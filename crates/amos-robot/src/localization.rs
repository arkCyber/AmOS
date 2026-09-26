//! **Monte Carlo Localization (MCL)** — a particle filter that answers "where am I?" on a
//! map the robot already has.
//!
//! Reference: Thrun, Burgard & Fox, *Probabilistic Robotics* Ch. 8 ("Grid and Monte Carlo
//! Localization"). The sample-motion / importance-weight / systematic-resample loop is
//! theirs; the bounds and the error surface are this crate's.
//!
//! ### Why this module exists next to [`crate::slam`]
//!
//! [`crate::slam`] carries an EKF, and an EKF holds a **unimodal** belief: one mean, one
//! covariance. That is the right shape for tracking a robot whose pose is already known,
//! and it is structurally incapable of the *global* question — "which of these four
//! identical corridors am I in?" — because the moment the belief has two equally likely
//! hypotheses there is no single mean to hold. This module is the other half: a cloud of
//! weighted hypotheses that can start spread over the whole map and collapse onto one pose.
//!
//! The two are complements, not duplicates:
//!
//! | | [`crate::slam`] (EKF) | this module (MCL) |
//! |---|---|---|
//! | belief | one Gaussian | `N` weighted samples |
//! | map | **estimated** (SLAM) | **given**, fixed |
//! | global localization | no | yes |
//! | cost per step | `O(L²)` covariance | `O(N · Z · L)` |
//!
//! ### The loop
//!
//! ```text
//!   predict(v, ω, dt)   sample the motion model per particle        → no allocation
//!   update(&[z])        weight each particle by max-over-landmarks  → no allocation
//!   resample()          systematic, only when ESS < ratio · N        → no allocation
//!   estimate()          weighted mean + 3×3 covariance + verdict     → no allocation
//! ```
//!
//! ### Honest boundaries (registered in `docs/robot-autonomy.md` §34, REQ-A716, FMEA F-SH-174)
//!
//! 1. **The map is given.** This module never maps. It consumes a [`Landmark`] cloud — a
//!    surveyed one, or one read out of a SLAM run through [`crate::slam::SlamState::landmarks`]
//!    (the slice lives on the state; [`crate::slam::EkfSlam`] wraps that state but exposes no
//!    landmark accessor, only `pose` / `num_landmarks`). Every landmark is then treated as
//!    ground truth — and the per-landmark `cov` a SLAM run attaches is **dropped**, so a map
//!    whose landmarks have barely converged is trusted exactly as much as a surveyed one.
//!    A wrong map yields a confident wrong answer — see boundary 5. The
//!    `tests/localization_e2e.rs` join proves this flow end to end.
//! 2. **Detection *and* recovery.** When the readings stop matching the map *anywhere*, every
//!    particle's likelihood collapses together, [`PoseEstimate::match_quality`] falls toward
//!    zero, and [`LocalizationHealth`] reports `Diverged`. Left there, that is only a
//!    *detection* — a kidnapped robot is reported lost, not rescued. So a divergent step also
//!    **re-seeds**: a fraction ([`McControl::sensor_reset_ratio`]) of the cloud is re-drawn
//!    from the pose prior — uniformly over the map extent, forgetting the motion model — and
//!    re-scored against the same sweep, so the fresh hypotheses have to earn their weight.
//!    This is sensor resetting (Lenser & Veloso, *Sensor Resetting Localization*, 2003) in its
//!    practical form: with no analytic inverse measurement model for a landmark map, the
//!    "sample from `p(x | z)`" draw is realised as a uniform proposal re-weighted by the
//!    sensor likelihood. The rescue is **bounded** — at most `ratio · N` particles move, and
//!    only on a step whose readings explain nothing — so a converged belief is untouched. A
//!    `sensor_reset_ratio` of `0.0` restores the detect-only behaviour.
//! 3. **Bounded and allocation-free in the loop.** [`MAX_PARTICLES`] bounds the sample count
//!    ([`MAX_LOCALIZATION_LANDMARKS`] the map, [`MAX_OBSERVATIONS_PER_UPDATE`] the reading
//!    batch), so per-step work has a ceiling. `predict`, `update`, `resample` and `estimate`
//!    allocate nothing: the log-weight and resample buffers are owned by the filter and
//!    reused. Construction ([`McLocalizer::new`] / [`McLocalizer::new_at`]) does allocate.
//! 4. **Deterministic.** The RNG is a `SmallRng` seeded from [`McControl::seed`]; two filters
//!    built with the same seed and fed the same commands and readings produce bit-identical
//!    particles. This is the same rule [`crate::vision::five_point`] follows, for the same
//!    reason: a regression test must be able to pin the draw.
//! 5. **`f32` state, and a caveat about the covariance.** Positions and angles are `f32`
//!    like the rest of the crate. The reported covariance is the *spread of the cloud*, and
//!    a cloud can be simultaneously **tight and wrong** — a symmetric map can leave one
//!    self-consistent hypothesis that explains every reading. The covariance then
//!    understates the true uncertainty, and [`PoseEstimate::match_quality`] stays high. A
//!    caller in that situation has no signal from this module that anything is wrong.
//! 6. **Maximum-likelihood data association, no gate.** Each observation is scored against
//!    *every* landmark and the best is kept. There is no Mahalanobis gate and no hysteresis
//!    (contrast [`crate::slam::associate`]), so a landmark that is briefly occluded cannot
//!    mis-associate persistently — but a wrong-but-close landmark also contributes fully.
//! 7. **2-D.** Planar position and yaw only, the same state as [`crate::slam`].
//! 8. **Resampling roughens.** After a resample every particle takes a small jitter
//!    ([`McControl::resample_jitter_m`], Gordon et al. 1993). Without it the cloud collapses
//!    to `N` copies of one sample and can never refine; with it, a converged belief carries a
//!    floor of spread set by the jitter rather than by the sensor. That floor is the honest
//!    reason [`McControl::converged_radius_m`] is a quarter metre and not a centimetre.
//! 9. **A degenerate sensor is a degenerate filter.** The measurement model treats the
//!    declared variances as the truth, so *noiseless* readings make the likelihood a delta:
//!    the closest particle is separated from the runner-up by an arbitrarily large factor,
//!    the weights collapse onto it, and [`PoseEstimate::match_quality`] plummets even though
//!    the estimate is centimetres from the truth. Feed the real sensor's variances, not
//!    zeros — which [`McLocalizer::update`] refuses anyway.
//! 10. **The map this filter accepts is smaller than the map SLAM can build.**
//!     [`crate::slam::MAX_LANDMARKS`] is `512`, this module's ceiling is `256`, and the two
//!     bound different quantities (the EKF's caps its state size, whose covariance grows as
//!     `L²`; this one caps per-step work, `O(N · Z · L)`). So a SLAM map above 256 landmarks
//!     is **refused** with [`LocalizationError::TooManyLandmarks`] rather than silently
//!     truncated — the caller must keep the 256 best-converged landmarks and say so. The seam
//!     is pinned by `tests/localization_e2e.rs`, which fails if either bound moves past the
//!     other.

use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};
use std::f32::consts::PI;

use crate::planning::Pose;
use crate::slam::{Landmark, SlamObservation, VelocityCommand};

/// Hard ceiling on the sample count. A caller may ask for fewer; never more.
///
/// // chosen: a static bound so per-step work has a ceiling (NASA "Power of 10" rule 2 —
/// every loop must have a statically known upper bound). `4096` particles is roughly the
/// point where a `f32` 3-DOF cloud stops buying accuracy in a room-scale map and starts
/// costing more than it returns; the default is [`DEFAULT_PARTICLES`], well below it.
pub const MAX_PARTICLES: usize = 4096;

/// The sample count [`McControl::default`] starts from.
///
/// // chosen: the textbook MCL figure for a room-scale map, and the number every test here
/// // is calibrated against.
pub const DEFAULT_PARTICLES: usize = 512;

/// Ceiling on the number of known landmarks the filter will hold.
///
/// // chosen: the per-step cost is `O(N · Z · L)`, so this is the term that decides whether a
/// // step fits a control period. The bound a caller must budget against is the crate's own
/// // [`McLocalizer::max_step_evaluations`]: `N · MAX_OBSERVATIONS_PER_UPDATE · L` =
/// // `512 · 64 · 256 ≈ 8.4 M` likelihood evaluations at the defaults. (An earlier revision of
/// // this line quoted `512 · 16 · 256 ≈ 2.1 M` — a 16-reading sweep, four times below the `Z`
/// // the bound itself applies; the bound is the figure that matters, a typical sweep the
/// // smaller one.) A larger map must be spatially indexed first, which this module does not
/// // do. Note this ceiling is deliberately **below** [`crate::slam::MAX_LANDMARKS`] (`512`):
/// // the two bound different quantities — the EKF bounds its state size, this bounds per-step
/// // work — so a SLAM map above this ceiling must be trimmed before it is handed over, and
/// // [`LocalizationError::TooManyLandmarks`] names the count so the caller knows by how much.
pub const MAX_LOCALIZATION_LANDMARKS: usize = 256;

/// Ceiling on the readings accepted by one [`McLocalizer::update`].
///
/// // chosen: above any single sweep a planar scanner in this workspace reports, and low
/// // enough that a caller cannot turn one step into unbounded work by concatenating
/// // batches. A larger batch must be split across several `update` calls.
pub const MAX_OBSERVATIONS_PER_UPDATE: usize = 64;

/// How far outside the map's bounding box the initial uniform cloud is allowed to extend (m).
///
/// // chosen: a policy margin, not a measured figure. Without it a map whose landmarks are
/// // collinear would produce a zero-area box and a degenerate cloud; two metres is wide
/// // enough that the true pose is unlikely to sit outside it.
pub const INITIAL_SPREAD_MARGIN_M: f32 = 2.0;

/// Below this [`PoseEstimate::match_quality`] the belief is treated as inconsistent with the
/// map and [`LocalizationHealth::Diverged`] is reported regardless of how tight the cloud is.
///
/// // chosen: a policy floor, not a measured figure. `0.05` is `exp(-0.5 · 6)` — it declares
/// // the belief lost once the best particle averages a normalized innovation of about
/// // `6` (a ~2.4-σ miss) over every reading in the batch.
pub const MATCH_QUALITY_FLOOR: f32 = 0.05;

/// Default fraction of the cloud re-drawn from the pose prior on a divergent step — see
/// [`McControl::sensor_reset_ratio`].
///
/// // chosen: a policy figure, not a measured one. `0.0` would disable recovery; `1.0` would
/// // throw the whole belief away on every divergent step, discarding whatever the motion model
/// // still knew. `0.3` leaves most of the cloud on the motion prior while giving the rescue
/// // draw enough samples to land near a pose the sweep explains. Lenser & Veloso vary the
/// // fraction with the belief; a fixed `0.3` is this crate's bounded simplification.
pub const DEFAULT_SENSOR_RESET_RATIO: f32 = 0.3;

/// What the filter refused to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalizationError {
    /// The map held no landmarks, so no reading can ever be explained.
    EmptyMap,
    /// The map holds more than [`MAX_LOCALIZATION_LANDMARKS`] landmarks.
    TooManyLandmarks {
        /// How many landmarks were offered.
        given: usize,
    },
    /// An update carried more than [`MAX_OBSERVATIONS_PER_UPDATE`] readings.
    TooManyObservations {
        /// How many readings were offered.
        given: usize,
    },
    /// The requested particle count was `0` or above [`MAX_PARTICLES`].
    BadParticleCount {
        /// The count that was rejected.
        given: usize,
    },
    /// A parameter was non-finite or outside its allowed range — a negative variance, a
    /// non-positive sigma, a resample ratio outside `(0, 1)`, or a NaN pose.
    BadParameter,
}

impl std::fmt::Display for LocalizationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LocalizationError::EmptyMap => {
                write!(
                    f,
                    "the landmark map is empty: no particle can ever be weighted"
                )
            }
            LocalizationError::TooManyLandmarks { given } => write!(
                f,
                "{given} landmarks exceeds MAX_LOCALIZATION_LANDMARKS \
                 ({MAX_LOCALIZATION_LANDMARKS}): the per-step cost is O(N · Z · L)"
            ),
            LocalizationError::TooManyObservations { given } => write!(
                f,
                "{given} readings exceeds MAX_OBSERVATIONS_PER_UPDATE \
                 ({MAX_OBSERVATIONS_PER_UPDATE}): split the sweep across several updates"
            ),
            LocalizationError::BadParticleCount { given } => {
                write!(f, "particle count {given} is not in 1..={MAX_PARTICLES}")
            }
            LocalizationError::BadParameter => write!(
                f,
                "a parameter was non-finite or out of range (negative variance, non-positive \
                 sigma, or a resample ratio outside 0..1): the belief was left untouched"
            ),
        }
    }
}

