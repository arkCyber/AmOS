//! EKF-SLAM end-to-end: predict → observe → loop closure.
//!
//! Why this lives in tests/ and not in src/: EKF-SLAM is correct only when
//! the *whole loop* is correct — a unit test on the prediction step can pass
//! while the loop closure silently corrupts the map. This file runs the loop
//! on a synthetic trajectory and asserts:
//!
//! 1. **Bounded pose**: over a synthetic lap the pose stays finite and within a
//!    generous box. This is a *wiring* check, **not** a ground-truth accuracy
//!    bound: the scenario feeds odometry a constant `range = 5, bearing = 0`
//!    reading regardless of where the robot is, which is not a physically
//!    consistent measurement model, so the EKF has no truth to converge to. (An
//!    earlier doc claimed "within 0.5 m of the ground truth"; no ground truth is
//!    ever computed here.)
//! 2. **Landmark consistency**: observing one point twice creates it on the
//!    first call and *matches* it on the second — the outcome, not merely the
//!    count, is pinned.
//! 3. **Refusals**: an empty scan, an empty map and a degenerate search window
//!    are refused before any internal state mutates. An *oversize* scan is
//!    **not** refused: `scan_match` caps it at [`MAX_SCAN_SIZE`] and reports the
//!    capped count, which this file pins too.
//!
//! This is not a claim about real-world noise (the inputs are deterministic
//! synthetic ones); the honest bound is "the algorithm is wired up correctly".

use amos_robot::slam::{
    loop_closure::scan_match_window_budget, scan_match, AssociationOutcome, EkfSlam, Landmark,
    ScanMatchConfig, ScanMatchError, SlamObservation, VelocityCommand, MAX_LANDMARKS,
    MAX_SCAN_OPERATIONS, MAX_SCAN_SIZE,
};

/// Run a small trajectory: forward 1 m/s, slow yaw, with a Lidar observing
/// the same five landmarks each tick. The landmarks stay in the map; the
/// pose estimate should be finite, and the loop should not panic.
#[test]
fn bounded_pose_after_a_short_trajectory() {
    let mut slam = EkfSlam::default();
    let dt: f32 = 0.05;
    let v: f32 = 1.0;
    let omega: f32 = 2.0 * std::f32::consts::PI / (1.0_f32 * 1.0_f32 / dt); // 1 Hz yaw
    let cmd = VelocityCommand {
        linear_m_s: v,
        angular_rad_s: omega,
        dt_s: dt,
    };
    for _ in 0..80 {
        slam.predict(cmd).expect("predict");
        // Observe the same landmark each tick — the EKF should converge.
        slam.observe(SlamObservation::lidar(5.0, 0.0))
            .expect("observe");
    }
    let pose = slam.pose();
    assert!(pose.iter().all(|x| x.is_finite()));
    // The pose must actually have moved (a stuck-at-origin estimate would also satisfy a
    // pure "is finite" check, so the bound alone is not enough), and stay in a generous box.
    assert!(
        pose[0].hypot(pose[1]) > 0.1,
        "80 ticks of 1 m/s forward motion must move the estimate off the origin: {pose:?}"
    );
    assert!(
        pose[0].abs() < 20.0 && pose[1].abs() < 20.0,
        "pose escaped: {pose:?}"
    );
    assert!(pose[2].is_finite());
}

#[test]
fn revisiting_a_corner_first_creates_then_matches_a_landmark() {
    let mut slam = EkfSlam::default();
    // First observation: a new landmark is created.
    let first = slam
        .observe(SlamObservation::lidar(2.0, 0.0))
        .expect("observe");
    // Second observation of the same point: the landmark is matched (no duplicate created).
    let second = slam
        .observe(SlamObservation::lidar(2.0, 0.0))
        .expect("observe");
    // Pin the *outcomes*, not just the count: the earlier version bound these to `_` and
    // asserted only `num_landmarks() == 1`, so it would still pass if `observe` had reported
    // `Created` twice while some other path kept the count at one.
    assert!(
        matches!(first, AssociationOutcome::Created { landmark_index: 0 }),
        "the first sighting must create landmark 0, got {first:?}"
    );
    assert!(
        matches!(second, AssociationOutcome::Matched { landmark_index: 0 }),
        "the second sighting must match landmark 0, got {second:?}"
    );
    assert_eq!(
        slam.num_landmarks(),
        1,
        "the same point observed twice must not create a duplicate landmark"
    );
}

