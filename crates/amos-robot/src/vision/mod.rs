//! Sparse visual odometry: FAST corner detector, Lucas-Kanade optical flow,
//! 5-point essential-matrix solver with RANSAC, frame-to-frame pose recovery.
//!
//! References:
//!
//! * Rosten & Drummond, *"Fusing points and lines for high performance tracking"* (FAST).
//! * Lucas & Kanade, *"An iterative image registration procedure with application to
//!   stereo vision"* (LK optical flow).
//! * Nistér, *"An efficient solution to the five-point relative pose problem"* (the
//!   essential-matrix estimator this module approximates with the Stewénius 5-point
//!   polynomial solver, kept as the textbook *eight-point* baseline for stability).
//! * Hartley & Zisserman, *Multiple View Geometry* (the RANSAC loop and the essential
//!   matrix's null-space projection).
//!
//! ### Why this is a separate module from [`crate::slam`]
//!
//! Visual odometry and laser SLAM are two parallel front-ends that *can* feed the same
//! back-end, but they make different assumptions:
//!
//! * The laser SLAM front-end assumes 2-D planar motion; the visual front-end assumes a
//!   calibrated camera and arbitrary 3-D motion.
//! * The laser front-end's landmarks are points in a 2-D world; the visual front-end's
//!   landmarks are 3-D rays, triangulated later.
//!
//! Keeping them in separate modules means a deployment can swap one out (a stereo
//! camera, a depth sensor) without touching the other. Both produce a
//! `VisualObservation` whose type signature makes the assumption explicit.
//!
//! ### Honest boundaries
//!
//! 1. **Synthetic image input.** The module operates on flat `&[u8]` luminance buffers;
//!    it does not depend on a camera driver. A deployment hands it the output of its
//!    camera abstraction, which is the seam for testing and for swap-in.
//! 2. **Integer arithmetic in the inner loops.** The detector's threshold and the flow's
//!    gradient sums are `i32`, not `f32` — pixels are `u8`, gradients are `i32`.
//! 3. **RANSAC bounded.** [`five_point::MAX_RANSAC_ITERATIONS`] = 256; a real
//!    RANSAC implementation is correct in expectation over `O(log(1 − p)) / log(1 − w^n)`
//!    iterations, and 256 is enough for `n = 5`, `w = 0.3`, `p = 0.999`.
//! 4. **No camera matrix dependency.** The intrinsic calibration is a single
//!    [`CameraIntrinsics`] value; the essential matrix is in *normalised* image
//!    coordinates, so a deployment can apply its own intrinsics without rewriting the
//!    solver.

pub mod fast;
pub mod five_point;
pub mod lk;
pub mod vo;

pub use fast::{Corner, FastConfig, FastDetector};
pub use five_point::{
    essential_matrix_eight_point, recover_pose_from_essential, CameraIntrinsics, Essential, Pose2D,
    RansacReport, MAX_RANSAC_ITERATIONS,
};
pub use lk::{optical_flow_sparse, FlowVector, LkConfig, LkOutcome};
pub use vo::{track_frame_to_frame, VisualObservation, VisualTracker, MAX_TRACKED_FEATURES};
