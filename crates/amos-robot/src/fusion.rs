//! IMU attitude fusion — one estimator, with the evidence for what it used.
//!
//! The problem this solves: an IMU gives angular rate (which integrates cleanly but
//! drifts) and acceleration (which is absolute in the long run but useless whenever the
//! body accelerates). An attitude estimator is the only place where "how much do I trust
//! each" is decided, so *that decision* is what this module makes observable instead of
//! hiding it behind one angle:
//!
//! | what the caller gets | why it is a separate field |
//! |---|---|
//! | [`Attitude::correction`] = `Applied` / `GyroOnly { reason }` | during free fall or hard acceleration gravity is **not separable** from body acceleration. The estimator then integrates the gyro only — and says so, so a consumer can widen its uncertainty instead of trusting a roll that is quietly drifting |
//! | [`Attitude::yaw_reference`] | a 6-axis unit **cannot observe yaw**. Reporting an integrated angle as a heading is the classic defect; the field stays `DeadReckoned` until the yaw is actually referenced to something external — [`AttitudeEstimator::set_heading`] for a manual heading, or a magnetometer-accepted step in [`AttitudeEstimator::update_with_mag`], which sets it to `Magnetic` |
//! | [`AttitudeEstimator::gyro_correction_rad_s`] | the bias the estimator learned. A correction that stays at zero while the attitude tracks gravity means the two are fighting, not agreeing |
//!
//! The algorithm is Mahony's 6-DOF complementary filter on a quaternion (`ki` turns the
//! proportional correction into a gyro-bias estimate), with the conventions written down
//! at [`ImuSample`]: SI units, body frame *x* forward / *y* right / *z* up, and an
//! accelerometer that reads **+1 g along its own up axis at rest** — the sign a holder on
//! a table produces, and the one Mahony's `v = 2·halfv` derivation assumes.
//!
//! Honest boundaries (registered in `docs/robot-autonomy.md`, not hidden):
//!
//! 1. **6-DOF by default, no covariance**: yaw is dead-reckoned unless the caller supplies a
//!    heading — manually via [`AttitudeEstimator::set_heading`], or from a magnetometer via
//!    [`AttitudeEstimator::update_with_mag`] (the 9-DOF extension below, which promotes
//!    [`YawReference`] to `Magnetic`) — and even then the estimator does not model the
//!    reference's own noise. (An earlier revision of this boundary said "no magnetometer";
//!    the 9-DOF path shipped, so that sentence is gone — REQ-A678.)
//! 2. **No linear-acceleration compensation**: a body in a sustained coordinated turn is
//!    rejected by [`AccelRejection::NotGravity`] — at 1 g of lateral acceleration a level
//!    turn is indistinguishable from a tilt *by construction* — rather than modelled.
//! 3. **Not a filter with a covariance**: there is no Kalman state, so there is no honest
//!    variance to publish. That is exactly why the output is a category
//!    ([`GravityCorrection`]) rather than a σ: an EKF/UKF belongs here once it can also
//!    publish the covariance it claims.
//! 4. **The conventions are the default ones, not the only ones**: a body whose IMU is
//!    mounted rotated needs that rotation applied **before** this module — a mount matrix
//!    is calibration, and calibration belongs to the deployment.
//! 5. **`Ki` learns a *bias*, not a step**: the integral term is tuned for the slow error a
//!    real gyro bias produces. A large one-off attitude error (a filter reset onto an
//!    already-tilted body, a step disturbance) is read as a bias and overshoots. Set
//!    `ki = 0` via [`AttitudeEstimator::with_gains`] for a pure proportional
//!    (complementary) response — which is what a caller that re-acquires from gravity
//!    every frame wants anyway.
//! 6. **Yaw absorbs part of the gravity correction**: the correction is a rotation that
//!    takes the estimated gravity direction onto the measured one, and that geodesic is
//!    *not* a rotation about body *z* when roll and pitch are both non-zero. A few degrees
//!    of apparent yaw motion during a long roll/pitch transient is therefore expected
//!    behaviour of an unreferenced yaw, not a bug: the honest response is the
//!    [`YawReference`] field, not a claim that yaw held still (measured: **3.33°** over a
//!    6 s recovery from a 25°/15° step, **proportional-only** — `with_gains(1.0, 0.0)`.
//!    The default `Ki` learns a spurious bias through the same transient and gives
//!    3.62° instead, so the figure is a property of that gain choice, not of the leak:
//!    `a_skewed_gravity_correction_moves_the_unreferenced_yaw` pins the `Ki = 0` case).
//!
//! ```no_run
//! use amos_robot::fusion::{AttitudeEstimator, ImuSample, STANDARD_GRAVITY_M_S2, YawReference};
//!
//! # fn main() -> Result<(), amos_robot::fusion::FusionError> {
//! let mut estimator = AttitudeEstimator::new();
//! // At rest, level: the accelerometer reads +1 g along body z.
//! let sample = ImuSample::new([0.0, 0.0, STANDARD_GRAVITY_M_S2], [0.0, 0.0, 0.0]);
//! let attitude = estimator.update(&sample, 1.0 / 200.0)?;
//! assert!(attitude.roll_rad.abs() < 1e-3, "level means level");
//! assert_eq!(attitude.yaw_reference, YawReference::DeadReckoned);
//! # Ok(())
//! # }
//! ```

use std::f32::consts::PI;

/// Standard gravity, in m/s² (the constant the acceptance window is scaled by).
// cited: ISO 80000-3 / CGPM standard gravity, 9.80665 m/s².
pub const STANDARD_GRAVITY_M_S2: f32 = 9.806_65;

/// Longest step counted as *continuous* integration, in seconds.
///
/// A gap longer than this is refused ([`FusionError::Gap`]) rather than integrated: after
/// a stall the attitude is unknown, and a filter that silently bridges it reports a
/// confidence it did not earn. 250 ms is an order of magnitude above a 200 Hz IMU's step
/// (5 ms) and five times the shortest deadman in the profile table (50 ms).
pub const MAX_DT_S: f32 = 0.25;

/// Smallest acceleration norm accepted as *gravity*, in g.
pub const ACCEL_MIN_G: f32 = 0.75;

/// Largest acceleration norm accepted as *gravity*, in g.
pub const ACCEL_MAX_G: f32 = 1.25;

/// At or below this norm the sensor is read as weightless (free fall / unpowered), in g.
const WEIGHTLESS_G: f32 = 0.1;

/// Default proportional gain of the gravity correction (`Kp`), in 1/s: an attitude error
/// of `e` rad produces a correction rate `Kp · e` rad/s, so the loop closes in ~`1/Kp` s.
// cited: Mahony, Hamel & Pflimlin (2008), "Nonlinear complementary filters on the special
// orthogonal group" — the *algorithm* (this correction law, and its `Kp`/`Ki` roles) is
// that paper's. The **value** `1.0` is `// chosen:` by this crate; the paper fixes only
// `Kp > 0`, and the "~1 s" figure above is a restatement of `1/Kp`, not a paper number.
const DEFAULT_KP: f32 = 1.0;

/// Default integral gain (`Ki`), in 1/s²: it turns the leftover error into a gyro-bias
/// estimate, which is what lets a long hover hold an attitude instead of drifting.
// chosen: **not cited and not measured.** An earlier `// cited:` marker attributed "a
// `Kp:Ki` ratio near 20 decouples the bias estimate from the attitude loop" to Mahony,
// Hamel & Pflimlin (2008). That paper gives the bias estimator and its stability
// condition (`Ki > 0`) but **no numeric ratio**; published implementations of the same
// algorithm pick far larger ratios (e.g. `Kp = 2, Ki = 0.005`, a ratio of 400). The `20`
// here is simply **this crate's own** `DEFAULT_KP / DEFAULT_KI = 1.0 / 0.05` — a ratio,
// not a quoted figure, and a deployment tunes it (see `AttitudeEstimator::with_gains`).
const DEFAULT_KI: f32 = 0.05;

/// One inertial sample, in SI units.
///
/// **Units and frame are part of the contract**, because a fusion module fed in g and
/// deg/s produces a plausible, wrong attitude:
///
/// * `accel_m_s2` — specific force in the body frame, *x* forward, *y* right, *z* up. At
///   rest it is the reaction to gravity, so a level unit reads `[0, 0, +9.81]`.
/// * `gyro_rad_s` — angular rate about the body axes (*not* Euler rates: the estimator
///   rotates the quaternion with this vector directly, which is what makes it exact for
///   large angles where an Euler-angle complementary filter is not).
///
/// These are `amos-sensor`'s wire units (`accel_m_s2` / `gyro_rad_s`), so a sample goes
/// from the sensor service to this type without a conversion that could be forgotten.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImuSample {
    /// Specific force, body frame, m/s².
    pub accel_m_s2: [f32; 3],
    /// Angular rate, body frame, rad/s.
    pub gyro_rad_s: [f32; 3],
}

impl ImuSample {
    /// A sample from its two triples.
    pub fn new(accel_m_s2: [f32; 3], gyro_rad_s: [f32; 3]) -> Self {
        Self {
            accel_m_s2,
            gyro_rad_s,
        }
    }

    /// True when every axis is finite (the estimator refuses anything else).
    ///
    /// ```no_run
    /// use amos_robot::fusion::ImuSample;
    ///
    /// assert!(ImuSample::new([0.0, 0.0, 9.81], [0.0, 0.0, 0.0]).is_finite());
    /// assert!(!ImuSample::new([f32::NAN, 0.0, 9.81], [0.0, 0.0, 0.0]).is_finite());
    /// ```
    pub fn is_finite(&self) -> bool {
        self.accel_m_s2.iter().all(|v| v.is_finite())
            && self.gyro_rad_s.iter().all(|v| v.is_finite())
    }

    /// The acceleration norm, in m/s² — `0.0` for a non-finite sample, which callers
    /// reject first via [`ImuSample::is_finite`].
    fn accel_norm_m_s2(&self) -> f32 {
        let [x, y, z] = self.accel_m_s2;
        if !(x.is_finite() && y.is_finite() && z.is_finite()) {
            return 0.0;
        }
        (x * x + y * y + z * z).sqrt()
    }
}

/// Why the accelerometer could **not** be used as a gravity reference on one update.
///
/// A rejection is not an error: an accelerating robot is a normal robot. It is a statement
/// about evidence, and the attitude is still produced (from the gyro).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccelRejection {
    /// The norm is at or below `0.1 g`: free fall, a dropped sensor, or an unpowered one.
    /// Gravity cannot be read from an accelerometer that is not being held by it.
    Weightless,
    /// The norm is outside `0.75..=1.25 g`: the body is accelerating, and body
    /// acceleration is indistinguishable from gravity in a single sample.
    NotGravity,
}

impl AccelRejection {
    /// Stable key, for logs and for a UI that renders the reason.
    pub fn key(self) -> &'static str {
        match self {
            AccelRejection::Weightless => "weightless",
            AccelRejection::NotGravity => "not-gravity",
        }
    }
}

/// Whether gravity was available to correct roll/pitch on one update.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GravityCorrection {
    /// **No update has been integrated yet**: there is no evidence either way, and that is
    /// a third state rather than a very confident zero. `Unknown` is never read as
    /// "healthy" anywhere else in this workspace and it is not read as "referenced" here.
    Unobserved,
    /// The accelerometer read ~1 g and was used: roll/pitch are referenced to gravity,
    /// which is what stops them from drifting.
    Applied,
    /// The accelerometer was unusable, so the gyro was integrated alone. Roll/pitch drift
    /// until the next [`GravityCorrection::Applied`]; the caller should treat the angles
    /// as an extrapolation, not as a reference.
    GyroOnly {
        /// Which check rejected the sample.
        reason: AccelRejection,
    },
}