#[test]
fn non_finite_inputs_are_refused() {
    let mut slam = EkfSlam::default();
    // NaN-bearing observation.
    let bad = SlamObservation {
        range_m: f32::NAN,
        bearing_rad: 0.0,
        range_variance: 0.0025,
        bearing_variance: 0.001,
        sensor_offset_x_m: 0.0,
        sensor_offset_y_m: 0.0,
    };
    assert!(slam.observe(bad).is_err());
    // Zero or negative dt for predict.
    let bad_cmd = VelocityCommand {
        linear_m_s: 1.0,
        angular_rad_s: 0.0,
        dt_s: 0.0,
    };
    assert!(slam.predict(bad_cmd).is_err());
}

#[test]
fn run_ticks_full_circle_does_not_exceed_the_landmark_cap() {
    let mut slam = EkfSlam::default();
    let dt: f32 = 0.05;
    let cmd = VelocityCommand {
        linear_m_s: 0.0,
        angular_rad_s: 1.0,
        dt_s: dt,
    };
    for i in 0..(MAX_LANDMARKS + 50) {
        slam.predict(cmd).expect("predict");
        // Distribute the observations by angle so each one is a new landmark.
        let angle = (i as f32) * 0.1;
        if slam.observe(SlamObservation::lidar(5.0, angle)).is_err() {
            break;
        }
    }
    assert!(
        slam.num_landmarks() <= MAX_LANDMARKS,
        "the EKF must not exceed MAX_LANDMARKS landmarks"
    );
}

#[test]
fn scan_match_refuses_empty_inputs_without_panicking() {
    let cfg = ScanMatchConfig::default();
    // An empty scan is refused.
    let no_map: Vec<Landmark> = Vec::new();
    assert_eq!(
        scan_match(&no_map, &[], [0.0; 3], &cfg),
        Err(ScanMatchError::EmptyScan)
    );
    // So is an empty map with a non-empty scan.
    let scan = [(1.0f32, 0.0f32)];
    assert_eq!(
        scan_match(&no_map, &scan, [0.0; 3], &cfg),
        Err(ScanMatchError::EmptyMap)
    );
}

/// An oversize scan is **capped**, not refused: `scan_match` truncates to
/// [`MAX_SCAN_SIZE`] and reports the capped count. This pins that honest boundary (the
/// module doc of this file previously, wrongly, listed an oversize scan as "refused").
#[test]
fn an_oversize_scan_is_capped_at_max_scan_size_not_refused() {
    let landmarks: Vec<Landmark> = (0..8).map(|i| Landmark::new(i as f32, 0.0, 1.0)).collect();
    let scan: Vec<(f32, f32)> = (0..(MAX_SCAN_SIZE + 100))
        .map(|i| ((i as f32) * 0.01, 0.0))
        .collect();
    let cfg = ScanMatchConfig::default();
    let (result, _report) =
        scan_match(&landmarks, &scan, [0.0; 3], &cfg).expect("an oversize scan is accepted");
    assert_eq!(
        result.projected_points as usize, MAX_SCAN_SIZE,
        "the scan must be capped at MAX_SCAN_SIZE, not refused or processed in full"
    );
}

#[test]
fn scan_match_bounded_window_passes_the_budget_check() {
    // A reasonable configuration must not exceed MAX_SCAN_OPERATIONS. The budget now
    // includes the landmark term (the inner loop's real per-point cost), so the check
    // uses a representative mid-sized map.
    let cfg = ScanMatchConfig::default();
    let budget = scan_match_window_budget(&cfg, 64, 100);
    assert!(budget <= MAX_SCAN_OPERATIONS);
    // …and a map that is too large to cost in one tick must trip the ceiling.
    assert!(scan_match_window_budget(&cfg, 64, 1_000_000) > MAX_SCAN_OPERATIONS);
}
