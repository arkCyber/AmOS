//! Headless walkthrough of the energy-governor → CPU/NPU frequency loop.
//!
//! Shows how an [`EnergyGovernor`] decision (`SensorMode`) is folded into a
//! concrete [`FreqPlan`] of per-cluster + NPU frequency ceilings for a sample
//! heterogeneous chip, for every mode and for a live low-battery decision. It
//! only *prints* — nothing is written, so it runs anywhere.
//!
//! ```text
//! cargo run -p amos-power --example governor_freq
//! ```

use amos_power::{BatteryState, Cluster, ClusterKind, EnergyGovernor, Telemetry};
use amos_sensor::SensorMode;

fn main() {
    // A typical phone-like topology (id, kind, hw max kHz) + a 1.5 GHz NPU.
    // On a real device this comes from vendor tables / a HAL, not hard-coded.
    let clusters = [
        Cluster::new(0, ClusterKind::Little, 1_800_000),
        Cluster::new(1, ClusterKind::Big, 2_500_000),
        Cluster::new(2, ClusterKind::Prime, 3_200_000),
    ];
    let npu_max_khz = Some(1_500_000);

    println!("AmOS energy-governor → CPU/NPU frequency ceilings (sample chip)\n");
    for mode in SensorMode::ALL {
        print_mode(mode, &clusters, npu_max_khz);
    }

    println!("--- Derived from a live EnergyGovernor decision ---\n");
    // Low battery (15 %) → the governor emits a PowerSave decision.
    let mut gov = EnergyGovernor::default();
    let telemetry = Telemetry::new(BatteryState::on_battery(15.0), Default::default(), None);
    let decision = gov.observe(&telemetry);
    println!(
        "decision: mode={} reason={}",
        decision.sensor_mode.key(),
        decision.reason
    );
    print_plan(
        "low-battery tick",
        amos_power::plan_from_decision(&decision, &clusters, npu_max_khz),
    );
}

fn print_mode(mode: SensorMode, clusters: &[Cluster], npu_max_khz: Option<u32>) {
    print_plan(
        &format!("mode {}", mode.key()),
        amos_power::plan(mode, clusters, npu_max_khz),
    );
}

fn print_plan(label: &str, plan: amos_power::FreqPlan) {
    let caps = plan
        .cpu_caps
        .iter()
        .map(|c| match c.max_khz {
            Some(k) => format!("cluster-{} ≤ {k} kHz", c.cluster),
            None => format!("cluster-{} uncapped", c.cluster),
        })
        .collect::<Vec<_>>()
        .join(", ");
    let npu = match plan.npu_cap_khz {
        Some(k) => format!("npu ≤ {k} kHz"),
        None => "npu uncapped".to_string(),
    };
    println!("{label}: {caps}; {npu}");
}
