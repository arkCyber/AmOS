//! Host↔guest **byte-channel bridge** lifecycle (P2, see `docs/clipboard-container-sync.md`
//! §5/§7). The real transport is a host↔guest socket/vsock bridge that only exists
//! on a Waydroid/device, so this module owns the parts that are **transport
//! independent and therefore offline-testable**:
//!
//! * [`Backoff`] — the reconnect-scheduling policy: exponential backoff with a cap,
//!   a finite retry budget (fail-safe: a dead peer is eventually given up on rather
//!   than retried forever), and `reset` once a connection has proven useful.
//! * [`supervise`] — a blocking driver that repeatedly: asks an injectable
//!   `connect` closure for a fresh connection (a [`Read`] transport), hands raw
//!   bytes to an injectable `consume` (host/guest codec + ingest), detects EOF /
//!   I-O / codec-fatal ends, and schedules reconnects through a [`Backoff`] and an
//!   injectable `sleep`. Both the transport and the sleep are injected, so the whole
//!   reconnect/backoff discipline is exercised headless with in-memory connectors.
//!
//! On-device you supply a real `connect` (host: a Unix/vsock client to the guest;
//! guest: a listener) and `|d| std::thread::sleep(d)`; everything above the bytes
//! is identical to what is tested here.

use std::io::Read;
use std::time::Duration;

/// Exponential reconnect backoff policy (deterministic — no jitter).
///
/// Delays grow `base × 2^n` (clamped to `max`) for each consecutive failure; after
/// [`Backoff::max_retries`] failures `retry_delay` returns `None` so the caller can
/// give up (fail-safe: never retry a dead peer forever). [`Backoff::reset`] clears
/// the failure count after a connection proved useful.
#[derive(Debug, Clone)]
pub struct Backoff {
    base_ms: u64,
    max_ms: u64,
    max_retries: usize,
    failures: usize,
}

impl Backoff {
    /// Exponential backoff from `base_ms`, never exceeding `max_ms`, giving up
    /// after `max_retries` consecutive failures (must be `> 0`).
    pub fn new(base_ms: u64, max_ms: u64, max_retries: usize) -> Self {
        Self {
            base_ms,
            max_ms,
            max_retries: max_retries.max(1),
            failures: 0,
        }
    }

    /// How long to wait before the *next* retry, or `None` to give up. Increments
    /// the internal failure count.
    pub fn retry_delay(&mut self) -> Option<Duration> {
        if self.failures >= self.max_retries {
            return None;
        }
        let n = self.failures;
        self.failures += 1;
        let mult = 1u64 << n.min(20); // guard the shift against overflow
        let ms = self.base_ms.saturating_mul(mult).min(self.max_ms);
        Some(Duration::from_millis(ms))
    }

    /// Clear the failure count (call after a connection has carried bytes).
    pub fn reset(&mut self) {
        self.failures = 0;
    }

    /// Consecutive failures seen so far.
    pub fn failures(&self) -> usize {
        self.failures
    }

    /// The total retry budget.
    pub fn max_retries(&self) -> usize {
        self.max_retries
    }

    /// The smallest wait between any two attempts (the base delay). Used as a
    /// reconnect **floor** so a reachable-but-flapping peer (opens, sends a little,
    /// closes) cannot make us reconnect at zero delay forever.
    pub fn min_delay(&self) -> Duration {
        Duration::from_millis(self.base_ms)
    }
}