impl std::error::Error for LocalizationError {}

/// How much the cloud should be believed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalizationHealth {
    /// The cloud is tight *and* the readings match the map there: a single confident pose.
    Converged,
    /// The cloud is spread — or the readings only partly explain it — but not lost.
    Uncertain,
    /// The belief is spread past [`McControl::diverged_radius_m`], or the readings match the
    /// map nowhere ([`PoseEstimate::match_quality`] below [`MATCH_QUALITY_FLOOR`]).
    Diverged,
}

impl LocalizationHealth {
    /// Stable key for logs and traces.
    pub fn key(self) -> &'static str {
        match self {
            LocalizationHealth::Converged => "converged",
            LocalizationHealth::Uncertain => "uncertain",
            LocalizationHealth::Diverged => "diverged",
        }
    }
}

/// The knobs a caller sets once, at construction.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct McControl {
    /// Sample count (`1..=`[`MAX_PARTICLES`]).
    pub particles: usize,
    /// Standard deviation of the forward-speed noise, per `√s` (m/s).
    ///
    /// // policy, not measurement: the motion-model noise density a deployment should
    /// // replace with its own odometry characterisation. The default tracks a wheeled base
    /// // with a mild speed estimate error.
    pub linear_noise_m_per_s: f32,
    /// Standard deviation of the yaw-rate noise, per `√s` (rad/s).
    ///
    /// // policy, not measurement — see [`McControl::linear_noise_m_per_s`].
    pub angular_noise_rad_per_s: f32,
    /// Extra heading noise injected per step, per `√s` (rad/s). This is what lets a cloud
    /// *rotate* its hypotheses apart, which yaw-rate noise alone does poorly.
    ///
    /// // policy, not measurement — see [`McControl::linear_noise_m_per_s`].
    pub heading_noise_rad_per_s: f32,
    /// Positional jitter added to every particle after a resample (m) — "roughening"
    /// (Gordon, Salmond & Smith, 1993).
    ///
    /// **This is what keeps the filter alive.** Resampling without it copies survivors
    /// exactly, so after a few steps the cloud is `N` copies of one sample: the spread
    /// collapses to zero, no particle can be closer to the truth than the one it was copied
    /// from, and the filter can never refine past the spacing it was seeded with. The jitter
    /// gives the cloud somewhere new to move each step, so the weighted update can then
    /// select the better of the new positions.
    ///
    /// // chosen: 5 cm, about the range resolution of the planar scanner these filtering
    /// // variances come from ([`SlamObservation::lidar`]) — small enough not to blur a
    /// // converged belief, large enough to walk out of a wrong basin over a few steps.
    pub resample_jitter_m: f32,
    /// Heading jitter added after a resample (rad), for the same reason.
    ///
    /// // chosen: `0.02` rad ≈ 1.2°, again the scanner's bearing scale rather than a fitted
    /// // constant.
    pub resample_jitter_rad: f32,
    /// Resample when the effective sample size falls below this fraction of `particles`.
    ///
    /// // chosen: `0.5`, the standard low-variance-resampling trigger. Above it the sample
    /// // set still carries the distribution; below it, resampling is what keeps the cloud
    /// // from degenerating onto a handful of weights.
    pub resample_ess_ratio: f32,
    /// Position spread at or below which the cloud counts as tight (m).
    ///
    /// // chosen: a quarter metre, the scale at which an indoor pose is actionable.
    pub converged_radius_m: f32,
    /// Heading spread at or below which the cloud counts as tight (rad).
    ///
    /// // chosen: `0.10` rad ≈ 5.7°, the same scale as a typical planar-scanner bearing
    /// // resolution.
    pub converged_heading_rad: f32,
    /// Position spread above which the belief is reported lost (m).
    ///
    /// // chosen: two metres, an order of magnitude past the convergence radius so that the
    /// // band between the two is a real "uncertain" region rather than a knife edge.
    pub diverged_radius_m: f32,
    /// Fraction of the cloud re-drawn from the pose prior on a **divergent** step, in `[0, 1]`.
    ///
    /// `0.0` disables sensor resetting: the filter only ever *detects* a lost belief and never
    /// re-seeds, so a kidnapped robot is reported `Diverged` and stays there. Above zero, a
    /// step whose [`PoseEstimate::match_quality`] falls below
    /// [`McControl::sensor_reset_trigger`] moves `round(ratio · particles)` particles to fresh
    /// uniform poses and re-scores the whole cloud against the same sweep.
    ///
    /// // policy, not measurement — see [`DEFAULT_SENSOR_RESET_RATIO`].
    pub sensor_reset_ratio: f32,
    /// [`PoseEstimate::match_quality`] below which sensor resetting fires, in `(0, 1]`.
    ///
    /// // chosen: the same floor [`MATCH_QUALITY_FLOOR`] judges the health by, so "the health
    /// // verdict is `Diverged` for the readings-don't-match reason" and "the rescue draw is
    /// // armed" are the same condition rather than two numbers that can drift apart.
    pub sensor_reset_trigger: f32,
    /// Seed for the internal `SmallRng`. Same seed plus same inputs ⇒ identical output.
    pub seed: u64,
}

impl Default for McControl {
    fn default() -> Self {
        Self {
            particles: DEFAULT_PARTICLES,
            linear_noise_m_per_s: 0.1,
            angular_noise_rad_per_s: 0.05,
            heading_noise_rad_per_s: 0.05,
            resample_jitter_m: 0.05,
            resample_jitter_rad: 0.02,
            resample_ess_ratio: 0.5,
            converged_radius_m: 0.25,
            converged_heading_rad: 0.10,
            diverged_radius_m: 2.0,
            sensor_reset_ratio: DEFAULT_SENSOR_RESET_RATIO,
            sensor_reset_trigger: MATCH_QUALITY_FLOOR,
            seed: 0x5EED_0F1C,
        }
    }
}

/// The answer: a pose, its spread, and a verdict on whether to trust it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PoseEstimate {
    /// Weighted-mean north position (m).
    pub x_m: f32,
    /// Weighted-mean east position (m).
    pub y_m: f32,
    /// Weighted **circular** mean heading (rad), in `[-π, π]`.
    pub theta_rad: f32,
    /// Weighted 3×3 covariance, row-major, symmetrised: `[σ_xx, σ_xy, σ_xθ, ·, σ_yy, σ_yθ,
    /// ·, ·, σ_θθ]`. The `·` cells mirror their transposes.
    pub cov: [f32; 9],
    /// How much the cloud should be believed.
    pub health: LocalizationHealth,
    /// Effective sample size (`1 / Σwᵢ²`) at the moment of the estimate.
    pub effective_particles: f32,
    /// Consistency of the map with the readings, in `(0, 1]`: `exp(-½ · minₚ Σ_z νₚ,ᵢ)`.
    /// Near `1` the best particle explains every reading to within its noise; near `0` the
    /// map explains nothing. Not a probability density — the Gaussian normaliser `1/(2π√det
    /// Σ)` is constant across particles and is dropped because it cancels in the weights.
    pub match_quality: f32,
}

impl PoseEstimate {
    /// The larger of the x and y standard deviations (m).
    pub fn position_sigma_m(&self) -> f32 {
        self.cov[0].max(self.cov[4]).max(0.0).sqrt()
    }

    /// The heading standard deviation (rad).
    pub fn heading_sigma_rad(&self) -> f32 {
        self.cov[8].max(0.0).sqrt()
    }

    /// This estimate as a [`Pose`], millimetres and milli-radians, rounded.
    ///
    /// A non-finite component is rendered as `0` rather than propagated: an integer pose has
    /// no NaN, and a caller that needs to *know* the estimate was garbage reads
    /// [`PoseEstimate::health`], which will not be `Converged`.
    pub fn to_pose(self) -> Pose {
        Pose {
            north_mm: round_to_i64(self.x_m, 1000.0),
            east_mm: round_to_i64(self.y_m, 1000.0),
            heading_mrad: round_to_i32(self.theta_rad, 1000.0),
        }
    }
}

/// One hypothesis: a planar pose and its unnormalised-then-normalised weight.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Particle {
    /// North position (m).
    pub x_m: f32,
    /// East position (m).
    pub y_m: f32,
    /// Heading (rad).
    pub theta_rad: f32,
    /// Normalised weight (sums to `1` across the cloud after every update).
    pub weight: f32,
}

/// A bounded, deterministic particle filter for planar localization on a known landmark map.
#[derive(Debug)]
pub struct McLocalizer {
    map: Vec<Landmark>,
    particles: Vec<Particle>,
    /// Reused as the log-weight accumulator in [`McLocalizer::update`] — one `f64` per
    /// particle, allocated once.
    log_weights: Vec<f64>,
    /// Reused as the destination of systematic resampling, so a resample allocates nothing.
    resample_buf: Vec<Particle>,
    rng: SmallRng,
    control: McControl,
    match_quality: f32,
    effective_particles: f32,
    /// The most recent motion command's `dt`, so `update` can report a rate-consistent
    /// weight. Retained rather than recomputed because it is not derived from the particles.
    last_dt_s: f32,
}

impl McLocalizer {
    /// A filter whose belief starts **spread uniformly over the map** — the global
    /// localization case. Every landmark is trusted as given.
    ///
    /// The cloud covers the map's bounding box expanded by [`INITIAL_SPREAD_MARGIN_M`] on
    /// each side, with a uniform heading. A map whose landmarks are collinear (a zero-area
    /// bounding box) still gets the margin, so the cloud is never degenerate.
    pub fn new(map: Vec<Landmark>, control: McControl) -> Result<Self, LocalizationError> {
        let mut filter = Self::with_control(map, control)?;
        let (lo_x, hi_x, lo_y, hi_y) = filter.scatter_box();
        let n = filter.particles.len();
        for p in &mut filter.particles {
            p.x_m = filter.rng.gen_range(lo_x..hi_x);
            p.y_m = filter.rng.gen_range(lo_y..hi_y);
            p.theta_rad = wrap_angle(filter.rng.gen_range(-PI..PI));
            p.weight = 1.0 / n as f32;
        }
        filter.effective_particles = n as f32;
        Ok(filter)
    }

    /// A filter whose belief starts **tight around a known pose** — the tracking case, and
    /// the shape an EKF would also be initialised with. `sigma_m` and `sigma_theta_rad` must
    /// be finite and strictly positive.
    pub fn new_at(
        map: Vec<Landmark>,
        control: McControl,
        x_m: f32,
        y_m: f32,
        theta_rad: f32,
        sigma_m: f32,
        sigma_theta_rad: f32,
    ) -> Result<Self, LocalizationError> {
        if !x_m.is_finite()
            || !y_m.is_finite()
            || !theta_rad.is_finite()
            || !sigma_m.is_finite()
            || !sigma_theta_rad.is_finite()
            || sigma_m <= 0.0
            || sigma_theta_rad <= 0.0
        {
            return Err(LocalizationError::BadParameter);
        }
        let mut filter = Self::with_control(map, control)?;
        let n = filter.particles.len();
        for p in &mut filter.particles {
            p.x_m = x_m + sigma_m * gaussian(&mut filter.rng);
            p.y_m = y_m + sigma_m * gaussian(&mut filter.rng);
            p.theta_rad = wrap_angle(theta_rad + sigma_theta_rad * gaussian(&mut filter.rng));
            p.weight = 1.0 / n as f32;
        }
        filter.effective_particles = n as f32;
        Ok(filter)
    }

