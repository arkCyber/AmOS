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

/// A register of one-shot exact wall-clock alarms, keyed by id.
///
/// The map is ordered by [`JobId`], **not** by fire time — there is no
/// time-ordered index. The fire-time ordering [`Self::due`] promises is produced
/// by the explicit `sort()` in that method, not by the storage: the sort is
/// load-bearing, and deleting it would silently hand fired alarms back in id
/// order while the docs still claimed fire order. (REQ-A544.)
#[derive(Clone, Debug, Default)]
pub struct ExactAlarmClock {
    /// `id -> at_ms`. Id-keyed; this is the **only** index (see the type docs).
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
    /// (ties by id) so a caller can surface multiple alarms predictably — an
    /// explicit `sort()` below provides that, since the map itself is id-ordered
    /// (see the type docs). (REQ-A544.)
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
    ///
    /// A linear scan over the id-keyed map — there is no time-ordered index to
    /// consult (see the type docs), so this is O(n), not O(log n). (REQ-A544.)
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

    /// The documented fire-time ordering is produced by `due`'s explicit
    /// `sort()`, not by the storage (the map is id-ordered). The ids here are
    /// chosen so id order and time order **disagree** (`z` fires before `a`) —
    /// the only shape that can catch a missing sort, since `late`/`now`/`soon`
    /// happen to sort both ways alike. (REQ-A544.)
    #[test]
    fn due_orders_by_fire_time_not_by_id() {
        let mut c = ExactAlarmClock::new();
        // id order: "a" < "m" < "z"; fire order: z(100), a(200), m(300).
        c.register(JobId::new("m"), 300);
        c.register(JobId::new("z"), 100);
        c.register(JobId::new("a"), 200);
        assert_eq!(
            c.due(300),
            vec![JobId::new("z"), JobId::new("a"), JobId::new("m")],
            "fired alarms must be ordered by fire time, not by id"
        );

        // Equal fire times tie-break by id.
        let mut t = ExactAlarmClock::new();
        t.register(JobId::new("b"), 50);
        t.register(JobId::new("a"), 50);
        assert_eq!(t.due(50), vec![JobId::new("a"), JobId::new("b")]);
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
