//! The join between EKF-SLAM and Monte Carlo localization: the map one builds is localized
//! against by the other.
//!
//! Why this lives in tests/ and not in src/: `tests/slam_e2e.rs` proves the EKF builds a
//! consistent landmark map, and `localization.rs`'s own unit tests prove the particle filter
//! recovers a pose **on a map it was handed** — but neither proves the two *meet*. The
//! `localization` module doc claims the flow ("it consumes a [`Landmark`] cloud … read out of
//! a SLAM run"), and before this file no code performed it: `McLocalizer` had no consumer
//! outside its own unit tests, and the citation named `EkfSlam` — which exposes **no**
//! landmark accessor. The slice lives on `SlamState::landmarks`; that is the type this file
//! drives, and that is the correction the module doc now records.
//!
//! Four claims, each about the *seam* rather than about either half alone:
//!
//! 1. **The map crosses.** A `SlamState`'s landmark slice, cloned out through the public
//!    accessor, is accepted by `McLocalizer::new` verbatim.
//! 2. **The frames agree.** Seeded at the pose the SLAM map was built from and fed readings
//!    taken there, the filter *holds* that pose. This is the load-bearing claim: were the
//!    SLAM map in a different frame, unit or bearing convention than the filter's
//!    measurement model, the update would drag the estimate off truth. The scanner rides at
//!    [`SENSOR_OFFSET`] — non-zero on both axes, read at a non-zero heading — so the claim
//!    covers the body-to-world offset rotation both halves apply, not just the heading term.
//! 3. **The refusal crosses.** An empty SLAM map (a state that has observed nothing) is
//!    refused by the localizer with its own `EmptyMap`, not accepted as a filter that can
//!    never converge.
//! 4. **The seams' bounds are stated.** The EKF may build more landmarks than the localizer
//!    accepts, so that boundary is pinned and the refusal is checked to name the count.
//!
//! Claim 2's assertion is guarded by an in-suite **negative control**
//! (`a_far_off_map_is_reported_lost_not_held`): the same fixture, with the map moved far
//! from where the readings were taken, must report *lost* rather than hold the pose — so
//! claim 2 cannot pass by ignoring the map it was handed.

use amos_robot::slam::{
    Landmark, SlamControl, SlamObservation, SlamState, VelocityCommand, MAX_LANDMARKS,
};
use amos_robot::{
    LocalizationError, LocalizationHealth, McControl, McLocalizer, MATCH_QUALITY_FLOOR,
};

/// The pose the robot occupies while it surveys: a non-trivial heading, so a map in the wrong
/// orientation cannot pass by accident.
const TRUE_POSE: [f32; 3] = [2.0, 1.5, 0.4];

/// The five world-frame landmarks the robot observes. Deliberately **asymmetric** — no
/// rotation or reflection of this set maps onto itself — so a 180°-flipped or mirrored
/// belief cannot explain the same readings (contrast the symmetric `square_map` in
/// `localization.rs`'s unit tests, which converges to a rotated *image* of the truth).
const LANDMARKS: [(f32, f32); 5] = [
    (0.0, 0.0),
    (8.0, 2.0),
    (5.0, 9.0),
    (-3.0, 6.0),
    (-7.0, -4.0),
];

/// Where the scanner sits in the robot's body frame. Deliberately non-zero on **both** axes
/// and read at a non-zero heading, so the join exercises the body-to-world rotation
/// `ox·cosθ − oy·sinθ`, `ox·sinθ + oy·cosθ` that both halves apply. With a centre-mounted
/// sensor (as an earlier revision of this file had) the cross terms vanish and the join
/// would agree about a rotation neither half was actually performing — the crate's only
/// other offset tests pass `oy = 0` at heading `0`, where that rotation is the identity.
const SENSOR_OFFSET: (f32, f32) = (0.35, -0.20);

/// A fixed, hand-written sensor perturbation, one entry per landmark: a near-truth reading
/// is required, but an *exactly* noiseless one makes the likelihood a delta and collapses
/// the weights onto a single particle (the module's boundary 9), so each reading is nudged
/// by a fraction of a sigma. A table rather than an RNG draw, so the test has no seed to pin
/// and no `rand` dependency.
const SENSOR_OFFSETS: [(f32, f32); 5] = [
    (0.020, 0.0040),
    (-0.010, -0.0030),
    (0.015, 0.0020),
    (-0.020, 0.0050),
    (0.005, -0.0040),
];

/// Wrap to `[-π, π]`, matching the filter's own convention so a bearing difference is
/// measured the short way round.
fn wrap(a: f32) -> f32 {
    let tau = 2.0 * std::f32::consts::PI;
    let mut r = a % tau;
    if r > std::f32::consts::PI {
        r -= tau;
    } else if r < -std::f32::consts::PI {
        r += tau;
    }
    r
}

