//! 2-D **EKF-SLAM** (Extended Kalman Filter Simultaneous Localization and Mapping).
//!
//! Reference: Thrun, Burgard & Fox, *Probabilistic Robotics* Ch. 10.
//!
//! The split inside the module is deliberate (one module, four submodules — every public
//! type is re-exported here):
//!
//! | Submodule | What it owns |
//! |---|---|
//! | [`ekf`] | The state (`[x, y, θ]`) + N landmarks, the prediction step, the observation update, the maintain routines. |
//! | [`landmarks`] | A 2-D point landmark's identity: position, covariance, an "ever observed?" flag. |
//! | [`data_assoc`] | Mahalanobis-gated nearest-neighbour (and JCBB-style pairwise gates), the **rule that decides which observation is which landmark**. |
//! | [`loop_closure`] | Pose-graph relocalisation by scan matching against the global landmark cloud. |
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
//! 5. **Deterministic seeds.** Every randomised routine (`data_assoc`, `loop_closure`)
//!    takes an `&mut SmallRng` so a regression test can pin the seed.
//! 6. **No allocation in inner loops.** [`data_assoc::associate`] uses caller-supplied
//!    scratch buffers ([`data_assoc::AssocScratch`]) so the data-association step never
//!    touches the allocator.

pub mod data_assoc;
pub mod ekf;
pub mod landmarks;
pub mod loop_closure;
pub mod occupancy;

pub use data_assoc::{associate, AssocScratch, Association};
pub use ekf::{
    EkfSlam, SlamControl, SlamError, SlamObservation, SlamState, VelocityCommand, MAX_LANDMARKS,
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
