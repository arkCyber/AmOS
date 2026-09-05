//! CPU / NPU frequency-governor domain — turning an energy [`SensorMode`] into
//! concrete per-cluster frequency *ceilings*.
//!
//! [`crate::policy::decide`] answers *which* energy mode to run in (Performance /
//! Balanced / PowerSave). This module answers the follow-up the mobile-survival
//! goal needs: given that mode and the chip's frequency topology, **what maximum
//! frequency ceiling should each CPU cluster and the NPU actually run at** so a
//! heavy on-device LLM does not starve the phone / System-UI.
//!
//! The model is deliberately small and pure:
//!
//! * A heterogeneous "big.LITTLE"-style device has [`ClusterKind`]s — `Little`
//!   (efficient cores that carry the UI / telephony / wakeups), `Big` and
//!   `Prime` (where decode / prefill threads hammer).
//! * [`cpu_percent`] / [`npu_percent`] give the *ceiling* as a percentage of each
//!   domain's hardware max for a given [`SensorMode`]. Percentages (not floats)
//!   keep the mapping deterministic and integer-exact.
//! * [`plan`] / [`plan_from_decision`] fold a chip topology (each cluster's id /
//!   kind / max-kHz and an optional NPU max) into a concrete [`FreqPlan`]: one
//!   [`FreqCap`] per cluster plus an optional NPU cap.
//!
//! The key responsiveness guarantee: the `Little` cluster is **never capped below
//! its hardware max in Balanced** and only gently in PowerSave, so the phone /
//! System-UI work that schedules there is not preempted into jank by a background
//! inference hogging `Big`/`Prime`/the NPU. Applying a [`FreqPlan`] to real
//! hardware is a separate seam (the feature-gated `linux` module writes the sysfs
//! ceilings); this module is pure `std` and offline-testable.

use amos_sensor::{SensorManager, SensorMode};

use crate::governor::EnergyGovernor;
use crate::policy::{Decision, Policy};
use crate::types::Telemetry;

/// The kind of a CPU frequency cluster on a heterogeneous device. Used to decide
/// how aggressively each cluster is capped in a given [`SensorMode`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ClusterKind {
    /// Efficient cores — carry the phone / System-UI / telephony wakeups. Low
    /// power, so capping it saves little while risking UI jank; we spare it.
    Little,
    /// Performance cores — where a heavy prompt-eval / decode thread often lands.
    Big,
    /// Top-end single / few-core turbo domain — the most power-hungry to cap.
    Prime,
}

impl ClusterKind {
    /// Every cluster kind, for iterating / validation.
    pub const ALL: [ClusterKind; 3] = [ClusterKind::Little, ClusterKind::Big, ClusterKind::Prime];

    /// Stable key for UI / logs / a future wire bus.
    pub fn key(self) -> &'static str {
        match self {
            ClusterKind::Little => "little",
            ClusterKind::Big => "big",
            ClusterKind::Prime => "prime",
        }
    }

    /// Parse from a key; `None` for unknown strings.
    pub fn from_key(s: &str) -> Option<ClusterKind> {
        match s {
            "little" => Some(ClusterKind::Little),
            "big" => Some(ClusterKind::Big),
            "prime" => Some(ClusterKind::Prime),
            _ => None,
        }
    }
}

/// One frequency domain of the chip as seen by the governor: a CPU cluster with
/// a platform-assigned `id`, its [`ClusterKind`], and its hardware max frequency
/// (kHz). The platform supplies this topology (vendor tables / a HAL); the pure
/// [`plan`] turns it into ceilings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cluster {
    /// Platform identifier of this frequency domain (used by the applier seam).
    pub id: u32,
    /// Whether it is a little / big / prime cluster.
    pub kind: ClusterKind,
    /// Hardware max frequency of the cluster, kHz.
    pub max_khz: u32,
}

