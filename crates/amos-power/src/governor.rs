//! [`EnergyGovernor`] — a thin, stateful ticker over the pure rule engine.
//!
//! The rule itself is a pure function ([`decide`](crate::decide)); a real
//! scheduler polls once per cadence and wants the previous decision carried in for
//! hysteresis. [`EnergyGovernor`] stores exactly that and exposes `observe(&Telemetry)
//! -> Decision`, returning the fresh decision each tick (deterministic given the
//! input sequence — no wall clock is involved).

use amos_sensor::SensorMode;

use crate::policy::{decide, Decision, Policy};
use crate::types::Telemetry;

/// A periodic energy-governor: remembers the last [`Decision`] (for hysteresis)
/// and hands back a fresh one per [`observe`](EnergyGovernor::observe).
///
/// This is the object a daemon / System-UI task polls every few seconds: it
/// samples [`Telemetry`], calls [`observe`](EnergyGovernor::observe), logs the
/// [`Decision`], and applies it (e.g. [`Decision::apply_to`] a
/// [`SensorManager`](amos_sensor::SensorManager), gating an in-flight inference
/// on [`Decision::cap_inference`], deferring background work on
/// [`Decision::throttle_background`]).
pub struct EnergyGovernor {
    policy: Policy,
    last: Option<Decision>,
}

impl EnergyGovernor {
    /// A governor with the given [`Policy`].
    pub fn new(policy: Policy) -> Self {
        Self { policy, last: None }
    }

    /// The tuned policy (read thresholds / clone to inspect).
    pub fn policy(&self) -> &Policy {
        &self.policy
    }

    /// The previous tick's decision, if any.
    pub fn last_decision(&self) -> Option<Decision> {
        self.last
    }

    /// The last *applied* mode, if a tick has run yet.
    pub fn mode(&self) -> Option<SensorMode> {
        self.last.map(|d| d.sensor_mode)
    }

    /// Run one tick on `t` and return the fresh decision. The previous decision
    /// is carried into the pure rule so low-battery / thermal hysteresis holds
    /// across successive polls.
    pub fn observe(&mut self, t: &Telemetry) -> Decision {
        let d = decide(&self.policy, t, self.last.as_ref());
        self.last = Some(d);
        d
    }
}

impl Default for EnergyGovernor {
    fn default() -> Self {
        Self::new(Policy::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::Reason;
    use crate::types::{BatteryState, Telemetry, Usage};

    fn t(level: f64, charging: bool) -> Telemetry {
        let battery = if charging {
            BatteryState::charging(level)
        } else {
            BatteryState::on_battery(level)
        };
        Telemetry::new(battery, Usage::default(), None)
    }

    #[test]
    fn observe_returns_decision_and_remembers_it() {
        let mut g = EnergyGovernor::default();
        assert_eq!(g.last_decision(), None);
        let d = g.observe(&t(15.0, false)); // low battery -> PowerSave
        assert_eq!(d.sensor_mode, SensorMode::PowerSave);
        assert_eq!(g.mode(), Some(SensorMode::PowerSave));
        assert_eq!(g.last_decision(), Some(d));
    }

    #[test]
    fn observe_chains_hysteresis_across_ticks() {
        let mut g = EnergyGovernor::default();
        // Enter PowerSave at 18%.
        assert_eq!(
            g.observe(&t(18.0, false)).sensor_mode,
            SensorMode::PowerSave
        );
        // Recovery to 25% is still below the 30 exit -> governor holds PowerSave
        // (the "hold" only happens because observe() passes the last decision in).
        assert_eq!(g.observe(&t(25.0, false)).reason, Reason::BatteryLowHold);
        assert_eq!(g.mode(), Some(SensorMode::PowerSave));
        // Above the exit band -> Balanced, then charging -> Performance.
        assert_eq!(g.observe(&t(35.0, false)).sensor_mode, SensorMode::Balanced);
        assert_eq!(
            g.observe(&t(50.0, true)).sensor_mode,
            SensorMode::Performance
        );
    }

    #[test]
    fn default_policy_is_sane() {
        let g = EnergyGovernor::default();
        // on/off/critical are ordered and in 0..=100.
        let p = g.policy().normalized();
        assert!(p.power_save_off_level_pct >= p.power_save_on_level_pct);
        assert!(p.power_save_on_level_pct >= p.critical_level_pct);
        assert!(p.critical_temp_c > p.high_temp_c);
    }
}
