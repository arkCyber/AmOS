//! Host "wake → poll → re-arm" cycle for a daily exact alarm.
//!
//! This is the loop a device AlarmManager / host thread runs: given a registered
//! exact alarm, `next_at(now)` says *when to wake*, then `due(now)` fires it
//! (once) and the caller re-arms the next occurrence. Deterministic (fake wall
//! clock) so it runs on any host without a real device.

use amos_scheduler::exact::ExactAlarmClock;
use amos_scheduler::JobId;

const DAY_MS: u64 = 86_400_000;

#[test]
fn host_cycle_arms_wakes_fires_once_and_re_arms_next_day() {
    let mut clock = ExactAlarmClock::new();
    let morning = JobId::new("morning");

    // WebView registers: ring "morning" at some absolute instant.
    let first_at = 1_000_000 + 6 * 3_600_000; // 06:00 on "day 0" (arbitrary epoch base)
    clock.register(morning.clone(), first_at);

    let mut now = 1_000_000; // boot just after midnight on day 0

    // --- day 0: host sleeps until next_at, then polls & fires once ---
    let wake = clock.next_at(now).expect("an alarm is scheduled");
    assert_eq!(wake, first_at);
    now = wake;
    assert_eq!(clock.due(now), vec![morning.clone()]);
    assert!(clock.is_empty(), "fire-once: nothing left after due");

    // The Clock app re-arms the next day after the user acknowledges.
    clock.register(morning.clone(), first_at + DAY_MS);

    // --- day 1: same single fire ---
    let wake1 = clock.next_at(now).expect("next day re-armed");
    assert_eq!(wake1, first_at + DAY_MS);
    assert_eq!(clock.due(wake1), vec![morning.clone()]);
    assert!(clock.is_empty());

    // No re-fire of the same instant.
    assert!(clock.due(wake1).is_empty());
    assert_eq!(clock.next_at(wake1), None);
}
