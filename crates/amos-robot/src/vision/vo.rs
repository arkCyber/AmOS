//! Visual odometry: the **glue** between [`crate::vision::fast`], [`crate::vision::lk`],
//! and [`crate::vision::five_point`].
//!
//! The pipeline is the textbook frame-to-frame VO, and it is exactly three stages:
//!
//! 1. **Detect** FAST corners in frame `t` ([`crate::vision::fast::FastDetector`]), or
//!    reuse the set the caller carried in from the previous call.
//! 2. **Track** them into frame `t+1` with LK optical flow ([`crate::vision::lk`]).
//! 3. **Estimate** the camera motion by RANSAC over the essential matrix
//!    ([`crate::vision::five_point::ransac_essential`]).
//!
//! There is no fourth "refine" stage: no median-flow aggregation, no exponential moving
//! average, no drift compensation. The raw RANSAC consensus is the output. A deployment
//! that wants temporal smoothing does it downstream, where it can see the whole history
//! and the covariance.
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
//! place the IMU integration lives (`crate::fusion`). What this module reports is the
//! unit translation direction ([`RansacReport::pose`]) plus the per-feature flow — it does
//! **not** compute any aggregate "ratio of flow magnitudes" (an earlier revision of this
//! paragraph claimed it did; no such quantity appears in [`VisualObservation`] or in
//! [`RansacReport`]). Whatever the flow magnitudes imply about relative depth is left for a
//! caller that has the scale and wants to derive it.

use crate::vision::fast::{FastConfig, FastDetector};
use crate::vision::five_point::{ransac_essential, CameraIntrinsics, RansacReport};
use crate::vision::lk::{optical_flow_sparse, FlowVector, LkConfig, LkOutcome};

/// Largest track set the glue **generates** in a frame step: the detection cap in
/// `detect_corners` and the refill cap in `replenish`.
///
/// It is **not** a check on a caller-supplied set. `track_frame_to_frame` takes
/// `&mut Vec<(u16, u16)>` and tracks whatever it is handed, so a caller that passes in (or
/// installs with [`VisualTracker::set_features`]) a longer list will see it propagated
/// verbatim — the glue does not truncate it. Bounded work is therefore the caller's
/// contract to keep at that boundary; this constant bounds only what the glue invents.
/// (An earlier revision of this doc said "the largest track set the glue *holds* between
/// frames", which overstates it: the cap is applied to detections, not to the input.)
pub const MAX_TRACKED_FEATURES: usize = 256;

/// Below this many surviving features, the tracker re-detects corners to refill the set.
/// Half the cap: fewer than 128 tracks leaves the RANSAC inlier set small enough that a
/// single bad match can pull the essential-matrix estimate.
///
/// The re-detection runs on the **target** frame `next`, not on `prev` (see
/// [`track_frame_to_frame`]): those detections live in `next`, which is where the surviving
/// tracks already are and where the next call's `prev_features` must point. An earlier
/// revision of this doc said "in the current frame", which reads as `prev`.
pub const MIN_TRACKED_FEATURES: usize = MAX_TRACKED_FEATURES / 2;

/// Minimum separation (pixels) between a freshly-detected corner and an existing track,
/// so re-detection does not stack new corners onto ones that already survived.
const MIN_REDETECT_SPACING_PX: i32 = 8;

/// Fewest matched pairs the eight-point solver needs. Below this the RANSAC call is skipped
/// and the report is `None`.
///
/// Note this guard is **redundant in effect**: [`ransac_essential`] opens with its own
/// `if a.len() < 8 { return None }`, so removing this one would produce the same `None` for
/// the same input. It is kept as a local statement of the requirement (and to avoid the
/// call), but because the two paths are observationally identical **no test can distinguish
/// them** — so none claims to. An earlier revision of this doc said the guard avoids
/// feeding the solver "a degenerate design matrix", which implies the callee would
/// otherwise mishandle a short input; it would not, it returns `None`.
const VO_MIN_SAMPLES: usize = 8;

/// Inlier threshold for the VO RANSAC: the **squared** Sampson distance in normalised
/// image-plane units (see [`crate::vision::five_point::DEFAULT_INLIER_THRESHOLD`] for the
/// unit). Tighter than that default (1.0) because the matches here are sub-pixel LK tracks,
/// not raw detections, so a correct match should sit far inside it.
const VO_INLIER_THRESHOLD: f32 = 1e-3;

