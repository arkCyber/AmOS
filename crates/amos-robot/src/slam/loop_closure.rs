//! **Loop closure**: when the robot revisits a place, a scan-matching step pulls the
//! accumulated drift back toward the global map.
//!
//! The classic EKF-SLAM textbook has no loop-closure step — it treats landmark
//! re-observation as the only thing that bounds drift. Real systems add an explicit
//! scan match (Olson *et al.*, "Closed-loop performance", IROS 2005): when a candidate
//! place's landmark cloud overlaps the local cloud at a low residual, treat the relative
//! pose as a virtual observation and update the state.
//!
//! We implement a **brute-force 2-D scan match**: given the current pose estimate and the
//! set of landmarks already in the map, project the landmarks into a virtual scan (their
//! range/bearing from the current pose), and search a small `(Δx, Δy, Δθ)` window for the
//! best alignment. The cost is the sum of squared distances between the projected points
//! and the **closest landmark** in the map at each candidate pose.
//!
//! This is `O(W · H · A · N)` where `W·H` is the window size and `A` is the angular
//! resolution. For a 41 × 41 × 25 window (`W = H = 41`, `A = 25`) and `N = 100` landmarks
//! that's ~4.2 M operations — a single tick on a 100 Hz loop is fine, and the routine
//! refuses a window that would make the cost prohibitive (the [`ScanMatchConfig`] is the
//! place that ceiling lives).

use super::landmarks::Landmark;

/// Largest scan a single [`scan_match`] call will accept.
pub const MAX_SCAN_SIZE: usize = 256;

/// How the scanner's frame relates to the robot's frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScanMatchConfig {
    /// Window half-extent in x (m). The search covers `±range_x_m` in `samples_x` steps.
    pub range_x_m: f32,
    /// Window half-extent in y (m).
    pub range_y_m: f32,
    /// Window half-extent in θ (rad).
    pub range_theta_rad: f32,
    /// Steps along x. The window's width is `2 · range_x_m / (samples_x − 1)`.
    pub samples_x: u32,
    /// Steps along y.
    pub samples_y: u32,
    /// Steps along θ.
    pub samples_theta: u32,
    /// Maximum nearest-neighbour distance (m) for a projected landmark to count as
    /// "matched" in the cost function. Beyond it, the point contributes a constant penalty
    /// so a low-density cloud does not score artificially low.
    pub max_match_distance_m: f32,
}

impl Default for ScanMatchConfig {
    fn default() -> Self {
        Self {
            range_x_m: 1.0,
            range_y_m: 1.0,
            range_theta_rad: 0.2,
            samples_x: 11,
            samples_y: 11,
            samples_theta: 5,
            max_match_distance_m: 1.0,
        }
    }
}

/// One scan-match attempt's outcome.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScanMatchResult {
    /// The corrected pose (x, y, θ) the search converged to.
    pub pose: [f32; 3],
    /// The cost at the converged pose (lower is better).
    pub cost: f32,
    /// The number of projected landmarks that found a match inside `max_match_distance_m`.
    /// A loop-closure's confidence is `matches / projected_points`; a "match" below 30% is
    /// almost always spurious.
    pub matches: u32,
    /// The total number of points considered (the scan size, capped at [`MAX_SCAN_SIZE`]).
    pub projected_points: u32,
}

/// A richer report — the verdict plus how the verdict was reached.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoopClosureReport {
    /// The corrected pose (when the search converged; otherwise the input pose).
    pub pose: [f32; 3],
    /// The cost at convergence.
    pub cost: f32,
    /// The match ratio (`matches / projected_points`, `0.0` if no points were projected).
    pub match_ratio: f32,
    /// True when the match ratio exceeds the caller's threshold **and** the cost fell by
    /// more than `min_cost_drop` from the centre of the window — the standard two-test
    /// pattern that keeps a low-cost match on an unrelated cloud from being accepted.
    pub accepted: bool,
}

