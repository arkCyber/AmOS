//! `governor.rs` — the composed resource/energy/lifecycle/scheduler closed loop.
//!
//! Ties the three domain cores together into one offline-testable controller a
//! periodic driver (daemon / System UI) can tick:
//!
//! * [`amos_power::EnergyGovernor`] — folds battery/thermal/live-power/usage into
//!   a `SensorMode` decision.
//! * [`amos_applife::AppLifecycle`] — per-process foreground/background/cached
//!   states; under PowerSave we freeze idle background processes to `Cached`
//!   (tombstone), on recovery + screen-on we thaw them; under explicit memory
//!   pressure we reclaim (kill) the LRU cached/background victims.
//! * [`amos_scheduler::Scheduler`] — a deferred job is only executed when the
//!   power state allows it; an exact alarm always fires at its time.
//!
//! [`ResourceGovernor::observe`] is deterministic (pure function of its inputs)
//! and returns a [`GovernorOutcome`] describing what this tick did. A caller
//! registers apps/jobs up front, then polls with `now` (ticks) + telemetry +
//! pressure/window flags. This is the reference orchestration the per-app host /
//! device binding drives (`docs/app-lifecycle.md` §5, `docs/scheduler.md` §7).

use amos_applife::{AppId, AppLifecycle, AppState};
use amos_power::{Decision, EnergyGovernor, Policy, Telemetry};
use amos_scheduler::{JobId, JobType, PowerState, ScheduledJob, Scheduler};
use amos_sensor::SensorMode;

/// What one [`ResourceGovernor::observe`] tick did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GovernorOutcome {
    /// Chosen mode key: `performance` | `balanced` | `power_save`.
    pub sensor_mode: &'static str,
    /// Reason key for the energy decision.
    pub reason: &'static str,
    /// Governor recommends capping / deferring inference (from the energy decision).
    pub cap_inference: bool,
    /// Governor recommends deferring background work (from the energy decision).
    pub throttle_background: bool,
    /// Exact alarms that fired this tick (user-visible, always run at time).
    pub fired_alarms: Vec<JobId>,
    /// Deferred background jobs executed this tick (power state allowed them).
    pub ran_deferred: Vec<JobId>,
    /// Processes frozen `Background → Cached` (tombstoned) this tick.
    pub frozen: Vec<AppId>,
    /// Processes thawed `Cached → Background` this tick (recovered + screen on).
    pub thawed: Vec<AppId>,
    /// Processes killed under explicit memory pressure this tick.
    pub reclaimed: Vec<AppId>,
    /// Number of apps still in `Background` after this tick.
    pub background_count: usize,
}

/// The composed energy → lifecycle → scheduler closed loop.
pub struct ResourceGovernor {
    energy: EnergyGovernor,
    apps: AppLifecycle,
    jobs: Scheduler,
    /// Number of `observe` ticks driven so far.
    ticks: u64,
    /// The most recent tick's outcome (for status / the wire service).
    last: Option<GovernorOutcome>,
}

impl Default for ResourceGovernor {
    fn default() -> Self {
        Self::new(Policy::default())
    }
}

impl ResourceGovernor {
    /// A governor with the default energy [`Policy`].
    pub fn new(policy: Policy) -> Self {
        Self {
            energy: EnergyGovernor::new(policy),
            apps: AppLifecycle::new(),
            jobs: Scheduler::new(),
            ticks: 0,
            last: None,
        }
    }

    // ---- registration delegates ------------------------------------------

    /// Register (launch) an app process into the lifecycle registry.
    pub fn register_app(&mut self, id: AppId) -> Result<(), amos_applife::LifecycleError> {
        self.apps.launch(id)
    }

    /// Move a registered app to the background.
    pub fn background_app(&mut self, id: AppId) -> Result<(), amos_applife::LifecycleError> {
        self.apps.go_background(id)
    }

    /// Schedule a job (exact alarm or deferred) on the scheduler.
    pub fn schedule(&mut self, job: ScheduledJob) -> Result<(), amos_scheduler::SchedulerError> {
        self.jobs.register(job)
    }

