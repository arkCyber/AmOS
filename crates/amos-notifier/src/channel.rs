//! The `Channel` trait + a stable [`ChannelId`] for diagnostics.
//!
//! A transport implements [`Channel::send`] and returns a [`SendOutcome`].
//! The dispatcher uses the outcome to update metrics; a transport that
//! returns [`SendOutcome::Failed`] is not retried (the next alert is a
//! fresh attempt — retries would amplify flapping).

use std::sync::Arc;

use crate::alert::Alert;

/// Stable, human-readable channel identifier (`"webhook:https://…"`).
/// Used as a key in [`crate::metrics::DispatchMetrics`].
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ChannelId(pub String);

impl ChannelId {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Outcome of one send attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendOutcome {
    /// The transport accepted the alert (HTTP 2xx, SMTP 250, …).
    Sent,
    /// The transport is structurally fine but this particular send was
    /// refused (rate limit, auth, …). Distinct from `Failed` so the
    /// dispatcher can pick a different transport next time.
    Dropped,
    /// The transport is broken (connection refused, DNS failure, …).
    /// Recorded as a failure; the next alert will try again.
    Failed,
}

/// A delivery channel. **Sync** by design: the dispatcher calls `send`
/// inline on whatever thread is firing the alert. Transports that need
/// async (HTTP, SMTP) block inside `send` — typically a few ms on a LAN,
/// capped by a short timeout inside the transport itself.
pub trait Channel: Send + Sync {
    fn id(&self) -> ChannelId;
    fn send(&self, alert: &Alert) -> SendOutcome;
}

/// A counting channel: wraps another channel and increments the global
/// counters every time `send` returns. This is the only path that records
/// metrics — the dispatcher trusts the wrapper, not the underlying channel.
pub struct Instrumented<C: Channel> {
    inner: C,
    metrics: Arc<crate::metrics::ChannelMetricsInner>,
}

impl<C: Channel> Instrumented<C> {
    pub fn wrap(inner: C, metrics: Arc<crate::metrics::ChannelMetricsInner>) -> Self {
        Self { inner, metrics }
    }
}

impl<C: Channel> Channel for Instrumented<C> {
    fn id(&self) -> ChannelId {
        self.inner.id()
    }
    fn send(&self, alert: &Alert) -> SendOutcome {
        let outcome = self.inner.send(alert);
        match outcome {
            SendOutcome::Sent => {
                self.metrics
                    .sent
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            SendOutcome::Dropped => {
                self.metrics
                    .dropped
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            SendOutcome::Failed => {
                self.metrics
                    .failed
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
        outcome
    }
}

/// Helper for tests: a channel that records every alert it sees.
#[derive(Debug)]
pub struct Recorder {
    pub id: ChannelId,
    pub received: std::sync::Mutex<Vec<Alert>>,
}

impl Default for Recorder {
    fn default() -> Self {
        Self {
            id: ChannelId::new("recorder"),
            received: Default::default(),
        }
    }
}

impl Recorder {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: ChannelId::new(id),
            received: Default::default(),
        }
    }
}

impl Channel for Recorder {
    fn id(&self) -> ChannelId {
        self.id.clone()
    }
    fn send(&self, alert: &Alert) -> SendOutcome {
        if let Ok(mut g) = self.received.lock() {
            g.push(alert.clone());
            SendOutcome::Sent
        } else {
            SendOutcome::Failed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::ChannelMetricsInner;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    /// `Recorder::default()` and `Recorder::new` both go through the same
    /// construction shape — locking is consistent and a poisoned mutex
    /// yields `Failed` (never a panic, never an `unwrap`).
    #[test]
    fn recorder_default_has_id_recorder_and_empty_log() {
        let r = Recorder::default();
        assert_eq!(r.id.as_str(), "recorder");
        assert!(r.received.lock().unwrap().is_empty());
    }

    #[test]
    fn recorder_records_in_order_and_returns_sent() {
        let r = Recorder::new("rc-a");
        let a1 = Alert::p0("a", "first");
        let a2 = Alert::p1("b", "second");
        assert_eq!(r.send(&a1), SendOutcome::Sent);
        assert_eq!(r.send(&a2), SendOutcome::Sent);
        let log = r.received.lock().unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].id, "a");
        assert_eq!(log[1].id, "b");
    }

    /// `Instrumented::wrap` must preserve the inner channel's id exactly.
    /// (Id mismatches are how a metrics row gets disassociated from the
    /// transport it actually ran on — the previous marker set the
    /// `ChannelId` outside the dispatcher, then the dispatcher wrapped it
    /// for metrics.)
    #[test]
    fn instrumented_preserves_inner_id_for_metrics_label() {
        struct FixedId;
        impl Channel for FixedId {
            fn id(&self) -> ChannelId {
                ChannelId::new("custom-id")
            }
            fn send(&self, _alert: &Alert) -> SendOutcome {
                SendOutcome::Sent
            }
        }
        let inner = FixedId;
        let metrics = Arc::new(ChannelMetricsInner::default());
        let wrapped = Instrumented::wrap(inner, metrics);
        assert_eq!(wrapped.id().as_str(), "custom-id");
    }

    #[test]
    fn instrumented_counts_sent_outcome() {
        let r = Recorder::new("inc-sent");
        let metrics = Arc::new(ChannelMetricsInner::default());
        let wrapped = Instrumented::wrap(r, metrics.clone());
        for _ in 0..3 {
            wrapped.send(&Alert::p2("x", "y"));
        }
        let snap = metrics.snapshot();
        assert_eq!(snap.sent, 3);
        assert_eq!(snap.dropped, 0);
        assert_eq!(snap.failed, 0);
    }

    #[test]
    fn instrumented_counts_dropped_outcome() {
        struct AlwaysDrop;
        impl Channel for AlwaysDrop {
            fn id(&self) -> ChannelId {
                ChannelId::new("drop")
            }
            fn send(&self, _alert: &Alert) -> SendOutcome {
                SendOutcome::Dropped
            }
        }
        let metrics = Arc::new(ChannelMetricsInner::default());
        let wrapped = Instrumented::wrap(AlwaysDrop, metrics.clone());
        wrapped.send(&Alert::p2("x", "y"));
        assert_eq!(
            metrics.dropped.load(Ordering::Relaxed),
            1,
            "Dropped must be counted in the `dropped` atom, not in `failed`"
        );
        assert_eq!(metrics.failed.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn instrumented_counts_failed_outcome() {
        struct AlwaysFail;
        impl Channel for AlwaysFail {
            fn id(&self) -> ChannelId {
                ChannelId::new("fail")
            }
            fn send(&self, _alert: &Alert) -> SendOutcome {
                SendOutcome::Failed
            }
        }
        let metrics = Arc::new(ChannelMetricsInner::default());
        let wrapped = Instrumented::wrap(AlwaysFail, metrics.clone());
        wrapped.send(&Alert::p2("x", "y"));
        assert_eq!(metrics.failed.load(Ordering::Relaxed), 1);
        assert_eq!(metrics.dropped.load(Ordering::Relaxed), 0);
    }

    /// The dispatcher increments `suppressed` itself (via the throttle),
    /// not through `Instrumented`. This is a **regression guard**: if a
    /// future refactor moves suppression counting into `Instrumented`, the
    /// dispatcher would double-count.
    #[test]
    fn instrumented_does_not_count_suppression() {
        let r = Recorder::new("no-suppress");
        let metrics = Arc::new(ChannelMetricsInner::default());
        let wrapped = Instrumented::wrap(r, metrics.clone());
        // We send through the wrapper, which only handles Send/Drop/Fail
        // outcomes. Anything else (Suppress in particular) is a dispatcher
        // concern. Simulate the dispatcher path: the wrapper reports
        // `Sent`; the metrics show `sent=1` and `suppressed=0`.
        assert_eq!(wrapped.send(&Alert::p0("x", "y")), SendOutcome::Sent);
        let snap = metrics.snapshot();
        assert_eq!(snap.sent, 1);
        assert_eq!(snap.suppressed, 0, "suppressed is dispatched-side only");
    }
}