impl Cluster {
    /// A cluster with the given domain id / kind / hardware max (kHz).
    pub const fn new(id: u32, kind: ClusterKind, max_khz: u32) -> Self {
        Self { id, kind, max_khz }
    }
}

/// A requested frequency ceiling for one cluster. `None` (`max_khz`) means
/// "leave the hardware governor unconstrained here" — used for Performance and
/// for the protected Little cluster, where imposing a ceiling would not help.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FreqCap {
    /// The cluster the ceiling applies to (matches [`Cluster::id`]).
    pub cluster: u32,
    /// Maximum frequency (kHz) to allow on the cluster. `None` means "no imposed
    /// ceiling" — the applier seam *releases* any previously applied cap by
    /// restoring the cluster's hardware max (see the `linux` module), so returning
    /// to `Performance` after a `PowerSave` genuinely lifts the throttle.
    pub max_khz: Option<u32>,
}

/// The complete set of ceilings a single governor tick should apply: one cap per
/// CPU cluster plus an optional NPU (dedicated accelerator) cap.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct FreqPlan {
    /// Per-cluster CPU frequency ceilings.
    pub cpu_caps: Vec<FreqCap>,
    /// NPU frequency ceiling (kHz), or `None` to leave the accelerator alone.
    pub npu_cap_khz: Option<u32>,
}

impl FreqPlan {
    /// Whether this plan imposes no ceilings anywhere (all clusters + NPU free).
    pub fn is_uncapped(&self) -> bool {
        self.cpu_caps.iter().all(|c| c.max_khz.is_none()) && self.npu_cap_khz.is_none()
    }
}

impl std::fmt::Display for FreqPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let caps = self
            .cpu_caps
            .iter()
            .map(|c| match c.max_khz {
                Some(k) => format!("cluster-{}≤{k}", c.cluster),
                None => format!("cluster-{} free", c.cluster),
            })
            .collect::<Vec<_>>()
            .join("; ");
        let npu = match self.npu_cap_khz {
            Some(k) => format!("{k}"),
            None => "free".to_string(),
        };
        write!(f, "cpu[{caps}] | npu {npu}")
    }
}

/// The CPU-cluster ceiling as a percentage (0–100) of the cluster's hardware max
/// while the device runs in `mode`.
///
/// Rationale, tuned for mobile survival under a heavy on-device LLM:
/// * `Performance` — no ceiling anywhere (`100`): we want full prefill/decode speed.
/// * `Balanced` — `Big`/`Prime` and the NPU capped modestly to cap SoC drain/heat,
///   but the `Little` cluster stays uncapped so UI / phone / telephony are not
///   preempted into jank by a background inference hogging the big cores.
/// * `PowerSave` — `Prime` cut hardest, then `Big`, then (gently) `Little`, with
///   the NPU at half — throttling the inference engines before basic services.
pub const fn cpu_percent(kind: ClusterKind, mode: SensorMode) -> u16 {
    match mode {
        SensorMode::Performance => 100,
        SensorMode::Balanced => match kind {
            ClusterKind::Little => 100,
            ClusterKind::Big => 80,
            ClusterKind::Prime => 80,
        },
        SensorMode::PowerSave => match kind {
            ClusterKind::Little => 80,
            ClusterKind::Big => 50,
            ClusterKind::Prime => 40,
        },
    }
}

/// The NPU (dedicated accelerator) ceiling as a percentage of its hardware max
/// while the device runs in `mode`. The NPU is what an on-device LLM decode
/// mostly drives, so it is the first domain we throttle to protect the battery /
/// thermals and free the CPU for the phone / System-UI.
pub const fn npu_percent(mode: SensorMode) -> u16 {
    match mode {
        SensorMode::Performance => 100,
        SensorMode::Balanced => 85,
        SensorMode::PowerSave => 50,
    }
}

