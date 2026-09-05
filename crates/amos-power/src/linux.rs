//! Real Linux cpufreq sysfs applier — feature-gated `linux`.
//!
//! Realizes a [`FreqPlan`] on a Linux / Android device by writing each domain's
//! frequency *ceiling* to the kernel cpufreq interface:
//!
//! * CPU cluster `id` → `/sys/devices/system/cpu/cpu{rep}/cpufreq/scaling_max_freq`
//!   (the representative cpu that owns the cluster's shared cpufreq policy).
//!   A `FreqCap` with `max_khz: Some(..)` writes that ceiling; one with `None`
//!   (uncapped — Performance, or the protected Little cluster) **releases** any
//!   previously applied cap by restoring the cluster's hardware max read from
//!   `cpuinfo_max_freq`. So capping under PowerSave and later restoring under
//!   Performance both actually reach the device instead of only throttling one-way.
//! * NPU / accelerator ceilings are written to caller-supplied sysfs paths
//!   (`npu_max_paths`), since the exact devfreq node is SoC-vendor specific.
//!   Releasing an NPU cap (uncapped plan) restores the known NPU hardware max when
//!   one is supplied via [`LinuxFreqGovernor::with_npu_max`]; without it there is
//!   no generic restore node, so an uncapped NPU is left to the caller that owns
//!   the accelerator.
//!
//! Honest seam, mirroring the repo's `android.rs` seams: it never *claims* a cap
//! was applied. Every write is attempted and any failure (file missing,
//! read-only, no such cpu, unprivileged) is reported in a [`FreqApplyReport`];
//! it never panics on programmer error (P0-1 gate). Tests run against a
//! **tempdir** root so the logic is exercised on the host without touching a real
//! `/sys`. On a device the daemon that owns this must have write access to the
//! cpufreq nodes (root / a privileged service) — actual hardware validation is
//! device bring-up work, `cargo check -p amos-power --features linux` only keeps
//! it compiling.

use std::fs;
use std::path::{Path, PathBuf};

use crate::freq::{Cluster, ClusterKind, FreqCap, FreqPlan};

/// Default sysfs root for per-cpu cpufreq scaling controls.
pub fn default_cpufreq_root() -> PathBuf {
    PathBuf::from("/sys/devices/system/cpu")
}

/// Which cpu owns the shared cpufreq policy of a frequency domain.
pub type ClusterReps = Vec<(u32, u32)>;

/// One cpufreq frequency domain discovered on a Linux sysfs tree: the
/// representative cpu that owns the shared policy, every cpu in that policy
/// (from `related_cpus`), and the domain's hardware max (kHz).
///
/// [`ClusterKind`] (little/big/prime) is *not* discoverable from generic sysfs —
/// a caller labels each domain by platform via [`DiscoveredDomain::cluster`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredDomain {
    /// Representative cpu that owns the shared cpufreq policy (lowest cpu of the
    /// policy group).
    pub rep_cpu: u32,
    /// Every cpu sharing this policy (from `related_cpus`, else just `rep_cpu`).
    pub cpus: Vec<u32>,
    /// Hardware max frequency of the domain, kHz (`cpuinfo_max_freq`).
    pub max_khz: u32,
}

impl DiscoveredDomain {
    /// Turn this discovered domain into a [`Cluster`] spec for the given
    /// [`ClusterKind`] (used by [`crate::freq::plan`]). The platform supplies the
    /// kind; the rest comes from the sysfs discovery.
    pub fn cluster(&self, kind: ClusterKind) -> Cluster {
        Cluster::new(self.rep_cpu, kind, self.max_khz)
    }
}

/// Parse a space-separated list of cpus (e.g. a `related_cpus` file) into a
/// vector. Unparseable entries are skipped.
fn parse_cpu_list(text: &str) -> Vec<u32> {
    text.split_whitespace()
        .filter_map(|t| t.parse().ok())
        .collect()
}

