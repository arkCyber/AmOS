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

/// The current half of a sample from a raw
/// `BatteryManager#getLongProperty(CURRENT_NOW)` answer (µA).
///
/// Encodes two platform facts that a naive `raw > 0` check gets wrong
/// (REQ-A1449/F-PWR-001):
///
/// * `getLongProperty` answers **`Long.MIN_VALUE`** for a property the device does *not*
///   support. That is "unavailable", so it maps to `None`, never to a reading.
/// * `CURRENT_NOW` is **signed by convention**: positive is net current *into* the
///   battery, negative is current *out of* it. A phone under a heavy LLM load is
///   discharging, so the honest reading is negative — and the old `raw > 0` gate
///   turned the exact case this crate exists to measure into "unknown"
///   (`power_mw() == 0.0`).
///
/// This crate reports *draw* as a magnitude, so the sign is dropped here. The charging
/// direction is a separate fact owned by `amos-power`'s charge-status telemetry, not a
/// sign to reconstruct from a current read.
/// Only the Android HAL seam (`crate::android`, behind `feature = "android"`) and this
/// module's own tests call this, so it is dead in a default lib build — gate it rather
/// than leave a `-D warnings` failure behind (the seam still compiles under `--features
/// amos-profiling/android`, which is where `android.rs` is built).
#[cfg(any(test, feature = "android"))]
pub(crate) const fn current_ua_from_property(raw: i64) -> Option<i64> {
    if raw == i64::MIN {
        None
    } else if raw < 0 {
        Some(-raw)
    } else {
        Some(raw)
    }
}

/// Where a [`BatterySample`]'s voltage came from.
///
/// The current half is always measured (`BatteryManager#getLongProperty`), but the voltage
/// half has two sources on this platform: the live terminal voltage from the sticky
/// `ACTION_BATTERY_CHANGED` `EXTRA_VOLTAGE`, or — when that broadcast is absent — a
/// **nominal** Li-ion value. The two are not interchangeable in a report: `mW` from a
/// nominal voltage is an *estimate* built on an assumed input, and this crate's rule is
/// that an estimate is never published as a measurement (REQ-A1449 / F-PWR-001). Recording
/// which one produced the number is what lets [`mean_power_mw`] keep an assumed input out
/// of the averaged figure that becomes `ProfileReport::est_energy_j`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoltageSource {
    /// The live terminal voltage (`EXTRA_VOLTAGE`) — the power is a measurement.
    Measured,
    /// A nominal fallback voltage, used only because no live reading was available — the
    /// power is an estimate over an assumed input.
    NominalFallback,
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
    /// Whether `voltage_mv` is a live reading or the nominal fallback (see
    /// [`VoltageSource`]).
    pub voltage_source: VoltageSource,
}

impl BatterySample {
    /// A raw sample exactly as read off the battery, unsanitised — both halves **measured**.
    pub const fn new(current_ua: i64, voltage_mv: i64) -> Self {
        Self {
            current_ua,
            voltage_mv,
            voltage_source: VoltageSource::Measured,
        }
    }

    /// A sample whose voltage is the caller's **nominal fallback** rather than a live
    /// reading — the current is still measured, the voltage is assumed.
    ///
    /// Kept distinct from [`new`](Self::new) so the assumption travels with the number:
    /// [`mean_power_mw`] leaves these out of the average that becomes a published energy
    /// figure, while `power_mw()` still answers for a caller that wants the estimate.
    pub const fn with_nominal_voltage(current_ua: i64, voltage_mv: i64) -> Self {
        Self {
            current_ua,
            voltage_mv,
            voltage_source: VoltageSource::NominalFallback,
        }
    }

    /// Whether this sample's voltage is a live reading (its power is a measurement).
    pub const fn voltage_is_measured(&self) -> bool {
        matches!(self.voltage_source, VoltageSource::Measured)
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
///
/// A sample whose voltage is the **nominal fallback** ([`VoltageSource::NominalFallback`])
/// is excluded for the same reason, and this is the one place the distinction is
/// load-bearing: the mean is what a `ProfileReport` publishes as `est_energy_j`, and a
/// figure averaged from an *assumed* 3700 mV is an estimate wearing a measurement's
/// clothes (REQ-A1449 / F-PWR-001). `power_mw()` still answers for such a sample, so a
/// caller that *wants* the estimate can read it off the sample directly — it is only the
/// aggregated, published number that refuses to mix the two. `None` when no sample has a
/// measured voltage.
pub fn mean_power_mw(samples: &[BatterySample]) -> Option<f64> {
    let mut sum = 0.0;
    let mut valid = 0u32;
    for s in samples {
        if s.is_valid() && s.voltage_is_measured() {
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
    fn a_nominal_voltage_sample_is_excluded_from_the_published_mean() {
        // 1 A at a *live* 4.0 V is a measurement; 1 A at a *nominal* 4.0 V is an estimate over
        // an assumed input. The mean that becomes `est_energy_j` may only average the first.
        let measured = BatterySample::new(1_000_000, 4000);
        let estimated = BatterySample::with_nominal_voltage(1_000_000, 4000);
        assert!(
            estimated.is_valid(),
            "the current is real, so the pair is usable"
        );
        assert!(!estimated.voltage_is_measured());
        assert!(
            (estimated.power_mw() - 4000.0).abs() < 1e-9,
            "the estimate is still answerable"
        );

        let mixed = [measured, estimated];
        let m = mean_power_mw(&mixed).expect("one measured sample remains");
        assert!(
            (m - 4000.0).abs() < 1e-9,
            "the estimate must not drag the mean: {m}"
        );

        // No measured voltage anywhere ⇒ no published power at all (never a fabricated 0 W or a
        // nominal-voltage number presented as a reading).
        assert_eq!(mean_power_mw(&[estimated]), None);
    }

    #[test]
    fn a_measured_sample_stays_in_the_mean() {
        // The negative control for the exclusion: `new` is the measured constructor, so a plain
        // pair must still average (a rule that excluded everything would also pass `None` checks).
        let s = [BatterySample::new(1_000_000, 4000)];
        assert!(s[0].voltage_is_measured());
        assert_eq!(mean_power_mw(&s), Some(4000.0));
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
    fn current_property_sentinel_is_unavailable_not_a_reading() {
        // `getLongProperty` answers Long.MIN_VALUE for an unsupported property.
        assert_eq!(current_ua_from_property(i64::MIN), None);
    }

    #[test]
    fn discharging_current_is_a_real_draw_not_unknown() {
        // The sign convention: negative = current out of the battery. A phone under load
        // is discharging, so this was exactly the value the old `raw > 0` gate discarded
        // (REQ-A1449/F-PWR-001).
        assert_eq!(current_ua_from_property(-1_200_000), Some(1_200_000));
        // ...and the magnitude feeds the same mW math as a positive read: 1.2 A @ 3.9 V.
        let s = BatterySample::new(current_ua_from_property(-1_200_000).unwrap(), 3900);
        assert!(s.is_valid());
        assert!((s.power_mw() - 4680.0).abs() < 1e-9, "{}", s.power_mw());
    }

    #[test]
    fn charging_current_keeps_its_magnitude_and_zero_stays_unknown() {
        assert_eq!(current_ua_from_property(500_000), Some(500_000));
        // A true zero is still "no measurable current": `is_valid` stays false, so the
        // crate reports "unavailable" rather than a fabricated 0 W (unchanged contract).
        assert_eq!(current_ua_from_property(0), Some(0));
        assert!(!BatterySample::new(0, 3900).is_valid());
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
