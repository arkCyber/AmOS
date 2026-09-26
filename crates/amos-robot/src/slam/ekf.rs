//! The EKF-SLAM core: state, prediction, observation, maintain.
//!
//! Matrix indexing throughout this file uses the verbose `row * cap + col`
//! form even when the row is zero or one (e.g. `0 * cap + j`,
//! `1 * active + 2`); the literal form is the clearest way to read a
//! flat-row-major matrix multiply against the symmetry tests, and matches the
//! textbook layout the comments cite. We allow `clippy::identity_op` and
//! `clippy::erasing_op` for this file on purpose.
//!
#![allow(clippy::identity_op, clippy::erasing_op)]

//! ### State
//!
//! ```text
//!     x = [ robot_x, robot_y, robot_θ, lm1_x, lm1_y, lm2_x, lm2_y, … ]ᵀ
//! ```
//!
//! * Robot pose: 3 floats (`f32`), in metres and radians.
//! * Landmark positions: 2 floats each (`f32` per axis).
//! * State dimension: `dim = 3 + 2 · num_landmarks`.
//!
//! The covariance is a `dim × dim` matrix stored in a single flat `Vec<f32>`. We never
//! read or write the matrix outside this module — the public API takes the dimensions
//! it needs and computes the right index. A unit test that took the matrix directly would
//! couple to its layout, which is exactly what the abstraction exists to prevent.
//!
//! ### Honest boundaries
//!
//! 1. **Bounded landmark count.** [`MAX_LANDMARKS`] = 512. A larger map is the SLAM front-end
//!    for a tile store, not this file.
//! 2. **Bounded state dimension.** The state vector and covariance are sized at
//!    `3 + 2 · MAX_LANDMARKS` = 1027, so the covariance `Vec<f32>` alone is `1027² · 4 B` ≈
//!    4.0 MiB — and `SlamState` also holds two same-sized scratch buffers (`scratch_a`,
//!    `scratch_b`), so one state costs ≈ **12 MiB**, not 4. The alternative is a sparse
//!    representation, which is correct but is a separate algorithm (see "sparse EKF-SLAM",
//!    not this file).
//! 3. **No automatic relinearisation.** The state mean is held as `f32`; the covariance is
//!    symmetrised after every update ([`SlamState::symmetrise_covariance`]). A filter that
//!    silently accepts a non-PD covariance would diverge.
use std::f32::consts::PI;

use super::data_assoc::{Association, CHI2_2DOF_95};
use super::landmarks::Landmark;

/// Largest map this module will hold, in landmarks. Beyond this, new observations are
/// refused with [`SlamError::MapFull`].
pub const MAX_LANDMARKS: usize = 512;

/// Robot dimension (x, y, θ) — the part of the state that is *not* a landmark.
pub const ROBOT_DIM: usize = 3;

/// Dimension per landmark.
pub const LM_DIM: usize = 2;

/// Range (m) below which a landmark is treated as coincident with the sensor origin and
/// the bearing Jacobian (`∂φ/∂x = dy/q²`) is refused as singular.
const MIN_RANGE_M: f32 = 1e-6;

/// Smallest acceptable determinant of the 2×2 innovation covariance `S`. A determinant at
/// or below this is numerically singular and `S⁻¹` is not trusted.
const MIN_INNOVATION_DET: f32 = 1e-12;

/// Smallest process-noise variance accepted from [`SlamControl`]. A caller may pass `0`
/// for "perfect odometry", but a zero-diagonal `Q` lets the covariance collapse and the
/// filter stop learning; the floor keeps it positive-definite.
const MIN_PROCESS_NOISE: f32 = 1e-6;

/// Largest reading batch [`SlamState::associate_joint`] will jointly associate. The JCBB
/// search is exponential in the batch size, so this is the bound that keeps one step's work
/// finite (NASA "Power of 10" rule 2 — every loop must have a statically known upper bound).
/// A larger sweep is refused with [`SlamError::TooManyObservations`].
pub const MAX_JCBB_OBSERVATIONS: usize = 8;

/// How many candidate landmarks JCBB keeps per observation — the best by individual gate.
///
/// // chosen: a branch-and-bound prior, not a sensor property. The candidates kept are the
/// // individually-most-consistent ones, so a true match outside this set is one whose single
/// // gate already ranked it ninth-best, which the individual gate is meant to have pruned.
pub const MAX_JCBB_CANDIDATES: usize = 8;

/// Hard cap on search nodes examined in one [`SlamState::associate_joint`] call. On reaching
/// it the search returns the **best hypothesis found so far** — a bounded, deterministic
/// answer rather than an unbounded search. The cap is what makes the exponential branch-and-
/// bound terminate on a pathological candidate set.
pub const MAX_JCBB_NODES: usize = 4096;

/// Joint dimension of the largest hypothesis: `2 · MAX_JCBB_OBSERVATIONS` (range + bearing per
/// pair). Sizes the fixed search buffers.
const MAX_JCBB_DIM: usize = 2 * MAX_JCBB_OBSERVATIONS;

/// Smallest pivot magnitude the joint-compatibility solver accepts. Below it the stacked
/// innovation covariance is treated as singular and the hypothesis is **pruned** (see
/// [`SlamState::associate_joint`]) — a deliberate deviation from `innovation_gate_squared`'s
/// refusal, because in a search a degenerate branch has alternatives to fall back to.
const MIN_JCBB_PIVOT: f32 = 1e-12;
/// The 95% upper quantile of `χ²(k)` for the **even** degrees of freedom JCBB tests with: a
/// hypothesis of `m` pairs stacks `2m` innovations, so `k = 2m`. Entry `i` is `k = 2(i+1)`.
///
/// // cited: standard `χ²` table (NIST/SEMATECH e-Handbook §1.3.6.7.4). The joint gate is the
/// // same 95% confidence [`CHI2_2DOF_95`] uses for one pair; the threshold grows with the
/// // dimension because the statistic is a sum of `k` squared normalized innovations. These are
/// // applied to the **squared** Mahalanobis distance, so they are not square-rooted.
const CHI2_95_EVEN: [f32; MAX_JCBB_OBSERVATIONS] =
    [5.991, 9.488, 12.592, 15.507, 18.307, 21.026, 23.685, 26.296];

/// A 2-D odometry-style control input: forward speed in metres per second, yaw rate in
/// radians per second. SI units and a body-frame convention, stated here rather than
/// borrowed — there is no middleware type to point at. (`amos_link::robot_hal::Gait` is a
/// gait *name* — `stand`/`trot`/… — that expands to joint angles, not a velocity, and the
/// middleware exposes no `linear_m_s`/`angular_rad_s` field anywhere; an earlier revision of
/// this doc claimed "the same convention `Gait` uses after the `frame → motion` transform",
/// which names a transform that exists nowhere in the workspace.)
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VelocityCommand {
    /// Forward speed (m/s). Negative means "reverse".
    pub linear_m_s: f32,
    /// Yaw rate (rad/s). Positive is counter-clockwise in the world frame.
    pub angular_rad_s: f32,
    /// Period the command is held (s). The integration is `x += v · dt`, `θ += ω · dt`.
    pub dt_s: f32,
}

/// What one observation contributes to the filter.
///
/// `range_m` and `bearing_rad` are in the sensor's own frame (range forward, bearing
/// counter-clockwise from forward). The Jacobian and the predicted measurement are
/// computed against the current state estimate.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SlamObservation {
    /// Range to the landmark (m).
    pub range_m: f32,
    /// Bearing to the landmark (rad, counter-clockwise from sensor x axis).
    pub bearing_rad: f32,
    /// Variance of the range measurement (m²).
    pub range_variance: f32,
    /// Variance of the bearing measurement (rad²).
    pub bearing_variance: f32,
    /// Optional sensor-frame x offset (m). A lidar whose origin is not the robot centre
    /// passes the offset here; `0` is "the sensor is at the robot centre".
    pub sensor_offset_x_m: f32,
    /// Optional sensor-frame y offset (m).
    pub sensor_offset_y_m: f32,
}

impl SlamObservation {
    /// A 2-D lidar reading at the robot's centre, with the variances a typical planar
    /// scanner reports (`0.05² m` range, `0.5°²` bearing).
    pub fn lidar(range_m: f32, bearing_rad: f32) -> Self {
        Self {
            range_m,
            bearing_rad,
            range_variance: 0.0025,
            bearing_variance: (PI / 360.0) * (PI / 360.0),
            sensor_offset_x_m: 0.0,
            sensor_offset_y_m: 0.0,
        }
    }
}

/// What the EKF refused to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlamError {
    /// [`MAX_LANDMARKS`] was reached: a new observation cannot become a new landmark.
    MapFull,
    /// The Jacobian hit a singular sub-matrix (e.g. the landmark lies on the robot).
    Singular,
    /// An input carried a non-finite value or a negative variance, or a value whose
    /// magnitude overflowed the derived landmark position to a non-finite one.
    BadInput,
    /// A batch handed to [`SlamState::associate_joint`] carried more than
    /// [`MAX_JCBB_OBSERVATIONS`] readings. The joint search is exponential in the batch size,
    /// so an oversized sweep is **refused** (with the count) rather than silently truncated
    /// or searched unboundedly; split it across calls.
    TooManyObservations {
        /// How many readings were offered.
        given: usize,
    },
}

impl std::fmt::Display for SlamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SlamError::MapFull => write!(
                f,
                "the map already holds {MAX_LANDMARKS} landmarks: a new observation cannot \
                 become another one"
            ),
            SlamError::Singular => write!(
                f,
                "the innovation Jacobian is singular (a landmark on top of the robot has no \
                 bearing to observe): the update was refused"
            ),
            SlamError::BadInput => write!(
                f,
                "an input carried a non-finite value, a negative variance, or a magnitude \
                 that overflowed the landmark position: the state was left untouched"
            ),
            SlamError::TooManyObservations { given } => write!(
                f,
                "{given} readings exceeds MAX_JCBB_OBSERVATIONS ({MAX_JCBB_OBSERVATIONS}): \
                 the joint search is exponential in the batch size, so split the sweep"
            ),
        }
    }
}

impl std::error::Error for SlamError {}

/// A lever the caller can flip to trade off work against information.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SlamControl {
    /// The gate on the **squared** Mahalanobis distance (`d² ~ χ²(2)`). The 95% quantile
    /// of `χ²(2)` is [`CHI2_2DOF_95`] (`5.991`), so the default accepts the 95%
    /// most-consistent matches and rejects the rest. (A value of `5.99² ≈ 35.9` would be a
    /// 5.99-σ gate — effectively ungated — which is *not* the 95% the name suggests.)
    pub gate_squared: f32,
    /// When the EKF observes a landmark the **first** time, its initial covariance is
    /// a large value (the landmark's position is uncertain). The default is `1.0 m²`.
    ///
    /// // policy: a fresh landmark is given a 1 m standard deviation. That is not a
    /// measured sensor property — it is the "uninformative prior" choice, wide enough that
    /// the first real update pulls the estimate most of the way to the reading, and it is
    /// the value every unit test here is calibrated against.
    pub initial_landmark_variance: f32,
    /// Odometry process-noise density for translation (m²/s²), added to the robot's x/y
    /// variance as `q · dt²` each prediction. This is a property of the *motion* model;
    /// it previously rode on `initial_landmark_variance`, which is a property of the
    /// *landmark* model — two unrelated quantities that happened to share a constant.
    ///
    /// // policy, not measurement: a per-odometry-characterisation value. The default
    /// (`0.1`) is the number the old implicit derivation produced at the default landmark
    /// variance, so removing the coupling left the filter's behaviour unchanged. A
    /// deployment should replace it with the covariance of its own wheel-odometry drift.
    pub process_noise_linear: f32,
    /// Odometry process-noise density for heading (rad²/s²), added to the robot's θ
    /// variance as `q · dt²` each prediction.
    ///
    /// // policy, not measurement — see [`SlamControl::process_noise_linear`]. The default
    /// (`0.05`) is likewise the value the old derivation produced, not a measured IMU or
    /// odometry figure.
    pub process_noise_angular: f32,
}

impl Default for SlamControl {
    fn default() -> Self {
        Self {
            gate_squared: CHI2_2DOF_95,
            initial_landmark_variance: 1.0,
            // The values the previous implicit derivation (`initial_landmark_variance`
            // × 0.1 / × 0.05) produced at the default landmark variance, so the default
            // filter behaviour is unchanged — only the coupling is removed.
            process_noise_linear: 0.1,
            process_noise_angular: 0.05,
        }
    }
}

/// The full SLAM state: pose, landmarks, the full covariance, the running counts.
#[derive(Clone, Debug)]
pub struct SlamState {
    /// Robot pose (x, y, θ).
    pose: [f32; ROBOT_DIM],
    /// Landmark list — `landmarks.len() == num_landmarks`.
    landmarks: Vec<Landmark>,
    /// The full covariance, row-major. `Σ[0..3, 0..3]` is the robot sub-matrix,
    /// `Σ[3+2i..3+2i+2, 3+2i..3+2i+2]` is landmark `i`'s. Indexed by [`SlamState::idx`].
    covariance: Vec<f32>,
    /// Scratch buffer A, sized to `capacity²`. Reused by `predict` and
    /// `update_landmark` so neither routine allocates on the hot path
    /// (NASA Power of 10 §2: no allocation in inner loops). Allocated once
    /// in [`SlamState::with_pose`].
    scratch_a: Vec<f32>,
    /// Scratch buffer B, sized to `capacity²` — see [`SlamState::scratch_a`]. The two
    /// buffers let the covariance products ping-pong without an intermediate copy.
    scratch_b: Vec<f32>,
}

impl SlamState {
    /// A fresh state, pose at the origin, no landmarks, identity covariance on the robot
    /// (`0.1²` for x/y, `0.05²` for θ) and zeros everywhere else.
    pub fn new() -> Self {
        Self::with_pose([0.0, 0.0, 0.0], 0.1, 0.05)
    }

    /// A fresh state with the given pose and the given robot initial covariance.
    /// `pose_sigma_m` is the σ for x/y, `heading_sigma_rad` for θ.
    pub fn with_pose(pose: [f32; 3], pose_sigma_m: f32, heading_sigma_rad: f32) -> Self {
        let dim = ROBOT_DIM + 2 * MAX_LANDMARKS;
        let mut covariance = vec![0.0f32; dim * dim];
        // Robot block — identity * σ².
        let mut set = |row: usize, col: usize, value: f32| {
            let k = row * dim + col;
            if let Some(slot) = covariance.get_mut(k) {
                *slot = value;
            }
        };
        let p = pose_sigma_m.max(0.0);
        set(0, 0, p * p);
        set(1, 1, p * p);
        let h = heading_sigma_rad.max(0.0);
        set(2, 2, h * h);
        // Scratch buffers are sized to the full capacity so `predict` /
        // `update_landmark` never allocate on the hot path. The two `dim*dim`
        // buffers are each ~4 MiB at `MAX_LANDMARKS = 512`. Allocated once per
        // `SlamState`, paid once per deployment, not once per `predict` /
        // `observe` step.
        let scratch_a = vec![0.0f32; dim * dim];
        let scratch_b = vec![0.0f32; dim * dim];
        Self {
            pose,
            landmarks: Vec::new(),
            covariance,
            scratch_a,
            scratch_b,
        }
    }

    /// The robot pose.
    pub fn pose(&self) -> [f32; 3] {
        self.pose
    }

