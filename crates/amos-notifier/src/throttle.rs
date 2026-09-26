//! Suppression-window state machine + token-bucket rate limiter.
//!
//! Each `(channel, fingerprint)` pair owns one bucket. The dispatcher
//! consults [`Throttle::allow`] before forwarding; the returned
//! [`ThrottleDecision`] says whether to send, merge (suppression window) or
//! drop (rate limit) so the metrics stay honest.
//!
//! **The rate limiter does not bite today.** The bucket is keyed per
//! fingerprint, and the suppression window alone already swallows every
//! repeat of a fingerprint, so the bucket can never be empty at the moment
//! the window lets an alert through — see [`ThrottleDecision::RateLimit`]
//! for the arithmetic and `rate_limit_is_unreachable_for_every_severity`
//! for the measurement.
//!
//! No external `tokio::time` — we use [`std::time::Instant`] and a single
//! mutex per bucket. The dispatcher calls this from the firing thread;
//! the lock is held for microseconds.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::alert::Severity;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThrottleDecision {
    /// Send immediately.
    Allow,
    /// Suppression window is open — merge with the last alert of this
    /// fingerprint instead of dispatching a fresh one. The operator still
    /// sees the count via [`crate::metrics`].
    Suppress,
    /// Rate limit (token bucket empty) — drop without merging. The
    /// operator sees a "dropped" counter.
    ///
    /// **Unreachable under the current [`Severity`] table.** The bucket
    /// starts full and loses a token only on an `Allow`, which at the same
    /// instant opens the suppression window. While the window is open every
    /// call still refills the bucket, so an `Allow` leaves `capacity - 1`
    /// tokens and the bucket has to climb back to just **one** token before
    /// it could ever refuse — at most `1 / rate_per_sec` seconds (P0 ≈ 0 s,
    /// P1 = 1 s, P2 = 10 s). Every severity's suppression window is far
    /// longer than that (30 s ∕ 300 s ∕ 3600 s), so any alert the window lets
    /// through arrives with a full bucket and is `Allow`ed. The arm is kept
    /// because the dispatcher matches on it; a severity table that made it
    /// live would also mean the `dropped` channel counter — whose only
    /// *other* producer is `SendOutcome::Dropped` in `channel.rs` — no
    /// longer means one thing.
    RateLimit,
}

#[derive(Debug)]
struct Bucket {
    /// Token-bucket capacity — `rate_per_sec.max(1.0)`, except P0
    /// (`rate_per_sec == 0.0`), which gets `1e9` so the bucket never empties.
    capacity: f64,
    /// Tokens/sec refill rate. P0 is `1e9` (effectively unlimited).
    refill: f64,
    tokens: f64,
    last_refill: Instant,
    /// Last time a suppression-window-eligible alert was accepted.
    last_emit: Option<Instant>,
    suppression_window: Duration,
}

impl Bucket {
    fn new(rate_per_sec: f64, suppression: Duration, now: Instant) -> Self {
        // P0 ⇒ refill is effectively unlimited.
        let (capacity, refill) = if rate_per_sec <= 0.0 {
            (1.0e9, 1.0e9)
        } else {
            (rate_per_sec.max(1.0), rate_per_sec)
        };
        Self {
            capacity,
            refill,
            tokens: capacity,
            last_refill: now,
            last_emit: None,
            suppression_window: suppression,
        }
    }

    fn allow(&mut self, now: Instant) -> ThrottleDecision {
        // 1) Refill tokens based on elapsed time. Saturating so a clock
        // jump (NTP step) does not refill an unbounded number of tokens.
        let elapsed = now
            .saturating_duration_since(self.last_refill)
            .as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.refill).min(self.capacity);
        self.last_refill = now;
        // 2) Suppression window? If the previous emit was inside the
        // window, this alert is **merged** (Suppression beats rate-limit
        // so the operator sees the count even when the bucket is empty).
        if let Some(last) = self.last_emit {
            if now.saturating_duration_since(last) < self.suppression_window {
                return ThrottleDecision::Suppress;
            }
        }
        // 3) Token bucket.
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            self.last_emit = Some(now);
            ThrottleDecision::Allow
        } else {
            ThrottleDecision::RateLimit
        }
    }
}

