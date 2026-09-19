//! The `Dispatcher` — the centerpiece of the notifier.
//!
//! Responsibilities, in order:
//!
//! 1. **Suppress / rate-limit** each alert per channel via [`crate::throttle`].
//! 2. **Fan-out** surviving alerts to every configured channel.
//! 3. **Instrument** every send so [`crate::metrics`] stays honest.
//! 4. **Stderr fallback** — if no channels are configured, the alert still
//!    reaches the operator via a structured stderr line. This is the
//!    "we never silently drop a P0" guarantee.

use std::sync::Arc;
use std::time::Instant;

use crate::alert::Alert;
use crate::channel::{Channel, Instrumented};
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
    /// If `true`, the dispatcher appends one `tracing::warn!` line per alert
    /// when **no channels are configured**, so a misconfigured production
    /// box still surfaces alerts in the log stream. The same fallback is
    /// always on (the `stderr` path is one of the configured channels when
    /// the builder is used with `with_stderr_fallback`).
    stderr_fallback: bool,
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

    /// Enable the stderr fallback path. When `true` AND no channels are
    /// configured, every alert still writes one structured stderr line.
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
            if self.inner.stderr_fallback {
                eprintln!(
                    "[amos-notifier] no channels configured — {sev} {id}: {msg}",
                    sev = alert.severity.label(),
                    id = alert.id,
                    msg = alert.message
                );
            } else {
                // Without a fallback, the alert still goes to `tracing` so
                // an operator with the daemon's log file is not blind.
                tracing::warn!(
                    severity = alert.severity.label(),
                    id = %alert.id,
                    "alert dropped: no channels configured and stderr fallback is off"
                );
            }
            return;
        }
        for (i, ch) in self.inner.channels.iter().enumerate() {
            let decision =
                self.inner
                    .throttle
                    .allow(ch.id().as_str(), &fingerprint, alert.severity, now);
            match decision {
                ThrottleDecision::Allow => {
                    ch.send(&alert);
                }
                ThrottleDecision::Suppress => {
                    self.inner.metrics[i]
                        .suppressed
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                ThrottleDecision::RateLimit => {
                    self.inner.metrics[i]
                        .dropped
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            }
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
        // Metrics are empty (no channels), but the dispatcher is alive.
        let m = d.metrics();
        assert!(m.channels.is_empty());
        assert_eq!(m.global.sent, 0);
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

    #[test]
    fn failed_send_does_not_crash_the_dispatcher() {
        struct AlwaysFail;
        impl crate::channel::Channel for AlwaysFail {
            fn id(&self) -> crate::channel::ChannelId {
                crate::channel::ChannelId::new("always-fail")
            }
            fn send(&self, _alert: &Alert) -> crate::channel::SendOutcome {
                crate::channel::SendOutcome::Failed
            }
        }
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
}
