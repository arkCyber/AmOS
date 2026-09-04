//! The [`Scheduler`]: a deterministic register of alarm/deferred jobs with
//! Doze-compliant due-batching and a next-wake answer.

use std::collections::BTreeMap;

use crate::error::SchedulerError;
use crate::spec::{JobId, JobType, PowerState};

/// Convenience result alias.
pub type Result<T> = std::result::Result<T, SchedulerError>;

/// One registered job: its kind and the window `[earliest, latest]` (in the
/// caller's monotonic ticks) within which it may run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduledJob {
    pub id: JobId,
    pub job_type: JobType,
    /// First tick at which the job may run.
    pub earliest: u64,
    /// Last tick at which a deferred job is still valid (an exact alarm is due
    /// from `earliest` on).
    pub latest: u64,
}

impl ScheduledJob {
    /// Build a job, rejecting an inverted window (`latest < earliest`).
    pub fn new(id: JobId, job_type: JobType, earliest: u64, latest: u64) -> Result<Self> {
        if latest < earliest {
            return Err(SchedulerError::InvalidWindow {
                id: id.to_string(),
                earliest,
                latest,
            });
        }
        Ok(Self {
            id,
            job_type,
            earliest,
            latest,
        })
    }

    /// A user-visible exact alarm scheduled for tick `at`.
    pub fn alarm(id: JobId, at: u64) -> Result<Self> {
        Self::new(id, JobType::AlarmExact, at, at)
    }

    /// A deferred job valid anywhere in `[earliest, latest]` (alignable).
    pub fn deferred(id: JobId, earliest: u64, latest: u64) -> Result<Self> {
        Self::new(id, JobType::Deferred, earliest, latest)
    }
}

