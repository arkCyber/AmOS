//! Integration: a full device-idle cycle — an exact alarm wakes the device, and
//! deferred background jobs are withheld during Doze then coalesce into the next
//! maintenance window (fewer wakes), then complete.

use amos_scheduler::{JobId, PowerState, ScheduledJob, Scheduler};

#[test]
fn doze_cycle_aligns_deferred_and_lets_alarm_through() {
    let mut s = Scheduler::new();
    // A user alarm at tick 300 must fire even while idle.
    s.register(ScheduledJob::alarm(JobId::new("wake.alarm"), 300).unwrap())
        .unwrap();
    // Background jobs (deep-link prefetch, model refresh) with wide windows.
    s.register(ScheduledJob::deferred(JobId::new("bg.prefetch"), 100, 900).unwrap())
        .unwrap();
    s.register(ScheduledJob::deferred(JobId::new("bg.cleanup"), 120, 900).unwrap())
        .unwrap();

    // Device asleep (Doze), no maintenance window yet, no charger.
    let idle = PowerState {
        dozing: true,
        maintenance_open: false,
        charging: false,
    };

    // At tick 150 nothing may run while idle (alarm is later).
    assert_eq!(s.due(150, idle), Vec::<JobId>::new());
    // The next guaranteed wake is the exact alarm.
    assert_eq!(s.next_wake(150), Some(300));

    // At the alarm time it fires even during Doze.
    assert_eq!(s.due(300, idle), vec![JobId::new("wake.alarm")]);
    s.complete(&JobId::new("wake.alarm"));

    // Still idle with no window: deferred work is withheld.
    assert_eq!(s.due(400, idle), Vec::<JobId>::new());

    // A maintenance window opens → both deferred jobs run together in one batch.
    let window = PowerState {
        dozing: true,
        maintenance_open: true,
        charging: false,
    };
    assert_eq!(
        s.due(450, window),
        vec![JobId::new("bg.cleanup"), JobId::new("bg.prefetch")]
    );
    s.complete(&JobId::new("bg.prefetch"));
    s.complete(&JobId::new("bg.cleanup"));
    assert!(s.is_empty());
}