    /// Move an existing, registered app to a target lifecycle [`AppState`]
    /// (foreground/background/frozen-cached/service/stopped). `Visible` is not a
    /// settable state here (it derives from surface visibility), so it is rejected.
    pub fn move_app(
        &mut self,
        id: AppId,
        to: amos_applife::AppState,
    ) -> Result<(), amos_applife::LifecycleError> {
        use amos_applife::AppState as S;
        match to {
            S::Foreground => self.apps.go_foreground(id),
            S::Background => self.apps.go_background(id),
            S::Cached => self.apps.freeze(id),
            S::ForegroundService => self.apps.start_service(id),
            S::Stopped => self.apps.stop(id),
            S::Visible => Err(amos_applife::LifecycleError::InvalidTransition {
                id: id.to_string(),
                from: ".".to_string(),
                to: "visible".to_string(),
            }),
        }
    }

    /// Remove (kill, no saved state) an app from the lifecycle registry.
    pub fn kill_app(&mut self, id: &AppId) -> bool {
        self.apps.kill(id)
    }

    /// Current state of an app, if it is registered.
    pub fn app_state(&self, id: &AppId) -> Option<AppState> {
        self.apps.state(id).ok()
    }

    /// Stable snapshot of every registered app as `(id, state)`.
    pub fn app_entries(&self) -> Vec<(AppId, AppState)> {
        self.apps
            .ids()
            .into_iter()
            .filter_map(|id| self.apps.state(&id).ok().map(|s| (id, s)))
            .collect()
    }

    /// Stable snapshot of every scheduled job as `(id, kind, earliest, latest)`.
    pub fn job_entries(&self) -> Vec<(JobId, JobType, u64, u64)> {
        self.jobs.entries()
    }

    // ---- the closed loop --------------------------------------------------

    /// Run one tick at `now` (monotonic ticks) under `telemetry` + pressure/window
    /// flags. Deterministic and env-free — the unit/integration-test entry point.
    ///
    /// 1. energy decision (`sensor_mode`, `cap_inference`, `throttle_background`);
    /// 2. scheduler: fire due exact alarms; execute deferred jobs only when the
    ///    derived power state allows (doze-proxy = `throttle_background`);
    /// 3. lifecycle: on `PowerSave` freeze idle `Background` apps to `Cached`;
    ///    otherwise (and screen on) thaw `Cached` back to `Background`;
    /// 4. if `memory_pressure`, reclaim (kill) the LRU cached/background victims.
    pub fn observe(
        &mut self,
        now: u64,
        telemetry: Telemetry,
        memory_pressure: bool,
        maintenance_open: bool,
    ) -> GovernorOutcome {
        let d: Decision = self.energy.observe(&telemetry);
        let dozing = d.throttle_background;
        let power = PowerState {
            dozing,
            maintenance_open,
            charging: telemetry.battery.charging,
        };

        // 2. Run due jobs.
        let due = self.jobs.due(now, power);
        let mut fired_alarms = Vec::new();
        let mut ran_deferred = Vec::new();
        for id in due {
            match self.jobs.kind(&id) {
                Some(JobType::AlarmExact) => fired_alarms.push(id.clone()),
                Some(JobType::Deferred) => ran_deferred.push(id.clone()),
                None => {}
            }
            let _ = self.jobs.complete(&id);
        }

        // 3. Freeze / thaw idle processes.
        let mut frozen = Vec::new();
        let mut thawed = Vec::new();
        if d.sensor_mode == SensorMode::PowerSave {
            for id in self.background_app_ids() {
                if self.apps.freeze(id.clone()).is_ok() {
                    frozen.push(id);
                }
            }
        } else if telemetry.usage.screen_on {
            for id in self.cached_app_ids() {
                if self.apps.thaw(id.clone()).is_ok() {
                    thawed.push(id);
                }
            }
        }

        // 4. Reclaim under explicit memory pressure.
        let mut reclaimed = Vec::new();
        if memory_pressure {
            for id in self.apps.reclaim_candidates(3) {
                if self.apps.kill(&id) {
                    reclaimed.push(id);
                }
            }
        }

        let background_count = self
            .apps
            .counts()
            .get(&AppState::Background)
            .copied()
            .unwrap_or(0);

        let outcome = GovernorOutcome {
            sensor_mode: d.sensor_mode.key(),
            reason: d.reason.key(),
            cap_inference: d.cap_inference,
            throttle_background: d.throttle_background,
            fired_alarms,
            ran_deferred,
            frozen,
            thawed,
            reclaimed,
            background_count,
        };
        self.ticks += 1;
        self.last = Some(outcome.clone());
        outcome
    }