/// What the yaw angle is referenced to.
///
/// The distinction is the difference between a compass and a stopwatch. A 6-DOF estimator
/// has no yaw observation at all, so its yaw is an integral of the gyro (biased, drifting
/// without bound); calling that a "heading" is the defect this enum exists to prevent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum YawReference {
    /// No external heading has been supplied since the last reset: yaw is dead-reckoned
    /// and drifts. Render it as a *relative* angle, never as a bearing.
    DeadReckoned,
    /// [`AttitudeEstimator::set_heading`] was called at least once since the last reset:
    /// yaw's error is bounded by that reference's own error, not by the gyro alone.
    Referenced,
    /// A magnetometer supplied a heading on the most recent [`AttitudeEstimator::update_with_mag`]
    /// call. Distinct from `Referenced` because a magnetometer is a sensor with its own
    /// noise model, not a manual override.
    Magnetic,
}

/// The estimated orientation, plus what the estimate rests on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Attitude {
    /// Roll (rotation about body *x*), radians, wrapped to `(-π, π]`.
    pub roll_rad: f32,
    /// Pitch (rotation about body *y*), radians, wrapped to `(-π, π]`.
    pub pitch_rad: f32,
    /// Yaw (rotation about body *z*), radians, wrapped to `(-π, π]`. Read
    /// [`Attitude::yaw_reference`] before using it as a direction.
    pub yaw_rad: f32,
    /// What yaw means ([`YawReference`]).
    pub yaw_reference: YawReference,
    /// Whether gravity corrected this update ([`GravityCorrection`]) — the field that says
    /// whether `roll_rad`/`pitch_rad` are a reference or an extrapolation.
    pub correction: GravityCorrection,
    /// Total time integrated since construction/reset, seconds. A consumer that wants to
    /// bound drift needs elapsed time, not a sample count.
    pub integrated_s: f32,
}

impl Attitude {
    /// True when the roll/pitch half of this estimate is referenced to gravity.
    ///
    /// ```no_run
    /// use amos_robot::fusion::{AttitudeEstimator, ImuSample};
    ///
    /// # fn main() -> Result<(), amos_robot::fusion::FusionError> {
    /// let mut estimator = AttitudeEstimator::new();
    /// // 2 g of specific force: the body is accelerating, so gravity is not readable.
    /// let pushing = ImuSample::new([0.0, 0.0, 19.6], [0.0, 0.0, 0.0]);
    /// let attitude = estimator.update(&pushing, 0.005)?;
    /// assert!(!attitude.is_gravity_referenced());
    /// # Ok(())
    /// # }
    /// ```
    pub fn is_gravity_referenced(&self) -> bool {
        self.correction == GravityCorrection::Applied
    }

    /// One line an operator can read — including what the numbers are *not*.
    ///
    /// ```no_run
    /// use amos_robot::fusion::{AttitudeEstimator, ImuSample};
    ///
    /// # fn main() -> Result<(), amos_robot::fusion::FusionError> {
    /// let mut estimator = AttitudeEstimator::new();
    /// let level = ImuSample::new([0.0, 0.0, 9.806_65], [0.0, 0.0, 0.0]);
    /// let line = estimator.update(&level, 0.005)?.summary();
    /// assert!(line.contains("gravity-referenced"), "{line}");
    /// assert!(line.contains("yaw=dead-reckoned"), "{line}");
    /// # Ok(())
    /// # }
    /// ```
    pub fn summary(&self) -> String {
        let correction = match self.correction {
            GravityCorrection::Unobserved => "no-update-yet".to_string(),
            GravityCorrection::Applied => "gravity-referenced".to_string(),
            GravityCorrection::GyroOnly { reason } => format!("gyro-only({})", reason.key()),
        };
        let yaw = match self.yaw_reference {
            YawReference::DeadReckoned => "yaw=dead-reckoned",
            YawReference::Referenced => "yaw=referenced",
            YawReference::Magnetic => "yaw=magnetic",
        };
        format!(
            "roll={:.1}deg pitch={:.1}deg yaw={:.1}deg {correction} {yaw}",
            self.roll_rad.to_degrees(),
            self.pitch_rad.to_degrees(),
            self.yaw_rad.to_degrees()
        )
    }
}

/// Why a sample could not be integrated.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FusionError {
    /// The sample carried a non-finite axis. Treating it as zero would inject a fabricated
    /// measurement into the state.
    NonFiniteSample,
    /// `dt_s` was not a positive, finite number: a zero or negative step has no physical
    /// meaning (two samples with one stamp are one sample, or a clock went backwards).
    DeltaTime {
        /// The rejected value, for the log line.
        dt_s: f32,
    },
    /// The gap since the previous sample exceeded [`MAX_DT_S`], so the attitude is no
    /// longer continuous with what was integrated. Call [`AttitudeEstimator::reset`] and
    /// re-acquire instead of integrating across an unobserved interval.
    Gap {
        /// The rejected gap, in seconds.
        dt_s: f32,
    },
}

impl std::fmt::Display for FusionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FusionError::NonFiniteSample => write!(f, "the IMU sample carries a non-finite axis"),
            FusionError::DeltaTime { dt_s } => write!(
                f,
                "the integration step must be positive and finite, got {dt_s} s"
            ),
            FusionError::Gap { dt_s } => write!(
                f,
                "a {dt_s} s gap exceeds the {MAX_DT_S} s continuity limit: the attitude is unknown \
                 across it, so reset() and re-acquire instead of integrating it"
            ),
        }
    }
}

impl std::error::Error for FusionError {}

/// A Mahony 6-DOF attitude estimator: quaternion state, gravity correction, gyro-bias
/// estimate.
///
/// ```no_run
/// use amos_robot::fusion::{AttitudeEstimator, ImuSample, YawReference};
///
/// # fn main() -> Result<(), amos_robot::fusion::FusionError> {
/// let mut estimator = AttitudeEstimator::new();
/// // A magnetometer or GNSS course arrives once: from then on yaw is *referenced*.
/// estimator.set_heading(0.0);
/// let level = ImuSample::new([0.0, 0.0, 9.806_65], [0.0, 0.0, 0.0]);
/// let attitude = estimator.update(&level, 0.005)?;
/// assert_eq!(attitude.yaw_reference, YawReference::Referenced);
/// # Ok(())
/// # }
/// ```
#[derive(Clone, Copy, Debug)]
pub struct AttitudeEstimator {
    /// Orientation as `[w, x, y, z]`, normalised after every step.
    quaternion: [f32; 4],
    /// The rate **added** to the gyro to cancel its bias (i.e. `-bias`), integrated by `Ki`.
    correction_rad_s: [f32; 3],
    /// The gravity error of the last update (`a × v`), kept so `update` computes it once.
    error: [f32; 3],
    /// What the last update used as its gravity reference.
    last_correction: GravityCorrection,
    yaw_reference: YawReference,
    integrated_s: f32,
    kp: f32,
    ki: f32,
}

impl Default for AttitudeEstimator {
    fn default() -> Self {
        Self::new()
    }
}

impl AttitudeEstimator {
    /// A level, still, unbiased estimator.
    pub fn new() -> Self {
        Self {
            quaternion: [1.0, 0.0, 0.0, 0.0],
            correction_rad_s: [0.0; 3],
            error: [0.0; 3],
            last_correction: GravityCorrection::Unobserved,
            yaw_reference: YawReference::DeadReckoned,
            integrated_s: 0.0,
            kp: DEFAULT_KP,
            ki: DEFAULT_KI,
        }
    }

    /// The same estimator with explicit gains.
    ///
    /// `kp` is the gravity-correction gain (1/s), `ki` the gyro-bias gain (1/s²). A
    /// deployment that knows its IMU (a MEMS unit with a stable bias wants a smaller `ki`
    /// than a noisy one) tunes here: the knobs are parameters rather than constants buried
    /// in the update path, because a number nobody can see is a number nobody can defend.
    /// A non-finite or negative gain is ignored (the default is kept) rather than
    /// propagating a `NaN` into every later step.
    pub fn with_gains(kp: f32, ki: f32) -> Self {
        let mut estimator = Self::new();
        if kp.is_finite() && kp >= 0.0 {
            estimator.kp = kp;
        }
        if ki.is_finite() && ki >= 0.0 {
            estimator.ki = ki;
        }
        estimator
    }

    /// Back to level, still, `DeadReckoned`, with the learned correction forgotten.
    ///
    /// This is the honest response to a stall, a mount change or a re-acquisition: the
    /// state that cannot be justified is dropped, and the *evidence* (yaw reference, bias)
    /// is dropped with it — a reset that kept the old bias would keep a number nothing
    /// supports any more. The gains are the caller's configuration and survive.
    pub fn reset(&mut self) {
        let (kp, ki) = (self.kp, self.ki);
        *self = Self::new();
        self.kp = kp;
        self.ki = ki;
    }

    /// Declare the current yaw from an external heading (a magnetometer triad, a GNSS
    /// course, a surveyed landmark).
    ///
    /// The estimator does not measure a heading — it is told one — which is exactly why
    /// the resulting state is [`YawReference::Referenced`] rather than silently "better".
    /// A non-finite value cannot reference anything, so it is ignored, the call reports
    /// `false`, and the state is left exactly as it was.
    ///
    /// Implementation note: this still rebuilds the quaternion from the (extracted)
    /// roll/pitch and the *requested* yaw, because that path is what the existing
    /// `yaw_is_dead_reckoned_until_a_heading_is_given` test pins. The roundtrip
    /// `euler -> quaternion_from_euler` is not `f32`-exact, but the tilt error it
    /// introduces is **nanoradian**-scale (measured `3e-8` rad of roll at a 10°/5°
    /// roll/pitch) — orders of magnitude below the `1e-4` rad bound pinned by
    /// `set_heading_roundtrip_drift_is_bounded`. (What that test actually bounds is the
    /// *residual learned bias* integrated over the next few steps — measured `9e-6` rad
    /// over 0.05 s — not the roundtrip error, which is far too small to see.)
    pub fn set_heading(&mut self, yaw_rad: f32) -> bool {
        if !yaw_rad.is_finite() {
            return false;
        }
        let (roll, pitch) = self.euler();
        self.quaternion = quaternion_from_euler(roll, pitch, wrap_pi(yaw_rad));
        self.yaw_reference = YawReference::Referenced;
        true
    }

    /// The gyro correction the estimator has learned, in rad/s — the value *added* to the
    /// measured rate, i.e. `-bias`.
    ///
    /// A steady non-zero value while the attitude is stable is the estimator cancelling a
    /// real sensor bias: the observable that tells a calibration engineer the loop is
    /// working, rather than the attitude merely looking plausible.
    pub fn gyro_correction_rad_s(&self) -> [f32; 3] {
        self.correction_rad_s
    }

    /// The current attitude without integrating anything, carrying the correction category
    /// of the **last** update ([`GravityCorrection::Unobserved`] before the first one,
    /// because nothing has been integrated yet).
    pub fn estimate(&self) -> Attitude {
        let (roll, pitch) = self.euler();
        Attitude {
            roll_rad: roll,
            pitch_rad: pitch,
            yaw_rad: self.yaw(),
            yaw_reference: self.yaw_reference,
            correction: self.last_correction,
            integrated_s: self.integrated_s,
        }
    }

