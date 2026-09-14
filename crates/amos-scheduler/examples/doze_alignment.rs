//! `doze_alignment` — deferred work that coalesces, and the gate that holds it back.
//!
//! Registers an exact alarm and three deferred jobs with wide windows, then advances a fake
//! clock: while the device is awake the deferred jobs may run when due; once it dozes they are
//! **withheld** until a maintenance window opens (or the charger is attached). The example also
//! prints the coalesced `next_wake` — one wakeup instead of four.
//!
//! Usage:
//! ```text
//! cargo run -p amos-scheduler --example doze_alignment
//! ```

use amos_scheduler::{JobId, JobType, PowerState, ScheduledJob, Scheduler};

fn dump(now: u64, scheduler: &Scheduler) {
    let (alarms, deferred) = scheduler.counts();
    let entries: Vec<String> = scheduler
        .entries()
        .into_iter()
        .map(|(id, kind, earliest, latest)| {
            format!("{}:{:?}[{earliest}..{latest}]", id.as_str(), kind)
        })
        .collect();
    println!(
        "t={now:<4} alarms={alarms} deferred={deferred} next_wake={:?} jobs=[{}]",
        scheduler.next_wake(now),
        entries.join(", ")
    );
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut scheduler = Scheduler::new();

    // A user-visible alarm: it runs when its time arrives, Doze or not.
    scheduler.register(ScheduledJob::alarm(JobId::new("wake-me"), 30)?)?;
    // Background work with a window each: the scheduler may align these with each other.
    scheduler.register(ScheduledJob::deferred(JobId::new("sync-mail"), 10, 40)?)?;
    scheduler.register(ScheduledJob::deferred(JobId::new("reindex-notes"), 15, 45)?)?;
    scheduler.register(ScheduledJob::deferred(JobId::new("cleanup"), 20, 60)?)?;
    println!("registered 4 job(s)");
    dump(0, &scheduler);

    // Awake, nothing due yet.
    println!(
        "due at t=5,  awake: {:?}",
        scheduler.due(5, PowerState::awake())
    );

    // Due now, awake: the deferred jobs run.
    let due = scheduler.due(20, PowerState::awake());
    println!("due at t=20, awake: {due:?}");
    for id in &due {
        scheduler.complete(id);
    }
    dump(20, &scheduler);

    // Now Doze without a maintenance window: deferred work is withheld, the alarm is not.
    let dozing = PowerState {
        dozing: true,
        maintenance_open: false,
        charging: false,
    };
    println!(
        "deferred runnable while dozing? {}",
        dozing.deferred_runnable()
    );
    let due = scheduler.due(35, dozing);
    println!("due at t=35, dozing: {due:?}  (only the exact alarm may run)");
    for id in &due {
        scheduler.complete(id);
    }

    // A maintenance window opens (or a charger appears): the withheld work runs.
    let window = PowerState {
        dozing: true,
        maintenance_open: true,
        charging: false,
    };
    let due = scheduler.due(40, window);
    println!("due at t=40, maintenance open: {due:?}");
    for id in &due {
        scheduler.complete(id);
    }
    let charging = PowerState {
        charging: true,
        ..PowerState::default()
    };
    println!(
        "due at t=45, charging: {:?}  (charging makes deferred work cheap)",
        scheduler.due(45, charging)
    );

    // Jobs whose window closed without running are expired, and said so.
    let expired = scheduler.expire(100);
    println!("expired by t=100: {expired:?}");
    dump(100, &scheduler);
    println!(
        "kind of \"wake-me\": {:?}",
        scheduler.kind(&JobId::new("wake-me"))
    );
    println!(
        "cancel(\"wake-me\") -> {}",
        scheduler.cancel(&JobId::new("wake-me"))
    );
    println!("remaining: {}", scheduler.len());
    let _ = JobType::AlarmExact;
    Ok(())
}
