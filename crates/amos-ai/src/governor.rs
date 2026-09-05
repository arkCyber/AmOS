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

use std::path::{Path, PathBuf};

use amos_applife::{AppId, AppLifecycle, AppState};
use amos_power::{
    linux::FreqApplyReport, plan, Cluster, ClusterKind, Decision, EnergyGovernor, FreqPlan,
    LinuxFreqGovernor, OverlapPolicy, Policy, Telemetry,
};
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
    /// Deferred jobs whose window fully passed this tick without running (expired).
    pub dropped: Vec<JobId>,
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
    /// The most recent tick's energy [`SensorMode`] (drives the CPU/NPU frequency
    /// plan exposed by [`ResourceGovernor::freq_plan`]).
    last_mode: Option<SensorMode>,
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
            last_mode: None,
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

    /// Cancel a scheduled job so it never runs. `false` when no such job existed.
    pub fn cancel_job(&mut self, id: &JobId) -> bool {
        self.jobs.cancel(id)
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

        // 2b. Drop deferred jobs whose [earliest, latest] window fully passed this
        // tick while conditions never let them run — they are no longer valid, and
        // keeping them registered would silently skew outstanding-job counts.
        let dropped = self.jobs.expire(now);

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
            dropped,
        };
        self.ticks += 1;
        self.last = Some(outcome.clone());
        self.last_mode = Some(d.sensor_mode);
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

    /// The per-cluster + NPU frequency ceilings implied by the **last** energy
    /// decision's [`SensorMode`] for a given chip topology (`None` before the
    /// first tick). A stateless mapping (`amos_power::plan`): a caller that wants
    /// to apply only *changed* plans should own an `amos_power::FrequencyGovernor`
    /// and hand it to a `LinuxFreqGovernor` — this method is the composition point
    /// that bridges the composed controller to the DVFS seam.
    pub fn freq_plan(&self, clusters: &[Cluster], npu_max_khz: Option<u32>) -> Option<FreqPlan> {
        self.last_mode.map(|m| plan(m, clusters, npu_max_khz))
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

/// A resident DVFS applier for the daemon governor beat: discovers the CPUFreq
/// topology from a Linux sysfs root once, then applies the frequency plan implied
/// by the last [`ResourceGovernor`] energy decision — **only when it changed** —
/// by writing `scaling_max_freq` (and the NPU node) via `amos_power`'s
/// [`LinuxFreqGovernor`].
///
/// Kinds (little/big) are labelled by a documented heuristic: a domain at ≥90% of
/// the fastest domain's max is `Big`, the rest `Little` (efficient). Device
/// bring-up should override with the real topology when it differs. Honest: any
/// write failure is surfaced in the returned [`FreqApplyReport`]; nothing is
/// claimed applied unless the seam reports it.
pub struct DvfsDriver {
    applier: LinuxFreqGovernor,
    clusters: Vec<Cluster>,
    npu_max_khz: Option<u32>,
    last: Option<FreqPlan>,
    /// Total `scaling_max_freq` writes the seam reported as applied.
    applied_total: u64,
    /// Total write attempts the seam reported as failed.
    failed_total: u64,
}

impl DvfsDriver {
    /// Build a driver by discovering the CPUFreq domains under `root` (e.g.
    /// `/sys/devices/system/cpu`). `None` when nothing is discoverable there.
    pub fn from_cpufreq_root(
        root: &Path,
        cpu_max: u32,
        npu_max_khz: Option<u32>,
        npu_paths: Vec<PathBuf>,
    ) -> Option<Self> {
        // Discover the CPUFreq domains. `Dedupe` treats the earliest (low-rep)
        // claim as authoritative: a policy whose cpus overlap an earlier domain is
        // dropped (a stray duplicate must not double-apply caps to the same
        // silicon). Any overlap that was seen is surfaced so a malformed sysfs tree
        // is never silent.
        let disc = LinuxFreqGovernor::discover_with_policy(root, cpu_max, OverlapPolicy::Dedupe);
        for o in &disc.overlaps {
            tracing::warn!(
                "cpufreq overlap: domain rep {} overlaps domain rep {} on cpu {} (later owner dropped)",
                o.rep_cpu,
                o.prior_rep_cpu,
                o.cpu
            );
        }
        let domains = disc.domains;
        if domains.is_empty() {
            return None;
        }
        let fastest = domains.iter().map(|d| d.max_khz).max()?;
        let mut clusters = Vec::with_capacity(domains.len());
        let mut reps = Vec::with_capacity(domains.len());
        for d in domains {
            // Heuristic: >= 90% of the fastest domain => Big; else Little.
            let kind = if u64::from(d.max_khz) * 10 >= u64::from(fastest) * 9 {
                ClusterKind::Big
            } else {
                ClusterKind::Little
            };
            clusters.push(d.cluster(kind));
            reps.push((d.rep_cpu, d.rep_cpu));
        }
        let applier =
            LinuxFreqGovernor::new(root.to_path_buf(), reps, npu_paths).with_npu_max(npu_max_khz);
        Some(Self {
            applier,
            clusters,
            npu_max_khz,
            last: None,
            applied_total: 0,
            failed_total: 0,
        })
    }

    /// Total writes the seam reported as applied since construction.
    pub fn applied_total(&self) -> u64 {
        self.applied_total
    }

    /// Total write attempts the seam reported as failed since construction.
    pub fn failed_total(&self) -> u64 {
        self.failed_total
    }

    /// The discovered topology (fed back into `ResourceGovernor::freq_plan`).
    pub fn clusters(&self) -> &[Cluster] {
        &self.clusters
    }

    /// The NPU hardware max this driver can restore to (for `freq_plan`).
    pub fn npu_max_khz(&self) -> Option<u32> {
        self.npu_max_khz
    }

    /// Override the cluster kinds for the *discovered* domains — lets device
    /// bring-up replace the heuristic ([`DvfsDriver::from_cpufreq_root`]) with the
    /// real topology (e.g. which domain is actually the efficient `Little`
    /// cluster). Entries whose `rep_cpu` is not discovered are ignored.
    pub fn relabel_kinds(&mut self, kinds: &[(u32, ClusterKind)]) {
        for &(rep, kind) in kinds {
            if let Some(c) = self.clusters.iter_mut().find(|c| c.id == rep) {
                c.kind = kind;
            }
        }
    }

    /// Apply `plan` if it differs from the last applied one. `None` when it is
    /// unchanged (no sysfs write needed); otherwise the real [`FreqApplyReport`]
    /// so the caller can log exactly what the device accepted / refused.
    pub fn apply_if_changed(&mut self, plan: &FreqPlan) -> Option<FreqApplyReport> {
        if self.last.as_ref() == Some(plan) {
            return None;
        }
        let report = self.applier.apply(plan);
        self.applied_total += u64::from(report.applied);
        self.failed_total += report.failures.len() as u64;
        self.last = Some(plan.clone());
        Some(report)
    }
}

/// Parse an env-format cluster-kind override: comma-separated `"cpu:kind"` pairs,
/// e.g. `"0:Little,4:Big,8:Prime"` (kind case-insensitive). Malformed / unknown
/// kinds are skipped so a bad value never takes down the daemon.
pub fn parse_kinds_env(s: &str) -> Vec<(u32, ClusterKind)> {
    s.split(',')
        .filter_map(|tok| {
            let (cpu, kind) = tok.split_once(':')?;
            let cpu = cpu.trim().parse().ok()?;
            let kind = match kind.trim().to_ascii_lowercase().as_str() {
                "little" => ClusterKind::Little,
                "big" => ClusterKind::Big,
                "prime" => ClusterKind::Prime,
                _ => return None,
            };
            Some((cpu, kind))
        })
        .collect()
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

    #[test]
    fn power_save_plus_pressure_never_touch_protected_apps() {
        use amos_applife::AppState as S;
        let mut g = ResourceGovernor::default();
        // A foreground app (user-facing) and a foreground-service app (e.g. music
        // playback) must be invisible to the energy + memory reclaim actions.
        g.register_app(AppId::new("phone")).unwrap(); // stays Foreground
        g.register_app(AppId::new("music")).unwrap();
        g.move_app(AppId::new("music"), S::ForegroundService)
            .unwrap();
        // One idle background app is the only valid victim.
        g.register_app(AppId::new("sync")).unwrap();
        g.background_app(AppId::new("sync")).unwrap();

        // PowerSave + memory pressure at once: the background victim may be frozen
        // then reclaimed, but the protected tiers are never touched.
        let o = g.observe(0, battery(15.0), true, false);
        assert_eq!(o.sensor_mode, "power_save");
        assert_eq!(o.frozen, vec![AppId::new("sync")]);
        assert_eq!(o.reclaimed, vec![AppId::new("sync")]);
        assert!(o.reclaimed.contains(&AppId::new("sync")));

        assert!(
            !o.frozen
                .iter()
                .any(|id| id.as_str() == "phone" || id.as_str() == "music"),
            "protected tiers must never be frozen: {o:?}"
        );
        assert!(
            !o.reclaimed
                .iter()
                .any(|id| id.as_str() == "phone" || id.as_str() == "music"),
            "protected tiers must never be reclaimed: {o:?}"
        );
        assert_eq!(g.app_state(&AppId::new("phone")), Some(S::Foreground));
        assert_eq!(
            g.app_state(&AppId::new("music")),
            Some(S::ForegroundService)
        );
    }

    #[test]
    fn expired_deferred_is_dropped_and_surfaced_in_outcome() {
        let mut g = ResourceGovernor::default();
        // A deferred job whose window passes while PowerSave throttles it, plus a
        // still-valid deferred and a future exact alarm.
        g.schedule(ScheduledJob::deferred(JobId::new("expired"), 0, 3).unwrap())
            .unwrap();
        g.schedule(ScheduledJob::deferred(JobId::new("valid"), 0, 200).unwrap())
            .unwrap();
        g.schedule(ScheduledJob::alarm(JobId::new("ring"), 100).unwrap())
            .unwrap();

        // PowerSave + now=50: the exact alarm is not yet due, the valid deferred is
        // withheld (throttle), and the fully-passed deferred window (3) is dropped.
        let o = g.observe(50, battery(15.0), false, false);
        assert_eq!(o.sensor_mode, "power_save");
        assert!(o.fired_alarms.is_empty());
        assert!(
            o.ran_deferred.is_empty(),
            "deferred withheld while throttled"
        );
        assert_eq!(o.dropped, vec![JobId::new("expired")]);
        assert_eq!(
            g.job_entries().len(),
            2,
            "valid deferred + exact alarm remain"
        );
    }

    #[test]
    fn cancel_job_removes_a_scheduled_job() {
        let mut g = ResourceGovernor::default();
        g.schedule(ScheduledJob::alarm(JobId::new("alarm.wake"), 10).unwrap())
            .unwrap();
        g.schedule(ScheduledJob::deferred(JobId::new("bg.sync"), 0, 50).unwrap())
            .unwrap();
        assert_eq!(g.job_entries().len(), 2);

        assert!(g.cancel_job(&JobId::new("bg.sync")), "existing job cancels");
        assert_eq!(g.job_entries().len(), 1, "only the alarm remains");
        assert_eq!(g.job_entries()[0].0, JobId::new("alarm.wake"));

        assert!(!g.cancel_job(&JobId::new("nope")), "unknown job → false");
    }

    #[test]
    fn freq_plan_follows_the_last_energy_decision() {
        use amos_power::{Cluster, ClusterKind};
        let mut g = ResourceGovernor::default();
        // No tick yet → no plan.
        assert_eq!(g.freq_plan(&[], None), None);

        // Low battery + screen on → PowerSave.
        let clusters = vec![
            Cluster::new(0, ClusterKind::Little, 1_800_000),
            Cluster::new(1, ClusterKind::Big, 2_500_000),
        ];
        g.observe(0, battery(15.0), false, false);
        let p = g
            .freq_plan(&clusters, Some(1_000_000))
            .expect("a tick ran, so a plan is available");
        // PowerSave map: little 80%, big 50%, NPU 50%.
        assert_eq!(p.cpu_caps[0].max_khz, Some(1_440_000));
        assert_eq!(p.cpu_caps[1].max_khz, Some(1_250_000));
        assert_eq!(p.npu_cap_khz, Some(500_000));

        // Charging → Performance: the plan is uncapped.
        g.observe(0, charging(), false, false);
        let p2 = g.freq_plan(&clusters, Some(1_000_000)).expect("plan");
        assert!(p2.is_uncapped());
    }

    // --- DvfsDriver host test ---------------------------------------------
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static DVFS_TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let seq = DVFS_TEST_SEQ.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "amos-ai-dvfs-test-{}-{}-{seq}",
                std::process::id(),
                nanos
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn prep_cpu(root: &Path, cpu: u32, max_khz: u32) {
        let dir = root.join(format!("cpu{cpu}/cpufreq"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("cpuinfo_max_freq"), format!("{max_khz}\n")).unwrap();
        fs::write(dir.join("scaling_max_freq"), "999999\n").unwrap();
    }
    fn read_scaling(root: &Path, cpu: u32) -> u32 {
        let s =
            fs::read_to_string(root.join(format!("cpu{cpu}/cpufreq/scaling_max_freq"))).unwrap();
        s.trim().parse().unwrap()
    }

    #[test]
    fn dvfs_driver_discovers_applies_on_change_and_restores() {
        use amos_sensor::SensorMode;
        let root = TempDir::new();
        // little cpu0 (1.8 GHz) + big cpu4 (2.5 GHz).
        prep_cpu(root.path(), 0, 1_800_000);
        prep_cpu(root.path(), 4, 2_500_000);

        let mut d = DvfsDriver::from_cpufreq_root(root.path(), 8, None, Vec::new())
            .expect("topology discovered");
        assert_eq!(d.clusters().len(), 2);
        // PowerSave plan over the discovered topology.
        let ps = plan(SensorMode::PowerSave, d.clusters(), None);
        let rep = d.apply_if_changed(&ps).expect("new plan applied");
        assert!(rep.is_clean(), "failures: {:?}", rep.failures);
        assert_eq!(read_scaling(root.path(), 0), 1_440_000); // little 80%
        assert_eq!(read_scaling(root.path(), 4), 1_250_000); // big 50%
        assert_eq!(d.applied_total(), 2);
        assert_eq!(d.failed_total(), 0);

        // Same plan again -> no rewrite (and no counter change).
        assert!(d.apply_if_changed(&ps).is_none());
        assert_eq!(d.applied_total(), 2);

        // Balanced restores little (release) and caps big at 80%.
        let bal = plan(SensorMode::Balanced, d.clusters(), None);
        let rep2 = d.apply_if_changed(&bal).expect("new plan applied");
        assert!(rep2.is_clean(), "failures: {:?}", rep2.failures);
        assert_eq!(read_scaling(root.path(), 0), 1_800_000);
        assert_eq!(read_scaling(root.path(), 4), 2_000_000);
        assert_eq!(d.applied_total(), 4);
        assert_eq!(d.failed_total(), 0);
    }

    #[test]
    fn dvfs_kind_override_replaces_heuristic_labels() {
        use amos_sensor::SensorMode;
        let root = TempDir::new();
        prep_cpu(root.path(), 0, 1_800_000); // little-looking (heuristic: Little)
        prep_cpu(root.path(), 4, 2_500_000); // big-looking (heuristic: Big)

        let mut d = DvfsDriver::from_cpufreq_root(root.path(), 8, None, Vec::new()).unwrap();
        // Confirm the heuristic labelled them Little / Big.
        assert_eq!(d.clusters()[0].kind, ClusterKind::Little);
        assert_eq!(d.clusters()[1].kind, ClusterKind::Big);

        // Bring-up override flips them (real topology may differ from the
        // max-based heuristic).
        d.relabel_kinds(&[(0, ClusterKind::Big), (4, ClusterKind::Little)]);
        assert_eq!(d.clusters()[0].kind, ClusterKind::Big);
        assert_eq!(d.clusters()[1].kind, ClusterKind::Little);

        // The relabel actually changes the resulting plan (Big caps harder in
        // PowerSave than Little).
        let ps = plan(SensorMode::PowerSave, d.clusters(), None);
        assert_eq!(ps.cpu_caps[0].max_khz, Some(900_000)); // cpu0 now Big: 50% × 1.8 GHz
        assert_eq!(ps.cpu_caps[1].max_khz, Some(2_000_000)); // cpu4 now Little: 80% × 2.5 GHz
    }

    #[test]
    fn parse_kinds_env_accepts_pairs_and_skips_garbage() {
        let k = parse_kinds_env("0:Little, 4:Big ,8:Prime,not:num,9:Turbo,,2:x");
        assert_eq!(
            k,
            vec![
                (0, ClusterKind::Little),
                (4, ClusterKind::Big),
                (8, ClusterKind::Prime)
            ]
        );
        assert!(parse_kinds_env("").is_empty());
    }

    #[test]
    fn dvfs_discovery_dedupes_overlapping_policies_and_warns() {
        // A minimal Subscriber that just counts WARN events, so we can assert the
        // overlap warning actually fires without pulling in a logging backend.
        struct WarnProbe {
            warns: std::sync::Arc<std::sync::atomic::AtomicU64>,
        }
        impl tracing::Subscriber for WarnProbe {
            fn enabled(&self, _m: &tracing::Metadata<'_>) -> bool {
                true
            }
            fn new_span(&self, _s: &tracing::span::Attributes<'_>) -> tracing::span::Id {
                tracing::span::Id::from_u64(1)
            }
            fn record(&self, _id: &tracing::span::Id, _r: &tracing::span::Record<'_>) {}
            fn record_follows_from(&self, _a: &tracing::span::Id, _b: &tracing::span::Id) {}
            fn event(&self, ev: &tracing::Event<'_>) {
                if ev.metadata().level() == &tracing::Level::WARN {
                    self.warns.fetch_add(1, Ordering::Relaxed);
                }
            }
            fn enter(&self, _id: &tracing::span::Id) {}
            fn exit(&self, _id: &tracing::span::Id) {}
        }

        let root = TempDir::new();
        // Overlapping sysfs: cpu0's little policy claims "0 1 2" (1.8 GHz) while a
        // stray big policy on cpu2 claims "2 3" (2.5 GHz) — cpu2 overlaps cpu0's
        // domain *and* owns its own policy.
        for (cpu, related, max) in [(0u32, "0 1 2", 1_800_000u32), (2u32, "2 3", 2_500_000u32)] {
            let dir = root.path().join(format!("cpu{cpu}/cpufreq"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("cpuinfo_max_freq"), format!("{max}\n")).unwrap();
            fs::write(dir.join("related_cpus"), related).unwrap();
            fs::write(dir.join("scaling_max_freq"), "999999\n").unwrap();
        }

        let warns = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let guard = tracing::subscriber::set_default(WarnProbe {
            warns: warns.clone(),
        });

        // from_cpufreq_root runs with OverlapPolicy::Dedupe: the stray cpu2 owner is
        // dropped, leaving only cpu0's domain (still discoverable, so the driver is
        // Some) — while a WARN is emitted for the overlap.
        let d = DvfsDriver::from_cpufreq_root(root.path(), 4, None, Vec::new())
            .expect("topology discovered after dedupe");
        assert_eq!(d.clusters().len(), 1, "stray overlapping owner dropped");
        assert_eq!(d.clusters()[0].id, 0);
        assert_eq!(d.clusters()[0].max_khz, 1_800_000);

        drop(guard);
        assert_eq!(
            warns.load(Ordering::Relaxed),
            1,
            "exactly one overlap WARN should have fired"
        );
    }
}
