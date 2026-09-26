//! **Data association** — the rule that decides which observation belongs to which landmark.
//!
//! This is the *single hardest* problem in EKF-SLAM: a wrong pairing injects a fake
//! "measurement" that diverges the filter. The textbook answer is a Mahalanobis gate —
//! the **squared** form `νᵀ S⁻¹ ν < χ²_threshold` (with the threshold the upper quantile
//! of `χ²`, so the root is *not* taken) — followed by a decision: nearest neighbour (what
//! this module implements), or the more careful Joint Compatibility Branch and Bound, which
//! this module does **not** implement: JCBB needs the *joint* covariance, so it lives in
//! [`super::ekf`] ([`super::ekf::SlamState::associate_joint`] /
//! [`super::ekf::SlamState::observe_batch`]) next to the state it reads.
//!
//! `associate` here is a **standalone helper**: it gates on the distance from the
//! observation to a landmark's *position*, weighted by that landmark's own covariance
//! ([`Landmark::cov`]) — a 2-D position Mahalanobis, not the innovation `νᵀ S⁻¹ ν`. Those
//! differ: the innovation covariance `S = H Σ Hᵀ + R` also carries the robot-pose
//! uncertainty and the measurement noise, which the position form omits. The EKF's own
//! [`crate::slam::ekf::SlamState::observe`] therefore does **not** call this function — it
//! evaluates the full innovation gate inline. `associate` remains for callers that hold a
//! landmark cloud but not a joint covariance (e.g. a global map in a two-stage design).
//!
//! We do the **gated nearest neighbour**: for every observation, the algorithm finds the
//! landmark whose predicted position is closest in Mahalanobis distance and within a
//! gate. A miss is a *new* landmark. This is the cheapest correct rule (Nieto *et al.*,
//! "Data association in O(n m)" — linear in observations × landmarks).
//!
//! ### Why a scratch buffer, and what it actually buys
//!
//! The **inner loop** — observations × landmarks, 256 × 200 is 51 200 comparisons in a
//! single frame — allocates nothing. That is the loop where per-iteration allocation would
//! matter, and it is the loop NASA Power of 10 #2 is about.
//!
//! `associate` itself still returns an owned `Vec<Association>` — one allocation **per
//! call**, not per observation and not per comparison. At 20 Hz that is 20 allocations per
//! second for the whole frame, a cost the `Vec` return type buys deliberately: the verdicts
//! are the function's product, and a caller that needs the frame's verdicts held across
//! calls would have to own a second buffer for them anyway. An earlier revision of this
//! comment claimed the naive implementation would allocate "4000 `Vec`s per second" — that
//! figure belongs to a design that allocates one list *per observation*; the per-call
//! allocation is what this one does, and it is stated here rather than papered over.
//!
//! `AssocScratch` is the caller-owned, fixed-size workspace that carries the per-observation
//! nearest-neighbour result out of that inner loop — read back with
//! [`AssocScratch::best_distance`] / [`AssocScratch::best_index`] instead of walking the
//! verdict list. It is reset at the *start* of each call, so one scratch can be reused
//! across frames.

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
/// A single 360° lidar scan at 1.4° spacing produces **257** returns — one *more* than this
/// cap. That is a deliberate, bounded trade: 256 is a power of two (cheap to size), and the
/// 257th-and-beyond observation degrades to `Association::New`, which is the *safe*
/// direction (a fresh landmark, not a wrong match). A deployment whose sensor genuinely
/// emits more returns than this either downsamples at the driver or raises the `const`
/// knowingly; nothing here panics or silently drops the extra returns.
pub const ASSOC_CANDIDATES: usize = 256;

/// The 95% upper quantile of the `χ²(2)` distribution — the squared-Mahalanobis gate for a
/// 2-D observation at 95% confidence.
///
/// // cited: standard `χ²` table, 2 degrees of freedom, `p = 0.95` → 5.991 (NIST/SEMATECH
/// e-Handbook §1.3.6.7.4). The value is compared against the **squared** Mahalanobis
/// distance, so it is not square-rooted.
pub const CHI2_2DOF_95: f32 = 5.991;

