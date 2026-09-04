//! The energy policy: [`Policy`] thresholds, the [`Decision`] a tick produces and
//! the pure, deterministic rule engine [`decide`].
//!
//! The rule is intentionally **pure** — `decide(policy, telemetry, current)` is a
//! function of its inputs only, so it cannot flap on wall-clock jitter and every
//! branch is unit-testable. Entry/exit **hysteresis** (so a value hovering at a
//! boundary does not oscillate between modes) is expressed via `current`: pass the
//! previous tick's [`Decision`] (as [`EnergyGovernor`](crate::governor::EnergyGovernor)
//! does) and the battery-low band only *enters* below `power_save_on_level_pct` and
//! only *exits* above `power_save_off_level_pct`; the thermal tiers carry an
//! analogous exit cushion.

use amos_sensor::SensorManager;
use amos_sensor::SensorMode;

use crate::types::Telemetry;

/// Energy-mode ordering used to reason about "deeper save".
///
/// `Performance < Balanced < PowerSave`. A transition to a *higher* index is a
/// deeper power save (protective, applied at once); returning to a lower index is
/// a restore (governed by hysteresis / cooldown so it does not flap).
#[cfg(test)]
fn save_rank(mode: SensorMode) -> u8 {
    match mode {
        SensorMode::Performance => 0,
        SensorMode::Balanced => 1,
        SensorMode::PowerSave => 2,
    }
}

/// Why the governor chose the mode / flags it did. Kept as a closed enum so UI and
/// logs can show a stable, machine-readable reason (vs. an ad-hoc string).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// Charger attached and thermals are fine → allow full performance.
    Charging,
    /// On battery, everything healthy → everyday Balanced, no throttle.
    Healthy,
    /// On battery, live power is high under a heavy load → drop to Balanced.
    PowerDraw,
    /// On battery, charge at/below the save-on level → PowerSave.
    BatteryLow,
    /// On battery, already in PowerSave from a low battery and still under the
    /// save-off level → hold PowerSave (hysteresis exit guard).
    BatteryLowHold,
    /// On battery, charge critically low → hard PowerSave + cap inference.
    BatteryCritical,
    /// Device hot (below critical) → Balanced, never Performance.
    ThermalHigh,
    /// Device critically hot → hard PowerSave + cap everything.
    ThermalCritical,
}

impl Reason {
    /// Stable key for UI / logs / a future wire bus.
    pub fn key(self) -> &'static str {
        match self {
            Reason::Charging => "charging",
            Reason::Healthy => "healthy",
            Reason::PowerDraw => "power_draw",
            Reason::BatteryLow => "battery_low",
            Reason::BatteryLowHold => "battery_low_hold",
            Reason::BatteryCritical => "battery_critical",
            Reason::ThermalHigh => "thermal_high",
            Reason::ThermalCritical => "thermal_critical",
        }
    }
}

impl std::fmt::Display for Reason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.key())
    }
}

/// Tunable decision thresholds. `Default` is a sane phone profile; chainable
/// `with_*` builders override single knobs. Kept [`Copy`] so it can be shared and
/// cheaply normalized per call.
#[derive(Clone, Copy, Debug)]
pub struct Policy {
    /// Below/at this charge the governor forces PowerSave regardless of load.
    pub critical_level_pct: f64,
    /// At/under this charge the governor *enters* PowerSave (battery low).
    pub power_save_on_level_pct: f64,
    /// Above/at this charge a PowerSave-from-low-battery *exits* (hysteresis).
    pub power_save_off_level_pct: f64,
    /// Live draw (mW) at/above which, on battery + heavy load, we drop to Balanced.
    pub high_power_mw: f64,
    /// At/above this die temperature (°C) we refuse Performance (cap at Balanced).
    pub high_temp_c: f64,
    /// At/above this die temperature (°C) we force PowerSave + cap everything.
    pub critical_temp_c: f64,
    /// Exit cushion below a thermal tier (°C) before we restore the lighter mode.
    pub thermal_exit_hysteresis_c: f64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            critical_level_pct: 10.0,
            power_save_on_level_pct: 20.0,
            power_save_off_level_pct: 30.0,
            high_power_mw: 4000.0,
            high_temp_c: 38.0,
            critical_temp_c: 45.0,
            thermal_exit_hysteresis_c: 2.0,
        }
    }
}