/// The integer ceiling (kHz) for a domain whose hardware max is `max_khz` at
/// `percent` of max. `percent >= 100` (or a `0` max) returns `max_khz` unchanged;
/// otherwise the cap is `floor(max × percent / 100)`, floored to at least `1` kHz
/// and never above the hardware max. Integer math keeps the result exact and
/// deterministic.
///
/// Never panics: a `0` hardware max (a degenerate / misconfigured cluster) short
/// circuits before the `[1, max]` clamp, which is only safe for `max >= 1`.
pub fn cap_khz(max_khz: u32, percent: u16) -> u32 {
    if max_khz == 0 || percent >= 100 {
        return max_khz;
    }
    let cap = (u64::from(max_khz) * u64::from(percent)) / 100;
    // `max_khz >= 1` here, so the `[1, max]` clamp range is always valid.
    cap.clamp(1, u64::from(max_khz)) as u32
}

/// Build the frequency plan for an energy `mode` given the chip topology.
///
/// A cluster whose ceiling is `100%` (Performance, and the Little cluster in
/// Balanced) yields `max_khz: None` — "no imposed ceiling". The `linux` applier
/// interprets that as *release* (restore the cluster to its hardware max), so a
/// plan that lifts a previous PowerSave cap genuinely raises the ceiling again.
/// The NPU is capped only when the plan's mode caps it and a hardware max was
/// supplied.
pub fn plan(mode: SensorMode, clusters: &[Cluster], npu_max_khz: Option<u32>) -> FreqPlan {
    let cpu_caps = clusters
        .iter()
        .map(|c| {
            let percent = cpu_percent(c.kind, mode);
            let max_khz = (percent < 100).then(|| cap_khz(c.max_khz, percent));
            FreqCap {
                cluster: c.id,
                max_khz,
            }
        })
        .collect();
    let npu_cap_khz = npu_max_khz.and_then(|hw| {
        let percent = npu_percent(mode);
        (percent < 100).then(|| cap_khz(hw, percent))
    });
    FreqPlan {
        cpu_caps,
        npu_cap_khz,
    }
}

/// Build the frequency plan from a governor [`Decision`] (uses its
/// `sensor_mode`). This is the seam `EnergyGovernor::observe` feeds: take the
/// `Decision` a tick produced and derive the ceilings to push to the hardware.
pub fn plan_from_decision(
    decision: &Decision,
    clusters: &[Cluster],
    npu_max_khz: Option<u32>,
) -> FreqPlan {
    plan(decision.sensor_mode, clusters, npu_max_khz)
}

/// A stateful, DVFS-facing ticker: run a telemetry snapshot each poll and get the
/// [`FreqPlan`] to apply **only when it changed** from the previous poll.
///
/// Mirrors [`EnergyGovernor`]'s role for the energy *mode*: here we dedup the
/// *frequency* side so a periodic scheduler does not rewrite identical
/// `scaling_max_freq` values on every tick (a real sysfs write is not free and a
/// repeated identical ceiling can perturb the DVFS governor for no benefit). On a
/// device this is what a ticker hands to the `linux` applier seam:
///
/// ```text
///   let mut fg = FrequencyGovernor::new(Policy::default(), clusters, npu_max);
///   if let Some(plan) = fg.observe(&telemetry) {
///       linux_gov.apply(&plan);   // only when the ceilings actually changed
///   }
/// ```
///
/// The first tick always yields `Some(plan)` (there is nothing applied yet); an
/// unchanged mode yields `None`, and a mode change yields the fresh plan.
pub struct FrequencyGovernor {
    energy: EnergyGovernor,
    clusters: Vec<Cluster>,
    npu_max_khz: Option<u32>,
    applied: Option<FreqPlan>,
    changes: u64,
}

impl FrequencyGovernor {
    /// A frequency governor over the given chip topology with the given energy
    /// [`Policy`].
    pub fn new(policy: Policy, clusters: Vec<Cluster>, npu_max_khz: Option<u32>) -> Self {
        Self {
            energy: EnergyGovernor::new(policy),
            clusters,
            npu_max_khz,
            applied: None,
            changes: 0,
        }
    }

