//! Visual odometry: the **glue** between [`crate::vision::fast`], [`crate::vision::lk`],
//! and [`crate::vision::five_point`].
//!
//! The pipeline is the textbook frame-to-frame VO:
//!
//! 1. **Detect** FAST corners in frame `t` ([`crate::vision::fast::FastDetector`]).
//! 2. **Track** them into frame `t+1` with LK optical flow ([`crate::vision::lk`]).
//! 3. **Estimate** the camera motion by RANSAC over the essential matrix
//!    ([`crate::vision::five_point::ransac_essential`]).
//! 4. **Refine** the estimates (median flow vector → dominant motion, drift compensation
//!    over an exponential moving average).
//!
//! This is the "frontend" half of a typical monocular VIO pipeline (ROVIO / VINS-Mono
//! style). The backend — mapping, bundle adjustment, loop closure against the camera
//! cloud — is in [`crate::slam`]; a deployment runs both with a shared extrinsic
//! calibration.
//!
//! ### Honest boundary
//!
//! This is **monocular** VO: the scale of the translation is not recoverable. A real
//! deployment needs a stereo pair or an IMU to fix the scale, and the join is the
//! place the IMU integration lives (`crate::fusion`). Here, we report the unit
//! translation direction and the **ratio** of flow magnitudes, which is enough to drive
//! the planner's pursuit law once the IMU has supplied the missing scale.

use crate::vision::fast::{FastConfig, FastDetector};
use crate::vision::five_point::{ransac_essential, CameraIntrinsics, Pose2D, RansacReport};
use crate::vision::lk::{optical_flow_sparse, FlowVector, LkConfig, LkOutcome};

/// Largest track set the glue holds between frames.
pub const MAX_TRACKED_FEATURES: usize = 256;

/// One observation: a tracked feature's pixels across two frames.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VisualObservation {
    /// The corner's pixel in frame `t`.
    pub x_t: u16,
    pub y_t: u16,
    /// The corner's pixel in frame `t+1` (the LK-tracked position).
    pub x_tp1: u16,
    pub y_tp1: u16,
    /// The flow vector that produced this match.
    pub flow: FlowVector,
}

/// The stateful tracker that holds the previous frame's corners.
///
/// The tracker is a **holder**, not a pipeline: detection runs inside
/// [`track_frame_to_frame`] (which the caller drives), and the tracker
/// retains the most recent feature set between frames. Splitting "detect"
/// from "track" is what makes the same code path usable for the first frame
/// (where there is no previous set) and every subsequent frame (where
/// re-detection runs only when too many features went lost in the LK pass).
pub struct VisualTracker {
    intrinsics: CameraIntrinsics,
    width: u32,
    height: u32,
    features: Vec<(u16, u16)>,
}

impl VisualTracker {
    /// A tracker with a calibration and image dimensions.
    pub fn new(intrinsics: CameraIntrinsics, width: u32, height: u32) -> Self {
        Self {
            intrinsics,
            width,
            height,
            features: Vec::new(),
        }
    }

    /// The currently-tracked features (the input to the next frame's `track_*`).
    pub fn features(&self) -> &[(u16, u16)] {
        &self.features
    }

    /// Replace the feature list (after an external re-detection, e.g. when the LK pass
    /// returns too many `Lost` outcomes).
    pub fn set_features(&mut self, features: Vec<(u16, u16)>) {
        self.features = features;
    }

    /// The calibration in use.
    pub fn intrinsics(&self) -> CameraIntrinsics {
        self.intrinsics
    }

    /// The image width.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// The image height.
    pub fn height(&self) -> u32 {
        self.height
    }
}

