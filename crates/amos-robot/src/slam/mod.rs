//! 2-D **EKF-SLAM** (Extended Kalman Filter Simultaneous Localization and Mapping).
//!
//! Reference: Thrun, Burgard & Fox, *Probabilistic Robotics* Ch. 10.
//!
//! The split inside the module is deliberate (one module, five submodules — every public
//! item is re-exported here):
//!
//! | Submodule | What it owns |
//! |---|---|
//! | [`ekf`] | The state (`[x, y, θ]`) + N landmarks, the prediction step, the observation update, the maintain routines. |
//! | [`landmarks`] | A 2-D point landmark's identity: position, covariance, an "ever observed?" flag. |
//! | [`data_assoc`] | Mahalanobis-gated nearest-neighbour over a landmark cloud — the standalone rule for callers without a joint covariance. The EKF's own association is the innovation gate in [`ekf`], with the **Joint Compatibility Branch and Bound** (`associate_joint` / `observe_batch`) as the batch path. |
//! | [`loop_closure`] | Relocalisation by scan matching (a deterministic grid search) against the global landmark cloud; an accepted match is handed back as a **virtual observation** to the EKF — there is no pose graph here. |
//! | [`occupancy`] | A log-odds 2-D occupancy grid, fed by the predicted measurements and used by [`crate::planning::Grid`] as a *map source*. |
//!
//! ### Honest boundaries (registered in `docs/robot-autonomy.md` §4)
//!
//! 1. **Bounded landmarks.** The map grows only up to [`ekf::MAX_LANDMARKS`]; beyond that a
//!    new observation is refused with [`ekf::SlamError::MapFull`] rather than growing the
//!    covariance unboundedly. This is the same "one bounded number per axis" rule the rest
//!    of this crate follows.
//! 2. **2-D.** Every state and every landmark is a 2-D point with a yaw. A 3-D extension
//!    would mean replacing every matrix and every gate — the seam is the [`landmarks::Landmark`]
//!    type, not the algorithm.
//! 3. **No relinearisation on every step.** The state mean is held as floats; the covariance
//!    is the only place floats multiply floats, so the common-case inner loop has bounded
//!    work per landmark.
//! 4. **The covariance is symmetric.** Asymmetric covariance matrices are a sign of
//!    numerical drift, not of physics; [`ekf::SlamState::symmetrise_covariance`] is the
//!    routine that catches it.
//! 5. **Deterministic.** No routine in this module draws random numbers: [`data_assoc::associate`]
//!    is a deterministic gated nearest neighbour, and [`loop_closure::scan_match`] is a
//!    deterministic grid search. The randomness lives in the *vision* front-end's RANSAC
//!    ([`crate::vision::five_point`]), which takes an explicit seeded `SmallRng` so a
//!    regression test can pin it. Reproducible association here is a feature: two runs over
//!    the same inputs must produce the same map.
//! 6. **No allocation in the association inner loop.** [`data_assoc::associate`]'s
//!    comparison loop — observations × landmarks — allocates nothing; it carries the
//!    per-observation nearest neighbour out through a caller-supplied fixed-size workspace
//!    ([`data_assoc::AssocScratch`]). The call itself is **not** allocation-free: it returns
//!    an owned `Vec<Association>`, one allocation per call. That is the deliberate cost of
//!    returning the verdicts, and it is stated as a per-call figure rather than claimed away.

pub mod data_assoc;
pub mod ekf;
pub mod landmarks;
pub mod loop_closure;
pub mod occupancy;

pub use data_assoc::{associate, AssocScratch, Association, ASSOC_CANDIDATES, CHI2_2DOF_95};
pub use ekf::{
    AssociationOutcome, BatchOutcome, EkfSlam, SlamControl, SlamError, SlamObservation, SlamState,
    VelocityCommand, MAX_JCBB_CANDIDATES, MAX_JCBB_NODES, MAX_JCBB_OBSERVATIONS, MAX_LANDMARKS,
};
pub use landmarks::Landmark;
pub use loop_closure::{
    scan_match, LoopClosureReport, ScanMatchConfig, ScanMatchError, ScanMatchResult,
    MAX_SCAN_OPERATIONS, MAX_SCAN_SIZE,
};
pub use occupancy::{
    OccupancyCell, OccupancyError, OccupancyGrid, OccupancyLogodds, OCCUPANCY_DEFAULT_HIT,
    OCCUPANCY_DEFAULT_MISS, OCCUPANCY_MAX_BOUND, OCCUPANCY_MIN_BOUND,
};
