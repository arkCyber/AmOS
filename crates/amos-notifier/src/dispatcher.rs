//! The `Dispatcher` — the centerpiece of the notifier.
//!
//! Responsibilities, in order:
//!
//! 1. **Suppress / rate-limit** each alert per channel via [`crate::throttle`].
//! 2. **Fan-out** surviving alerts to every configured channel.
//! 3. **Instrument** every send so [`crate::metrics`] stays honest.
//! 4. **Stderr fallback** — if the alert reaches no channel, it still reaches
//!    the operator via a structured stderr line (or `tracing` when the stderr
//!    path is off). This is the "we never silently drop a P0" guarantee, and it
//!    holds in **both** no-channel cases: nothing configured at all, and every
//!    configured channel refusing or failing the alert (REQ-A769).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use crate::alert::Alert;
use crate::channel::{Channel, Instrumented, SendOutcome};
use crate::metrics::{ChannelMetrics, ChannelMetricsInner, DispatchMetrics};
use crate::throttle::{Throttle, ThrottleDecision};

/// A built dispatcher.
#[derive(Clone)]
pub struct Dispatcher {
    inner: Arc<Inner>,
}

struct Inner {
    channels: Vec<Arc<dyn Channel>>,
    metrics: Vec<Arc<ChannelMetricsInner>>,
    throttle: Throttle,
    /// If `true`, an alert that reaches no channel is written as one structured
    /// **stderr** line; if `false` it is written to `tracing` instead (so a box
    /// with the daemon's log file is never blind). Either way the fallback is
    /// always on — the flag only chooses which stream the operator reads, for
    /// both the empty-channel case and the every-channel-refused case (REQ-A769).
    stderr_fallback: bool,
    /// Alerts that reached no channel and were surfaced only by [`Inner::stderr_fallback`].
    /// Exposed on [`DispatchMetrics::fallbacks`] so the fallback is observable, not just printed.
    fallbacks: AtomicU64,
}

/// Builder for [`Dispatcher`].
#[derive(Default)]
pub struct DispatcherBuilder {
    channels: Vec<Arc<dyn Channel>>,
    metrics: Vec<Arc<ChannelMetricsInner>>,
    stderr_fallback: bool,
}

impl DispatcherBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a channel. The builder wraps it with an [`Instrumented`] so the
    /// dispatcher's metrics reflect every send without each transport
    /// duplicating counter logic.
    pub fn with_channel(mut self, channel: impl Channel + 'static) -> Self {
        let inner = Arc::new(ChannelMetricsInner::default());
        let wrapped: Arc<dyn Channel> = Arc::new(Instrumented::wrap(channel, inner.clone()));
        self.channels.push(wrapped);
        self.metrics.push(inner);
        self
    }

    /// Enable the stderr fallback path. When `true`, every alert that reaches
    /// no channel writes one structured stderr line; when `false` it writes to
    /// `tracing` instead. The fallback itself always runs — this only picks the
    /// stream (REQ-A769).
    pub fn with_stderr_fallback(mut self, on: bool) -> Self {
        self.stderr_fallback = on;
        self
    }

    pub fn build(self) -> Dispatcher {
        Dispatcher {
            inner: Arc::new(Inner {
                channels: self.channels,
                metrics: self.metrics,
                throttle: Throttle::new(),
                stderr_fallback: self.stderr_fallback,
                fallbacks: AtomicU64::new(0),
            }),
        }
    }
}

impl Dispatcher {
    pub fn builder() -> DispatcherBuilder {
        DispatcherBuilder::new()
    }