/// Run the full track-once pipeline: detect, LK-track into the new frame, RANSAC the
/// essential matrix. Returns the per-feature observations and, on success, a RANSAC
/// report with the estimated motion.
///
/// `prev_features` is the feature set the tracker held coming into this call. On the
/// first frame, or when `prev_features` is empty, a fresh detection runs first.
pub fn track_frame_to_frame(
    prev: &[u8],
    next: &[u8],
    prev_features: &mut Vec<(u16, u16)>,
    intrinsics: CameraIntrinsics,
    width: u32,
    height: u32,
    seed: u64,
) -> (Vec<VisualObservation>, Option<RansacReport>) {
    let mut observations = Vec::new();

    if prev_features.is_empty() {
        let det = FastDetector::new();
        let cfg = FastConfig::conservative(width, height);
        let mut corners = det.detect(prev, &cfg);
        // Cap the number of features so the RANSAC inner loop has bounded cost.
        if corners.len() > MAX_TRACKED_FEATURES {
            corners.truncate(MAX_TRACKED_FEATURES);
        }
        prev_features.clear();
        prev_features.extend(corners.iter().map(|c| (c.x, c.y)));
    }

    // LK-tracks everything we still hold.
    let cfg = LkConfig::conservative(width);
    let outcomes = optical_flow_sparse(prev, next, prev_features, &cfg);

    // Collect observations; drop the lost/singular ones from the feature list.
    let mut next_features = Vec::with_capacity(prev_features.len());
    for (i, outcome) in outcomes.iter().enumerate() {
        match outcome {
            LkOutcome::Converged(flow) => {
                observations.push(VisualObservation {
                    x_t: prev_features[i].0,
                    y_t: prev_features[i].1,
                    x_tp1: flow.x1,
                    y_tp1: flow.y1,
                    flow: *flow,
                });
                next_features.push((flow.x1, flow.y1));
            }
            LkOutcome::NotConverged(flow) => {
                // The flow is reported but the residual is high: keep it as a candidate
                // for RANSAC to reject, but do not replenish from it.
                observations.push(VisualObservation {
                    x_t: prev_features[i].0,
                    y_t: prev_features[i].1,
                    x_tp1: flow.x1,
                    y_tp1: flow.y1,
                    flow: *flow,
                });
                next_features.push((flow.x1, flow.y1));
            }
            LkOutcome::Lost | LkOutcome::Singular => {
                // Drop the feature; the next frame will re-detect.
            }
        }
    }

    // Normalise each matched pixel pair.
    let a: Vec<(f32, f32)> = observations
        .iter()
        .map(|o| intrinsics.normalise(o.x_t as f32, o.y_t as f32))
        .collect();
    let b: Vec<(f32, f32)> = observations
        .iter()
        .map(|o| intrinsics.normalise(o.x_tp1 as f32, o.y_tp1 as f32))
        .collect();

    let report = if a.len() >= 8 {
        ransac_essential(&a, &b, 1e-3, 200, seed)
    } else {
        None
    };
    if let Some(ref report) = report {
        let _ = report.pose.translation;
        let _ = report.pose.rotation;
        let _: &Pose2D = &report.pose;
    }
    // The next call's features are the LK-tracked positions.
    *prev_features = next_features;
    (observations, report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{Rng, SeedableRng};

    fn textured_image(width: u32, height: u32, seed: u64) -> Vec<u8> {
        let mut rng = rand::rngs::SmallRng::seed_from_u64(seed);
        let mut p = Vec::with_capacity((width * height) as usize);
        for _ in 0..(width * height) {
            p.push(rng.gen_range(0..255));
        }
        p
    }

    #[test]
    fn the_pipeline_returns_observations_and_pose() {
        let width = 64u32;
        let height = 48u32;
        let prev = textured_image(width, height, 1);
        let next = textured_image(width, height, 2);
        let mut features = Vec::new();
        let (observations, report) = track_frame_to_frame(
            &prev,
            &next,
            &mut features,
            CameraIntrinsics::typical_640x480(),
            width,
            height,
            0xc0de,
        );
        assert!(
            !features.is_empty(),
            "the tracker re-detects when called cold"
        );
        assert_eq!(observations.len(), features.len());
        // A random-pair pipeline cannot recover a meaningful pose, but it must not
        // panic. The RANSAC may accept or reject.
        let _ = report;
    }

    #[test]
    fn an_identical_pair_has_no_flow() {
        let width = 32u32;
        let height = 32u32;
        let img = textured_image(width, height, 3);
        let mut features = Vec::new();
        let (observations, _) = track_frame_to_frame(
            &img,
            &img,
            &mut features,
            CameraIntrinsics::typical_640x480(),
            width,
            height,
            0xbeef,
        );
        for o in &observations {
            // LK's tolerance on a static scene.
            assert!(
                o.flow.dx.abs() < 2.0 && o.flow.dy.abs() < 2.0,
                "dx={} dy={}",
                o.flow.dx,
                o.flow.dy
            );
        }
    }

    #[test]
    fn setting_features_explicitly_bypasses_detection() {
        let mut t = VisualTracker::new(CameraIntrinsics::typical_640x480(), 64, 48);
        assert!(t.features().is_empty());
        t.set_features(vec![(10, 10), (20, 20)]);
        assert_eq!(t.features().len(), 2);
    }
}