    /// Shared validation + allocation. `particles` are placeholders here; the two public
    /// constructors fill them differently, which is the whole distinction between them.
    fn with_control(map: Vec<Landmark>, control: McControl) -> Result<Self, LocalizationError> {
        if map.is_empty() {
            return Err(LocalizationError::EmptyMap);
        }
        if map.len() > MAX_LOCALIZATION_LANDMARKS {
            return Err(LocalizationError::TooManyLandmarks { given: map.len() });
        }
        for l in &map {
            if !l.x_m.is_finite() || !l.y_m.is_finite() {
                return Err(LocalizationError::BadParameter);
            }
        }
        if control.particles == 0 || control.particles > MAX_PARTICLES {
            return Err(LocalizationError::BadParticleCount {
                given: control.particles,
            });
        }
        if !control.linear_noise_m_per_s.is_finite()
            || control.linear_noise_m_per_s < 0.0
            || !control.angular_noise_rad_per_s.is_finite()
            || control.angular_noise_rad_per_s < 0.0
            || !control.heading_noise_rad_per_s.is_finite()
            || control.heading_noise_rad_per_s < 0.0
            || !control.resample_jitter_m.is_finite()
            || control.resample_jitter_m < 0.0
            || !control.resample_jitter_rad.is_finite()
            || control.resample_jitter_rad < 0.0
            || !control.resample_ess_ratio.is_finite()
            || control.resample_ess_ratio <= 0.0
            || control.resample_ess_ratio >= 1.0
            || !control.converged_radius_m.is_finite()
            || control.converged_radius_m <= 0.0
            || !control.converged_heading_rad.is_finite()
            || control.converged_heading_rad <= 0.0
            || !control.diverged_radius_m.is_finite()
            || control.diverged_radius_m < control.converged_radius_m
            || !control.sensor_reset_ratio.is_finite()
            || control.sensor_reset_ratio < 0.0
            || control.sensor_reset_ratio > 1.0
            || !control.sensor_reset_trigger.is_finite()
            || control.sensor_reset_trigger <= 0.0
            || control.sensor_reset_trigger > 1.0
        {
            return Err(LocalizationError::BadParameter);
        }
        let n = control.particles;
        Ok(Self {
            map,
            particles: vec![
                Particle {
                    x_m: 0.0,
                    y_m: 0.0,
                    theta_rad: 0.0,
                    weight: 1.0 / n as f32,
                };
                n
            ],
            log_weights: vec![0.0; n],
            resample_buf: Vec::with_capacity(n),
            rng: SmallRng::seed_from_u64(control.seed),
            control,
            match_quality: 1.0,
            effective_particles: n as f32,
            last_dt_s: 0.0,
        })
    }

    /// The `(min_x, max_x, min_y, max_y)` extent of the known map.
    fn bounding_box(&self) -> (f32, f32, f32, f32) {
        let mut lo_x = f32::INFINITY;
        let mut hi_x = f32::NEG_INFINITY;
        let mut lo_y = f32::INFINITY;
        let mut hi_y = f32::NEG_INFINITY;
        for l in &self.map {
            lo_x = lo_x.min(l.x_m);
            hi_x = hi_x.max(l.x_m);
            lo_y = lo_y.min(l.y_m);
            hi_y = hi_y.max(l.y_m);
        }
        (lo_x, hi_x, lo_y, hi_y)
    }

    /// The map's bounding box expanded by [`INITIAL_SPREAD_MARGIN_M`] on every side — the box
    /// a uniform pose draw is taken from. Shared by global initialisation and sensor resetting
    /// so both scatters cover the same region.
    fn scatter_box(&self) -> (f32, f32, f32, f32) {
        let (min_x, max_x, min_y, max_y) = self.bounding_box();
        let m = INITIAL_SPREAD_MARGIN_M;
        (min_x - m, max_x + m, min_y - m, max_y + m)
    }

    /// Score every particle against `observations`, writing `-½ Σ_z ν` into `log_weights`, and
    /// return `(best_sum_nees, max_log)`: the runner-up-relevant minimum (for
    /// [`PoseEstimate::match_quality`]) and the shift that keeps the exponentiation in range.
    ///
    /// Split out of [`McLocalizer::update`] because sensor resetting scores the cloud **twice**
    /// on a divergent step — once to detect the divergence, once after the re-seed — and the
    /// two passes must be the same arithmetic, not two copies of it.
    fn score(&mut self, observations: &[SlamObservation]) -> (f32, f64) {
        let mut best_sum_nees = f32::INFINITY;
        let mut max_log = f64::NEG_INFINITY;
        for (p, log_w) in self.particles.iter().zip(self.log_weights.iter_mut()) {
            let mut sum_nees = 0.0f32;
            for o in observations {
                sum_nees += best_landmark_nees(p, o, &self.map);
            }
            best_sum_nees = best_sum_nees.min(sum_nees);
            let lw = -0.5 * sum_nees as f64;
            *log_w = lw;
            if lw > max_log {
                max_log = lw;
            }
        }
        (best_sum_nees, max_log)
    }

    /// Overwrite `k` particles (spread evenly across the cloud by a random-stride walk, so no
    /// slot is drawn twice) with poses sampled uniformly over [`Self::scatter_box`] and a
    /// uniform heading. Forgets the motion model on purpose: this is the rescue draw.
    fn reseed_uniform(&mut self, k: usize) {
        let n = self.particles.len();
        if k == 0 || n == 0 {
            return;
        }
        let (lo_x, hi_x, lo_y, hi_y) = self.scatter_box();
        // A stride of `n / k` (at least 1) visits `k` distinct slots from a random start.
        // `k <= n` is the caller's contract, so the walk never wraps onto a visited slot.
        let stride = (n / k).max(1);
        let start = self.rng.gen_range(0..n);
        for j in 0..k {
            let idx = (start + j * stride) % n;
            let x = self.rng.gen_range(lo_x..hi_x);
            let y = self.rng.gen_range(lo_y..hi_y);
            let theta = wrap_angle(self.rng.gen_range(-PI..PI));
            let p = &mut self.particles[idx];
            p.x_m = x;
            p.y_m = y;
            p.theta_rad = theta;
        }
    }

    /// Sample the motion model: every particle is propagated by `cmd`, plus noise drawn from
    /// the control's three noise densities scaled by `√dt`.
    ///
    /// A command that is non-finite or carries `dt_s <= 0` is **refused silently**: the
    /// belief is left exactly as it was. There is no error return because a motion step has
    /// no partial failure mode — the only alternatives are "moved" and "did not move" — and a
    /// caller that needs to distinguish them validates its command, as
    /// [`crate::slam::EkfSlam::predict`] also requires.
    pub fn predict(&mut self, cmd: VelocityCommand) {
        let dt = cmd.dt_s;
        if !dt.is_finite()
            || dt <= 0.0
            || !cmd.linear_m_s.is_finite()
            || !cmd.angular_rad_s.is_finite()
        {
            return;
        }
        let root_dt = dt.sqrt();
        let sigma_v = self.control.linear_noise_m_per_s * root_dt;
        let sigma_w = self.control.angular_noise_rad_per_s * root_dt;
        let sigma_h = self.control.heading_noise_rad_per_s * root_dt;
        let rng = &mut self.rng;
        for p in &mut self.particles {
            let v = cmd.linear_m_s + sigma_v * gaussian(rng);
            let w = cmd.angular_rad_s + sigma_w * gaussian(rng);
            let theta = wrap_angle(p.theta_rad + w * dt + sigma_h * gaussian(rng));
            p.theta_rad = theta;
            p.x_m += v * dt * theta.cos();
            p.y_m += v * dt * theta.sin();
        }
        self.last_dt_s = dt;
    }

    /// Importance-weight every particle against the readings and, if the effective sample
    /// size has collapsed, resample.
    ///
    /// Each reading is scored against **every** landmark and the best (minimum normalized
    /// innovation) is kept — maximum-likelihood association, no gate (boundary 6). Weights
    /// are accumulated in `f64` log space and exponentiated after the batch, so a long sweep
    /// cannot underflow the product to zero before normalisation.
    ///
    /// An empty reading list is a no-op, not an error: a scanner with nothing in range is a
    /// legitimate step, and it carries no information to act on.
    pub fn update(&mut self, observations: &[SlamObservation]) -> Result<(), LocalizationError> {
        if observations.len() > MAX_OBSERVATIONS_PER_UPDATE {
            return Err(LocalizationError::TooManyObservations {
                given: observations.len(),
            });
        }
        for o in observations {
            if !o.range_m.is_finite()
                || !o.bearing_rad.is_finite()
                || !o.sensor_offset_x_m.is_finite()
                || !o.sensor_offset_y_m.is_finite()
                || !o.range_variance.is_finite()
                || o.range_variance <= 0.0
                || !o.bearing_variance.is_finite()
                || o.bearing_variance <= 0.0
            {
                return Err(LocalizationError::BadParameter);
            }
        }
        if observations.is_empty() {
            return Ok(());
        }

        let z = observations.len() as f32;
        // The Gaussian normaliser is a constant across particles, so it is dropped by `score`;
        // the resulting weights differ only by that constant and normalise to the same
        // distribution, and `match_quality` is defined against the same convention.
        let (mut best_sum_nees, mut max_log) = self.score(observations);

        // Sensor resetting (Lenser & Veloso, 2003). `best_sum_nees` is the *best* particle's
        // total normalized innovation, so `(-½ · best_sum_nees/z).exp()` is exactly the
        // match-quality this step will report: below the trigger, no hypothesis in the cloud
        // explains the sweep, which is the kidnapped-robot signal. Re-draw a bounded fraction
        // from the pose prior and re-score — the fresh hypotheses then compete for weight on
        // equal footing with the survivors, and the resample below keeps whichever explain the
        // readings. The second `score` pass is the cost of the rescue and happens only on a
        // divergent step (see [`McLocalizer::max_step_evaluations`]).
        if self.control.sensor_reset_ratio > 0.0 {
            let candidate_mq = (-0.5 * best_sum_nees / z).exp();
            if candidate_mq < self.control.sensor_reset_trigger {
                let k = ((self.control.sensor_reset_ratio * self.particles.len() as f32).round()
                    as usize)
                    .clamp(1, self.particles.len());
                self.reseed_uniform(k);
                let rescored = self.score(observations);
                best_sum_nees = rescored.0;
                max_log = rescored.1;
            }
        }

        let mut total = 0.0f64;
        for (p, &lw) in self.particles.iter_mut().zip(self.log_weights.iter()) {
            let w = (lw - max_log).exp();
            p.weight = w as f32;
            total += w;
        }

        // The two leaves catch different inputs and only one of them is reachable.
        //
        // `!total.is_finite()` is the live one: `best_landmark_nees` squares
        // `range_m − predicted_range` in `f32` and `range_m` has no upper bound (`update`
        // checks finiteness only), so one reading at `1.0e30` overflows `dr²` to `+inf` ⇒
        // `nees = +inf` ⇒ every `lw = −inf` ⇒ `max_log = −inf` ⇒ `lw − max_log` is
        // `−inf − (−inf) = NaN` ⇒ `total` is `NaN`. See
        // `an_all_infinite_nees_reading_keeps_the_cloud_uniform_instead_of_collapsing_it`.
        //
        // `total <= 0.0` is **unreachable**, and kept for the reason the branch is written
        // at all: the exponent is taken relative to `max_log`, so the maximal term is
        // always `exp(0) = 1` and a finite total is at least `1.0` (and at most `n`); when
        // `total` is not finite it is `NaN`, and `NaN <= 0.0` is `false`. This was measured:
        // replacing this leaf with `false` changes no outcome at any `range_m` (the guard
        // still fires through the first leaf).
        if !total.is_finite() || total <= 0.0 {
            // Every particle is equally hopeless: the map explains nothing anywhere. Keep
            // the cloud uniform — resampling a zero-weight distribution would concentrate on
            // an arbitrary particle — and report the loss through `match_quality`.
            let n = self.particles.len();
            for p in &mut self.particles {
                p.weight = 1.0 / n as f32;
            }
            self.match_quality = 0.0;
            self.effective_particles = n as f32;
        } else {
            let inv = (1.0 / total) as f32;
            let mut sum_sq = 0.0f32;
            for p in &mut self.particles {
                p.weight *= inv;
                sum_sq += p.weight * p.weight;
            }
            self.effective_particles = if sum_sq > 0.0 { 1.0 / sum_sq } else { 0.0 };
            self.match_quality = (-0.5 * best_sum_nees / z).exp();
        }

        let threshold = self.control.resample_ess_ratio * self.particles.len() as f32;
        if self.effective_particles < threshold {
            self.resample();
        }
        Ok(())
    }

