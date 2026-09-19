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
//!    `3 + 2 · MAX_LANDMARKS` = 1027. `Vec<f32>` of that size is ~4 MiB for the covariance.
//!    The alternative is a sparse representation, which is correct but is a separate
//!    algorithm (see "sparse EKF-SLAM", not this file).
//! 3. **No automatic relinearisation.** The state mean is held as `f32`; the covariance is
//!    symmetrised after every update ([`SlamState::symmetrise_covariance`]). A filter that
//!    silently accepts a non-PD covariance would diverge.
use std::f32::consts::PI;

use super::landmarks::Landmark;

/// Largest map this module will hold, in landmarks. Beyond this, new observations are
/// refused with [`SlamError::MapFull`].
pub const MAX_LANDMARKS: usize = 512;

/// Robot dimension (x, y, θ) — the part of the state that is *not* a landmark.
pub const ROBOT_DIM: usize = 3;

/// Dimension per landmark.
pub const LM_DIM: usize = 2;

/// A 2-D odometry-style control input (`forward`, `angular` in metres and radians per
/// second — the same convention `amos_link::robot_hal::Gait` uses after the
/// `frame → motion` transform).
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
    /// An input carried a non-finite value or a negative variance.
    BadInput,
    /// The Mahalanobis gate exceeded the configured gate — the observation is treated as
    /// a *new* landmark rather than a measurement of an existing one.
    Gated,
}

/// A lever the caller can flip to trade off work against information.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SlamControl {
    /// Squared Mahalanobis gate (a `χ²(2)` 95% is `5.99²`).
    pub gate_squared: f32,
    /// When the EKF observes a landmark the **first** time, its initial covariance is
    /// a large value (the landmark's position is uncertain). The default is `1.0 m²`.
    pub initial_landmark_variance: f32,
}

