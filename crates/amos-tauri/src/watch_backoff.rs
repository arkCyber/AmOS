//! Shared reconnect policy for the daemon **watch** streams the System UI opens
//! (telephony `Watch`, Android LMK `WatchLmk`). A single source of truth so the
//! two watchers can't drift: exponential backoff up to a ceiling while the daemon
//! is unreachable, reset to the base as soon as a round connects — so a recovery
//! is picked up promptly and a long outage doesn't hammer the socket.

/// Minimum wait between reconnect attempts (ms).
pub const WATCH_BACKOFF_BASE_MS: u64 = 500;
/// Ceiling for the exponential reconnect backoff (ms).
pub const WATCH_BACKOFF_MAX_MS: u64 = 8000;

/// Next reconnect wait (ms) given the previous wait and whether the last round
/// actually connected. A successful connect resets to the base (the daemon is
/// up; if it then drops the stream we want to retry quickly), while a failed
/// connect keeps backing off exponentially up to the ceiling.
pub fn next_backoff_ms(prev_ms: u64, connected: bool) -> u64 {
    if connected {
        WATCH_BACKOFF_BASE_MS
    } else {
        (prev_ms * 2).min(WATCH_BACKOFF_MAX_MS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resets_to_base_after_a_successful_connect() {
        // Even from a maxed-out wait, a successful connect must retry quickly.
        assert_eq!(
            next_backoff_ms(WATCH_BACKOFF_MAX_MS, true),
            WATCH_BACKOFF_BASE_MS
        );
        assert_eq!(
            next_backoff_ms(WATCH_BACKOFF_BASE_MS, true),
            WATCH_BACKOFF_BASE_MS
        );
    }

    #[test]
    fn doubles_and_is_capped_on_failed_connects() {
        assert_eq!(next_backoff_ms(WATCH_BACKOFF_BASE_MS, false), 1000);
        assert_eq!(next_backoff_ms(4000, false), WATCH_BACKOFF_MAX_MS);
        assert_eq!(
            next_backoff_ms(WATCH_BACKOFF_MAX_MS, false),
            WATCH_BACKOFF_MAX_MS
        );
    }
}