impl Policy {
    /// Return a copy with degenerate configurations normalized so the invariants
    /// `critical_level ≤ save_on ≤ save_off` and `critical_temp > high_temp` hold,
    /// with all levels clamped to 0–100. Called at the top of [`decide`]; a
    /// contradictory input collapses to an ordered (still safe) configuration
    /// rather than ever violating the ordering the rule relies on.
    pub fn normalized(&self) -> Self {
        let mut p = *self;
        if p.critical_temp_c <= p.high_temp_c {
            p.critical_temp_c = p.high_temp_c + 1.0;
        }
        p.thermal_exit_hysteresis_c = p.thermal_exit_hysteresis_c.max(0.0);

        let clamp100 = |x: f64| x.clamp(0.0, 100.0);
        let on = clamp100(p.power_save_on_level_pct);
        // Exit band must be at or above the entry band.
        let off = clamp100(p.power_save_off_level_pct).max(on);
        // Critical must never be above the entry level (it is the more urgent floor).
        let critical = clamp100(p.critical_level_pct).min(on);
        p.power_save_on_level_pct = on;
        p.power_save_off_level_pct = off;
        p.critical_level_pct = critical;
        p
    }

    /// Chainable builder: override the battery-critical level.
    pub fn with_critical_level(mut self, pct: f64) -> Self {
        self.critical_level_pct = pct;
        self
    }
    /// Chainable builder: override the PowerSave entry level.
    pub fn with_save_on_level(mut self, pct: f64) -> Self {
        self.power_save_on_level_pct = pct;
        self
    }
    /// Chainable builder: override the PowerSave exit level (hysteresis).
    pub fn with_save_off_level(mut self, pct: f64) -> Self {
        self.power_save_off_level_pct = pct;
        self
    }
    /// Chainable builder: override the high-draw threshold (mW).
    pub fn with_high_power_mw(mut self, mw: f64) -> Self {
        self.high_power_mw = mw;
        self
    }
    /// Chainable builder: override the high-thermal tier (°C).
    pub fn with_high_temp(mut self, c: f64) -> Self {
        self.high_temp_c = c;
        self
    }
    /// Chainable builder: override the critical-thermal tier (°C).
    pub fn with_critical_temp(mut self, c: f64) -> Self {
        self.critical_temp_c = c;
        self
    }
}

/// The result of one policy tick: which [`SensorMode`] to run sensors/inference
/// in, whether to cap heavy inference, whether to defer background work, and why.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Decision {
    /// The energy mode to push into [`SensorManager`] / expose to the engine.
    pub sensor_mode: SensorMode,
    /// Recommend capping / deferring a running local inference (LLM / heavy ASR).
    pub cap_inference: bool,
    /// Recommend deferring background work (non-user-visible polling / sync /
    /// background inference) — the "background gating" half of foreground↔background.
    pub throttle_background: bool,
    /// Why this decision was reached (stable machine-readable key).
    pub reason: Reason,
}

impl Decision {
    /// Apply the chosen mode into a [`SensorManager`] (this is how the decision
    /// actually gates continuous sampling). The manager already refuses too-fast
    /// streams in `PowerSave`; we just point it at the decided mode.
    pub fn apply_to(&self, manager: &SensorManager) {
        manager.set_mode(self.sensor_mode);
    }
}

impl std::fmt::Display for Decision {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "mode: {}", self.sensor_mode.key())?;
        writeln!(f, "cap_inference: {}", self.cap_inference)?;
        writeln!(f, "throttle_background: {}", self.throttle_background)?;
        write!(f, "reason: {}", self.reason)
    }
}

// ---- small branch helpers -------------------------------------------------