    /// The landmark list.
    pub fn landmarks(&self) -> &[Landmark] {
        &self.landmarks
    }

    /// The number of landmarks currently in the map.
    pub fn num_landmarks(&self) -> usize {
        self.landmarks.len()
    }

    /// The state dimension (`3 + 2 · num_landmarks`).
    pub fn dim(&self) -> usize {
        ROBOT_DIM + LM_DIM * self.landmarks.len()
    }

    /// The **stride** (row length) of the covariance — the number of columns, not the total
    /// cell count (`capacity²`). Fixed at `3 + 2 · MAX_LANDMARKS` = 1027 and independent of
    /// the current state dim, so the flat `Vec<f32>` is indexed `row * capacity + col`.
    pub fn capacity(&self) -> usize {
        ROBOT_DIM + LM_DIM * MAX_LANDMARKS
    }

    /// Read a covariance cell, or `0.0` outside the active state.
    ///
    /// Private by design: the module doc promises the `dim × dim` layout never escapes this
    /// file, and a caller that indexed `Σ` directly would couple to that layout (and to the
    /// pre-allocated `capacity` stride) — the exact coupling the abstraction exists to
    /// prevent. External code reads a landmark's uncertainty through [`Landmark::cov`].
    fn cov(&self, row: usize, col: usize) -> f32 {
        let dim = self.capacity();
        if row >= dim || col >= dim {
            return 0.0;
        }
        let active = self.dim();
        if row >= active || col >= active {
            return 0.0;
        }
        self.covariance.get(row * dim + col).copied().unwrap_or(0.0)
    }

    /// Write a covariance cell (the caller is responsible for symmetry).
    ///
    /// The cell must be inside the **pre-allocated** block ([`SlamState::capacity`]),
    /// not just the active block. Reading via [`SlamState::cov`] refuses cells outside
    /// the active block, but writes to inactive rows are how `add_landmark` seeds a new
    /// landmark without first extending the state. Private for the same reason as
    /// [`SlamState::cov`].
    fn set_cov(&mut self, row: usize, col: usize, value: f32) {
        let dim = self.capacity();
        if row >= dim || col >= dim {
            return;
        }
        let k = row * dim + col;
        if let Some(slot) = self.covariance.get_mut(k) {
            *slot = value;
        }
    }

    /// Enforce `Σ = Σᵀ`. Cheap (`dim² / 2` reads), and run after every update.
    pub fn symmetrise_covariance(&mut self) {
        let active = self.dim();
        for i in 0..active {
            for j in (i + 1)..active {
                let a = self.cov(i, j);
                let b = self.cov(j, i);
                let avg = 0.5 * (a + b);
                self.set_cov(i, j, avg);
                self.set_cov(j, i, avg);
            }
        }
    }

    /// Add one landmark; returns its index, or [`SlamError::MapFull`] if the cap is hit.
    fn add_landmark(&mut self, landmark: Landmark) -> Result<u16, SlamError> {
        if self.landmarks.len() >= MAX_LANDMARKS {
            return Err(SlamError::MapFull);
        }
        let index = self.landmarks.len() as u16;
        let lx = ROBOT_DIM + LM_DIM * self.landmarks.len();
        // Initial covariance: a large value on the diagonal, zero cross-correlation.
        // Defensive second line: since `observe` validates `initial_landmark_variance`
        // before `Landmark::new` is called, this arm is **unreachable via `observe`** for a
        // negative/NaN variance — the value can no longer arrive pre-sanitised to `0.0`.
        // It is kept as a last-line gate on the sole private caller, and is deliberately not
        // given a fabricated test (the crate documents unreachable branches rather than
        // manufacturing coverage).
        let v = landmark.cov[0];
        if !v.is_finite() || v < 0.0 {
            return Err(SlamError::BadInput);
        }
        self.set_cov(lx, lx, v);
        self.set_cov(lx + 1, lx + 1, v);
        self.landmarks.push(landmark);
        // The new landmark is "observed" once the call that added it integrated it; we
        // set the flag here, the caller is the one that increments `observations`.
        if let Some(lm) = self.landmarks.last_mut() {
            lm.ever_observed = true;
        }
        Ok(index)
    }

    /// **Prediction step**: integrate one velocity command into the pose, expand the
    /// covariance with the motion model Jacobian `F_x` and the process noise `Q`.
    ///
    /// *Motion model*: a unicycle (`x' = x + v·cos(θ)·dt`, `y' = y + v·sin(θ)·dt`,
    /// `θ' = θ + ω·dt`). The Jacobian against the robot pose is exact for this model; the
    /// landmark Jacobian is the identity (they don't move with the robot).
    pub fn predict(
        &mut self,
        command: VelocityCommand,
        control: &SlamControl,
    ) -> Result<(), SlamError> {
        if !command.linear_m_s.is_finite()
            || !command.angular_rad_s.is_finite()
            || !command.dt_s.is_finite()
            || command.dt_s <= 0.0
        {
            return Err(SlamError::BadInput);
        }

        let [x, y, theta] = self.pose;
        let v = command.linear_m_s;
        let w = command.angular_rad_s;
        let dt = command.dt_s;
        let cos_t = theta.cos();
        let sin_t = theta.sin();

        // ① Integrate the pose into a local. It is committed together with the
        // covariance at the end, so a covariance step that fails validation leaves the
        // whole state untouched rather than half-advanced.
        let new_pose = [x + v * cos_t * dt, y + v * sin_t * dt, theta + w * dt];
        // Refuse a non-finite pose before it is committed. The covariance guard at the end
        // inspects only `scratch_b`: a `NaN` x/y with a finite heading leaves `f_02`/`f_12`
        // finite, so the covariance stays finite, the guard passes, and `NaN` reaches
        // `self.pose` under an `Ok` — the silent corruption the covariance guard exists to
        // prevent, one buffer over.
        if new_pose.iter().any(|v| !v.is_finite()) {
            return Err(SlamError::BadInput);
        }

        // ② Build the motion Jacobian F_x (sparse — robot rows only).
        let active = self.dim();
        let cap = self.capacity();
        // Clear the **whole** scratch_b (not just the active block) so stale
        // data from a previous step doesn't leak into inactive cells of
        // self.covariance through the copy-back at the end of `predict`.
        for slot in self.scratch_b.iter_mut() {
            *slot = 0.0;
        }
        // `fx` lives in scratch_a; reused on every step (no per-step allocation).
        for slot in self.scratch_a.iter_mut().take(active * active) {
            *slot = 0.0;
        }
        // (Index form `i * active + i` keeps the row-major matrix layout
        // explicit, which is what clippy is asking about when `i = 0`.)
        for i in 0..active {
            self.scratch_a[i * active + i] = 1.0;
        }
        // ∂(x')/∂θ = -v sin(θ) dt
        // ∂(y')/∂θ = +v cos(θ) dt
        self.scratch_a[0 * active + 2] = -v * sin_t * dt;
        self.scratch_a[1 * active + 2] = v * cos_t * dt;

        // ③ Process noise — applied at the end of Phase 2, after `tmp · Fᵀ` has been
        // written into scratch_b. These are motion-model densities, independent of the
        // landmark initialisation variance.
        let q_lin = control.process_noise_linear.max(MIN_PROCESS_NOISE);
        let q_ang = control.process_noise_angular.max(MIN_PROCESS_NOISE);

        // ④ Σ' = F Σ Fᵀ + Q. `F` is the identity plus two entries in column 2 (the
        // `∂(x')/∂θ` and `∂(y')/∂θ` slots); all other landmark rows are untouched. The
        // two-phase multiply below uses that sparsity instead of materialising `F`, and
        // writes only into the two `SlamState` scratch buffers — no allocation on the
        // step (NASA Power of 10 §2).
        //
        //   Phase 1: tmp = F · Σ        → scratch_a
        //   Phase 2: out = tmp · Fᵀ + Q → scratch_b
        let f_02 = self.scratch_a[0 * active + 2]; // -v·sin·dt (read before scratch_a is overwritten)
        let f_12 = self.scratch_a[1 * active + 2]; // +v·cos·dt

        // Phase 1: tmp = F · Σ  (writes scratch_a).
        //   For an identity-plus-three-corners F, the multiply collapses to:
        //     tmp[i, j] = Σ[i, j]                    for i ≠ 0, 1
        //     tmp[0, j] = Σ[0, j] + f_02 · Σ[2, j]
        //     tmp[1, j] = Σ[1, j] + f_12 · Σ[2, j]
        //   We do this column-major in j, row-by-row in i, to keep the Σ
        //   read pattern cache-friendly.
        for j in 0..active {
            let s_0j = self.covariance[0 * cap + j];
            let s_1j = self.covariance[1 * cap + j];
            let s_2j = self.covariance[2 * cap + j];
            self.scratch_a[0 * cap + j] = s_0j + f_02 * s_2j;
            self.scratch_a[1 * cap + j] = s_1j + f_12 * s_2j;
            // Rows 2..active: identity, just copy.
            for i in 2..active {
                self.scratch_a[i * cap + j] = self.covariance[i * cap + j];
            }
        }

        // Phase 2: out = tmp · Fᵀ + Q (writes scratch_b).
        //
        // Fᵀ[k, j] = F[j, k], so the j-th column of Fᵀ is the j-th row of F:
        //   j = 0: F[0, *] = [1, 0, f_02, 0, 0, ...]  →  out[i, 0] = tmp[i, 0] + f_02 · tmp[i, 2]
        //   j = 1: F[1, *] = [0, 1, f_12, 0, 0, ...]  →  out[i, 1] = tmp[i, 1] + f_12 · tmp[i, 2]
        //   j = 2: F[2, *] = [0, 0, 1, 0, 0, ...]      →  out[i, 2] = tmp[i, 2]
        //   j ≥ 3: identity                            →  out[i, j] = tmp[i, j]
        for i in 0..active {
            let t_i0 = self.scratch_a[i * cap + 0];
            let t_i1 = self.scratch_a[i * cap + 1];
            let t_i2 = self.scratch_a[i * cap + 2];
            self.scratch_b[i * cap + 0] = t_i0 + f_02 * t_i2;
            self.scratch_b[i * cap + 1] = t_i1 + f_12 * t_i2;
            self.scratch_b[i * cap + 2] = t_i2;
            // Other columns: identity.
            for j in 3..active {
                self.scratch_b[i * cap + j] = self.scratch_a[i * cap + j];
            }
        }
        // Add Q (the robot-block process noise) on top.
        self.scratch_b[0 * cap + 0] += q_lin * dt * dt;
        self.scratch_b[1 * cap + 1] += q_lin * dt * dt;
        self.scratch_b[2 * cap + 2] += q_ang * dt * dt;

        // Validate before committing: a non-finite cell means the covariance has blown up,
        // and copying only the finite cells would leave a silently corrupted filter that
        // still reports `Ok`.
        if self.scratch_b.iter().any(|v| !v.is_finite()) {
            return Err(SlamError::BadInput);
        }
        self.pose = new_pose;
        self.covariance.copy_from_slice(&self.scratch_b);
        self.symmetrise_covariance();
        self.refresh_landmark_covariances();
        Ok(())
    }

    /// **Observation step**: integrate one range-bearing reading into the state.
    ///
    /// * If the reading matches an existing landmark (the gate passes), update the landmark
    ///   with the standard EKF correction.
    /// * Otherwise, **initialise a new landmark** at the predicted position with the
    ///   large initial covariance.
    pub fn observe(
        &mut self,
        observation: SlamObservation,
        control: &SlamControl,
    ) -> Result<AssociationOutcome, SlamError> {
        if !observation.range_m.is_finite()
            || !observation.bearing_rad.is_finite()
            || !observation.range_variance.is_finite()
            || !observation.bearing_variance.is_finite()
            || !observation.sensor_offset_x_m.is_finite()
            || !observation.sensor_offset_y_m.is_finite()
            || observation.range_variance < 0.0
            || observation.bearing_variance < 0.0
        {
            // The `is_finite` checks must precede the `< 0.0` tests: `NaN < 0.0` is
            // `false`, so a NaN variance would otherwise slip through and poison `R`,
            // `S`, `K` and the covariance (which the copy-back then silently drops,
            // reporting `Ok` on a corrupted step).
            //
            // The two sensor-offset fields belong in this list for the same reason the
            // variances do: they are rotated into the world frame at
            // [`Self::predict_landmark_position`] and [`Self::measurement`], so a
            // non-finite one makes the predicted landmark position non-finite. Without
            // these two checks that outcome was caught only by the `lm_x.is_finite()`
            // net below and reported as [`SlamError::Singular`] — a *geometry* verdict
            // ("the landmark lies on the robot") for what is a malformed input, which is
            // the one thing this variant's own doc says it is not. A caller that treats
            // `Singular` as "bad pose, retry" would retry forever. Only `is_finite` is
            // checked: a negative offset is legal (the sensor may sit behind or beside
            // the robot centre).
            //
            // The variance tests are `< 0.0`, so a **zero** variance is accepted here — it
            // is read as "this reading is exact", the same stance this function takes on
            // `initial_landmark_variance` below. The other half of the seam disagrees:
            // `McLocalizer::update` refuses with `variance <= 0.0`, because a zero there
            // is a degenerate likelihood rather than a statement of confidence (its
            // boundary 9). The divergence is deliberate on neither side — it is recorded
            // in `docs/robot-autonomy.md` §38 rather than silently resolved, since fixing
            // it means picking a policy for the zero the crate does not yet have.
            return Err(SlamError::BadInput);
        }
        // The control fields `observe` consumes are validated up front, like the
        // observation above — before any state is touched.
        //
        // `initial_landmark_variance` *must* be refused here rather than sanitised
        // downstream: the create branch feeds `σ = variance.sqrt()` to `Landmark::new`,
        // which computes `σ² = σ.max(0.0)²`. `f32::max` returns the non-NaN operand, so
        // both a negative variance (`sqrt` → `NaN`) and a literal `NaN` collapse to
        // `0.0` — a landmark of *zero* covariance, i.e. "perfectly known", which is the
        // opposite of the wide uninformative prior the field documents. `add_landmark`'s
        // `!v.is_finite() || v < 0.0` guard cannot catch it: by then `v` is already `0.0`.
        // (`0.0` itself stays legal — a caller may deliberately seed a known landmark.)
        //
        // A non-finite or negative `gate_squared` is refused for the same reason: the gate
        // `d² ≤ gate_squared` is never satisfied (`d² ≥ 0`), so every observation would be
        // "created" and the map would fill with duplicates while still reporting `Ok`.
        if !control.initial_landmark_variance.is_finite()
            || control.initial_landmark_variance < 0.0
            || !control.gate_squared.is_finite()
            || control.gate_squared < 0.0
        {
            return Err(SlamError::BadInput);
        }

        // The last line of defence on the predicted position. The guard above checks the
        // offset fields for *finiteness only* — deliberately, since what counts as an
        // implausible offset depends on the robot, which this crate does not know — so a
        // **finite** but enormous `range_m` or offset still overflows the sum built at
        // [`Self::predict_landmark_position`] to ±`inf`. That is the same malformed-input
        // outcome the two offset checks above were added to keep out of the geometry
        // verdict, reached through a third field, so it must carry the same verdict:
        // `BadInput`, not `Singular`. (A corrupted internal pose can overflow the sum too;
        // it is equally not a singular Jacobian — no Jacobian has been formed here.)
        let (lm_x, lm_y) = self.predict_landmark_position(&observation);
        if !lm_x.is_finite() || !lm_y.is_finite() {
            return Err(SlamError::BadInput);
        }

        // Try to associate the observation with an existing landmark first. The gate is
        // the **innovation** Mahalanobis distance `νᵀ S⁻¹ ν` with `S = H Σ Hᵀ + R` — the
        // same quantity `update_landmark` uses — not the landmark's own stored
        // covariance. The robot-pose uncertainty is normally the dominant term in `S`,
        // so a gate that ignored it would accept matches the filter should reject.
        let mut best_d2 = f32::INFINITY;
        let mut best_index: u16 = u16::MAX;
        for i in 0..self.landmarks.len() {
            if !self.landmarks[i].ever_observed {
                continue;
            }
            // A singular `S` propagates as a typed refusal (see `innovation_gate_squared`);
            // it must not be swallowed into "no match", which would create a duplicate.
            if let Some(d2) = self.innovation_gate_squared(i, &observation)? {
                if d2 < best_d2 {
                    best_d2 = d2;
                    best_index = i as u16;
                }
            }
        }
        if best_index != u16::MAX && best_d2 <= control.gate_squared {
            // Update the matched landmark.
            let landmark_index = best_index as usize;
            self.update_landmark(landmark_index, &observation)?;
            Ok(AssociationOutcome::Matched {
                landmark_index: best_index,
            })
        } else {
            // Initialise a new landmark at the predicted position.
            let idx = self.create_landmark(&observation, control)?;
            Ok(AssociationOutcome::Created {
                landmark_index: idx,
            })
        }
    }