    /// The tuned policy (delegates to the wrapped [`EnergyGovernor`]).
    pub fn policy(&self) -> &Policy {
        self.energy.policy()
    }

    /// The last energy decision (delegates to the wrapped [`EnergyGovernor`]).
    pub fn last_decision(&self) -> Option<Decision> {
        self.energy.last_decision()
    }

    /// The current [`SensorMode`], once a tick has run.
    pub fn mode(&self) -> Option<SensorMode> {
        self.energy.mode()
    }

    /// The most recently surfaced plan (the one the caller last applied).
    pub fn applied_plan(&self) -> Option<&FreqPlan> {
        self.applied.as_ref()
    }

    /// How many times [`observe`](Self::observe) surfaced a *changed* plan (i.e.
    /// how many distinct `apply` calls a well-behaved caller made).
    pub fn changes(&self) -> u64 {
        self.changes
    }

    /// Run one tick. Returns the [`FreqPlan`] to apply if it differs from what was
    /// last surfaced; `None` when the mode is unchanged (nothing to write). The
    /// wrapped [`EnergyGovernor`] always advances so energy-mode hysteresis keeps
    /// working even across ticks that need no frequency change.
    pub fn observe(&mut self, t: &Telemetry) -> Option<FreqPlan> {
        let decision = self.energy.observe(t);
        let plan = plan_from_decision(&decision, &self.clusters, self.npu_max_khz);
        if self.applied.as_ref() == Some(&plan) {
            return None;
        }
        self.applied = Some(plan.clone());
        self.changes += 1;
        Some(plan)
    }
}

impl Default for FrequencyGovernor {
    fn default() -> Self {
        Self::new(Policy::default(), Vec::new(), None)
    }
}

/// The composed **energy → sampling + frequency** closed loop a ticker can drive
/// with one call per poll.
///
/// [`FrequencyGovernor`] answers "which frequency ceilings, and did they change?";
/// this wrapper additionally keeps a [`SensorManager`] (the real `amos-sensor`
/// energy-gated sampling surface) in the decided [`SensorMode`] every tick, so the
/// energy decision is applied to *sampling* immediately while the returned
/// [`FreqPlan`] (`Some` only when changed) is what the caller hands to a frequency
/// applier (e.g. the `linux` seam's `LinuxFreqGovernor`).
///
/// ```text
///   let mut gov = ComposedGovernor::new(Policy::default(), clusters, npu_max, sensors);
///   if let Some(plan) = gov.observe(&telemetry) {
///       linux_gov.apply(&plan);   // ceilings changed -> write sysfs
///   }
///   // sampling mode already reflects the decision (apply_to the SensorManager).
/// ```
///
/// Pure `std` on the host (no wall clock); the `SensorManager` is the caller's
/// real or Mock-backed manager.
pub struct ComposedGovernor {
    freq: FrequencyGovernor,
    sensors: SensorManager,
}

impl ComposedGovernor {
    /// Compose a [`FrequencyGovernor`] over the given policy / topology with a
    /// [`SensorManager`] that the decided [`SensorMode`] is pushed into each tick.
    pub fn new(
        policy: Policy,
        clusters: Vec<Cluster>,
        npu_max_khz: Option<u32>,
        sensors: SensorManager,
    ) -> Self {
        Self {
            freq: FrequencyGovernor::new(policy, clusters, npu_max_khz),
            sensors,
        }
    }

    /// The [`SensorManager`] this governor keeps in the decided mode (for reads).
    pub fn sensors(&self) -> &SensorManager {
        &self.sensors
    }