/// Outcome of one [`LinuxFreqGovernor::apply`]: how many caps were written and a
/// human-readable list of anything that failed (each with *which* target failed,
/// so a caller can log exactly what the device refused — no fabricated success).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FreqApplyReport {
    /// Number of `scaling_max_freq` writes that succeeded.
    pub applied: u32,
    /// `(description, reason)` for each failed write (e.g. a cluster that has no
    /// representative cpu configured, a missing node, a read-only /sys).
    pub failures: Vec<(String, String)>,
}

impl FreqApplyReport {
    /// True when every requested write landed.
    pub fn is_clean(&self) -> bool {
        self.failures.is_empty()
    }
}

impl std::fmt::Display for FreqApplyReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.failures.is_empty() {
            return write!(f, "applied {} (clean)", self.applied);
        }
        let details = self
            .failures
            .iter()
            .map(|(what, why)| format!("{what}: {why}"))
            .collect::<Vec<_>>()
            .join("; ");
        write!(
            f,
            "applied {}; {} failure(s): {details}",
            self.applied,
            self.failures.len()
        )
    }
}

/// Applies [`FreqPlan`]s to a Linux cpufreq sysfs tree.
///
/// Construct with an explicit `cpufreq_root` + topology (for tests and for
/// platforms where the sysfs is mounted elsewhere); `default()` uses
/// [`default_cpufreq_root`] and an empty topology (the caller populates it at
/// device bring-up with the real cluster→representative-cpu mapping).
#[derive(Clone, Debug)]
pub struct LinuxFreqGovernor {
    cpufreq_root: PathBuf,
    cluster_reps: ClusterReps,
    npu_max_paths: Vec<PathBuf>,
    /// Known NPU hardware max (kHz), used to *restore* the NPU when an uncapped
    /// plan releases it (mirrors the CPU `cpuinfo_max_freq` restore).
    npu_max_khz: Option<u32>,
}

impl LinuxFreqGovernor {
    /// A governor over the given cpufreq root, cluster topology and optional NPU
    /// sysfs max-freq nodes.
    pub fn new(
        cpufreq_root: PathBuf,
        cluster_reps: ClusterReps,
        npu_max_paths: Vec<PathBuf>,
    ) -> Self {
        Self {
            cpufreq_root,
            cluster_reps,
            npu_max_paths,
            npu_max_khz: None,
        }
    }

    /// Builder: set the NPU hardware max (kHz) so an *uncapped* NPU in a later plan
    /// can be released (restored to this max) instead of staying throttled forever.
    /// Chainable and non-mutating: `LinuxFreqGovernor::new(...).with_npu_max(Some(hw))`.
    pub fn with_npu_max(mut self, npu_max_khz: Option<u32>) -> Self {
        self.npu_max_khz = npu_max_khz;
        self
    }

    /// The root being written to (exposed for diagnostics / tests).
    pub fn cpufreq_root(&self) -> &Path {
        &self.cpufreq_root
    }

    fn scaling_max_path(&self, cpu: u32) -> PathBuf {
        self.cpufreq_root
            .join(format!("cpu{cpu}/cpufreq/scaling_max_freq"))
    }

    fn cpuinfo_max_path(&self, cpu: u32) -> PathBuf {
        self.cpufreq_root
            .join(format!("cpu{cpu}/cpufreq/cpuinfo_max_freq"))
    }

    fn read_khz(path: &Path) -> Option<u32> {
        fs::read_to_string(path).ok()?.trim().parse().ok()
    }