    /// Found a new landmark at the position `obs` predicts, with the control's uninformative
    /// prior covariance. Shared by the create branch of [`SlamState::observe`] and of
    /// [`SlamState::observe_batch`], so the two cannot seed a landmark differently.
    ///
    /// The caller has already validated `obs` and (in `observe`) that the predicted position is
    /// finite; this is the sole mutation, kept in one place rather than copied.
    fn create_landmark(
        &mut self,
        obs: &SlamObservation,
        control: &SlamControl,
    ) -> Result<u16, SlamError> {
        let (lm_x, lm_y) = self.predict_landmark_position(obs);
        let mut lm = Landmark::new(lm_x, lm_y, control.initial_landmark_variance.sqrt());
        lm.ever_observed = true;
        let idx = self.add_landmark(lm)?;
        if let Some(slot) = self.landmarks.get_mut(idx as usize) {
            slot.observations = slot.observations.saturating_add(1);
        }
        Ok(idx)
    }

    /// **Joint Compatibility Branch and Bound** (Neira & Tardós, *Data association in
    /// stochastic mapping using the joint compatibility test*, IEEE T-RA 2001): associate a
    /// whole reading batch at once, choosing the largest set of pairings that is *jointly*
    /// consistent rather than each reading's individually-nearest landmark.
    ///
    /// The single-reading [`SlamState::observe`] can double-book a landmark: two readings both
    /// nearest to the same landmark each match it, and the second founds a **duplicate**. JCBB
    /// constrains the pairing to be one-to-one (a landmark appears at most once) and tests the
    /// stacked innovation of the whole hypothesis with `S = H Σ Hᵀ + R` over every pair at
    /// once, so a pairing that is individually plausible but jointly impossible is rejected in
    /// favour of the consistent alternative.
    ///
    /// * **Individual compatibility** pre-filters candidates: a pair must pass
    ///   [`SlamControl::gate_squared`] on its own `νᵀ S⁻¹ ν` — the standard JCBB prior. A
    ///   singular individual `S` propagates as [`SlamError::Singular`], exactly as `observe`.
    /// * **Joint compatibility** tests a hypothesis of `m` pairs against the 95% `χ²(2m)`
    ///   quantile (`CHI2_95_EVEN`, the private table this module gates against).
    /// * A hypothesis whose joint `S` is **singular is pruned** — the deliberate deviation from
    ///   `innovation_gate_squared`'s refusal, recorded in `docs/robot-autonomy.md` §71: in a
    ///   search, pruning one degenerate branch is correct because alternatives exist, whereas
    ///   on the single path there is nothing to fall back to, so refusing is right.
    ///
    /// The search is bounded by [`MAX_JCBB_NODES`]; on reaching the cap the best hypothesis so
    /// far is returned (a bounded, deterministic answer). Returns one [`Association`] per
    /// observation, in order. The return is one allocation per call, the same deliberate cost
    /// [`super::data_assoc::associate`] documents.
    pub fn associate_joint(
        &self,
        observations: &[SlamObservation],
        control: &SlamControl,
    ) -> Result<Vec<Association>, SlamError> {
        if observations.len() > MAX_JCBB_OBSERVATIONS {
            return Err(SlamError::TooManyObservations {
                given: observations.len(),
            });
        }
        if !control.gate_squared.is_finite() || control.gate_squared < 0.0 {
            return Err(SlamError::BadInput);
        }
        // Validate the batch exactly as `observe` validates one reading, so a malformed reading
        // carries the same verdict on either path.
        for obs in observations {
            if !obs.range_m.is_finite()
                || !obs.bearing_rad.is_finite()
                || !obs.range_variance.is_finite()
                || !obs.bearing_variance.is_finite()
                || !obs.sensor_offset_x_m.is_finite()
                || !obs.sensor_offset_y_m.is_finite()
                || obs.range_variance < 0.0
                || obs.bearing_variance < 0.0
            {
                return Err(SlamError::BadInput);
            }
            let (lx, ly) = self.predict_landmark_position(obs);
            if !lx.is_finite() || !ly.is_finite() {
                return Err(SlamError::BadInput);
            }
        }

        // Individual compatibility: gather each observation's best candidates.
        let mut search = Jcbb::new(self, observations.len());
        for (i, obs) in observations.iter().enumerate() {
            for lm in 0..self.landmarks.len() {
                if !self.landmarks[lm].ever_observed {
                    continue;
                }
                let Some(m) = self.measurement(lm, obs) else {
                    continue;
                };
                let d2 = gate_statistic(&m)?;
                if d2 <= control.gate_squared {
                    search.offer(i, lm as u16, m, d2);
                }
            }
        }

        search.run();
        Ok(search.verdicts())
    }

    /// **Joint observation step**: associate a whole batch at once with [`Self::associate_joint`]
    /// and then apply the chosen pairing — a match updates its landmark, a miss founds one.
    ///
    /// The batch's association is computed **once, against the prior state**, as JCBB prescribes
    /// (the joint test stacks every pair's innovation against one `Σ`); the resulting updates are
    /// then applied sequentially, so each correction sees the covariance the previous one left.
    /// That is the standard decomposition — association against the prediction, innovation
    /// filtering once the pairing is fixed — and the one reason a batch can pick a *jointly*
    /// consistent pairing the single-reading [`Self::observe`] cannot (two readings nearest the
    /// same landmark are forced onto a one-to-one pairing, so the second is not a duplicate).
    ///
    /// Returns how many readings were matched and how many founded a landmark.
    pub fn observe_batch(
        &mut self,
        observations: &[SlamObservation],
        control: &SlamControl,
    ) -> Result<BatchOutcome, SlamError> {
        // `associate_joint` does not consume `initial_landmark_variance` (it founds nothing), so
        // the field is validated here, where `create_landmark` would read it — the same up-front
        // refusal `observe` makes, and for the same reason: a negative variance reaches
        // `Landmark::new` as `NaN.sqrt()`, i.e. `NaN`, which its `sigma.max(0.0)²` folds to a
        // *zero*-covariance landmark ("perfectly known"), the opposite of the wide prior the
        // field means. `add_landmark`'s guard cannot catch it once `v` is already `0.0`.
        if !control.initial_landmark_variance.is_finite() || control.initial_landmark_variance < 0.0
        {
            return Err(SlamError::BadInput);
        }
        let verdicts = self.associate_joint(observations, control)?;
        let mut matched = 0usize;
        let mut created = 0usize;
        for (obs, verdict) in observations.iter().zip(verdicts.iter()) {
            match verdict {
                Association::Match { landmark_index, .. } => {
                    self.update_landmark(*landmark_index as usize, obs)?;
                    matched += 1;
                }
                Association::New { .. } => {
                    self.create_landmark(obs, control)?;
                    created += 1;
                }
            }
        }
        Ok(BatchOutcome { matched, created })
    }

    /// The world-frame landmark position a sensor reading predicts.
    fn predict_landmark_position(&self, obs: &SlamObservation) -> (f32, f32) {
        let [x, y, theta] = self.pose;
        // Sensor-frame offset rotated into world frame.
        let cos_t = theta.cos();
        let sin_t = theta.sin();
        let sx = x + obs.sensor_offset_x_m * cos_t - obs.sensor_offset_y_m * sin_t;
        let sy = y + obs.sensor_offset_x_m * sin_t + obs.sensor_offset_y_m * cos_t;
        let world_bearing = theta + obs.bearing_rad;
        (
            sx + obs.range_m * world_bearing.cos(),
            sy + obs.range_m * world_bearing.sin(),
        )
    }

    /// The linearised range-bearing measurement of landmark `index` from the current
    /// state, everything `observe` and `update_landmark` both need.
    ///
    /// `H` is non-zero on only five columns (the robot's three and the landmark's two),
    /// so the innovation covariance `S = H Σ Hᵀ + R` is assembled from a 5×5 sub-block of
    /// `Σ` — `O(1)` per landmark rather than `O(active²)`. That is what makes the
    /// innovation gate affordable inside the association loop over the whole map.
    ///
    /// Returns `None` when the landmark cannot be *measured* from here — it coincides with the
    /// sensor origin, or its squared range overflows so `q` is non-finite — in which case the
    /// bearing Jacobian is singular and the caller skips it (see
    /// `a_landmark_the_robot_cannot_measure_is_skipped_not_a_singular_innovation`).
    fn measurement(&self, index: usize, obs: &SlamObservation) -> Option<Measurement> {
        let lm = self.landmarks.get(index)?;
        let [rx, ry, theta] = self.pose;
        let cos_t = theta.cos();
        let sin_t = theta.sin();
        // The sensor-frame offset rotated into the world frame. The offset enters both
        // the predicted measurement *and* the pose Jacobian (through `∂/∂θ`), which is
        // why the prediction and the update must share this one derivation.
        let a = obs.sensor_offset_x_m * cos_t - obs.sensor_offset_y_m * sin_t;
        let b = obs.sensor_offset_x_m * sin_t + obs.sensor_offset_y_m * cos_t;
        let dx = lm.x_m - (rx + a);
        let dy = lm.y_m - (ry + b);
        let q2 = dx * dx + dy * dy;
        let q = q2.sqrt();
        // `q` is a norm, so the `<=` and the finiteness test together reject a coincident
        // or non-finite landmark without a NaN slipping through (`NaN <= x` is `false`).
        // Both leaves are live and reachable through the public API, each via a *different*
        // input: `range_m = 0` founds the landmark on the sensor origin so `q == 0` (caught
        // by `q <= MIN_RANGE_M` alone), while a finite-but-huge `range_m` overflows `q²`, so
        // `q == inf` (caught by `!q.is_finite()` alone — `inf <= 1e-6` is `false`).
        if !q.is_finite() || q <= MIN_RANGE_M {
            return None;
        }

        let lx = ROBOT_DIM + LM_DIM * index;
        let cols = [0usize, 1, 2, lx, lx + 1];
        // Range row: ∂r/∂robot = −∂r/∂landmark; the θ entry carries the offset `b`.
        let h = [
            [-dx / q, -dy / q, (dx * b - dy * a) / q, dx / q, dy / q],
            [
                dy / q2,
                -dx / q2,
                -(dy * b + dx * a) / q2 - 1.0,
                -dy / q2,
                dx / q2,
            ],
        ];

        let predicted_bearing = dy.atan2(dx) - theta;
        let innovation = [
            obs.range_m - q,
            wrap_angle(obs.bearing_rad - predicted_bearing),
        ];
        let r = [obs.range_variance, 0.0, 0.0, obs.bearing_variance];

        let mut s = [0.0f32; 4];
        for i in 0..2 {
            for j in 0..2 {
                let mut sum = 0.0f32;
                for (ki, &ci) in cols.iter().enumerate() {
                    if h[i][ki] == 0.0 {
                        continue;
                    }
                    for (kj, &cj) in cols.iter().enumerate() {
                        if h[j][kj] == 0.0 {
                            continue;
                        }
                        sum += h[i][ki] * self.cov(ci, cj) * h[j][kj];
                    }
                }
                s[i * 2 + j] = sum + r[i * 2 + j];
            }
        }
        Some(Measurement {
            cols,
            h,
            innovation,
            s,
        })
    }

    /// The squared Mahalanobis innovation `νᵀ S⁻¹ ν` of `obs` against landmark `index`.
    ///
    /// * `Ok(None)` — the landmark cannot be *measured* from here (it coincides with the
    ///   sensor origin, so the bearing Jacobian is singular). This is not a fault: the
    ///   landmark is simply skipped in the association scan.
    /// * `Ok(Some(d2))` — the gate statistic.
    /// * `Err(SlamError::Singular)` — the measurement is well-defined but `S` is not
    ///   invertible, or `d2` came out non-finite. This is a **numerical fault**, not a skip:
    ///   reporting it as "no match" would let `observe` initialise a *duplicate* landmark at
    ///   the same place, silently corrupting the map. `update_landmark` refuses the identical
    ///   condition with the same error, so the two paths agree.
    fn innovation_gate_squared(
        &self,
        index: usize,
        obs: &SlamObservation,
    ) -> Result<Option<f32>, SlamError> {
        let Some(m) = self.measurement(index, obs) else {
            return Ok(None);
        };
        Ok(Some(gate_statistic(&m)?))
    }

    /// Refresh every landmark's stored 2×2 covariance from the filter's marginal block,
    /// so [`Landmark::cov`] (which the data-association gate reads) tracks the true
    /// uncertainty rather than the value fixed at initialisation.
    fn refresh_landmark_covariances(&mut self) {
        for i in 0..self.landmarks.len() {
            let lx = ROBOT_DIM + LM_DIM * i;
            let cov = [
                self.cov(lx, lx),
                self.cov(lx, lx + 1),
                self.cov(lx + 1, lx),
                self.cov(lx + 1, lx + 1),
            ];
            self.landmarks[i].cov = cov;
        }
    }