    /// Number of `observe` ticks driven so far (`> 0` ⇒ the loop has run).
    pub fn ticks(&self) -> u64 {
        self.ticks
    }

    /// The most recent tick's outcome, if any (drives `GetState`/status).
    pub fn last_decision(&self) -> Option<&GovernorOutcome> {
        self.last.as_ref()
    }

    /// Ids of apps currently in [`AppState::Background`] (stable order).
    fn background_app_ids(&self) -> Vec<AppId> {
        self.apps
            .ids()
            .into_iter()
            .filter(|id| self.apps.state(id).is_ok_and(|s| s == AppState::Background))
            .collect()
    }

    /// Ids of apps currently in [`AppState::Cached`] (stable order).
    fn cached_app_ids(&self) -> Vec<AppId> {
        self.apps
            .ids()
            .into_iter()
            .filter(|id| self.apps.state(id).is_ok_and(|s| s == AppState::Cached))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_power::{BatteryState, Usage};

    fn screen_on() -> Usage {
        Usage {
            screen_on: true,
            foreground_heavy: false,
            inference_active: false,
        }
    }

    fn battery(level: f64) -> Telemetry {
        Telemetry::new(BatteryState::on_battery(level), screen_on(), None)
    }

    fn charging() -> Telemetry {
        Telemetry::new(BatteryState::charging(60.0), screen_on(), None)
    }

    #[test]
    fn power_save_freezes_background_and_defers_work_until_recovery() {
        let mut g = ResourceGovernor::default();
        // One background app.
        g.register_app(AppId::new("notes")).unwrap();
        g.background_app(AppId::new("notes")).unwrap();
        // One exact alarm at t=10; one deferred sync valid [0,50].
        g.schedule(ScheduledJob::alarm(JobId::new("alarm.wake"), 10).unwrap())
            .unwrap();
        g.schedule(ScheduledJob::deferred(JobId::new("bg.sync"), 0, 50).unwrap())
            .unwrap();

        // Low battery + screen on: PowerSave. The exact alarm fires; the deferred
        // sync is withheld (doze-proxy = throttle_background); the idle background
        // app is frozen to Cached (tombstone).
        let o = g.observe(10, battery(15.0), false, false);
        assert_eq!(o.sensor_mode, "power_save");
        assert_eq!(o.fired_alarms, vec![JobId::new("alarm.wake")]);
        assert!(
            o.ran_deferred.is_empty(),
            "deferred withheld while throttled"
        );
        assert_eq!(o.frozen, vec![AppId::new("notes")]);
        assert_eq!(o.background_count, 0);

        // Now charging + a maintenance window is open: the deferred sync runs and
        // the cached app is thawed back to background.
        let o2 = g.observe(20, charging(), false, true);
        assert_eq!(o2.sensor_mode, "performance");
        assert_eq!(o2.ran_deferred, vec![JobId::new("bg.sync")]);
        assert_eq!(o2.thawed, vec![AppId::new("notes")]);
    }

    #[test]
    fn memory_pressure_reclaims_lru_background_victims() {
        let mut g = ResourceGovernor::default();
        g.register_app(AppId::new("old")).unwrap();
        g.background_app(AppId::new("old")).unwrap();
        g.register_app(AppId::new("recent")).unwrap();
        g.background_app(AppId::new("recent")).unwrap();

        // Healthy/charging (no freeze branch) + explicit memory pressure → the LRU
        // background apps are reclaimed (oldest first).
        let o = g.observe(0, charging(), true, false);
        assert_eq!(o.reclaimed, vec![AppId::new("old"), AppId::new("recent")]);
        assert_eq!(o.background_count, 0);
        assert!(o.frozen.is_empty() && o.thawed.is_empty());
    }
}
