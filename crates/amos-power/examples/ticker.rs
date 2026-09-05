//! Periodic-driver reference: how a daemon / System-UI ticker would run the
//! energy + frequency governors across a telemetry timeline.
//!
//! This is the caller-side loop `docs/power-policy.md` §6 names as the next step
//! (kept here as a runnable example so a ticker author can mirror it): each poll
//! it builds a [`Telemetry`] snapshot, asks the [`FrequencyGovernor`] for a
//! frequency plan, and — critically — applies it **only when it changed**
//! (a `None` tick means no redundant sysfs write). Writes nothing itself.
//!
//! ```text
//! cargo run -p amos-power --example ticker
//! ```

use amos_power::{BatteryState, Cluster, ClusterKind, FreqPlan, FrequencyGovernor, Telemetry};
use amos_sensor::SensorMode;

/// A sample phone-like chip: little / big / prime + a 1.5 GHz NPU.
fn chip() -> Vec<Cluster> {
    vec![
        Cluster::new(0, ClusterKind::Little, 1_800_000),
        Cluster::new(1, ClusterKind::Big, 2_500_000),
        Cluster::new(2, ClusterKind::Prime, 3_200_000),
    ]
}

/// One line of a telemetry timeline: a label and the snapshot to feed that tick.
struct Tick {
    label: &'static str,
    telemetry: Telemetry,
}

fn on_battery(level: f64) -> Telemetry {
    Telemetry::new(BatteryState::on_battery(level), Default::default(), None)
}

fn describe(plan: &FreqPlan) -> String {
    // Human-readable via the FreqPlan Display impl (e.g. cpu[cluster-0 free;
    // cluster-1≤2000000] | npu 750000).
    plan.to_string()
}

fn main() {
    println!("AmOS governor ticker — applying only *changed* frequency plans\n");
    let mut fg = FrequencyGovernor::new(Default::default(), chip(), Some(1_500_000));

    let ticks = vec![
        Tick {
            label: "t0  charging -> Performance",
            telemetry: Telemetry::new(BatteryState::charging(60.0), Default::default(), None),
        },
        Tick {
            label: "t1  on battery 70% -> Balanced",
            telemetry: on_battery(70.0),
        },
        Tick {
            label: "t2  same Balanced tick (no change)",
            telemetry: on_battery(70.0),
        },
        Tick {
            label: "t3  battery 12% -> PowerSave",
            telemetry: on_battery(12.0),
        },
        Tick {
            label: "t4  charger attached -> Performance",
            telemetry: Telemetry::new(BatteryState::charging(12.0), Default::default(), None),
        },
    ];

    for tick in ticks {
        let changed = fg.observe(&tick.telemetry);
        let mode = fg.mode().map(SensorMode::key).unwrap_or("?");
        match changed {
            Some(plan) => println!(
                "{:<36} mode={:<9} APPLY  {}",
                tick.label,
                mode,
                describe(&plan)
            ),
            None => println!("{:<36} mode={:<9} none   (skip write)", tick.label, mode),
        }
    }

    println!(
        "\nnotes: Balanced caps big/prime (~80%) + NPU while leaving the UI's little cluster\n\
         free, so an inference that *stays* Balanced (reason flips to power_draw, mode\n\
         unchanged) triggers no freq change; caps move on the mode transitions above."
    );
}