    /// Run a single landmark EKF update (the call site has already done the gate check).
    ///
    /// Takes no [`SlamControl`]: the measurement noise `R` rides on the *observation*
    /// (`range_variance` / `bearing_variance`), and the gate that decides *whether* to update
    /// has already run in `observe`. A `control` parameter here would be dead weight, which is
    /// why there is none.
    fn update_landmark(
        &mut self,
        landmark_index: usize,
        obs: &SlamObservation,
    ) -> Result<(), SlamError> {
        let active = self.dim();
        let cap = self.capacity();
        let m = self
            .measurement(landmark_index, obs)
            .ok_or(SlamError::Singular)?;
        let lx_row = m.cols[3];

        // S⁻¹ (2×2 closed form).
        //
        // This refusal is the identical one `innovation_gate_squared` makes, kept as a
        // last line for a caller that does not gate first. On the one path that exists
        // today it cannot fire: `observe` runs this same test on this same `S` before it
        // calls here, and it propagates the error. So neither copy is pinned on its own —
        // a test can only witness the pair (see
        // `an_overflown_innovation_determinant_is_refused_not_read_as_a_perfect_match`).
        let det = m.s[0] * m.s[3] - m.s[1] * m.s[2];
        if !det.is_finite() || det.abs() <= MIN_INNOVATION_DET {
            return Err(SlamError::Singular);
        }
        let s_inv = [m.s[3] / det, -m.s[1] / det, -m.s[2] / det, m.s[0] / det];

        // K = Σ Hᵀ S⁻¹ — assembled into scratch_a with stride `active` (K[row, col] at
        // `row·active + col`, col ∈ {0, 1}). Only five columns of H are non-zero, so the
        // product walks the support list rather than the whole state.
        for slot in self.scratch_a.iter_mut().take(active * active) {
            *slot = 0.0;
        }
        for row in 0..active {
            for col in 0..2 {
                let mut sum = 0.0f32;
                for (ki, &ci) in m.cols.iter().enumerate() {
                    let cov_v = self.cov(row, ci);
                    if cov_v == 0.0 {
                        continue;
                    }
                    sum +=
                        cov_v * (m.h[0][ki] * s_inv[0 * 2 + col] + m.h[1][ki] * s_inv[1 * 2 + col]);
                }
                self.scratch_a[row * active + col] = sum;
            }
        }

        // μ' = μ + K · ν, captured now: scratch_a is reused for the covariance below.
        let [v0, v1] = m.innovation;
        let pose_delta = [
            self.scratch_a[0 * active + 0] * v0 + self.scratch_a[0 * active + 1] * v1,
            self.scratch_a[1 * active + 0] * v0 + self.scratch_a[1 * active + 1] * v1,
            self.scratch_a[2 * active + 0] * v0 + self.scratch_a[2 * active + 1] * v1,
        ];
        let lm_delta = [
            self.scratch_a[lx_row * active + 0] * v0 + self.scratch_a[lx_row * active + 1] * v1,
            self.scratch_a[(lx_row + 1) * active + 0] * v0
                + self.scratch_a[(lx_row + 1) * active + 1] * v1,
        ];

        // Σ' = (I − K H) Σ.
        // ① KH = K · H into scratch_b. KH[row, c] is non-zero only for c in the support.
        for slot in self.scratch_b.iter_mut().take(active * active) {
            *slot = 0.0;
        }
        for row in 0..active {
            let k_r0 = self.scratch_a[row * active + 0];
            let k_r1 = self.scratch_a[row * active + 1];
            for (ki, &ci) in m.cols.iter().enumerate() {
                self.scratch_b[row * active + ci] = k_r0 * m.h[0][ki] + k_r1 * m.h[1][ki];
            }
        }
        // ② new_Σ = Σ − (KH) Σ into scratch_a. Clear the whole buffer so the K values
        // (stride `active`) cannot survive into the copy-back and land in inactive cells.
        for slot in self.scratch_a.iter_mut() {
            *slot = 0.0;
        }
        for row in 0..active {
            for col in 0..active {
                let mut sum = 0.0f32;
                for &ci in m.cols.iter() {
                    let kh = self.scratch_b[row * active + ci];
                    if kh == 0.0 {
                        continue;
                    }
                    sum += kh * self.covariance[ci * cap + col];
                }
                self.scratch_a[row * cap + col] = self.covariance[row * cap + col] - sum;
            }
        }
        // ③ Validate before committing. A non-finite cell means the filter has blown up;
        // copying only the finite cells (as the previous code did) would leave a silently
        // corrupted covariance and still report `Ok`.
        if self.scratch_a.iter().any(|v| !v.is_finite()) {
            return Err(SlamError::BadInput);
        }
        self.covariance.copy_from_slice(&self.scratch_a);
        self.symmetrise_covariance();

        // Commit the state now that the covariance is known good.
        self.pose[0] += pose_delta[0];
        self.pose[1] += pose_delta[1];
        self.pose[2] = wrap_angle(self.pose[2] + pose_delta[2]);
        if let Some(lm) = self.landmarks.get_mut(landmark_index) {
            lm.x_m += lm_delta[0];
            lm.y_m += lm_delta[1];
            lm.observations = lm.observations.saturating_add(1);
            lm.symmetrise();
        }
        self.refresh_landmark_covariances();
        Ok(())
    }
}

/// One landmark's linearised measurement, shared by the association gate and the update.
///
/// `Copy` because the joint view ([`SlamState::associate_joint`]) holds one per candidate in a
/// fixed-size table, and a joint compatibility test needs the individual `cols`/`h`/`innovation`
/// of each pair it stacks — not just the pre-reduced `s`.
#[derive(Clone, Copy)]
struct Measurement {
    /// The five state columns `H` is non-zero on: robot x, y, θ, then the landmark's x, y.
    cols: [usize; 5],
    /// `h[row][k]` — the range (`row = 0`) and bearing (`row = 1`) rows over [`Self::cols`].
    h: [[f32; 5]; 2],
    /// The innovation `[z_range − r, z_bearing − φ]`.
    innovation: [f32; 2],
    /// `S = H Σ Hᵀ + R`, row-major.
    s: [f32; 4],
}

impl Measurement {
    /// A placeholder with every field zero — the initial value of the joint search's candidate
    /// table, always overwritten before it is read (`cand_n[depth]` bounds the reads).
    const ZERO: Measurement = Measurement {
        cols: [0; 5],
        h: [[0.0; 5]; 2],
        innovation: [0.0; 2],
        s: [0.0; 4],
    };
}

/// The squared Mahalanobis innovation `νᵀ S⁻¹ ν` of a measurement, or [`SlamError::Singular`]
/// when `S` is not invertible (or the statistic came out non-finite).
///
/// This is the one copy of the gate arithmetic, shared by [`SlamState::innovation_gate_squared`]
/// (single-observation gate) and [`SlamState::associate_joint`] (individual-compatibility
/// pre-filter). Kept as a free function so neither caller can drift from the other.
fn gate_statistic(m: &Measurement) -> Result<f32, SlamError> {
    let det = m.s[0] * m.s[3] - m.s[1] * m.s[2];
    if !det.is_finite() || det.abs() <= MIN_INNOVATION_DET {
        return Err(SlamError::Singular);
    }
    let inv = [m.s[3] / det, -m.s[1] / det, -m.s[2] / det, m.s[0] / det];
    let [v0, v1] = m.innovation;
    let d2 = v0 * (inv[0] * v0 + inv[1] * v1) + v1 * (inv[2] * v0 + inv[3] * v1);
    if d2.is_finite() {
        Ok(d2)
    } else {
        Err(SlamError::Singular)
    }
}

impl Default for SlamState {
    #[allow(clippy::derivable_impls)] // SlamState needs explicit `Vec` allocation; `Default::default` is the documented seam for "no landmarks, robot-block covariance seeded".
    fn default() -> Self {
        Self::new()
    }
}

/// The JCBB search: a fixed-size candidate table (the individually-compatible pairs, sorted
/// best-first) plus the branch-and-bound recursion over hypotheses.
///
/// Every buffer is a fixed-size array sized by the [`MAX_JCBB_OBSERVATIONS`] /
/// [`MAX_JCBB_CANDIDATES`] constants, so the search allocates nothing (NASA Power of 10 §2) —
/// the one allocation on this path is the `Vec<Association>` that [`Self::verdicts`] returns,
/// the same per-call cost the sibling [`super::data_assoc::associate`] documents. The only
/// other stack cost is the joint solve's `MAX_JCBB_DIM²` matrix (~1 KiB), rebuilt per
/// hypothesis test.
struct Jcbb<'a> {
    state: &'a SlamState,
    n_obs: usize,
    /// Per observation, the candidate landmarks, ascending by individual gate statistic.
    cand_lm: [[u16; MAX_JCBB_CANDIDATES]; MAX_JCBB_OBSERVATIONS],
    /// The [`Measurement`] of each candidate, so the joint test never re-derives it.
    cand_m: [[Measurement; MAX_JCBB_CANDIDATES]; MAX_JCBB_OBSERVATIONS],
    /// Each candidate's individual `νᵀ S⁻¹ ν` (the pre-filter ranking and the reported distance).
    cand_d2: [[f32; MAX_JCBB_CANDIDATES]; MAX_JCBB_OBSERVATIONS],
    /// How many candidates observation `i` has (`≤ MAX_JCBB_CANDIDATES`); bounds every read.
    cand_n: [usize; MAX_JCBB_OBSERVATIONS],
    /// Nodes visited so far, against [`MAX_JCBB_NODES`].
    nodes: usize,
    /// The hypothesis under construction: `(observation index, landmark index)` pairs.
    hyp: [(u16, u16); MAX_JCBB_OBSERVATIONS],
    hyp_len: usize,
    /// The best complete-or-partial hypothesis seen (largest, then lowest summed gate).
    best: [(u16, u16); MAX_JCBB_OBSERVATIONS],
    best_len: usize,
    best_score: f32,
}

impl<'a> Jcbb<'a> {
    fn new(state: &'a SlamState, n_obs: usize) -> Self {
        Self {
            state,
            n_obs,
            cand_lm: [[u16::MAX; MAX_JCBB_CANDIDATES]; MAX_JCBB_OBSERVATIONS],
            cand_m: [[Measurement::ZERO; MAX_JCBB_CANDIDATES]; MAX_JCBB_OBSERVATIONS],
            cand_d2: [[0.0; MAX_JCBB_CANDIDATES]; MAX_JCBB_OBSERVATIONS],
            cand_n: [0; MAX_JCBB_OBSERVATIONS],
            nodes: 0,
            hyp: [(u16::MAX, u16::MAX); MAX_JCBB_OBSERVATIONS],
            hyp_len: 0,
            best: [(u16::MAX, u16::MAX); MAX_JCBB_OBSERVATIONS],
            best_len: 0,
            best_score: f32::INFINITY,
        }
    }

    /// Record `(obs, landmark)` as an individually-compatible candidate, kept sorted ascending
    /// by `d2` and capped at [`MAX_JCBB_CANDIDATES`] (the best survive; a worse one offered
    /// after the row is full is dropped).
    fn offer(&mut self, obs: usize, landmark: u16, m: Measurement, d2: f32) {
        if obs >= self.n_obs {
            return;
        }
        let n = self.cand_n[obs];
        let mut pos = n.min(MAX_JCBB_CANDIDATES);
        while pos > 0 && self.cand_d2[obs][pos - 1] > d2 {
            pos -= 1;
        }
        if pos >= MAX_JCBB_CANDIDATES {
            return;
        }
        let last = n.min(MAX_JCBB_CANDIDATES - 1);
        let mut i = last;
        while i > pos {
            self.cand_lm[obs][i] = self.cand_lm[obs][i - 1];
            self.cand_m[obs][i] = self.cand_m[obs][i - 1];
            self.cand_d2[obs][i] = self.cand_d2[obs][i - 1];
            i -= 1;
        }
        self.cand_lm[obs][pos] = landmark;
        self.cand_m[obs][pos] = m;
        self.cand_d2[obs][pos] = d2;
        if n < MAX_JCBB_CANDIDATES {
            self.cand_n[obs] = n + 1;
        }
    }

    /// Run the branch-and-bound search from the empty hypothesis.
    fn run(&mut self) {
        self.search(0);
    }

    /// Depth-first search: at `depth` (the observation to assign next), try each unused
    /// candidate best-first, keeping only branches whose hypothesis is *jointly* compatible,
    /// and finally the "leave this observation unassociated" branch. A complete or pruned
    /// hypothesis that beats the best recorded so far is kept.
    fn search(&mut self, depth: usize) {
        if self.nodes >= MAX_JCBB_NODES {
            return;
        }
        self.nodes += 1;

        if depth == self.n_obs {
            let score = self.hypothesis_score();
            // Strictly larger wins; a tie goes to the lower summed individual gate. Both are
            // deterministic, so two runs over the same inputs record the same hypothesis.
            if self.hyp_len > self.best_len
                || (self.hyp_len == self.best_len && score < self.best_score)
            {
                self.best[..self.hyp_len].copy_from_slice(&self.hyp[..self.hyp_len]);
                self.best_len = self.hyp_len;
                self.best_score = score;
            }
            return;
        }

        // Bound: the remaining `n_obs - depth` observations can add at most that many pairs, so
        // a hypothesis that still could not reach the best length is not worth exploring. `>`
        // (not `>=`) keeps tie-length hypotheses alive for the score tie-break.
        if self.hyp_len + (self.n_obs - depth) < self.best_len {
            return;
        }

        let n = self.cand_n[depth];
        for c in 0..n {
            let landmark = self.cand_lm[depth][c];
            if self.landmark_used(landmark) {
                continue;
            }
            self.hyp[self.hyp_len] = (depth as u16, landmark);
            self.hyp_len += 1;
            let jointly_compatible = self
                .joint_statistic()
                .is_some_and(|d2| d2 <= CHI2_95_EVEN[self.hyp_len - 1]);
            if jointly_compatible {
                self.search(depth + 1);
            }
            self.hyp_len -= 1;
            if self.nodes >= MAX_JCBB_NODES {
                return;
            }
        }

        // The always-available branch: this observation founds no match. It keeps a complete
        // assignment reachable for every depth, so a search cut short by the node cap still
        // returns a well-formed verdict per observation.
        self.search(depth + 1);
    }

    fn landmark_used(&self, landmark: u16) -> bool {
        self.hyp[..self.hyp_len]
            .iter()
            .any(|&(_, used)| used == landmark)
    }

    /// The summed individual gate statistic of the hypothesis under construction (the
    /// tie-break; not the joint statistic, which is what the gate itself tests).
    fn hypothesis_score(&self) -> f32 {
        self.hyp[..self.hyp_len]
            .iter()
            .map(|&(obs, lm)| self.pair_d2(obs as usize, lm))
            .sum()
    }

    /// The candidate [`Measurement`] recorded for `(obs, landmark)`, or `None` if the pair was
    /// never offered. Every pair in a hypothesis came from the candidate table, so this is
    /// `Some` on the search path.
    fn pair_measurement(&self, obs: usize, landmark: u16) -> Option<Measurement> {
        let n = *self.cand_n.get(obs)?;
        let row = self.cand_lm.get(obs)?;
        row[..n]
            .iter()
            .position(|&lm| lm == landmark)
            .and_then(|c| self.cand_m.get(obs)?.get(c).copied())
    }

    /// The individual gate statistic recorded for `(obs, landmark)`, or `INFINITY` if absent.
    fn pair_d2(&self, obs: usize, landmark: u16) -> f32 {
        let n = self.cand_n.get(obs).copied().unwrap_or(0);
        self.cand_lm[obs][..n]
            .iter()
            .position(|&lm| lm == landmark)
            .map_or(f32::INFINITY, |c| self.cand_d2[obs][c])
    }

