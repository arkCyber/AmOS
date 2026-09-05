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

/// One instantaneous battery reading: the current being drawn (`current_ua`, µA)
/// at the terminal voltage it is drawn at (`voltage_mv`, mV).
///
/// This is the raw pair every battery telemetry source provides on-device —
/// Android's `BatteryManager#getLongProperty(BATTERY_PROPERTY_CURRENT_NOW)` and
/// the sticky `ACTION_BATTERY_CHANGED` `EXTRA_VOLTAGE`. The physical conversion
/// `power_mW = current_µA × voltage_mV / 1e6` lives here as a platform-neutral,
/// host-testable pure value so the Android HAL seam (`crate::android`, a
/// feature-gated module) and any future PMIC / simulator backend share one honest
/// math instead of each re-implementing it with a hard-coded nominal voltage.
///
/// It deliberately does **not** fabricate a reading: an absent / errored
/// property yields `0`/negative and [`BatterySample::is_valid`] reports `false`
/// (honest "unknown"), so a caller can refuse to report a power draw rather than
/// trust a corrupt one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BatterySample {
    /// Instantaneous current draw in microamps (µA).
    pub current_ua: i64,
    /// Battery terminal voltage in millivolts (mV).
    pub voltage_mv: i64,
}

impl BatterySample {
    /// A raw sample exactly as read off the battery, unsanitised.
    pub const fn new(current_ua: i64, voltage_mv: i64) -> Self {
        Self {
            current_ua,
            voltage_mv,
        }
    }

    /// Whether both halves of the reading are *present* (`> 0`). `0` / negative
    /// is how a failed/unsupported battery-property read reports itself, so this
    /// is the "can I trust this sample?" gate.
    pub const fn is_valid(&self) -> bool {
        self.current_ua > 0 && self.voltage_mv > 0
    }

    /// Instantaneous board power in milliwatts (`current_µA × voltage_mV / 1e6`).
    /// `0.0` when the sample is invalid — matching the crate-wide honesty that a
    /// `0.0` power draw means "unavailable", never a fabricated number.
    ///
    /// Widening to `f64` before multiplying keeps a large-but-valid raw pair from
    /// overflowing `i64`; the values a real PMIC reports are far from the edge.
    pub fn power_mw(&self) -> f64 {
        if !self.is_valid() {
            return 0.0;
        }
        (self.current_ua as f64) * (self.voltage_mv as f64) / 1_000_000.0
    }
}

/// Average board power (mW) over a run, aggregated from the instantaneous
/// [`BatterySample`]s a caller read across the measurement window (e.g. once at
/// the start / end, or spread through an inference run).
///
/// A single instantaneous read is noisy and skew-prone; averaging the same
/// physical `current × voltage` pair over the window is the honest mean that a
/// `Power × time` estimate ([`energy_joules`] → `ProfileReport.est_energy_j`)
/// should consume. Invalid / "unknown" samples (`!is_valid()`, e.g. a property
/// read that errored) are ignored rather than counted as `0` W, and `None` is
/// returned when there is no valid sample at all — so a caller never fabricates
/// an energy number out of a noisy or empty window.
pub fn mean_power_mw(samples: &[BatterySample]) -> Option<f64> {
    let mut sum = 0.0;
    let mut valid = 0u32;
    for s in samples {
        if s.is_valid() {
            sum += s.power_mw();
            valid += 1;
        }
    }
    if valid == 0 {
        None
    } else {
        Some(sum / f64::from(valid))
    }
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

    #[test]
    fn battery_sample_power_is_voltage_times_current() {
        // Real-ish LLM decode burst: 1.2 A @ 3.9 V → 4680 mW.
        let s = BatterySample::new(1_200_000, 3900);
        assert!(s.is_valid());
        let mw = s.power_mw();
        assert!((mw - 4680.0).abs() < 1e-9, "{mw}");
        // µA × mV is unit-correct: 100 µA @ 3700 mV → 0.37 mW.
        let idle = BatterySample::new(100, 3700);
        assert!((idle.power_mw() - 0.37).abs() < 1e-9);
    }

    #[test]
    fn battery_sample_invalid_is_zero_not_fabricated() {
        // A property read that errored reports <= 0 — that is "unknown".
        assert!(!BatterySample::new(0, 3900).is_valid());
        assert!(!BatterySample::new(-5, 3900).is_valid());
        assert!(!BatterySample::new(1_000_000, 0).is_valid());
        assert_eq!(BatterySample::new(0, 3900).power_mw(), 0.0);
        assert_eq!(BatterySample::new(1_000_000, 0).power_mw(), 0.0);
    }

    #[test]
    fn battery_sample_large_pair_does_not_overflow() {
        // Widening to f64 keeps a big-but-plausible pair from overflowing i64.
        let s = BatterySample::new(i64::MAX, 5000);
        assert!(s.is_valid());
        assert!(s.power_mw() > 0.0 && s.power_mw().is_finite());
    }

    #[test]
    fn mean_power_averages_valid_samples_over_a_window() {
        // 1.0 A @ 4.0 V = 4 W, then 0.5 A @ 4.0 V = 2 W → mean 3 W.
        let s = [
            BatterySample::new(1_000_000, 4000),
            BatterySample::new(500_000, 4000),
        ];
        let m = mean_power_mw(&s).expect("valid samples");
        assert!((m - 3000.0).abs() < 1e-9, "{m}");
    }

    #[test]
    fn mean_power_ignores_unknown_samples_and_is_none_when_all_unknown() {
        // An errored property read (<= 0) is "unknown", never a 0 W sample.
        let mixed = [
            BatterySample::new(1_000_000, 4000), // 4 W
            BatterySample::new(0, 4000),         // invalid -> ignored
            BatterySample::new(2_000_000, 4000), // 8 W
        ];
        let m = mean_power_mw(&mixed).expect("one valid remains");
        assert!((m - 6000.0).abs() < 1e-9, "{m}"); // (4 + 8) / 2
                                                   // All unknown / empty -> None (no fabricated energy).
        assert_eq!(mean_power_mw(&[BatterySample::new(0, 0)]), None);
        assert_eq!(mean_power_mw(&[]), None);
    }

    #[test]
    fn mean_power_feeds_energy_estimate() {
        // Mean 3 W over 2 s → 6 J.
        let samples = [
            BatterySample::new(1_000_000, 4000),
            BatterySample::new(500_000, 4000),
        ];
        let mw = mean_power_mw(&samples).unwrap();
        let wall = Duration::from_secs(2);
        let j = energy_joules(mw, wall);
        assert!((j - 6.0).abs() < 1e-9, "{j}");
    }
}
