//! Link counters — the numbers an operator (and `make`-style smoke) can trust.
//!
//! Every counter here is updated by the layer that *knows* the fact, never estimated:
//! `published` counts frames handed to a transport, `delivered` counts frames a
//! subscriber queue accepted, `dropped` counts frames a QoS policy refused (i.e. the
//! price of best-effort), and `decode_errors` counts frames a typed subscriber could
//! not turn back into a `Message` (a version skew or a corrupt link — never silent).
//!
//! The counters are plain atomics with `Relaxed` ordering: they are a *reporting*
//! surface, not a synchronisation primitive, so the cheapest ordering is the correct
//! one. Nothing here is reset while the node lives, so a reader always sees the
//! cumulative truth.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

/// Cumulative counters of one link node (or of one transport instance).
#[derive(Debug, Default)]
pub struct LinkMetrics {
    published: AtomicU64,
    delivered: AtomicU64,
    dropped: AtomicU64,
    blocked: AtomicU64,
    decode_errors: AtomicU64,
    encode_errors: AtomicU64,
}

impl LinkMetrics {
    /// A fresh, all-zero counter set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record `n` frames handed to a transport.
    pub fn record_published(&self, n: u64) {
        self.published.fetch_add(n, Ordering::Relaxed);
    }

    /// Record `n` frames accepted by subscriber queues.
    pub fn record_delivered(&self, n: u64) {
        self.delivered.fetch_add(n, Ordering::Relaxed);
    }

    /// Record `n` frames a QoS policy dropped.
    pub fn record_dropped(&self, n: u64) {
        self.dropped.fetch_add(n, Ordering::Relaxed);
    }

    /// Record `n` publishes that had to **wait** for a reliable subscriber.
    ///
    /// This is the price of `Reliability::Reliable` and, until this counter existed, an
    /// invisible one: a control subscriber that stops reading silently slows the
    /// publisher down instead of dropping anything. Counting the waits makes the
    /// back-pressure a number an operator can see (the alternative — inferring it from a
    /// latency graph — is exactly the guesswork this crate avoids elsewhere).
    pub fn record_blocked(&self, n: u64) {
        self.blocked.fetch_add(n, Ordering::Relaxed);
    }

    /// Record one received frame that could not be decoded into the subscriber's type.
    pub fn record_decode_error(&self) {
        self.decode_errors.fetch_add(1, Ordering::Relaxed);
    }

    /// Record one outgoing message that could not be encoded.
    pub fn record_encode_error(&self) {
        self.encode_errors.fetch_add(1, Ordering::Relaxed);
    }

    /// A consistent-enough point-in-time reading (each field is independent).
    pub fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            published: self.published.load(Ordering::Relaxed),
            delivered: self.delivered.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            blocked: self.blocked.load(Ordering::Relaxed),
            decode_errors: self.decode_errors.load(Ordering::Relaxed),
            encode_errors: self.encode_errors.load(Ordering::Relaxed),
        }
    }
}

/// A serializable reading of [`LinkMetrics`] (JSON for the CLI, protobuf for the
/// control plane).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetricsSnapshot {
    /// Frames handed to a transport.
    pub published: u64,
    /// Frames accepted by subscriber queues.
    pub delivered: u64,
    /// Frames dropped by a QoS policy.
    pub dropped: u64,
    /// Publishes that had to wait for a reliable subscriber (back-pressure).
    pub blocked: u64,
    /// Received frames that failed to decode.
    pub decode_errors: u64,
    /// Messages that failed to encode.
    pub encode_errors: u64,
}

impl MetricsSnapshot {
    /// The share of published frames that reached a subscriber queue, in `[0, 1]`.
    ///
    /// With several subscribers a frame can be delivered more than once, so the ratio
    /// is capped at 1 — it answers "are frames getting through at all", which is what
    /// a healthy-link check asks.
    pub fn delivery_ratio(&self) -> f32 {
        if self.published == 0 {
            return 1.0;
        }
        let r = self.delivered as f64 / self.published as f64;
        r.min(1.0) as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_accumulate_and_snapshot() {
        let m = LinkMetrics::new();
        m.record_published(3);
        m.record_delivered(2);
        m.record_dropped(1);
        m.record_blocked(4);
        m.record_decode_error();
        m.record_encode_error();
        let s = m.snapshot();
        assert_eq!(s.published, 3);
        assert_eq!(s.delivered, 2);
        assert_eq!(s.dropped, 1);
        assert_eq!(s.blocked, 4, "back-pressure is counted, not inferred");
        assert_eq!(s.decode_errors, 1);
        assert_eq!(s.encode_errors, 1);
        // A second snapshot keeps accumulating (never reset).
        m.record_published(2);
        assert_eq!(m.snapshot().published, 5);
        assert_ne!(MetricsSnapshot::default(), m.snapshot());
    }

    #[test]
    fn delivery_ratio_is_bounded_and_defined_at_zero() {
        let empty = MetricsSnapshot::default();
        assert_eq!(empty.delivery_ratio(), 1.0);
        let half = MetricsSnapshot {
            published: 4,
            delivered: 2,
            ..Default::default()
        };
        assert!((half.delivery_ratio() - 0.5).abs() < 1e-6);
        // Three subscribers on one publish delivers 3x — still reported as 1.0.
        let fanout = MetricsSnapshot {
            published: 1,
            delivered: 3,
            ..Default::default()
        };
        assert_eq!(fanout.delivery_ratio(), 1.0);
    }
}
