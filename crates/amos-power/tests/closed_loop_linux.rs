//! Host-only **closed loop**: power reading → decision → frequency → hardware.
//!
//! Chains the whole story the mobile-survival goal needs, with no device / no
//! `/sys`: a live power reading derived from a real `voltage × current` sample
//! (`amos_profiling`) is folded into a [`Telemetry`], the [`EnergyGovernor`]
//! turns the heavy-draw snapshot into a `Balanced` decision, the
//! [`FrequencyGovernor`] maps that to per-cluster + NPU ceilings, and the
//! [`LinuxFreqGovernor`] writes `scaling_max_freq` on a tempdir tree. It proves
//! "AI inference at high draw caps the inference-hogging big/prime + NPU while
//! sparing the responsive little cluster", and that charging then *restores* the
//! hardware maxes.
//!
//! Feature-gated `linux` (uses the sysfs applier). Run:
//! `cargo test -p amos-power --features linux --test closed_loop_linux`.

#![cfg(feature = "linux")]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

// Unique per-instance counter so parallel tests never collide on a tempdir.
static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

use amos_power::{
    BatteryState, Cluster, ClusterKind, ComposedGovernor, FrequencyGovernor, LinuxFreqGovernor,
    Policy, Telemetry, Usage,
};
use amos_profiling::{BatterySample, MockPowerSource};
use amos_sensor::{
    CameraConfig, CameraId, MockSensorProvider, PixelFormat, Resolution, SensorManager, SensorMode,
};

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
            "amos-power-closedloop-test-{}-{}-{seq}",
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
    fs::write(dir.join("cpuinfo_max_freq"), format!("{cpuinfo_max_khz}\n")).unwrap();
    fs::write(dir.join("scaling_max_freq"), "999999\n").unwrap();
}

fn read_scaling(root: &Path, cpu: u32) -> u32 {
    let s = fs::read_to_string(root.join(format!("cpu{cpu}/cpufreq/scaling_max_freq"))).unwrap();
    s.trim().parse().unwrap()
}

fn chip() -> Vec<Cluster> {
    vec![
        Cluster::new(0, ClusterKind::Little, 1_800_000),
        Cluster::new(1, ClusterKind::Big, 2_500_000),
        Cluster::new(2, ClusterKind::Prime, 3_200_000),
    ]
}

#[test]
fn live_power_draw_caps_inference_clusters_but_spares_little() {
    let root = TestRoot::new();
    // (cpu, cluster hw max): little0@1.8GHz, big1@2.5GHz, prime2@3.2GHz.
    for (cpu, max) in [(0u32, 1_800_000u32), (4, 2_500_000), (6, 3_200_000)] {
        prep_cpu(root.path(), cpu, max);
    }
    let npu_dir = root.path().join("npu");
    fs::create_dir_all(&npu_dir).unwrap();
    fs::write(npu_dir.join("freq"), "0\n").unwrap();

    // A real power reading: 1.2 A @ 5.0 V = 6.0 W — the profiling power model.
    let live_mw = BatterySample::new(1_200_000, 5000).power_mw();
    assert!((live_mw - 6000.0).abs() < 1e-9, "{live_mw}");

    let gov = LinuxFreqGovernor::new(
        root.path().to_path_buf(),
        vec![(0, 0), (1, 4), (2, 6)],
        vec![npu_dir.join("freq")],
    );
    let mut freq = FrequencyGovernor::new(Default::default(), chip(), Some(1_500_000));

    // Background inference, screen off, on battery at 70%, drawing 6 W (> 4 W
    // threshold) → the governor drops to Balanced to protect battery/thermals.
    let usage = Usage {
        screen_on: false,
        foreground_heavy: false,
        inference_active: true,
    };
    let t = Telemetry::new(BatteryState::on_battery(70.0), usage, None)
        .with_power_from(&MockPowerSource::new(live_mw));
    let plan = freq.observe(&t).expect("a changed plan on the first tick");
    assert_eq!(freq.mode(), Some(SensorMode::Balanced));
    assert!(!plan.is_uncapped());

    let rep = gov.apply(&plan);
    assert!(rep.is_clean(), "failures: {:?}", rep.failures);
    // Little (UI/phone) kept at hardware max (released, not capped)…
    assert_eq!(read_scaling(root.path(), 0), 1_800_000);
    // …big/prime capped at 80%, NPU at 85% of its hardware max.
    assert_eq!(read_scaling(root.path(), 4), 2_000_000); // 2.5 GHz × 80%
    assert_eq!(read_scaling(root.path(), 6), 2_560_000); // 3.2 GHz × 80%
    assert_eq!(
        fs::read_to_string(npu_dir.join("freq")).unwrap().trim(),
        "1275000" // 1.5 GHz × 85%
    );

    // The governor won't rewrite the identical Balanced plan every tick.
    assert!(freq.observe(&t).is_none());

    // Charging recovers → Performance: uncapped plan restores the hardware maxes.
    let charging = Telemetry::new(BatteryState::charging(70.0), Default::default(), None);
    let plan2 = freq
        .observe(&charging)
        .expect("mode change surfaces a plan");
    assert!(plan2.is_uncapped());
    let rep2 = gov.apply(&plan2);
    assert!(rep2.is_clean(), "failures: {:?}", rep2.failures);
    assert_eq!(read_scaling(root.path(), 0), 1_800_000);
    assert_eq!(read_scaling(root.path(), 4), 2_500_000);
    assert_eq!(read_scaling(root.path(), 6), 3_200_000);
}