/// Scratch for one frame's association: a caller-owned, fixed-size workspace.
#[derive(Clone, Debug)]
pub struct AssocScratch {
    /// Per-observation nearest-neighbour distance (the root, for reporting). Each slot is
    /// written **once per observation, after that observation's inner loop**, from the
    /// running best which is kept in a register; the scan does not index into this array.
    /// Read back through [`AssocScratch::best_distance`].
    best_dist: [f32; ASSOC_CANDIDATES],
    /// Per-observation nearest-neighbour landmark index (`u16::MAX` for "none"). Written at
    /// the same point as [`Self::best_dist`]. Read back through [`AssocScratch::best_index`].
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

    /// The nearest-neighbour Mahalanobis distance recorded for observation `obs_index` in the
    /// **most recent** [`associate`] call, or `None` if `obs_index` is at or past
    /// [`ASSOC_CANDIDATES`] (where `associate` never gated it). `f32::INFINITY` means "no
    /// landmark was a candidate" — an empty map, or a map of only unobserved landmarks.
    ///
    /// This is the same value the corresponding verdict reports, read without walking the
    /// verdict list. It survives until the next `associate` call, which resets the workspace
    /// before it starts.
    pub fn best_distance(&self, obs_index: usize) -> Option<f32> {
        self.best_dist.get(obs_index).copied()
    }

    /// The index of the landmark nearest observation `obs_index` in the **most recent**
    /// [`associate`] call, or `None` when there was no nearest landmark — either because
    /// `obs_index` is at or past [`ASSOC_CANDIDATES`], or because no landmark was a
    /// candidate (an empty map, or only unobserved landmarks).
    ///
    /// To distinguish "past the cap" from "no candidate", read
    /// [`Self::best_distance`]: it is `None` for the former and `INFINITY` for the latter.
    pub fn best_index(&self, obs_index: usize) -> Option<u16> {
        match self.best_index.get(obs_index).copied() {
            Some(u16::MAX) | None => None,
            Some(i) => Some(i),
        }
    }

    fn reset(&mut self) {
        self.best_dist.fill(f32::INFINITY);
        self.best_index.fill(u16::MAX);
    }
}