/// A float `reading >= bound`, treating non-finite / absent as `false`.
fn at_least(reading: Option<f64>, bound: f64) -> bool {
    matches!(reading, Some(x) if x.is_finite() && x >= bound)
}
/// A float `reading <= bound`, treating non-finite / absent as `false`.
fn at_most(reading: Option<f64>, bound: f64) -> bool {
    matches!(reading, Some(x) if x.is_finite() && x <= bound)
}

/// True when the previous decision was a PowerSave caused by low battery
/// (including the critical tier) — used for the exit hysteresis band.
fn was_battery_save(cur: Option<&Decision>) -> bool {
    matches!(
        cur,
        Some(Decision {
            sensor_mode: SensorMode::PowerSave,
            reason: Reason::BatteryLow | Reason::BatteryLowHold | Reason::BatteryCritical,
            ..
        })
    )
}

/// True when the previous decision was a PowerSave caused by critical thermals —
/// used for the thermal exit cushion so a temperature hovering at the critical
/// line does not oscillate.
fn was_thermal_critical_save(cur: Option<&Decision>) -> bool {
    matches!(
        cur,
        Some(Decision {
            sensor_mode: SensorMode::PowerSave,
            reason: Reason::ThermalCritical,
            ..
        })
    )
}

/// True when the previous decision already throttled because of non-critical
/// heat (so we stay at Balanced until the temperature falls by the exit cushion).
fn was_thermal_high(cur: Option<&Decision>) -> bool {
    matches!(
        cur,
        Some(Decision {
            sensor_mode: SensorMode::Balanced,
            reason: Reason::ThermalHigh,
            ..
        })
    )
}

// ---- the rule -------------------------------------------------------------