#[derive(Debug, Default)]
pub struct Throttle {
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl Throttle {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decide whether `channel_id` may send an alert of `severity` right
    /// now. `fingerprint` is the alert's `Severity|id` string (see
    /// [`crate::alert::Alert::fingerprint`]).
    pub fn allow(
        &self,
        channel_id: &str,
        fingerprint: &str,
        severity: Severity,
        now: Instant,
    ) -> ThrottleDecision {
        let key = format!("{channel_id}|{fingerprint}");
        let mut guard = match self.buckets.lock() {
            Ok(g) => g,
            Err(_) => return ThrottleDecision::Allow, // fail-open: never block alerts on a poisoned lock
        };
        let bucket = guard.entry(key).or_insert_with(|| {
            Bucket::new(
                severity.rate_per_sec(),
                Duration::from_secs(severity.suppression_window_secs()),
                now,
            )
        });
        bucket.allow(now)
    }

    /// Test-only: how many distinct (channel, fingerprint) buckets are live.
    pub fn bucket_count(&self) -> usize {
        self.buckets.lock().map(|g| g.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p0_is_unlimited_within_a_window() {
        let t = Throttle::new();
        let now = Instant::now();
        // A P0 within the suppression window is *suppressed*, not rate-
        // limited (Suppression beats rate-limit by design — the operator
        // still wants to count how many of the same id fired). So:
        // - First call: Allow (bucket + window reset).
        // - Second call 1 ns later: Suppress (still inside the 30 s window).
        let f = "P0|x";
        assert_eq!(t.allow("ch", f, Severity::P0, now), ThrottleDecision::Allow);
        assert_eq!(
            t.allow("ch", f, Severity::P0, now + Duration::from_nanos(1)),
            ThrottleDecision::Suppress
        );
        // Past the 30 s window: Allow again (and the bucket still has
        // plenty of tokens because P0 has an effectively-infinite refill).
        let past = now + Duration::from_secs(31);
        assert_eq!(
            t.allow("ch", f, Severity::P0, past),
            ThrottleDecision::Allow
        );
    }

    #[test]
    fn p1_window_suppresses_same_id_within_5_min() {
        let t = Throttle::new();
        let now = Instant::now();
        let f = "P1|x";
        assert_eq!(t.allow("ch", f, Severity::P1, now), ThrottleDecision::Allow);
        // Inside the 5 min window ⇒ Suppress (even though the bucket has
        // been refilled — suppression is checked first).
        assert_eq!(
            t.allow("ch", f, Severity::P1, now + Duration::from_secs(10)),
            ThrottleDecision::Suppress
        );
    }

    #[test]
    fn distinct_fingerprints_have_independent_buckets() {
        let t = Throttle::new();
        let now = Instant::now();
        assert_eq!(
            t.allow("ch", "P0|a", Severity::P0, now),
            ThrottleDecision::Allow
        );
        assert_eq!(
            t.allow("ch", "P0|b", Severity::P0, now),
            ThrottleDecision::Allow
        );
        assert_eq!(t.bucket_count(), 2);
    }

    #[test]
    fn suppression_window_expires() {
        let t = Throttle::new();
        let now = Instant::now();
        assert_eq!(
            t.allow("ch", "P2|x", Severity::P2, now),
            ThrottleDecision::Allow
        );
        // 1 ns later ⇒ Suppress.
        assert_eq!(
            t.allow("ch", "P2|x", Severity::P2, now + Duration::from_nanos(1)),
            ThrottleDecision::Suppress
        );
        // 1 h + 1 ns later ⇒ Allow again.
        let later = now + Duration::from_secs(3600) + Duration::from_nanos(1);
        assert_eq!(
            t.allow("ch", "P2|x", Severity::P2, later),
            ThrottleDecision::Allow
        );
    }

    /// The suppression window is checked before the token bucket, so a
    /// repeat of the same fingerprint inside the window is merged even when
    /// the bucket has plenty of tokens. (This test was named
    /// `rate_limit_kicks_in_when_window_has_expired`, which its own body
    /// contradicted — see `rate_limit_is_unreachable_for_every_severity` for
    /// why the third arm never appears at all.)
    #[test]
    fn suppression_window_beats_the_token_bucket() {
        let t = Throttle::new();
        let now = Instant::now();
        let f = "P2|x";
        assert_eq!(t.allow("ch", f, Severity::P2, now), ThrottleDecision::Allow);
        // 10 s in, the bucket has refilled by `0.1 tokens/s * 10 s = 1`
        // token — full — but the 1 h window still swallows the repeat.
        let now2 = now + Duration::from_secs(10);
        assert_eq!(
            t.allow("ch", f, Severity::P2, now2),
            ThrottleDecision::Suppress
        );
    }

    /// The invariant behind the previous two tests: an `Allow` leaves
    /// `capacity - 1` tokens and `RateLimit` needs the bucket to still be
    /// short of **one** token when the suppression window closes — so the
    /// window must be shorter than the `max(0, 2 - capacity) / rate` seconds
    /// it takes to refill to one token. Pin it, so that widening a severity's
    /// rate or shortening its window fails *here* with the consequence
    /// spelled out — instead of quietly switching a nominal dispatch path on.
    #[test]
    fn the_rate_limit_stays_unreachable_only_while_the_window_outlasts_the_refill() {
        for severity in [Severity::P0, Severity::P1, Severity::P2] {
            let rate = severity.rate_per_sec();
            if rate <= 0.0 {
                continue; // no token bucket to drain
            }
            let capacity = rate.max(1.0);
            // Tokens left after an `Allow` is `capacity - 1`; a refusal needs
            // fewer than one, so this is how long the bucket stays refilling.
            let refill_secs = (1.0 - (capacity - 1.0)).max(0.0) / rate;
            let window = severity.suppression_window_secs() as f64;
            assert!(
                window > refill_secs,
                "{severity:?}: the suppression window ({window}s) no longer outlasts the \
                 bucket refill ({refill_secs}s) — ThrottleDecision::RateLimit becomes \
                 reachable, so the dispatcher's `dropped` counter needs a test that \
                 actually produces it"
            );
        }
    }

    /// Characterisation, written before this file's docs were touched: no
    /// input reaches [`ThrottleDecision::RateLimit`]. The bucket starts full
    /// and the only thing that ever removes a token is an `Allow` — which at
    /// the same instant opens the suppression window. Everything the window
    /// swallows still refills the bucket, so the token count has to climb
    /// from `capacity - 1` back to `capacity` before the window can close,
    /// and every severity's window is far longer than that climb. Drive the
    /// densest stream the API allows — one call per second, which keeps
    /// `last_refill` current so even the boundary call sees almost no
    /// elapsed time — and the third arm still never appears.
    #[test]
    fn rate_limit_is_unreachable_for_every_severity() {
        for severity in [Severity::P0, Severity::P1, Severity::P2] {
            let t = Throttle::new();
            let start = Instant::now();
            let window = severity.suppression_window_secs();
            let mut decisions = Vec::new();
            for secs in 0..=window {
                decisions.push((
                    secs,
                    t.allow("ch", "fp", severity, start + Duration::from_secs(secs)),
                ));
            }
            for secs in [window + 1, window + 2, window * 2] {
                decisions.push((
                    secs,
                    t.allow("ch", "fp", severity, start + Duration::from_secs(secs)),
                ));
            }
            for (secs, d) in &decisions {
                assert_ne!(
                    *d,
                    ThrottleDecision::RateLimit,
                    "{severity:?} produced RateLimit at t={secs}s — the arm just became \
                     reachable; the dispatcher's `dropped` accounting and this file's docs \
                     must be revisited"
                );
            }
            // The stream really did exercise the other two arms, so the
            // assertion above is not vacuous.
            assert!(decisions.iter().any(|(_, d)| *d == ThrottleDecision::Allow));
            assert!(decisions
                .iter()
                .any(|(_, d)| *d == ThrottleDecision::Suppress));
        }
    }
}
