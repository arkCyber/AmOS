//! Per-client, emergency-exempt dial rate limiting for the telephony service.
//!
//! `docs/telephony.md §5` demands ordinary dialing be subject to rate limiting while
//! emergency calls are **always** exempt (an emergency must never be throttled). The
//! limiter lives in the domain crate and is consulted by `TelephonyService::dial`
//! only for non-emergency calls, keyed by a client id the caller supplies on gRPC
//! metadata (`x-client-id`). Callers without an id share a single `_default` bucket —
//! on a device there is effectively one principal (the System UI dialer), which is
//! exactly the surface we want to bound against flooding.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct State {
    cap_per_window: u32,
    window: Duration,
    /// Hard ceiling on distinct tracked clients (a spoofed `x-client-id` flood must
    /// never grow memory without bound).
    max_clients: usize,
    /// client -> (window start, calls this window)
    buckets: HashMap<String, (Instant, u32)>,
}

/// Default ceiling on distinct client ids the limiter will track.
const DEFAULT_MAX_CLIENTS: usize = 256;

/// Fixed-window per-client counter. Thread-safe and **bounded**: distinct clients are
/// capped (`max_clients`) and expired windows are pruned on access, so a hostile
/// caller flooding fake ids cannot grow the map unboundedly (a memory-DoS).
pub struct DialRateLimiter {
    inner: Mutex<State>,
}

impl DialRateLimiter {
    pub fn new(cap_per_window: u32, window: Duration) -> Self {
        Self::with_clients(cap_per_window, window, DEFAULT_MAX_CLIENTS)
    }

    /// Construct with an explicit ceiling on tracked client ids.
    pub fn with_clients(cap_per_window: u32, window: Duration, max_clients: usize) -> Self {
        Self {
            inner: Mutex::new(State {
                cap_per_window: cap_per_window.max(1),
                window,
                max_clients: max_clients.max(1),
                buckets: HashMap::new(),
            }),
        }
    }

    pub fn per_minute(cap: u32) -> Self {
        Self::new(cap, Duration::from_secs(60))
    }

    /// Try to consume one allowance for `client`. `true` = allowed (slot consumed);
    /// `false` = over this window's cap, or a brand-new client while at capacity.
    pub fn allow(&self, client: &str) -> bool {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let window = g.window;
        let cap = g.cap_per_window;
        let max = g.max_clients;
        let now = Instant::now();

        // Drop windows that have fully elapsed so they free a client slot.
        g.buckets
            .retain(|_, (start, _)| now.duration_since(*start) < window);

        // A brand-new client at the ceiling is denied rather than letting the map grow.
        if !g.buckets.contains_key(client) && g.buckets.len() >= max {
            return false;
        }

        let entry = g
            .buckets
            .entry(client.to_string())
            .or_insert_with(|| (now, 0));
        if now.duration_since(entry.0) >= window {
            *entry = (now, 0);
        }
        if entry.1 < cap {
            entry.1 += 1;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_cap_then_blocks_within_window() {
        let lim = DialRateLimiter::new(2, Duration::from_secs(60));
        assert!(lim.allow("c1"));
        assert!(lim.allow("c1"));
        assert!(!lim.allow("c1"), "third call in the same window is blocked");
    }

    #[test]
    fn buckets_are_per_client() {
        let lim = DialRateLimiter::new(1, Duration::from_secs(60));
        assert!(lim.allow("c1"));
        assert!(!lim.allow("c1"));
        assert!(lim.allow("c2"), "a different client has its own budget");
    }

    #[test]
    fn distinct_clients_are_bounded() {
        let lim = DialRateLimiter::with_clients(5, Duration::from_secs(60), 2);
        assert!(lim.allow("a"));
        assert!(lim.allow("b"));
        // At the 2-client ceiling, a brand-new client is refused (no unbounded growth).
        assert!(!lim.allow("c"), "new client past capacity is denied");
        // Known clients keep their own budget.
        assert!(lim.allow("a"));
    }
}