    /// Run one tick: advance the energy decision, **apply it to the
    /// [`SensorManager`]** (push the decided [`SensorMode`]), and return the
    /// frequency plan to apply *only when it changed* (`None` = nothing new to
    /// write). Mode + sensor gating are therefore always in sync from a single
    /// call, regardless of whether the frequency ceilings moved.
    pub fn observe(&mut self, t: &Telemetry) -> Option<FreqPlan> {
        let plan = self.freq.observe(t);
        if let Some(d) = self.freq.last_decision() {
            d.apply_to(&self.sensors);
        }
        plan
    }

    /// The tuned policy (delegates to the wrapped [`FrequencyGovernor`]).
    pub fn policy(&self) -> &Policy {
        self.freq.policy()
    }

    /// The current [`SensorMode`], once a tick has run.
    pub fn mode(&self) -> Option<SensorMode> {
        self.freq.mode()
    }

    /// The last energy [`Decision`].
    pub fn last_decision(&self) -> Option<Decision> {
        self.freq.last_decision()
    }

    /// How many ticks surfaced a changed frequency plan (distinct applies).
    pub fn changes(&self) -> u64 {
        self.freq.changes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clusters() -> Vec<Cluster> {
        vec![
            // little 0: 1.8 GHz · big 1: 2.5 GHz · prime 2: 3.2 GHz
            Cluster::new(0, ClusterKind::Little, 1_800_000),
            Cluster::new(1, ClusterKind::Big, 2_500_000),
            Cluster::new(2, ClusterKind::Prime, 3_200_000),
        ]
    }

    #[test]
    fn cluster_kind_keys_round_trip() {
        for k in ClusterKind::ALL {
            assert_eq!(ClusterKind::from_key(k.key()), Some(k));
        }
        assert_eq!(ClusterKind::from_key("mid"), None);
    }

    #[test]
    fn performance_leaves_everything_uncapped() {
        let p = plan(SensorMode::Performance, &clusters(), Some(1_500_000));
        assert!(p.cpu_caps.iter().all(|c| c.max_khz.is_none()));
        assert_eq!(p.npu_cap_khz, None);
        assert!(p.is_uncapped());
    }

    #[test]
    fn balanced_protects_little_and_caps_big_and_npu() {
        let p = plan(SensorMode::Balanced, &clusters(), Some(1_500_000));
        // Little (UI / phone) is spared: no ceiling.
        let little = p
            .cpu_caps
            .iter()
            .find(|c| c.cluster == 0)
            .expect("little present");
        assert_eq!(
            little.max_khz, None,
            "UI cluster must not be capped in Balanced"
        );
        // Big/prime are capped at 80%.
        let big = p
            .cpu_caps
            .iter()
            .find(|c| c.cluster == 1)
            .expect("big present");
        assert_eq!(big.max_khz, Some(2_000_000)); // 2.5 GHz × 80%
                                                  // NPU capped at 85%.
        assert_eq!(p.npu_cap_khz, Some(1_275_000)); // 1.5 GHz × 85%
        assert!(!p.is_uncapped());
    }

    #[test]
    fn power_save_orders_clusters_deepest_save_first() {
        let p = plan(SensorMode::PowerSave, &clusters(), Some(1_500_000));
        let cap = |id: u32| {
            p.cpu_caps
                .iter()
                .find(|c| c.cluster == id)
                .expect("cluster")
                .max_khz
        };
        // Prime 40% < Big 50% < Little 80% of hw max.
        assert_eq!(cap(2), Some(1_280_000)); // 3.2 GHz × 40%
        assert_eq!(cap(1), Some(1_250_000)); // 2.5 GHz × 50%
        assert_eq!(cap(0), Some(1_440_000)); // 1.8 GHz × 80%
        assert_eq!(p.npu_cap_khz, Some(750_000)); // 1.5 GHz × 50%
                                                  // Display is a stable, human-readable summary of the same plan.
        let s = p.to_string();
        assert!(s.contains("cluster-0≤1440000"), "{s}");
        assert!(s.contains("npu 750000"), "{s}");
    }

    #[test]
    fn plan_from_decision_follows_sensor_mode() {
        use crate::policy::{decide, Policy};
        use crate::types::{BatteryState, Telemetry, Usage};
        // Low battery -> PowerSave decision.
        let battery = BatteryState::on_battery(15.0);
        let t = Telemetry::new(battery, Usage::default(), None);
        let d = decide(&Policy::default(), &t, None);
        let p = plan_from_decision(&d, &clusters(), Some(1_000_000));
        // Matches the PowerSave cluster map.
        assert_eq!(p.npu_cap_khz, Some(500_000));
        assert!(p.cpu_caps.iter().any(|c| c.max_khz.is_some()));
    }

    #[test]
    fn cap_khz_is_exact_floor_within_hw_max() {
        assert_eq!(cap_khz(2_500_000, 80), 2_000_000);
        assert_eq!(cap_khz(1_800_000, 100), 1_800_000);
        // A tiny max never underflows below 1 kHz.
        assert_eq!(cap_khz(1, 40), 1);
        // 100+ never raises above the hardware max.
        assert_eq!(cap_khz(999, 150), 999);
    }

    #[test]
    fn degenerate_zero_max_topology_never_panics() {
        // A misconfigured / reported 0 hardware max must never reach the clamp.
        assert_eq!(cap_khz(0, 40), 0);
        assert_eq!(cap_khz(0, 100), 0);
        assert_eq!(cap_khz(0, 150), 0);

        // ...and planning over a zero-max cluster stays total (no panic).
        let zero = vec![
            Cluster::new(0, ClusterKind::Little, 1_800_000),
            Cluster::new(1, ClusterKind::Big, 0), // degenerate
        ];
        let p = plan(SensorMode::PowerSave, &zero, Some(1_500_000));
        assert_eq!(p.cpu_caps.len(), 2);
        assert_eq!(p.cpu_caps[0].max_khz, Some(1_440_000)); // little 80% of 1.8 GHz
        assert_eq!(p.cpu_caps[1].max_khz, Some(0)); // big has no valid max
        assert_eq!(p.npu_cap_khz, Some(750_000));
    }

    #[test]
    fn frequency_governor_surfaces_a_change_once_then_dedups() {
        use crate::types::{BatteryState, Usage};
        let mut fg = FrequencyGovernor::new(Policy::default(), clusters(), Some(1_500_000));

        // First tick: low battery -> PowerSave plan surfaced (nothing applied yet).
        let low = Telemetry::new(BatteryState::on_battery(15.0), Usage::default(), None);
        let p1 = fg.observe(&low).expect("first tick must surface a plan");
        assert_eq!(fg.changes(), 1);
        assert!(p1.cpu_caps.iter().any(|c| c.max_khz.is_some()));

        // Same mode again -> plan unchanged -> None (no redundant sysfs write).
        assert!(fg.observe(&low).is_none());
        assert_eq!(fg.changes(), 1);

        // Charging -> Performance: an uncapped plan, and genuinely different.
        let charging = Telemetry::new(BatteryState::charging(50.0), Usage::default(), None);
        let p2 = fg
            .observe(&charging)
            .expect("mode change must surface a plan");
        assert_eq!(fg.changes(), 2);
        assert!(p2.is_uncapped());

        // Repeat the same tick -> dedup again.
        assert!(fg.observe(&charging).is_none());
        assert_eq!(fg.changes(), 2);
    }

    #[test]
    fn frequency_governor_exposes_mode_and_decision() {
        use crate::types::{BatteryState, Usage};
        let mut fg = FrequencyGovernor::new(Policy::default(), clusters(), Some(1_500_000));
        assert_eq!(fg.mode(), None);
        fg.observe(&Telemetry::new(
            BatteryState::on_battery(15.0),
            Usage::default(),
            None,
        ));
        assert_eq!(fg.mode(), Some(SensorMode::PowerSave));
        assert_eq!(
            fg.last_decision().map(|d| d.sensor_mode),
            Some(SensorMode::PowerSave)
        );
        assert_eq!(
            fg.policy().critical_level_pct,
            Policy::default().critical_level_pct
        );
    }

    #[test]
    fn composed_governor_applies_mode_to_sensors_and_surfaces_changed_plan() {
        use crate::types::{BatteryState, Usage};
        use amos_sensor::{CameraConfig, CameraId, MockSensorProvider, PixelFormat, Resolution};
        use std::sync::Arc;

        let cfg = CameraConfig {
            id: CameraId::REAR,
            resolution: Resolution::new(640, 480),
            fps: 30, // above the PowerSave camera ceiling (15)
            format: PixelFormat::Rgba8,
        };
        let provider = MockSensorProvider::new(vec![cfg], 200, false);
        let sensors = SensorManager::new(Arc::new(provider), SensorMode::Balanced);
        let mut gov =
            ComposedGovernor::new(Policy::default(), clusters(), Some(1_500_000), sensors);

        // Low battery -> PowerSave: mode is pushed into the real manager and a
        // changed (capped) frequency plan is surfaced.
        let low = Telemetry::new(BatteryState::on_battery(15.0), Usage::default(), None);
        let p1 = gov.observe(&low).expect("first tick surfaces a plan");
        assert_eq!(gov.sensors().mode(), SensorMode::PowerSave);
        assert_eq!(gov.mode(), Some(SensorMode::PowerSave));
        assert!(p1.cpu_caps.iter().any(|c| c.max_khz.is_some()));

        // Same tick -> plan unchanged (None, no sysfs write), mode stays applied.
        assert!(gov.observe(&low).is_none());
        assert_eq!(gov.sensors().mode(), SensorMode::PowerSave);

        // Charging -> Performance: uncapped plan surfaced and manager flips mode.
        let charge = Telemetry::new(BatteryState::charging(50.0), Usage::default(), None);
        let p2 = gov.observe(&charge).expect("mode change surfaces a plan");
        assert!(p2.is_uncapped());
        assert_eq!(gov.sensors().mode(), SensorMode::Performance);
    }

    #[test]
    fn freq_mapping_respects_save_depth_and_hw_bounds_across_all_modes_kinds() {
        // The caps must never exceed the hardware max, must be >= 1 kHz when a
        // valid (non-zero) max is capped, and Performance is the only uncapped mode.
        let cluster_max = |id: u32| -> u32 {
            clusters()
                .into_iter()
                .find(|c| c.id == id)
                .map(|c| c.max_khz)
                .unwrap_or(0)
        };
        for mode in SensorMode::ALL {
            let p = plan(mode, &clusters(), Some(1_500_000));
            if mode == SensorMode::Performance {
                assert!(p.is_uncapped(), "Performance must impose no ceilings");
            } else {
                assert!(!p.is_uncapped(), "{mode:?} must cap something");
            }
            for c in &p.cpu_caps {
                if let Some(k) = c.max_khz {
                    assert!(
                        (1..=cluster_max(c.cluster)).contains(&k),
                        "cap {k} outside (1..={}) for cluster {}",
                        cluster_max(c.cluster),
                        c.cluster
                    );
                }
            }
            if let Some(k) = p.npu_cap_khz {
                assert!((1..=1_500_000).contains(&k), "npu cap {k} out of range");
            }
        }

        // Deeper save never *raises* a ceiling: PowerSave <= Balanced <= Performance.
        for kind in ClusterKind::ALL {
            assert!(
                cpu_percent(kind, SensorMode::PowerSave) <= cpu_percent(kind, SensorMode::Balanced)
            );
            assert!(
                cpu_percent(kind, SensorMode::Balanced)
                    <= cpu_percent(kind, SensorMode::Performance)
            );
        }
        assert!(npu_percent(SensorMode::PowerSave) <= npu_percent(SensorMode::Balanced));
        assert!(npu_percent(SensorMode::Balanced) <= npu_percent(SensorMode::Performance));
    }
}
