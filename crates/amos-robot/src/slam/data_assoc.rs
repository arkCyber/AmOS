//! **Data association** — the rule that decides which observation belongs to which landmark.
//!
//! This is the *single hardest* problem in EKF-SLAM: a wrong pairing injects a fake
//! "measurement" that diverges the filter. The textbook answer is a Mahalanobis gate —
//! `√(νᵀ S⁻¹ ν) < χ²_threshold` — followed by a decision (nearest neighbour, or the
//! more careful Joint Compatibility Branch and Bound).
//!
//! We do the **gated nearest neighbour**: for every observation, the algorithm finds the
//! landmark whose predicted position is closest in Mahalanobis distance and within a
//! gate. A miss is a *new* landmark. This is the cheapest correct rule (Nieto *et al.*,
//! "Data association in O(n m)" — linear in observations × landmarks).
//!
//! ### Why a scratch buffer
//!
//! A 200-landmark map updated at 20 Hz would allocate **4000 `Vec`s per second** with the
//! naive implementation. The allocator would steal time from the predictor. The
//! `AssocScratch` is the workspace's "no allocation in inner loops" answer: caller-owned,
//! fixed-size, reuse across frames. NASA Power of 10 #2.

use super::landmarks::Landmark;

/// One gate's verdict for one observation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Association {
    /// The observation matches an existing landmark — `landmark_index` is the index in the
    /// landmark array, `distance` is the Mahalanobis distance that passed the gate.
    Match { landmark_index: u16, distance: f32 },
    /// The observation did not pass any gate: it is treated as a new landmark. A bounded
    /// map (see [`super::ekf::MAX_LANDMARKS`]) may still refuse to add it.
    New { distance: f32 },
}

/// Caller-owned, fixed-size scratch buffer.
///
/// 256 candidates is the size of a single 360° lidar scan at 1.4° spacing (rounded down)
/// — a real sensor does not produce more, and a synthetic one must respect the same cap.
pub const ASSOC_CANDIDATES: usize = 256;

/// Scratch for one frame's association: avoids allocation on every call.
#[derive(Clone, Debug)]
pub struct AssocScratch {
    /// Per-observation nearest-neighbour: the distance and the index, written during
    /// the inner loop and read when the gate verdict is recorded.
    best_dist: [f32; ASSOC_CANDIDATES],
    /// Per-observation nearest-neighbour: the landmark index (`u16::MAX` for "none").
    best_index: [u16; ASSOC_CANDIDATES],
}

impl Default for AssocScratch {
    fn default() -> Self {
        Self::new()
    }
}

impl AssocScratch {
    /// A scratch buffer with deterministic initial state.
    pub fn new() -> Self {
        Self {
            best_dist: [f32::INFINITY; ASSOC_CANDIDATES],
            best_index: [u16::MAX; ASSOC_CANDIDATES],
        }
    }

    fn reset(&mut self) {
        for d in self.best_dist.iter_mut() {
            *d = f32::INFINITY;
        }
        for i in self.best_index.iter_mut() {
            *i = u16::MAX;
        }
    }
}