/// Decide the energy mode + throttle flags for one [`Telemetry`] snapshot.
///
/// `current` is the previous tick's [`Decision`] (or `None` on the first tick).
/// It is only used for hysteresis — the *same* thresholds decide both directions,
/// but a mode that would restore a PowerSave is held until the input moves past
/// the exit band, so values hovering at a boundary do not make the mode flap.
///
/// Priority (first match wins, strongest pressure first):
/// 1. critically hot → hard PowerSave, cap everything
/// 2. critical battery (on battery) → hard PowerSave
/// 3. low battery (on battery) → PowerSave (hysteretic on/off band)
/// 4. hot (non-critical) → Balanced, never Performance (hysteretic exit)
/// 5. high live power + heavy load (on battery) → Balanced
/// 6. charging + cool → Performance
/// 7. otherwise (on battery, healthy) → Balanced
///
/// The returned mode is authoritative; `cap_inference` / `throttle_background`
/// are *recommendations* a scheduler uses to gate the engine / background tasks.
pub fn decide(policy: &Policy, t: &Telemetry, current: Option<&Decision>) -> Decision {
    let p = policy.normalized();
    let battery = t.battery;
    let on_battery = !battery.charging;
    let usage = t.usage;

    let thermal_save_exit = p.critical_temp_c - p.thermal_exit_hysteresis_c;
    let thermal_high_exit = p.high_temp_c - p.thermal_exit_hysteresis_c;

    // 1. Critical heat — force full save, keep it held until we cool below the
    //    exit cushion (so a temperature hovering at the critical line is stable).
    if at_least(battery.temperature_c, p.critical_temp_c) {
        return Decision {
            sensor_mode: SensorMode::PowerSave,
            cap_inference: true,
            throttle_background: true,
            reason: Reason::ThermalCritical,
        };
    }
    if was_thermal_critical_save(current) && at_least(battery.temperature_c, thermal_save_exit) {
        return Decision {
            sensor_mode: SensorMode::PowerSave,
            cap_inference: true,
            throttle_background: true,
            reason: Reason::ThermalCritical,
        };
    }

    if on_battery {
        // 2. Critical battery — hard save (hard floor we only leave on recovery).
        if at_most(battery.level_pct, p.critical_level_pct) {
            return Decision {
                sensor_mode: SensorMode::PowerSave,
                cap_inference: true,
                throttle_background: true,
                reason: Reason::BatteryCritical,
            };
        }
        // 3. Low battery — enter at <= on, hold until >= off (hysteresis).
        let low_active = was_battery_save(current);
        if at_most(battery.level_pct, p.power_save_on_level_pct) {
            return Decision {
                sensor_mode: SensorMode::PowerSave,
                cap_inference: true,
                throttle_background: true,
                reason: Reason::BatteryLow,
            };
        }
        if low_active && !at_least(battery.level_pct, p.power_save_off_level_pct) {
            return Decision {
                sensor_mode: SensorMode::PowerSave,
                cap_inference: true,
                throttle_background: true,
                reason: Reason::BatteryLowHold,
            };
        }
    }

    // 4. Non-critical heat — at most Balanced (never Performance). Held while the
    //    die stays above the high-exit cushion once we already throttled for heat.
    if at_least(battery.temperature_c, p.high_temp_c) {
        return Decision {
            sensor_mode: SensorMode::Balanced,
            cap_inference: usage.inference_active,
            throttle_background: true,
            reason: Reason::ThermalHigh,
        };
    }
    if was_thermal_high(current) && at_least(battery.temperature_c, thermal_high_exit) {
        return Decision {
            sensor_mode: SensorMode::Balanced,
            cap_inference: usage.inference_active,
            throttle_background: true,
            reason: Reason::ThermalHigh,
        };
    }

    // 5. High sustained draw under a heavy load on battery → drop to Balanced so
    //    we do not drain / heat while hammering the SoC.
    if on_battery {
        let heavy_load = usage.inference_active || usage.foreground_heavy || !usage.screen_on;
        if heavy_load && at_least(t.power_mw, p.high_power_mw) {
            return Decision {
                sensor_mode: SensorMode::Balanced,
                cap_inference: usage.inference_active,
                throttle_background: !usage.screen_on,
                reason: Reason::PowerDraw,
            };
        }
    }

    // 6. Charging + cool → full performance is allowed.
    if battery.charging {
        return Decision {
            sensor_mode: SensorMode::Performance,
            cap_inference: false,
            throttle_background: false,
            reason: Reason::Charging,
        };
    }

    // 7. On battery, healthy → everyday Balanced. We still mark *background*
    //    inference as deferrable when the screen is off (foreground↔background),
    //    but do not hard-cap anything.
    Decision {
        sensor_mode: SensorMode::Balanced,
        cap_inference: false,
        throttle_background: usage.inference_active && !usage.screen_on,
        reason: Reason::Healthy,
    }
}