/// A `SensorManager` over a mock 30 FPS rear camera (PowerSave-gated).
fn sensors_30fps() -> SensorManager {
    use std::sync::Arc;
    let cfg = CameraConfig {
        id: CameraId::REAR,
        resolution: Resolution::new(640, 480),
        fps: 30, // above the PowerSave camera ceiling (15)
        format: PixelFormat::Rgba8,
    };
    let provider = MockSensorProvider::new(vec![cfg], 200, false);
    SensorManager::new(Arc::new(provider), SensorMode::Balanced)
}

#[test]
fn discover_then_composed_governor_caps_sysfs_and_gates_sensors() {
    let root = TestRoot::new();
    // little policy on cpu0 (1.8 GHz), big policy on cpu4 (2.5 GHz).
    prep_cpu(root.path(), 0, 1_800_000);
    prep_cpu(root.path(), 4, 2_500_000);
    let npu_dir = root.path().join("npu");
    fs::create_dir_all(&npu_dir).unwrap();
    fs::write(npu_dir.join("freq"), "0\n").unwrap();

    // 1. Discover the topology off the (fake) sysfs tree.
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
    let applier =
        LinuxFreqGovernor::new(root.path().to_path_buf(), reps, vec![npu_dir.join("freq")])
            .with_npu_max(Some(1_500_000));

    // 2. A composed governor over that topology + a real SensorManager.
    let mut gov = ComposedGovernor::new(
        Policy::default(),
        clusters,
        Some(1_500_000),
        sensors_30fps(),
    );

    // 3. Low battery -> PowerSave: plan surfaced, sensor manager gated, sysfs capped.
    let low = Telemetry::new(BatteryState::on_battery(12.0), Default::default(), None);
    let plan = gov.observe(&low).expect("first tick surfaces a plan");
    assert_eq!(gov.sensors().mode(), SensorMode::PowerSave);
    assert!(
        gov.sensors().camera_capture(CameraId::REAR).is_err(),
        "30 FPS camera must be refused under PowerSave"
    );
    let rep = applier.apply(&plan);
    assert!(rep.is_clean(), "failures: {:?}", rep.failures);
    assert_eq!(read_scaling(root.path(), 0), 1_440_000); // little 80%
    assert_eq!(read_scaling(root.path(), 4), 1_250_000); // big 50%
    assert_eq!(
        fs::read_to_string(npu_dir.join("freq")).unwrap().trim(),
        "750000" // NPU 50%
    );

    // 4. Charging -> Performance: manager recovers and sysfs caps are restored.
    let charge = Telemetry::new(BatteryState::charging(12.0), Default::default(), None);
    let plan2 = gov.observe(&charge).expect("mode change surfaces a plan");
    assert!(plan2.is_uncapped());
    assert_eq!(gov.sensors().mode(), SensorMode::Performance);
    assert!(gov.sensors().camera_capture(CameraId::REAR).is_ok());
    let rep2 = applier.apply(&plan2);
    assert!(rep2.is_clean(), "failures: {:?}", rep2.failures);
    assert_eq!(read_scaling(root.path(), 0), 1_800_000);
    assert_eq!(read_scaling(root.path(), 4), 2_500_000);
    assert_eq!(
        fs::read_to_string(npu_dir.join("freq")).unwrap().trim(),
        "1500000"
    );
}
