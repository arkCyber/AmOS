//! Tauri host bridge for native exact alarms (§9 ③, docs/native-alarm-bridge.md).
//!
//! Owns one process-wide [`ExactAlarmClock`] and exposes three commands the
//! WebView calls so alarm "ring at this absolute wall-clock instant" decisions
//! live in native code (not throttlable JS timers):
//!
//! * `scheduler_alarm_register { id, atMs }`
//! * `scheduler_alarm_cancel { id }`
//! * `scheduler_alarm_poll { nowMs? } -> [id, …]`  (fires due alarms once)
//!
//! A real host that must *wake a sleeping/dead process* would take the clock's
//! `next_at` and hand it to an OS exact-wake (`AlarmManager` on Android) — that
//! device binding stays a caller/device seam (see the docs). While the process is
//! alive, a poll thread can simply sleep until `next_at`, then `poll`, and surface
//! the due ids to the WebView.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use amos_scheduler::exact::ExactAlarmClock;
use amos_scheduler::JobId;
use serde::Serialize;
use tauri::State;

/// Wall-clock epoch (ms) now, never panicking / never negative.
fn now_ms() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis().min(u64::MAX as u128) as u64,
        Err(_) => 0,
    }
}

/// Process-shared exact-alarm ledger the three commands operate on.
pub struct AlarmSchedState {
    inner: Mutex<ExactAlarmClock>,
}

impl Default for AlarmSchedState {
    fn default() -> Self {
        Self::new()
    }
}

impl AlarmSchedState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(ExactAlarmClock::new()),
        }
    }

    /// Schedule (or reschedule) a one-shot alarm at an absolute epoch ms.
    pub fn register(&self, id: String, at_ms: u64) {
        self.lock().register(JobId::new(id), at_ms);
    }

    /// Cancel a pending alarm; returns whether it was present.
    pub fn cancel(&self, id: &str) -> bool {
        self.lock().cancel(&JobId::new(id))
    }

    /// Fire & return the ids whose time has arrived by `now`.
    pub fn poll(&self, now: u64) -> Vec<String> {
        self.lock()
            .due(now)
            .into_iter()
            .map(|id| id.as_str().to_owned())
            .collect()
    }

    /// Earliest future wake instant (feeds an OS exact-wake / poll sleep).
    pub fn next_at(&self, now: u64) -> Option<u64> {
        self.lock().next_at(now)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ExactAlarmClock> {
        // Poison-recover: a panicked writer must never deadlock the commands.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Serializable poll answer (ids as plain strings for the JS bridge).
#[derive(Clone, Debug, Serialize)]
pub struct AlarmPoll {
    pub due: Vec<String>,
}

/// Register a one-shot exact alarm at `atMs` (absolute epoch ms).
#[tauri::command]
pub fn scheduler_alarm_register(
    state: State<'_, AlarmSchedState>,
    id: String,
    at_ms: u64,
) -> Result<(), String> {
    state.register(id, at_ms);
    Ok(())
}

/// Cancel a pending alarm. Returns whether it was registered.
#[tauri::command]
pub fn scheduler_alarm_cancel(state: State<'_, AlarmSchedState>, id: String) -> Result<bool, String> {
    Ok(state.cancel(&id))
}

/// Fire & return the ids due by `nowMs` (defaults to the host wall clock).
#[tauri::command]
pub fn scheduler_alarm_poll(
    state: State<'_, AlarmSchedState>,
    now_ms: Option<u64>,
) -> Result<AlarmPoll, String> {
    let now = match now_ms {
        Some(v) => v,
        // `now_ms` here is the Option param (it shadows the module fn of the
        // same name), so call the free fn via its full path to avoid E0618.
        None => crate::alarm_sched::now_ms(),
    };
    Ok(AlarmPoll {
        due: state.poll(now),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> AlarmSchedState {
        AlarmSchedState::new()
    }

    #[test]
    fn register_poll_fires_once_and_cancel_removes() {
        let s = state();
        s.register("wake".into(), 1_000);
        assert!(s.cancel("wake")); // removed before it fires
        assert!(!s.cancel("wake"));

        s.register("wake".into(), 1_000);
        s.register("later".into(), 2_000);
        assert_eq!(s.poll(999), Vec::<String>::new());
        assert_eq!(s.poll(1_000), vec!["wake".to_string()]);
        // Not re-fired on a later poll.
        assert_eq!(s.poll(9_999), vec!["later".to_string()]);
        assert!(s.poll(9_999).is_empty());
    }

    #[test]
    fn next_at_feeds_a_wake_time() {
        let s = state();
        assert_eq!(s.next_at(0), None);
        s.register("a".into(), 500);
        s.register("b".into(), 1_000);
        assert_eq!(s.next_at(0), Some(500));
        assert_eq!(s.next_at(600), Some(1_000));
        assert_eq!(s.next_at(5_000), None);
    }

    #[test]
    fn re_register_reschedules_a_daily_alarm() {
        let s = state();
        s.register("daily".into(), 86_400_000);
        assert_eq!(s.poll(86_400_000), vec!["daily".to_string()]);
        // The caller re-arms the next day.
        s.register("daily".into(), 2 * 86_400_000);
        assert_eq!(s.next_at(86_400_001), Some(2 * 86_400_000));
    }
}