/// Build a full [`Telemetry`] with default (screen-on, no workload) usage.
#[cfg(test)]
fn healthy_telemetry(battery: crate::types::BatteryState) -> crate::types::Telemetry {
    crate::types::Telemetry::new(battery, crate::types::Usage::default(), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{BatteryState, Telemetry, Usage};

    fn on_battery(level: f64) -> Telemetry {
        healthy_telemetry(BatteryState::on_battery(level))
    }

    #[test]
    fn charging_cool_is_performance() {
        let d = decide(&Policy::default(), &on_battery(50.0), None); // on battery
        assert_eq!(d.sensor_mode, SensorMode::Balanced);
        let t = healthy_telemetry(BatteryState::charging(50.0));
        let d2 = decide(&Policy::default(), &t, None);
        assert_eq!(d2.sensor_mode, SensorMode::Performance);
        assert_eq!(d2.reason, Reason::Charging);
        assert!(!d2.cap_inference && !d2.throttle_background);
    }

    #[test]
    fn on_battery_healthy_is_balanced() {
        let d = decide(&Policy::default(), &on_battery(60.0), None);
        assert_eq!(d.sensor_mode, SensorMode::Balanced);
        assert_eq!(d.reason, Reason::Healthy);
        assert!(!d.cap_inference);
    }

    #[test]
    fn low_battery_enters_power_save_below_save_on() {
        let d = decide(&Policy::default(), &on_battery(15.0), None);
        assert_eq!(d.sensor_mode, SensorMode::PowerSave);
        assert_eq!(d.reason, Reason::BatteryLow);
        assert!(d.cap_inference && d.throttle_background);
    }

    #[test]
    fn low_battery_band_is_hysteretic() {
        let p = Policy::default(); // enter <= 20, exit >= 30
                                   // Enter at 18.
        let in_save = decide(&p, &on_battery(18.0), None);
        assert_eq!(in_save.sensor_mode, SensorMode::PowerSave);
        // Held while below the 30 exit even after recovering past the 20 entry.
        let held = decide(&p, &on_battery(25.0), Some(&in_save));
        assert_eq!(held.sensor_mode, SensorMode::PowerSave);
        assert_eq!(held.reason, Reason::BatteryLowHold);
        // Once >= 30 it restores.
        let exited = decide(&p, &on_battery(31.0), Some(&in_save));
        assert_eq!(exited.sensor_mode, SensorMode::Balanced);
        assert_eq!(exited.reason, Reason::Healthy);
        // A fresh tick (no history) at 25 does NOT enter PowerSave (above entry).
        let fresh = decide(&p, &on_battery(25.0), None);
        assert_eq!(fresh.sensor_mode, SensorMode::Balanced);
    }

    #[test]
    fn critical_battery_forces_save_regardless_of_history() {
        let p = Policy::default();
        let d = decide(&p, &on_battery(5.0), None);
        assert_eq!(d.sensor_mode, SensorMode::PowerSave);
        assert_eq!(d.reason, Reason::BatteryCritical);
    }

    #[test]
    fn thermal_critical_forces_hard_save_even_while_charging() {
        let mut b = BatteryState::charging(90.0);
        b.temperature_c = Some(47.0); // heat wins over the charger
        let d = decide(&Policy::default(), &healthy_telemetry(b), None);
        assert_eq!(d.sensor_mode, SensorMode::PowerSave);
        assert_eq!(d.reason, Reason::ThermalCritical);
        assert!(d.cap_inference && d.throttle_background);
    }

    #[test]
    fn thermal_high_caps_at_balanced_not_power_save() {
        let p = Policy::default(); // high 38, critical 45
        let mut b = BatteryState::on_battery(70.0);
        b.temperature_c = Some(40.0);
        let d = decide(&p, &healthy_telemetry(b), None);
        assert_eq!(d.sensor_mode, SensorMode::Balanced);
        assert_eq!(d.reason, Reason::ThermalHigh);
    }

    #[test]
    fn thermal_critical_exit_has_cushion() {
        let p = Policy::default(); // critical 45, exit cushion 2 -> restore under 43
        let mut hot = BatteryState::on_battery(70.0);
        hot.temperature_c = Some(46.0);
        let entered = decide(&p, &healthy_telemetry(hot), None);
        assert_eq!(entered.reason, Reason::ThermalCritical);
        // Still 44 (>43 exit cushion): a previous ThermalCritical stays PowerSave.
        hot.temperature_c = Some(44.0);
        let held = decide(&p, &healthy_telemetry(hot), Some(&entered));
        assert_eq!(held.sensor_mode, SensorMode::PowerSave);
        assert_eq!(held.reason, Reason::ThermalCritical);
        // Down to 42 (< 43): restores to Balanced.
        hot.temperature_c = Some(42.0);
        let restored = decide(&p, &healthy_telemetry(hot), Some(&entered));
        assert_eq!(restored.sensor_mode, SensorMode::Balanced);
        assert_ne!(restored.reason, Reason::ThermalCritical);
    }

    #[test]
    fn high_power_under_heavy_load_drops_to_balanced() {
        let p = Policy::default().with_high_power_mw(4000.0);
        let usage = Usage {
            screen_on: true,
            foreground_heavy: true,
            inference_active: false,
        };
        let t = Telemetry::new(BatteryState::on_battery(70.0), usage, Some(4800.0));
        let d = decide(&p, &t, None);
        assert_eq!(d.sensor_mode, SensorMode::Balanced);
        assert_eq!(d.reason, Reason::PowerDraw);
        assert!(!d.cap_inference);
        // Screen off + heavy background is also "load" for power-draw purposes.
        let bg = Usage {
            screen_on: false,
            foreground_heavy: false,
            inference_active: true,
        };
        let tb = Telemetry::new(BatteryState::on_battery(70.0), bg, Some(4800.0));
        let db = decide(&p, &tb, None);
        assert_eq!(db.reason, Reason::PowerDraw);
        assert!(
            db.cap_inference,
            "background inference under high draw is capped"
        );
    }

    #[test]
    fn high_power_but_light_load_stays_healthy_balanced() {
        let p = Policy::default().with_high_power_mw(4000.0);
        // Screen on, no heavy foreground, no inference, but the reading is high
        // (e.g. transient) → not a "load" we throttle; stays healthy Balanced.
        let usage = Usage {
            screen_on: true,
            foreground_heavy: false,
            inference_active: false,
        };
        let t = Telemetry::new(BatteryState::on_battery(70.0), usage, Some(4800.0));
        let d = decide(&p, &t, None);
        assert_eq!(d.reason, Reason::Healthy);
        assert_eq!(d.sensor_mode, SensorMode::Balanced);
    }

    #[test]
    fn healthy_marks_background_inference_deferrable_when_screen_off() {
        let p = Policy::default();
        let usage = Usage {
            screen_on: false,
            foreground_heavy: false,
            inference_active: true,
        };
        let t = Telemetry::new(BatteryState::on_battery(70.0), usage, None);
        let d = decide(&p, &t, None);
        assert_eq!(d.sensor_mode, SensorMode::Balanced);
        assert!(!d.cap_inference);
        assert!(
            d.throttle_background,
            "background inference with screen off defers"
        );
        assert_eq!(d.reason, Reason::Healthy);
    }

    #[test]
    fn foreground_inference_on_battery_is_not_throttled_when_screen_on() {
        let p = Policy::default();
        let usage = Usage {
            screen_on: true,
            foreground_heavy: false,
            inference_active: true,
        };
        let t = Telemetry::new(BatteryState::on_battery(70.0), usage, None);
        let d = decide(&p, &t, None);
        assert_eq!(d.reason, Reason::Healthy);
        assert!(!d.throttle_background);
    }

    #[test]
    fn decision_display_is_stable_key_value() {
        let d = decide(&Policy::default(), &on_battery(15.0), None);
        let s = d.to_string();
        assert!(s.contains("mode: power_save"), "{s}");
        assert!(s.contains("reason: battery_low"), "{s}");
        assert_eq!(s.lines().count(), 4);
    }

    #[test]
    fn reason_keys_are_unique_and_stable() {
        let keys = [
            Reason::Charging,
            Reason::Healthy,
            Reason::PowerDraw,
            Reason::BatteryLow,
            Reason::BatteryLowHold,
            Reason::BatteryCritical,
            Reason::ThermalHigh,
            Reason::ThermalCritical,
        ];
        let mut seen = std::collections::BTreeSet::new();
        for r in keys {
            assert!(seen.insert(r.key()), "duplicate key for {r:?}");
        }
    }

    #[test]
    fn normalized_policy_orders_levels_and_temps() {
        let bad = Policy::default()
            .with_critical_level(40.0) // above save-on -> normalized down
            .with_save_on_level(30.0)
            .with_save_off_level(10.0) // below save-on -> swapped
            .with_critical_temp(37.0); // below high 38 -> bumped above
        let p = bad.normalized();
        assert!(p.power_save_off_level_pct >= p.power_save_on_level_pct);
        assert!(p.power_save_on_level_pct >= p.critical_level_pct);
        assert!(p.critical_temp_c > p.high_temp_c);
    }

    #[test]
    fn save_rank_orders_modes() {
        assert!(save_rank(SensorMode::PowerSave) > save_rank(SensorMode::Balanced));
        assert!(save_rank(SensorMode::Balanced) > save_rank(SensorMode::Performance));
    }
}
