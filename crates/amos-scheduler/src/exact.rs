//! `ExactAlarmClock` — the wall-clock, fire-once exact-alarm host that sits on
//! top of the generic [`Scheduler`](crate::Scheduler).
//!
//! The base `Scheduler` reasons in the caller's *monotonic ticks* and keeps an
//! exact alarm until the caller completes it. To ring a Clock alarm at an
//! absolute wall-clock instant — the moment the WebView / Clock screen might NOT
//! be the thing doing the timing — we want a tiny, fire-once ledger keyed by
//! real epoch **milliseconds**:
//!
//! * `register(id, at_ms)` — one-shot "ring `id` at this absolute ms".
//! * `due(now_ms)` — returns & removes the alarms whose time has arrived (each
//!   fires exactly once).
//! * `next_at(now_ms)` — the earliest future instant to wake for (the value a
//!   real `AlarmManager` / exact-wake binder consumes: “sleep until then”).
//! * `cancel(id)` / re-register — how the Clock app updates its alarms.
//!
//! Pure `std`, no clock of its own (the caller supplies `now_ms`), so it is
//! deterministically testable with an injected/fake wall clock. Binding this
//! ledger's `next_at` to an OS exact-wake (Android `AlarmManager`, or a Tauri
//! host thread that sleeps until `next_at` then calls `due` and wakes the
//! WebView) is a caller-side seam — see `docs/native-alarm-bridge.md`.

use std::collections::BTreeMap;

use crate::spec::JobId;

/// One scheduled exact alarm (epoch milliseconds at which it should fire).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExactAlarm {
    /// Absolute wall-clock instant (ms since the Unix epoch) to fire.
    pub at_ms: u64,
}

/// A register of one-shot exact wall-clock alarms, ordered by fire time.
#[derive(Clone, Debug, Default)]
pub struct ExactAlarmClock {
    /// `id -> at_ms`, kept also in a time-ordered index.
    alarms: BTreeMap<JobId, u64>,
}

impl ExactAlarmClock {
    pub fn new() -> Self {
        Self {
            alarms: BTreeMap::new(),
        }
    }

    /// Number of outstanding (not-yet-fired) alarms.
    pub fn len(&self) -> usize {
        self.alarms.len()
    }

    pub fn is_empty(&self) -> bool {
        self.alarms.is_empty()
    }

    /// Whether an alarm id is currently registered.
    pub fn contains(&self, id: &JobId) -> bool {
        self.alarms.contains_key(id)
    }

    /// Schedule (or re-schedule) a one-shot alarm at an absolute epoch `at_ms`.
    /// Registering an existing id replaces its previous time.
    pub fn register(&mut self, id: JobId, at_ms: u64) {
        self.alarms.insert(id, at_ms);
    }

    /// Remove an alarm without firing it. Returns whether it was present.
    pub fn cancel(&mut self, id: &JobId) -> bool {
        self.alarms.remove(id).is_some()
    }

    /// Fire every registered alarm whose time has arrived by `now_ms`. Each
    /// fires exactly once (removed on return). Results are ordered by fire time
    /// (ties by id) so a caller can surface multiple alarms predictably.
    pub fn due(&mut self, now_ms: u64) -> Vec<JobId> {
        // Collect (at_ms, id) for all due, sort by time then id, remove them.
        let mut due: Vec<(u64, JobId)> = self
            .alarms
            .iter()
            .filter(|(_, at)| **at <= now_ms)
            .map(|(id, at)| (*at, id.clone()))
            .collect();
        due.sort();
        let fired: Vec<JobId> = due.into_iter().map(|(_, id)| id).collect();
        for id in &fired {
            self.alarms.remove(id);
        }
        fired
    }

    /// The earliest future instant (ms) to wake for, if any is scheduled.
    pub fn next_at(&self, now_ms: u64) -> Option<u64> {
        self.alarms
            .values()
            .copied()
            .filter(|at| *at > now_ms)
            .min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_counts_and_cancels() {
        let mut c = ExactAlarmClock::new();
        assert!(c.is_empty());
        c.register(JobId::new("a"), 100);
        c.register(JobId::new("b"), 200);
        assert_eq!(c.len(), 2);
        assert!(c.contains(&JobId::new("a")));
        assert!(c.cancel(&JobId::new("a")));
        assert_eq!(c.len(), 1);
        assert!(!c.cancel(&JobId::new("a"))); // already gone
    }

    #[test]
    fn due_fires_once_ordered_and_removes() {
        let mut c = ExactAlarmClock::new();
        c.register(JobId::new("late"), 300);
        c.register(JobId::new("now"), 100);
        c.register(JobId::new("soon"), 150);
        assert_eq!(c.due(99), Vec::<JobId>::new()); // nothing yet
        assert_eq!(c.due(150), vec![JobId::new("now"), JobId::new("soon")]);
        assert_eq!(c.len(), 1, "only the late alarm remains");
        // Not re-fired on a later poll.
        assert_eq!(c.due(999), vec![JobId::new("late")]);
        assert!(c.is_empty());
    }

    #[test]
    fn next_at_reports_earliest_future_wake() {
        let mut c = ExactAlarmClock::new();
        assert_eq!(c.next_at(0), None);
        c.register(JobId::new("far"), 1000);
        c.register(JobId::new("near"), 500);
        assert_eq!(c.next_at(0), Some(500));
        assert_eq!(c.next_at(600), Some(1000));
        assert_eq!(c.next_at(5000), None);
    }

    #[test]
    fn re_registration_replaces_time_and_reschedules_daily() {
        let mut c = ExactAlarmClock::new();
        let id = JobId::new("morning");
        c.register(id.clone(), 1_000);
        assert_eq!(c.due(999), Vec::<JobId>::new());
        // Fired at 1000.
        assert_eq!(c.due(1_000), vec![id.clone()]);
        // Re-arm for the next day (a daily alarm the Clock app re-registers).
        c.register(id.clone(), 86_400_000);
        assert_eq!(c.next_at(5_000), Some(86_400_000));
        assert_eq!(c.due(86_400_000), vec![id]);
    }
}
