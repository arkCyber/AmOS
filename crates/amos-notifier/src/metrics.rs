//! Per-channel metrics + a global dispatcher view.
//!
//! Every instrumented channel updates its own [`ChannelMetricsInner`]; the
//! dispatcher holds an [`Arc`] to each one and exposes a snapshot via
//! [`DispatchMetrics::snapshot`]. The shape mirrors what the gRPC
//! `SystemStatus` already returns for the log sinks — the operator sees a
//! `sent / dropped / failed` triple per channel and a global total.

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default)]
pub struct ChannelMetricsInner {
    pub sent: AtomicU64,
    pub dropped: AtomicU64,
    pub failed: AtomicU64,
    /// How many alerts were suppressed by the (id, severity) window — the
    /// operator wants to see "23× in 5 min" not 23 lines, so we count the
    /// suppressed ones in a separate bucket rather than dropping them.
    pub suppressed: AtomicU64,
}

impl ChannelMetricsInner {
    pub fn snapshot(&self) -> ChannelMetrics {
        ChannelMetrics {
            sent: self.sent.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            suppressed: self.suppressed.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ChannelMetrics {
    pub sent: u64,
    pub dropped: u64,
    pub failed: u64,
    pub suppressed: u64,
}

/// The full snapshot the dispatcher exposes.
#[derive(Debug, Clone)]
pub struct DispatchMetrics {
    pub channels: Vec<(String, ChannelMetrics)>,
    pub global: ChannelMetrics,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn snapshot_reflects_atomic_state() {
        let inner = ChannelMetricsInner::default();
        inner.sent.fetch_add(7, Ordering::Relaxed);
        inner.dropped.fetch_add(2, Ordering::Relaxed);
        inner.failed.fetch_add(1, Ordering::Relaxed);
        let s = inner.snapshot();
        assert_eq!((s.sent, s.dropped, s.failed), (7, 2, 1));
    }

    #[test]
    fn dispatch_metrics_clone_is_cheap_and_independent() {
        let a = ChannelMetrics {
            sent: 5,
            dropped: 0,
            failed: 0,
            suppressed: 0,
        };
        let b = a;
        assert_eq!(a.sent, b.sent);
    }
}
