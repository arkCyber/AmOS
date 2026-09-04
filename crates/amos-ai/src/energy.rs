//! Daemon energy governor (`energy.rs`) — assembly of [`amos_power`].
//!
//! Mirrors `profiler.rs`: a shared store behind an `Arc` that a periodic task
//! ticks and that `get_status` reads into the `StatusReply.energy` wire message.
//! Inputs are env-configured on a host (`AMOS_ENERGY_*`); on a real device a
//! sampler feeds the live battery/thermal HAL instead (the same seam
//! `amos-profiling`'s `PowerSource` describes — `docs/power-policy.md`).
//!
//! Honest labels: the daemon does not measure real power or drive a
//! `SensorManager` here — it *runs the governor* and reports the recommended
//! mode/flags so a UI/supervisor can act on `cap_inference` / `throttle_background`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use amos_power::{BatteryState, Decision, EnergyGovernor, Policy, Telemetry, Usage};

/// A point-in-time governor read (mapped onto the `EnergyPolicy` wire message and
/// the periodic log line).
#[derive(Clone, Copy, Debug)]
pub struct EnergySnapshot {
    /// Recommended mode key: `performance` | `balanced` | `power_save`.
    pub sensor_mode: &'static str,
    /// Stable reason key (`amos_power::Reason::key`); `pending` before the first tick.
    pub reason: &'static str,
    /// Governor recommends capping / deferring inference.
    pub cap_inference: bool,
    /// Governor recommends deferring background work.
    pub throttle_background: bool,
    /// Periodic governor ticks so far (`> 0` ⇒ the governor has run).
    pub ticks: u64,
    // Latest tick's inputs (for diagnostics / an operator reading the log line).
    pub level_pct: Option<f64>,
    pub temperature_c: Option<f64>,
    pub power_mw: Option<f64>,
    pub charging: bool,
    pub screen_on: bool,
    pub inference_active: bool,
}

impl EnergySnapshot {
    /// The not-yet-run baseline: Balanced/healthy, zero ticks.
    pub fn pending() -> Self {
        Self {
            sensor_mode: "balanced",
            reason: "pending",
            cap_inference: false,
            throttle_background: false,
            ticks: 0,
            level_pct: None,
            temperature_c: None,
            power_mw: None,
            charging: false,
            screen_on: true,
            inference_active: false,
        }
    }
}

/// Shared, periodically-ticked energy governor for the daemon.
pub struct EnergyStore {
    governor: Mutex<EnergyGovernor>,
    ticks: AtomicU64,
    last: Mutex<Option<EnergySnapshot>>,
}

impl Default for EnergyStore {
    fn default() -> Self {
        Self::new()
    }
}

impl EnergyStore {
    /// A governor with the default [`Policy`].
    pub fn new() -> Self {
        Self::new_with_policy(Policy::default())
    }

    /// A governor with an explicit [`Policy`].
    pub fn new_with_policy(policy: Policy) -> Self {
        Self {
            governor: Mutex::new(EnergyGovernor::new(policy)),
            ticks: AtomicU64::new(0),
            last: Mutex::new(None),
        }
    }

    /// Run one governor tick on an explicit [`Telemetry`] and remember the result.
    /// Deterministic and env-free — the unit-test entry point.
    pub fn tick_with(&self, telemetry: Telemetry) -> EnergySnapshot {
        let mut gov = self.governor.lock().unwrap_or_else(|p| p.into_inner());
        let d: Decision = gov.observe(&telemetry);
        let ticks = self.ticks.fetch_add(1, Ordering::Relaxed) + 1;
        let snap = snapshot_of(&d, ticks, &telemetry);
        *self.last.lock().unwrap_or_else(|p| p.into_inner()) = Some(snap);
        snap
    }

    /// Run one governor tick on an env-sampled [`Telemetry`] (the periodic-loop /
    /// CLI entry point on a host). See [`telemetry_from_env`].
    pub fn tick_once(&self) -> EnergySnapshot {
        self.tick_with(telemetry_from_env())
    }

    /// Current read: the latest tick, or the "pending" baseline before the first.
    pub fn snapshot(&self) -> EnergySnapshot {
        self.last
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .unwrap_or_else(EnergySnapshot::pending)
    }

    /// Periodically tick the governor and log the decision, on the same cadence as
    /// the health / profile heartbeats. Aborted on shutdown (mirrors the others).
    pub fn spawn_periodic(self: &Arc<Self>, interval: Duration) -> tokio::task::JoinHandle<()> {
        let interval = interval.max(Duration::from_millis(1));
        let store = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            loop {
                ticker.tick().await;
                let s = store.tick_once();
                tracing::info!(
                    sensor_mode = s.sensor_mode,
                    reason = s.reason,
                    cap_inference = s.cap_inference,
                    throttle_background = s.throttle_background,
                    ticks = s.ticks,
                    level_pct = s.level_pct.map(|x| format!("{x:.1}")).unwrap_or_default(),
                    temperature_c = s
                        .temperature_c
                        .map(|x| format!("{x:.1}"))
                        .unwrap_or_default(),
                    power_mw = s.power_mw.map(|x| format!("{x:.1}")).unwrap_or_default(),
                    charging = s.charging,
                    screen_on = s.screen_on,
                    inference_active = s.inference_active,
                    "amos-ai energy governor"
                );
            }
        })
    }
}