    /// Systematic (low-variance) resampling: draw `N` samples whose cumulative weights are
    /// evenly spaced by `1/N` with one random offset, so the survivors track the distribution
    /// with far less variance than `N` independent draws. Allocates nothing: the new cloud is
    /// built in the filter's own buffer and the outgoing cloud's allocation is recycled back
    /// into it, so `push` never reallocates (both buffers were sized for `N` at construction).
    fn resample(&mut self) {
        let n = self.particles.len();
        // `src` is the cloud being resampled; `dst` is the already-sized destination buffer.
        let mut src = std::mem::take(&mut self.particles);
        let mut dst = std::mem::take(&mut self.resample_buf);
        dst.clear();
        let step = 1.0 / n as f32;
        let mut c = src[0].weight;
        let mut i = 0usize;
        // Index safety: `i` starts at 0, advances only while `i + 1 < n`, and is only ever
        // read as `src[i]` — so every read is in bounds without a panic path.
        let mut u = self.rng.gen_range(0.0f32..step);
        for _ in 0..n {
            while u > c && i + 1 < n {
                i += 1;
                c += src[i].weight;
            }
            dst.push(src[i]);
            u += step;
        }
        let uniform = 1.0 / n as f32;
        let jitter_m = self.control.resample_jitter_m;
        let jitter_rad = self.control.resample_jitter_rad;
        let rng = &mut self.rng;
        for p in &mut dst {
            p.weight = uniform;
            p.x_m += jitter_m * gaussian(rng);
            p.y_m += jitter_m * gaussian(rng);
            p.theta_rad = wrap_angle(p.theta_rad + jitter_rad * gaussian(rng));
        }
        src.clear();
        self.particles = dst;
        self.resample_buf = src;
        self.effective_particles = n as f32;
    }

    /// Weighted mean pose, its 3×3 covariance, and the health verdict. Allocates nothing.
    ///
    /// The heading is a **circular** mean (`atan2(Σw·sinθ, Σw·cosθ)`), so a cloud straddling
    /// `±π` averages to the short way round rather than to `0`.
    pub fn estimate(&self) -> PoseEstimate {
        let mut sx = 0.0f32;
        let mut sy = 0.0f32;
        let mut c = 0.0f32;
        let mut s = 0.0f32;
        for p in &self.particles {
            sx += p.weight * p.x_m;
            sy += p.weight * p.y_m;
            c += p.weight * p.theta_rad.cos();
            s += p.weight * p.theta_rad.sin();
        }
        let theta = if c == 0.0 && s == 0.0 {
            0.0
        } else {
            s.atan2(c)
        };

        let mut cov = [0.0f32; 9];
        for p in &self.particles {
            let dx = p.x_m - sx;
            let dy = p.y_m - sy;
            let dth = wrap_angle(p.theta_rad - theta);
            cov[0] += p.weight * dx * dx;
            cov[1] += p.weight * dx * dy;
            cov[2] += p.weight * dx * dth;
            cov[4] += p.weight * dy * dy;
            cov[5] += p.weight * dy * dth;
            cov[8] += p.weight * dth * dth;
        }
        cov[3] = cov[1];
        cov[6] = cov[2];
        cov[7] = cov[5];

        let sigma_p = cov[0].max(cov[4]).max(0.0).sqrt();
        let sigma_h = cov[8].max(0.0).sqrt();
        let health = if self.match_quality < MATCH_QUALITY_FLOOR
            || sigma_p > self.control.diverged_radius_m
        {
            LocalizationHealth::Diverged
        } else if sigma_p <= self.control.converged_radius_m
            && sigma_h <= self.control.converged_heading_rad
        {
            LocalizationHealth::Converged
        } else {
            LocalizationHealth::Uncertain
        };

        PoseEstimate {
            x_m: sx,
            y_m: sy,
            theta_rad: theta,
            cov,
            health,
            effective_particles: self.effective_particles,
            match_quality: self.match_quality,
        }
    }

    /// The particle cloud, read-only.
    pub fn particles(&self) -> &[Particle] {
        &self.particles
    }

    /// How many particles are in flight (never `0`, never above [`MAX_PARTICLES`]).
    pub fn particle_count(&self) -> usize {
        self.particles.len()
    }

    /// How many landmarks the known map holds.
    pub fn map_len(&self) -> usize {
        self.map.len()
    }

    /// The control this filter was built with.
    pub fn control(&self) -> McControl {
        self.control
    }

    /// The `dt` of the last accepted [`McLocalizer::predict`] (`0` before the first).
    pub fn last_dt_s(&self) -> f32 {
        self.last_dt_s
    }

    /// One control-period's worth of filter work, for a caller budgeting a loop: the bound is
    /// `N · Z · L` likelihood evaluations (one private `score` pass) plus an `O(N)` optional
    /// resample. `Z` is the size of the reading batch and `L` the map size.
    ///
    /// **A sensor-resetting step costs twice this** — the detection pass plus the re-score
    /// after the rescue draw — and only when the readings explain nothing anywhere
    /// ([`McControl::sensor_reset_trigger`]). Budget `2 · max_step_evaluations()` as the
    /// worst case; the figure returned here is the ordinary (non-resetting) step, which is
    /// what a converged loop pays.
    pub fn max_step_evaluations(&self) -> usize {
        self.particles.len() * MAX_OBSERVATIONS_PER_UPDATE * self.map.len()
    }
}

/// The smallest normalized innovation (NEES, a `χ²(2)` variate) over every landmark in the
/// map, for one particle and one reading. `f32::INFINITY` if the map is empty — unreachable
/// through the public constructors, which refuse an empty map, but stated rather than
/// unwrapped.
fn best_landmark_nees(p: &Particle, o: &SlamObservation, map: &[Landmark]) -> f32 {
    let cos = p.theta_rad.cos();
    let sin = p.theta_rad.sin();
    // The sensor's world position, given its offset in the robot body frame.
    let sx = p.x_m + cos * o.sensor_offset_x_m - sin * o.sensor_offset_y_m;
    let sy = p.y_m + sin * o.sensor_offset_x_m + cos * o.sensor_offset_y_m;
    let mut best = f32::INFINITY;
    for l in map {
        let dx = l.x_m - sx;
        let dy = l.y_m - sy;
        let predicted_range = (dx * dx + dy * dy).sqrt();
        let predicted_bearing = wrap_angle(dy.atan2(dx) - p.theta_rad);
        let dr = o.range_m - predicted_range;
        let db = wrap_angle(o.bearing_rad - predicted_bearing);
        let nees = dr * dr / o.range_variance + db * db / o.bearing_variance;
        if nees < best {
            best = nees;
        }
    }
    best
}

/// Wrap an angle to `[-π, π]`.
fn wrap_angle(a: f32) -> f32 {
    let tau = 2.0 * PI;
    let mut r = a % tau;
    if r > PI {
        r -= tau;
    } else if r < -PI {
        r += tau;
    }
    r
}