    /// Discover the cpufreq frequency domains present under `root` by scanning
    /// `cpu0..cpu_max` for policy dirs with a readable `cpuinfo_max_freq`,
    /// grouping the cpus that share a policy via `related_cpus`.
    ///
    /// Emits **one** domain per policy, keyed by the lowest cpu of the group (so a
    /// kernel that mirrors a policy dir across every member cpu does not double
    /// count). A cpu with no `cpufreq` dir is skipped. `ClusterKind` is not
    /// discoverable from generic sysfs — callers label each domain by platform via
    /// [`DiscoveredDomain::cluster`], then feed the result to
    /// [`crate::freq::plan`] and the reps to `new`.
    pub fn discover(root: &Path, cpu_max: u32) -> Vec<DiscoveredDomain> {
        let mut domains = Vec::new();
        for cpu in 0..cpu_max {
            let dir = root.join(format!("cpu{cpu}/cpufreq"));
            let Some(max_khz) = Self::read_khz(&dir.join("cpuinfo_max_freq")) else {
                continue; // not a policy owner here (no dir / unreadable)
            };
            let related = fs::read_to_string(dir.join("related_cpus"))
                .map(|t| parse_cpu_list(&t))
                .unwrap_or_default();
            let mut cpus = if related.is_empty() {
                vec![cpu]
            } else {
                related
            };
            let Some(min) = cpus.iter().min().copied() else {
                continue;
            };
            if min != cpu {
                continue; // per-member mirror of a policy we already own from `min`
            }
            cpus.sort_unstable();
            domains.push(DiscoveredDomain {
                rep_cpu: cpu,
                cpus,
                max_khz,
            });
        }
        domains
    }

    /// Representative cpu of a cluster, if the topology lists one.
    fn rep_cpu(&self, cluster: u32) -> Option<u32> {
        self.cluster_reps
            .iter()
            .find(|(id, _)| *id == cluster)
            .map(|(_, cpu)| *cpu)
    }

    fn write_khz(&self, path: &Path, khz: u32, what: String, report: &mut FreqApplyReport) {
        match fs::write(path, format!("{khz}\n")) {
            Ok(()) => report.applied += 1,
            Err(e) => report.failures.push((what, format!("{path:?}: {e}"))),
        }
    }

    /// Apply one plan: write each cluster's ceiling to its representative cpu's
    /// `scaling_max_freq` and each NPU ceiling to the configured devfreq nodes.
    /// A `None` (uncapped) CPU cluster *releases* a prior cap by restoring the
    /// hardware max; an uncapped NPU does the same when a known NPU max is set.
    /// Failures never panic — they are collected in the returned [`FreqApplyReport`].
    pub fn apply(&self, plan: &FreqPlan) -> FreqApplyReport {
        let mut report = FreqApplyReport::default();
        for cap in &plan.cpu_caps {
            self.apply_cpu_cap(*cap, &mut report);
        }
        match plan.npu_cap_khz {
            Some(khz) => self.apply_npu_cap(khz, &mut report),
            None => self.apply_npu_release(&mut report),
        }
        report
    }

    fn apply_npu_cap(&self, khz: u32, report: &mut FreqApplyReport) {
        if self.npu_max_paths.is_empty() {
            report.failures.push((
                "npu".to_string(),
                "no npu_max_paths configured; NPU ceiling not applied".to_string(),
            ));
            return;
        }
        for p in &self.npu_max_paths {
            self.write_khz(p, khz, "npu".to_string(), report);
        }
    }

    fn apply_npu_release(&self, report: &mut FreqApplyReport) {
        // Restore a previously applied NPU cap to the known hardware max (mirrors
        // the CPU `cpuinfo_max_freq` restore). With no known NPU max there is no
        // generic restore node — an uncapped NPU is left to the caller (documented).
        let Some(hw) = self.npu_max_khz else {
            return;
        };
        if self.npu_max_paths.is_empty() {
            // We *intend* to release the NPU but have nowhere to write it — an
            // honest misconfiguration signal, never a silent skip.
            report.failures.push((
                "npu".to_string(),
                "cannot release NPU: npu_max_khz set but no npu_max_paths configured".to_string(),
            ));
            return;
        }
        for p in &self.npu_max_paths {
            self.write_khz(p, hw, "npu".to_string(), report);
        }
    }

