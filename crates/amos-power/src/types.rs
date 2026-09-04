//! Input snapshot types for the energy governor.
//!
//! The governor is a pure function of a [`Telemetry`] snapshot, so each tick is
//! just: measure (battery + thermal + live power + usage) → build a `Telemetry` →
//! call [`crate::decide`]. Keeping inputs as plain data (not a trait) makes the
//! rule deterministic and lets tests construct any state directly.

use amos_profiling::PowerSource;

/// What the battery / charger / thermal subsystem reported on this tick.
///
/// `None` on the optionals means "unknown / not sampled yet" — the policy treats
/// an absent reading conservatively (it never *assumes* a healthy battery).
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct BatteryState {
    /// State of charge, 0.0–100.0 percent. `None` when the reading is unavailable.
    pub level_pct: Option<f64>,
    /// Whether a charger is attached. When `true` the governor may raise to the
    /// charging (performance) tier instead of saving battery.
    pub charging: bool,
    /// Device / die temperature, °C. `None` when the reading is unavailable.
    pub temperature_c: Option<f64>,
}

impl BatteryState {
    /// A fully-known healthy snapshot, on battery at `level_pct`%.
    pub fn on_battery(level_pct: f64) -> Self {
        Self {
            level_pct: Some(level_pct),
            charging: false,
            temperature_c: Some(25.0),
        }
    }

    /// A fully-known snapshot, charging at `level_pct`%.
    pub fn charging(level_pct: f64) -> Self {
        Self {
            level_pct: Some(level_pct),
            charging: true,
            temperature_c: Some(25.0),
        }
    }
}

/// What the user / system is doing this tick. This is the *foreground ↔
/// background* signal the governor uses to decide whether to defer work.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Usage {
    /// Is the screen on (the user is actively looking at the device)?
    pub screen_on: bool,
    /// Is a heavy, user-visible workload in the foreground (camera preview, AR,
    /// a big UI render)? Distinct from generic "screen on".
    pub foreground_heavy: bool,
    /// Is a local on-device inference (LLM / ASR) running right now?
    pub inference_active: bool,
}

/// The full per-tick picture the policy decides on.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Telemetry {
    pub battery: BatteryState,
    /// Live average board power draw in mW (from a
    /// [`PowerSource`](amos_profiling::PowerSource)); `None` when unavailable.
    pub power_mw: Option<f64>,
    pub usage: Usage,
}

impl Telemetry {
    /// Build a snapshot from an explicit battery + usage + an optional live
    /// power figure (this is what a sampler reads off the power HAL).
    pub fn new(battery: BatteryState, usage: Usage, power_mw: Option<f64>) -> Self {
        Self {
            battery,
            power_mw,
            usage,
        }
    }

    /// Sample live power from a [`PowerSource`] and fold it into the snapshot.
    /// A non-finite reading is treated as "unknown" (`None`), never trusted.
    pub fn with_power_from(mut self, power: &dyn PowerSource) -> Self {
        let mw = power.average_power_mw();
        self.power_mw = if mw.is_finite() { Some(mw) } else { None };
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_conservative_not_healthy() {
        // Unknown battery level off-charger is the conservative baseline.
        let t = Telemetry::default();
        assert_eq!(t.battery.level_pct, None);
        assert!(!t.battery.charging);
        assert_eq!(t.battery.temperature_c, None);
        assert_eq!(t.power_mw, None);
    }

    #[test]
    fn battery_constructors_carry_level_and_charger() {
        let b = BatteryState::on_battery(55.0);
        assert_eq!(b.level_pct, Some(55.0));
        assert!(!b.charging);
        let c = BatteryState::charging(42.0);
        assert!(c.charging);
    }

    #[test]
    fn with_power_source_sanitises_non_finite() {
        struct Fixed(f64);
        impl PowerSource for Fixed {
            fn name(&self) -> &'static str {
                "fixed"
            }
            fn average_power_mw(&self) -> f64 {
                self.0
            }
        }
        let usage = Usage::default();
        // Finite → Some.
        let t =
            Telemetry::new(BatteryState::default(), usage, None).with_power_from(&Fixed(1234.0));
        assert_eq!(t.power_mw, Some(1234.0));
        // Non-finite → None, never leaked through.
        let t2 =
            Telemetry::new(BatteryState::default(), usage, None).with_power_from(&Fixed(f64::NAN));
        assert_eq!(t2.power_mw, None);
        let t3 = Telemetry::new(BatteryState::default(), usage, None)
            .with_power_from(&Fixed(f64::INFINITY));
        assert_eq!(t3.power_mw, None);
    }
}