    /// `νᵀ S⁻¹ ν` for the whole hypothesis, with `S` the stacked innovation covariance over
    /// every pair at once: the 2×2 diagonal blocks are each pair's own `S = H Σ Hᵀ + R` and the
    /// off-diagonal blocks are the pair-to-pair cross terms `H_a Σ H_bᵀ` (the measurement noise
    /// is independent, so it enters only on the diagonal). `None` when the stacked `S` is
    /// singular or the statistic is non-finite — both prune the hypothesis.
    fn joint_statistic(&self) -> Option<f32> {
        let k = self.hyp_len;
        if k == 0 {
            return Some(0.0);
        }
        let dim = 2 * k;
        let stride = MAX_JCBB_DIM;
        let mut s = [0.0f32; MAX_JCBB_DIM * MAX_JCBB_DIM];
        let mut nu = [0.0f32; MAX_JCBB_DIM];

        for a in 0..k {
            let (obs_a, lm_a) = self.hyp[a];
            let ma = self.pair_measurement(obs_a as usize, lm_a)?;
            s[2 * a * stride + 2 * a] = ma.s[0];
            s[2 * a * stride + 2 * a + 1] = ma.s[1];
            s[(2 * a + 1) * stride + 2 * a] = ma.s[2];
            s[(2 * a + 1) * stride + 2 * a + 1] = ma.s[3];
            nu[2 * a] = ma.innovation[0];
            nu[2 * a + 1] = ma.innovation[1];

            for b in (a + 1)..k {
                let (obs_b, lm_b) = self.hyp[b];
                let mb = self.pair_measurement(obs_b as usize, lm_b)?;
                for r1 in 0..2 {
                    for r2 in 0..2 {
                        let mut sum = 0.0f32;
                        for (p, &cp) in ma.cols.iter().enumerate() {
                            if ma.h[r1][p] == 0.0 {
                                continue;
                            }
                            for (q, &cq) in mb.cols.iter().enumerate() {
                                if mb.h[r2][q] == 0.0 {
                                    continue;
                                }
                                sum += ma.h[r1][p] * self.state.cov(cp, cq) * mb.h[r2][q];
                            }
                        }
                        s[(2 * a + r1) * stride + 2 * b + r2] = sum;
                        s[(2 * b + r2) * stride + 2 * a + r1] = sum;
                    }
                }
            }
        }

        solve_quadratic_form(&mut s, &nu, dim)
    }

    /// One verdict per observation, in order: a matched pair reports the landmark and the
    /// **root** of its individual gate statistic (the form a log or plot wants, matching
    /// [`super::data_assoc::associate`]); an unmatched observation reports the root of its
    /// nearest candidate's statistic, or `INFINITY` when it had none.
    fn verdicts(&self) -> Vec<Association> {
        let mut out = Vec::with_capacity(self.n_obs);
        for obs in 0..self.n_obs {
            let matched = self.best[..self.best_len]
                .iter()
                .find(|&&(o, _)| o as usize == obs)
                .map(|&(_, lm)| (lm, self.pair_d2(obs, lm)));
            match matched {
                Some((landmark_index, d2)) => out.push(Association::Match {
                    landmark_index,
                    distance: d2.sqrt(),
                }),
                None => out.push(Association::New {
                    distance: self.nearest_root(obs),
                }),
            }
        }
        out
    }

    /// The root of observation `obs`'s best candidate statistic, or `INFINITY` when it had none.
    fn nearest_root(&self, obs: usize) -> f32 {
        if self.cand_n[obs] > 0 {
            self.cand_d2[obs][0].sqrt()
        } else {
            f32::INFINITY
        }
    }
}

/// Evaluate the squared Mahalanobis form `νᵀ S⁻¹ ν` for the symmetric joint innovation
/// covariance `S`, by Gauss-Jordan elimination with partial pivoting. Returns `None` on a
/// pivot below [`MIN_JCBB_PIVOT`] (or non-finite), or a non-finite result — both prune the
/// hypothesis.
///
/// `s` is the `dim × dim` row-major matrix with `MAX_JCBB_DIM` stride; only the leading
/// `dim × dim` block is touched. `nu` is left intact (the form is read off the *unsolved*
/// innovation dotted with the solution), so the caller's `nu` is not the buffer that moves.
fn solve_quadratic_form(
    s: &mut [f32; MAX_JCBB_DIM * MAX_JCBB_DIM],
    nu: &[f32; MAX_JCBB_DIM],
    dim: usize,
) -> Option<f32> {
    let stride = MAX_JCBB_DIM;
    // The elimination carries `x = S⁻¹ ν` here; `nu` keeps the innovation for the final dot.
    let mut x = [0.0f32; MAX_JCBB_DIM];
    x[..dim].copy_from_slice(&nu[..dim]);

    for col in 0..dim {
        let mut pivot = col;
        let mut best = s[col * stride + col].abs();
        for row in (col + 1)..dim {
            let v = s[row * stride + col].abs();
            if v > best {
                best = v;
                pivot = row;
            }
        }
        if !best.is_finite() || best <= MIN_JCBB_PIVOT {
            return None;
        }
        if pivot != col {
            for j in 0..dim {
                s.swap(col * stride + j, pivot * stride + j);
            }
            x.swap(col, pivot);
        }
        let inv = 1.0 / s[col * stride + col];
        for j in 0..dim {
            s[col * stride + j] *= inv;
        }
        x[col] *= inv;
        for row in 0..dim {
            if row == col {
                continue;
            }
            let factor = s[row * stride + col];
            if factor == 0.0 {
                continue;
            }
            for j in 0..dim {
                s[row * stride + j] -= factor * s[col * stride + j];
            }
            x[row] -= factor * x[col];
        }
    }

    let d2: f32 = (0..dim).map(|i| nu[i] * x[i]).sum();
    if d2.is_finite() {
        Some(d2)
    } else {
        None
    }
}

/// Wrap an angle into `(-π, π]`.
///
/// A non-finite input is returned **unchanged** (`NaN` stays `NaN`). It must not be mapped
/// to `0.0`: a `NaN` bearing compared against a prediction would then read as a *perfect*
/// match, and the association gate would pass on a corrupted reading. Returning the `NaN`
/// lets it propagate into `νᵀ S⁻¹ ν`, where the caller's finiteness check turns it into a
/// typed [`SlamError::Singular`] instead of a fabricated match. (`observe` already rejects a
/// non-finite `bearing_rad` at the boundary, so this is the second line of defence.)
fn wrap_angle(angle: f32) -> f32 {
    if !angle.is_finite() {
        return angle;
    }
    let two_pi = 2.0 * PI;
    let mut wrapped = angle - two_pi * ((angle + PI) / two_pi).floor();
    if wrapped > PI {
        wrapped -= two_pi;
    }
    if wrapped <= -PI {
        wrapped += two_pi;
    }
    wrapped
}

/// What one observation produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssociationOutcome {
    /// The observation matched an existing landmark (its index).
    Matched { landmark_index: u16 },
    /// The observation was gated out: a new landmark was added at the predicted position.
    Created { landmark_index: u16 },
}

/// What one batch produced for [`SlamState::observe_batch`]: how many readings updated an
/// existing landmark and how many founded a new one. `matched + created == batch length`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BatchOutcome {
    /// Readings assigned to an existing landmark.
    pub matched: usize,
    /// Readings that founded a new landmark.
    pub created: usize,
}

/// A high-level wrapper that owns a [`SlamState`] and a [`SlamControl`].
///
/// The wrapper exists to make `predict` / `observe` callable with a single mutable borrow
/// (the state and its control travel together).
///
/// **The control is always [`SlamControl::default`].** There is deliberately no
/// `with_control` / `set_control`: an earlier revision had them, and they were removed as
/// zero-referenced (the crate's rule is "no setter without a caller"). Every consumer —
/// `tests/slam_e2e.rs` and the in-file tests — constructs the wrapper with
/// `EkfSlam::default()` and never changes the policy. An earlier doc here claimed the
/// wrapper "pins a `SlamControl` so a test can compare two runs that share the same policy",
/// which described a capability no setter provides. A caller that needs a non-default policy
/// drives [`SlamState::predict`] / [`SlamState::observe`] directly.
#[derive(Default)]
pub struct EkfSlam {
    state: SlamState,
    control: SlamControl,
}

impl EkfSlam {
    /// The current pose estimate (x, y, θ). Forwarded to [`SlamState::pose`].
    pub fn pose(&self) -> [f32; 3] {
        self.state.pose()
    }

    /// The number of landmarks currently in the map. Forwarded to
    /// [`SlamState::num_landmarks`].
    pub fn num_landmarks(&self) -> usize {
        self.state.num_landmarks()
    }

    /// Run a prediction step.
    pub fn predict(&mut self, command: VelocityCommand) -> Result<(), SlamError> {
        self.state.predict(command, &self.control)
    }

    /// Run an observation step.
    pub fn observe(
        &mut self,
        observation: SlamObservation,
    ) -> Result<AssociationOutcome, SlamError> {
        self.state.observe(observation, &self.control)
    }