/// The range/bearing each landmark presents to the scanner, in the EKF's own convention:
/// range from the sensor, bearing relative to the robot's heading. The sensor sits at
/// [`SENSOR_OFFSET`] in the body frame, so its world position is the robot's rotated by the
/// heading. `offsets` perturbs each reading (pass zeros for the noiseless survey).
fn readings_from(pose: [f32; 3], offsets: &[(f32, f32); 5]) -> Vec<SlamObservation> {
    let (ox, oy) = SENSOR_OFFSET;
    let (cos_t, sin_t) = (pose[2].cos(), pose[2].sin());
    let sx = pose[0] + ox * cos_t - oy * sin_t;
    let sy = pose[1] + ox * sin_t + oy * cos_t;
    LANDMARKS
        .iter()
        .zip(offsets)
        .map(|(&(lx, ly), &(dr, db))| {
            let dx = lx - sx;
            let dy = ly - sy;
            let range = dx.hypot(dy) + dr;
            let bearing = wrap(wrap(dy.atan2(dx) - pose[2]) + db);
            let mut o = SlamObservation::lidar(range, bearing);
            o.sensor_offset_x_m = ox;
            o.sensor_offset_y_m = oy;
            o
        })
        .collect()
}

/// Drive a `SlamState` from the true pose, observing every landmark several times, and
/// return the state plus its landmark map cloned out through the public accessor — the
/// exact slice a downstream localizer would be handed.
fn build_slam_map() -> (SlamState, Vec<Landmark>) {
    let mut state = SlamState::with_pose(TRUE_POSE, 0.05, 0.05);
    let control = SlamControl::default();
    let survey = readings_from(TRUE_POSE, &[(0.0, 0.0); 5]);
    // Observe the stationary survey several times: the first sighting *creates* each landmark
    // at the predicted position with a wide prior, and the repeats pull it onto the reading.
    for _ in 0..8 {
        for obs in &survey {
            state
                .observe(*obs, &control)
                .expect("the survey observation is well-formed");
        }
    }
    let map = state.landmarks().to_vec();
    (state, map)
}

/// Claim 1 — the map crosses the boundary. The landmark slice a SLAM run exposes is accepted
/// by `McLocalizer::new` verbatim, and the filter reports the count the EKF reported.
#[test]
fn a_slam_run_hands_its_landmarks_to_the_localizer() {
    let (state, map) = build_slam_map();
    assert_eq!(
        state.num_landmarks(),
        LANDMARKS.len(),
        "the stationary survey must create exactly one landmark per observed point"
    );
    assert!(
        map.iter().all(|l| l.ever_observed),
        "every landmark in a map a localizer is meant to trust must have been observed"
    );

    let localizer =
        McLocalizer::new(map, McControl::default()).expect("a SLAM-built map is a valid map");
    assert_eq!(
        localizer.map_len(),
        state.num_landmarks(),
        "the localizer must hold every landmark the EKF published, none dropped"
    );
}

/// Claim 2 — the frames agree. The filter, seeded at the pose the map was built from and fed
/// readings taken there, holds that pose. If the SLAM map disagreed with the filter's
/// measurement model in frame, unit or bearing convention, the weighted update would pull
/// the estimate away from truth and this would fail.
///
/// The estimate is asserted, **not** `health`: the readings here are near-noiseless, so the
/// likelihood is nearly a delta and `match_quality` plummets even though the pose is right
/// (the module's boundary 9). That is a property of the fixture, not of the join.
#[test]
fn the_localizer_holds_the_pose_the_slam_map_was_built_from() {
    let (_, map) = build_slam_map();
    let mut localizer = McLocalizer::new_at(
        map,
        McControl::default(),
        TRUE_POSE[0],
        TRUE_POSE[1],
        TRUE_POSE[2],
        0.15,
        0.15,
    )
    .expect("a tight seed around a finite pose is valid");

    // The robot is stationary: read, update, repeat. No `predict`, so the belief is refined
    // in place rather than propagated.
    let readings = readings_from(TRUE_POSE, &SENSOR_OFFSETS);
    for _ in 0..8 {
        localizer
            .update(&readings)
            .expect("the readings are well-formed");
    }

    let est = localizer.estimate();
    let dx = est.x_m - TRUE_POSE[0];
    let dy = est.y_m - TRUE_POSE[1];
    let dtheta = wrap(est.theta_rad - TRUE_POSE[2]);
    // Tolerances are measured, not asserted from the theory: the seed `sigma` is 0.15 m and
    // 0.15 rad, and the filter must stay well inside it.
    assert!(
        dx.abs() < 0.15 && dy.abs() < 0.15,
        "the localizer must hold the pose the map was built from, got ({}, {}) vs ({}, {})",
        est.x_m,
        est.y_m,
        TRUE_POSE[0],
        TRUE_POSE[1]
    );
    assert!(
        dtheta.abs() < 0.12,
        "the heading must hold too, off by {} rad",
        dtheta
    );
}