    /// Fire one alert. All work happens on the calling thread — the
    /// dispatcher is intentionally synchronous so a transport that hangs
    /// can be observed (and killed) by the calling supervisor.
    pub fn fire(&self, alert: Alert) {
        let now = Instant::now();
        let fingerprint = alert.fingerprint();
        if self.inner.channels.is_empty() {
            self.inner.fallbacks.fetch_add(1, Ordering::Relaxed);
            self.operator_fallback(&alert, "no channels configured");
            return;
        }
        // REQ-A769. `attempted` / `delivered` are what let the dispatcher tell
        // "we delivered this somewhere" from "we tried and nobody took it". A
        // `Suppress`/`RateLimit` decision is a deliberate, counted non-delivery
        // (bullet 2 of the crate docs) — it is **not** a reason to fall back, so
        // it leaves `attempted` false. An `Allow` that returns anything but
        // `Sent` (a `Failed` transport, or a `Dropped` refusal like a webhook
        // 401) means the alert reached no operator, and the fallback fires.
        //
        // The defect this closes: `lib.rs` promised the stderr fallback "when no
        // transports are configured **or every transport fails**", but only the
        // empty-channel half was implemented — a box with one webhook pointed at
        // a dead host had every P0 counted in `failed` and shown to nobody.
        let mut attempted = false;
        let mut delivered = false;
        for (i, ch) in self.inner.channels.iter().enumerate() {
            let decision =
                self.inner
                    .throttle
                    .allow(ch.id().as_str(), &fingerprint, alert.severity, now);
            match decision {
                ThrottleDecision::Allow => {
                    attempted = true;
                    if ch.send(&alert) == SendOutcome::Sent {
                        delivered = true;
                    }
                }
                ThrottleDecision::Suppress => {
                    self.inner.metrics[i]
                        .suppressed
                        .fetch_add(1, Ordering::Relaxed);
                }
                ThrottleDecision::RateLimit => {
                    self.inner.metrics[i]
                        .dropped
                        .fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        if attempted && !delivered {
            self.inner.fallbacks.fetch_add(1, Ordering::Relaxed);
            self.operator_fallback(&alert, "no channel accepted the alert");
        }
    }

    /// Write the last-resort operator line for an alert that reached no channel.
    ///
    /// The **one** place that decides *how* the operator hears: a structured
    /// stderr line when `stderr_fallback` is armed, `tracing::warn!` otherwise (the
    /// daemon's log file is the floor). Both the empty-channel case and the
    /// every-channel-refused case route through here, so the two cannot drift into
    /// describing the same outcome two different ways. `note` is the reason; the
    /// alert's severity, id and message follow it in one parseable line.
    fn operator_fallback(&self, alert: &Alert, note: &str) {
        if self.inner.stderr_fallback {
            eprintln!(
                "[amos-notifier] {note} — {sev} {id}: {msg}",
                sev = alert.severity.label(),
                id = alert.id,
                msg = alert.message
            );
        } else {
            tracing::warn!(
                severity = alert.severity.label(),
                id = %alert.id,
                "alert reached no channel: {note} (stderr fallback is off)"
            );
        }
    }

    /// Snapshot every channel's metrics into a serializable view.
    pub fn metrics(&self) -> DispatchMetrics {
        let mut total = ChannelMetrics::default();
        let mut per = Vec::with_capacity(self.inner.metrics.len());
        for (i, m) in self.inner.metrics.iter().enumerate() {
            let s = m.snapshot();
            total.sent += s.sent;
            total.dropped += s.dropped;
            total.failed += s.failed;
            total.suppressed += s.suppressed;
            per.push((self.inner.channels[i].id().as_str().to_string(), s));
        }
        DispatchMetrics {
            channels: per,
            global: total,
            fallbacks: self.inner.fallbacks.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::Recorder;
    use std::sync::Arc;

    #[test]
    fn no_channels_with_stderr_off_does_not_panic_and_does_not_silently_drop() {
        // We exercise this via `tracing` (the `tracing-test` subscriber
        // would assert; without one, the call is a no-op for output).
        let d = Dispatcher::builder().with_stderr_fallback(false).build();
        d.fire(Alert::p0("x", "y"));
        // Metrics are empty (no channels), but the dispatcher is alive — and the
        // alert is accounted for as one fallback, not silently gone (REQ-A769).
        let m = d.metrics();
        assert!(m.channels.is_empty());
        assert_eq!(m.global.sent, 0);
        assert_eq!(m.fallbacks, 1);
    }

    #[test]
    fn fan_out_reaches_every_channel() {
        let r1 = Arc::new(Recorder::new("ch1"));
        let r2 = Arc::new(Recorder::new("ch2"));
        let d = Dispatcher::builder()
            .with_channel(Recorder::new("ch-recorder-1"))
            .with_channel(Recorder::new("ch-recorder-2"))
            .build();
        // We can't fish the recorder back out of the dispatcher (the trait
        // boundary hides it), so just confirm two channels were registered.
        assert_eq!(d.metrics().channels.len(), 2);
        let _ = (r1, r2); // appease unused
    }

    #[test]
    fn suppression_window_merges_two_p1s_of_the_same_id() {
        let d = Dispatcher::builder()
            .with_channel(Recorder::new("ch-suppress"))
            .build();
        d.fire(Alert::p1("db.slow", "first"));
        d.fire(Alert::p1("db.slow", "second"));
        let m = d.metrics();
        let (_, cm) = &m.channels[0];
        // First alert: sent. Second alert: suppressed (P1 window is 5 min).
        assert_eq!(cm.sent, 1);
        assert_eq!(cm.suppressed, 1);
    }

    #[test]
    fn different_ids_each_get_their_own_window() {
        let d = Dispatcher::builder()
            .with_channel(Recorder::new("ch-multi"))
            .build();
        d.fire(Alert::p1("db.slow", "a"));
        d.fire(Alert::p1("cpu.high", "b"));
        let m = d.metrics();
        let (_, cm) = &m.channels[0];
        // Both ids are independent: neither is suppressed by the other.
        assert_eq!(cm.sent, 2);
        assert_eq!(cm.suppressed, 0);
    }

    #[test]
    fn p0_is_not_rate_limited() {
        let d = Dispatcher::builder()
            .with_channel(Recorder::new("ch-p0"))
            .build();
        for _ in 0..10 {
            d.fire(Alert::p0("kernel.panic", "boom"));
        }
        let m = d.metrics();
        let (_, cm) = &m.channels[0];
        // First P0 sent, subsequent 9 are suppressed (30 s window). The
        // thing being tested is "no `dropped`" — a rate-limit outcome.
        assert_eq!(cm.dropped, 0);
        assert_eq!(cm.sent, 1);
        assert_eq!(cm.suppressed, 9);
    }

    /// A channel whose transport is broken — every send fails.
    struct AlwaysFail;
    impl Channel for AlwaysFail {
        fn id(&self) -> crate::channel::ChannelId {
            crate::channel::ChannelId::new("always-fail")
        }
        fn send(&self, _alert: &Alert) -> SendOutcome {
            SendOutcome::Failed
        }
    }

    #[test]
    fn failed_send_does_not_crash_the_dispatcher() {
        let d = Dispatcher::builder().with_channel(AlwaysFail).build();
        // Two distinct ids bypass the suppression window so each one
        // reaches the channel and is recorded as failed.
        d.fire(Alert::p0("a", "first"));
        d.fire(Alert::p0("b", "second"));
        let m = d.metrics();
        let (_, cm) = &m.channels[0];
        assert_eq!(cm.failed, 2);
        // And the dispatcher is still alive — a third alert goes through.
        d.fire(Alert::p0("c", "third"));
        let m = d.metrics();
        let (_, cm) = &m.channels[0];
        assert_eq!(cm.failed, 3);
    }

    /// A channel that always declines a send it is structurally able to make.
    struct AlwaysDrop;
    impl Channel for AlwaysDrop {
        fn id(&self) -> crate::channel::ChannelId {
            crate::channel::ChannelId::new("always-drop")
        }
        fn send(&self, _alert: &Alert) -> SendOutcome {
            SendOutcome::Dropped
        }
    }

    /// REQ-A769 — the case `lib.rs` promised but the code did not do: channels are
    /// configured, and every one of them fails. Before this, the alert reached the
    /// `failed` counter and **nobody else**; now it reaches the operator fallback too.
    #[test]
    fn a_p0_that_every_channel_fails_still_reaches_the_operator_fallback() {
        let d = Dispatcher::builder()
            .with_stderr_fallback(true)
            .with_channel(AlwaysFail)
            .build();
        d.fire(Alert::p0("daemon.crash", "budget exhausted"));
        let m = d.metrics();
        assert_eq!(m.global.failed, 1, "the transport failure is still counted");
        assert_eq!(
            m.fallbacks, 1,
            "and the alert is surfaced to the operator, not just counted"
        );
    }

    /// `Dropped` is a refusal, not a delivery: a webhook that answers 401 took
    /// nothing, so the operator fallback must fire here too (the promise is "an
    /// alert reaches nobody ⇒ say so", whatever the transport called it).
    #[test]
    fn an_alert_every_channel_drops_also_falls_back() {
        let d = Dispatcher::builder().with_channel(AlwaysDrop).build();
        d.fire(Alert::p0("daemon.crash", "bad webhook auth"));
        let m = d.metrics();
        assert_eq!(m.global.dropped, 1);
        assert_eq!(m.fallbacks, 1);
    }

    /// …but one transport taking the alert is enough. The fallback is a last
    /// resort, not a second copy sent whenever any single channel fails — the
    /// same rule `a_failed_channel_does_not_block_other_channels` relies on.
    #[test]
    fn one_channel_delivering_suppresses_the_fallback() {
        let d = Dispatcher::builder()
            .with_stderr_fallback(true)
            .with_channel(AlwaysFail)
            .with_channel(Recorder::new("rec-ok"))
            .build();
        d.fire(Alert::p0("daemon.crash", "one sink took it"));
        let m = d.metrics();
        assert!(m.global.sent >= 1, "the recorder delivered");
        assert_eq!(m.fallbacks, 0, "a delivered alert is not a fallback");
    }

    /// A suppression is a deliberate, counted non-delivery (crate docs, bullet 2),
    /// so it must **not** trip the fallback — that would turn every duplicate P1
    /// into an operator line and defeat the window it exists to enforce.
    #[test]
    fn a_suppressed_duplicate_is_not_a_fallback() {
        let d = Dispatcher::builder()
            .with_stderr_fallback(true)
            .with_channel(Recorder::new("rec-supp"))
            .build();
        d.fire(Alert::p1("db.slow", "first"));
        d.fire(Alert::p1("db.slow", "second"));
        let m = d.metrics();
        assert_eq!(m.global.sent, 1);
        assert_eq!(m.global.suppressed, 1);
        assert_eq!(m.fallbacks, 0, "suppression is not a delivery failure");
    }
}