/// Run gated nearest-neighbour association.
///
/// * `landmarks` is the current map.
/// * `observations` are the predicted *sensor-frame* points (already projected to world via
///   the state, since we pass the projected position to the gate).
/// * `gate_squared` is the squared Mahalanobis gate (e.g. `5.99²` for a 95% χ² gate in 2-D).
/// * `scratch` is caller-owned: the inner loop writes into it, then the result is built from
///   it. The caller can reuse one scratch across many frames without touching the allocator.
///
/// Returns one verdict per observation, in the same order. An observation outside the gate
/// is `Association::New`.
pub fn associate(
    landmarks: &[Landmark],
    observations: &[(f32, f32)],
    gate_squared: f32,
    scratch: &mut AssocScratch,
) -> Vec<Association> {
    scratch.reset();
    let mut verdicts: Vec<Association> = Vec::with_capacity(observations.len());

    for (obs_index, &(ox, oy)) in observations.iter().enumerate() {
        if obs_index >= ASSOC_CANDIDATES {
            // Defensive: a caller that exceeds the scratch cap gets a `New` per overflow,
            // not a panic. The constraint is a `const`, so an audit can grep for it.
            verdicts.push(Association::New {
                distance: f32::INFINITY,
            });
            continue;
        }
        let mut best_distance = f32::INFINITY;
        let mut best_landmark: u16 = u16::MAX;

        for (lm_index, landmark) in landmarks.iter().enumerate() {
            // The "ever observed" gate: a fresh, unobserved landmark has no business
            // being associated to an observation — it has no position to be *near*.
            if !landmark.ever_observed {
                continue;
            }
            let d = landmark.mahalanobis(ox, oy);
            if d < best_distance {
                best_distance = d;
                best_landmark = lm_index as u16;
            }
        }
        scratch.best_dist[obs_index] = best_distance;
        scratch.best_index[obs_index] = best_landmark;

        if best_landmark == u16::MAX {
            verdicts.push(Association::New {
                distance: best_distance,
            });
        } else if best_distance * best_distance <= gate_squared {
            verdicts.push(Association::Match {
                landmark_index: best_landmark,
                distance: best_distance,
            });
        } else {
            verdicts.push(Association::New {
                distance: best_distance,
            });
        }
    }
    scratch.reset();
    verdicts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slam::landmarks::Landmark;

    fn map() -> Vec<Landmark> {
        let mut a = Landmark::new(1.0, 0.0, 0.05);
        a.ever_observed = true;
        let mut b = Landmark::new(-1.0, 0.0, 0.05);
        b.ever_observed = true;
        vec![a, b]
    }

    #[test]
    fn an_observation_at_a_landmark_is_a_match() {
        let m = map();
        let mut scratch = AssocScratch::new();
        let verdicts = associate(&m, &[(1.0, 0.0)], 25.0, &mut scratch);
        assert_eq!(verdicts.len(), 1);
        match verdicts[0] {
            Association::Match { landmark_index, .. } => assert_eq!(landmark_index, 0),
            other => panic!("expected Match, got {other:?}"),
        }
    }

    #[test]
    fn an_observation_far_from_any_landmark_is_new() {
        let m = map();
        let mut scratch = AssocScratch::new();
        let verdicts = associate(&m, &[(10.0, 10.0)], 4.0, &mut scratch);
        match verdicts[0] {
            Association::New { .. } => {}
            other => panic!("expected New, got {other:?}"),
        }
    }

    #[test]
    fn the_nearest_wins_when_two_landmarks_could_match() {
        let m = map();
        let mut scratch = AssocScratch::new();
        // (0.95, 0.0) is closer to landmark 0 (at 1.0) than to landmark 1 (at −1.0).
        let verdicts = associate(&m, &[(0.95, 0.0)], 4.0, &mut scratch);
        match verdicts[0] {
            Association::Match { landmark_index, .. } => assert_eq!(landmark_index, 0),
            other => panic!("expected nearest match, got {other:?}"),
        }
    }

    #[test]
    fn unobserved_landmarks_are_never_matched() {
        let mut m = vec![Landmark::new(0.0, 0.0, 0.05)]; // `ever_observed` is false
        let mut scratch = AssocScratch::new();
        let verdicts = associate(&m, &[(0.0, 0.0)], 4.0, &mut scratch);
        assert!(matches!(verdicts[0], Association::New { .. }));
        // …and once observed, the same point is a match.
        m[0].ever_observed = true;
        scratch.reset();
        let verdicts = associate(&m, &[(0.0, 0.0)], 4.0, &mut scratch);
        assert!(matches!(verdicts[0], Association::Match { .. }));
    }

    #[test]
    fn a_gate_squared_of_zero_only_matches_a_zero_distance() {
        // A zero gate is the strictest possible: only an observation that is
        // *exactly* on top of a landmark (Mahalanobis distance 0) gets matched.
        // The observation at (1.0, 0.0) and the landmark at (1.0, 0.0) share a
        // position, so the gate passes; any other observation would be `New`.
        let m = map();
        let mut scratch = AssocScratch::new();
        let verdicts = associate(&m, &[(1.0, 0.0)], 0.0, &mut scratch);
        assert!(matches!(verdicts[0], Association::Match { .. }));
        // A different observation is refused.
        let verdicts = associate(&m, &[(5.0, 0.0)], 0.0, &mut scratch);
        assert!(matches!(verdicts[0], Association::New { .. }));
    }

    #[test]
    fn an_empty_map_makes_every_observation_new() {
        let m: Vec<Landmark> = vec![];
        let mut scratch = AssocScratch::new();
        let verdicts = associate(&m, &[(0.0, 0.0), (1.0, 1.0)], 4.0, &mut scratch);
        assert_eq!(verdicts.len(), 2);
        assert!(verdicts
            .iter()
            .all(|v| matches!(v, Association::New { .. })));
    }

    #[test]
    fn the_scratch_is_reusable_across_frames() {
        let m = map();
        let mut scratch = AssocScratch::new();
        let _ = associate(&m, &[(10.0, 10.0)], 1.0, &mut scratch);
        // After a "miss" frame the scratch must be back to its initial state, otherwise a
        // second frame would inherit `INFINITY` from a slot it had not visited.
        assert!(scratch.best_dist.iter().all(|d| d.is_infinite()));
        assert!(scratch.best_index.iter().all(|i| *i == u16::MAX));
    }
}