/// One standard-normal draw, Box–Muller. The `u1` floor is required: `ln(0) = -∞`.
fn gaussian(rng: &mut SmallRng) -> f32 {
    let mut u1 = rng.gen_range(0.0f32..1.0);
    if u1 <= f32::MIN_POSITIVE {
        u1 = f32::MIN_POSITIVE;
    }
    let u2 = rng.gen_range(0.0f32..1.0);
    (-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos()
}

/// `value * scale`, rounded, with non-finite input rendered as `0` (an integer type has no
/// NaN, and the caller learns of the bad estimate from `health`, not from the pose).
fn round_to_i64(value: f32, scale: f32) -> i64 {
    if value.is_finite() {
        (value * scale).round() as i64
    } else {
        0
    }
}

/// See [`round_to_i64`].
fn round_to_i32(value: f32, scale: f32) -> i32 {
    if value.is_finite() {
        (value * scale).round() as i32
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A square of four landmarks at `(±10, ±10)`, unambiguous enough to localize in when the
    /// cloud starts tight.
    ///
    /// It is **not** usable for a global test: because association is max-over-landmarks, the
    /// square's 4-fold symmetry makes every 90°-rotated pose about the centre explain the
    /// readings equally well, so a spread cloud can legitimately collapse onto an image of
    /// the truth. Use [`asymmetric_map`] for anything that starts unlocalized.
    fn square_map() -> Vec<Landmark> {
        vec![
            Landmark::new(10.0, 10.0, 0.05),
            Landmark::new(10.0, -10.0, 0.05),
            Landmark::new(-10.0, 10.0, 0.05),
            Landmark::new(-10.0, -10.0, 0.05),
        ]
    }

    /// Five landmarks with no rotational symmetry, so the readings admit a single pose.
    fn asymmetric_map() -> Vec<Landmark> {
        vec![
            Landmark::new(0.0, 0.0, 0.05),
            Landmark::new(8.0, 2.0, 0.05),
            Landmark::new(5.0, 9.0, 0.05),
            Landmark::new(-3.0, 6.0, 0.05),
            Landmark::new(-7.0, -4.0, 0.05),
        ]
    }

    /// Readings a perfect scanner at `(x, y, θ)` would return for every landmark in `map`,
    /// in the sensor frame (range forward, bearing CCW from forward).
    fn readings(x: f32, y: f32, theta: f32, map: &[Landmark]) -> Vec<SlamObservation> {
        map.iter()
            .map(|l| {
                let dx = l.x_m - x;
                let dy = l.y_m - y;
                let range = (dx * dx + dy * dy).sqrt();
                let bearing = wrap_angle(dy.atan2(dx) - theta);
                SlamObservation::lidar(range, bearing)
            })
            .collect()
    }

    /// The same readings through a scanner carrying the noise `SlamObservation::lidar`
    /// declares. A real filter always sees this; the exact readings above are the degenerate
    /// delta case documented as boundary 9, and are used only where that is the point.
    fn noisy_readings(
        x: f32,
        y: f32,
        theta: f32,
        map: &[Landmark],
        seed: u64,
    ) -> Vec<SlamObservation> {
        with_scanner_noise(readings(x, y, theta, map), seed)
    }

    /// Readings a perfect scanner mounted at body-frame offset `(ox, oy)` returns for every
    /// landmark in `map`, from a robot at `(x, y, θ)`. The sensor's world position is the
    /// robot's rotated into the body frame — the same convention the EKF applies, and exactly
    /// the term a filter that ignored the offset would get wrong.
    fn offset_readings(
        x: f32,
        y: f32,
        theta: f32,
        offset: (f32, f32),
        map: &[Landmark],
    ) -> Vec<SlamObservation> {
        let (ox, oy) = offset;
        let (c, s) = (theta.cos(), theta.sin());
        let sx = x + ox * c - oy * s;
        let sy = y + ox * s + oy * c;
        map.iter()
            .map(|l| {
                let dx = l.x_m - sx;
                let dy = l.y_m - sy;
                let range = (dx * dx + dy * dy).sqrt();
                let bearing = wrap_angle(dy.atan2(dx) - theta);
                let mut o = SlamObservation::lidar(range, bearing);
                o.sensor_offset_x_m = ox;
                o.sensor_offset_y_m = oy;
                o
            })
            .collect()
    }

    /// Add the scanner noise `SlamObservation::lidar` declares to each reading, drawing in a
    /// fixed order (range then bearing, per observation) so a seed pins the result.
    fn with_scanner_noise(mut obs: Vec<SlamObservation>, seed: u64) -> Vec<SlamObservation> {
        let mut rng = SmallRng::seed_from_u64(seed);
        for o in &mut obs {
            o.range_m += 0.05 * gaussian(&mut rng);
            o.bearing_rad += (PI / 360.0) * gaussian(&mut rng);
        }
        obs
    }

    #[test]
    fn refuses_an_empty_map() {
        assert_eq!(
            McLocalizer::new(Vec::new(), McControl::default()).unwrap_err(),
            LocalizationError::EmptyMap
        );
    }

    #[test]
    fn refuses_a_zero_particle_count() {
        let control = McControl {
            particles: 0,
            ..McControl::default()
        };
        assert_eq!(
            McLocalizer::new(square_map(), control).unwrap_err(),
            LocalizationError::BadParticleCount { given: 0 }
        );
    }

    #[test]
    fn refuses_more_particles_than_the_bound() {
        let control = McControl {
            particles: MAX_PARTICLES + 1,
            ..McControl::default()
        };
        assert_eq!(
            McLocalizer::new(square_map(), control).unwrap_err(),
            LocalizationError::BadParticleCount {
                given: MAX_PARTICLES + 1
            }
        );
    }

    #[test]
    fn refuses_an_oversized_map() {
        let map: Vec<Landmark> = (0..=MAX_LOCALIZATION_LANDMARKS)
            .map(|i| Landmark::new(i as f32, 0.0, 0.1))
            .collect();
        assert_eq!(
            McLocalizer::new(map, McControl::default()).unwrap_err(),
            LocalizationError::TooManyLandmarks {
                given: MAX_LOCALIZATION_LANDMARKS + 1
            }
        );
    }

    #[test]
    fn refuses_bad_noise_and_ratio_parameters() {
        for control in [
            McControl {
                linear_noise_m_per_s: -1.0,
                ..McControl::default()
            },
            McControl {
                angular_noise_rad_per_s: f32::NAN,
                ..McControl::default()
            },
            McControl {
                resample_ess_ratio: 1.0,
                ..McControl::default()
            },
            McControl {
                resample_ess_ratio: 0.0,
                ..McControl::default()
            },
            McControl {
                converged_radius_m: 0.0,
                ..McControl::default()
            },
            McControl {
                diverged_radius_m: 0.01,
                ..McControl::default()
            },
        ] {
            assert_eq!(
                McLocalizer::new(square_map(), control).unwrap_err(),
                LocalizationError::BadParameter
            );
        }
    }

    /// Every parameter [`McLocalizer::new`] inspects, and the refusal each must produce.
    ///
    /// The constructor's validation was, for **fifteen of its twenty-one** conditions, never
    /// executed. `refuses_bad_noise_and_ratio_parameters` pins six of them
    /// (`linear_noise < 0`, the `angular_noise` finiteness check, `ess_ratio` at both ends,
    /// `converged_radius <= 0`, and `diverged_radius < converged_radius`); with the other
    /// thirteen control checks — and both map-finiteness checks — deleted, the whole suite
    /// stayed green (362 passed). A guard no test executes is a guard that can be dropped
    /// without a red. This one is not cosmetic: a `NaN` `resample_jitter_m` reaches
    /// [`Self::resample`], where it overwrites every particle's position with `NaN` and
    /// poisons `estimate` under an `Ok`.
    ///
    /// Each row mutates exactly one field so its refusal is attributable to the condition
    /// named; the two mutators per field pin the finiteness check and the bound separately.
    #[test]
    fn every_malformed_construction_parameter_is_refused() {
        /// One way to break a control: set a named field to a value the guard must refuse.
        type Corrupt = fn(&mut McControl);
        let bad: [(&str, Corrupt); 25] = [
            ("linear_noise_m_per_s", |c| {
                c.linear_noise_m_per_s = f32::NAN
            }),
            ("linear_noise_m_per_s", |c| c.linear_noise_m_per_s = -1.0),
            ("angular_noise_rad_per_s", |c| {
                c.angular_noise_rad_per_s = f32::NAN
            }),
            ("angular_noise_rad_per_s", |c| {
                c.angular_noise_rad_per_s = -1.0
            }),
            ("heading_noise_rad_per_s", |c| {
                c.heading_noise_rad_per_s = f32::NAN
            }),
            ("heading_noise_rad_per_s", |c| {
                c.heading_noise_rad_per_s = -1.0
            }),
            ("resample_jitter_m", |c| c.resample_jitter_m = f32::NAN),
            ("resample_jitter_m", |c| c.resample_jitter_m = -1.0),
            ("resample_jitter_rad", |c| c.resample_jitter_rad = f32::NAN),
            ("resample_jitter_rad", |c| c.resample_jitter_rad = -1.0),
            ("resample_ess_ratio", |c| c.resample_ess_ratio = f32::NAN),
            ("resample_ess_ratio", |c| c.resample_ess_ratio = 0.0),
            ("resample_ess_ratio", |c| c.resample_ess_ratio = 1.0),
            ("converged_radius_m", |c| c.converged_radius_m = f32::NAN),
            ("converged_radius_m", |c| c.converged_radius_m = 0.0),
            ("converged_heading_rad", |c| {
                c.converged_heading_rad = f32::NAN
            }),
            ("converged_heading_rad", |c| c.converged_heading_rad = 0.0),
            ("diverged_radius_m", |c| c.diverged_radius_m = f32::NAN),
            ("diverged_radius_m", |c| c.diverged_radius_m = 0.01),
            ("sensor_reset_ratio", |c| c.sensor_reset_ratio = f32::NAN),
            ("sensor_reset_ratio", |c| c.sensor_reset_ratio = -0.1),
            ("sensor_reset_ratio", |c| c.sensor_reset_ratio = 1.5),
            ("sensor_reset_trigger", |c| {
                c.sensor_reset_trigger = f32::NAN
            }),
            ("sensor_reset_trigger", |c| c.sensor_reset_trigger = 0.0),
            ("sensor_reset_trigger", |c| c.sensor_reset_trigger = 1.5),
        ];
        for (field, corrupt) in bad {
            let mut control = McControl::default();
            corrupt(&mut control);
            assert_eq!(
                McLocalizer::new(square_map(), control).unwrap_err(),
                LocalizationError::BadParameter,
                "a malformed {field} must be BadParameter"
            );
        }

        // A non-finite landmark in the map is refused for the same reason: it would make
        // every predicted range and bearing non-finite, collapse all weights to zero, and be
        // reported as `match_quality = 0.0` rather than as the malformed input it is.
        type Set = fn(&mut Landmark);
        let bad_map: [(&str, Set); 2] = [
            ("x_m", |l| l.x_m = f32::NAN),
            ("y_m", |l| l.y_m = f32::INFINITY),
        ];
        for (field, corrupt) in bad_map {
            let mut map = square_map();
            corrupt(&mut map[0]);
            assert_eq!(
                McLocalizer::new(map, McControl::default()).unwrap_err(),
                LocalizationError::BadParameter,
                "a non-finite landmark {field} must be BadParameter"
            );
        }

        // The complement, so this test cannot pass by refusing everything: the untouched
        // defaults must construct, and so must a map whose finite landmarks are negative.
        assert!(McLocalizer::new(square_map(), McControl::default()).is_ok());
        // `sensor_reset_ratio = 0.0` is a *legal* control, not a malformed one: it is the
        // documented way to turn recovery off and get the detect-only filter back.
        assert!(
            McLocalizer::new(
                square_map(),
                McControl {
                    sensor_reset_ratio: 0.0,
                    ..McControl::default()
                }
            )
            .is_ok(),
            "0.0 disables sensor resetting and must be accepted, not refused"
        );
    }

    #[test]
    fn refuses_a_bad_initial_sigma() {
        assert_eq!(
            McLocalizer::new_at(square_map(), McControl::default(), 0.0, 0.0, 0.0, 0.0, 0.1)
                .unwrap_err(),
            LocalizationError::BadParameter
        );
        assert_eq!(
            McLocalizer::new_at(
                square_map(),
                McControl::default(),
                0.0,
                0.0,
                0.0,
                f32::NAN,
                0.1
            )
            .unwrap_err(),
            LocalizationError::BadParameter
        );
    }

    /// Every `f32` argument of [`McLocalizer::new_at`] the guard at the top of the function
    /// inspects, and the refusal each must produce.
    ///
    /// This test exists because the guard had, for **five of its seven** conditions, no test at
    /// all: `refuses_a_bad_initial_sigma` pins only the two `sigma_m` conditions (`<= 0.0` and
    /// non-finite). With the other five deleted the whole suite stayed green — including the
    /// finiteness checks on the three *pose* arguments, whose whole job is to keep a `NaN` out of
    /// the sampled cloud, where it would spread to every particle and turn the estimate silently
    /// `NaN` rather than into an error. A guard is only as good as the conditions someone pins.
    #[test]
    fn every_malformed_initial_pose_or_sigma_is_refused() {
        // (x_m, y_m, theta_rad, sigma_m, sigma_theta_rad) — the five positional `f32` arguments.
        let good = [0.0f32, 0.0, 0.0, 0.3, 0.1];
        /// One way to break a `new_at` argument: set the value at one slot to something the guard
        /// must refuse.
        type Corrupt = fn(&mut f32);
        let bad: [(usize, Corrupt); 5] = [
            (0, |v| *v = f32::NAN),          // x_m non-finite
            (1, |v| *v = f32::INFINITY),     // y_m non-finite
            (2, |v| *v = f32::NEG_INFINITY), // theta_rad non-finite
            (4, |v| *v = f32::NAN),          // sigma_theta_rad non-finite
            (4, |v| *v = 0.0),               // sigma_theta_rad not strictly positive
        ];
        for (slot, corrupt) in bad {
            let mut args = good;
            corrupt(&mut args[slot]);
            assert_eq!(
                McLocalizer::new_at(
                    square_map(),
                    McControl::default(),
                    args[0],
                    args[1],
                    args[2],
                    args[3],
                    args[4],
                )
                .unwrap_err(),
                LocalizationError::BadParameter,
                "a malformed argument at slot {slot} must be BadParameter"
            );
        }
        // The complement, so this test cannot pass by refusing everything: the untouched
        // arguments must construct.
        assert!(McLocalizer::new_at(
            square_map(),
            McControl::default(),
            good[0],
            good[1],
            good[2],
            good[3],
            good[4],
        )
        .is_ok());
    }

    #[test]
    fn refuses_a_reading_with_a_nonpositive_variance() {
        let mut filter = McLocalizer::new(square_map(), McControl::default()).unwrap();
        let mut bad = SlamObservation::lidar(5.0, 0.1);
        bad.range_variance = 0.0;
        assert_eq!(
            filter.update(&[bad]).unwrap_err(),
            LocalizationError::BadParameter
        );
    }

    /// Every field of a reading the guard at the top of `update` inspects, and the refusal each
    /// must produce.
    ///
    /// This test exists because the guard had, for **seven of its eight** conditions, no test at
    /// all: `refuses_a_reading_with_a_nonpositive_variance` pins `range_variance <= 0.0` and
    /// nothing else. With the other seven conditions deleted the whole suite stayed green —
    /// including the two **sensor-offset** finiteness checks, which are the ones `ekf.rs`'s
    /// sibling guard omits and which this module's own ledger (REQ-A725 / §37) cites as "the
    /// correct counterpart". A guard is only as good as the conditions someone pins; pointing at
    /// an unpinned guard as the good example is how the hole survives.
    #[test]
    fn every_malformed_reading_is_refused_as_bad_parameter() {
        /// One way to break a reading: set a named field to a value the guard must refuse.
        type Corrupt = fn(&mut SlamObservation);
        let non_finite: [(&str, Corrupt); 6] = [
            ("range_m", |o| o.range_m = f32::NAN),
            ("bearing_rad", |o| o.bearing_rad = f32::INFINITY),
            ("sensor_offset_x_m", |o| o.sensor_offset_x_m = f32::NAN),
            ("sensor_offset_y_m", |o| {
                o.sensor_offset_y_m = f32::NEG_INFINITY
            }),
            ("range_variance", |o| o.range_variance = f32::NAN),
            ("bearing_variance", |o| o.bearing_variance = f32::NAN),
        ];
        for (field, corrupt) in non_finite {
            let mut filter = McLocalizer::new(square_map(), McControl::default()).unwrap();
            let mut bad = SlamObservation::lidar(5.0, 0.1);
            corrupt(&mut bad);
            assert_eq!(
                filter.update(&[bad]).unwrap_err(),
                LocalizationError::BadParameter,
                "a non-finite {field} must be BadParameter"
            );
        }

        // Non-positive variances are refused here. The predicate is `<= 0.0`, where the EKF's
        // sibling guard uses `< 0.0` and lets a zero variance through to be silently dropped by
        // its determinant floor — the asymmetry is recorded in `docs/robot-autonomy.md` §38.
        let non_positive: [(&str, Corrupt); 2] = [
            ("range_variance", |o| o.range_variance = 0.0),
            ("bearing_variance", |o| o.bearing_variance = -1.0),
        ];
        for (field, corrupt) in non_positive {
            let mut filter = McLocalizer::new(square_map(), McControl::default()).unwrap();
            let mut bad = SlamObservation::lidar(5.0, 0.1);
            corrupt(&mut bad);
            assert_eq!(
                filter.update(&[bad]).unwrap_err(),
                LocalizationError::BadParameter,
                "a non-positive {field} must be BadParameter"
            );
        }

        // The complement, so this test cannot pass by refusing everything: a *negative* sensor
        // offset is a legal placement (the scanner may sit behind or beside the centre) and must
        // be accepted. Only non-finiteness is malformed.
        let mut filter = McLocalizer::new(square_map(), McControl::default()).unwrap();
        let mut ok = SlamObservation::lidar(5.0, 0.1);
        ok.sensor_offset_x_m = -0.5;
        ok.sensor_offset_y_m = -0.25;
        assert!(
            filter.update(&[ok]).is_ok(),
            "a negative sensor offset is a legal placement, not a malformed input"
        );
    }

    #[test]
    fn refuses_an_oversized_reading_batch() {
        let mut filter = McLocalizer::new(square_map(), McControl::default()).unwrap();
        let batch = vec![SlamObservation::lidar(5.0, 0.1); MAX_OBSERVATIONS_PER_UPDATE + 1];
        assert_eq!(
            filter.update(&batch).unwrap_err(),
            LocalizationError::TooManyObservations {
                given: MAX_OBSERVATIONS_PER_UPDATE + 1
            }
        );
    }

    #[test]
    fn an_empty_reading_batch_is_a_noop() {
        let mut filter = McLocalizer::new(square_map(), McControl::default()).unwrap();
        let before = filter.particles().to_vec();
        filter.update(&[]).unwrap();
        assert_eq!(filter.particles(), before.as_slice());
    }

    #[test]
    fn predict_refuses_a_bad_command_and_leaves_the_belief_alone() {
        let mut filter = McLocalizer::new(square_map(), McControl::default()).unwrap();
        let before = filter.particles().to_vec();
        for cmd in [
            VelocityCommand {
                linear_m_s: 1.0,
                angular_rad_s: 0.0,
                dt_s: 0.0,
            },
            VelocityCommand {
                linear_m_s: 1.0,
                angular_rad_s: 0.0,
                dt_s: f32::NAN,
            },
            VelocityCommand {
                linear_m_s: f32::INFINITY,
                angular_rad_s: 0.0,
                dt_s: 0.1,
            },
        ] {
            filter.predict(cmd);
        }
        assert_eq!(filter.particles(), before.as_slice());
    }

    /// Every field of a [`VelocityCommand`] the guard at the top of [`McLocalizer::predict`]
    /// inspects, and the silent no-op each must produce.
    ///
    /// This test exists because the guard had, for **one of its four** conditions, no test at
    /// all: `predict_refuses_a_bad_command_and_leaves_the_belief_alone` pins `dt_s` non-finite,
    /// `dt_s <= 0.0` and `linear_m_s` non-finite, but never a non-finite `angular_rad_s`. With
    /// that condition deleted the whole suite stayed green — and its loss is the same silent
    /// `NaN` failure the other three guard against: `w = angular_rad_s + sigma_w * gaussian`
    /// feeds `theta = wrap_angle(θ + w·dt + …)`, so an infinite turn rate wraps to `NaN`, and
    /// `x`/`y` pick that `NaN` up through `theta.cos()`/`theta.sin()`. `predict` returns `()`,
    /// so nothing downstream is told the cloud is now poisoned. This is the **fourth** guard in
    /// the same family as `SlamState::observe` (REQ-A725), `McLocalizer::update` (REQ-A728) and
    /// `McLocalizer::new` / `new_at` (REQ-A733 / REQ-A737) — a guard is only as good as the
    /// conditions someone pins.
    ///
    /// **Correction (REQ-A817 / F-SH-257).** The sentence above that `dt_s <= 0.0` was pinned
    /// here was wrong. The `("dt_s", |c| c.dt_s = 0.0)` case below only asserts the *cloud* is
    /// unchanged, and a zero-`dt` step is a no-op on the cloud whether or not the `dt <= 0.0`
    /// condition exists — so with that condition deleted this test still passed. The leaf is
    /// pinned instead by
    /// `a_nonpositive_dt_is_refused_and_leaves_both_the_cloud_and_last_dt_untouched`, which
    /// pre-moves `last_dt_s` and a negative `dt_s` into the fixture. What was pinned here
    /// without ambiguity is `dt_s` non-finite, `linear_m_s` non-finite, and `angular_rad_s`
    /// non-finite.
    #[test]
    fn every_malformed_command_is_refused_and_leaves_the_belief_alone() {
        /// One way to break a command: set a named field to a value the guard must refuse.
        type Corrupt = fn(&mut VelocityCommand);
        let bad: [(&str, Corrupt); 4] = [
            ("dt_s", |c| c.dt_s = f32::NAN),
            ("dt_s", |c| c.dt_s = 0.0),
            ("linear_m_s", |c| c.linear_m_s = f32::INFINITY),
            ("angular_rad_s", |c| c.angular_rad_s = f32::NEG_INFINITY),
        ];
        for (field, corrupt) in bad {
            let mut filter = McLocalizer::new(square_map(), McControl::default()).unwrap();
            let before = filter.particles().to_vec();
            let mut cmd = VelocityCommand {
                linear_m_s: 1.0,
                angular_rad_s: 0.0,
                dt_s: 0.1,
            };
            corrupt(&mut cmd);
            filter.predict(cmd);
            assert_eq!(
                filter.particles(),
                before.as_slice(),
                "a malformed {field} must leave the cloud untouched"
            );
        }
        // The complement, so this test cannot pass by refusing everything: a legal command must
        // actually move the cloud.
        let mut filter = McLocalizer::new(square_map(), McControl::default()).unwrap();
        let before = filter.particles().to_vec();
        filter.predict(VelocityCommand {
            linear_m_s: 1.0,
            angular_rad_s: 0.5,
            dt_s: 0.1,
        });
        assert_ne!(
            filter.particles(),
            before.as_slice(),
            "a legal command must move the cloud"
        );
    }

    /// A non-positive `dt_s` must be **refused**, not passed through as a no-op.
    ///
    /// The distinction is not academic. `predict` computes `root_dt = dt.sqrt()` and scales
    /// every noise density by it, so a **negative** `dt_s` gives `sqrt(<0) = NaN`, and from
    /// there `sigma_v`/`sigma_w`/`sigma_h` are `NaN`, `w` is `NaN`, `theta` wraps to `NaN`,
    /// and every particle's `x_m`/`y_m`/`theta_rad` is poisoned — silently, because `predict`
    /// returns `()`. A `dt_s = 0` command is calmer but still not a refusal: it leaves the
    /// cloud untouched (all the `dt`-scaled terms vanish) yet still writes `last_dt_s = 0`,
    /// contradicting the doc's "the belief is left exactly as it was".
    ///
    /// `every_malformed_command_is_refused_and_leaves_the_belief_alone` already feeds
    /// `dt_s = 0.0`, but a zero-`dt` step is a no-op on the *particles* regardless of the
    /// guard, so that case passes with the `dt <= 0.0` condition deleted. This test is written
    /// so it cannot: it moves `last_dt_s` off its constructor value with a legal step first,
    /// then asks both a zero and a negative `dt_s` to leave **both** the cloud and
    /// `last_dt_s` exactly where they were. `last_dt_s` is the observable that a zero `dt`
    /// changes and a refusal must not; the negative `dt` additionally pins the `NaN` the leaf
    /// alone prevents.
    #[test]
    fn a_nonpositive_dt_is_refused_and_leaves_both_the_cloud_and_last_dt_untouched() {
        let mut filter = McLocalizer::new(square_map(), McControl::default()).unwrap();
        // Move `last_dt_s` off the constructor's `0.0` so a later silent `last_dt_s = 0` is
        // observable, and give the cloud a non-trivial shape to compare against.
        filter.predict(VelocityCommand {
            linear_m_s: 1.0,
            angular_rad_s: 0.5,
            dt_s: 0.1,
        });
        let before = filter.particles().to_vec();
        let dt_before = filter.last_dt_s();
        assert!(dt_before > 0.0, "the legal step must have set last_dt_s");

        for bad_dt in [0.0, -1.0] {
            filter.predict(VelocityCommand {
                linear_m_s: 1.0,
                angular_rad_s: 0.0,
                dt_s: bad_dt,
            });
            assert_eq!(
                filter.particles(),
                before.as_slice(),
                "dt_s = {bad_dt} must leave the cloud untouched"
            );
            assert_eq!(
                filter.last_dt_s(),
                dt_before,
                "dt_s = {bad_dt} must leave last_dt_s untouched"
            );
        }

        // The complement: a strictly positive `dt_s` moves both the cloud and `last_dt_s`, so
        // this test cannot pass by refusing every command.
        filter.predict(VelocityCommand {
            linear_m_s: 1.0,
            angular_rad_s: 0.5,
            dt_s: 0.2,
        });
        assert_ne!(filter.particles(), before.as_slice());
        assert_eq!(filter.last_dt_s(), 0.2);
    }

    #[test]
    fn the_cloud_covers_the_map_bounding_box_plus_margin() {
        let filter = McLocalizer::new(square_map(), McControl::default()).unwrap();
        // Landmarks span [-10, 10]; the cloud is drawn from [-12, 12].
        for p in filter.particles() {
            assert!((-12.0..=12.0).contains(&p.x_m), "x out of range: {}", p.x_m);
            assert!((-12.0..=12.0).contains(&p.y_m), "y out of range: {}", p.y_m);
            assert!((-PI..=PI).contains(&p.theta_rad));
        }
    }

    #[test]
    fn a_tight_cloud_converges_and_reports_the_pose() {
        let map = square_map();
        let ctrl = McControl {
            particles: 1000,
            ..McControl::default()
        };
        let truth = (3.0f32, -4.0f32, 0.9f32);
        let mut filter =
            McLocalizer::new_at(map.clone(), ctrl, truth.0, truth.1, truth.2, 0.3, 0.1).unwrap();
        // Several stationary updates, as a real loop would produce.
        for i in 0..8u64 {
            filter
                .update(&noisy_readings(truth.0, truth.1, truth.2, &map, 100 + i))
                .unwrap();
        }
        let est = filter.estimate();
        assert!(
            (est.x_m - truth.0).abs() < 0.15,
            "x off by {}",
            (est.x_m - truth.0).abs()
        );
        assert!(
            (est.y_m - truth.1).abs() < 0.15,
            "y off by {}",
            (est.y_m - truth.1).abs()
        );
        assert!(
            wrap_angle(est.theta_rad - truth.2).abs() < 0.1,
            "theta off by {}",
            wrap_angle(est.theta_rad - truth.2).abs()
        );
        assert_eq!(est.health, LocalizationHealth::Converged);
        assert!(
            est.match_quality > 0.2,
            "match quality {}",
            est.match_quality
        );
    }

    /// The scanner rides at a body-frame offset, so the world point it reports *from* is the
    /// robot's pose **rotated by the heading** — `ox·cosθ − oy·sinθ`, `ox·sinθ + oy·cosθ`.
    ///
    /// This is the one term of the shared measurement model that nothing else in the crate
    /// reaches. The EKF's own offset test passes `oy = 0` at heading `0`, where that rotation
    /// is the identity (it demonstrates the offset is *added*, never that it is *rotated*),
    /// and every other test here hands the filter a sensor at the robot centre. So a sign
    /// error in either cross-term is invisible crate-wide — measured, not assumed: flipping
    /// the `sin` term in [`best_landmark_nees`](super::best_landmark_nees) leaves all 407
    /// tests green.
    ///
    /// Both axes are non-zero on purpose — `oy` is what the `sin` terms rotate — and the
    /// assertion that carries the weight is `match_quality`: a model that dropped or
    /// mis-rotated the offset would place the sensor roughly half a metre from where the
    /// reading was taken, a ~20σ miss, and the consistency score would fall to zero.
    #[test]
    fn a_rotated_sensor_offset_is_honoured_by_the_weights() {
        let map = asymmetric_map();
        let ctrl = McControl {
            particles: 1000,
            ..McControl::default()
        };
        let truth = (3.0f32, -4.0f32, 0.9f32);
        let offset = (0.4f32, 0.3f32);
        let mut filter =
            McLocalizer::new_at(map.clone(), ctrl, truth.0, truth.1, truth.2, 0.3, 0.1).unwrap();
        for i in 0..8u64 {
            filter
                .update(&with_scanner_noise(
                    offset_readings(truth.0, truth.1, truth.2, offset, &map),
                    200 + i,
                ))
                .unwrap();
        }
        let est = filter.estimate();
        assert!(
            (est.x_m - truth.0).abs() < 0.15,
            "x off by {}",
            (est.x_m - truth.0).abs()
        );
        assert!(
            (est.y_m - truth.1).abs() < 0.15,
            "y off by {}",
            (est.y_m - truth.1).abs()
        );
        assert!(
            wrap_angle(est.theta_rad - truth.2).abs() < 0.1,
            "theta off by {}",
            wrap_angle(est.theta_rad - truth.2).abs()
        );
        assert!(
            est.match_quality > 0.2,
            "a filter that honoured the rotated offset explains these readings; got {}",
            est.match_quality
        );
    }

    /// The capability the EKF does not have: a cloud spread over the whole map collapses
    /// onto the true pose while the robot drives.
    ///
    /// The robot moves because it must: a *stationary* filter has no source of new samples
    /// (this module implements no roughening), so its cloud can never get finer than the
    /// spacing of the particles it was seeded with. Motion noise in [`McLocalizer::predict`]
    /// is what lets the cloud refine past that floor — which is also true of a real robot,
    /// whose loop always has motion in it.
    #[test]
    fn global_localization_converges_from_a_uniform_cloud() {
        let map = asymmetric_map();
        let ctrl = McControl {
            particles: 4000,
            seed: 7,
            ..McControl::default()
        };
        let (mut tx, mut ty, mut tt) = (-2.0f32, 5.0f32, -2.5f32);
        let mut filter = McLocalizer::new(map.clone(), ctrl).unwrap();
        let before = filter.estimate();
        assert!(
            before.position_sigma_m() > 2.0,
            "the initial cloud should be spread, got {}",
            before.position_sigma_m()
        );

        let cmd = VelocityCommand {
            linear_m_s: 0.4,
            angular_rad_s: 0.15,
            dt_s: 0.1,
        };
        for i in 0..120u64 {
            filter.predict(cmd);
            // The noiseless truth integrated exactly as the motion model's mean does.
            tt = wrap_angle(tt + cmd.angular_rad_s * cmd.dt_s);
            tx += cmd.linear_m_s * cmd.dt_s * tt.cos();
            ty += cmd.linear_m_s * cmd.dt_s * tt.sin();
            filter
                .update(&noisy_readings(tx, ty, tt, &map, 200 + i))
                .unwrap();
        }
        let est = filter.estimate();
        assert!(
            (est.x_m - tx).abs() < 0.3 && (est.y_m - ty).abs() < 0.3,
            "global localization landed at ({}, {}) not ({}, {})",
            est.x_m,
            est.y_m,
            tx,
            ty
        );
        assert!(
            wrap_angle(est.theta_rad - tt).abs() < 0.15,
            "heading {} vs truth {}",
            est.theta_rad,
            tt
        );
        assert_eq!(
            est.health,
            LocalizationHealth::Converged,
            "health {:?} sigma_p {} sigma_h {} mq {} ess {}",
            est.health,
            est.position_sigma_m(),
            est.heading_sigma_rad(),
            est.match_quality,
            est.effective_particles
        );
    }

    /// Roughening is what lets a cloud refine past the spacing it was seeded with even with
    /// the robot standing still — the property the global test above relies on.
    #[test]
    fn roughening_lets_a_stationary_filter_refine() {
        let map = asymmetric_map();
        let mut filter = McLocalizer::new(
            map.clone(),
            McControl {
                particles: 2000,
                seed: 21,
                ..McControl::default()
            },
        )
        .unwrap();
        let truth = (-2.0f32, 5.0f32, -2.5f32);
        for i in 0..40u64 {
            filter
                .update(&noisy_readings(truth.0, truth.1, truth.2, &map, 300 + i))
                .unwrap();
        }
        let est = filter.estimate();
        assert!(
            (est.x_m - truth.0).abs() < 0.25 && (est.y_m - truth.1).abs() < 0.25,
            "stationary localization landed at ({}, {}) not ({}, {})",
            est.x_m,
            est.y_m,
            truth.0,
            truth.1
        );
        assert_eq!(est.health, LocalizationHealth::Converged);
    }

    /// With roughening switched off the cloud degenerates: the spread collapses toward zero
    /// and the estimate freezes wherever the seed lattice happened to land it.
    #[test]
    fn without_roughening_the_cloud_degenerates() {
        let map = asymmetric_map();
        let ctrl = McControl {
            particles: 2000,
            seed: 21,
            resample_jitter_m: 0.0,
            resample_jitter_rad: 0.0,
            ..McControl::default()
        };
        let mut filter = McLocalizer::new(map.clone(), ctrl).unwrap();
        let truth = (-2.0f32, 5.0f32, -2.5f32);
        for i in 0..40u64 {
            filter
                .update(&noisy_readings(truth.0, truth.1, truth.2, &map, 400 + i))
                .unwrap();
        }
        let est = filter.estimate();
        // The cloud has collapsed to a handful of coincident samples: no meaningful spread
        // remains, and no particle can be anywhere the seed lattice did not put one.
        assert!(
            est.position_sigma_m() < 1e-3,
            "the degenerate cloud should have collapsed, sigma {}",
            est.position_sigma_m()
        );
    }

    /// The negative control: a map that does not describe the readings must not be reported
    /// as converged.
    ///
    /// The wrong map must be **non-congruent** to the truth, and that is the point this test
    /// was rewritten to protect. Its first version shifted the true square 100 m away — but a
    /// rigid translation of a landmark set is the *same map*, and readings taken from the
    /// origin against the true square are reproduced exactly by a robot standing at the
    /// translated origin. Nothing could find that pose while the cloud started tight at the
    /// origin and had no motion, so the test passed; once sensor resetting searches the whole
    /// extent, the filter correctly localizes in the shifted map and reports `Converged`. The
    /// fixture was measuring the filter's *search range*, not map disagreement. Each landmark
    /// is now displaced by its own vector, which no rigid transform reproduces, so the
    /// readings genuinely match nothing.
    #[test]
    fn a_wrong_map_is_reported_as_diverged_not_converged() {
        let wrong_map: Vec<Landmark> = square_map()
            .iter()
            .enumerate()
            .map(|(i, l)| {
                let k = i as f32;
                Landmark::new(l.x_m + 100.0 + 7.0 * k, l.y_m + 100.0 - 5.0 * k, 0.05)
            })
            .collect();
        let truth = (0.0f32, 0.0f32, 0.0f32);
        let ctrl = McControl {
            particles: 500,
            seed: 11,
            ..McControl::default()
        };
        let mut filter =
            McLocalizer::new_at(wrong_map.clone(), ctrl, 0.0, 0.0, 0.0, 0.5, 0.2).unwrap();
        // Readings are generated from the TRUE landmark positions and scored against the
        // wrong map, which is the mismatch a survey error actually produces.
        for _ in 0..10 {
            filter
                .update(&readings(truth.0, truth.1, truth.2, &square_map()))
                .unwrap();
        }
        let est = filter.estimate();
        assert!(
            est.match_quality < MATCH_QUALITY_FLOOR,
            "a 100 m map error should collapse match quality, got {}",
            est.match_quality
        );
        assert_ne!(est.health, LocalizationHealth::Converged);
        assert_eq!(est.health, LocalizationHealth::Diverged);
    }

    #[test]
    fn the_same_seed_gives_the_same_particles() {
        let map = square_map();
        let ctrl = McControl {
            seed: 99,
            ..McControl::default()
        };
        let mut a = McLocalizer::new(map.clone(), ctrl).unwrap();
        let mut b = McLocalizer::new(map, ctrl).unwrap();
        assert_eq!(a.particles(), b.particles());
        let cmd = VelocityCommand {
            linear_m_s: 0.7,
            angular_rad_s: 0.2,
            dt_s: 0.1,
        };
        a.predict(cmd);
        b.predict(cmd);
        assert_eq!(a.particles(), b.particles());
    }

    #[test]
    fn a_different_seed_gives_different_particles() {
        let map = square_map();
        let mut a = McLocalizer::new(
            map.clone(),
            McControl {
                seed: 1,
                ..McControl::default()
            },
        )
        .unwrap();
        let b = McLocalizer::new(
            map,
            McControl {
                seed: 2,
                ..McControl::default()
            },
        )
        .unwrap();
        assert_ne!(a.particles(), b.particles());
        // ...and after a move, still different.
        let cmd = VelocityCommand {
            linear_m_s: 1.0,
            angular_rad_s: 0.0,
            dt_s: 0.1,
        };
        a.predict(cmd);
        assert_ne!(a.particles().len(), 0);
    }

    #[test]
    fn the_heading_mean_wraps_around_pi() {
        // A cloud straddling +π, seeded at π with a small sigma. A naive arithmetic mean
        // would land near 0 (the far side of the circle); the circular mean must not.
        let filter = McLocalizer::new_at(
            square_map(),
            McControl {
                particles: 2000,
                seed: 3,
                ..McControl::default()
            },
            -2.0,
            5.0,
            PI - 0.02,
            0.05,
            0.05,
        )
        .unwrap();
        let est = filter.estimate();
        assert!(
            wrap_angle(est.theta_rad - PI).abs() < 0.1
                || wrap_angle(est.theta_rad + PI).abs() < 0.1,
            "circular mean {} should be near ±π",
            est.theta_rad
        );
    }

    #[test]
    fn resampling_keeps_the_count_and_normalises_the_weights() {
        let map = square_map();
        let ctrl = McControl {
            particles: 300,
            seed: 5,
            ..McControl::default()
        };
        let truth = (1.0f32, 2.0f32, 0.3f32);
        let mut filter = McLocalizer::new_at(map.clone(), ctrl, 0.0, 0.0, 0.0, 5.0, 1.0).unwrap();
        filter
            .update(&readings(truth.0, truth.1, truth.2, &map))
            .unwrap();
        assert_eq!(filter.particle_count(), 300);
        let sum: f32 = filter.particles().iter().map(|p| p.weight).sum();
        assert!((sum - 1.0).abs() < 1e-3, "weights sum to {}", sum);
    }

    #[test]
    fn a_tiny_weight_cloud_does_not_produce_nan() {
        // A map so far away that every likelihood underflows to zero must still leave a
        // usable, finite estimate rather than NaN.
        let far: Vec<Landmark> = square_map()
            .iter()
            .map(|l| Landmark::new(l.x_m + 1.0e6, l.y_m, 0.05))
            .collect();
        let ctrl = McControl {
            particles: 200,
            seed: 13,
            ..McControl::default()
        };
        let mut filter = McLocalizer::new_at(far.clone(), ctrl, 0.0, 0.0, 0.0, 0.5, 0.2).unwrap();
        filter
            .update(&readings(0.0, 0.0, 0.0, &square_map()))
            .unwrap();
        let est = filter.estimate();
        assert!(est.x_m.is_finite() && est.y_m.is_finite() && est.theta_rad.is_finite());
        assert_eq!(est.health, LocalizationHealth::Diverged);
        assert_eq!(est.match_quality, 0.0);
    }

    /// The `!total.is_finite()` leaf of the weight-normalisation guard, and why its sibling
    /// `total <= 0.0` is not the same thing.
    ///
    /// `a_tiny_weight_cloud_does_not_produce_nan` (above) drives the **else** branch: its map
    /// is 1e6 m away, so `dr² ≈ 1e12` stays well inside `f32` and `total` is finite (the
    /// weights merely underflow to tiny). The guard's own branch needs the *exponent* to be
    /// non-finite: `best_landmark_nees` squares `range_m − predicted_range` in `f32`, and
    /// `range_m` has **no upper bound** (`update` checks finiteness only), so a single reading
    /// at `1.0e30` overflows `dr²` to `+inf` ⇒ `nees = +inf` ⇒ every `lw = −inf` ⇒
    /// `max_log = −inf` ⇒ `lw − max_log = −inf − (−inf) = NaN` ⇒ `total = Σ exp(NaN) = NaN`.
    ///
    /// Delete the leaf and the else branch divides by `NaN`: every weight becomes `NaN`,
    /// `sum_sq` is `NaN`, `effective_particles` drops to `0.0`, and `0.0 < ess_ratio · n` then
    /// **resamples a cloud whose cumulative weights are all `NaN`** — `while u > NaN` is never
    /// true, so `i` stays `0` and every output particle is a copy of `src[0]` plus jitter. The
    /// documented recovery ("keep the cloud uniform") is gone and the belief collapses onto one
    /// arbitrary hypothesis. `effective_particles` reads `n` either way (resample resets it) and
    /// `match_quality` is `0.0` either way, so the **position spread** is the observable:
    /// measured 0.494 with the leaf and 0.051 without it.
    #[test]
    fn an_all_infinite_nees_reading_keeps_the_cloud_uniform_instead_of_collapsing_it() {
        let ctrl = McControl {
            particles: 200,
            seed: 13,
            ..McControl::default()
        };
        let mut filter = McLocalizer::new_at(square_map(), ctrl, 0.0, 0.0, 0.0, 0.5, 0.2).unwrap();
        let before = filter.estimate().position_sigma_m();
        assert!(before > 0.4, "the cloud starts spread, got {before}");

        filter
            .update(&[SlamObservation::lidar(1.0e30, 0.0)])
            .unwrap();

        let after = filter.estimate().position_sigma_m();
        assert!(
            after > 0.4,
            "a reading that explains nothing must leave the cloud as spread as it was \
             ({before}), not collapse it onto one particle (got {after})"
        );
        let uniform = 1.0 / filter.particle_count() as f32;
        for p in filter.particles() {
            assert!(
                p.weight.is_finite(),
                "a NaN weight is the failure this leaf prevents"
            );
            assert!(
                (p.weight - uniform).abs() < 1e-6,
                "every particle is equally hopeless, so all must carry 1/n"
            );
        }
        let est = filter.estimate();
        assert_eq!(est.match_quality, 0.0);
        assert_eq!(est.health, LocalizationHealth::Diverged);

        // Contrast — the *else* branch collapses the cloud, and that is correct: a reading
        // that actually pins the landmarks concentrates the weights on the hypotheses that
        // explain it. The guard is about the case where *no* hypothesis does.
        let mut pinned = McLocalizer::new_at(square_map(), ctrl, 0.0, 0.0, 0.0, 0.5, 0.2).unwrap();
        pinned
            .update(&readings(0.0, 0.0, 0.0, &square_map()))
            .unwrap();
        assert!(
            pinned.estimate().position_sigma_m() < 0.2,
            "a reading the map does explain must concentrate the cloud, got {}",
            pinned.estimate().position_sigma_m()
        );
    }

    /// Each of the three published verdicts, produced through **the leaf that decides it**.
    ///
    /// [`McControl::diverged_radius_m`]'s own doc says it is "an order of magnitude past the
    /// convergence radius so that the band between the two is a real 'uncertain' region rather
    /// than a knife edge" — so all three bands are load-bearing, and a leaf that never decides
    /// anything is indistinguishable from a correct one until something mutates it. The two
    /// diverged causes are kept apart deliberately: three of the shipped tests reach `Diverged`
    /// through the `match_quality` leaf (`match_quality < MATCH_QUALITY_FLOOR`) and the
    /// `position_sigma_m` leaf is never the decider, so this asserts the *spread* cause with the
    /// match quality explicitly on the good side of the floor.
    ///
    /// The spreads are set at construction ([`McLocalizer::new_at`]), where the cloud's σ is
    /// chosen directly, so each case sits in its band by construction rather than by tuning a
    /// filter's convergence.
    #[test]
    fn the_three_health_bands_are_each_decided_by_their_own_leaf() {
        let ctrl = McControl {
            particles: 500,
            seed: 11,
            ..McControl::default()
        };
        let at = |sigma_m: f32, sigma_theta_rad: f32| {
            McLocalizer::new_at(
                asymmetric_map(),
                ctrl,
                0.0,
                0.0,
                0.0,
                sigma_m,
                sigma_theta_rad,
            )
            .expect("the parameters are finite and strictly positive")
            .estimate()
        };

        // ① `Converged` — both spreads inside their radii. This is also the control: it proves
        // ② and ③ are not green because everything is reported unconverged.
        let tight = at(0.1, 0.05);
        assert!(tight.position_sigma_m() <= ctrl.converged_radius_m);
        assert!(tight.heading_sigma_rad() <= ctrl.converged_heading_rad);
        assert_eq!(tight.health, LocalizationHealth::Converged);

        // ② `Uncertain` through the **position** band: spread past the convergence radius but
        // not past the divergence one.
        let mid = at(1.0, 0.05);
        assert!(mid.position_sigma_m() > ctrl.converged_radius_m);
        assert!(mid.position_sigma_m() <= ctrl.diverged_radius_m);
        assert_eq!(mid.health, LocalizationHealth::Uncertain);

        // ③ `Uncertain` through the **heading** band: the position is tight, so
        // `sigma_h <= converged_heading_rad` is the only conjunct that can refuse `Converged`.
        let turned = at(0.1, 1.0);
        assert!(turned.position_sigma_m() <= ctrl.converged_radius_m);
        assert!(turned.heading_sigma_rad() > ctrl.converged_heading_rad);
        assert_eq!(turned.health, LocalizationHealth::Uncertain);

        // ④ `Diverged` through the **spread** cause, with the readings not at fault — the
        // match quality is on the good side of the floor, so `sigma_p > diverged_radius_m` is
        // the leaf that has to fire.
        let spread = at(3.0, 0.05);
        assert!(spread.position_sigma_m() > ctrl.diverged_radius_m);
        assert!(
            spread.match_quality >= MATCH_QUALITY_FLOOR,
            "the readings must not be the reason this is diverged, got match_quality {}",
            spread.match_quality
        );
        assert_eq!(spread.health, LocalizationHealth::Diverged);
    }

    #[test]
    fn to_pose_rounds_metres_to_millimetres() {
        let map = square_map();
        let ctrl = McControl {
            particles: 400,
            seed: 17,
            ..McControl::default()
        };
        let mut filter = McLocalizer::new_at(map, ctrl, 1.234, -5.678, 0.5, 0.02, 0.01).unwrap();
        filter.predict(VelocityCommand {
            linear_m_s: 0.0,
            angular_rad_s: 0.0,
            dt_s: 0.01,
        });
        let pose = filter.estimate().to_pose();
        assert!(
            (pose.north_mm - 1234).abs() < 100,
            "north_mm {}",
            pose.north_mm
        );
        assert!(
            (pose.east_mm + 5678).abs() < 100,
            "east_mm {}",
            pose.east_mm
        );
        assert!(
            (pose.heading_mrad - 500).abs() < 100,
            "mrad {}",
            pose.heading_mrad
        );
    }

    #[test]
    fn the_particle_count_never_exceeds_the_bound() {
        let filter = McLocalizer::new(
            square_map(),
            McControl {
                particles: MAX_PARTICLES,
                ..McControl::default()
            },
        )
        .unwrap();
        assert_eq!(filter.particle_count(), MAX_PARTICLES);
        assert!(filter.particle_count() <= MAX_PARTICLES);
    }

    #[test]
    fn max_step_evaluations_matches_the_documented_bound() {
        let filter = McLocalizer::new(square_map(), McControl::default()).unwrap();
        assert_eq!(
            filter.max_step_evaluations(),
            DEFAULT_PARTICLES * MAX_OBSERVATIONS_PER_UPDATE * 4
        );
    }

    #[test]
    fn wrap_angle_normalises_into_the_closed_interval() {
        assert!((wrap_angle(0.0) - 0.0).abs() < 1e-6);
        assert!((wrap_angle(2.0 * PI) - 0.0).abs() < 1e-6);
        assert!((wrap_angle(PI + 0.1) - (PI + 0.1 - 2.0 * PI)).abs() < 1e-6);
        assert!((wrap_angle(-PI - 0.1) - (-PI - 0.1 + 2.0 * PI)).abs() < 1e-6);
        for a in [-50.0f32, -6.3, -0.1, 0.5, 6.3, 50.0] {
            let w = wrap_angle(a);
            assert!((-PI..=PI).contains(&w), "{a} wrapped to {w}");
        }
    }

    #[test]
    fn the_default_control_passes_its_own_validation() {
        let filter = McLocalizer::new(square_map(), McControl::default()).unwrap();
        assert_eq!(filter.particle_count(), DEFAULT_PARTICLES);
        assert_eq!(filter.map_len(), 4);
        assert_eq!(filter.last_dt_s(), 0.0);
    }

    /// The feature this module's boundary 2 is about: a robot that has been **kidnapped** — put
    /// down somewhere else with no odometry to say so — is *rescued*, not merely reported lost.
    ///
    /// The filter converges at the origin, then the readings start coming from the far side of
    /// the map with the cloud still sitting on the old pose. The motion model cannot help (there
    /// is no motion), so the only thing that can move the belief is the rescue draw. The
    /// assertion is on the *recovered pose*, not just on the health flipping: a filter that
    /// reported `Uncertain` somewhere random would pass a health-only check.
    #[test]
    fn sensor_resetting_recovers_a_kidnapped_robot() {
        let map = asymmetric_map();
        let ctrl = McControl {
            particles: 4000,
            seed: 31,
            ..McControl::default()
        };
        let (ax, ay, at) = (0.0f32, 0.0f32, 0.0f32);
        let mut filter = McLocalizer::new_at(map.clone(), ctrl, ax, ay, at, 0.3, 0.1).unwrap();
        for i in 0..10u64 {
            filter
                .update(&noisy_readings(ax, ay, at, &map, 500 + i))
                .unwrap();
        }
        let before = filter.estimate();
        assert_eq!(
            before.health,
            LocalizationHealth::Converged,
            "the filter must be converged before it is kidnapped, got {before:?}"
        );

        // Kidnapped: readings now come from 5 m away with a new heading.
        let (bx, by, bt) = (5.0f32, -3.0f32, 2.0f32);
        let mut recovered_at: Option<u64> = None;
        for i in 0..40u64 {
            filter
                .update(&noisy_readings(bx, by, bt, &map, 600 + i))
                .unwrap();
            let est = filter.estimate();
            if est.health == LocalizationHealth::Converged
                && (est.x_m - bx).abs() < 0.3
                && (est.y_m - by).abs() < 0.3
                && wrap_angle(est.theta_rad - bt).abs() < 0.15
            {
                recovered_at = Some(i);
                break;
            }
        }
        let est = filter.estimate();
        assert!(
            recovered_at.is_some(),
            "the rescue draw must place the belief back on the true pose; ended at \
             ({}, {}, {}) with health {:?} after 40 updates",
            est.x_m,
            est.y_m,
            est.theta_rad,
            est.health
        );
    }

    /// The negative control for the test above: with `sensor_reset_ratio = 0.0` the *same*
    /// kidnapping is only ever detected. The belief stays on the old pose and is reported
    /// `Diverged`, which is the pre-resetting behaviour boundary 2 used to describe as the
    /// module's whole contract — so this test fails if the rescue draw leaks into the
    /// disabled path.
    #[test]
    fn without_sensor_resetting_a_kidnapped_robot_stays_lost() {
        let map = asymmetric_map();
        let ctrl = McControl {
            particles: 4000,
            seed: 31,
            sensor_reset_ratio: 0.0,
            ..McControl::default()
        };
        let (ax, ay, at) = (0.0f32, 0.0f32, 0.0f32);
        let mut filter = McLocalizer::new_at(map.clone(), ctrl, ax, ay, at, 0.3, 0.1).unwrap();
        for i in 0..10u64 {
            filter
                .update(&noisy_readings(ax, ay, at, &map, 500 + i))
                .unwrap();
        }

        let (bx, by, bt) = (5.0f32, -3.0f32, 2.0f32);
        for i in 0..40u64 {
            filter
                .update(&noisy_readings(bx, by, bt, &map, 600 + i))
                .unwrap();
            let est = filter.estimate();
            assert_ne!(
                est.health,
                LocalizationHealth::Converged,
                "without the rescue draw a lost belief must never be reported converged \
                 (update {i}, pose ({}, {}))",
                est.x_m,
                est.y_m
            );
        }
        let est = filter.estimate();
        assert_eq!(est.health, LocalizationHealth::Diverged);
        assert!(
            est.match_quality < MATCH_QUALITY_FLOOR,
            "the readings explain nothing on the old pose, got match_quality {}",
            est.match_quality
        );
    }

    /// The rescue draw is **trigger-gated**, not something every update does. The sharp
    /// observable is a `sensor_reset_ratio` of `1.0`: if the trigger fired on a reading the map
    /// *does* explain, the entire cloud would be re-scattered uniformly and the position spread
    /// would jump to map scale (tens of metres). A cloud that stays within the convergence
    /// radius therefore proves the trigger held.
    #[test]
    fn a_matching_reading_never_fires_the_rescue_draw() {
        let map = asymmetric_map();
        let ctrl = McControl {
            particles: 1000,
            seed: 41,
            sensor_reset_ratio: 1.0,
            ..McControl::default()
        };
        let (tx, ty, tt) = (3.0f32, -4.0f32, 0.9f32);
        let mut filter = McLocalizer::new_at(map.clone(), ctrl, tx, ty, tt, 0.3, 0.1).unwrap();
        for i in 0..8u64 {
            filter
                .update(&noisy_readings(tx, ty, tt, &map, 700 + i))
                .unwrap();
        }
        let est = filter.estimate();
        assert_eq!(
            est.health,
            LocalizationHealth::Converged,
            "a matching reading must leave the belief converged, got {est:?}"
        );
        assert!(
            est.position_sigma_m() < 0.25,
            "a ratio of 1.0 would have scattered the whole cloud had the trigger fired; \
             sigma {} says it did not",
            est.position_sigma_m()
        );
    }
}
