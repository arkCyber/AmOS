//! **Loop closure**: when the robot revisits a place, a scan-matching step pulls the
//! accumulated drift back toward the global map.
//!
//! The classic EKF-SLAM textbook has no loop-closure step — it treats landmark
//! re-observation as the only thing that bounds drift. Real systems add an explicit scan
//! match — the idea is Olson's, *Real-Time Correlative Scan Matching* (ICRA 2009), which
//! also names global loop closing as its motivating use — and when a candidate place's
//! landmark cloud overlaps the local cloud at a low residual, the relative pose is treated
//! as a virtual observation and updates the state.
//!
//! An earlier revision of this paragraph cited "Olson *et al.*, 'Closed-loop performance',
//! IROS 2005". No such paper exists: Olson's scan-matching paper is a single-author ICRA
//! 2009 paper with that title, and the "loop closure" part of it is an application, not the
//! title. The wrong citation is called out here rather than quietly swapped, because a
//! fabricated reference is indistinguishable from a real one to every later reader.
//!
//! The two acceptance thresholds (`MIN_MATCH_RATIO`, `MIN_COST_DROP`) are **this crate's
//! policy**, not figures taken from that (or any other) paper — see their own docs. (Both
//! are private `const`s, so their names are plain code here rather than intra-doc links:
//! rustdoc refuses a public page that links to a private item.)
//!
//! We implement a **brute-force 2-D scan match**: given the current pose estimate and the
//! set of landmarks already in the map, project the landmarks into a virtual scan (their
//! range/bearing from the current pose), and search a small `(Δx, Δy, Δθ)` window for the
//! best alignment. The cost is the sum of squared distances between the projected points
//! and the **closest landmark** in the map at each candidate pose.
//!
//! The cost is `O(W · H · A · N_points · N_landmarks)`: for each of the `W·H·A` candidate
//! poses, each of the (capped) scan points pays a full nearest-neighbour pass over the
//! landmark cloud. The `N_points` factor is easy to forget and it dominates — for the
//! [`ScanMatchConfig::default`] (11 × 11 × 5 = 605 poses) over a 50-point scan and a
//! 100-landmark map it is ~3.0 M operations, one tick at 100 Hz; a 41 × 41 × 25 window
//! over a 256-point scan and the same map is ~1.1 **billion**, and the routine refuses it.
//! [`scan_match_window_budget`] computes the number and [`MAX_SCAN_OPERATIONS`] is the
//! ceiling it is checked against, so the refusal is a number, not a guess.

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
    /// Steps along x, covering `±range_x_m` — so the step between candidates is
    /// `2 · range_x_m / (samples_x − 1)` (the *width* of the window is `2 · range_x_m`).
    /// Must be `>= 1`; `0` is refused by [`scan_match`] as
    /// [`ScanMatchError::DegenerateWindow`]. A value of `1` is legal and means a zero-width
    /// window **at the initial pose** — the single candidate is `initial_pose[0]`, not the
    /// window's lower corner (see the private helper `axis_offset`).
    pub samples_x: u32,
    /// Steps along y — see [`ScanMatchConfig::samples_x`]. Must be `>= 1`.
    pub samples_y: u32,
    /// Steps along θ — see [`ScanMatchConfig::samples_x`]. Must be `>= 1`.
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
    /// True when the match ratio is at least `MIN_MATCH_RATIO` **and** the cost fell by at
    /// least `MIN_COST_DROP` from the centre of the window. Both thresholds are `const`s in
    /// this module, not caller-supplied: the standard two-test pattern that keeps a
    /// low-cost match on an unrelated cloud from being accepted. (Note the cost test is
    /// against the **centre** of the window, i.e. `initial_pose`, not the best pose's
    /// neighbours — so "the search found nothing better than where we already were" reads
    /// as `accepted == false`.)
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
/// The function is `O(W · H · A · N_points · N_landmarks)` and the inner loop is
/// allocation-free. The window size is enforced to be small enough that the cost stays
/// predictable — see [`scan_match_window_budget`].
pub fn scan_match(
    landmarks: &[Landmark],
    local_scan: &[(f32, f32)],
    initial_pose: [f32; 3],
    config: &ScanMatchConfig,
) -> Result<(ScanMatchResult, LoopClosureReport), ScanMatchError> {
    // A malformed configuration is refused before anything else. Without this, a non-finite
    // `range_*` makes every candidate pose non-finite, every cost `NaN`, and the routine
    // returns `Ok` with an *infinite* cost and the input pose — an answer that looks like a
    // successful search and is actually a search that compared nothing. A negative
    // half-extent is refused for the same reason the field is called a half-extent: it
    // mirrors the window instead of sizing it.
    if !config.range_x_m.is_finite()
        || !config.range_y_m.is_finite()
        || !config.range_theta_rad.is_finite()
        || config.range_x_m < 0.0
        || config.range_y_m < 0.0
        || config.range_theta_rad < 0.0
        || !config.max_match_distance_m.is_finite()
        || config.max_match_distance_m < 0.0
    {
        return Err(ScanMatchError::InvalidConfig);
    }
    if local_scan.is_empty() {
        return Err(ScanMatchError::EmptyScan);
    }
    if landmarks.is_empty() {
        return Err(ScanMatchError::EmptyMap);
    }
    // A zero sample count on any axis means the triple loop never runs: no cost is ever
    // computed, and the routine would return `Ok` with the input pose and an infinite cost
    // — a successful-looking answer for a search that considered nothing. Refuse it.
    if config.samples_x == 0 || config.samples_y == 0 || config.samples_theta == 0 {
        return Err(ScanMatchError::DegenerateWindow);
    }
    let n_points = local_scan.len().min(MAX_SCAN_SIZE);
    // Only the first `MAX_SCAN_SIZE` points are ever considered. Slicing here (rather
    // than leaving `cost_at` to iterate the full input) keeps `matches ≤ n_points`, so
    // `match_ratio` cannot exceed 1.0, and makes `projected_points` the count that was
    // actually costed.
    let scan = &local_scan[..n_points];

    // Budget check: W·H·A candidate poses × N_points × N_landmarks must fit in a bounded
    // number of operations — the landmark term is what the inner loop actually pays per
    // point, so leaving it out would let a big map walk past the guard.
    let budget = scan_match_window_budget(config, n_points, landmarks.len());
    if budget > MAX_SCAN_OPERATIONS {
        return Err(ScanMatchError::WindowTooLarge { requested: budget });
    }

    let mut best_cost = f32::INFINITY;
    let mut best_pose = initial_pose;
    let mut best_matches: u32 = 0;

    let (initial_cost, _) = cost_at(landmarks, scan, initial_pose, config);

    for ix in 0..config.samples_x {
        let x = initial_pose[0] + axis_offset(config.range_x_m, config.samples_x, ix);
        for iy in 0..config.samples_y {
            let y = initial_pose[1] + axis_offset(config.range_y_m, config.samples_y, iy);
            for it in 0..config.samples_theta {
                let theta =
                    initial_pose[2] + axis_offset(config.range_theta_rad, config.samples_theta, it);
                let pose = [x, y, theta];
                let (cost, matches) = cost_at(landmarks, scan, pose, config);
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

/// Minimum cost drop that counts as "the search moved the estimate". A static scene
/// already has a low cost at the centre of the window, so the best candidate cannot beat
/// it by much; requiring a drop keeps that case from reading as a loop closure.
/// **This is a policy choice, not a measurement** — the unit is the summed squared
/// match distance from `cost_at`, so it does not convert to metres. Raise it for a
/// noisier cloud.
const MIN_COST_DROP: f32 = 0.05;

/// Minimum match ratio (matches / projected points) that counts as evidence.
///
/// // chosen: **this crate's policy, not a figure quoted from a paper.** An earlier revision
/// claimed `0.3` was "the value Olson's paper reports as the floor for a real loop closure in
/// 2-D lidar scans"; Olson's scan-matching paper gives no such number, so the attribution was
/// removed rather than kept as an unverifiable citation. The reasoning for `0.3` stands on its
/// own: a spurious alignment between two unrelated point clouds still finds *some* nearest
/// neighbour within [`ScanMatchConfig::max_match_distance_m`] for a sizeable minority of
/// points, and a real revisit — where the local scan was produced by the same structure the
/// map holds — puts most points well inside the gate. `0.3` sits between those two regimes
/// with margin on both sides. It is a policy threshold: a sparse or noisy cloud needs a
/// lower one, a dense clean one can afford higher.
const MIN_MATCH_RATIO: f32 = 0.30;

/// Largest operation count the search is allowed to take.
///
/// The bound exists so that one `scan_match` cannot monopolise a control tick. Its size is
/// **arithmetic about a bound, not a measurement**: 5 M operations at roughly 1 ns per
/// inner-loop iteration on a contemporary 64-bit CPU is about **5 ms**, i.e. *half* of a
/// 10 ms (100 Hz) tick — not the "small fraction" an earlier revision of this comment
/// claimed. And 1 ns understates it: the inner iteration is a compare, two subtractions, two
/// multiplications and an add, plus a `sqrt` per *point*. So treat 5 ms as a floor, not an
/// estimate of the wall-clock cost, and note that this crate has **never timed `scan_match`
/// on any machine** — the guard's job is only to keep the operation count finite and
/// predictable, which it does exactly. A deployment with a slower CPU or a tighter tick must
/// lower this bound and measure its own. Beyond it the call is refused and the caller picks a
/// smaller window.
pub const MAX_SCAN_OPERATIONS: u64 = 5_000_000;

/// The `i`-th candidate offset along one axis: `samples` poses spanning `±range` are spaced
/// by `2·range / (samples − 1)`, so the offset is `−range + i · step`.
///
/// A **single sample is the centre** (offset `0.0`), not `−range`. There is no step to
/// divide by when `samples == 1`, and the naive `−range + i · 0` silently placed the one
/// candidate a whole `range` away from where the caller said the robot is — a "search" that
/// reports a pose the caller never asked about, and a `LoopClosureReport` whose cost drop is
/// measured against a centre that was never evaluated.
fn axis_offset(range: f32, samples: u32, i: u32) -> f32 {
    if samples > 1 {
        let step = 2.0 * range / (samples as f32 - 1.0);
        -range + i as f32 * step
    } else {
        0.0
    }
}

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
///
/// This is `W · H · A · N_points · N_landmarks`: for each of the `W·H·A` candidate poses,
/// each of the (capped) scan points pays a full nearest-neighbour pass over the landmark
/// cloud. The landmark factor is the inner loop's real cost and must be included, or the
/// ceiling does not bound anything. All multiplies saturate, so a caller passing absurd
/// sample counts gets a huge-but-finite budget that trips the guard instead of wrapping
/// below it.
pub const fn scan_match_window_budget(
    config: &ScanMatchConfig,
    n_points: usize,
    n_landmarks: usize,
) -> u64 {
    let w = config.samples_x as u64;
    let h = config.samples_y as u64;
    let a = config.samples_theta as u64;
    w.saturating_mul(h)
        .saturating_mul(a)
        .saturating_mul(n_points as u64)
        .saturating_mul(n_landmarks as u64)
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
    /// At least one of `samples_x`, `samples_y`, `samples_theta` is `0`, so the search
    /// window contains no candidate poses. Distinct from [`ScanMatchError::WindowTooLarge`]
    /// because a *smaller* window is the fix for that one, while this needs a *non-zero*
    /// sample count — and because the degenerate case would otherwise be reported as a
    /// successful match with an infinite cost (see the guard in [`scan_match`]).
    DegenerateWindow,
    /// One of the [`ScanMatchConfig`] extents is negative or not finite.
    ///
    /// A non-finite extent makes every candidate pose non-finite and every cost `NaN`; the
    /// comparison `cost < best_cost` is then false for every candidate, so the routine would
    /// return `Ok` with an infinite cost and the *input* pose — indistinguishable from "the
    /// search ran and found nothing" when in fact it compared nothing. A negative half-extent
    /// mirrors the window rather than sizing it. Both are refused here instead.
    InvalidConfig,
}

impl std::fmt::Display for ScanMatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScanMatchError::EmptyScan => write!(
                f,
                "the local scan is empty: there is nothing to align to the map"
            ),
            ScanMatchError::EmptyMap => write!(
                f,
                "the landmark cloud is empty: there is no map to align the scan against"
            ),
            ScanMatchError::WindowTooLarge { requested } => write!(
                f,
                "the search window would take {requested} operations, over the \
                 {MAX_SCAN_OPERATIONS}-operation ceiling: use a smaller window"
            ),
            ScanMatchError::DegenerateWindow => write!(
                f,
                "a sample count of 0 leaves no candidate pose to evaluate: every axis needs \
                 at least one sample"
            ),
            ScanMatchError::InvalidConfig => write!(
                f,
                "a search extent is negative or not finite: each is a half-extent (>= 0) and \
                 must be a real number"
            ),
        }
    }
}

impl std::error::Error for ScanMatchError {}

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

    /// A landmark that has never been observed carries no position evidence and must not
    /// attract a match — otherwise a fresh, uninitialised landmark at the origin would
    /// silently become the nearest neighbour for every scan point near it, inflating the
    /// match count and corrupting the cost. The map here has exactly one *observed*
    /// landmark; the unobserved twin sits exactly on the scan point and must be ignored.
    #[test]
    fn an_unobserved_landmark_never_attracts_a_match() {
        let config = ScanMatchConfig::default();
        let mut observed = Landmark::new(1.0, 0.0, 0.05);
        observed.ever_observed = true;
        let unobserved = Landmark::new(0.0, 0.0, 0.05); // `ever_observed` is false
        let map = vec![unobserved, observed];
        // The scan point projects exactly onto the *unobserved* landmark's position; only
        // the observed one 1 m away is eligible, which is a match (gate is generous).
        let (cost, matches) = cost_at(&map, &[(0.0, 0.0)], [0.0, 0.0, 0.0], &config);
        assert_eq!(matches, 1, "the observed landmark must be the one matched");
        assert!(
            (cost - 1.0).abs() < 1e-4,
            "the cost is the squared distance to the observed landmark, got {cost}"
        );
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
        // The true pose is an exact grid point of the default window (step 0.2 m / 0.1 rad),
        // and it is the *unique* minimiser: the integer-translation tie is broken because a
        // shifted cloud loses its boundary points. So the search must land on it exactly.
        assert_eq!(result.pose, pose, "the matched pose must be the true pose");
        assert_eq!(result.cost, 0.0, "the true pose has zero cost");
        assert_eq!(result.matches, 25, "all 25 scan points must match");
        // The static-on-static case is "no useful loop closure" — the cost doesn't drop.
        assert!(
            !report.accepted,
            "a static scene should not accept a loop closure"
        );
    }

    #[test]
    fn a_perturbed_pose_converges_back_to_the_initial() {
        let landmarks = square_landmarks(5, 1.0);
        let scan: Vec<(f32, f32)> = (0..5)
            .flat_map(|i| (0..5).map(move |j| (i as f32 - 2.0, j as f32 - 2.0)))
            .collect();
        // Start the search 0.5 m / 0.05 rad away from the true pose [2, 2, 0] — the search
        // should pull it back.
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
        // The 11×11×5 window is stepped at 0.2 m / 0.2 m / 0.1 rad centred on the perturbed
        // pose [2.5, 2.5, 0.05], so the grid points nearest the true pose are 2.1, 2.1 and
        // −0.05. The search must find that grid point rather than wander: the residual is
        // exactly one half-step in x/y and one half-step in θ.
        assert!(
            (result.pose[0] - 2.1).abs() < 1e-6,
            "x={} (expected the nearest grid point 2.1)",
            result.pose[0]
        );
        assert!(
            (result.pose[1] - 2.1).abs() < 1e-6,
            "y={} (expected the nearest grid point 2.1)",
            result.pose[1]
        );
        assert!(
            (result.pose[2] - (-0.05)).abs() < 1e-6,
            "θ={} (expected the nearest grid point −0.05)",
            result.pose[2]
        );
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
        let small_b = scan_match_window_budget(&small, 100, 50);
        let big_b = scan_match_window_budget(&big, 100, 50);
        assert!(big_b > small_b);
        // The landmark term must affect the budget — the old signature omitted it, so a
        // bigger map cost more without the guard noticing.
        assert!(scan_match_window_budget(&small, 100, 500) > small_b);
    }

    #[test]
    fn a_scan_larger_than_the_cap_reports_a_ratio_at_most_one() {
        // 600 points against a dense map: with the old code `cost_at` iterated the full
        // 600 while `n_points` was capped at 256, giving `match_ratio ≈ 2.34`. The ratio
        // is a confidence in [0,1] and must stay there.
        let landmarks = square_landmarks(30, 1.0);
        let scan: Vec<(f32, f32)> = (0..30)
            .flat_map(|i| (0..20).map(move |j| (i as f32 * 0.5, j as f32 * 0.5)))
            .collect();
        assert!(scan.len() > MAX_SCAN_SIZE, "fixture must exceed the cap");
        let cfg = ScanMatchConfig {
            samples_x: 1,
            samples_y: 1,
            samples_theta: 1,
            ..ScanMatchConfig::default()
        };
        let (result, report) = scan_match(&landmarks, &scan, [5.0, 5.0, 0.0], &cfg).expect("match");
        assert_eq!(
            result.projected_points as usize, MAX_SCAN_SIZE,
            "only the capped number of points is costed"
        );
        assert!(
            (0.0..=1.0).contains(&report.match_ratio),
            "match_ratio must be a confidence in [0,1], got {}",
            report.match_ratio
        );
    }

    /// A zero sample count on any axis makes the search consider no candidate pose. Before
    /// the guard this returned `Ok` with the input pose and an infinite cost — a
    /// successful-looking answer for a search that never ran. A sample count of `1` is
    /// legal (it is a zero-width window centred on the initial pose), so the boundary is
    /// pinned from both sides.
    #[test]
    fn a_degenerate_window_is_refused_but_a_single_sample_is_not() {
        let landmarks = square_landmarks(3, 1.0);
        let scan = vec![(0.0, 0.0), (1.0, 1.0)];
        let zeroed = |x, y, t| ScanMatchConfig {
            samples_x: x,
            samples_y: y,
            samples_theta: t,
            ..ScanMatchConfig::default()
        };
        for cfg in [zeroed(0, 1, 1), zeroed(1, 0, 1), zeroed(1, 1, 0)] {
            assert_eq!(
                scan_match(&landmarks, &scan, [0.0; 3], &cfg),
                Err(ScanMatchError::DegenerateWindow),
                "a zero sample count must be refused: {cfg:?}"
            );
        }
        // One sample on every axis is a degenerate *window*, not a degenerate *search*:
        // it evaluates exactly one pose, so it must still return a result.
        let initial = [1.5, -0.5, 0.25];
        let (result, report) = scan_match(&landmarks, &scan, initial, &zeroed(1, 1, 1))
            .expect("a single-sample window is legal");
        assert!(
            result.cost.is_finite(),
            "one pose was costed, so cost is finite"
        );
        // …and that one pose is the **initial pose**. The window has zero width, so the only
        // candidate is where the caller already thinks the robot is; an earlier revision
        // placed it a whole `range` away (at `initial_pose − range` on every axis), which made
        // a one-sample "search" answer with a pose the caller never asked about.
        assert_eq!(
            result.pose, initial,
            "a single-sample window must evaluate the initial pose, not the window's corner"
        );
        assert_eq!(report.pose, initial);
        // The cost drop is measured against that same pose, so it is exactly zero and the
        // closure is refused — a one-sample window can never "accept".
        assert!(
            !report.accepted,
            "a search that evaluated only the initial pose found nothing to accept"
        );
    }

    /// A malformed configuration is refused with a typed error rather than searched. Without
    /// the guard a `NaN` extent yields `Ok` with an *infinite* cost and the input pose: a
    /// result that reads as "the search ran and found nothing better" when in fact every
    /// candidate compared `NaN`.
    #[test]
    fn a_malformed_config_is_refused_not_silently_searched() {
        let landmarks = square_landmarks(3, 1.0);
        let scan = vec![(0.0, 0.0), (1.0, 1.0)];
        let base = ScanMatchConfig::default();
        let cases = [
            ScanMatchConfig {
                range_x_m: f32::NAN,
                ..base
            },
            ScanMatchConfig {
                range_y_m: f32::INFINITY,
                ..base
            },
            ScanMatchConfig {
                range_theta_rad: f32::NAN,
                ..base
            },
            ScanMatchConfig {
                range_x_m: -1.0,
                ..base
            },
            ScanMatchConfig {
                range_theta_rad: -0.1,
                ..base
            },
            ScanMatchConfig {
                max_match_distance_m: f32::NAN,
                ..base
            },
            ScanMatchConfig {
                max_match_distance_m: -0.5,
                ..base
            },
        ];
        for cfg in cases {
            assert_eq!(
                scan_match(&landmarks, &scan, [0.0; 3], &cfg),
                Err(ScanMatchError::InvalidConfig),
                "a malformed extent must be refused: {cfg:?}"
            );
        }
        // A zero extent is legal (the window collapses to a point, which is what `samples`
        // already expresses), so the boundary is pinned from the accepting side too.
        let zero_range = ScanMatchConfig {
            range_x_m: 0.0,
            range_y_m: 0.0,
            range_theta_rad: 0.0,
            ..base
        };
        assert!(
            scan_match(&landmarks, &scan, [0.0; 3], &zero_range).is_ok(),
            "a zero half-extent is a legal degenerate window, not a malformed config"
        );
    }

    /// Every field of a [`ScanMatchConfig`] the guard at the top of [`scan_match`] inspects, and
    /// the refusal each must produce.
    ///
    /// This test exists because the guard has **eight** conditions and the one above pinned only
    /// **seven** of them: it exercised `range_x_m < 0.0` and `range_theta_rad < 0.0` but never a
    /// **negative `range_y_m`**. With `|| config.range_y_m < 0.0` deleted the whole suite stayed
    /// green — and its loss is not cosmetic: the guard's own doc says a negative half-extent is
    /// refused *because it mirrors the window instead of sizing it*, so an unguarded negative
    /// y-extent makes the search cover the mirrored region and still return `Ok` with a
    /// plausible-looking pose — a wrong answer reported as a successful search. This is the same
    /// family as the robot stack's other input guards (`SlamState::observe` REQ-A725,
    /// `McLocalizer::update` REQ-A728, `new`/`new_at` REQ-A733/A737, `predict` REQ-A746): a guard
    /// is only as good as the conditions someone pins. Every leaf is pinned here, symmetric in x
    /// and y.
    #[test]
    fn every_malformed_scan_match_field_is_refused() {
        let landmarks = square_landmarks(3, 1.0);
        let scan = vec![(0.0, 0.0), (1.0, 1.0)];
        /// One way to break a config: set a named field to a value the guard must refuse.
        type Corrupt = (&'static str, fn(&mut ScanMatchConfig));
        let base = ScanMatchConfig::default();
        let bad: [Corrupt; 8] = [
            ("range_x_m", |c| c.range_x_m = f32::NAN),
            ("range_y_m", |c| c.range_y_m = f32::INFINITY),
            ("range_theta_rad", |c| c.range_theta_rad = f32::NAN),
            ("range_x_m", |c| c.range_x_m = -1.0),
            ("range_y_m", |c| c.range_y_m = -1.0),
            ("range_theta_rad", |c| c.range_theta_rad = -0.1),
            ("max_match_distance_m", |c| {
                c.max_match_distance_m = f32::NAN
            }),
            ("max_match_distance_m", |c| c.max_match_distance_m = -0.5),
        ];
        for (field, corrupt) in bad {
            let mut cfg = base;
            corrupt(&mut cfg);
            assert_eq!(
                scan_match(&landmarks, &scan, [0.0; 3], &cfg),
                Err(ScanMatchError::InvalidConfig),
                "a malformed {field} must be InvalidConfig"
            );
        }
        // The complement, so this test cannot pass by refusing everything: an untouched default
        // config must actually search.
        assert!(
            scan_match(&landmarks, &scan, [0.0; 3], &base).is_ok(),
            "a well-formed config must be searched, not refused"
        );
    }

    /// Every variant renders one operator-facing line — the same contract the sibling error
    /// types (`PlanError`, `DwaError`, `FusionError`, `LoopError`) hold. This enum had no
    /// `Display` at all, so a caller could only `{:?}` it.
    #[test]
    fn every_scan_match_error_renders_its_cause() {
        let rendered = [
            ScanMatchError::EmptyScan,
            ScanMatchError::EmptyMap,
            ScanMatchError::WindowTooLarge { requested: 7 },
            ScanMatchError::DegenerateWindow,
            ScanMatchError::InvalidConfig,
        ]
        .map(|e| e.to_string());
        for line in &rendered {
            assert!(!line.is_empty(), "every error needs a message");
            assert!(
                !line.contains("ScanMatchError"),
                "the message must describe the cause, not the type: {line}"
            );
        }
        // The variants must be distinguishable from one another: two different faults that
        // render the same line give an operator nothing to act on.
        for (i, a) in rendered.iter().enumerate() {
            for b in rendered.iter().skip(i + 1) {
                assert_ne!(a, b, "two distinct faults must not render identically");
            }
        }
        assert!(
            rendered[2].contains('7'),
            "the oversized window must name the count it refused: {}",
            rendered[2]
        );
        assert!(
            rendered[2].contains(&MAX_SCAN_OPERATIONS.to_string()),
            "…and the ceiling it exceeded: {}",
            rendered[2]
        );
    }

    /// The module doc quotes concrete operation counts; this keeps them from drifting.
    /// The `N_points` factor is the one that is easy to leave out of a mental estimate.
    #[test]
    fn the_documented_budget_numbers_are_the_arithmetic_ones() {
        // Default window: 11 · 11 · 5 = 605 poses, over a 50-point scan and 100 landmarks.
        let default = scan_match_window_budget(&ScanMatchConfig::default(), 50, 100);
        assert_eq!(default, 605 * 50 * 100);
        assert!(
            default < MAX_SCAN_OPERATIONS,
            "the default configuration must be admissible, got {default}"
        );
        // The doc's "too big" example: 41 · 41 · 25 poses over the 256-point cap and 100
        // landmarks — ~1.1 billion operations, refused.
        let huge = ScanMatchConfig {
            range_x_m: 2.0,
            range_y_m: 2.0,
            range_theta_rad: 0.4,
            samples_x: 41,
            samples_y: 41,
            samples_theta: 25,
            max_match_distance_m: 1.0,
        };
        let budget = scan_match_window_budget(&huge, MAX_SCAN_SIZE, 100);
        assert_eq!(budget, 41 * 41 * 25 * 256 * 100);
        assert!(
            budget > MAX_SCAN_OPERATIONS,
            "the doc's oversized window must trip the guard, got {budget}"
        );
    }
}