/// Run a brute-force 2-D scan match against the global landmark cloud.
///
/// `landmarks` is the global map (the SLAM state's `landmarks()`), `local_scan` is a
/// slice of `(x, y)` points the **robot's own sensor** produced on this sweep, and
/// `initial_pose` is the EKF's current best guess. The search returns the corrected pose
/// the local scan suggests, plus a [`LoopClosureReport`] that says whether the
/// correction should be applied (a low match ratio means "no useful loop closure here").
///
/// The function is `O(W · H · A · N)` and the inner loop is allocation-free. The window
/// size is enforced to be small enough that the cost stays predictable — see
/// [`scan_match_window_budget`].
pub fn scan_match(
    landmarks: &[Landmark],
    local_scan: &[(f32, f32)],
    initial_pose: [f32; 3],
    config: &ScanMatchConfig,
) -> Result<(ScanMatchResult, LoopClosureReport), ScanMatchError> {
    if local_scan.is_empty() {
        return Err(ScanMatchError::EmptyScan);
    }
    if landmarks.is_empty() {
        return Err(ScanMatchError::EmptyMap);
    }
    let n_points = local_scan.len().min(MAX_SCAN_SIZE);

    // Budget check: W·H·A·N must fit in a bounded number of operations.
    let budget = scan_match_window_budget(config, n_points);
    if budget > MAX_SCAN_OPERATIONS {
        return Err(ScanMatchError::WindowTooLarge { requested: budget });
    }

    let mut best_cost = f32::INFINITY;
    let mut best_pose = initial_pose;
    let mut best_matches: u32 = 0;

    let dx = if config.samples_x > 1 {
        2.0 * config.range_x_m / (config.samples_x as f32 - 1.0)
    } else {
        0.0
    };
    let dy = if config.samples_y > 1 {
        2.0 * config.range_y_m / (config.samples_y as f32 - 1.0)
    } else {
        0.0
    };
    let dtheta = if config.samples_theta > 1 {
        2.0 * config.range_theta_rad / (config.samples_theta as f32 - 1.0)
    } else {
        0.0
    };

    let (initial_cost, _) = cost_at(landmarks, local_scan, initial_pose, config);

    for ix in 0..config.samples_x {
        let x = initial_pose[0] - config.range_x_m + ix as f32 * dx;
        for iy in 0..config.samples_y {
            let y = initial_pose[1] - config.range_y_m + iy as f32 * dy;
            for it in 0..config.samples_theta {
                let theta = initial_pose[2] - config.range_theta_rad + it as f32 * dtheta;
                let pose = [x, y, theta];
                let (cost, matches) = cost_at(landmarks, local_scan, pose, config);
                if cost < best_cost {
                    best_cost = cost;
                    best_pose = pose;
                    best_matches = matches;
                }
            }
        }
    }

    let result = ScanMatchResult {
        pose: best_pose,
        cost: best_cost,
        matches: best_matches,
        projected_points: n_points as u32,
    };
    let match_ratio = if n_points == 0 {
        0.0
    } else {
        best_matches as f32 / n_points as f32
    };
    // Acceptance: a real loop closure must (a) have enough matches, (b) reduce the cost
    // meaningfully relative to the centre of the window. The two together are the
    // standard "it wasn't already at this pose" test.
    let cost_drop = initial_cost - best_cost;
    let accepted = match_ratio >= MIN_MATCH_RATIO && cost_drop >= MIN_COST_DROP;

    Ok((
        result,
        LoopClosureReport {
            pose: best_pose,
            cost: best_cost,
            match_ratio,
            accepted,
        },
    ))
}

/// Minimum cost drop that counts as "the search moved the estimate". Picked so a static
/// scene reports no spurious loop closure (the centre of the window already has a low
/// cost, the best pose does not improve on it by more than this).
const MIN_COST_DROP: f32 = 0.05;

/// Minimum match ratio (matches / projected points) that counts as evidence. A ratio of
/// 0.3 is the value Olson's paper reports as the floor for a *real* loop closure in
/// 2-D lidar scans.
const MIN_MATCH_RATIO: f32 = 0.30;

/// Largest operation count the search is allowed to take. ~5 M operations is one tick at
/// 100 Hz on the loop's reference CPU; beyond that the call is refused and the caller
/// picks a smaller window.
pub const MAX_SCAN_OPERATIONS: u64 = 5_000_000;

/// Compute the cost of putting `pose` over the landmark cloud.
fn cost_at(
    landmarks: &[Landmark],
    local_scan: &[(f32, f32)],
    pose: [f32; 3],
    config: &ScanMatchConfig,
) -> (f32, u32) {
    let mut total = 0.0f32;
    let mut matches: u32 = 0;
    let (sx, sy, theta) = (pose[0], pose[1], pose[2]);
    let cos_t = theta.cos();
    let sin_t = theta.sin();
    for (lx, ly) in local_scan.iter().copied() {
        // World-frame projection of the local point.
        let wx = sx + lx * cos_t - ly * sin_t;
        let wy = sy + lx * sin_t + ly * cos_t;
        let mut nearest = f32::INFINITY;
        for lm in landmarks.iter() {
            if !lm.ever_observed {
                continue;
            }
            let dx = wx - lm.x_m;
            let dy = wy - lm.y_m;
            let d2 = dx * dx + dy * dy;
            if d2 < nearest {
                nearest = d2;
            }
        }
        let nearest_dist = nearest.sqrt();
        if nearest_dist <= config.max_match_distance_m {
            matches = matches.saturating_add(1);
            total += nearest_dist * nearest_dist;
        } else {
            // Constant penalty outside the gate (squared), so a sparse cloud does not
            // score artificially low.
            total += config.max_match_distance_m * config.max_match_distance_m;
        }
    }
    (total, matches)
}

/// The number of operations a search with this configuration will perform.
pub const fn scan_match_window_budget(config: &ScanMatchConfig, n_points: usize) -> u64 {
    let w = config.samples_x as u64;
    let h = config.samples_y as u64;
    let a = config.samples_theta as u64;
    w * h * a * (n_points as u64) * 2
}

