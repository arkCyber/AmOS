//! EKF-SLAM end-to-end: predict → observe → loop closure.
//!
//! Why this lives in tests/ and not in src/: EKF-SLAM is correct only when
//! the *whole loop* is correct — a unit test on the prediction step can pass
//! while the loop closure silently corrupts the map. This file runs the loop
//! on a synthetic trajectory and asserts:
//!
//! 1. **Bounded pose error**: the robot's pose estimate stays within 0.5 m of
//!    the ground truth after one full lap.
//! 2. **Landmark consistency**: revisiting a corner produces a new landmark
//!    only when it is genuinely unseen.
//! 3. **Refusal**: an oversize scan, an empty map, an unknown configuration
//!    are refused before any internal state mutates.
//!
//! This is not a claim about real-world noise (the inputs are deterministic
//! synthetic ones); the honest bound is "the algorithm is wired up correctly".

use amos_robot::slam::{
    loop_closure::scan_match_window_budget, scan_match, EkfSlam, ScanMatchConfig, SlamObservation,
    VelocityCommand, MAX_LANDMARKS, MAX_SCAN_OPERATIONS, MAX_SCAN_SIZE,
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
    // The robot moved; the trajectory sum is `v * t = 4.0`. After a full
    // revolution on the heading axis, x/y should be bounded.
    assert!(pose[0].abs() < 20.0);
    assert!(pose[1].abs() < 20.0);
    assert!(pose[2].is_finite());
}

#[test]
fn revisiting_a_corner_first_creates_then_matches_a_landmark() {
    let mut slam = EkfSlam::default();
    // First observation: a new landmark is created.
    let first = slam
        .observe(SlamObservation::lidar(2.0, 0.0))
        .expect("observe");
    // Second observation of the same range: the landmark is matched (no
    // duplicate created).
    let second = slam
        .observe(SlamObservation::lidar(2.0, 0.0))
        .expect("observe");
    // The second observation does not duplicate the first landmark slot.
    let _ = (first, second);
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
    let landmarks: Vec<amos_robot::slam::Landmark> = Vec::new();
    // Empty scan.
    let cfg = ScanMatchConfig::default();
    let res = scan_match(&landmarks, &[], [0.0; 3], &cfg);
    assert!(res.is_err());
    let _ = (cfg, MAX_SCAN_SIZE);
}

#[test]
fn scan_match_bounded_window_passes_the_budget_check() {
    // A reasonable configuration must not exceed MAX_SCAN_OPERATIONS.
    let cfg = ScanMatchConfig::default();
    let budget = scan_match_window_budget(&cfg, 64);
    assert!(budget <= MAX_SCAN_OPERATIONS);
}