/// RANSAC iterations for the VO step, below
/// [`crate::vision::five_point::MAX_RANSAC_ITERATIONS`] (256): this runs on every frame
/// over a bounded track set, and the frame-to-frame motion is small enough that the inlier
/// ratio is high, so the expected iteration count is well under this.
const VO_RANSAC_ITERATIONS: u32 = 200;

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

/// A convenience holder for the feature set the caller carries between frames.
///
/// It is a **holder only** — it owns the calibration, the image size, and the last feature
/// list, and it does nothing else. It is *not* driven by [`track_frame_to_frame`], which
/// takes the feature list directly as `&mut Vec<(u16, u16)>` and never consults a
/// `VisualTracker`; a caller may use this type to carry that `Vec` (and the calibration
/// that goes with it) in one place, or ignore it entirely and keep its own state. Nothing
/// here detects, tracks, or filters.
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
        *prev_features = detect_corners(prev, width, height);
    }

    // LK-tracks everything we still hold.
    let cfg = LkConfig::conservative(width);
    let outcomes = optical_flow_sparse(prev, next, prev_features, &cfg);

    // Collect observations; drop the lost/singular ones from the feature list.
    let mut next_features = Vec::with_capacity(MAX_TRACKED_FEATURES);
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
                // The flow is reported so RANSAC can reject it, but a high-residual
                // track is not carried forward: seeding the next frame from a
                // non-converged position compounds the error frame over frame.
                observations.push(VisualObservation {
                    x_t: prev_features[i].0,
                    y_t: prev_features[i].1,
                    x_tp1: flow.x1,
                    y_tp1: flow.y1,
                    flow: *flow,
                });
            }
            LkOutcome::Lost | LkOutcome::Singular => {
                // Drop the feature; it is replaced below if the set got too small.
            }
        }
    }

    // Too few survivors: re-detect in the *target* frame (where these features live for
    // the next call) and top the set back up, keeping the detections that are not already
    // within `MIN_REDETECT_SPACING_PX` of a survivor.
    if next_features.len() < MIN_TRACKED_FEATURES {
        replenish(next, width, height, &mut next_features);
    }

    // Normalise each matched pixel pair. The target is taken at the **sub-pixel** flow
    // position (`x_t + dx`), not the rounded `x_tp1`: the essential matrix is solved in
    // normalised coordinates where a half-pixel error is a real angular error, and the
    // rounding would throw away the accuracy LK just paid for.
    let a: Vec<(f32, f32)> = observations
        .iter()
        .map(|o| intrinsics.normalise(o.x_t as f32, o.y_t as f32))
        .collect();
    let b: Vec<(f32, f32)> = observations
        .iter()
        .map(|o| intrinsics.normalise(o.x_t as f32 + o.flow.dx, o.y_t as f32 + o.flow.dy))
        .collect();

    let report = if a.len() >= VO_MIN_SAMPLES {
        ransac_essential(&a, &b, VO_INLIER_THRESHOLD, VO_RANSAC_ITERATIONS, seed)
    } else {
        None
    };
    // The next call's features are the LK-tracked positions.
    *prev_features = next_features;
    (observations, report)
}

/// Detect FAST corners in `image`, strongest response first, capped at
/// [`MAX_TRACKED_FEATURES`].
///
/// The sort matters: `FastDetector` returns corners in raster order, so truncating that
/// list keeps an arbitrary top-left block of the frame and starves the rest. Ordering by
/// score before the cap keeps the **strongest** responses instead, wherever they sit in the
/// frame. It does **not** make the kept set spatially distributed — a frame whose 256
/// strongest corners are clustered keeps the cluster; spreading the set is
/// [`replenish`]'s spacing filter, and only on the refill path. (An earlier revision of
/// this doc said "the strongest, spatially-distributed response", which claims more than
/// the sort does.)
fn detect_corners(image: &[u8], width: u32, height: u32) -> Vec<(u16, u16)> {
    let mut corners = FastDetector::new().detect(image, &FastConfig::conservative(width, height));
    corners.sort_by_key(|c| std::cmp::Reverse(c.score));
    corners.truncate(MAX_TRACKED_FEATURES);
    corners.iter().map(|c| (c.x, c.y)).collect()
}