/// Fold a decision + the telemetry it came from into an [`EnergySnapshot`].
fn snapshot_of(d: &Decision, ticks: u64, t: &Telemetry) -> EnergySnapshot {
    EnergySnapshot {
        sensor_mode: d.sensor_mode.key(),
        reason: d.reason.key(),
        cap_inference: d.cap_inference,
        throttle_background: d.throttle_background,
        ticks,
        level_pct: t.battery.level_pct,
        temperature_c: t.battery.temperature_c,
        power_mw: t.power_mw,
        charging: t.battery.charging,
        screen_on: t.usage.screen_on,
        inference_active: t.usage.inference_active,
    }
}

/// Sample a [`Telemetry`] for one governor tick from `AMOS_ENERGY_*` environment
/// variables (host/dev). Unset optional readings stay `None` (unknown) — the
/// policy never assumes a healthy battery. Real on-device samplers replace this.
pub fn telemetry_from_env() -> Telemetry {
    let battery = BatteryState {
        level_pct: env_f64("AMOS_ENERGY_LEVEL_PCT"),
        charging: env_flag("AMOS_ENERGY_CHARGING").unwrap_or(false),
        temperature_c: env_f64("AMOS_ENERGY_TEMP_C"),
    };
    let usage = Usage {
        screen_on: env_flag("AMOS_ENERGY_SCREEN_ON").unwrap_or(true),
        foreground_heavy: env_flag("AMOS_ENERGY_FOREGROUND_HEAVY").unwrap_or(false),
        inference_active: env_flag("AMOS_ENERGY_INFERENCE_ACTIVE").unwrap_or(false),
    };
    Telemetry::new(battery, usage, env_f64("AMOS_ENERGY_POWER_MW"))
}

/// Parse an optional float env var; garbage / empty → `None`.
fn env_f64(key: &str) -> Option<f64> {
    std::env::var(key).ok().and_then(|v| v.parse::<f64>().ok())
}

/// Parse an optional bool env var (`1`/`true`/`yes` → true); empty → `Some(false)`.
fn env_flag(key: &str) -> Option<bool> {
    std::env::var(key).ok().map(|v| {
        matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(level: f64) -> Telemetry {
        Telemetry::new(BatteryState::on_battery(level), Usage::default(), None)
    }

    #[test]
    fn pending_snapshot_before_any_tick() {
        let s = EnergyStore::new();
        let snap = s.snapshot();
        assert_eq!(snap.ticks, 0);
        assert_eq!(snap.reason, "pending");
        assert_eq!(snap.sensor_mode, "balanced");
    }

    #[test]
    fn tick_records_mode_reason_and_counts() {
        let s = EnergyStore::new();
        // 15 % on battery → PowerSave / battery_low.
        let a = s.tick_with(t(15.0));
        assert_eq!(a.ticks, 1);
        assert_eq!(a.sensor_mode, "power_save");
        assert_eq!(a.reason, "battery_low");
        assert!(a.cap_inference && a.throttle_background);
        // Healthy charge later → balanced / healthy; ticks increment.
        let b = s.tick_with(t(70.0));
        assert_eq!(b.ticks, 2);
        assert_eq!(b.sensor_mode, "balanced");
        assert_eq!(b.reason, "healthy");
        assert_eq!(s.snapshot().ticks, 2);
    }

    #[test]
    fn charging_decision_is_performance() {
        let s = EnergyStore::new();
        let snap = s.tick_with(Telemetry::new(
            BatteryState::charging(50.0),
            Usage::default(),
            None,
        ));
        assert_eq!(snap.sensor_mode, "performance");
        assert_eq!(snap.reason, "charging");
    }

    #[test]
    fn telemetry_from_env_parses_numbers_and_flags() {
        // SAFETY: these tests run single-threaded w.r.t. env by convention; we set
        // only AMOS_ENERGY_* keys that no other test reads, so no cross-test race.
        std::env::set_var("AMOS_ENERGY_LEVEL_PCT", "12.5");
        std::env::set_var("AMOS_ENERGY_CHARGING", "1");
        std::env::set_var("AMOS_ENERGY_TEMP_C", "41.0");
        std::env::set_var("AMOS_ENERGY_POWER_MW", "5200");
        let t = telemetry_from_env();
        assert_eq!(t.battery.level_pct, Some(12.5));
        assert!(t.battery.charging);
        assert_eq!(t.battery.temperature_c, Some(41.0));
        assert_eq!(t.power_mw, Some(5200.0));
        std::env::remove_var("AMOS_ENERGY_LEVEL_PCT");
        std::env::remove_var("AMOS_ENERGY_CHARGING");
        std::env::remove_var("AMOS_ENERGY_TEMP_C");
        std::env::remove_var("AMOS_ENERGY_POWER_MW");
    }
}