    /// Associate a whole batch jointly and apply it. Forwarded to
    /// [`SlamState::observe_batch`].
    pub fn observe_batch(
        &mut self,
        observations: &[SlamObservation],
    ) -> Result<BatchOutcome, SlamError> {
        self.state.observe_batch(observations, &self.control)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every variant renders one operator-facing line — the contract the sibling error types
    /// (`PlanError`, `FusionError`, `LoopError`) already hold. This enum had no `Display`, so
    /// a caller could only `{:?}` it.
    #[test]
    fn every_slam_error_renders_its_cause() {
        let rendered =
            [SlamError::MapFull, SlamError::Singular, SlamError::BadInput].map(|e| e.to_string());
        for line in &rendered {
            assert!(!line.is_empty(), "every error needs a message");
            assert!(
                !line.contains("SlamError"),
                "the message must describe the cause, not the type: {line}"
            );
        }
        for (i, a) in rendered.iter().enumerate() {
            for b in rendered.iter().skip(i + 1) {
                assert_ne!(a, b, "two distinct faults must not render identically");
            }
        }
        assert!(
            rendered[0].contains(&MAX_LANDMARKS.to_string()),
            "the full map must name the cap: {}",
            rendered[0]
        );
    }

    #[test]
    fn a_fresh_state_has_no_landmarks_and_a_finite_covariance() {
        let s = SlamState::new();
        assert_eq!(s.pose(), [0.0, 0.0, 0.0]);
        assert_eq!(s.landmarks().len(), 0);
        assert!(s.cov(0, 0).is_finite());
        assert!((s.cov(0, 0) - 0.01).abs() < 1e-6);
    }

    #[test]
    fn predict_translates_a_linear_command() {
        let mut s = SlamState::new();
        s.predict(
            VelocityCommand {
                linear_m_s: 1.0,
                angular_rad_s: 0.0,
                dt_s: 0.1,
            },
            &SlamControl::default(),
        )
        .unwrap();
        let p = s.pose();
        assert!((p[0] - 0.1).abs() < 1e-5, "x={}", p[0]);
        assert!(p[1].abs() < 1e-5, "y={}", p[1]);
        assert!(p[2].abs() < 1e-5, "θ={}", p[2]);
    }

    #[test]
    fn predict_rotates_a_pure_angular_command() {
        let mut s = SlamState::new();
        s.predict(
            VelocityCommand {
                linear_m_s: 0.0,
                angular_rad_s: 1.0,
                dt_s: 0.5,
            },
            &SlamControl::default(),
        )
        .unwrap();
        let p = s.pose();
        assert!(p[0].abs() < 1e-5);
        assert!(p[1].abs() < 1e-5);
        assert!((p[2] - 0.5).abs() < 1e-5, "θ={}", p[2]);
    }

    #[test]
    fn observe_with_no_landmarks_creates_one_at_the_predicted_position() {
        let mut s = SlamState::new();
        let outcome = s
            .observe(SlamObservation::lidar(2.0, 0.0), &SlamControl::default())
            .unwrap();
        match outcome {
            AssociationOutcome::Created { landmark_index } => assert_eq!(landmark_index, 0),
            other => panic!("expected Created, got {other:?}"),
        }
        assert_eq!(s.landmarks().len(), 1);
        let lm = &s.landmarks()[0];
        assert!((lm.x_m - 2.0).abs() < 1e-4, "x={}", lm.x_m);
        assert!(lm.y_m.abs() < 1e-4);
    }

    #[test]
    fn a_second_observation_of_the_same_point_matches_the_first_landmark() {
        let mut s = SlamState::new();
        // Static pose, two observations of the same landmark at different ranges.
        s.observe(SlamObservation::lidar(2.0, 0.0), &SlamControl::default())
            .unwrap();
        let outcome = s
            .observe(SlamObservation::lidar(3.0, 0.0), &SlamControl::default())
            .unwrap();
        let lm = &s.landmarks()[0];
        match outcome {
            AssociationOutcome::Matched { landmark_index } => assert_eq!(landmark_index, 0),
            other => panic!("expected Matched, got {other:?}"),
        }
        // The first observation *creates* the landmark (position set, covariance left at
        // `initial_landmark_variance`); the second is the first real EKF update. With the
        // landmark prior σ² = 1.0, the robot's x variance σ² = 0.1² = 0.01, and the lidar
        // range variance 0.0025, the innovation covariance is `S = 1.0 + 0.01 + 0.0025 =
        // 1.0125` and the Kalman gain on the landmark's x is `1.0 / 1.0125 ≈ 0.98765`. The
        // innovation is `3.0 − 2.0 = 1.0 m`, so `x ← 2.0 + 0.98765·1.0 ≈ 2.98765`, with the
        // posterior variance `(1 − 0.98765)·1.0 ≈ 0.012346`. Pinning the number catches a
        // regression in the gain or the innovation that a bare `x > 2.0` would wave through.
        assert!(
            (lm.x_m - 2.987_654_2).abs() < 1e-4,
            "x must land at the analytic Kalman update 2.98765, got {}",
            lm.x_m
        );
        assert!(
            (lm.cov[0] - 0.012_345_7).abs() < 1e-5,
            "the update must shrink the landmark variance to ≈0.012346, got {:?}",
            lm.cov
        );
    }

    #[test]
    fn observe_refuses_to_exceed_the_landmark_cap() {
        // The landmark table is bounded by MAX_LANDMARKS; an observation that asks for
        // `MAX_LANDMARKS + 1` distinct ids must be refused, not silently overwritten.
        // The landmarks are laid out along a radial line at 0.5 m spacing — a 360°
        // bearing sweep would wrap after one revolution and start legitimately matching
        // the first landmarks again. With 0.1 cm range σ, 1 mm position σ and 1e-4 rad
        // heading σ, the innovation covariance's range term is ≈ 1e-4 m², so the nearest
        // existing landmark at 0.5 m gives a Mahalanobis distance of ≈ 50σ — far above
        // the √5.991 ≈ 2.45 cutoff, so every observation is genuinely a new landmark.
        // The gate is `O(1)` per landmark, so the 513-landmark sweep runs in the default
        // suite.
        let mut s = SlamState::with_pose([0.0, 0.0, 0.0], 0.001, 0.0001);
        let control = SlamControl {
            gate_squared: 5.991,
            initial_landmark_variance: 0.0001,
            ..SlamControl::default()
        };
        let obs_at = |range_m: f32| SlamObservation {
            range_m,
            bearing_rad: 0.0,
            range_variance: 1e-6,
            bearing_variance: (PI / 3600.0) * (PI / 3600.0),
            sensor_offset_x_m: 0.0,
            sensor_offset_y_m: 0.0,
        };
        let mut last_err: Option<SlamError> = None;
        let mut ok_count = 0;
        for i in 0..(MAX_LANDMARKS + 1) {
            match s.observe(obs_at(1.0 + 0.5 * i as f32), &control) {
                Ok(_) => ok_count += 1,
                Err(e) => {
                    last_err = Some(e);
                    break;
                }
            }
        }
        assert_eq!(last_err, Some(SlamError::MapFull), "ok count = {ok_count}");
        assert_eq!(s.num_landmarks(), MAX_LANDMARKS);
    }

    /// A negative `initial_landmark_variance` must be **refused**, not silently sanitised.
    /// The create branch feeds `σ = initial_landmark_variance.sqrt()` to `Landmark::new`,
    /// which computes `σ² = σ.max(0.0)²`; `(−1.0f32).sqrt()` is `NaN`, and `f32::max`
    /// returns the *non-NaN* operand, so `NaN.max(0.0) == 0.0` — the landmark is created
    /// with a **zero** covariance ("perfectly known"), the opposite of the wide
    /// uninformative prior the field documents, and `add_landmark`'s `v < 0.0` guard never
    /// fires because it only ever sees the sanitised `0.0`. Before the check at the top of
    /// `observe`, this returned `Ok(Created)`.
    #[test]
    fn a_negative_initial_landmark_variance_is_refused_not_sanitised_to_zero() {
        let mut s = SlamState::new();
        let control = SlamControl {
            initial_landmark_variance: -1.0,
            ..SlamControl::default()
        };
        assert_eq!(
            s.observe(SlamObservation::lidar(2.0, 0.0), &control),
            Err(SlamError::BadInput)
        );
        assert_eq!(
            s.num_landmarks(),
            0,
            "a refused observation must add no landmark"
        );
    }

    /// The `NaN` half of the same defect: `NaN` passes `add_landmark`'s `!v.is_finite()`
    /// guard only because `Landmark::new` has already collapsed it to `0.0`.
    #[test]
    fn a_non_finite_initial_landmark_variance_is_refused_not_sanitised_to_zero() {
        let mut s = SlamState::new();
        let control = SlamControl {
            initial_landmark_variance: f32::NAN,
            ..SlamControl::default()
        };
        assert_eq!(
            s.observe(SlamObservation::lidar(2.0, 0.0), &control),
            Err(SlamError::BadInput)
        );
        assert_eq!(s.num_landmarks(), 0);
    }

    /// A negative or non-finite gate can never be satisfied (`d² ≥ 0`), so *every*
    /// observation would be gated out and become a duplicate landmark while the filter
    /// reports `Ok`. That is a silently useless map, so the value is refused like the
    /// landmark variance. (`0.0` stays legal — "match only an exact hit".)
    #[test]
    fn a_nonsensical_gate_squared_is_refused() {
        for gate in [f32::NAN, -1.0] {
            let mut s = SlamState::new();
            let control = SlamControl {
                gate_squared: gate,
                ..SlamControl::default()
            };
            assert_eq!(
                s.observe(SlamObservation::lidar(2.0, 0.0), &control),
                Err(SlamError::BadInput),
                "gate_squared = {gate} must be refused"
            );
            assert_eq!(s.num_landmarks(), 0);
        }
    }

    /// Every field of an observation the guard at the top of `observe` inspects, and the
    /// refusal each must produce.
    ///
    /// This test exists because the guard had **none**: with its whole body deleted the
    /// `slam::` suite stayed green (all 81 tests), so a field could be dropped from the
    /// list — or a malformed value classified as something other than `BadInput` — with no
    /// red test to say so. The two sensor-offset fields were in exactly that hole: absent
    /// from the list, and a non-finite offset came back as [`SlamError::Singular`] (the
    /// "the landmark lies on the robot" verdict) instead of `BadInput`, whose own doc reads
    /// "an input carried a non-finite value". The symmetric input guard on the other side
    /// of the seam, `McLocalizer::update`, checks both offset fields.
    ///
    /// **Correction (REQ-A840 / F-SH-269).** Covering every *field* did not cover every
    /// *leaf*. `!observation.bearing_variance.is_finite()` was in exactly that hole: this
    /// test fed only `NEG_INFINITY`, which the sibling `bearing_variance < 0.0` leaf also
    /// catches, so deleting the `is_finite` leaf kept the whole `slam::` suite green. The
    /// two leaves are not interchangeable — only a **positive** non-finite value exercises
    /// the `is_finite` leaf alone. With that leaf gone, `+INFINITY` sails past the guard,
    /// `observe` returns `Ok(Created)` — a landmark founded on a malformed reading — and
    /// the next reading at the same spot comes back `Singular`, the very "geometry verdict
    /// for a malformed input" this guard exists to avoid. Hence `bearing_variance` appears
    /// below **once per sign**.
    #[test]
    fn every_malformed_observation_field_is_refused_as_bad_input() {
        /// One way to break an observation: set a named field to a value the guard must refuse.
        type Corrupt = fn(&mut SlamObservation);
        // A non-finite value in any field is `BadInput`, and no landmark may be created: a
        // refusal that still mutated the state would be worse than no check at all.
        let non_finite: [(&str, Corrupt); 7] = [
            ("range_m", |o| o.range_m = f32::NAN),
            ("bearing_rad", |o| o.bearing_rad = f32::INFINITY),
            ("range_variance", |o| o.range_variance = f32::NAN),
            ("bearing_variance", |o| {
                o.bearing_variance = f32::NEG_INFINITY
            }),
            ("bearing_variance", |o| o.bearing_variance = f32::INFINITY),
            ("sensor_offset_x_m", |o| o.sensor_offset_x_m = f32::NAN),
            ("sensor_offset_y_m", |o| o.sensor_offset_y_m = f32::INFINITY),
        ];
        for (field, corrupt) in non_finite {
            let mut s = SlamState::new();
            let mut obs = SlamObservation::lidar(2.0, 0.1);
            corrupt(&mut obs);
            assert_eq!(
                s.observe(obs, &SlamControl::default()),
                Err(SlamError::BadInput),
                "a non-finite {field} must be BadInput, not a geometry verdict"
            );
            assert_eq!(s.num_landmarks(), 0, "a refused {field} adds no landmark");
        }

        // A negative variance is `BadInput` too. It is checked *after* the finiteness tests
        // for the reason the guard's comment gives: `NaN < 0.0` is `false`.
        let negative: [(&str, Corrupt); 2] = [
            ("range_variance", |o| o.range_variance = -1.0),
            ("bearing_variance", |o| o.bearing_variance = -1.0),
        ];
        for (field, corrupt) in negative {
            let mut s = SlamState::new();
            let mut obs = SlamObservation::lidar(2.0, 0.1);
            corrupt(&mut obs);
            assert_eq!(
                s.observe(obs, &SlamControl::default()),
                Err(SlamError::BadInput),
                "a negative {field} must be BadInput"
            );
            assert_eq!(s.num_landmarks(), 0);
        }

        // The complement, so this test cannot pass by refusing everything: a *negative*
        // offset is a legal placement (the scanner may sit behind or beside the centre) and
        // must be accepted. Only non-finiteness is malformed.
        let mut s = SlamState::new();
        let mut obs = SlamObservation::lidar(2.0, 0.0);
        obs.sensor_offset_x_m = -0.5;
        obs.sensor_offset_y_m = -0.25;
        assert!(
            s.observe(obs, &SlamControl::default()).is_ok(),
            "a negative sensor offset is a legal placement, not a malformed input"
        );
    }

    #[test]
    fn predict_refuses_non_finite_input() {
        let mut s = SlamState::new();
        let cmd = VelocityCommand {
            linear_m_s: f32::NAN,
            angular_rad_s: 0.0,
            dt_s: 0.1,
        };
        assert_eq!(
            s.predict(cmd, &SlamControl::default()),
            Err(SlamError::BadInput)
        );
    }

    /// A non-finite **pose** must be refused, not committed. The covariance guard at the end
    /// of `predict` inspects only the covariance buffer: a `NaN` x/y with a finite heading
    /// (so `f_02`/`f_12` stay finite) produced a fully finite covariance, the guard passed,
    /// and `NaN` was written to `self.pose` under an `Ok`. `with_pose` is public, so the
    /// state can start non-finite.
    #[test]
    fn predict_refuses_to_commit_a_non_finite_pose() {
        let mut s = SlamState::with_pose([f32::NAN, 0.0, 0.0], 0.1, 0.05);
        let cmd = VelocityCommand {
            linear_m_s: 1.0,
            angular_rad_s: 0.0,
            dt_s: 0.1,
        };
        assert_eq!(
            s.predict(cmd, &SlamControl::default()),
            Err(SlamError::BadInput),
            "a NaN pose must not be advanced and reported `Ok`"
        );
        assert!(
            s.pose()[0].is_nan(),
            "the state is left untouched, not sanitised"
        );
    }

    #[test]
    fn predict_refuses_a_non_positive_dt() {
        let mut s = SlamState::new();
        let cmd = VelocityCommand {
            linear_m_s: 1.0,
            angular_rad_s: 0.0,
            dt_s: 0.0,
        };
        assert_eq!(
            s.predict(cmd, &SlamControl::default()),
            Err(SlamError::BadInput)
        );
    }

    #[test]
    fn the_covariance_is_symmetric_after_a_predict_observe_round_trip() {
        let mut s = SlamState::new();
        s.predict(
            VelocityCommand {
                linear_m_s: 1.0,
                angular_rad_s: 0.1,
                dt_s: 0.05,
            },
            &SlamControl::default(),
        )
        .unwrap();
        // Predict alone must not break symmetry.
        let dim_after_predict = s.dim();
        for i in 0..dim_after_predict {
            for j in (i + 1)..dim_after_predict {
                let a = s.cov(i, j);
                let b = s.cov(j, i);
                assert!(
                    (a - b).abs() < 1e-4,
                    "after predict: Σ[{i},{j}]={a} ≠ Σ[{j},{i}]={b}"
                );
            }
        }
        s.observe(SlamObservation::lidar(2.0, 0.5), &SlamControl::default())
            .unwrap();
        let dim = s.dim();
        for i in 0..dim {
            for j in (i + 1)..dim {
                let a = s.cov(i, j);
                let b = s.cov(j, i);
                assert!((a - b).abs() < 1e-4, "Σ[{i},{j}]={a} ≠ Σ[{j},{i}]={b}");
            }
        }
    }

    #[test]
    fn predict_propagates_the_robot_covariance_numerically() {
        // A quiet, known case verified against the closed form: pose [0,0,0], σ_xy = 0.1
        // (var 0.01), σ_θ = 0.05 (var 0.0025), driven straight at 1 m/s for 50 ms. At θ = 0
        // the motion Jacobian is `F = [[1,0,0],[0,1,v·dt],[0,0,1]] = [[1,0,0],[0,1,0.05],
        // [0,0,1]]` (the `∂θ` column is `[−v·sinθ·dt, v·cosθ·dt, 0]ᵀ = [0, 0.05, 0]ᵀ`). Then
        //   Σ' = F Σ Fᵀ + Q
        // with `Q = diag(q_lin·dt², q_lin·dt², q_ang·dt²) = diag(0.1·0.0025, 0.1·0.0025,
        // 0.05·0.0025) = diag(2.5e-4, 2.5e-4, 1.25e-4)`. The cross term `Σ'[1,2]` picks up
        // the `v·dt` coupling: `0.05 · 0.0025 = 1.25e-4`. This test fails if the sparse
        // two-phase multiply drops a term or mis-applies Q.
        let mut s = SlamState::new();
        s.predict(
            VelocityCommand {
                linear_m_s: 1.0,
                angular_rad_s: 0.0,
                dt_s: 0.05,
            },
            &SlamControl::default(),
        )
        .unwrap();
        assert_eq!(s.pose(), [0.05, 0.0, 0.0]);
        assert!((s.cov(0, 0) - 0.010_25).abs() < 1e-6, "Σ00={}", s.cov(0, 0));
        assert!(
            (s.cov(1, 1) - 0.010_256_25).abs() < 1e-6,
            "Σ11={}",
            s.cov(1, 1)
        );
        assert!(
            (s.cov(2, 2) - 0.002_625).abs() < 1e-6,
            "Σ22={}",
            s.cov(2, 2)
        );
        assert!(
            (s.cov(1, 2) - 0.000_125).abs() < 1e-7,
            "Σ12={}",
            s.cov(1, 2)
        );
    }

    #[test]
    fn a_static_robot_with_observations_converges_to_the_true_landmark() {
        // Monte-Carlo with a fixed seed is overkill for a deterministic test; one run is
        // enough: the EKF's mean is biased toward zero on the first observation (the
        // robot's pose is uncertain), but repeated observations pull the landmark
        // toward its true position.
        let mut s = SlamState::new();
        for _ in 0..30 {
            s.observe(SlamObservation::lidar(5.0, 0.0), &SlamControl::default())
                .unwrap();
        }
        let lm = &s.landmarks()[0];
        assert!((lm.x_m - 5.0).abs() < 0.2, "x={}", lm.x_m);
        assert!(lm.y_m.abs() < 0.2, "y={}", lm.y_m);
    }

    /// `EkfSlam::pose` must forward the *state's* pose, not a stale copy: the wrapper's
    /// whole point is that one mutable borrow drives both the state and the policy, so the
    /// accessor has to track each `predict`.
    #[test]
    fn the_wrapper_reports_the_pose_it_just_predicted() {
        let mut slam = EkfSlam::default();
        assert_eq!(
            slam.pose(),
            [0.0, 0.0, 0.0],
            "a fresh wrapper is at the origin"
        );
        slam.predict(VelocityCommand {
            linear_m_s: 1.0,
            angular_rad_s: 0.0,
            dt_s: 0.2,
        })
        .expect("a valid command");
        let p = slam.pose();
        assert!((p[0] - 0.2).abs() < 1e-5, "x={}", p[0]);
        assert_eq!(slam.pose(), [p[0], p[1], p[2]], "forwarded, not recomputed");
    }

    #[test]
    fn the_wrapper_predicts_and_observes() {
        let mut slam = EkfSlam::default();
        slam.predict(VelocityCommand {
            linear_m_s: 0.5,
            angular_rad_s: 0.0,
            dt_s: 0.1,
        })
        .unwrap();
        slam.observe(SlamObservation::lidar(2.0, 0.0)).unwrap();
        assert_eq!(slam.num_landmarks(), 1);
    }

    #[test]
    fn the_gate_accounts_for_robot_pose_uncertainty() {
        // The landmark is initialised with a tiny variance (1e-6) while the *robot pose*
        // is very uncertain (σ = 1 m). A 0.5 m discrepancy is well inside the combined
        // uncertainty, so the observation must still match. A gate that consulted only
        // the landmark's own covariance would compute 0.5 / 1e-3 = 500 σ and refuse.
        let mut s = SlamState::with_pose([0.0, 0.0, 0.0], 1.0, 1.0);
        let control = SlamControl {
            initial_landmark_variance: 1e-6,
            ..SlamControl::default()
        };
        s.observe(SlamObservation::lidar(2.0, 0.0), &control)
            .expect("create");
        let outcome = s
            .observe(SlamObservation::lidar(2.5, 0.0), &control)
            .expect("observe");
        assert!(
            matches!(outcome, AssociationOutcome::Matched { .. }),
            "the innovation gate must admit a 0.5 m jump under 1 m pose uncertainty, got {outcome:?}"
        );
        assert_eq!(s.num_landmarks(), 1);
    }

    #[test]
    fn a_sensor_offset_is_honoured_by_both_the_prediction_and_the_update() {
        // The sensor sits 0.5 m ahead of the robot centre. A landmark measured at 2.0 m
        // from the sensor is at world x = 2.5. The second, identical observation must
        // leave that estimate where it is: if the update model dropped the offset (as it
        // did before), the predicted range would be 2.5 versus the reported 2.0 and every
        // observation would drag the landmark toward 2.25.
        let mut s = SlamState::new();
        let obs = SlamObservation {
            range_m: 2.0,
            bearing_rad: 0.0,
            range_variance: 0.0025,
            bearing_variance: (PI / 360.0) * (PI / 360.0),
            sensor_offset_x_m: 0.5,
            sensor_offset_y_m: 0.0,
        };
        s.observe(obs, &SlamControl::default()).expect("create");
        let lm = &s.landmarks()[0];
        assert!((lm.x_m - 2.5).abs() < 1e-4, "created at x={}", lm.x_m);
        let outcome = s.observe(obs, &SlamControl::default()).expect("observe");
        assert!(matches!(outcome, AssociationOutcome::Matched { .. }));
        assert_eq!(
            s.num_landmarks(),
            1,
            "the second observation is not a new landmark"
        );
        let lm = &s.landmarks()[0];
        assert!(
            (lm.x_m - 2.5).abs() < 1e-3,
            "a consistent observation must not move the landmark, got x={}",
            lm.x_m
        );
    }

    /// The test above runs a **pure-x** offset at heading `0`, where the body-to-world
    /// rotation is the identity — it shows the offset is *added*, never that it is *rotated*.
    /// Here both axes are non-zero and the robot is turned, so the cross terms
    /// `−oy·sinθ` / `+ox·sinθ` are what place the sensor. Measured, not assumed: flipping
    /// the sign of either cross-term in `observe`/`predict` leaves the whole `slam::` suite
    /// (80 tests) green, so this is the only thing pinning them.
    #[test]
    fn a_rotated_sensor_offset_is_honoured_by_the_prediction_and_the_update() {
        let pose = [1.0f32, -2.0f32, 0.9f32];
        let (ox, oy) = (0.4f32, 0.3f32);
        let mut s = SlamState::with_pose(pose, 0.05, 0.05);
        // A landmark the sensor sees dead ahead at 2 m.
        let obs = SlamObservation {
            range_m: 2.0,
            bearing_rad: 0.0,
            range_variance: 0.0025,
            bearing_variance: (PI / 360.0) * (PI / 360.0),
            sensor_offset_x_m: ox,
            sensor_offset_y_m: oy,
        };
        s.observe(obs, &SlamControl::default()).expect("create");

        let (c, sn) = (pose[2].cos(), pose[2].sin());
        let expect_x = pose[0] + ox * c - oy * sn + 2.0 * c;
        let expect_y = pose[1] + ox * sn + oy * c + 2.0 * sn;
        let lm = &s.landmarks()[0];
        assert!(
            (lm.x_m - expect_x).abs() < 1e-3 && (lm.y_m - expect_y).abs() < 1e-3,
            "the landmark must be created at the sensor's rotated world position plus the \
             range along the heading, expected ({expect_x}, {expect_y}), got ({}, {})",
            lm.x_m,
            lm.y_m
        );

        // A repeat of the same observation is consistent only if the *update* rotates the
        // offset the same way; otherwise it pulls the landmark toward the un-offset spot.
        for _ in 0..3 {
            let outcome = s.observe(obs, &SlamControl::default()).expect("observe");
            assert!(matches!(outcome, AssociationOutcome::Matched { .. }));
        }
        let lm = &s.landmarks()[0];
        assert!(
            (lm.x_m - expect_x).abs() < 1e-2 && (lm.y_m - expect_y).abs() < 1e-2,
            "a consistent observation must not walk the landmark, expected ({expect_x}, \
             {expect_y}), got ({}, {})",
            lm.x_m,
            lm.y_m
        );
    }

    #[test]
    fn a_landmarks_stored_covariance_mirrors_the_filter_marginal() {
        // `Landmark::cov` is what the standalone data-association gate reads, so it must
        // be the filter's marginal block, not the value frozen at initialisation.
        let mut s = SlamState::new();
        let control = SlamControl::default();
        s.observe(SlamObservation::lidar(2.0, 0.0), &control)
            .expect("create");
        for _ in 0..5 {
            s.observe(SlamObservation::lidar(2.0, 0.0), &control)
                .expect("observe");
        }
        let lm = s.landmarks()[0];
        assert_eq!(lm.cov[0], s.cov(3, 3));
        assert_eq!(lm.cov[1], s.cov(3, 4));
        assert_eq!(lm.cov[2], s.cov(4, 3));
        assert_eq!(lm.cov[3], s.cov(4, 4));
        assert!(
            lm.cov[0] > 0.0 && lm.cov[0] < control.initial_landmark_variance,
            "repeated observation must shrink the marginal below its initial value, got {}",
            lm.cov[0]
        );
        // A prediction grows the marginal, and the mirror must follow it.
        s.predict(
            VelocityCommand {
                linear_m_s: 1.0,
                angular_rad_s: 0.0,
                dt_s: 0.1,
            },
            &control,
        )
        .expect("predict");
        assert_eq!(s.landmarks()[0].cov[0], s.cov(3, 3));
    }

    #[test]
    fn a_covariance_that_blows_up_is_refused_not_silently_partially_written() {
        // Drive the process noise to a finite but enormous value so `Σ` overflows to
        // infinity; the step must report the failure and leave the state untouched rather
        // than copying the finite cells and reporting `Ok`.
        let mut s = SlamState::new();
        let control = SlamControl {
            process_noise_linear: 1e30,
            process_noise_angular: 1e30,
            ..SlamControl::default()
        };
        let before = s.cov(0, 0);
        // `q · dt² = 1e90` overflows `f32` to infinity.
        let result = s.predict(
            VelocityCommand {
                linear_m_s: 1.0,
                angular_rad_s: 0.0,
                dt_s: 1e30,
            },
            &control,
        );
        assert_eq!(result, Err(SlamError::BadInput));
        assert_eq!(
            s.cov(0, 0),
            before,
            "a failed step must not mutate the state"
        );
        assert_eq!(s.pose(), [0.0, 0.0, 0.0]);
    }

    /// A singular innovation covariance must be a **typed refusal**, never a silent "no
    /// match": the latter would make `observe` initialise a duplicate landmark at the same
    /// place. This test pins both the error and the absence of the duplicate.
    #[test]
    fn a_singular_innovation_covariance_is_refused_not_turned_into_a_duplicate_landmark() {
        let mut s = SlamState::with_pose([0.0, 0.0, 0.0], 0.0, 0.0);
        let control = SlamControl::default();
        // The first observation *creates* the landmark, so the second one takes the gate path.
        s.observe(SlamObservation::lidar(2.0, 0.0), &control)
            .expect("create");
        assert_eq!(s.num_landmarks(), 1);
        // Collapse the landmark's covariance block to zero (the robot's is already zero, from
        // the zero pose sigma) and pass zero measurement noise, so `S = H Σ Hᵀ + R = 0` — the
        // exactly-singular case.
        s.set_cov(3, 3, 0.0);
        s.set_cov(4, 4, 0.0);
        let zero_noise = SlamObservation {
            range_variance: 0.0,
            bearing_variance: 0.0,
            ..SlamObservation::lidar(2.0, 0.0)
        };
        let err = s
            .observe(zero_noise, &control)
            .expect_err("a singular S must be refused, not gated out");
        assert_eq!(err, SlamError::Singular);
        assert_eq!(
            s.num_landmarks(),
            1,
            "the refusal must not leave a duplicate landmark behind"
        );
    }

    /// The **other** half of `det`'s two-leaf refusal. The test above drives the determinant
    /// to `0.0`, which `det.abs() <= MIN_INNOVATION_DET` catches; that sibling does **not**
    /// catch a non-finite determinant (`inf.abs()` is `inf`, and every comparison with `NaN`
    /// is false), so only `!det.is_finite()` does. A variance the `observe` boundary accepts
    /// — finite and non-negative, but enormous — makes `S = H Σ Hᵀ + R` overflow, so
    /// `det = s₀·s₃ − s₁·s₂` becomes `+inf`. Without the leaf, `inv` would be `[0, 0, 0, 0]`,
    /// `d²` would come out `0.0` — a *perfect* match — and the reading would associate with
    /// the landmark instead of being refused.
    #[test]
    fn an_overflown_innovation_determinant_is_refused_not_read_as_a_perfect_match() {
        let mut s = SlamState::with_pose([0.0, 0.0, 0.0], 0.0, 0.0);
        let control = SlamControl::default();
        s.observe(SlamObservation::lidar(2.0, 0.0), &control)
            .expect("create");
        // Finite (`< f32::MAX`) and non-negative, so the observation boundary accepts it;
        // large enough that the 2×2 product `s₀·s₃` overflows `f32` to `+inf`.
        let overflowing = SlamObservation {
            range_variance: 3.0e38,
            bearing_variance: 3.0e38,
            ..SlamObservation::lidar(2.0, 0.0)
        };
        let err = s
            .observe(overflowing, &control)
            .expect_err("an overflown determinant must be refused, not read as d² = 0");
        assert_eq!(err, SlamError::Singular);
        assert_eq!(
            s.num_landmarks(),
            1,
            "the refusal must not leave a duplicate landmark behind"
        );
    }

    /// The `measurement` front-end's two-leaf guard (`!q.is_finite() || q <= MIN_RANGE_M`) is
    /// the only thing that keeps a landmark the robot cannot *measure* from being read as one
    /// it cannot *resolve*. Both leaves are reachable through the public API, and they are
    /// reached by **different** inputs, so each needs its own case — the family's rule is that
    /// a leaf no test walks is a leaf that dies silently:
    ///
    /// * `q == 0` — `range_m = 0` is finite, so the `observe` boundary accepts it, and the
    ///   landmark is founded exactly on the sensor origin; re-observing it gives `q == 0`,
    ///   caught only by `q <= MIN_RANGE_M` (`0.0 <= 1e-6`; `!0.0.is_finite()` is `false`).
    /// * `q == inf` — this crate does not bound `range_m`, so a finite-but-huge reading founds
    ///   the landmark far enough that `q² = dx² + dy²` overflows `f32`; `q` is then `+inf`,
    ///   caught only by `!q.is_finite()` (`inf <= 1e-6` is `false`).
    ///
    /// With the guard, either reading is **skipped** in the association scan and a duplicate is
    /// created ([`AssociationOutcome::Created`]). Without it, the coincidence reaches the
    /// bearing Jacobian as `dx/q = 0/0 = NaN` and the overflow reaches it as
    /// `innovation = z − q = ±inf`; both come back as a hard [`SlamError::Singular`] — the
    /// "the landmark lies on the robot" verdict for what is really an unmeasurable landmark.
    #[test]
    fn a_landmark_the_robot_cannot_measure_is_skipped_not_a_singular_innovation() {
        let control = SlamControl::default();

        // (a) coincidence leaf: `q == 0`.
        let mut s = SlamState::new();
        let coincident = SlamObservation::lidar(0.0, 0.3);
        assert_eq!(
            s.observe(coincident, &control).expect("create"),
            AssociationOutcome::Created { landmark_index: 0 }
        );
        assert_eq!(
            s.observe(coincident, &control).expect("skip, not Singular"),
            AssociationOutcome::Created { landmark_index: 1 },
            "a landmark the robot sits on must be skipped, not resolved"
        );
        assert_eq!(
            s.num_landmarks(),
            2,
            "the skipped reading creates a duplicate rather than matching"
        );

        // (b) finiteness leaf: `q == inf`.
        let mut s = SlamState::new();
        let far = SlamObservation::lidar(1.0e30, 0.0);
        assert_eq!(
            s.observe(far, &control).expect("create"),
            AssociationOutcome::Created { landmark_index: 0 }
        );
        assert_eq!(
            s.observe(far, &control).expect("skip, not Singular"),
            AssociationOutcome::Created { landmark_index: 1 },
            "a landmark whose squared range overflows must be skipped, not resolved"
        );
        assert_eq!(
            s.num_landmarks(),
            2,
            "the skipped reading creates a duplicate rather than matching"
        );

        // Control: the same shape at a *measurable* range matches the existing landmark, so the
        // two cases above are not passing because every second observation duplicates.
        let mut s = SlamState::new();
        let roomy = SlamObservation::lidar(2.0, 0.3);
        assert_eq!(
            s.observe(roomy, &control).expect("create"),
            AssociationOutcome::Created { landmark_index: 0 }
        );
        assert_eq!(
            s.observe(roomy, &control).expect("match"),
            AssociationOutcome::Matched { landmark_index: 0 },
            "a measurable landmark must match, not duplicate"
        );
        assert_eq!(s.num_landmarks(), 1);
    }

    /// The `lm_x`/`lm_y` net below the observation guard is the crate's **last** line of
    /// defence on the predicted landmark position, and its verdict must be the one the
    /// guard's own comment argues for: a *malformed input*, i.e. `BadInput` — **not**
    /// `Singular`, the *geometry* verdict ("the landmark lies on the robot") whose own doc
    /// reads that way and which a caller resolves by retrying from another pose. A value
    /// that overflows the landmark position never heals on a retry.
    ///
    /// The guard above cannot cover this alone: it checks the offset fields for
    /// **finiteness only** (deliberately — what counts as an implausible offset depends on
    /// the robot, which this crate does not know), and `range_m` is not bounded at all. So
    /// a reading built entirely from **finite** values still overflows the sum that
    /// `predict_landmark_position` assembles. Both cases below are finite inputs, so no
    /// `is_finite` leaf in the guard fires and this net is the only thing standing between
    /// them and a landmark founded on `±inf`.
    ///
    /// Both leaves are exercised separately — `range·cos` overflows `lm_x`, `range·sin`
    /// overflows `lm_y` — since the guard is a two-leaf `!a.is_finite() || !b.is_finite()`
    /// and the family's rule is that a leaf no test walks is a leaf that dies silently.
    #[test]
    fn a_finite_reading_that_overflows_the_landmark_position_is_bad_input() {
        let control = SlamControl::default();
        // `f32::MAX + f32::MAX` is `+inf`, and each operand is finite, so the guard passes
        // both. `bearing = 0` puts the whole range on the x axis; `bearing = π/2` puts it on
        // the y axis (cos π/2 is ≈ −4.4e−8, so `lm_x` stays finite and only `lm_y` blows up).
        let cases = [("x", 0.0_f32), ("y", std::f32::consts::FRAC_PI_2)];
        for (axis, bearing) in cases {
            let mut s = SlamState::with_pose([0.0, 0.0, 0.0], 0.0, 0.0);
            // `range_m` and the offset that carries it are both `f32::MAX`: separate
            // fields, both finite, and they meet only inside the predicted position.
            let overflowing = SlamObservation {
                range_m: f32::MAX,
                bearing_rad: bearing,
                sensor_offset_x_m: f32::MAX,
                sensor_offset_y_m: f32::MAX,
                ..SlamObservation::lidar(2.0, 0.0)
            };
            assert_eq!(
                s.observe(overflowing, &control),
                Err(SlamError::BadInput),
                "a finite reading that overflows lm_{axis} must be refused as a malformed \
                 input, not as a geometry verdict"
            );
            assert_eq!(
                s.num_landmarks(),
                0,
                "the refusal must not leave a landmark founded on a non-finite position"
            );
        }
        // The control: a bounded reading at the same pose still creates a landmark, so the
        // two assertions above cannot be passing because everything is refused.
        let mut s = SlamState::with_pose([0.0, 0.0, 0.0], 0.0, 0.0);
        assert!(s
            .observe(SlamObservation::lidar(2.0, 0.0), &control)
            .is_ok());
        assert_eq!(s.num_landmarks(), 1);
    }

    /// The module's third honest boundary: the filter must not silently accept a non-PD
    /// covariance. This runs a Cholesky factorisation of the active block — the operational
    /// definition of symmetric positive-definite — after a predict, a create and a real
    /// update. A negative or zero leading minor fails the `sqrt` guard.
    #[test]
    fn the_covariance_stays_positive_definite_through_predict_create_and_update() {
        let mut s = SlamState::with_pose([0.0, 0.0, 0.0], 0.1, 0.1);
        let control = SlamControl::default();
        s.predict(
            VelocityCommand {
                linear_m_s: 0.5,
                angular_rad_s: 0.1,
                dt_s: 0.1,
            },
            &control,
        )
        .expect("predict");
        s.observe(SlamObservation::lidar(2.0, 0.0), &control)
            .expect("create");
        s.observe(SlamObservation::lidar(2.05, 0.01), &control)
            .expect("update");

        let n = s.dim();
        let mut l = vec![0.0f64; n * n];
        for i in 0..n {
            for j in 0..=i {
                let mut sum = s.cov(i, j) as f64;
                for k in 0..j {
                    sum -= l[i * n + k] * l[j * n + k];
                }
                if i == j {
                    assert!(
                        sum > 0.0,
                        "leading minor {i} is not positive ({sum}); Σ is not positive-definite"
                    );
                    l[i * n + j] = sum.sqrt();
                } else {
                    l[i * n + j] = sum / l[j * n + j];
                }
            }
        }
    }

    #[test]
    fn wrap_angle_normalises_to_the_half_open_interval() {
        assert!((wrap_angle(PI) - PI).abs() < 1e-5);
        assert!((wrap_angle(-PI) - PI).abs() < 1e-5);
        assert!(wrap_angle(3.0 * PI).abs() <= PI + 1e-5);
        // A non-finite angle is passed through, **not** mapped to `0.0` (which would read as
        // a perfect bearing match downstream). See the function's doc.
        assert!(wrap_angle(f32::NAN).is_nan());
        assert_eq!(wrap_angle(f32::INFINITY), f32::INFINITY);
    }

    // --- Joint Compatibility Branch and Bound (JCBB) -----------------------------------

    /// A state at the origin with two seed landmarks, ~0.06 m apart at range 5, and a *small*
    /// pose/landmark covariance so the association gate is dominated by the measurement noise
    /// (the geometry stays legible). Both landmarks are `ever_observed`.
    fn seeded_state() -> SlamState {
        let mut state = SlamState::with_pose([0.0, 0.0, 0.0], 0.02, 0.01);
        state
            .add_landmark(Landmark::new(5.0, 0.0, 0.02))
            .expect("first landmark");
        state
            .add_landmark(Landmark::new(5.0, 0.06, 0.02))
            .expect("second landmark");
        state
    }

    /// The discriminating pair for JCBB. Two readings both sit nearer landmark 0 than landmark
    /// 1, yet each is *individually* compatible with both (all four pairs pass the gate). The
    /// single-reading `observe` has no one-to-one constraint, so it double-books landmark 0 —
    /// both readings match it. JCBB must split them: whichever reading takes landmark 0, the
    /// other is forced onto landmark 1, which is the whole point of the joint test.
    #[test]
    fn a_joint_batch_splits_a_contested_landmark_where_sequential_observe_double_books_it() {
        let control = SlamControl::default();
        // Bearing 0.001 vs 0.004; landmark 1 is at bearing ≈ 0.012. Both readings are closest
        // to landmark 0 (0.001 and 0.004 beat 0.011 and 0.008), so the *nearest* rule collides.
        let a = SlamObservation::lidar(5.0, 0.001);
        let b = SlamObservation::lidar(5.0, 0.004);

        // Sequential `observe`: both readings' nearest is the same landmark, and nothing
        // forbids matching it twice.
        let mut sequential = seeded_state();
        assert_eq!(
            sequential.observe(a, &control).unwrap(),
            AssociationOutcome::Matched { landmark_index: 0 }
        );
        assert_eq!(
            sequential.observe(b, &control).unwrap(),
            AssociationOutcome::Matched { landmark_index: 0 },
            "the single-reading path double-books landmark 0"
        );

        // Joint association keeps the pairing one-to-one. The lower-gate assignment is
        // A→landmark 0 (its nearest), B→landmark 1.
        let mut joint = seeded_state();
        let verdicts = joint.associate_joint(&[a, b], &control).unwrap();
        assert_eq!(verdicts.len(), 2);
        let indices: Vec<u16> = verdicts
            .iter()
            .map(|v| match v {
                Association::Match { landmark_index, .. } => *landmark_index,
                Association::New { .. } => panic!("both readings are within the gate: {v:?}"),
            })
            .collect();
        assert_ne!(indices[0], indices[1], "the pairing must be one-to-one");
        assert_eq!(
            indices,
            vec![0, 1],
            "A keeps its nearest landmark 0; B is forced onto landmark 1"
        );

        // …and the batch applies it without founding a duplicate.
        let outcome = joint.observe_batch(&[a, b], &control).unwrap();
        assert_eq!(
            outcome,
            BatchOutcome {
                matched: 2,
                created: 0
            }
        );
        assert_eq!(
            joint.num_landmarks(),
            2,
            "no duplicate landmark was founded"
        );
    }

    /// The joint test is load-bearing: a pairing in which **every pair passes its own gate**
    /// can still be jointly impossible, and JCBB must reject it.
    ///
    /// A large heading uncertainty (σ_θ = 0.3 rad) makes both readings' bearings ~99.9%
    /// correlated through the one unknown heading. Two readings displaced to *opposite* sides
    /// of the landmark pair then have innovations of opposite sign in that shared direction:
    /// each is individually plausible (either could be explained by a heading error), but no
    /// single heading explains both at once, so the stacked innovation is enormous. The search
    /// is therefore forced down from a size-2 pairing to a size-1 one — the second reading is
    /// honestly `New`. Disabling the joint test (accepting every hypothesis) would match both.
    #[test]
    fn a_jointly_inconsistent_pairing_is_rejected_even_when_each_pair_passes_its_own_gate() {
        let mut state = SlamState::with_pose([0.0, 0.0, 0.0], 0.02, 0.3);
        state
            .add_landmark(Landmark::new(5.0, 0.0, 0.02))
            .expect("landmark 0");
        state
            .add_landmark(Landmark::new(5.0, 0.1, 0.02))
            .expect("landmark 1");
        let control = SlamControl::default();
        // Landmark bearings are ~0 and ~0.02 rad; the readings sit at −0.03 and +0.05.
        let a = SlamObservation::lidar(5.0, -0.03);
        let b = SlamObservation::lidar(5.0, 0.05);

        // Every pair clears its own 95% gate — the ambiguity is real, not a mis-gated pair.
        for (obs, lm) in [(a, 0), (a, 1), (b, 0), (b, 1)] {
            let d2 = state
                .innovation_gate_squared(lm, &obs)
                .expect("gate is well defined")
                .expect("landmark is measurable");
            assert!(
                d2 <= CHI2_2DOF_95,
                "pair (obs bearing {}, landmark {lm}) must pass its own gate, got d2 = {d2}",
                obs.bearing_rad
            );
        }

        // …yet no one-to-one pairing of both readings survives the joint test, so exactly one
        // reading is left without a landmark.
        let verdicts = state.associate_joint(&[a, b], &control).unwrap();
        assert_eq!(verdicts.len(), 2);
        let created = verdicts
            .iter()
            .filter(|v| matches!(v, Association::New { .. }))
            .count();
        assert_eq!(
            created, 1,
            "a jointly impossible pairing must drop to size 1, got {verdicts:?}"
        );
    }

    /// A sweep over the joint cap is **refused** with its size, never truncated: silently
    /// dropping readings would leave the caller believing the whole scan was associated.
    #[test]
    fn a_batch_larger_than_the_joint_cap_is_refused_with_its_size() {
        let state = seeded_state();
        let control = SlamControl::default();
        let batch = vec![SlamObservation::lidar(5.0, 0.0); MAX_JCBB_OBSERVATIONS + 1];
        match state.associate_joint(&batch, &control) {
            Err(SlamError::TooManyObservations { given }) => {
                assert_eq!(given, MAX_JCBB_OBSERVATIONS + 1)
            }
            other => panic!("expected TooManyObservations, got {other:?}"),
        }
    }

    /// Two runs over the same inputs produce the same pairing — the module's determinism
    /// promise, and what lets a regression test pin the search's tie-break.
    #[test]
    fn joint_association_is_deterministic_across_runs() {
        let control = SlamControl::default();
        let batch = [
            SlamObservation::lidar(5.0, 0.001),
            SlamObservation::lidar(5.0, 0.004),
        ];
        let first = seeded_state().associate_joint(&batch, &control).unwrap();
        let second = seeded_state().associate_joint(&batch, &control).unwrap();
        assert_eq!(first, second);
    }

    /// An empty batch associates nothing and changes nothing.
    #[test]
    fn an_empty_batch_is_a_no_op() {
        let control = SlamControl::default();
        assert!(seeded_state()
            .associate_joint(&[], &control)
            .unwrap()
            .is_empty());
        let mut state = seeded_state();
        assert_eq!(
            state.observe_batch(&[], &control).unwrap(),
            BatchOutcome {
                matched: 0,
                created: 0
            }
        );
        assert_eq!(state.num_landmarks(), 2);
    }

    /// A reading no existing landmark can explain founds exactly one landmark.
    #[test]
    fn a_batch_founds_a_landmark_for_a_reading_no_existing_one_can_explain() {
        let control = SlamControl::default();
        let mut state = seeded_state();
        let far = SlamObservation::lidar(3.0, 1.0); // bearing 1 rad: nowhere near either
        let verdicts = state.associate_joint(&[far], &control).unwrap();
        assert!(
            matches!(verdicts[0], Association::New { .. }),
            "got {:?}",
            verdicts[0]
        );
        let outcome = state.observe_batch(&[far], &control).unwrap();
        assert_eq!(
            outcome,
            BatchOutcome {
                matched: 0,
                created: 1
            }
        );
        assert_eq!(state.num_landmarks(), 3);
    }

    /// An unambiguous single-reading batch reaches the same landmark `observe` does — the joint
    /// path must not disagree with the single path when there is nothing to disambiguate.
    #[test]
    fn an_unambiguous_single_reading_batch_agrees_with_observe() {
        let control = SlamControl::default();
        let obs = SlamObservation::lidar(5.0, 0.0); // dead on landmark 0
        let single = seeded_state().observe(obs, &control).unwrap();
        let verdicts = seeded_state().associate_joint(&[obs], &control).unwrap();
        match (single, verdicts[0]) {
            (
                AssociationOutcome::Matched { landmark_index: a },
                Association::Match {
                    landmark_index: b, ..
                },
            ) => assert_eq!(a, b),
            other => panic!("both paths must match the same landmark, got {other:?}"),
        }
    }

    /// A reading with no landmark inside its gate is honestly `New` with **no** claimed
    /// distance (`INFINITY`) — not a fabricated `0`, which would read as a perfect match.
    #[test]
    fn a_new_verdict_with_no_candidate_claims_no_distance() {
        let control = SlamControl::default();
        let state = seeded_state();
        // Bearing 0.5 rad: far outside the 95% gate of either landmark.
        let verdicts = state
            .associate_joint(&[SlamObservation::lidar(5.0, 0.5)], &control)
            .unwrap();
        match verdicts[0] {
            Association::New { distance } => {
                assert!(distance.is_infinite(), "expected INFINITY, got {distance}")
            }
            other => panic!("expected New, got {other:?}"),
        }
    }

    /// Every malformed reading is refused as `BadInput`, whether alone or beside a good one —
    /// the batch path carries the same verdict the single path does.
    #[test]
    fn every_malformed_reading_in_a_batch_is_refused_as_bad_input() {
        let control = SlamControl::default();
        let state = seeded_state();
        let good = SlamObservation::lidar(5.0, 0.0);
        let cases = [
            SlamObservation {
                range_m: f32::NAN,
                ..good
            },
            SlamObservation {
                bearing_rad: f32::INFINITY,
                ..good
            },
            SlamObservation {
                range_variance: -1.0,
                ..good
            },
            SlamObservation {
                bearing_variance: f32::NAN,
                ..good
            },
            SlamObservation {
                sensor_offset_x_m: f32::NAN,
                ..good
            },
        ];
        for bad in cases {
            assert_eq!(
                state.associate_joint(&[bad], &control),
                Err(SlamError::BadInput),
                "a lone malformed reading must be refused: {bad:?}"
            );
            assert_eq!(
                state.associate_joint(&[good, bad], &control),
                Err(SlamError::BadInput),
                "a malformed reading among good ones must be refused: {bad:?}"
            );
        }
    }

    /// A non-finite or negative gate is refused by the batch path, exactly as `observe`
    /// refuses it — `d² ≤ gate` is never satisfied, so every reading would be "new".
    #[test]
    fn the_batch_path_refuses_a_nonsensical_gate() {
        let state = seeded_state();
        let obs = [SlamObservation::lidar(5.0, 0.0)];
        for gate in [f32::NAN, f32::INFINITY, -1.0] {
            let control = SlamControl {
                gate_squared: gate,
                ..SlamControl::default()
            };
            assert_eq!(
                state.associate_joint(&obs, &control),
                Err(SlamError::BadInput),
                "gate {gate} must be refused"
            );
        }
    }

    /// `observe_batch` founds a landmark, so it must guard the field that seeds one: a
    /// negative or non-finite `initial_landmark_variance` reaches `Landmark::new` as
    /// `NaN.sqrt()`, which its `sigma.max(0.0)²` folds to a *zero*-covariance landmark — the
    /// exact "perfectly known" inversion the single path refuses up front. Nothing is founded
    /// by a refused batch.
    #[test]
    fn the_batch_path_refuses_an_invalid_initial_landmark_variance_before_founding_anything() {
        let mut state = seeded_state();
        let far = SlamObservation::lidar(3.0, 1.0); // no existing landmark explains it
        for variance in [f32::NAN, f32::INFINITY, -1.0] {
            let control = SlamControl {
                initial_landmark_variance: variance,
                ..SlamControl::default()
            };
            assert_eq!(
                state.observe_batch(&[far], &control),
                Err(SlamError::BadInput),
                "initial_landmark_variance {variance} must be refused"
            );
        }
        assert_eq!(
            state.num_landmarks(),
            2,
            "a refused batch must not have founded a landmark"
        );
        // …while a *zero* variance stays legal (a deliberately seeded known landmark), the same
        // stance `observe` takes.
        let control = SlamControl {
            initial_landmark_variance: 0.0,
            ..SlamControl::default()
        };
        assert_eq!(
            state.observe_batch(&[far], &control).unwrap(),
            BatchOutcome {
                matched: 0,
                created: 1
            }
        );
        assert_eq!(state.num_landmarks(), 3);
    }
}