/// Top `features` back up to [`MAX_TRACKED_FEATURES`] from a fresh detection over
/// `image`, skipping detections that fall within [`MIN_REDETECT_SPACING_PX`] of a
/// feature already held (so the set does not pile many tracks onto one corner).
fn replenish(image: &[u8], width: u32, height: u32, features: &mut Vec<(u16, u16)>) {
    let spacing2 = (MIN_REDETECT_SPACING_PX as i64) * (MIN_REDETECT_SPACING_PX as i64);
    for (fx, fy) in detect_corners(image, width, height) {
        if features.len() >= MAX_TRACKED_FEATURES {
            break;
        }
        // `i64`: a `u16` coordinate reaches 65535, so `dx*dx` in `i32` overflows past a
        // 46340-px separation (panic in debug, a wrapped negative — i.e. "too close" — in
        // release, which would wrongly discard corners across a wide frame).
        let too_close = features.iter().any(|&(x, y)| {
            let dx = x as i64 - fx as i64;
            let dy = y as i64 - fy as i64;
            dx * dx + dy * dy < spacing2
        });
        if !too_close {
            features.push((fx, fy));
        }
    }
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

    /// Named for what it actually pins: on two *unrelated* random images the pipeline must
    /// still produce observations and re-detected in-bounds features without panicking. It
    /// does **not** assert a recovered pose — a random pair has no consistent motion, so
    /// `report` may legitimately be `None` and is discarded here. The test that drives and
    /// checks the pose branch is `a_horizontal_shift_reaches_the_ransac_branch_and_recovers_a_model`.
    #[test]
    fn the_pipeline_survives_two_unrelated_frames() {
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
        assert!(
            features.len() <= MAX_TRACKED_FEATURES,
            "the feature set must stay within the cap, got {}",
            features.len()
        );
        for &(x, y) in &features {
            assert!(
                (x as u32) < width && (y as u32) < height,
                "re-detected feature ({x},{y}) is outside the {width}×{height} frame"
            );
        }
        assert!(!observations.is_empty(), "some corners must track");
        // A random-pair pipeline cannot recover a meaningful pose, but it must not
        // panic. The RANSAC may accept or reject.
        let _ = report;
    }

    /// A grid of isolated 3×3 bright dots every 10 px: many strong FAST corners, all
    /// further apart than [`MIN_REDETECT_SPACING_PX`] so none are filtered out.
    fn dot_grid(size: u32) -> Vec<u8> {
        let mut p = vec![0u8; (size * size) as usize];
        let mut cy = 2;
        while cy + 3 <= size {
            let mut cx = 2;
            while cx + 3 <= size {
                for y in cy..cy + 3 {
                    for x in cx..cx + 3 {
                        p[(y * size + x) as usize] = 255;
                    }
                }
                cx += 10;
            }
            cy += 10;
        }
        p
    }

    /// The cap keeps the **strongest** detections, not a raster-order block. The fixture
    /// fills the frame with weak (score-100) corners and puts a single saturated (score-255)
    /// corner at the bottom-right — last in raster order, so a cap applied *before* the sort
    /// would drop it. Both paths are exercised: `detect_corners` directly, and
    /// `track_frame_to_frame`'s cold start, which is the only caller a deployment reaches.
    #[test]
    fn the_cap_keeps_the_strongest_response_not_the_top_left_block() {
        let size = 192u32;
        let mut img = vec![0u8; (size * size) as usize];
        // Weak 3×3 dots on a 10-px lattice: well over `MAX_TRACKED_FEATURES` of them, all
        // scoring ~100 (value 100 on a 0 background) and all mutually separated.
        let mut cy = 2;
        while cy + 3 <= size {
            let mut cx = 2;
            while cx + 3 <= size {
                for y in cy..cy + 3 {
                    for x in cx..cx + 3 {
                        img[(y * size + x) as usize] = 100;
                    }
                }
                cx += 10;
            }
            cy += 10;
        }
        // One saturated corner, raster-last of everything above.
        let (bx, by) = (182u32, 182u32);
        for y in by..by + 3 {
            for x in bx..bx + 3 {
                img[(y * size + x) as usize] = 255;
            }
        }
        let detected = detect_corners(&img, size, size);
        assert_eq!(
            detected.len(),
            MAX_TRACKED_FEATURES,
            "the fixture must have more corners than the cap, or truncation never bites"
        );
        assert!(
            detected
                .iter()
                .any(|&(x, y)| x >= bx as u16 && y >= by as u16),
            "the strongest corner (bottom-right) must survive the cap, got {detected:?}"
        );

        // The same guarantee through the public entry point: a cold `track_frame_to_frame`
        // on a uniform `prev` detects in `prev` and finds nothing, so the refill path
        // (which also sorts) is what populates the set from `next`.
        let prev = vec![128u8; (size * size) as usize];
        let mut features = Vec::new();
        let _ = track_frame_to_frame(
            &prev,
            &img,
            &mut features,
            CameraIntrinsics::typical_640x480(),
            size,
            size,
            0x1ce,
        );
        assert!(
            features
                .iter()
                .any(|&(x, y)| x >= bx as u16 && y >= by as u16),
            "the refill path must also keep the strongest corner, got {features:?}"
        );
    }

    #[test]
    fn a_frame_that_loses_every_track_is_repopulated_by_redetection() {
        // `prev` is uniform, so the cold detection finds nothing and every track is
        // lost; `next` is corner-rich, so re-detection must refill the tracker from it.
        let size = 128u32;
        let prev = vec![128u8; (size * size) as usize];
        let next = dot_grid(size);
        let mut features = Vec::new();
        let (observations, _) = track_frame_to_frame(
            &prev,
            &next,
            &mut features,
            CameraIntrinsics::typical_640x480(),
            size,
            size,
            0x1234,
        );
        assert!(
            observations.is_empty(),
            "a uniform previous frame has nothing to track"
        );
        // The set must be refilled from `next`, and every admitted corner must come from
        // the fresh detection and respect the spacing floor.
        let detected = detect_corners(&next, size, size);
        assert!(
            !detected.is_empty(),
            "fixture must produce detectable corners"
        );
        assert!(
            !features.is_empty(),
            "a fully-lost frame must be repopulated by re-detection"
        );
        for f in &features {
            assert!(
                detected.contains(f),
                "replenished feature {f:?} was not a detected corner of `next`"
            );
        }
    }

    /// A single `Lost` track must be **dropped**, not carried forward: the frame pair here
    /// is identical, so a tracker that kept the seed would report a zero-flow observation.
    /// The drop also drops the survivor count below [`MIN_TRACKED_FEATURES`], which must
    /// trigger re-detection — so both halves of the `Lost | Singular` arm are pinned.
    #[test]
    fn a_lost_track_is_dropped_and_the_set_is_topped_back_up() {
        let size = 128u32;
        let img = dot_grid(size);
        // (0, 0) has no room for a 3×3 LK window, so LK reports `Lost` for it.
        let mut features = vec![(0u16, 0u16)];
        let (observations, _) = track_frame_to_frame(
            &img,
            &img,
            &mut features,
            CameraIntrinsics::typical_640x480(),
            size,
            size,
            0x5eed,
        );
        assert!(
            observations.is_empty(),
            "a Lost feature must contribute no observation, got {observations:?}"
        );
        assert!(
            !features.contains(&(0, 0)),
            "the Lost seed must be dropped, not carried forward"
        );
        assert!(
            features.len() > 1,
            "dropping the seed must trigger re-detection, got {} feature(s)",
            features.len()
        );
        // Re-detection obeys the spacing floor, which can hold the count below
        // `MIN_TRACKED_FEATURES` on a sparse frame — so the guarantee is "refilled from
        // `next`'s own corners", not "refilled to the floor".
        let detected = detect_corners(&img, size, size);
        for f in &features {
            assert!(
                detected.contains(f),
                "replenished feature {f:?} was not a detected corner of `next`"
            );
        }
    }

    #[test]
    fn redetection_does_not_stack_features_on_one_corner() {
        // A single isolated bright square produces a tight cluster of FAST corners.
        // Without the spacing filter, `replenish` would pack them all in; with it, the
        // set keeps only well-separated detections.
        let size = 96u32;
        let mut img = vec![0u8; (size * size) as usize];
        for y in 40..56 {
            for x in 40..56 {
                img[(y * size + x) as usize] = 255;
            }
        }
        let mut features = Vec::new();
        replenish(&img, size, size, &mut features);
        for i in 0..features.len() {
            for j in (i + 1)..features.len() {
                let dx = features[i].0 as i64 - features[j].0 as i64;
                let dy = features[i].1 as i64 - features[j].1 as i64;
                let spacing = (MIN_REDETECT_SPACING_PX as i64) * (MIN_REDETECT_SPACING_PX as i64);
                assert!(
                    dx * dx + dy * dy >= spacing,
                    "features {:?} and {:?} are closer than the spacing floor",
                    features[i],
                    features[j]
                );
            }
        }
    }

    /// `replenish` must stop at [`MAX_TRACKED_FEATURES`]: a set already at the cap is left
    /// alone even when the image has corners to add. The cap is the bounded-work guarantee
    /// for the whole frame pipeline, and the `break` that enforces it only fires when the
    /// set arrives with entries in it (`track_frame_to_frame` calls `replenish` with the
    /// survivors, which can be non-empty), which no other test exercises.
    #[test]
    fn replenish_never_exceeds_the_cap() {
        let size = 64u32;
        let img = dot_grid(size);
        assert!(
            !detect_corners(&img, size, size).is_empty(),
            "fixture must have corners, or the loop body never runs"
        );
        let mut features = vec![(0u16, 0u16); MAX_TRACKED_FEATURES];
        replenish(&img, size, size, &mut features);
        assert_eq!(
            features.len(),
            MAX_TRACKED_FEATURES,
            "replenish must not grow the set past the cap"
        );
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

    /// The holder's read-back surface. `intrinsics`/`width`/`height` are what a caller reads
    /// to size the next frame's buffers, so a `new` that stored the dimensions swapped would
    /// otherwise hand LK a transposed image on every frame.
    #[test]
    fn the_holder_reads_back_its_calibration_and_dimensions() {
        let intrinsics = CameraIntrinsics {
            fx: 400.0,
            fy: 400.0,
            cx: 31.5,
            cy: 23.5,
        };
        let t = VisualTracker::new(intrinsics, 64, 48);
        assert_eq!(t.width(), 64);
        assert_eq!(t.height(), 48);
        assert_ne!(t.width(), t.height(), "the fixture must not hide a swap");
        assert_eq!(t.intrinsics(), intrinsics);
        // And the dimensions are the ones `typical_640x480` does *not* use, so the assertion
        // above cannot pass via a default.
        assert_ne!(t.intrinsics(), CameraIntrinsics::typical_640x480());
    }

    /// The other tests only check that a report is *not* produced (or discard it with
    /// `let _ =`). This one drives the RANSAC branch (`observations >= VO_MIN_SAMPLES`)
    /// with a geometrically consistent scene, so a regression that broke the estimator
    /// call — a wrong threshold, a swapped argument, an early `None` — fails here.
    ///
    /// A pure horizontal image shift is a valid epipolar geometry: the camera translates
    /// parallel to the image plane, so the epipole is at infinity and every epipolar line
    /// is horizontal. Every tracked pair is therefore an exact inlier.
    #[test]
    fn a_horizontal_shift_reaches_the_ransac_branch_and_recovers_a_model() {
        let width = 96u32;
        let height = 96u32;
        let prev = textured_image(width, height, 7);
        // Shift the same noise 3 px right, so each feature has a true correspondence.
        let mut next = vec![0u8; (width * height) as usize];
        for y in 0..height {
            for x in 0..width {
                let sx = (x as i64 - 3).clamp(0, width as i64 - 1) as u32;
                next[(y * width + x) as usize] = prev[(y * width + sx) as usize];
            }
        }
        let mut features = Vec::new();
        let (observations, report) = track_frame_to_frame(
            &prev,
            &next,
            &mut features,
            CameraIntrinsics::typical_640x480(),
            width,
            height,
            0x5eed,
        );
        assert!(
            observations.len() >= VO_MIN_SAMPLES,
            "the fixture must yield at least {VO_MIN_SAMPLES} tracked pairs, got {}",
            observations.len()
        );
        let report = report.expect("a consistent shift must produce a RANSAC model");
        assert_eq!(
            report.pose.total as usize,
            observations.len(),
            "RANSAC must see every tracked pair"
        );
        assert!(
            report.iterations >= 1 && report.iterations <= VO_RANSAC_ITERATIONS,
            "iterations must be bounded and non-zero, got {}",
            report.iterations
        );
    }
}
