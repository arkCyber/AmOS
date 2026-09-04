//! Power / energy seam: an average-power [`PowerSource`] (battery-monitor HAL on
//! a device, deterministic mock on the host) and the wall-time → energy math.
//!
//! Energy is estimated as `power × time`: on-device we read the averaged board
//! power draw (mA × voltage, or a per-crate mW figure from the power HAL) while
//! inference runs, and multiply by the measured wall time of that run.

use std::time::Duration;

/// The seam to a source of average board-power readings (mW).
///
/// A real backend would sample the Android battery/power HAL (current + voltage)
/// over the window; the mock returns whatever constant the harness set. Like
/// `amos-sensor`'s providers this is deliberately dumb — it just answers
/// "what was the average power draw over the last measurement window?".
pub trait PowerSource: Send + Sync {
    /// Name of the backend (for reports / logs).
    fn name(&self) -> &'static str;
    /// Average board power draw over the last window, in milliwatts.
    fn average_power_mw(&self) -> f64;
}

/// Deterministic [`PowerSource`] returning a fixed average power draw.
#[derive(Clone, Copy, Debug)]
pub struct MockPowerSource {
    pub mw: f64,
}

impl MockPowerSource {
    pub fn new(mw: f64) -> Self {
        Self { mw }
    }
}

impl PowerSource for MockPowerSource {
    fn name(&self) -> &'static str {
        "mock"
    }

    fn average_power_mw(&self) -> f64 {
        self.mw
    }
}

/// Energy in joules consumed while drawing a constant `power_mw` for `wall`.
///
/// `joules = (power_mW / 1000) × seconds`. A zero-duration window always yields
/// `0.0`; a non-finite power reading yields `f64::NAN` so callers can treat it
/// as "unknown" rather than silently trusting a corrupt reading.
pub fn energy_joules(power_mw: f64, wall: Duration) -> f64 {
    (power_mw / 1000.0) * wall.as_secs_f64()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_power_returns_configured_mw() {
        let p = MockPowerSource::new(4000.0);
        assert_eq!(p.name(), "mock");
        assert_eq!(p.average_power_mw(), 4000.0);
    }

    #[test]
    fn energy_is_power_times_time() {
        // 4 W for 2.15 s → 8.6 J.
        let j = energy_joules(4000.0, Duration::from_millis(2150));
        assert!((j - 8.6).abs() < 1e-9, "{j}");
        // Zero time → zero energy.
        assert_eq!(energy_joules(9000.0, Duration::ZERO), 0.0);
        // Corrupt power propagates as NaN (caller treats it as unknown).
        assert!(energy_joules(f64::NAN, Duration::from_secs(1)).is_nan());
    }
}