    /// Integrate one sample `dt_s` after the previous one.
    ///
    /// Refuses rather than guessing: a non-finite sample, a step that is not positive and
    /// finite, or a gap longer than [`MAX_DT_S`] (see [`FusionError`]). A refusal leaves the
    /// state **untouched** — a rejected sample must not move the estimate, or a caller that
    /// retries would integrate it twice.
    pub fn update(&mut self, sample: &ImuSample, dt_s: f32) -> Result<Attitude, FusionError> {
        if !sample.is_finite() {
            return Err(FusionError::NonFiniteSample);
        }
        if !(dt_s.is_finite() && dt_s > 0.0) {
            return Err(FusionError::DeltaTime { dt_s });
        }
        if dt_s > MAX_DT_S {
            return Err(FusionError::Gap { dt_s });
        }

        // ① Gravity, when it is readable. The decision is made on the *norm*, so a body
        // that is accelerating is excluded **before** it can pull the attitude toward a
        // fabricated "down".
        let correction = match self.gravity_reference(sample) {
            Ok(accel_unit) => {
                let v = self.estimated_gravity_body();
                self.error = cross(accel_unit, v);
                for (bias, e) in self.correction_rad_s.iter_mut().zip(self.error.iter()) {
                    *bias += self.ki * e * dt_s;
                }
                GravityCorrection::Applied
            }
            Err(reason) => {
                // No evidence is not the same as no error: the proportional term is fed
                // zero (it has nothing to correct with) and the integral term is **held**,
                // so a gyro-only stretch cannot invent a bias out of thin air.
                self.error = [0.0; 3];
                GravityCorrection::GyroOnly { reason }
            }
        };

        // ② The rate: measured gyro + proportional correction + learned correction.
        let g = [
            sample.gyro_rad_s[0] + self.kp * self.error[0] + self.correction_rad_s[0],
            sample.gyro_rad_s[1] + self.kp * self.error[1] + self.correction_rad_s[1],
            sample.gyro_rad_s[2] + self.kp * self.error[2] + self.correction_rad_s[2],
        ];

        // ③ The integration: q̇ = ½ · q ⊗ ω, ω in the **body** frame — exact for large
        // angles, unlike integrating Euler rates.
        let q = self.quaternion;
        let qdot = quat_mul(q, [0.0, g[0], g[1], g[2]]);
        self.quaternion = quat_normalize([
            q[0] + 0.5 * qdot[0] * dt_s,
            q[1] + 0.5 * qdot[1] * dt_s,
            q[2] + 0.5 * qdot[2] * dt_s,
            q[3] + 0.5 * qdot[3] * dt_s,
        ]);
        self.integrated_s += dt_s;
        self.last_correction = correction;

        Ok(self.estimate())
    }
}

/// The geometry the estimator runs on: kept in one block so the conventions (which axis is
/// which, which way gravity points) are readable in one screen.
impl AttitudeEstimator {
    /// The unit gravity direction the accelerometer reports, or the reason it cannot be
    /// trusted as one — never a fabricated third option.
    fn gravity_reference(&self, sample: &ImuSample) -> Result<[f32; 3], AccelRejection> {
        let norm = sample.accel_norm_m_s2();
        // `!norm.is_finite()` is a **defensive, currently-unreachable** arm: this is only
        // called from `update` after `sample.is_finite()` passed, and the sole
        // implementation of `accel_norm_m_s2` returns a real square root for a finite
        // triple — so `norm` here is always finite and the branch is pinned by
        // construction, not by a test. It is kept because the finiteness of `norm` is a
        // property of a *sibling* function: if `accel_norm_m_s2` ever stopped guarding, a
        // `NaN` norm would fall through both comparisons (all comparisons with `NaN` are
        // false) and be divided by below, producing a `NaN` gravity reference. The
        // reachable half is the weightless floor: `norm <= WEIGHTLESS_G · g`.
        if !norm.is_finite() || norm <= WEIGHTLESS_G * STANDARD_GRAVITY_M_S2 {
            return Err(AccelRejection::Weightless);
        }
        if !(ACCEL_MIN_G..=ACCEL_MAX_G).contains(&(norm / STANDARD_GRAVITY_M_S2)) {
            return Err(AccelRejection::NotGravity);
        }
        Ok([
            sample.accel_m_s2[0] / norm,
            sample.accel_m_s2[1] / norm,
            sample.accel_m_s2[2] / norm,
        ])
    }

    /// Estimated gravity direction in the body frame (Mahony's `v = 2 · halfv`).
    fn estimated_gravity_body(&self) -> [f32; 3] {
        let [w, x, y, z] = self.quaternion;
        [
            2.0 * (x * z - w * y),
            2.0 * (w * x + y * z),
            2.0 * (w * w - 0.5 + z * z),
        ]
    }

    /// Roll/pitch from the quaternion (yaw is separate, so the *reference* question stays
    /// visible at every call site).
    fn euler(&self) -> (f32, f32) {
        let [w, x, y, z] = self.quaternion;
        let roll = f32::atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y));
        let sin_pitch = (2.0 * (w * y - z * x)).clamp(-1.0, 1.0);
        (wrap_pi(roll), wrap_pi(sin_pitch.asin()))
    }

    fn yaw(&self) -> f32 {
        let [w, x, y, z] = self.quaternion;
        wrap_pi(f32::atan2(
            2.0 * (w * z + x * y),
            1.0 - 2.0 * (y * y + z * z),
        ))
    }
}

/// Wrap an angle into `(-π, π]`.
///
/// A non-finite angle cannot be wrapped. It falls back to `0.0` (level) rather than
/// propagating a `NaN` — the same "a state that cannot be justified becomes level, not
/// `NaN`" convention [`quat_normalize`] follows, chosen here so a `NaN` angle can never
/// silently poison every downstream comparison. Every caller feeds this a value from
/// `atan2`/`asin` of an already-finite quaternion, so the branch is defensive rather than
/// reachable today; `wrap_is_half_open_at_minus_pi` pins it.
fn wrap_pi(angle: f32) -> f32 {
    if !angle.is_finite() {
        return 0.0;
    }
    let wrapped = angle - 2.0 * PI * ((angle + PI) / (2.0 * PI)).floor();
    // The formula lands on `-π` for `-π`; normalise so the interval is half-open, which is
    // what makes "wrapped equal" a decidable property for tests and for a UI.
    if wrapped <= -PI {
        wrapped + 2.0 * PI
    } else {
        wrapped
    }
}

/// Cross product of two body-frame vectors.
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Hamilton product of two quaternions (`[w, x, y, z]`).
fn quat_mul(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ]
}

/// Renormalise a quaternion; a degenerate one (norm 0, or `NaN`) falls back to identity
/// rather than propagating a non-orientation into every later step.
fn quat_normalize(q: [f32; 4]) -> [f32; 4] {
    let norm = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if !norm.is_finite() || norm <= f32::EPSILON {
        return [1.0, 0.0, 0.0, 0.0];
    }
    [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm]
}