/// The job register. Jobs are removed when the caller completes/fires them, so
/// `len()` counts outstanding (unfired) jobs.
pub struct Scheduler {
    jobs: BTreeMap<JobId, ScheduledJob>,
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl Scheduler {
    pub fn new() -> Self {
        Self {
            jobs: BTreeMap::new(),
        }
    }

    /// Number of outstanding (registered, unfired) jobs.
    pub fn len(&self) -> usize {
        self.jobs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }

    pub fn contains(&self, id: &JobId) -> bool {
        self.jobs.contains_key(id)
    }

    /// The job kind of a registered job, if any.
    pub fn kind(&self, id: &JobId) -> Option<JobType> {
        self.jobs.get(id).map(|j| j.job_type)
    }

    /// Register a job (overwriting any existing job with the same id).
    pub fn register(&mut self, job: ScheduledJob) -> Result<()> {
        // Re-validate so callers can't bypass via the raw struct.
        if job.latest < job.earliest {
            return Err(SchedulerError::InvalidWindow {
                id: job.id.to_string(),
                earliest: job.earliest,
                latest: job.latest,
            });
        }
        self.jobs.insert(job.id.clone(), job);
        Ok(())
    }

    /// Remove a job without running it (cancel).
    pub fn cancel(&mut self, id: &JobId) -> bool {
        self.jobs.remove(id).is_some()
    }

    /// Mark a job as fired/complete (remove it from the outstanding set).
    pub fn complete(&mut self, id: &JobId) -> bool {
        self.cancel(id)
    }

    /// The next tick the device must be awake for an **exact** alarm that is not
    /// yet due (`earliest > now`), so a caller can sleep the device until then.
    /// Deferred work gives no guaranteed wake (it runs in a maintenance window or
    /// when awake/charging), so it does not influence this answer.
    pub fn next_wake(&self, now: u64) -> Option<u64> {
        self.jobs
            .values()
            .filter(|j| j.job_type == JobType::AlarmExact && j.earliest > now)
            .map(|j| j.earliest)
            .min()
    }

    /// All jobs due to run at `now` under the given `power` state.
    ///
    /// * **Exact alarms**: due once `now >= earliest` (the caller is the authority
    ///   on idle-cadence policy) — returned first.
    /// * **Deferred jobs**: due only when `earliest <= now <= latest` **and** the
    ///   power state allows deferred work (charging / not dozing / open
    ///   maintenance window). Every deferred job whose window covers `now` is
    ///   returned together — the coalesced "run them all in one batch" behaviour
    ///   that minimises wakeups.
    ///
    /// Results are in stable (id) order. The caller fires them then calls
    /// [`Self::complete`] on each.
    pub fn due(&self, now: u64, power: PowerState) -> Vec<JobId> {
        let mut exact = Vec::new();
        let mut deferred = Vec::new();
        for j in self.jobs.values() {
            match j.job_type {
                JobType::AlarmExact if j.earliest <= now => exact.push(j.id.clone()),
                JobType::Deferred
                    if j.earliest <= now && now <= j.latest && power.deferred_runnable() =>
                {
                    deferred.push(j.id.clone());
                }
                _ => {}
            }
        }
        // Exact alarms first (user-visible urgency), then the deferred batch.
        exact.extend(deferred);
        exact
    }

    /// Outstanding job count split by kind: `(exact, deferred)`.
    pub fn counts(&self) -> (usize, usize) {
        let exact = self
            .jobs
            .values()
            .filter(|j| j.job_type == JobType::AlarmExact)
            .count();
        (exact, self.jobs.len() - exact)
    }

    /// Stable snapshot of every outstanding job as `(id, kind, earliest, latest)`.
    pub fn entries(&self) -> Vec<(JobId, JobType, u64, u64)> {
        self.jobs
            .values()
            .map(|j| (j.id.clone(), j.job_type, j.earliest, j.latest))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::JobType;

    #[test]
    fn invalid_window_is_rejected_on_build_and_register() {
        // Builder rejects.
        assert_eq!(
            ScheduledJob::new(JobId::new("x"), JobType::Deferred, 10, 5),
            Err(SchedulerError::InvalidWindow {
                id: "x".to_string(),
                earliest: 10,
                latest: 5
            })
        );
        // Raw-struct register re-validates (can't bypass via the public fields).
        let raw = ScheduledJob {
            id: JobId::new("y"),
            job_type: JobType::Deferred,
            earliest: 10,
            latest: 5,
        };
        let mut s = Scheduler::new();
        assert_eq!(
            s.register(raw),
            Err(SchedulerError::InvalidWindow {
                id: "y".to_string(),
                earliest: 10,
                latest: 5
            })
        );
        assert!(s.is_empty());
    }

    #[test]
    fn exact_alarm_is_due_at_its_time_and_feeds_next_wake() {
        let mut s = Scheduler::new();
        s.register(ScheduledJob::alarm(JobId::new("ring"), 100).unwrap())
            .unwrap();
        assert_eq!(s.due(99, PowerState::awake()), Vec::<JobId>::new());
        assert_eq!(s.next_wake(50), Some(100)); // sleep until the alarm
        assert_eq!(s.due(100, PowerState::awake()), vec![JobId::new("ring")]);
        assert_eq!(s.next_wake(100), None); // no further alarms
        s.complete(&JobId::new("ring"));
        assert!(s.is_empty());
    }

    #[test]
    fn deferred_is_withheld_while_dozing_but_runs_in_window() {
        let mut s = Scheduler::new();
        s.register(ScheduledJob::deferred(JobId::new("sync"), 0, 200).unwrap())
            .unwrap();
        let dozing = PowerState {
            dozing: true,
            maintenance_open: false,
            charging: false,
        };
        // Idle, no window → withheld even though its window has started.
        assert_eq!(s.due(50, dozing), Vec::<JobId>::new());
        assert_eq!(s.next_wake(0), None, "deferred gives no guaranteed wake");
        // Charging lets it run even while dozing.
        assert_eq!(
            s.due(
                50,
                PowerState {
                    charging: true,
                    ..dozing
                }
            ),
            vec![JobId::new("sync")]
        );
        // A maintenance window opens → runs (still dozing).
        assert_eq!(
            s.due(
                50,
                PowerState {
                    maintenance_open: true,
                    ..dozing
                }
            ),
            vec![JobId::new("sync")]
        );
    }

    #[test]
    fn deferred_jobs_coalesce_into_one_due_batch() {
        let mut s = Scheduler::new();
        for n in ["a", "b", "c"] {
            s.register(ScheduledJob::deferred(JobId::new(n), 0, 100).unwrap())
                .unwrap();
        }
        let window = PowerState {
            dozing: true,
            maintenance_open: true,
            charging: false,
        };
        // All overlapping deferred jobs fire in one aligned batch (id order).
        assert_eq!(
            s.due(50, window),
            vec![JobId::new("a"), JobId::new("b"), JobId::new("c")]
        );
    }

    #[test]
    fn counts_split_by_kind_and_cancel_removes() {
        let mut s = Scheduler::new();
        s.register(ScheduledJob::alarm(JobId::new("ring"), 5).unwrap())
            .unwrap();
        s.register(ScheduledJob::deferred(JobId::new("d1"), 0, 9).unwrap())
            .unwrap();
        s.register(ScheduledJob::deferred(JobId::new("d2"), 0, 9).unwrap())
            .unwrap();
        assert_eq!(s.counts(), (1, 2));
        assert_eq!(s.len(), 3);
        assert!(s.cancel(&JobId::new("d1")));
        assert_eq!(s.counts(), (1, 1));
    }
}