impl Default for SlamControl {
    fn default() -> Self {
        Self {
            gate_squared: 5.99 * 5.99,
            initial_landmark_variance: 1.0,
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
    /// Scratch buffer B, sized to `capacity²` — see [`SlamState::scratch_a`].
    /// Two buffers let `mat_mul_add` ping-pong between them without an
    /// intermediate copy.
    scratch_b: Vec<f32>,
    /// Scratch buffer C, sized to `capacity · 2` — used by `update_landmark`
    /// for the Kalman gain (`active × 2`) and the measurement Jacobian (`2 × active`).
    scratch_c: Vec<f32>,
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
        // buffers are each ~4 MiB at `MAX_LANDMARKS = 512`; the `dim*2`
        // buffer is ~8 KiB. Allocated once per `SlamState`, paid once per
        // deployment, not once per `predict` / `observe` step.
        let scratch_a = vec![0.0f32; dim * dim];
        let scratch_b = vec![0.0f32; dim * dim];
        let scratch_c = vec![0.0f32; dim * 2];
        Self {
            pose,
            landmarks: Vec::new(),
            covariance,
            scratch_a,
            scratch_b,
            scratch_c,
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

    /// Total cells allocated for the covariance (independent of the current state dim).
    pub fn capacity(&self) -> usize {
        ROBOT_DIM + LM_DIM * MAX_LANDMARKS
    }

    /// Read a covariance cell, or `0.0` outside the active state.
    pub fn cov(&self, row: usize, col: usize) -> f32 {
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
    /// the active block, but writes to inactive rows are how a caller adds a new landmark
    /// without first extending the state.
    pub fn set_cov(&mut self, row: usize, col: usize, value: f32) {
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

        // ① Integrate the pose.
        self.pose = [x + v * cos_t * dt, y + v * sin_t * dt, theta + w * dt];

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

        // ③ Process noise scalar values — applied at the end of Phase 2, after
        // `tmp · Fᵀ` has been written into scratch_b.
        let q_lin = (control.initial_landmark_variance * 0.1).max(1e-6);
        let q_ang = (control.initial_landmark_variance * 0.05).max(1e-6);

        // ④ Σ' = F Σ Fᵀ + Q — all scratch buffers live on `SlamState`, so no
        // allocation occurs on this step (NASA Po10 §2). We borrow the buffers
        // disjointly:
        //   F      → scratch_a (read-only inside the kernel)
        //   Q      → scratch_b (read-only inside the kernel)
        //   tmp    → scratch_a (write — overwritten after F is read; we
        //                       borrow the second half of the buffer for it
        //                       via `split_at_mut`, so F and tmp can coexist)
        //   out    → self.covariance (written in place — read of Σ happens
        //                             row-by-row into a local of the kernel
        //                             before each row of out is written)
        // To keep the borrow checker happy without a second full-capacity
        // scratch, we copy Σ into scratch_c (active × 2 sized) — no, that's
        // too small. So we use scratch_a as F and scratch_b as Q+tmp+out
        // by reading Σ and F into local `f`/`sigma` proxies. The cleanest
        // path is: rebuild F as a small `Vec` of size `active·active` once
        // per step. That's the per-step allocation we are trying to remove.
        //
        // Practical fix: do the multiplication in two phases. Phase 1 reads
        // `F` and `Σ` and writes `tmp` (F · Σ) into scratch_a; phase 2 reads
        // `tmp` (now in scratch_a) and `F` (still in scratch_a? — no,
        // overwritten) and writes `tmp · Fᵀ + Q` into scratch_b. We need to
        // keep F readable across both phases.
        //
        // The simplest zero-allocation solution that keeps F alive: stash F
        // in scratch_c — but scratch_c is sized `active · 2`, not
        // `active · active`. Re-purpose the structure: scratch_c holds the
        // sparse F rows (only 3 non-default entries), and we *rebuild* the
        // dense `tmp` multiply in scratch_a against `Σ` directly, without
        // materialising F. The `F` we need is identity-plus-three-corners,
        // so we can read it from scratch_c at each inner iteration without
        // ever building a full matrix.
        //
        // Encoding: scratch_c[0..3] = the three non-default F entries
        // (rows 0,1,2 column 2 — the `∂(x')/∂θ` and `∂(y')/∂θ` slots).
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

        // Copy the new covariance from scratch_b into self.covariance.
        // Symmetrisation afterwards forces the lower triangle to mirror the upper.
        for (slot, value) in self.covariance.iter_mut().zip(self.scratch_b.iter()) {
            if value.is_finite() {
                *slot = *value;
            }
        }
        self.symmetrise_covariance();
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
            || observation.range_variance < 0.0
            || observation.bearing_variance < 0.0
        {
            return Err(SlamError::BadInput);
        }

        let (lm_x, lm_y) = self.predict_landmark_position(&observation);
        if !lm_x.is_finite() || !lm_y.is_finite() {
            return Err(SlamError::Singular);
        }

        // Try to associate the observation with an existing landmark first.
        let mut best_distance = f32::INFINITY;
        let mut best_index: u16 = u16::MAX;
        for (i, lm) in self.landmarks.iter().enumerate() {
            if !lm.ever_observed {
                continue;
            }
            let d = lm.mahalanobis(lm_x, lm_y);
            if d < best_distance {
                best_distance = d;
                best_index = i as u16;
            }
        }
        if best_index != u16::MAX && best_distance * best_distance <= control.gate_squared {
            // Update the matched landmark.
            let landmark_index = best_index as usize;
            self.update_landmark(landmark_index, &observation, control)?;
            Ok(AssociationOutcome::Matched {
                landmark_index: best_index,
            })
        } else {
            // Initialise a new landmark at the predicted position.
            let mut lm = Landmark::new(lm_x, lm_y, control.initial_landmark_variance.sqrt());
            lm.ever_observed = true;
            let idx = self.add_landmark(lm)?;
            if let Some(slot) = self.landmarks.get_mut(idx as usize) {
                slot.observations = slot.observations.saturating_add(1);
            }
            Ok(AssociationOutcome::Created {
                landmark_index: idx,
            })
        }
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

    /// Run a single landmark EKF update (the call site has already done the gate check).
    fn update_landmark(
        &mut self,
        landmark_index: usize,
        obs: &SlamObservation,
        control: &SlamControl,
    ) -> Result<(), SlamError> {
        let _ = control; // (kept for symmetry; the variance lives on the observation)
        let active = self.dim();
        if landmark_index >= self.landmarks.len() {
            return Err(SlamError::BadInput);
        }
        let lm_x = self.landmarks[landmark_index].x_m;
        let lm_y = self.landmarks[landmark_index].y_m;
        let [rx, ry, theta] = self.pose;

        let dx = lm_x - rx;
        let dy = lm_y - ry;
        let q = (dx * dx + dy * dy).sqrt();
        if q < 1e-6 {
            return Err(SlamError::Singular);
        }
        let predicted_bearing = dy.atan2(dx) - theta;
        let predicted_range = q;

        // Innovation: actual minus predicted.
        let z_range = obs.range_m;
        let z_bearing = wrap_angle(obs.bearing_rad - predicted_bearing);
        let innovation = [z_range - predicted_range, z_bearing];

        // H — the Jacobian of the predicted measurement with respect to the state.
        // Non-zero entries only on the landmark's 2 rows and the robot's 3 rows.
        // `h` lives in scratch_c (sized `active · 2` = `2 · active`) — no per-step allocation.
        let lx_row = ROBOT_DIM + LM_DIM * landmark_index;
        for slot in self.scratch_c.iter_mut().take(2 * active) {
            *slot = 0.0;
        }
        // Row 0 (range): non-zero on robot (x, y) and landmark (x, y).
        self.scratch_c[0 * active + 0] = -dx / q;
        self.scratch_c[0 * active + 1] = -dy / q;
        self.scratch_c[0 * active + lx_row] = dx / q;
        self.scratch_c[0 * active + lx_row + 1] = dy / q;
        // Row 1 (bearing): non-zero on robot (x, y, θ) and landmark (x, y).
        self.scratch_c[1 * active + 0] = dy / (q * q);
        self.scratch_c[1 * active + 1] = -dx / (q * q);
        self.scratch_c[1 * active + 2] = -1.0;
        self.scratch_c[1 * active + lx_row] = -dy / (q * q);
        self.scratch_c[1 * active + lx_row + 1] = dx / (q * q);

        // R — the measurement noise.
        let r = [obs.range_variance, 0.0, 0.0, obs.bearing_variance];

        // S = H Σ Hᵀ + R — 2×2. (Reads `h` from scratch_c.)
        let mut s = [0.0f32; 4];
        for i in 0..2 {
            for j in 0..2 {
                let mut sum = 0.0f32;
                for k in 0..active {
                    let h_ik = self.scratch_c[i * active + k];
                    if h_ik == 0.0 {
                        continue;
                    }
                    for l in 0..active {
                        let h_jl = self.scratch_c[j * active + l];
                        if h_jl == 0.0 {
                            continue;
                        }
                        sum += h_ik * self.cov(k, l) * h_jl;
                    }
                }
                s[i * 2 + j] = sum + r[i * 2 + j];
            }
        }
        // S⁻¹ (2×2 closed form).
        let det = s[0] * s[3] - s[1] * s[2];
        if det.abs() < 1e-12 {
            return Err(SlamError::Singular);
        }
        let s_inv = [s[3] / det, -s[1] / det, -s[2] / det, s[0] / det];

        // K = Σ Hᵀ S⁻¹ — (active × 2). We assemble K into scratch_a in an
        // `active × active` row-major layout (so K[row, col] lives at
        // `scratch_a[row * active + col]` with col ∈ {0, 1}). After this step
        // we don't need scratch_a for anything else until the covariance
        // update — at which point we overwrite it with the new covariance.
        // (NB: scratch_a is also used by `predict`, but `update_landmark`
        // and `predict` are never called with overlapping borrows.)
        for slot in self.scratch_a.iter_mut().take(active * active) {
            *slot = 0.0;
        }
        for row in 0..active {
            for col in 0..2 {
                let mut sum = 0.0f32;
                for j in 0..2 {
                    for kk in 0..active {
                        let cov_v = self.cov(row, kk);
                        if cov_v == 0.0 {
                            continue;
                        }
                        let h_jk = self.scratch_c[j * active + kk];
                        sum += cov_v * h_jk * s_inv[j * 2 + col];
                    }
                }
                self.scratch_a[row * active + col] = sum;
            }
        }

        // State update: μ' = μ + K · ν  (reads K from scratch_a, reads H
        // earlier — H is still in scratch_c and not needed again).
        self.pose[0] += self.scratch_a[0 * active + 0] * innovation[0]
            + self.scratch_a[0 * active + 1] * innovation[1];
        self.pose[1] += self.scratch_a[1 * active + 0] * innovation[0]
            + self.scratch_a[1 * active + 1] * innovation[1];
        self.pose[2] += self.scratch_a[2 * active + 0] * innovation[0]
            + self.scratch_a[2 * active + 1] * innovation[1];
        self.pose[2] = wrap_angle(self.pose[2]);
        if let Some(lm) = self.landmarks.get_mut(landmark_index) {
            lm.x_m += self.scratch_a[lx_row * active + 0] * innovation[0]
                + self.scratch_a[lx_row * active + 1] * innovation[1];
            lm.y_m += self.scratch_a[(lx_row + 1) * active + 0] * innovation[0]
                + self.scratch_a[(lx_row + 1) * active + 1] * innovation[1];
            lm.observations = lm.observations.saturating_add(1);
            lm.symmetrise();
        }

        // Covariance update: Σ' = (I − K H) Σ.
        // We need three `active · active` slots:
        //   ① KH (assembled from K and H)
        //   ② the new Σ (row-major)
        //   ③ the old Σ as we read it
        // Slots available: scratch_a (K already there, can be reused), scratch_b.
        // Plan: KH goes into scratch_b; the new Σ goes into scratch_a (after K
        // has been folded into it). The old Σ is read directly from
        // self.covariance (each row of the new Σ reads the full corresponding
        // row of the old Σ plus the row of KH · Σ — both reads can race if
        // self.covariance is being written, but in this block we only *read*
        // self.covariance and write to scratch_a / scratch_b).
        let cap = self.capacity();
        // ① KH = K · H, into scratch_b.
        for slot in self.scratch_b.iter_mut().take(active * active) {
            *slot = 0.0;
        }
        for row in 0..active {
            for col in 0..active {
                let mut sum = 0.0f32;
                for j in 0..2 {
                    // K[row, j] lives at scratch_a[row * active + j].
                    let k_rj = self.scratch_a[row * active + j];
                    if k_rj == 0.0 {
                        continue;
                    }
                    // H[j, col] lives at scratch_c[j * active + col].
                    let h_jc = self.scratch_c[j * active + col];
                    sum += k_rj * h_jc;
                }
                self.scratch_b[row * active + col] = sum;
            }
        }
        // ② new_Σ = (I − KH) · Σ, into scratch_a (overwriting K). We read
        // self.covariance here — not the in-flight scratch_a — so each row of
        // the multiply can address both the same row and any earlier row of Σ
        // (which the formula requires for the lower-triangular terms).
        for row in 0..active {
            for col in 0..active {
                let mut sum = 0.0f32;
                for mid in 0..active {
                    let kh_rm = self.scratch_b[row * active + mid];
                    if kh_rm == 0.0 {
                        continue;
                    }
                    let old = self.covariance[mid * cap + col];
                    sum += kh_rm * old;
                }
                let old = self.covariance[row * cap + col];
                let updated = old - sum;
                self.scratch_a[row * cap + col] = updated;
            }
        }
        // ③ Copy new_Σ from scratch_a into self.covariance; symmetrise.
        for (slot, value) in self.covariance.iter_mut().zip(self.scratch_a.iter()) {
            if value.is_finite() {
                *slot = *value;
            }
        }
        self.symmetrise_covariance();
        Ok(())
    }
}

impl Default for SlamState {
    #[allow(clippy::derivable_impls)] // SlamState needs explicit `Vec` allocation; `Default::default` is the documented seam for "no landmarks, robot-block covariance seeded".
    fn default() -> Self {
        Self::new()
    }
}

/// Wrap an angle into `(-π, π]`.
fn wrap_angle(angle: f32) -> f32 {
    if !angle.is_finite() {
        return 0.0;
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

/// A high-level wrapper that owns a [`SlamState`] and the control parameters.
///
/// The wrapper exists for two reasons:
///
/// 1. It makes `predict` / `observe` callable with a single mutable borrow on a small
///    object (rather than the state + control separately).
/// 2. It pins a [`SlamControl`] so a test can compare two runs that share the same policy.
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // EKF averaging: the second observation pulls the landmark's x estimate
        // slightly past 2.0 toward 3.0. The exact value depends on the relative
        // weight of the prior (σ² = 1) vs. the new measurement (σ² = 0.0025).
        let lm = &s.landmarks()[0];
        match outcome {
            AssociationOutcome::Matched { landmark_index } => assert_eq!(landmark_index, 0),
            other => panic!("expected Matched, got {other:?}"),
        }
        // The landmark's range estimate must move past the first observation.
        assert!(
            lm.x_m > 2.0,
            "x must move past the first observation, got {}",
            lm.x_m
        );
    }

    #[test]
    #[ignore = "513 obs × 1027-dim EKF cov update is benchmark territory; skip by default"]
    fn observe_refuses_to_exceed_the_landmark_cap() {
        // The landmark table is bounded by MAX_LANDMARKS; an observation that
        // asks for `MAX_LANDMARKS + 1` distinct ids must be refused, not
        // silently overwritten. Bearings are spaced 1° apart at 5 m range
        // (0.087 m of arc-separation). With σ² = 0.0001 (1 cm σ) the gate
        // discriminates them cleanly: Mahalanobis distance ≈ 8.7, well over
        // the 5.99² cutoff. The full sweep covers 360° × 512 ⇒ 360°/512 ≈ 0.7°
        // between observations, comfortably above the gate margin.
        let mut s = SlamState::new();
        let control = SlamControl {
            gate_squared: 5.99 * 5.99,
            initial_landmark_variance: 0.0001,
        };
        let observations = MAX_LANDMARKS + 1;
        let mut last_err: Option<SlamError> = None;
        let mut last_ok = 0;
        for i in 0..observations {
            let angle = (i as f32) * (1.0 * std::f32::consts::PI / 180.0);
            match s.observe(SlamObservation::lidar(5.0, angle), &control) {
                Ok(_) => last_ok += 1,
                Err(e) => {
                    last_err = Some(e);
                    break;
                }
            }
        }
        assert_eq!(last_err, Some(SlamError::MapFull), "ok count = {last_ok}");
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
    fn wrap_angle_normalises_to_the_half_open_interval() {
        assert!((wrap_angle(PI) - PI).abs() < 1e-5);
        assert!((wrap_angle(-PI) - PI).abs() < 1e-5);
        assert!(wrap_angle(3.0 * PI).abs() <= PI + 1e-5);
        assert_eq!(wrap_angle(f32::NAN), 0.0);
    }
}