/// The quaternion for a ZYX Euler triple (`roll` about *x*, `pitch` about *y*, `yaw` about
/// *z*) — the inverse of the extraction in `AttitudeEstimator::euler`, used by
/// [`AttitudeEstimator::set_heading`].
///
/// The roundtrip `euler → quaternion_from_euler` is not `f32`-exact, so `set_heading`
/// introduces a tilt error — measured at the **nanoradian** scale (`3e-8` rad of roll at
/// a 10°/5° roll/pitch). `set_heading_roundtrip_drift_is_bounded` pins the *post-reset*
/// motion, which is dominated by the residual learned bias rather than this roundtrip.
fn quaternion_from_euler(roll: f32, pitch: f32, yaw: f32) -> [f32; 4] {
    let (sr, cr) = ((roll * 0.5).sin(), (roll * 0.5).cos());
    let (sp, cp) = ((pitch * 0.5).sin(), (pitch * 0.5).cos());
    let (sy, cy) = ((yaw * 0.5).sin(), (yaw * 0.5).cos());
    quat_normalize([
        cr * cp * cy + sr * sp * sy,
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The specific force an accelerometer reports when the body is at `(roll, pitch)` with
    /// **no** linear acceleration, in m/s² — derived from `Rᵀ · (0, 0, g)` for the ZYX
    /// convention this module uses, so the tests share the module's geometry instead of
    /// re-inventing a sign.
    fn gravity_body(roll: f32, pitch: f32) -> [f32; 3] {
        let g = STANDARD_GRAVITY_M_S2;
        [
            -pitch.sin() * g,
            pitch.cos() * roll.sin() * g,
            pitch.cos() * roll.cos() * g,
        ]
    }

    const STEP_S: f32 = 1.0 / 200.0;

    /// Drive the estimator for `seconds` at 200 Hz from one constant sample.
    fn run(estimator: &mut AttitudeEstimator, sample: &ImuSample, seconds: f32) -> Attitude {
        let steps = (seconds / STEP_S).round() as u32;
        let mut last = estimator.estimate();
        for _ in 0..steps {
            match estimator.update(sample, STEP_S) {
                Ok(attitude) => last = attitude,
                Err(e) => panic!("the estimator refused a valid sample: {e}"),
            }
        }
        last
    }

    #[test]
    fn level_and_still_stays_level() {
        let mut estimator = AttitudeEstimator::new();
        // Nothing integrated yet: the correction category is "no evidence", not "applied".
        assert_eq!(
            estimator.estimate().correction,
            GravityCorrection::Unobserved
        );
        let attitude = run(
            &mut estimator,
            &ImuSample::new(gravity_body(0.0, 0.0), [0.0; 3]),
            1.0,
        );
        assert!(attitude.roll_rad.to_degrees().abs() < 0.1, "{attitude:?}");
        assert!(attitude.pitch_rad.to_degrees().abs() < 0.1, "{attitude:?}");
        assert_eq!(attitude.correction, GravityCorrection::Applied);
        assert_eq!(attitude.yaw_reference, YawReference::DeadReckoned);
        assert!((attitude.integrated_s - 1.0).abs() < 1e-3);
    }

    #[test]
    fn a_tilt_is_recovered_from_gravity() {
        // The attitude starts level (identity) while gravity says the body is rolled and
        // pitched: the correction must drive the state *to* gravity, and only the gyro part
        // is integrated, so yaw must not move.
        //
        // Proportional-only on purpose: this is the `Kp` property (a step error is pulled
        // out exponentially). `Ki` is tuned for a *slowly varying* bias, and a 30° step is
        // not one — see the boundary in the module docs — so it is exercised where it
        // belongs (`a_gyro_bias_is_learned_instead_of_believed`).
        for (roll_deg, pitch_deg) in [(30.0_f32, 0.0_f32), (0.0, -20.0), (25.0, 15.0)] {
            let roll = roll_deg.to_radians();
            let pitch = pitch_deg.to_radians();
            let mut estimator = AttitudeEstimator::with_gains(1.0, 0.0);
            let attitude = run(
                &mut estimator,
                &ImuSample::new(gravity_body(roll, pitch), [0.0; 3]),
                6.0,
            );
            let roll_err = wrap_pi(attitude.roll_rad - roll).to_degrees();
            let pitch_err = wrap_pi(attitude.pitch_rad - pitch).to_degrees();
            assert!(
                roll_err.abs() < 1.0 && pitch_err.abs() < 1.0,
                "roll {roll_deg} pitch {pitch_deg} → {attitude:?}"
            );
            // Yaw is **unobservable** here, and the geodesic that pulls gravity home is not a
            // rotation about body z: with a skewed correction axis (roll and pitch both
            // nonzero) some of the correction necessarily lands in the unreferenced yaw
            // degree of freedom. So the claim is the *reference* one — yaw is
            // dead-reckoned and the filter says so — plus, for the pure-roll case (whose
            // correction axis *is* body x), that yaw does not move at all.
            assert_eq!(attitude.yaw_reference, YawReference::DeadReckoned);
            // A tolerance, not `==`: the fixture is built from `to_radians`, so the
            // "pure roll" case is only exactly zero by luck of the literal.
            if pitch_deg.abs() < 1e-6 {
                assert!(
                    attitude.yaw_rad.to_degrees().abs() < 0.1,
                    "a pure roll correction must not touch yaw: {attitude:?}"
                );
            }
        }
    }

    /// Boundary 6 in the module docs: the gravity correction is the geodesic from the
    /// estimated gravity direction to the measured one, and that geodesic is **not** a
    /// rotation about body *z* when roll and pitch are both non-zero. So a skewed
    /// roll/pitch step is expected to leak a few degrees into the *unreferenced* yaw —
    /// with the honest answer being the `YawReference` field, not a claim that yaw held
    /// still. The doc quotes `3.33°`; this pins it, and pins that it is the **skewed**
    /// case: a pure-roll sibling (same test above) asserts yaw ≈ 0, because its correction
    /// axis *is* body *x*.
    ///
    /// Proportional-only (`Ki = 0`) on purpose, matching the doc's figure: with the default
    /// `Ki` the integral learns a bias through the same transient and the leak reads
    /// `3.62°`. That is a property of the gain choice, so the test names the gains it used
    /// rather than implying the number is gain-independent.
    ///
    /// **What this pins is the outcome, not a branch.** The leak turns out to be a
    /// *geometric* function of the converged attitude (the yaw component of the rotation
    /// that aligns gravity), so it is insensitive to *how* the estimator arrives. Three
    /// mutations were injected and each left the yaw assert green: scaling `Kp` by 0.9,
    /// zeroing the cross product's body-*z* component, and integrating a **world-frame**
    /// rate in place of a body rate (the last moved the figure only from `3.3267283` to
    /// `3.3267329` degrees — a 6th-decimal change). So this assert fires when the
    /// *gravity-alignment geometry* changes, not on a specific branch; claiming a mutation
    /// "proves the branch" would be the overclaim this crate forbids.
    #[test]
    fn a_skewed_gravity_correction_moves_the_unreferenced_yaw() {
        let roll = 25.0_f32.to_radians();
        let pitch = 15.0_f32.to_radians();
        let mut estimator = AttitudeEstimator::with_gains(1.0, 0.0);
        let attitude = run(
            &mut estimator,
            &ImuSample::new(gravity_body(roll, pitch), [0.0; 3]),
            6.0,
        );
        // The tilt is recovered (the sibling test's claim) *and* the yaw has moved: the
        // leak is real, unreferenced, and reported as such.
        assert!(attitude.roll_rad.to_degrees() > 24.0, "{attitude:?}");
        assert_eq!(attitude.yaw_reference, YawReference::DeadReckoned);
        let yaw_deg = attitude.yaw_rad.to_degrees();
        assert!(
            (yaw_deg - 3.33).abs() < 0.05,
            "a 25°/15° step must leak ~3.33° into the unreferenced yaw, got {yaw_deg}"
        );
    }

    #[test]
    fn an_accelerating_body_is_gyro_only_and_says_so() {
        let mut estimator = AttitudeEstimator::new();
        // 2 g: indistinguishable from a tilt in one sample, so it must not be *used*.
        let pushing = ImuSample::new([0.0, 0.0, 2.0 * STANDARD_GRAVITY_M_S2], [0.1, 0.0, 0.0]);
        let attitude = run(&mut estimator, &pushing, 0.5);
        assert_eq!(
            attitude.correction,
            GravityCorrection::GyroOnly {
                reason: AccelRejection::NotGravity
            }
        );
        // …and the angle is the gyro integral, not a fabricated tilt: 0.1 rad/s × 0.5 s.
        assert!(
            (attitude.roll_rad - 0.05).abs() < 1e-3,
            "gyro-only roll must be ∫ω dt: {attitude:?}"
        );
    }

    #[test]
    fn free_fall_is_weightless_not_a_tilt() {
        let mut estimator = AttitudeEstimator::new();
        let falling = ImuSample::new([0.0, 0.0, 0.0], [0.0, 0.0, 0.0]);
        let attitude = run(&mut estimator, &falling, 0.2);
        assert_eq!(
            attitude.correction,
            GravityCorrection::GyroOnly {
                reason: AccelRejection::Weightless
            }
        );
        assert!(attitude.roll_rad.abs() < 1e-6, "zero rate means no motion");
    }

    #[test]
    fn gravity_returns_and_the_drift_is_undone() {
        // The property that matters in the field: a gyro-only stretch (bias, no gravity)
        // drifts, and the *same* estimator recovers when gravity is readable again — no
        // reset needed, with the correction category telling the whole story.
        let mut estimator = AttitudeEstimator::new();
        let biased = ImuSample::new([0.0, 0.0, 0.0], [0.05, 0.0, 0.0]);
        let drifting = run(&mut estimator, &biased, 4.0);
        assert!(
            drifting.roll_rad.to_degrees() > 5.0,
            "0.05 rad/s for 4 s must show as drift: {drifting:?}"
        );
        let recovered = run(
            &mut estimator,
            &ImuSample::new(gravity_body(0.0, 0.0), [0.0; 3]),
            6.0,
        );
        assert_eq!(recovered.correction, GravityCorrection::Applied);
        assert!(
            recovered.roll_rad.to_degrees().abs() < 1.0,
            "gravity must unwind the drift: {recovered:?}"
        );
    }

    #[test]
    fn a_gyro_bias_is_learned_instead_of_believed() {
        // A 0.02 rad/s bias on x with the body actually level: a proportional-only filter
        // would settle at a steady roll error of `bias/Kp`. The integral term must instead
        // learn the bias (as `-bias`) — the difference between "looks plausible" and
        // "holds an attitude".
        let mut estimator = AttitudeEstimator::new();
        let sample = ImuSample::new(gravity_body(0.0, 0.0), [0.02, 0.0, 0.0]);
        let attitude = run(&mut estimator, &sample, 30.0);
        assert!(
            attitude.roll_rad.to_degrees().abs() < 1.0,
            "the residue must be small: {attitude:?}"
        );
        let learned = estimator.gyro_correction_rad_s()[0];
        assert!(
            (learned + 0.02).abs() < 0.006,
            "the learned correction must approach -bias (-0.02), got {learned}"
        );
    }

    #[test]
    fn the_bias_estimate_does_not_wind_up_under_a_persistent_disturbance() {
        // The `ki` integral is deliberately **not clamped**: it cannot run away because the
        // attitude *follows* the measured gravity, so the cross-product error returns to
        // zero after each transient and the integral stops. That claim is pinned here, not
        // merely asserted in a comment: the fixture drives a worse case than a field does
        // (forty 0.8 rad attitude steps, each held a full second) and bounds the peak of
        // the learned correction.
        //
        // This bounds "no windup in this scenario", not a hardware spec: `0.2 rad/s` is a
        // deliberately loose ceiling (~6× the `0.032` measured) so the test fails on a
        // genuine runaway (which would climb past it monotonically) rather than on jitter.
        let mut estimator = AttitudeEstimator::new();
        let mut peak = 0.0f32;
        for k in 0..40 {
            let roll = 0.8 * (k as f32 * 0.9).cos();
            let sample = ImuSample::new(gravity_body(roll, 0.0), [0.0; 3]);
            for _ in 0..(1.0 / STEP_S) as u32 {
                estimator.update(&sample, STEP_S).expect("update");
                let c = estimator.gyro_correction_rad_s();
                peak = peak.max(c[0].abs()).max(c[1].abs()).max(c[2].abs());
            }
        }
        assert!(
            peak < 0.2,
            "the learned correction must stay a plausible gyro bias, got peak {peak} rad/s"
        );
    }

    #[test]
    fn yaw_is_dead_reckoned_until_a_heading_is_given() {
        let mut estimator = AttitudeEstimator::new();
        run(
            &mut estimator,
            &ImuSample::new(gravity_body(0.0, 0.0), [0.0, 0.0, 0.3]),
            1.0,
        );
        let dead = estimator.estimate();
        assert_eq!(dead.yaw_reference, YawReference::DeadReckoned);
        // 0.3 rad/s for 1 s, integrated dead-reckoned (no heading reference yet).
        assert!(
            (dead.yaw_rad - 0.3).abs() < 1e-3,
            "dead-reckoned yaw after 1 s at 0.3 rad/s must be 0.3 rad: {dead:?}"
        );

        assert!(estimator.set_heading(90.0_f32.to_radians()));
        let referenced = estimator.estimate();
        assert_eq!(referenced.yaw_reference, YawReference::Referenced);
        assert!(
            (referenced.yaw_rad.to_degrees() - 90.0).abs() < 0.1,
            "{referenced:?}"
        );

        // A non-finite heading references nothing, so it is refused and changes nothing.
        assert!(!estimator.set_heading(f32::NAN));
        assert_eq!(estimator.estimate(), referenced);
    }

    #[test]
    fn refused_inputs_do_not_move_the_estimate() {
        let mut estimator = AttitudeEstimator::new();
        let attitude = run(
            &mut estimator,
            &ImuSample::new(gravity_body(0.0, 0.0), [0.0; 3]),
            0.1,
        );

        let nan = ImuSample::new([f32::NAN, 0.0, 9.81], [0.0; 3]);
        assert_eq!(
            estimator.update(&nan, STEP_S),
            Err(FusionError::NonFiniteSample)
        );
        let ok = ImuSample::new(gravity_body(0.0, 0.0), [0.0; 3]);
        assert_eq!(
            estimator.update(&ok, 0.0),
            Err(FusionError::DeltaTime { dt_s: 0.0 })
        );
        assert_eq!(
            estimator.update(&ok, -STEP_S),
            Err(FusionError::DeltaTime { dt_s: -STEP_S })
        );
        assert!(matches!(
            estimator.update(&ok, f32::NAN),
            Err(FusionError::DeltaTime { .. })
        ));
        assert!(matches!(
            estimator.update(&ok, MAX_DT_S + 1e-3),
            Err(FusionError::Gap { .. })
        ));
        // 0.25 s is the *inclusive* ceiling: the boundary itself is a legal step.
        assert!(estimator.update(&ok, MAX_DT_S).is_ok());

        // The refusals left the state where the integration put it: a refusal is not a step.
        let after = estimator.estimate();
        assert!((after.integrated_s - (attitude.integrated_s + MAX_DT_S)).abs() < 1e-4);
        assert!((after.roll_rad - attitude.roll_rad).abs() < 1e-4);
    }

    /// The `dt_s` guard's finiteness leaf, which only `+INFINITY` walks.
    ///
    /// The guard is `!(dt_s.is_finite() && dt_s > 0.0)`, and `update`'s own doc promises a
    /// step "that is not positive and finite" is refused as [`FusionError::DeltaTime`].
    /// Measured: deleting `dt_s.is_finite() &&` leaves the whole crate green (392 passed) —
    /// the guard test above feeds `0.0`, `-STEP_S` and `NaN`, each of which the sibling
    /// `dt_s > 0.0` leaf already catches (`NaN > 0.0` is `false`), and `-∞ > 0.0` is `false`
    /// too, so `+∞` is the sole input that reaches the leaf alone.
    ///
    /// Without the leaf the refusal still happens, but one stage later and with the wrong
    /// verdict: `+∞ > MAX_DT_S` is `true`, so a malformed value is reported as a `Gap` — the
    /// verdict that means "the attitude is discontinuous across a long but *real* interval,
    /// reset and re-acquire". A caller that resynchronises on `Gap` is told to do so by a
    /// value that was never a gap at all.
    #[test]
    fn an_infinite_step_is_a_malformed_step_not_a_gap() {
        let mut estimator = AttitudeEstimator::new();
        let ok = ImuSample::new(gravity_body(0.0, 0.0), [0.0; 3]);
        assert_eq!(
            estimator.update(&ok, f32::INFINITY),
            Err(FusionError::DeltaTime {
                dt_s: f32::INFINITY
            }),
            "∞ s is not a positive finite step, so it is a DeltaTime, not a Gap"
        );
        // Control: a *finite* step past the ceiling is the `Gap` verdict, so the assertion
        // above cannot be passing because everything past the ceiling is refused alike.
        assert!(matches!(
            estimator.update(&ok, MAX_DT_S + 1e-3),
            Err(FusionError::Gap { .. })
        ));
    }

    #[test]
    fn the_estimate_is_deterministic() {
        // Two estimators, one input stream: identical to the bit. An estimator with hidden
        // state (a random dither, a wall-clock read) could not promise this, and a replay of
        // a recorded flight would not reproduce.
        let mut a = AttitudeEstimator::new();
        let mut b = AttitudeEstimator::new();
        for i in 0..500 {
            let t = i as f32 * STEP_S;
            let sample = ImuSample::new(
                gravity_body(0.3 * t.sin(), 0.2 * t.cos()),
                [0.01 * t.cos(), 0.02 * t.sin(), 0.03],
            );
            assert_eq!(a.update(&sample, STEP_S), b.update(&sample, STEP_S));
        }
        assert_eq!(a.estimate(), b.estimate());
        assert_eq!(a.gyro_correction_rad_s(), b.gyro_correction_rad_s());
    }

    #[test]
    fn wrap_is_half_open_at_minus_pi() {
        assert!((wrap_pi(PI) - PI).abs() < 1e-5);
        assert!((wrap_pi(-PI) - PI).abs() < 1e-5, "-π normalises to π");
        assert!((wrap_pi(3.0 * PI) - PI).abs() < 1e-4);
        assert!(wrap_pi(-1.0e9).is_finite());
        assert_eq!(wrap_pi(f32::NAN), 0.0);
    }

    #[test]
    fn a_degenerate_quaternion_is_identity_not_nan() {
        // A quaternion that cannot be normalised must become "level", never `NaN`: `NaN`
        // angles would silently poison every comparison downstream.
        assert_eq!(quat_normalize([0.0, 0.0, 0.0, 0.0]), [1.0, 0.0, 0.0, 0.0]);
        assert_eq!(quat_normalize([f32::NAN; 4]), [1.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn the_summary_reports_what_the_numbers_are_not() {
        let mut estimator = AttitudeEstimator::new();
        let pushing = ImuSample::new([0.0, 0.0, 2.0 * STANDARD_GRAVITY_M_S2], [0.0; 3]);
        let line = run(&mut estimator, &pushing, STEP_S).summary();
        assert!(line.contains("gyro-only(not-gravity)"), "{line}");
        assert!(line.contains("yaw=dead-reckoned"), "{line}");
        assert!(!line.contains("gravity-referenced"), "{line}");
    }

    /// The `summary` line must change with the evidence, not only with the numbers. An
    /// estimator that has integrated nothing renders `no-update-yet` (the "no evidence"
    /// third state, never a confident level); once a level 1 g sample is integrated the same
    /// field must read `gravity-referenced`, and the stale token must be gone. A `summary`
    /// that hard-codes one string would pass the old gyro-only test and fail here.
    #[test]
    fn the_summary_names_the_unobserved_and_gravity_referenced_states() {
        let mut estimator = AttitudeEstimator::new();
        let before = estimator.estimate().summary();
        assert!(before.contains("no-update-yet"), "{before}");
        assert!(!before.contains("gravity-referenced"), "{before}");

        let level = ImuSample::new(gravity_body(0.0, 0.0), [0.0; 3]);
        let after = run(&mut estimator, &level, STEP_S).summary();
        assert!(after.contains("gravity-referenced"), "{after}");
        assert!(!after.contains("no-update-yet"), "{after}");
    }

    /// Every `YawReference` must render its own token. The default is `dead-reckoned`; a
    /// manual `set_heading` promotes it to `referenced`; a magnetometer update to `magnetic`.
    /// Each step asserts the *other* tokens are absent, so a `summary` that printed a
    /// constant — or collapsed two states onto one string — cannot pass.
    #[test]
    fn the_summary_names_every_yaw_reference() {
        let mut estimator = AttitudeEstimator::new();
        assert!(estimator.estimate().summary().contains("yaw=dead-reckoned"));

        assert!(estimator.set_heading(0.3), "a finite heading is accepted");
        let referenced = estimator.estimate().summary();
        assert!(referenced.contains("yaw=referenced"), "{referenced}");
        assert!(!referenced.contains("yaw=dead-reckoned"), "{referenced}");
        assert!(!referenced.contains("yaw=magnetic"), "{referenced}");

        let level = ImuSample::new(gravity_body(0.0, 0.0), [0.0; 3]);
        let step = estimator
            .update_with_mag(&level, &MagSample::new([17.32, -10.0, 38.0]), STEP_S)
            .expect("a level sample with a non-degenerate field is integrated");
        assert!(step.magnetometer_used, "the field is usable, not rejected");
        let magnetic = step.attitude.summary();
        assert!(magnetic.contains("yaw=magnetic"), "{magnetic}");
        assert!(!magnetic.contains("yaw=referenced"), "{magnetic}");
        assert_eq!(step.attitude.yaw_reference, YawReference::Magnetic);
    }

    /// The rejection keys are operator- and log-visible strings: renaming one silently
    /// breaks every dashboard that greps for it, so pin both spellings here.
    #[test]
    fn accel_rejection_keys_are_stable() {
        assert_eq!(AccelRejection::Weightless.key(), "weightless");
        assert_eq!(AccelRejection::NotGravity.key(), "not-gravity");
        assert_ne!(
            AccelRejection::Weightless.key(),
            AccelRejection::NotGravity.key(),
            "the two reasons must not collapse to one key"
        );
    }

    #[test]
    fn a_non_finite_or_negative_gain_is_ignored_rather_than_propagated() {
        // Every bad gain keeps the default. The *set* of bad values matters, and an earlier
        // revision of this test got it wrong: it fed only `with_gains(NAN, -1.0)`, and both
        // of those are caught by the `>= 0.0` half of the guard *as well as* by `is_finite`.
        // Neutralising the `is_finite` leaf (`kp.is_finite()` → `true`) therefore left all 42
        // `fusion` tests green — the leaf was dead to the suite (REQ-A860 / F-SH-276).
        //
        // `+INFINITY` is the value that walks the `is_finite` leaf *alone* (`INF >= 0.0` is
        // `true`, `NaN >= 0.0` is `false`). Installing it makes the update's
        // `g = gyro + kp · error + correction` non-finite, so `quat_normalize` falls back to
        // identity and the estimator reports a **level** attitude (roll 0°, pitch 0°) while
        // still claiming `GravityCorrection::Applied` — a fault dressed as an all-clear, the
        // worst shape for an attitude estimate a controller reads.
        for bad in [f32::NAN, f32::INFINITY, -1.0] {
            let mut estimator = AttitudeEstimator::with_gains(bad, bad);
            assert_eq!(
                estimator.kp, DEFAULT_KP,
                "kp = {bad} must be ignored, not installed"
            );
            assert_eq!(
                estimator.ki, DEFAULT_KI,
                "ki = {bad} must be ignored, not installed"
            );
            let attitude = run(
                &mut estimator,
                &ImuSample::new(gravity_body(10.0_f32.to_radians(), 0.0), [0.0; 3]),
                6.0,
            );
            assert_eq!(attitude.correction, GravityCorrection::Applied);
            // The roll input is a pure roll, so both angles are pinned. The bound is tight
            // enough that a leaked non-finite gain — which freezes the estimate at level,
            // `roll ≈ 0` — fails it, while the defaults (settling to ~9.98° by 6 s) pass.
            assert!(
                (attitude.roll_rad.to_degrees() - 10.0).abs() < 1.0,
                "a leaked non-finite gain freezes the estimate at level: {bad} -> {attitude:?}"
            );
            assert!(
                attitude.pitch_rad.to_degrees().abs() < 1.0,
                "a pure roll must not induce pitch: {bad} -> {attitude:?}"
            );
        }
        // A finite, non-negative gain *is* installed, so the loop above is not passing
        // because the constructor ignores everything.
        let tuned = AttitudeEstimator::with_gains(2.0, 0.5);
        assert_eq!(tuned.kp, 2.0);
        assert_eq!(tuned.ki, 0.5);
    }

    #[test]
    fn reset_forgets_the_state_and_the_evidence() {
        let mut estimator = AttitudeEstimator::new();
        let sample = ImuSample::new(gravity_body(0.0, 0.0), [0.02, 0.0, 0.0]);
        run(&mut estimator, &sample, 5.0);
        assert_ne!(estimator.gyro_correction_rad_s(), [0.0; 3]);
        estimator.set_heading(0.5);

        estimator.reset();
        let fresh = estimator.estimate();
        assert_eq!(fresh, AttitudeEstimator::new().estimate());
        assert_eq!(estimator.gyro_correction_rad_s(), [0.0; 3]);
        assert_eq!(fresh.yaw_reference, YawReference::DeadReckoned);
        assert_eq!(fresh.correction, GravityCorrection::Unobserved);
    }

    /// Regression for the heading-reset path: `set_heading` rebuilds the quaternion
    /// from the extracted (roll, pitch) and the *requested* yaw. The roundtrip
    /// `euler -> quaternion_from_euler` is not f32-exact, but the tilt error it
    /// introduces is nanoradian-scale (measured `3e-8` rad of roll here). The bound
    /// below (`1e-4` rad) is therefore ~10× above what the reset-plus-one-gravity-step
    /// actually produces (measured `9e-6` rad of roll after 0.05 s), and that residual
    /// is the *learned bias* being integrated, not the roundtrip error. The point is to
    /// pin the magnitude so a future change cannot let it grow unseen.
    ///
    /// Concretely: pre-tilt at 10° roll/5° pitch, settle until gravity correction is
    /// applied (`correction: Applied`), then call `set_heading(90°)` and verify the
    /// next few steps still track the pre-reset tilt within `1e-4` rad.
    #[test]
    fn set_heading_roundtrip_drift_is_bounded() {
        let mut estimator = AttitudeEstimator::new();
        let tilted = ImuSample::new(
            gravity_body(10.0_f32.to_radians(), 5.0_f32.to_radians()),
            [0.0, 0.0, 0.0],
        );
        let settled = run(&mut estimator, &tilted, 6.0);
        assert_eq!(
            settled.correction,
            GravityCorrection::Applied,
            "expected gravity correction to be applied before the heading reset"
        );
        let roll_before = settled.roll_rad;
        let pitch_before = settled.pitch_rad;

        assert!(estimator.set_heading(90.0_f32.to_radians()));
        // Without further integration the heading reset's exact form varies; the
        // guarantee we make is that the *next gravity step* returns to the
        // pre-reset tilt within 1e-4 rad (i.e. ~0.006°).
        let after_one = run(&mut estimator, &tilted, 0.05);
        let roll_after = after_one.roll_rad;
        let pitch_after = after_one.pitch_rad;

        assert!(
            (roll_before - roll_after).abs() < 1e-4,
            "roll drift after set_heading: before={roll_before} after={roll_after}"
        );
        assert!(
            (pitch_before - pitch_after).abs() < 1e-4,
            "pitch drift after set_heading: before={pitch_before} after={pitch_after}"
        );
    }

    // No test-only public exposure needed for this regression.
}

// ============================================================================
// 9-DOF fusion extension: magnetometer heading reference
// ============================================================================
//
// A 6-axis IMU cannot observe yaw. A 9-axis sensor (accelerometer + gyro + magnetometer)
// can, because the magnetometer measures the Earth's field *and* rejects the gravity-axis
// ambiguity that leaves the 6-axis yaw drifting. This section adds:
//   * `MagSample` — body-frame magnetometer reading, SI units (µT).
//   * `YawReference::Magnetic` — the enum gets a third variant that records a
//     magnetometer-derived yaw, not a manually supplied one. (An earlier revision of this
//     line named a `MagReference::Referenced`; no such type exists in this crate — the
//     variant lives on `YawReference`.)
//   * `AttitudeEstimator::update_with_mag` — one step with all nine axes.
//   * `AllanVariance` — the gyro-noise health monitor (NASA GNC §3.4.4). It is a
//     bounded, online estimator: every `record` adds one gyro sample, the variance is
//     recomputed on demand over a bounded window, and a verdict (`Healthy` /
//     `Degraded` / `Failed`) reports whether the noise floor has stayed inside the
//     manufacturer-specified envelope.

/// One magnetometer reading, body frame, in microteslas (µT).
///
/// The convention is the same as [`ImuSample`]: body frame x forward, y right, z up. The
/// Earth's field at the surface is ~25–65 µT, with the horizontal projection varying
/// with latitude — a value below 5 µT is a likely sensor fault, not a "weak magnet".
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MagSample {
    /// Magnetometer reading, body frame, microteslas.
    pub field_ut: [f32; 3],
}

impl MagSample {
    /// The field vector, in microteslas, from its three axes.
    pub const fn new(field_ut: [f32; 3]) -> Self {
        Self { field_ut }
    }

    /// True when every axis is finite.
    pub fn is_finite(&self) -> bool {
        self.field_ut.iter().all(|v| v.is_finite())
    }

    /// The field magnitude in µT — `0.0` for a non-finite sample.
    pub fn norm_ut(&self) -> f32 {
        if !self.is_finite() {
            return 0.0;
        }
        let [x, y, z] = self.field_ut;
        (x * x + y * y + z * z).sqrt()
    }
}

impl YawReference {
    /// True when the yaw is referenced to *any* external source (manual heading, magnetometer).
    pub fn is_referenced(self) -> bool {
        matches!(self, YawReference::Referenced | YawReference::Magnetic)
    }
}

/// One nine-axis step's result.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NineAxisStep {
    /// The attitude after this step. When [`NineAxisStep::magnetometer_used`] is `false`
    /// this is exactly what the 6-axis [`AttitudeEstimator::update`] produced; when it is
    /// `true` the quaternion was rebuilt with the magnetometer-derived yaw, so the yaw
    /// (and hence the whole attitude) differs from the 6-axis result.
    pub attitude: Attitude,
    /// True when the magnetometer was accepted and drove this step's yaw reference. False
    /// when the sample was non-finite or below the magnitude floor
    /// (`MIN_MAG_FIELD_UT`), in which case the state is left as the 6-axis step produced
    /// it.
    pub magnetometer_used: bool,
}

impl AttitudeEstimator {
    /// Run one 9-DOF step: the 6-axis update, then a magnetometer-derived yaw reference
    /// when the field is readable. A non-finite sample, or one whose magnitude is below
    /// [`MIN_MAG_FIELD_UT`] (5 µT), is skipped (yaw stays at whatever reference it had
    /// before).
    ///
    /// The yaw correction is **applied last**, after the gravity correction, so the
    /// existing 6-axis tests are unaffected. A magnetometer bias that gives a fixed yaw
    /// offset is recorded as a constant drift on `[YawReference::Magnetic]` and is what an
    /// operator reads as "the heading is referenced, but the offset is X degrees from
    /// true north".
    ///
    /// ```no_run
    /// use amos_robot::fusion::{AttitudeEstimator, ImuSample, MagSample, YawReference};
    /// # fn main() -> Result<(), amos_robot::fusion::FusionError> {
    /// let mut e = AttitudeEstimator::new();
    /// let att = e.update_with_mag(
    ///     &ImuSample::new([0.0, 0.0, 9.81], [0.0, 0.0, 0.0]),
    ///     // Body-frame Earth field (≈43 µT) for a level robot at 30° yaw:
    ///     // `Rz(-ψ)·[Bh, 0, Bv]` with `Bh = 20`, `Bv = 38`.
    ///     &MagSample::new([17.32, -10.0, 38.0]),
    ///     0.005,
    /// )?;
    /// assert!(matches!(att.attitude.yaw_reference, YawReference::Magnetic));
    /// # Ok(())
    /// # }
    /// ```
    pub fn update_with_mag(
        &mut self,
        sample: &ImuSample,
        mag: &MagSample,
        dt_s: f32,
    ) -> Result<NineAxisStep, FusionError> {
        let attitude = self.update(sample, dt_s)?;
        if !mag.is_finite() {
            // NaN and ±inf refuse to participate in the integration; the state stays
            // what the 6-axis step produced. The yaw reference is unchanged.
            return Ok(NineAxisStep {
                attitude,
                magnetometer_used: false,
            });
        }
        let mag_floor = MIN_MAG_FIELD_UT;
        if mag.norm_ut() < mag_floor {
            // Below the floor: a dropped magnetometer, a near-degaussed sensor, or a
            // body whose ferrous content swamps the Earth's field. The state is left
            // alone.
            return Ok(NineAxisStep {
                attitude,
                magnetometer_used: false,
            });
        }
        // Yaw from the magnetometer (tilt-compensated): atan2(my, mx·cos(roll) + mz·sin(roll)).
        // We extract roll/pitch from the current quaternion (no integration after the
        // 6-axis step — they are the same this instant).
        let (roll, pitch) = self.euler();
        let [mx, my, mz] = mag.field_ut;
        let cr = roll.cos();
        let sr = roll.sin();
        let cp = pitch.cos();
        let sp = pitch.sin();
        // Tilt-compensated components (see e.g. Honeywell AN-203).
        let x_h = mx * cp + my * sr * sp + mz * cr * sp;
        let y_h = my * cr - mz * sr;
        // The heading comes from the *horizontal* projection. If it is not observable — a
        // purely vertical field, e.g. a level robot next to a ferrous mass — `atan2(0, 0)`
        // returns 0, and the step would report `Magnetic` on a fabricated bearing. The
        // total-magnitude floor above cannot see this (a 20 µT vertical field passes it).
        // Refuse the same way an unusable accelerometer is reported rather than trusted.
        if (x_h * x_h + y_h * y_h).sqrt() < mag_floor {
            return Ok(NineAxisStep {
                attitude,
                magnetometer_used: false,
            });
        }
        // For an `R = Rz(ψ)·Ry(θ)·Rx(φ)` attitude and a field `Rᵀ·[Bh, 0, Bv]`, the
        // tilt-compensated components reduce to `x_h = Bh·cos ψ`, `y_h = −Bh·sin ψ`
        // (verified by expanding the rotation). So `atan2(y_h, x_h) = −ψ` — the heading is
        // the *negated* argument. Passing `−y_h` recovers `ψ`, matching the yaw the same
        // quaternion's `yaw()` extracts.
        let yaw_mag = wrap_pi((-y_h).atan2(x_h));
        // Rebuild the quaternion with the corrected yaw — same path as `set_heading`.
        self.quaternion = quaternion_from_euler(roll, pitch, yaw_mag);
        self.yaw_reference = YawReference::Magnetic;
        Ok(NineAxisStep {
            attitude: self.estimate(),
            magnetometer_used: true,
        })
    }
}

/// Lower bound on the magnetometer magnitude accepted as a valid Earth-field reference.
///
/// Applied twice: to the sensor's **total** magnitude (below 5 µT it is degaussed or
/// dominated by the robot's own ferrous signature) and to the **horizontal projection**
/// that actually yields a heading (`atan2` of two near-zero components is a fabricated
/// bearing, however strong the vertical component is).
pub const MIN_MAG_FIELD_UT: f32 = 5.0;

// ============================================================================
// Allan variance health monitor
// ============================================================================

/// A bounded-window Allan variance estimator. Records a gyro noise sample, reports the
/// running variance on demand, and a verdict on whether the noise floor is in
/// spec.
///
/// The window is a VecDeque of the last `N` samples, with `N` chosen at construction;
/// the variance is the standard overlapping Allan variance for an even integration
/// (the textbook formulation, mod the constant coefficients that drop out of any
/// p-pole-noise metric).
///
/// The verdict is **the noise floor itself**, not "is it a good reading". The intent is
/// that a deployment flashes a light when the variance has drifted to twice the
/// manufacturer-specified noise floor, regardless of what the estimator does with the
/// samples: an over-noisy gyro is a faulty gyro even if the estimator copes.
// The formula below divides by `2·(N − 1)`, so it needs at least a handful of differences
// to carry information; below this the estimate is dominated by its own denominator.
// (Not `// cited:` — this is a derivation from that formula, not a source; the formula
// itself is in `variance`'s body.)
const ALLAN_MIN_WINDOW: usize = 8;

/// Window length substituted at construction when a caller asks for fewer than
/// [`ALLAN_MIN_WINDOW`] samples.
const ALLAN_DEFAULT_WINDOW: usize = 64;

/// Upper bound on the retained window, in samples — a policy cap, not a measurement.
///
/// [`AllanVariance::new`] pre-sizes its `VecDeque` from the requested window, and an absurd
/// request (`usize::MAX`) makes `VecDeque::with_capacity` **panic** with "capacity overflow".
/// The contract is *substitute, not reject*, so a request above this is clamped to it rather
/// than turned into a fallible constructor. 1 Mi samples is 8 MiB of `f64`, far above any
/// meaningful Allan window, and keeps construction total.
const ALLAN_MAX_WINDOW: usize = 1 << 20;

/// Nominal noise floor substituted at construction for a non-finite or non-positive
/// request, in rad/s.
// chosen: **the "typical MEMS-class gyro" phrasing is a convention, not a measurement.**
// This crate has never characterised a gyro, and `record`/`variance` are fed whatever the
// caller supplies, so nothing here could have measured this. It is a starting default a
// deployment overrides with its own datasheet figure (see `AllanVariance::new`); an
// earlier `// measured:` marker claimed an experiment that does not exist.
const ALLAN_DEFAULT_NOMINAL_RAD_S: f64 = 0.01;

/// Failure multiplier substituted at construction for a non-finite or `<= 1` request.
const ALLAN_DEFAULT_FAILED_MULTIPLIER: f64 = 2.0;
#[derive(Clone, Debug)]
pub struct AllanVariance {
    /// The window length, set at construction. Larger windows are smoother, smaller
    /// windows react faster to step changes.
    window: std::collections::VecDeque<f64>,
    /// The nominal noise floor: a `f64` corresponding to the value published in the
    /// IMU's datasheet. The default of `0.01 rad/s` is a typical MEMS class.
    nominal_rad_s: f64,
    /// The `failed_at` threshold, in units of `nominal_rad_s`. The default of `2.0` is
    /// "twice the spec" — values beyond that declare the IMU unhealthy.
    failed_multiplier: f64,
}

impl AllanVariance {
    /// A monitor with a window of `window_size` samples, a nominal noise floor of
    /// `nominal_rad_s`, and a `failed_multiplier` of `failed`.
    ///
    /// Each argument is **substituted, not rejected**, when it cannot describe a working
    /// monitor: a `window_size` below 8 becomes 64 and one above `ALLAN_MAX_WINDOW` is
    /// clamped to it (an unbounded pre-size would make `VecDeque::with_capacity` *panic*);
    /// a non-finite or non-positive
    /// `nominal_rad_s` becomes `0.01 rad/s`; a non-finite or `<= 1.0` `failed_multiplier`
    /// becomes `2.0`. Rationale: a health monitor that
    /// refuses to exist protects nothing, and one configured with a degenerate window or
    /// a multiplier of 0 would report a verdict that means the opposite of what the
    /// caller asked for. Read back what was chosen via [`AllanVariance::window_size`].
    pub fn new(window_size: usize, nominal_rad_s: f64, failed_multiplier: f64) -> Self {
        let window_size = if !(ALLAN_MIN_WINDOW..=ALLAN_MAX_WINDOW).contains(&window_size) {
            if window_size > ALLAN_MAX_WINDOW {
                ALLAN_MAX_WINDOW
            } else {
                ALLAN_DEFAULT_WINDOW
            }
        } else {
            window_size
        };
        let nominal_rad_s = if nominal_rad_s.is_finite() && nominal_rad_s > 0.0 {
            nominal_rad_s
        } else {
            ALLAN_DEFAULT_NOMINAL_RAD_S
        };
        let failed_multiplier = if failed_multiplier.is_finite() && failed_multiplier > 1.0 {
            failed_multiplier
        } else {
            ALLAN_DEFAULT_FAILED_MULTIPLIER
        };
        Self {
            window: std::collections::VecDeque::with_capacity(window_size),
            nominal_rad_s,
            failed_multiplier,
        }
    }

    /// The window size the monitor keeps — the `VecDeque`'s capacity, which is at least
    /// the `window_size` requested at construction (a `VecDeque` may allocate a larger
    /// capacity than asked). Use this, not the requested value, to know how many samples
    /// [`AllanVariance::len`] can reach.
    pub fn window_size(&self) -> usize {
        self.window.capacity()
    }

    /// The current window length (≤ `window_size()`).
    pub fn len(&self) -> usize {
        self.window.len()
    }

    /// True when the window is empty.
    pub fn is_empty(&self) -> bool {
        self.window.is_empty()
    }

    /// Record one gyro sample. A non-finite sample is ignored (a deployed sensor that has
    /// hung is what the monitor **is** supposed to detect; the monitor must not feed its
    /// own NaN into the variance).
    pub fn record(&mut self, sample: f64) {
        if !sample.is_finite() {
            return;
        }
        if self.window.len() == self.window.capacity() {
            self.window.pop_front();
        }
        self.window.push_back(sample);
    }

    /// Compute the Allan variance over the window.
    ///
    /// Returns `None` when the window contains fewer than 8 samples (the Allan variance is
    /// ill-defined for short series).
    pub fn variance(&self) -> Option<f64> {
        let n = self.window.len();
        if n < ALLAN_MIN_WINDOW {
            return None;
        }
        // Overlapping Allan variance for τ = 1 sample:
        //   σ² = (1 / (2 · (N − 1))) · Σ (xᵢ₊₁ − xᵢ)²
        let mut sum_sq = 0.0f64;
        for i in 1..n {
            let dx = self.window[i] - self.window[i - 1];
            sum_sq += dx * dx;
        }
        Some(sum_sq / (2.0 * (n - 1) as f64))
    }

    /// The noise floor relative to the nominal — a multiplier `> 1.0` means the IMU is
    /// noisier than spec.
    pub fn multiplier(&self) -> Option<f64> {
        self.variance().map(|v| v.sqrt() / self.nominal_rad_s)
    }

    /// Verdict.
    ///
    /// `Unknown` when the window is short (fewer than 8 samples — no evidence yet),
    /// `Degraded` when the noise floor exceeds 1× but is below the failed multiplier,
    /// `Failed` when it reaches that multiplier.
    pub fn verdict(&self) -> AllanVerdict {
        match self.multiplier() {
            None => AllanVerdict::Unknown,
            Some(m) => {
                if m >= self.failed_multiplier {
                    AllanVerdict::Failed
                } else if m > 1.0 {
                    AllanVerdict::Degraded
                } else {
                    AllanVerdict::Healthy
                }
            }
        }
    }

    /// One line an operator can read.
    pub fn summary(&self) -> String {
        let v = self.variance();
        let m = self.multiplier();
        format!(
            "allan: verdict={} window={}/{} variance={} multiplier={}",
            self.verdict().key(),
            self.len(),
            self.window_size(),
            v.map(|x| format!("{x:.6}"))
                .unwrap_or_else(|| "-".to_string()),
            m.map(|x| format!("{x:.2}"))
                .unwrap_or_else(|| "-".to_string()),
        )
    }

    /// Clear the window (used after a sensor swap).
    pub fn clear(&mut self) {
        self.window.clear();
    }
}

/// The verdict the Allan variance reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AllanVerdict {
    /// The window has fewer than 8 samples — no variance to report.
    Unknown,
    /// The noise floor is inside the spec.
    Healthy,
    /// The noise floor is `> 1×` the nominal but below the failure threshold.
    Degraded,
    /// The noise floor crosses the failure threshold.
    Failed,
}

impl AllanVerdict {
    /// Stable key.
    pub fn key(self) -> &'static str {
        match self {
            AllanVerdict::Unknown => "unknown",
            AllanVerdict::Healthy => "healthy",
            AllanVerdict::Degraded => "degraded",
            AllanVerdict::Failed => "failed",
        }
    }
}

#[cfg(test)]
mod extras_tests {
    use super::*;

    /// The body-frame Earth field for a body at `(roll, pitch, yaw)`: `Rᵀ·[Bh, 0, Bv]` with
    /// `Rᵀ = Rx(-φ)·Ry(-θ)·Rz(-ψ)`. Built here from the rotation matrices directly (note each
    /// closure applies the *negative* of its argument), so the fixture shares no geometry
    /// with the estimator's own tilt-compensation formula — a sign error in one cannot cancel
    /// a sign error in the other.
    fn body_field(roll: f32, pitch: f32, yaw: f32, bh: f32, bv: f32) -> [f32; 3] {
        let rx = |a: f32, v: [f32; 3]| {
            [
                v[0],
                a.cos() * v[1] + a.sin() * v[2],
                -a.sin() * v[1] + a.cos() * v[2],
            ]
        };
        let ry = |a: f32, v: [f32; 3]| {
            [
                a.cos() * v[0] - a.sin() * v[2],
                v[1],
                a.sin() * v[0] + a.cos() * v[2],
            ]
        };
        let rz = |a: f32, v: [f32; 3]| {
            [
                a.cos() * v[0] + a.sin() * v[1],
                -a.sin() * v[0] + a.cos() * v[1],
                v[2],
            ]
        };
        rx(roll, ry(pitch, rz(yaw, [bh, 0.0, bv])))
    }

    /// The tilt-compensation terms (`sin r · sin p`, `cos r · sin p`, `cos r`, `sin r`) are
    /// the whole difference between a heading and a body-frame reading — and every one of
    /// them vanishes when roll and pitch are zero, which is the only case
    /// `the_magnetometer_recovers_the_true_heading_sign` exercises. A wrong tilt term leaves
    /// that test green and this one red.
    #[test]
    fn the_magnetometer_recovers_the_heading_when_the_body_is_tilted() {
        for (r_deg, p_deg, y_deg) in [
            (20.0f32, 0.0f32, 30.0f32),
            (0.0, 15.0, -45.0),
            (25.0, 15.0, 90.0),
        ] {
            let (roll, pitch, yaw) = (r_deg.to_radians(), p_deg.to_radians(), y_deg.to_radians());
            // Proportional-only so the settled tilt is exact: with the default `ki` the
            // integral learns a spurious bias through the settle transient (the boundary the
            // module docs name), leaving a steady roll/pitch offset that would be folded into
            // the tilt compensation and reported as a yaw error.
            let mut e = AttitudeEstimator::with_gains(1.0, 0.0);
            let gravity = ImuSample::new(
                [
                    -pitch.sin() * STANDARD_GRAVITY_M_S2,
                    pitch.cos() * roll.sin() * STANDARD_GRAVITY_M_S2,
                    pitch.cos() * roll.cos() * STANDARD_GRAVITY_M_S2,
                ],
                [0.0; 3],
            );
            for _ in 0..(6.0 / (1.0 / 200.0)) as u32 {
                e.update(&gravity, 1.0 / 200.0).expect("update");
            }
            let mag = body_field(roll, pitch, yaw, 20.0, 38.0);
            let step = e
                .update_with_mag(&gravity, &MagSample::new(mag), 1.0 / 200.0)
                .expect("update");
            assert!(step.magnetometer_used, "a ~43 µT field must be accepted");
            let err = wrap_pi(step.attitude.yaw_rad - yaw).to_degrees().abs();
            assert!(
                err < 0.5,
                "tilt ({r_deg}°, {p_deg}°) at heading {y_deg}° recovered as {}° (err {err}°)",
                step.attitude.yaw_rad.to_degrees()
            );
        }
    }

    #[test]
    fn mag_sample_norm_is_finite_for_finite_axes() {
        let m = MagSample::new([20.0, 0.0, 38.0]);
        assert!(m.is_finite());
        assert!((m.norm_ut() - 43.0).abs() < 1.0, "{}", m.norm_ut());

        // The documented contract for a non-finite axis is `0.0`, not `NaN`: a `NaN` norm
        // would poison the strength comparison that decides whether the field is usable.
        let bad = MagSample::new([f32::NAN, 0.0, 38.0]);
        assert!(!bad.is_finite());
        assert_eq!(bad.norm_ut(), 0.0, "a non-finite field must read as absent");
    }

    #[test]
    fn a_zero_field_magnetometer_does_not_drive_yaw() {
        let mut e = AttitudeEstimator::new();
        let att = e
            .update_with_mag(
                &ImuSample::new([0.0, 0.0, 9.81], [0.0, 0.0, 0.0]),
                &MagSample::new([0.0, 0.0, 0.0]),
                0.005,
            )
            .expect("update");
        assert!(!att.magnetometer_used);
        assert!(!att.attitude.yaw_reference.is_referenced());
    }

    /// A heading comes from the **horizontal** projection of the field. A field that is
    /// entirely vertical (a level robot beside a ferrous mass) has no horizontal component,
    /// so `atan2(0, 0)` returns `0` — a fabricated bearing. The total-magnitude guard cannot
    /// see this: 20 µT passes the 5 µT floor. The module's rule is refuse-over-fabricate, the
    /// same as an unusable accelerometer.
    #[test]
    fn a_purely_vertical_field_cannot_observe_yaw() {
        let mut e = AttitudeEstimator::new();
        let att = e
            .update_with_mag(
                &ImuSample::new([0.0, 0.0, 9.81], [0.0, 0.0, 0.0]),
                &MagSample::new([0.0, 0.0, 20.0]),
                0.005,
            )
            .expect("update");
        assert!(
            !att.magnetometer_used,
            "a vertical-only field has no heading to observe"
        );
        assert!(
            !att.attitude.yaw_reference.is_referenced(),
            "yaw must stay dead-reckoned, not become `Magnetic` on a fabricated 0"
        );
    }

    #[test]
    fn a_strong_field_drives_yaw_to_magnetic_reference() {
        let mut e = AttitudeEstimator::new();
        let att = e
            .update_with_mag(
                &ImuSample::new([0.0, 0.0, 9.81], [0.0, 0.0, 0.0]),
                // `[20, 0, 38]` is the body-frame field for a **level, north-facing**
                // robot (`ψ = 0`): `Rz(-0)·[20, 0, 38]`.
                &MagSample::new([20.0, 0.0, 38.0]),
                0.005,
            )
            .expect("update");
        assert!(att.magnetometer_used);
        assert!(matches!(att.attitude.yaw_reference, YawReference::Magnetic));
        assert!(
            att.attitude.yaw_rad.to_degrees().abs() < 0.1,
            "a north-facing field must give yaw 0, got {}°",
            att.attitude.yaw_rad.to_degrees()
        );
    }

    #[test]
    fn the_magnetometer_recovers_the_true_heading_sign() {
        // Round-trip the *tilt-compensated* solution the module documents. For a level
        // robot at yaw ψ the body-frame Earth field is `Rz(-ψ)·[Bh, 0, Bv]`. Feeding that
        // back must return +ψ, not −ψ (the sign a naive `atan2(y_h, x_h)` yields).
        for psi_deg in [30.0f32, -45.0, 90.0, 150.0] {
            let psi = psi_deg.to_radians();
            let (bh, bv) = (20.0f32, 38.0f32);
            let mag = [bh * psi.cos(), -bh * psi.sin(), bv];
            let mut e = AttitudeEstimator::new();
            let att = e
                .update_with_mag(
                    &ImuSample::new([0.0, 0.0, 9.81], [0.0, 0.0, 0.0]),
                    &MagSample::new(mag),
                    0.005,
                )
                .expect("update");
            let err = wrap_pi(att.attitude.yaw_rad - psi).to_degrees().abs();
            assert!(
                err < 0.5,
                "heading {psi_deg}° recovered as {}° (error {err}°)",
                att.attitude.yaw_rad.to_degrees()
            );
        }
    }

    #[test]
    fn nan_inputs_are_refused_not_propagated() {
        let mut e = AttitudeEstimator::new();
        let att = e
            .update_with_mag(
                &ImuSample::new([0.0, 0.0, 9.81], [0.0, 0.0, 0.0]),
                &MagSample::new([f32::NAN, 0.0, 1.0]),
                0.005,
            )
            .expect("update");
        assert!(!att.magnetometer_used);
    }

    /// An absurd window request must be *substituted, not rejected* — and must not panic.
    /// `AllanVariance::new` pre-sizes its `VecDeque` from the argument, so `usize::MAX` made
    /// `VecDeque::with_capacity` panic with "capacity overflow", contradicting the
    /// constructor's own contract.
    #[test]
    fn an_absurd_allan_window_is_clamped_not_a_panic() {
        let av = AllanVariance::new(usize::MAX, 0.01, 2.0);
        assert_eq!(av.window_size(), ALLAN_MAX_WINDOW);
        assert!(av.window_size() <= ALLAN_MAX_WINDOW);
    }

    #[test]
    fn allan_variance_unknown_for_short_window() {
        let mut av = AllanVariance::new(64, 0.01, 2.0);
        for _ in 0..5 {
            av.record(0.005);
        }
        assert!(matches!(av.verdict(), AllanVerdict::Unknown));
        assert_eq!(av.variance(), None);
    }

    #[test]
    fn allan_variance_healthy_for_quiet_gyro() {
        // White noise around 0 with σ ≈ 0.005 rad/s.
        let mut av = AllanVariance::new(256, 0.01, 2.0);
        for i in 0..200 {
            // Deterministic pseudo-noise; not noise per se, but a recognisable envelope.
            let v = 0.005 * ((i as f64 * 0.31).sin());
            av.record(v);
        }
        let v = av.variance().expect("variance");
        // The first difference of `A·sin(k·i)` is bounded by `A·k = 1.55e-3`, so the
        // variance (half the mean squared first difference) sits near `1.2e-6`; the
        // multiplier is `√v / nominal ≈ 0.11`, comfortably below the `1.0` Healthy line.
        assert!(v < 0.05, "v={v}");
        let m = av.multiplier().expect("mult");
        assert!(m < 1.0, "quiet gyro must not cross the nominal, m={m}");
        assert_eq!(av.verdict(), AllanVerdict::Healthy);
    }

    /// The band between `Healthy` and `Failed`: a gyro noisier than nominal but not yet at
    /// the failure multiplier must read `Degraded`, not fall through to either neighbour.
    /// The alternating signal gives an exactly-known multiplier (`√(Δ²/2) / nominal`), so the
    /// verdict is pinned by arithmetic rather than by a threshold coincidence.
    #[test]
    fn allan_variance_degraded_between_the_nominal_and_failure_lines() {
        // Δ chosen so √(Δ²/2) / 0.01 = 1.5 — halfway between the 1× and 2× lines.
        let delta = 0.015_f64 * std::f64::consts::SQRT_2;
        let mut av = AllanVariance::new(64, 0.01, 2.0);
        for i in 0..64 {
            av.record(if i % 2 == 0 { 0.0 } else { delta });
        }
        let m = av.multiplier().expect("mult");
        assert!(m > 1.0 && m < 2.0, "expected the degraded band, m={m}");
        assert_eq!(av.verdict(), AllanVerdict::Degraded);
    }

    /// Every `FusionError` must render a cause an operator can act on. Each arm is asserted
    /// on a token unique to it — a shared or copied arm would render the wrong text.
    #[test]
    fn every_fusion_error_renders_its_cause() {
        let cases: [(FusionError, &[&str]); 3] = [
            (FusionError::NonFiniteSample, &["non-finite"]),
            (FusionError::DeltaTime { dt_s: -0.5 }, &["positive", "-0.5"]),
            (FusionError::Gap { dt_s: 1.5 }, &["1.5", "reset()"]),
        ];
        let mut seen = Vec::new();
        for (err, needles) in cases {
            let line = err.to_string();
            for n in needles {
                assert!(line.contains(n), "`{line}` must mention `{n}`");
            }
            assert!(
                !seen.contains(&line),
                "two errors rendered identically: `{line}`"
            );
            seen.push(line);
        }
    }

    /// `Default` must be the same level, still estimator as `new`, not a second drifting
    /// initialiser — a caller's `#[derive(Default)]` struct reaches for this.
    #[test]
    fn the_default_estimator_equals_a_fresh_one() {
        assert_eq!(
            AttitudeEstimator::default().estimate(),
            AttitudeEstimator::new().estimate()
        );
    }

    #[test]
    fn allan_variance_failed_for_a_noisy_gyro() {
        // Drive a large variance by adding step changes.
        let mut av = AllanVariance::new(64, 0.01, 2.0);
        for i in 0..64 {
            let v = if i % 2 == 0 { 0.5 } else { -0.5 };
            av.record(v);
        }
        let m = av.multiplier().expect("mult");
        // Every first difference is ±1.0, so the variance is exactly 0.5 and the
        // multiplier is `√0.5 / 0.01 ≈ 70.7` — far past the `2.0` failure threshold.
        assert!(m > 1.0, "m={m}");
        assert!(
            m >= 2.0,
            "noisy gyro must cross the failure threshold, m={m}"
        );
        assert_eq!(av.verdict(), AllanVerdict::Failed);
    }

    #[test]
    fn allan_variance_failed_threshold_is_the_multiplier() {
        let mut av = AllanVariance::new(64, 0.01, 1.5);
        // A random-walk signal: the integrator of zero-mean noise has a
        // growing variance that the Allan variance flags as Failed once the
        // multiplier exceeds the threshold.
        let mut s = 0.0f64;
        let mut rng = 0x12345678u64;
        for _ in 0..128 {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            let r = ((rng >> 11) as f64) / ((1u64 << 53) as f64) - 0.5;
            s += r * 0.2;
            av.record(s);
        }
        let m = av.multiplier().expect("mult");
        assert!(m > 1.5, "m={m}");
        assert_eq!(av.verdict(), AllanVerdict::Failed);
    }

    #[test]
    fn a_clear_empties_the_window() {
        let mut av = AllanVariance::new(16, 0.01, 2.0);
        for _ in 0..16 {
            av.record(0.05);
        }
        assert_eq!(av.len(), 16);
        av.clear();
        assert!(av.is_empty());
    }

    #[test]
    fn invalid_parameters_are_replaced_with_safe_defaults() {
        let av = AllanVariance::new(2, -1.0, 0.5);
        assert_eq!(av.window_size(), 64);
        assert_eq!(av.multiplier(), None);
    }

    /// The two `is_finite()` leaves of [`AllanVariance::new`], which only `+∞` walks — and
    /// why adopting `∞` *disarms* the monitor rather than merely mis-tuning it.
    ///
    /// `new`'s doc names non-finite explicitly ("a non-finite or non-positive `nominal_rad_s`
    /// becomes `0.01 rad/s`; a non-finite or `<= 1.0` `failed_multiplier` becomes `2.0`").
    /// Measured: deleting either `is_finite() &&` leaf leaves the whole crate green (392
    /// passed), because the invalid-parameter test above feeds `-1.0` / `0.5` — both caught
    /// by the sibling `> 0.0` / `> 1.0` leaf — and a `NaN` is caught there too (`NaN > 0.0`
    /// is `false`), so `+∞` is the sole input that reaches each finiteness leaf alone.
    ///
    /// The consequence is a **monitor that always says `Healthy`**: `multiplier()` is
    /// `variance().sqrt() / nominal_rad_s`, so an adopted `∞` collapses it to `0.0` and
    /// `verdict()` returns `Healthy` for any gyro, however noisy. An adopted `∞`
    /// `failed_multiplier` makes `m >= failed_multiplier` unsatisfiable, so `Failed` becomes
    /// unreachable while `Degraded` still reports.
    #[test]
    fn an_infinite_allan_parameter_is_substituted_not_adopted() {
        // A ±0.5 rad/s alternation: variance = 2·A² = 0.5, so under the *default* nominal
        // (0.01) the multiplier is sqrt(0.5)/0.01 ≈ 70.7 — far past either threshold.
        let noisy = |av: &mut AllanVariance| {
            for i in 0..8 {
                av.record(if i % 2 == 0 { 0.5 } else { -0.5 });
            }
        };
        let mut av = AllanVariance::new(64, f64::INFINITY, f64::INFINITY);
        noisy(&mut av);
        assert!(
            av.multiplier().expect("a full window") > 2.0,
            "an ∞ nominal must be substituted, not adopted: adopting it forces the \
             multiplier to 0 and the verdict to Healthy forever, got {:?}",
            av.multiplier()
        );
        assert_eq!(
            av.verdict(),
            AllanVerdict::Failed,
            "an ∞ failed_multiplier must be substituted, or `Failed` becomes unreachable"
        );

        // Control: the same series under a sane configuration reaches `Failed` on its own,
        // so the assertions above are not passing because every window reports `Failed`.
        let mut sane = AllanVariance::new(64, 0.01, 2.0);
        noisy(&mut sane);
        assert_eq!(sane.verdict(), AllanVerdict::Failed);
    }

    #[test]
    fn nan_samples_are_ignored() {
        let mut av = AllanVariance::new(64, 0.01, 2.0);
        for _ in 0..64 {
            av.record(f64::NAN);
        }
        assert!(av.is_empty(), "NaN samples must not enter the window");
    }

    /// The keys are what an operator greps for, so they are pinned literally — an enum
    /// rename that silently changed a log key would otherwise pass every other test here.
    #[test]
    fn allan_verdict_keys_are_stable() {
        assert_eq!(AllanVerdict::Unknown.key(), "unknown");
        assert_eq!(AllanVerdict::Healthy.key(), "healthy");
        assert_eq!(AllanVerdict::Degraded.key(), "degraded");
        assert_eq!(AllanVerdict::Failed.key(), "failed");
    }

    #[test]
    fn allan_summary_names_the_verdict_and_the_missing_values() {
        // A short window has no verdict and no numbers: both render as `-`, not as `0`.
        let mut av = AllanVariance::new(16, 0.01, 2.0);
        let line = av.summary();
        assert!(
            line.contains("verdict=unknown") && line.contains("variance=-"),
            "empty window summary: {line}"
        );
        // A quiet window at the nominal floor is healthy, and the multiplier is a number.
        for _ in 0..16 {
            av.record(0.005);
        }
        let line = av.summary();
        assert!(
            line.contains("verdict=healthy") && !line.contains("multiplier=-"),
            "populated window summary: {line}"
        );
    }

    /// `is_gravity_referenced` must track the correction, not be a constant. The two
    /// samples are the documented pair: a level one (gravity readable) and a 2 g push.
    #[test]
    fn is_gravity_referenced_follows_the_correction() {
        let mut estimator = AttitudeEstimator::new();
        let level = ImuSample::new([0.0, 0.0, STANDARD_GRAVITY_M_S2], [0.0, 0.0, 0.0]);
        let attitude = estimator.update(&level, 0.005).expect("update");
        assert!(
            attitude.is_gravity_referenced(),
            "a level sample must be gravity-referenced: {:?}",
            attitude.correction
        );
        let pushing = ImuSample::new([0.0, 0.0, 2.0 * STANDARD_GRAVITY_M_S2], [0.0, 0.0, 0.0]);
        let attitude = estimator.update(&pushing, 0.005).expect("update");
        assert!(
            !attitude.is_gravity_referenced(),
            "a 2 g push must not be gravity-referenced"
        );
    }

    /// `is_referenced` is the "is the yaw anchored to anything?" predicate; both external
    /// sources must answer yes and the dead-reckoned default no. A `matches!` that dropped
    /// one variant would pass a test that only checked `DeadReckoned`.
    #[test]
    fn yaw_reference_is_referenced_covers_both_external_sources() {
        assert!(!YawReference::DeadReckoned.is_referenced());
        assert!(YawReference::Referenced.is_referenced());
        assert!(YawReference::Magnetic.is_referenced());
    }
}
