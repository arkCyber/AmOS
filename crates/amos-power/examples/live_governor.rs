//! Host demo: the **whole** power/performance loop running live in one process.
//!
//! Ties together both halves of the mobile-survival goal with no device / no `/sys`:
//! a real power reading (from the `amos-profiling` voltage×current model via
//! [`BatterySample`]/[`MockPowerSource`]) is folded into a [`Telemetry`], a
//! [`ComposedGovernor`] turns it into an energy decision that (a) gates the real
//! `amos-sensor` [`SensorManager`] (a 30 FPS camera is refused under PowerSave) and
//! (b) surfaces a deduped CPU/NPU frequency plan, all over a simulated timeline.
//!
//! ```text
//! cargo run -p amos-power --example live_governor
//! ```

use std::sync::Arc;

use amos_power::{
    BatteryState, Cluster, ClusterKind, ComposedGovernor, FreqPlan, Telemetry, Usage,
};
use amos_profiling::{BatterySample, MockPowerSource};
use amos_sensor::{
    CameraConfig, CameraId, MockSensorProvider, PixelFormat, Resolution, SensorError,
    SensorManager, SensorMode,
};

/// A sample phone-like chip: little / big / prime + a 1.5 GHz NPU.
fn chip() -> Vec<Cluster> {
    vec![
        Cluster::new(0, ClusterKind::Little, 1_800_000),
        Cluster::new(1, ClusterKind::Big, 2_500_000),
        Cluster::new(2, ClusterKind::Prime, 3_200_000),
    ]
}

/// A 30 FPS rear camera backed by a deterministic mock provider.
fn sensors() -> SensorManager {
    let cfg = CameraConfig {
        id: CameraId::REAR,
        resolution: Resolution::new(640, 480),
        fps: 30, // above the PowerSave camera ceiling (15)
        format: PixelFormat::Rgba8,
    };
    let provider = MockSensorProvider::new(vec![cfg], 200, false);
    SensorManager::new(Arc::new(provider), SensorMode::Balanced)
}

fn screen_on() -> Usage {
    Usage {
        screen_on: true,
        foreground_heavy: false,
        inference_active: false,
    }
}

fn describe(plan: &FreqPlan) -> String {
    let cpu = plan
        .cpu_caps
        .iter()
        .map(|c| match c.max_khz {
            Some(k) => format!("cluster-{}≤{k}", c.cluster),
            None => format!("cluster-{} free", c.cluster),
        })
        .collect::<Vec<_>>()
        .join("  ");
    let npu = match plan.npu_cap_khz {
        Some(k) => format!("npu≤{k}"),
        None => "npu free".to_string(),
    };
    format!("[{cpu} | {npu}]")
}

fn camera_status(gov: &ComposedGovernor) -> &'static str {
    match gov.sensors().camera_capture(CameraId::REAR) {
        Ok(_) => "camera 30fps OK",
        Err(SensorError::PowerSaveRate { .. }) => "camera 30fps REFUSED (PowerSave)",
        Err(_) => "camera error",
    }
}

fn main() {
    println!("AmOS live power+energy+frequency loop (host simulation; writes nothing)\n");
    let mut gov = ComposedGovernor::new(Default::default(), chip(), Some(1_500_000), sensors());

    // A real power reading from the profiling model: 1.2 A @ 5.0 V = 6 W under a
    // heavy inference. Used below to (re)create an accurate live draw.
    let heavy_inference_w = BatterySample::new(1_200_000, 5000).power_mw();
    assert!(heavy_inference_w > 4000.0, "6 W > 4 W high-draw threshold");

    let ticks = vec![
        (
            "t0  charging 60%",
            Telemetry::new(BatteryState::charging(60.0), screen_on(), None),
        ),
        (
            "t1  on battery 70%, idle",
            Telemetry::new(BatteryState::on_battery(70.0), screen_on(), None),
        ),
        (
            "t2  battery 12% + heavy inference @6 W",
            Telemetry::new(BatteryState::on_battery(12.0), screen_on(), None)
                .with_power_from(&MockPowerSource::new(heavy_inference_w)),
        ),
        (
            "t3  charger attached 12%",
            Telemetry::new(BatteryState::charging(12.0), screen_on(), None),
        ),
    ];

    for (label, t) in ticks {
        let changed = gov.observe(&t);
        let mode = gov.mode().map(SensorMode::key).unwrap_or("?");
        match changed {
            Some(plan) => println!(
                "{:<32} mode={:<9} {:<22} APPLY  {}",
                label,
                mode,
                camera_status(&gov),
                describe(&plan)
            ),
            None => println!(
                "{:<32} mode={:<9} {:<22} none   (skip write)",
                label,
                mode,
                camera_status(&gov)
            ),
        }
    }

    println!(
        "\nnotes: PowerSave gates the 30 FPS camera (SensorManager) AND caps big/prime;\n\
         Balanced leaves the UI's little cluster free while capping big/prime (~80%) + NPU;\n\
         charging restores full speed and re-allows the camera."
    );
}