/// Drive a blocking connect → drain → reconnect loop until [`Backoff`] gives up.
///
/// The loop never returns on success (it runs until the peer is gone for good);
/// it only terminates by returning `Err` once the [`Backoff`] retry budget is
/// exhausted. Callers wanting to observe connection/session events use the
/// `report` callback.
///
/// * `connect` — open a fresh connection; `Err` counts as one failed attempt.
/// * `on_connected` — called once per successful open (reset per-connection codec
///   state here — a partial frame must never survive a reconnect).
/// * `consume` — feed raw bytes read from the connection; `Err` marks the codec as
///   fatally out of sync and ends this connection.
/// * `sleep` — injectable wait (tests record it; production passes `thread::sleep`).
/// * `report` — receives a short reason for diagnostics each time a connection ends.
///
/// Backoff rule: connect **failures** back off exponentially; a connection that
/// carried **zero bytes** before ending is treated as a failure (guards against a
/// tight reconnect loop when a peer accepts then immediately drops); a connection
/// that exchanged bytes and then **closed cleanly** is reachable, so we reset the
/// backoff and reconnect after a base **floor** ([`Backoff::min_delay`], never
/// zero — a flapping peer cannot make us spin); a connection that ended on a
/// codec/I-O error keeps backing off exponentially so a persistently-corrupting
/// peer is throttled.
#[allow(clippy::type_complexity)]
pub fn supervise<C: Read>(
    mut backoff: Backoff,
    connect: &mut dyn FnMut() -> Result<C, String>,
    on_connected: &mut dyn FnMut(),
    consume: &mut dyn FnMut(&[u8]) -> Result<(), String>,
    sleep: &mut dyn FnMut(Duration),
    report: &mut dyn FnMut(&str),
) -> Result<(), String> {
    loop {
        let mut conn = match connect() {
            Ok(c) => c,
            Err(e) => {
                report("connect-failed");
                let Some(delay) = backoff.retry_delay() else {
                    return Err(format!("link gave up after retries: {e}"));
                };
                sleep(delay);
                continue;
            }
        };
        on_connected();

        // Drain until EOF / I-O error / codec-fatal.
        let mut chunk = [0u8; 4096];
        let mut bytes_read: u64 = 0;
        let end: Result<(), String> = loop {
            match conn.read(&mut chunk) {
                Ok(0) => break Ok(()), // clean EOF: peer closed
                Ok(n) => {
                    bytes_read += n as u64;
                    if let Err(e) = consume(&chunk[..n]) {
                        break Err(e);
                    }
                }
                Err(e) => break Err(format!("read error: {e}")),
            }
        };
        if bytes_read == 0 {
            // Accepted but yielded nothing — treat as a failed attempt so we don't
            // busy-loop against an accept-then-drop peer.
            report("no-bytes");
            let Some(delay) = backoff.retry_delay() else {
                return Err("link gave up: connection never carried bytes".to_string());
            };
            sleep(delay);
            continue;
        }
        // A clean close after carrying bytes means the peer is reachable: reset the
        // backoff and reconnect promptly — but never at ZERO delay (min_delay floor),
        // so a reachable-but-flapping peer cannot make us hot-loop.
        if let Err(e) = end {
            report("codec-or-io-error");
            // Persistent corruption / I-O errors still back off exponentially.
            let Some(delay) = backoff.retry_delay() else {
                return Err(format!("link gave up after stream error: {e}"));
            };
            sleep(delay);
            continue;
        }
        backoff.reset();
        report("closed");
        sleep(backoff.min_delay());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::io::Cursor;
    use std::rc::Rc;

    fn ms(d: Duration) -> u64 {
        d.as_millis() as u64
    }

    fn ms_seq(ds: &[Duration]) -> Vec<u64> {
        ds.iter().map(|d| ms(*d)).collect()
    }

    /// Drives [`supervise`] over an in-memory queue of per-connection byte payloads
    /// (each served to EOF) and returns the recorded history. Connections are
    /// exhausted by failing once the queue is empty, so `supervise` always ends in
    /// `Err` ("gave up") — on a real device it would run forever.
    fn drive(backoff: Backoff, payloads: Vec<Vec<u8>>, fatal_marker: Option<u8>) -> Harness {
        let queue: Rc<RefCell<Vec<Vec<u8>>>> = Rc::new(RefCell::new(payloads));
        let connected = Rc::new(Cell::new(0u64));
        let fed = Rc::new(RefCell::new(Vec::<u8>::new()));
        let sleeps = Rc::new(RefCell::new(Vec::<Duration>::new()));
        let reports = Rc::new(RefCell::new(Vec::<String>::new()));

        let mut connect = {
            let q = queue.clone();
            move || {
                let mut qq = q.borrow_mut();
                if qq.is_empty() {
                    Err("exhausted".into())
                } else {
                    Ok(Cursor::new(qq.remove(0)))
                }
            }
        };
        let mut on_connected = {
            let c = connected.clone();
            move || c.set(c.get() + 1)
        };
        let mut consume = {
            let f = fed.clone();
            let marker = fatal_marker;
            move |data: &[u8]| {
                if let Some(m) = marker {
                    if data.contains(&m) {
                        return Err("fatal-decode".into());
                    }
                }
                f.borrow_mut().extend_from_slice(data);
                Ok(())
            }
        };
        let mut sleep = {
            let s = sleeps.clone();
            move |d| s.borrow_mut().push(d)
        };
        let mut report = {
            let r = reports.clone();
            move |m: &str| r.borrow_mut().push(m.to_string())
        };

        let outcome = supervise::<Cursor<Vec<u8>>>(
            backoff,
            &mut connect,
            &mut on_connected,
            &mut consume,
            &mut sleep,
            &mut report,
        );
        // Snapshot each counter before the Rc handles are dropped at end of scope.
        let connected = connected.get();
        let fed = fed.borrow().clone();
        let sleeps = sleeps.borrow().clone();
        let reports = reports.borrow().clone();
        Harness {
            outcome,
            connected,
            fed,
            sleeps,
            reports,
        }
    }

    struct Harness {
        outcome: Result<(), String>,
        connected: u64,
        fed: Vec<u8>,
        sleeps: Vec<Duration>,
        reports: Vec<String>,
    }

    // ---- Backoff policy ----

    #[test]
    fn backoff_goes_exponential_then_gives_up() {
        let mut b = Backoff::new(10, 60, 4);
        assert_eq!(b.retry_delay().unwrap(), Duration::from_millis(10));
        assert_eq!(b.retry_delay().unwrap(), Duration::from_millis(20));
        assert_eq!(b.retry_delay().unwrap(), Duration::from_millis(40));
        assert_eq!(
            b.retry_delay().unwrap(),
            Duration::from_millis(60),
            "clamped at max"
        );
        assert_eq!(b.retry_delay(), None, "budget exhausted -> give up");
        assert_eq!(b.failures(), 4);
    }

    #[test]
    fn backoff_clamps_growth_to_max() {
        let mut b = Backoff::new(1, 8, 6);
        let got: Vec<u64> = (0..6)
            .map(|_| b.retry_delay().unwrap().as_millis() as u64)
            .collect();
        assert_eq!(got, [1, 2, 4, 8, 8, 8]);
        assert_eq!(b.retry_delay(), None);
    }

    #[test]
    fn backoff_shift_does_not_overflow() {
        let mut b = Backoff::new(u64::MAX / 2, u64::MAX, 40);
        let d = b.retry_delay().unwrap();
        assert_eq!(ms(d), ms(Duration::from_millis(u64::MAX / 2)));
    }

    #[test]
    fn backoff_reset_clears_failures() {
        let mut b = Backoff::new(10, 100, 3);
        let _ = b.retry_delay(); // 10, failures=1
        let _ = b.retry_delay(); // 20, failures=2
        b.reset();
        assert_eq!(b.failures(), 0);
        assert_eq!(
            b.retry_delay().unwrap(),
            Duration::from_millis(10),
            "restart from base"
        );
    }

    #[test]
    fn backoff_forces_min_one_retry() {
        let mut b = Backoff::new(10, 100, 0); // caller bug: force >= 1
        assert!(b.retry_delay().is_some());
    }

    #[test]
    fn backoff_min_delay_is_base_and_independent() {
        let b = Backoff::new(25, 100, 4);
        assert_eq!(b.min_delay(), Duration::from_millis(25));
    }

    // ---- supervise: reconnect + backoff ----

    #[test]
    fn stable_connections_reset_backoff_then_give_up_on_exhaustion() {
        let h = drive(
            Backoff::new(10, 60, 3),
            vec![b"conn-a".to_vec(), b"conn-b".to_vec()],
            None,
        );
        assert_eq!(h.connected, 2, "two successful opens");
        assert_eq!(h.fed, b"conn-aconn-b");
        // Each useful clean close reconnects after the base floor (10ms, never 0);
        // then the three connect failures that follow (queue exhausted) grow
        // 10/20/40ms before giving up.
        assert_eq!(ms_seq(&h.sleeps), [10, 10, 10, 20, 40]);
        assert_eq!(
            h.reports.iter().filter(|r| r.as_str() == "closed").count(),
            2
        );
        assert!(
            h.outcome.is_err(),
            "gives up once the peer is gone for good"
        );
    }

    #[test]
    fn empty_connection_is_treated_as_failure_to_avoid_busy_loop() {
        let h = drive(Backoff::new(10, 60, 2), vec![Vec::new(), Vec::new()], None);
        assert_eq!(h.connected, 2, "both empty opens counted");
        assert!(h.fed.is_empty(), "nothing to ingest");
        assert_eq!(
            ms_seq(&h.sleeps),
            [10, 20],
            "exponential backoff on no-bytes"
        );
        assert_eq!(
            h.reports
                .iter()
                .filter(|r| r.as_str() == "no-bytes")
                .count(),
            2
        );
        assert!(h.outcome.as_ref().unwrap_err().contains("gave up"));
    }

    #[test]
    fn codec_fatal_ends_connection_and_reconnects() {
        // First connection carries good bytes; second carries a fatal marker.
        let h = drive(
            Backoff::new(10, 60, 2),
            vec![b"good".to_vec(), vec![0u8]],
            Some(0u8),
        );
        assert_eq!(h.fed, b"good", "the fatal chunk is not fed");
        assert!(
            h.reports.iter().any(|r| r.as_str() == "codec-or-io-error"),
            "a codec-fatal connection is reported"
        );
        assert!(h.connected >= 2, "reconnect attempted after the fatal drop");
        assert!(h.outcome.is_err());
    }

    #[test]
    fn flaky_peer_backs_off_until_give_up() {
        // Never connects: must back off 10/20/40 then give up.
        let h = drive(Backoff::new(10, 60, 3), Vec::new(), None);
        assert_eq!(h.connected, 0);
        assert_eq!(ms_seq(&h.sleeps), [10, 20, 40]);
        assert!(h.outcome.as_ref().unwrap_err().contains("gave up"));
    }

    #[test]
    fn flapping_reachable_peer_is_throttled_to_floor_not_zero() {
        // Three short-but-useful sessions then exhaustion. A reachable peer that
        // keeps opening/sending-a-little/closing must be throttled to the base
        // floor (10ms) between reconnects — never reconnected at zero delay.
        let h = drive(
            Backoff::new(10, 60, 3),
            vec![b"x".to_vec(), b"y".to_vec(), b"z".to_vec()],
            None,
        );
        assert_eq!(h.connected, 3);
        let sleeps = ms_seq(&h.sleeps);
        assert!(
            sleeps.iter().all(|d| *d >= 10),
            "no zero-delay reconnect is allowed for a reachable-but-flapping peer"
        );
        // Three base-floor waits (one per clean close), then exponential growth on
        // the final connect-failure sequence before giving up.
        assert_eq!(&sleeps[..3], &[10, 10, 10]);
        assert_eq!(&sleeps[3..], &[10, 20, 40]);
        assert!(h.outcome.is_err());
    }

    #[test]
    fn on_connected_reset_hook_fires_per_open() {
        let h = drive(Backoff::new(5, 40, 1), vec![b"ping".to_vec()], None);
        assert_eq!(h.connected, 1);
        assert_eq!(h.fed, b"ping");
    }
}