/// Run gated nearest-neighbour association.
///
/// * `landmarks` is the current map.
/// * `observations` are the predicted *sensor-frame* points (already projected to world via
///   the state, since we pass the projected position to the gate).
/// * `gate_squared` is the squared Mahalanobis gate — `5.991` is the 95% quantile of
///   `χ²(2)`, so that is the value for a 95% gate in 2-D. It is compared against the
///   **squared** Mahalanobis distance ([`Landmark::mahalanobis_squared`]), never against the
///   root.
/// * `scratch` is caller-owned, fixed-size workspace. It is reset at the top of the call and
///   left holding this call's per-observation nearest neighbours at the end, readable via
///   [`AssocScratch::best_distance`] / [`AssocScratch::best_index`]. The inner loop itself
///   indexes into neither array — the running best is a local.
///
/// Returns one verdict per observation, in the same order. An observation outside the gate
/// is `Association::New`. The verdict distances are the Mahalanobis **roots** (the form a
/// log line or a plot wants); the gate is applied in squared units.
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
        let mut best_squared = f32::INFINITY;
        let mut best_landmark: u16 = u16::MAX;

        for (lm_index, landmark) in landmarks.iter().enumerate() {
            // `u16::MAX` is the "no match" sentinel, so an index at or above it cannot be
            // reported. Indices are ascending, so the first such index ends the scan. A
            // truncating `as u16` would alias the sentinel (a real match read as `New`) or a
            // wrong landmark — a silent association error, the worst failure mode here.
            if lm_index >= u16::MAX as usize {
                break;
            }
            // The "ever observed" gate: a fresh, unobserved landmark has no business
            // being associated to an observation — it has no position to be *near*.
            if !landmark.ever_observed {
                continue;
            }
            // The **squared** Mahalanobis distance: the gate is a `χ²` threshold, which is
            // quoted in squared units, so the root is only taken to *report* the match. See
            // [`Landmark::mahalanobis_squared`] for why the round trip is avoided here.
            let sq = landmark.mahalanobis_squared(ox, oy);
            if sq < best_squared {
                best_squared = sq;
                best_landmark = lm_index as u16;
            }
        }
        scratch.best_dist[obs_index] = best_squared.sqrt();
        scratch.best_index[obs_index] = best_landmark;

        if best_landmark == u16::MAX {
            verdicts.push(Association::New {
                distance: best_squared.sqrt(),
            });
        } else if best_squared <= gate_squared {
            verdicts.push(Association::Match {
                landmark_index: best_landmark,
                distance: best_squared.sqrt(),
            });
        } else {
            verdicts.push(Association::New {
                distance: best_squared.sqrt(),
            });
        }
    }
    // The workspace is deliberately **left holding this call's results** so the caller can
    // read them back through `best_distance`/`best_index`. The reset at the top of the next
    // call is what makes reuse safe; clearing here as well would make those accessors always
    // report the empty state.
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

    /// The gate runs in **squared** units but the verdict reports the **root**. Both halves
    /// are pinned here: the distance equals `Landmark::mahalanobis` (not its square, which
    /// is ~3.4× larger at this point), and the verdict follows the squared comparison.
    #[test]
    fn the_verdict_reports_the_root_while_the_gate_is_applied_squared() {
        let mut lm = Landmark::new(0.0, 0.0, 1.0); // cov = diag(1, 1)
        lm.ever_observed = true;
        let m = vec![lm];
        let mut scratch = AssocScratch::new();
        // A point at (2, 0): sq = 4.0, root = 2.0 — a factor of two apart, so reporting the
        // wrong one cannot pass unnoticed.
        let verdicts = associate(&m, &[(2.0, 0.0)], 4.0, &mut scratch);
        match verdicts[0] {
            Association::Match { distance, .. } => {
                assert!(
                    (distance - 2.0).abs() < 1e-5,
                    "the verdict distance is the root (2.0), not the gated square (4.0) — got {distance}"
                );
                assert!(
                    (distance - lm.mahalanobis(2.0, 0.0)).abs() < 1e-6,
                    "the reported distance must equal `Landmark::mahalanobis`"
                );
                assert!(
                    (distance * distance - lm.mahalanobis_squared(2.0, 0.0)).abs() < 1e-6,
                    "…and its square is the gated quantity"
                );
            }
            other => panic!("expected Match, got {other:?}"),
        }
        // sq == gate must be *inside* (the comparison is `<=`); an observation whose square
        // is just past the gate must be refused. Both are checked against sq, not the root.
        let at_gate = associate(
            &m,
            &[(CHI2_2DOF_95.sqrt(), 0.0)],
            CHI2_2DOF_95,
            &mut scratch,
        );
        assert!(
            matches!(at_gate[0], Association::Match { .. }),
            "on the gate must match: {:?}",
            at_gate[0]
        );
        let past_gate = associate(
            &m,
            &[(CHI2_2DOF_95.sqrt() * 1.001, 0.0)],
            CHI2_2DOF_95,
            &mut scratch,
        );
        assert!(
            matches!(past_gate[0], Association::New { .. }),
            "past the gate must be New: {:?}",
            past_gate[0]
        );
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

    /// The gate is the **squared** Mahalanobis distance against [`CHI2_2DOF_95`]: a point at
    /// exactly the 95% radius is inside, one just past it is outside.
    #[test]
    fn the_95_percent_gate_admits_the_boundary_and_refuses_past_it() {
        // A one-axis landmark with variance 1: Mahalanobis distance = |dx|.
        let mut lm = Landmark::new(0.0, 0.0, 1.0);
        lm.ever_observed = true;
        let m = vec![lm];
        let mut scratch = AssocScratch::new();
        let r = CHI2_2DOF_95.sqrt();
        let inside = associate(&m, &[(r - 1e-3, 0.0)], CHI2_2DOF_95, &mut scratch);
        assert!(
            matches!(inside[0], Association::Match { .. }),
            "just inside the 95% radius must match: {:?}",
            inside[0]
        );
        let outside = associate(&m, &[(r + 1e-3, 0.0)], CHI2_2DOF_95, &mut scratch);
        assert!(
            matches!(outside[0], Association::New { .. }),
            "just past the 95% radius must be New: {:?}",
            outside[0]
        );
    }

    /// Mahalanobis and Euclidean can disagree on the winner; the gate must follow
    /// Mahalanobis. Without an anisotropic map this test is indistinguishable from a
    /// Euclidean implementation.
    #[test]
    fn an_anisotropic_landmark_wins_where_euclidean_would_not() {
        let mut tight = Landmark::new(1.0, 0.0, 0.1); // cov = diag(0.01, 0.01)
        tight.ever_observed = true;
        let mut loose = Landmark::new(0.0, 0.5, 10.0); // cov = diag(100, 100)
        loose.ever_observed = true;
        let map = vec![tight, loose];
        // The observation is Euclidean-closer to `tight` (0.2) than to `loose` (1.3), but
        // in Mahalanobis terms `loose` is far nearer (its covariance is enormous).
        let mut scratch = AssocScratch::new();
        let verdicts = associate(&map, &[(1.2, 0.0)], 25.0, &mut scratch);
        match verdicts[0] {
            Association::Match { landmark_index, .. } => assert_eq!(
                landmark_index, 1,
                "Mahalanobis must prefer the loose, nearby-in-σ landmark"
            ),
            other => panic!("expected Match, got {other:?}"),
        }
    }

    /// A landmark index that does not fit `u16` is skipped, never truncated. The truncating
    /// version would report landmark 65 536 as index 0 — a wrong match to a landmark the
    /// observation has nothing to do with, which is the worst possible association error.
    #[test]
    fn an_index_past_u16_is_skipped_not_truncated() {
        // 65 537 landmarks (indices 0..=65 536). Only the last is observed, and it sits
        // exactly where the observation is.
        let mut map = vec![Landmark::new(0.0, 0.0, 0.1); u16::MAX as usize + 2];
        let last = map.len() - 1;
        map[last].ever_observed = true;
        let mut scratch = AssocScratch::new();
        let verdicts = associate(&map, &[(0.0, 0.0)], 4.0, &mut scratch);
        assert!(
            matches!(verdicts[0], Association::New { .. }),
            "an unrepresentable index must yield New, not a truncated match: {:?}",
            verdicts[0]
        );
    }

    /// One scratch, two frames: the second frame's result must not inherit anything the
    /// first frame left behind. The first `associate` call is what makes reuse safe (it
    /// resets at the top), so a frame with *fewer* observations than its predecessor must
    /// not see the predecessor's stale per-observation values, and a frame that finds no
    /// candidate must read back as "no candidate", not as the previous frame's match.
    #[test]
    fn the_scratch_is_reusable_across_frames() {
        let m = map();
        let mut scratch = AssocScratch::new();
        // Frame 1: a two-observation frame that matches landmark 0 on both.
        let _ = associate(&m, &[(1.0, 0.0), (1.0, 0.0)], 25.0, &mut scratch);
        assert_eq!(scratch.best_index(0), Some(0));
        assert_eq!(scratch.best_index(1), Some(0));
        // Frame 2: one observation, on landmark 1. Slot 0 must be the new frame's answer.
        let _ = associate(&m, &[(-1.0, 0.0)], 25.0, &mut scratch);
        assert_eq!(
            scratch.best_index(0),
            Some(1),
            "the second frame must overwrite the first frame's slot 0"
        );
        assert!(
            scratch.best_distance(0).is_some_and(|d| d < 1e-4),
            "and its distance, got {:?}",
            scratch.best_distance(0)
        );
        // Frame 2 had one observation; slot 1 is therefore *not covered* by it. The reset at
        // the top of the call is what makes that read as "nothing here" (`INFINITY`) rather
        // than as frame 1's leftover distance.
        assert_eq!(
            scratch.best_distance(1),
            Some(f32::INFINITY),
            "a slot this frame did not visit must not still hold the previous frame's answer"
        );
        assert_eq!(scratch.best_index(1), None);
        // Frame 3: an observation nowhere near either landmark — the slot must read back as
        // the nearest of the two (a candidate always exists here), not as the previous
        // frame's zero distance.
        let _ = associate(&m, &[(7.0, 0.0)], 0.0, &mut scratch);
        assert_eq!(
            scratch.best_index(0),
            Some(0),
            "…nearest is still landmark 0"
        );
        assert!(
            scratch.best_distance(0).is_some_and(|d| d > 1.0),
            "a far observation is not the previous frame's near one, got {:?}",
            scratch.best_distance(0)
        );
    }

    /// The workspace accessors report the same thing the verdict list does, and they
    /// distinguish "no candidate" (`INFINITY`) from "past the scratch cap" (`None`).
    #[test]
    fn the_scratch_accessors_agree_with_the_verdicts() {
        let m = map();
        let mut scratch = AssocScratch::new();
        let verdicts = associate(&m, &[(1.0, 0.0), (10.0, 10.0)], 25.0, &mut scratch);
        assert_eq!(scratch.best_index(0), Some(0));
        assert_eq!(
            scratch.best_index(1),
            Some(0),
            "the nearest one, even if refused"
        );
        // The reported distance is the verdict's distance, for both a Match and a New.
        for (i, verdict) in verdicts.iter().enumerate() {
            let reported = match verdict {
                Association::Match { distance, .. } | Association::New { distance } => *distance,
            };
            assert_eq!(
                scratch.best_distance(i),
                Some(reported),
                "slot {i} must equal the verdict's distance"
            );
        }
        // Past the cap: the accessor says `None` rather than reporting a stale infinity.
        assert_eq!(scratch.best_distance(ASSOC_CANDIDATES), None);
        assert_eq!(scratch.best_index(ASSOC_CANDIDATES), None);
        // An empty map (every landmark unobserved): a candidate that is *not* the verdict,
        // i.e. there is a slot but no number — `INFINITY`, not `None`.
        let unobserved = vec![Landmark::new(0.0, 0.0, 0.1)];
        let _ = associate(&unobserved, &[(0.0, 0.0)], 25.0, &mut scratch);
        assert_eq!(scratch.best_distance(0), Some(f32::INFINITY));
        assert_eq!(scratch.best_index(0), None);
    }

    /// `Default` is what `#[derive(Default)]` on a caller's struct reaches for; it must be
    /// the same deterministic empty scratch as `new`, not a second, drifting initialiser.
    #[test]
    fn the_default_scratch_equals_a_fresh_one() {
        let d: AssocScratch = AssocScratch::default();
        let n = AssocScratch::new();
        assert!(d.best_dist.iter().all(|v| v.is_infinite()));
        assert_eq!(d.best_dist, n.best_dist);
        assert_eq!(d.best_index, n.best_index);
    }

    /// A scan with **more returns than the scratch cap** (a 360° lidar at 1.4° spacing gives
    /// 257) must not panic: the overflow observations degrade to `New`, which is the safe
    /// direction (a fresh landmark, never a wrong match). This is the one place the module
    /// doc makes a "nothing here panics" promise, so it is worth holding it to it.
    #[test]
    fn observations_past_the_scratch_cap_degrade_to_new_without_panicking() {
        let m = map(); // landmark 0 at (1.0, 0.0), landmark 1 at (−1.0, 0.0)
        let mut scratch = AssocScratch::new();
        // One more than the cap. The first `ASSOC_CANDIDATES` sit on landmark 0 and must
        // still match; the single overflow sits on landmark 0 too — and must *still* be
        // `New`, because it was never gated.
        let mut obs = vec![(1.0, 0.0); ASSOC_CANDIDATES];
        obs.push((1.0, 0.0));
        let verdicts = associate(&m, &obs, 25.0, &mut scratch);
        assert_eq!(
            verdicts.len(),
            obs.len(),
            "one verdict per observation, no drop"
        );
        assert!(
            verdicts[..ASSOC_CANDIDATES].iter().all(|v| matches!(
                v,
                Association::Match {
                    landmark_index: 0,
                    ..
                }
            )),
            "the in-cap observations are gated normally"
        );
        assert!(
            matches!(verdicts[ASSOC_CANDIDATES], Association::New { distance } if distance.is_infinite()),
            "the overflow observation must be New with no measured distance, got {:?}",
            verdicts[ASSOC_CANDIDATES]
        );
        // The overflow slot was never gated, so the workspace does not claim a distance for
        // it — the in-cap slot above it does.
        assert_eq!(scratch.best_distance(ASSOC_CANDIDATES), None);
        assert_eq!(scratch.best_index(ASSOC_CANDIDATES), None);
        assert_eq!(scratch.best_index(0), Some(0));
    }
}