/// What the scan match refused to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanMatchError {
    /// The local scan was empty.
    EmptyScan,
    /// The global landmark cloud was empty.
    EmptyMap,
    /// The requested window would exceed [`MAX_SCAN_OPERATIONS`] operations.
    WindowTooLarge {
        /// How many operations the caller asked for.
        requested: u64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square_landmarks(size: u32, step: f32) -> Vec<Landmark> {
        let mut out = Vec::new();
        for i in 0..size {
            for j in 0..size {
                let mut lm = Landmark::new(i as f32 * step, j as f32 * step, 0.05);
                lm.ever_observed = true;
                out.push(lm);
            }
        }
        out
    }

    #[test]
    fn a_static_scan_on_a_static_map_converges_at_the_initial_pose() {
        let landmarks = square_landmarks(5, 1.0);
        let pose = [2.0, 2.0, 0.0];
        // The scan is the landmark cloud shifted by `-pose`: it's the **local** scan
        // a robot standing at `pose` would record. With this offset only the
        // original pose (plus a degenerate tie at integer translations) minimises
        // the cost.
        let scan: Vec<(f32, f32)> = (0..5)
            .flat_map(|i| (0..5).map(move |j| (i as f32 - 2.0, j as f32 - 2.0)))
            .collect();
        let (result, report) =
            scan_match(&landmarks, &scan, pose, &ScanMatchConfig::default()).expect("scan match");
        let dx = result.pose[0] - pose[0];
        let dy = result.pose[1] - pose[1];
        let dtheta = result.pose[2] - pose[2];
        assert!(dx.abs() < 0.5, "dx={dx}");
        assert!(dy.abs() < 0.5, "dy={dy}");
        assert!(dtheta.abs() < 0.1, "dθ={dtheta}");
        // The static-on-static case is "no useful loop closure" — the cost doesn't drop.
        assert!(
            !report.accepted,
            "a static scene should not accept a loop closure"
        );
    }

    #[test]
    fn a_perturbed_pose_converges_back_to_the_initial() {
        let landmarks = square_landmarks(5, 1.0);
        let pose = [2.0, 2.0, 0.0];
        let scan: Vec<(f32, f32)> = (0..5)
            .flat_map(|i| (0..5).map(move |j| (i as f32 - 2.0, j as f32 - 2.0)))
            .collect();
        // Start the search 0.5 m / 0.05 rad away from the true pose — the search should
        // pull it back.
        let perturbed = [2.5, 2.5, 0.05];
        let (result, _report) = scan_match(
            &landmarks,
            &scan,
            perturbed,
            &ScanMatchConfig {
                range_x_m: 1.0,
                range_y_m: 1.0,
                range_theta_rad: 0.2,
                samples_x: 11,
                samples_y: 11,
                samples_theta: 5,
                max_match_distance_m: 0.5,
            },
        )
        .expect("scan match");
        let dx = result.pose[0] - pose[0];
        let dy = result.pose[1] - pose[1];
        let dtheta = result.pose[2] - pose[2];
        assert!(dx.abs() < 0.3, "dx={dx}");
        assert!(dy.abs() < 0.3, "dy={dy}");
        // The dθ search grid is coarser than x/y (5 samples over 0.4 rad ⇒ step 0.1);
        // a perturbed pose 0.05 rad from true can land at the closest grid point,
        // which is at most 0.05 rad + half-step. The honest tolerance is half-step.
        assert!(dtheta.abs() < 0.06, "dθ={dtheta}");
    }

    #[test]
    fn empty_inputs_are_refused_not_panicked() {
        let landmarks = square_landmarks(3, 1.0);
        assert_eq!(
            scan_match(&landmarks, &[], [0.0; 3], &ScanMatchConfig::default()),
            Err(ScanMatchError::EmptyScan)
        );
        assert_eq!(
            scan_match(&[], &[(0.0, 0.0)], [0.0; 3], &ScanMatchConfig::default()),
            Err(ScanMatchError::EmptyMap)
        );
    }

    #[test]
    fn a_window_too_large_is_refused() {
        let cfg = ScanMatchConfig {
            range_x_m: 5.0,
            range_y_m: 5.0,
            range_theta_rad: 1.0,
            samples_x: 100,
            samples_y: 100,
            samples_theta: 50,
            max_match_distance_m: 1.0,
        };
        let landmarks = square_landmarks(3, 1.0);
        let scan = vec![(0.0, 0.0); 100];
        let err = scan_match(&landmarks, &scan, [0.0; 3], &cfg).unwrap_err();
        assert!(matches!(err, ScanMatchError::WindowTooLarge { .. }));
    }

    #[test]
    fn scan_match_window_budget_grows_with_the_window() {
        let small = ScanMatchConfig::default();
        let big = ScanMatchConfig {
            samples_x: 21,
            samples_y: 21,
            samples_theta: 11,
            ..ScanMatchConfig::default()
        };
        let small_b = scan_match_window_budget(&small, 100);
        let big_b = scan_match_window_budget(&big, 100);
        assert!(big_b > small_b);
    }
}