/// The **negative control** for claim 2. The identical fixture, with every landmark shifted
/// far from where the readings were taken, must report the belief *lost* rather than hold the
/// pose: the same code path that holds truth against a consistent map rejects an inconsistent
/// one. If claim 2 were passing by ignoring its map argument, this would pass too and claim 2
/// would be vacuous.
#[test]
fn a_far_off_map_is_reported_lost_not_held() {
    let (_, honest) = build_slam_map();
    // The same map, translated 50 m — far beyond any plausible pose error, so no particle
    // explains the readings and every one is equally hopeless.
    let shifted: Vec<Landmark> = honest
        .iter()
        .map(|l| Landmark::new(l.x_m + 50.0, l.y_m + 50.0, 1.0))
        .collect();

    let mut localizer = McLocalizer::new_at(
        shifted,
        McControl::default(),
        TRUE_POSE[0],
        TRUE_POSE[1],
        TRUE_POSE[2],
        0.15,
        0.15,
    )
    .expect("a tight seed around a finite pose is valid");
    let readings = readings_from(TRUE_POSE, &SENSOR_OFFSETS);
    for _ in 0..8 {
        localizer
            .update(&readings)
            .expect("the readings are well-formed");
    }

    let est = localizer.estimate();
    assert!(
        est.match_quality < MATCH_QUALITY_FLOOR,
        "a map 50 m from the readings must not explain them, got match_quality {}",
        est.match_quality
    );
    assert_eq!(
        est.health,
        LocalizationHealth::Diverged,
        "the belief must be reported lost, not held at truth"
    );
}

/// Claim 3 — the refusal crosses. A `SlamState` that has observed nothing publishes an empty
/// map, and the localizer refuses it with its own error rather than accepting a filter that
/// can never weight a particle.
#[test]
fn an_empty_slam_map_is_refused_by_the_localizer() {
    let mut state = SlamState::new();
    // A `predict` alone maps nothing: it moves the pose and leaves the landmark list empty.
    state
        .predict(
            VelocityCommand {
                linear_m_s: 1.0,
                angular_rad_s: 0.0,
                dt_s: 0.05,
            },
            &SlamControl::default(),
        )
        .expect("a well-formed predict");
    assert_eq!(
        state.num_landmarks(),
        0,
        "a predict with no observations must not invent landmarks"
    );

    let handed = state.landmarks().to_vec();
    let refused = McLocalizer::new(handed, McControl::default())
        .expect_err("an unmapped SLAM state must be refused at the seam");
    assert_eq!(
        refused,
        LocalizationError::EmptyMap,
        "the refusal must be EmptyMap, not a filter that can never weight a particle"
    );
}

/// Claim 4 — the two ceilings disagree, and the seam must say so.
///
/// `slam::MAX_LANDMARKS` (512) is larger than `localization::MAX_LOCALIZATION_LANDMARKS`
/// (256), so a SLAM map the EKF is *allowed* to build can be **refused** by the localizer
/// it is meant to feed. The two bounds are deliberate and belong to different quantities —
/// the EKF's caps its *state size* (`3 + 2·L`, a covariance that grows as `L²`), the
/// localizer's caps its *per-step work* (`O(N · Z · L)` likelihood evaluations) — so the fix
/// is not to raise one to meet the other; it is to make the seam's contract explicit. This
/// pins all three facts (the ordering, the refusal, and the error) so a future change to
/// either constant has to come here and decide.
#[test]
fn an_oversized_slam_map_is_refused_at_the_seam() {
    // The ordering that creates the gap, checked at **compile** time: if either bound ever
    // moves past the other this file stops building, which is louder than a red test and
    // cannot be skipped. If the bounds do agree again, the boundary note in `localization`
    // is obsolete and this assert is what says so.
    const _: () = assert!(
        MAX_LANDMARKS > amos_robot::MAX_LOCALIZATION_LANDMARKS,
        "the bounds now agree: revisit the localization boundary note"
    );

    // One past the localizer's ceiling: refused, and it says by how much.
    let oversized: Vec<Landmark> = (0..=amos_robot::MAX_LOCALIZATION_LANDMARKS)
        .map(|i| Landmark::new(i as f32, 0.0, 1.0))
        .collect();
    let refused = McLocalizer::new(oversized, McControl::default())
        .expect_err("a map at the EKF's ceiling is above the localizer's");
    assert_eq!(
        refused,
        LocalizationError::TooManyLandmarks {
            given: amos_robot::MAX_LOCALIZATION_LANDMARKS + 1
        },
        "the refusal must name the count, so a caller knows how much to trim"
    );
}