    fn apply_cpu_cap(&self, cap: FreqCap, report: &mut FreqApplyReport) {
        let what = format!("cluster-{}", cap.cluster);
        let Some(cpu) = self.rep_cpu(cap.cluster) else {
            // A capped cluster with no representative cpu cannot be written to —
            // that is a real failure. An *uncapped* cluster we were never managing
            // has nothing to release, so it is quietly skipped.
            if cap.max_khz.is_some() {
                report.failures.push((
                    what,
                    "no representative cpu configured for this cluster".to_string(),
                ));
            }
            return;
        };
        let scaling = self.scaling_max_path(cpu);
        match cap.max_khz {
            // Impose a ceiling.
            Some(khz) => self.write_khz(&scaling, khz, what, report),
            // Release: restore the hardware max so any cap we applied earlier is
            // actually lifted (otherwise a PowerSave would throttle forever).
            None => match Self::read_khz(&self.cpuinfo_max_path(cpu)) {
                Some(max) => self.write_khz(&scaling, max, what, report),
                None => report.failures.push((
                    what,
                    format!(
                        "cannot release cluster: {} is unreadable",
                        self.cpuinfo_max_path(cpu).display()
                    ),
                )),
            },
        }
    }
}

impl Default for LinuxFreqGovernor {
    fn default() -> Self {
        Self {
            cpufreq_root: default_cpufreq_root(),
            cluster_reps: Vec::new(),
            npu_max_paths: Vec::new(),
            npu_max_khz: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    // Unique per-instance counter so parallel tests never collide on a tempdir.
    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    /// A throwaway tempdir we fully own (no tempfile dependency in this crate).
    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "amos-power-freq-test-{}-{}-{seq}",
                std::process::id(),
                nanos
            ));
            fs::create_dir_all(&dir).unwrap();
            TestRoot(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn prep_cpu(root: &Path, cpu: u32, cpuinfo_max_khz: u32) {
        let dir = root.join(format!("cpu{cpu}/cpufreq"));
        fs::create_dir_all(&dir).unwrap();
        // Hardware max (what an uncapped / restore write must go back to) and the
        // current ceiling, initialised to an arbitrary value we'll overwrite.
        fs::write(dir.join("cpuinfo_max_freq"), format!("{cpuinfo_max_khz}\n")).unwrap();
        fs::write(dir.join("scaling_max_freq"), "999999\n").unwrap();
    }

    fn read_scaling(root: &Path, cpu: u32) -> u32 {
        let s =
            fs::read_to_string(root.join(format!("cpu{cpu}/cpufreq/scaling_max_freq"))).unwrap();
        s.trim().parse().unwrap()
    }

    #[test]
    fn applies_caps_and_restores_uncapped_clusters() {
        let root = TestRoot::new();
        prep_cpu(root.path(), 0, 1_800_000);
        prep_cpu(root.path(), 4, 2_500_000);
        let npu_dir = root.path().join("npu");
        fs::create_dir_all(&npu_dir).unwrap();
        fs::write(npu_dir.join("freq"), "0\n").unwrap();

        let gov = LinuxFreqGovernor::new(
            root.path().to_path_buf(),
            vec![(0, 0), (1, 4)],
            vec![npu_dir.join("freq")],
        );
        let plan = FreqPlan {
            cpu_caps: vec![
                FreqCap {
                    cluster: 0,
                    max_khz: Some(1_440_000),
                },
                // Uncapped (e.g. the protected Little cluster came back from
                // PowerSave): release -> restore the hardware max.
                FreqCap {
                    cluster: 1,
                    max_khz: None,
                },
            ],
            npu_cap_khz: Some(750_000),
        };
        let rep = gov.apply(&plan);
        assert!(rep.is_clean(), "failures: {:?}", rep.failures);
        // cluster-0 capped, cluster-1 released to its cpuinfo max, NPU capped.
        assert_eq!(rep.applied, 3);
        assert_eq!(read_scaling(root.path(), 0), 1_440_000);
        assert_eq!(read_scaling(root.path(), 4), 2_500_000);
        let npu = fs::read_to_string(npu_dir.join("freq")).unwrap();
        assert_eq!(npu.trim(), "750000");
    }

    #[test]
    fn unknown_cluster_is_reported_not_panicked() {
        let root = TestRoot::new();
        let gov = LinuxFreqGovernor::new(root.path().to_path_buf(), Vec::new(), Vec::new());
        let plan = FreqPlan {
            cpu_caps: vec![FreqCap {
                cluster: 7,
                max_khz: Some(100_000),
            }],
            npu_cap_khz: None,
        };
        let rep = gov.apply(&plan);
        assert!(!rep.is_clean());
        assert_eq!(rep.applied, 0);
        assert_eq!(rep.failures.len(), 1);
        assert!(rep.failures[0].0.contains('7'));
    }

    #[test]
    fn npu_without_paths_is_reported() {
        let root = TestRoot::new();
        let gov = LinuxFreqGovernor::new(root.path().to_path_buf(), Vec::new(), Vec::new());
        let plan = FreqPlan {
            cpu_caps: Vec::new(),
            npu_cap_khz: Some(500_000),
        };
        let rep = gov.apply(&plan);
        assert!(!rep.is_clean());
        assert!(rep.failures.iter().any(|(w, _)| w == "npu"));
        // Display surfaces the failure count + detail for logs.
        let s = rep.to_string();
        assert!(s.contains("1 failure"), "{s}");
        assert!(s.contains("npu_max_paths"), "{s}");
    }

    #[test]
    fn governor_decision_drives_sysfs_frequency_caps_end_to_end() {
        use crate::freq::{plan_from_decision, Cluster, ClusterKind};
        use crate::{BatteryState, EnergyGovernor, Telemetry};
        use amos_sensor::SensorMode;

        let root = TestRoot::new();
        // (cpu, cluster hw max kHz): little0@1.8GHz, big1@2.5GHz, prime2@3.2GHz.
        for (cpu, max) in [(0u32, 1_800_000u32), (4, 2_500_000), (6, 3_200_000)] {
            prep_cpu(root.path(), cpu, max);
        }
        let npu_dir = root.path().join("npu");
        fs::create_dir_all(&npu_dir).unwrap();
        fs::write(npu_dir.join("freq"), "0\n").unwrap();

        // little=0 (1.8 GHz) on cpu0 · big=1 (2.5 GHz) on cpu4 · prime=2 (3.2 GHz)
        // on cpu6; an NPU with a 1.5 GHz hardware max.
        let clusters = vec![
            Cluster::new(0, ClusterKind::Little, 1_800_000),
            Cluster::new(1, ClusterKind::Big, 2_500_000),
            Cluster::new(2, ClusterKind::Prime, 3_200_000),
        ];
        let gov = LinuxFreqGovernor::new(
            root.path().to_path_buf(),
            vec![(0, 0), (1, 4), (2, 6)],
            vec![npu_dir.join("freq")],
        );

        // Low battery -> EnergyGovernor issues a PowerSave decision...
        let mut eg = EnergyGovernor::default();
        let low = Telemetry::new(BatteryState::on_battery(15.0), Default::default(), None);
        let d = eg.observe(&low);
        assert_eq!(d.sensor_mode, SensorMode::PowerSave);
        // ...which maps to frequency ceilings and lands on the (fake) sysfs tree:
        // little stays responsive (80%), big/prime are cut hardest (50%/40%), NPU
        // at half.
        let plan = plan_from_decision(&d, &clusters, Some(1_500_000));
        let rep = gov.apply(&plan);
        assert!(rep.is_clean(), "failures: {:?}", rep.failures);
        assert_eq!(read_scaling(root.path(), 0), 1_440_000); // little 1.8 GHz × 80%
        assert_eq!(read_scaling(root.path(), 4), 1_250_000); // big 2.5 GHz × 50%
        assert_eq!(read_scaling(root.path(), 6), 1_280_000); // prime 3.2 GHz × 40%
        assert_eq!(
            fs::read_to_string(npu_dir.join("freq")).unwrap().trim(),
            "750000" // NPU 1.5 GHz × 50%
        );

        // Charging -> Performance: the plan is uncapped, and applying it *releases*
        // the caps by restoring each cluster's cpuinfo hardware max — otherwise a
        // PowerSave would throttle big/prime forever after recovery.
        let d2 = eg.observe(&Telemetry::new(
            BatteryState::charging(15.0),
            Default::default(),
            None,
        ));
        assert_eq!(d2.sensor_mode, SensorMode::Performance);
        let plan2 = plan_from_decision(&d2, &clusters, Some(1_500_000));
        assert!(plan2.is_uncapped());
        let rep2 = gov.apply(&plan2);
        assert!(rep2.is_clean(), "failures: {:?}", rep2.failures);
        assert_eq!(rep2.applied, 3); // one restore write per managed cluster
        assert_eq!(read_scaling(root.path(), 0), 1_800_000);
        assert_eq!(read_scaling(root.path(), 4), 2_500_000);
        assert_eq!(read_scaling(root.path(), 6), 3_200_000);
    }

    #[test]
    fn discover_groups_shared_policies_into_domains() {
        let root = TestRoot::new();
        // Two policies: little cpu0 (cpus 0..4, 1.8 GHz) and big cpu4 (4..8,
        // 2.5 GHz). Members 1..3 / 5..7 have no cpufreq dir.
        for (owner, related, max) in [
            (0u32, "0 1 2 3", 1_800_000u32),
            (4u32, "4 5 6 7", 2_500_000u32),
        ] {
            let dir = root.path().join(format!("cpu{owner}/cpufreq"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("cpuinfo_max_freq"), format!("{max}\n")).unwrap();
            fs::write(dir.join("related_cpus"), related).unwrap();
        }

        let domains = LinuxFreqGovernor::discover(root.path(), 8);
        assert_eq!(
            domains,
            vec![
                DiscoveredDomain {
                    rep_cpu: 0,
                    cpus: vec![0, 1, 2, 3],
                    max_khz: 1_800_000,
                },
                DiscoveredDomain {
                    rep_cpu: 4,
                    cpus: vec![4, 5, 6, 7],
                    max_khz: 2_500_000,
                },
            ]
        );

        // A mirrored dir on a member (cpu1 also reporting the group) must not
        // double-count: keyed by the group min (0), so cpu1's mirror is skipped.
        let dir1 = root.path().join("cpu1/cpufreq");
        fs::create_dir_all(&dir1).unwrap();
        fs::write(dir1.join("cpuinfo_max_freq"), "1800000\n").unwrap();
        fs::write(dir1.join("related_cpus"), "0 1 2 3").unwrap();
        let again = LinuxFreqGovernor::discover(root.path(), 8);
        assert_eq!(again.len(), 2, "mirrored member dir must not add a domain");
    }

    #[test]
    fn discovered_domain_becomes_a_cluster_and_plan() {
        use amos_sensor::SensorMode;
        let root = TestRoot::new();
        let dir = root.path().join("cpu4/cpufreq");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("cpuinfo_max_freq"), "2500000\n").unwrap();
        fs::write(dir.join("related_cpus"), "4 5 6 7").unwrap();

        let d = LinuxFreqGovernor::discover(root.path(), 8);
        assert_eq!(d.len(), 1);
        let cluster = d[0].cluster(ClusterKind::Big);
        assert_eq!(cluster.id, 4);
        assert_eq!(cluster.max_khz, 2_500_000);
        // Discovered max feeds the pure plan: PowerSave caps big at 50%.
        let p = crate::freq::plan(SensorMode::PowerSave, &[cluster], None);
        assert_eq!(p.cpu_caps[0].max_khz, Some(1_250_000));
    }

    #[test]
    fn npu_cap_is_released_to_known_max_when_uncapped() {
        let root = TestRoot::new();
        let npu_dir = root.path().join("npu");
        fs::create_dir_all(&npu_dir).unwrap();
        fs::write(npu_dir.join("freq"), "0\n").unwrap();
        let gov = LinuxFreqGovernor::new(
            root.path().to_path_buf(),
            Vec::new(),
            vec![npu_dir.join("freq")],
        )
        .with_npu_max(Some(1_500_000));

        // Cap the NPU at 750 kHz...
        let cap = FreqPlan {
            cpu_caps: Vec::new(),
            npu_cap_khz: Some(750_000),
        };
        let r1 = gov.apply(&cap);
        assert!(r1.is_clean(), "failures: {:?}", r1.failures);
        assert_eq!(
            fs::read_to_string(npu_dir.join("freq")).unwrap().trim(),
            "750000"
        );

        // ...then release: an uncapped plan restores the known 1.5 GHz max
        // (otherwise a PowerSave would leave the NPU throttled forever).
        let free = FreqPlan {
            cpu_caps: Vec::new(),
            npu_cap_khz: None,
        };
        let r2 = gov.apply(&free);
        assert!(r2.is_clean(), "failures: {:?}", r2.failures);
        assert_eq!(
            fs::read_to_string(npu_dir.join("freq")).unwrap().trim(),
            "1500000"
        );
    }

    #[test]
    fn npu_release_with_no_configured_path_is_reported_not_silent() {
        let root = TestRoot::new();
        // NPU max is set, but no node path was configured — releasing must not be
        // silently skipped (honest misconfiguration signal).
        let gov = LinuxFreqGovernor::new(root.path().to_path_buf(), Vec::new(), Vec::new())
            .with_npu_max(Some(1_500_000));
        let free = FreqPlan {
            cpu_caps: Vec::new(),
            npu_cap_khz: None,
        };
        let rep = gov.apply(&free);
        assert!(!rep.is_clean());
        assert_eq!(rep.applied, 0);
        assert_eq!(rep.failures.len(), 1);
        assert_eq!(rep.failures[0].0, "npu");
        assert!(rep.failures[0].1.contains("no npu_max_paths"));
    }

    #[test]
    fn discovered_topology_feeds_plan_and_apply_end_to_end() {
        use crate::freq::plan;
        use amos_sensor::SensorMode;

        let root = TestRoot::new();
        // little policy on cpu0 (1.8 GHz), big policy on cpu4 (2.5 GHz).
        prep_cpu(root.path(), 0, 1_800_000);
        prep_cpu(root.path(), 4, 2_500_000);

        // 1. Discover the topology straight off the (fake) sysfs tree.
        let domains = LinuxFreqGovernor::discover(root.path(), 8);
        assert_eq!(domains.len(), 2);
        let mut clusters = Vec::new();
        let mut reps = Vec::new();
        for d in &domains {
            let kind = if d.rep_cpu < 4 {
                ClusterKind::Little
            } else {
                ClusterKind::Big
            };
            clusters.push(d.cluster(kind));
            reps.push((d.rep_cpu, d.rep_cpu));
        }
        let gov = LinuxFreqGovernor::new(root.path().to_path_buf(), reps, Vec::new());

        // 2. A Balanced plan (little left free, big capped at 80%).
        let p = plan(SensorMode::Balanced, &clusters, None);
        let rep = gov.apply(&p);
        assert!(rep.is_clean(), "failures: {:?}", rep.failures);
        // little was uncapped -> released to its cpuinfo max (1.8 GHz);
        // big capped at 2.5 GHz × 80% = 2.0 GHz.
        assert_eq!(read_scaling(root.path(), 0), 1_800_000);
        assert_eq!(read_scaling(root.path(), 4), 2_000_000);

        // 3. PowerSave caps both: little 80%, big 50%.
        let ps = plan(SensorMode::PowerSave, &clusters, None);
        let rep2 = gov.apply(&ps);
        assert!(rep2.is_clean(), "failures: {:?}", rep2.failures);
        assert_eq!(read_scaling(root.path(), 0), 1_440_000);
        assert_eq!(read_scaling(root.path(), 4), 1_250_000);
    }
}
