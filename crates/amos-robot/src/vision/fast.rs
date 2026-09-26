//! FAST (Features from Accelerated Segment Test) corner detector — the Rosten–Drummond
//! "FAST-9" variant (the circle of 16 pixels with a 9-of-16 **contiguous** arc test).
//!
//! The original Rosten–Drummond detector pairs this test with a machine-learned decision
//! tree that *accelerates* it; this is the *non-machine-learned* variant — the same
//! high-throughput test run over the full 16-pixel ring, with no classifier in front of it.
//! The tree is only a speed optimization of the test below (it does not change which pixels
//! pass); running the test directly keeps the detection path a deterministic, reviewable
//! scan, which is what a verification campaign needs. No decision tree is implemented here.
//! (An earlier revision of this paragraph claimed the tree was "a 2-3× speedup" and that
//! "every aerospace-grade implementation I know of" runs the tree-free variant — neither is
//! a checkable claim, so both are withdrawn.)
//!
//! ### Inner loop
//!
//! * Pixel threshold test: 9 of 16 ring pixels brighter than `pixel + t`, or darker than
//!   `pixel − t`.
//! * Non-maximum suppression: among adjacent accepted pixels, keep only the brightest /
//!   darkest score. The comparison is **strict**, so a plateau of equally-scored pixels
//!   survives whole: a saturated edge (as in this module's own fixtures, where a bright
//!   square's corners all score 255) yields several adjacent corners, not one. That is
//!   deliberate — a strict winner is order-independent and therefore deterministic, and a
//!   caller that wants one point per plateau can pick it itself.
//!
//! All comparisons are `i32`, all offsets into the buffer are precomputed once per call —
//! the inner loop is a straight-line scan with no allocation.

/// Detector configuration.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FastConfig {
    /// Pixels per row in the input image.
    pub width: u32,
    /// Rows in the input image.
    pub height: u32,
    /// Detection threshold (the `t` in the test above).
    pub threshold: u8,
    /// Whether to run non-maximum suppression. When `true`, adjacent accepted pixels
    /// collapse to the single strongest (brightest/darkest) response; when `false` the
    /// detector is the boolean 9-arc test alone and may return clusters.
    pub non_max_suppression: bool,
    /// The minimum accepted score, in 8-bit units. Pixels whose absolute score is below
    /// this are not returned. Useful for filtering out weak responses.
    pub min_score: u8,
}

/// Detection threshold in 8-bit intensity units.
///
/// `// cited: Rosten & Drummond, *Machine learning for high-speed corner detection* (ECCV
/// 2006); their reference implementation's default threshold is `t = 20`, matched here.`
/// (An earlier revision attributed "`t = 10 .. 20` as the working range" to that paper; the
/// paper and the reference implementation state a *default of 20*, not a range, so the
/// range is withdrawn.) 20 sits at the conservative end of the 8-bit range — fewer, but
/// stronger, corners — which suits a tracker that will cap its set anyway
/// ([`crate::vision::vo::MAX_TRACKED_FEATURES`] is 256), preferring quality over count.
pub const DEFAULT_FAST_THRESHOLD: u8 = 20;

/// Minimum accepted corner score, in 8-bit intensity units.
///
/// `// chosen: 30 is this crate's floor — not cited and not measured.` It does **not** sit
/// "one threshold-step" above [`DEFAULT_FAST_THRESHOLD`] (there is no such step: an earlier
/// revision of this doc said so, but 30 is 1.5 × 20, not 20 + a step). What it is: a floor
/// above the `t = 20` the arc test already requires, so a corner cleared by the arc test
/// still has to show a response stronger than the test's own threshold. The class of the
/// relationship is unchanged — the exact value is a policy choice, and can be overridden.
pub const DEFAULT_FAST_MIN_SCORE: u8 = 30;

impl FastConfig {
    /// A conservative default: the 9-of-16 contiguous arc test, threshold
    /// [`DEFAULT_FAST_THRESHOLD`], non-max suppression on, score ≥
    /// [`DEFAULT_FAST_MIN_SCORE`]. (An earlier revision said "a 16-pixel arc": the ring is
    /// 16 pixels, but the *arc* is the 9 contiguous ones the test requires.)
    pub fn conservative(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            threshold: DEFAULT_FAST_THRESHOLD,
            non_max_suppression: true,
            min_score: DEFAULT_FAST_MIN_SCORE,
        }
    }
}

/// One detected corner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Corner {
    /// x coordinate (column) in the image.
    pub x: u16,
    /// y coordinate (row) in the image.
    pub y: u16,
    /// Score (the absolute deviation along the dominant arc).
    pub score: u16,
}

/// The detector. Holds no state — it is a `struct` only to namespace the constants.
pub struct FastDetector {
    _private: (),
}

impl Default for FastDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl FastDetector {
    /// A new detector.
    pub fn new() -> Self {
        Self { _private: () }
    }

    /// Detect corners in a luminance buffer.
    ///
    /// `pixels` must be `width · height` long; rows are stored contiguously (top-to-bottom).
    /// Returns the corners in scan order.
    pub fn detect(&self, pixels: &[u8], config: &FastConfig) -> Vec<Corner> {
        let mut corners = Vec::new();
        // Widen before multiplying: `u32 * u32` overflows for large images, which would
        // pass the length guard with a wrapped (small) product and then index out of
        // bounds. `usize` on 64-bit is wide enough for any real frame.
        let pixel_count = (config.width as usize).saturating_mul(config.height as usize);
        if config.width < 3 || config.height < 3 || pixels.len() < pixel_count {
            return corners;
        }
        // `Corner::x`/`y` are `u16`, and the suppression scan (`x in 1 .. w−1`) can emit a
        // coordinate as large as `width − 2`. An image wider than that would have
        // `x as u16` silently truncate the coordinate mod 65_536 — a *wrong* corner, not a
        // refused one. Refuse such an image up front; the bound is `u16::MAX + 2`, not
        // `u16::MAX`, because the last two columns can never be emitted.
        if config.width > u16::MAX as u32 + 2 || config.height > u16::MAX as u32 + 2 {
            return corners;
        }
        let w = config.width as i32;
        let h = config.height as i32;
        let t = config.threshold as i32;

        // 16 ring offsets (Rosten–Drummond FAST-9 / FAST-12). The order is fixed; the
        // number of contiguous pixels is the test that decides.
        const RING: [(i32, i32); 16] = [
            (0, -3),
            (1, -3),
            (2, -2),
            (3, -1),
            (3, 0),
            (3, 1),
            (2, 2),
            (1, 3),
            (0, 3),
            (-1, 3),
            (-2, 2),
            (-3, 1),
            (-3, 0),
            (-3, -1),
            (-2, -2),
            (-1, -3),
        ];

        // Score buffer: -1 means "no corner here". When non-max suppression is on, we
        // re-score the same pixels with a 3x3 winner-take-all kernel.
        let mut scores = vec![-1i32; pixel_count];

        for y in 3..(h - 3) {
            for x in 3..(w - 3) {
                let cx = x as usize;
                let cy = y as usize;
                let center = pixels[cy * (w as usize) + cx] as i32;

                // Quick rejection: at least two of the four cardinal ring pixels must
                // agree. Two is the *necessary* condition for a **9**-contiguous arc — an
                // earlier revision of this comment said "three, the high-speed test",
                // which is the FAST-12 rule and rejects genuine 9-arcs (the comment on the
                // two counters below works the arithmetic out).
                let p1 = pixels[(cy as i32 + RING[0].1) as usize * (w as usize)
                    + (cx as i32 + RING[0].0) as usize] as i32;
                let p5 = pixels[(cy as i32 + RING[4].1) as usize * (w as usize)
                    + (cx as i32 + RING[4].0) as usize] as i32;
                let p9 = pixels[(cy as i32 + RING[8].1) as usize * (w as usize)
                    + (cx as i32 + RING[8].0) as usize] as i32;
                let p13 = pixels[(cy as i32 + RING[12].1) as usize * (w as usize)
                    + (cx as i32 + RING[12].0) as usize] as i32;
                let bright = (p1 > center + t) as i32
                    + (p5 > center + t) as i32
                    + (p9 > center + t) as i32
                    + (p13 > center + t) as i32;
                let dark = (p1 < center - t) as i32
                    + (p5 < center - t) as i32
                    + (p9 < center - t) as i32
                    + (p13 < center - t) as i32;
                // Necessary condition for a *9*-contiguous arc: it must contain at least
                // 2 of the 4 cardinal ring pixels of the same sign. (The compass points
                // sit every 4 positions, so a 9-window contains at least ⌊9/4⌋ = 2 of them
                // — and can contain as few as 2, e.g. the arc {1,…,9} holds only 4 and 8.
                // A 3-of-4 threshold, the FAST-12 rule, would wrongly drop such corners.)
                if bright < 2 && dark < 2 {
                    continue;
                }

                // Full 16-pixel test: the ring is a **cycle**, so a contiguous run may
                // wrap from index 15 to index 0. Scan it twice (indices `i % 16` for
                // `i in 0..32`) so any run of up to 16 is measured whole. The score is the
                // peak deviation of the *dominant qualifying run*, not the max over the
                // whole ring — an isolated bright speck must not outrank the true arc.
                let mut bright_run = 0u32;
                let mut dark_run = 0u32;
                let mut bright_run_max = 0i32;
                let mut dark_run_max = 0i32;
                let mut best = 0i32;
                for i in 0..32 {
                    let (dx, dy) = RING[i % 16];
                    let px = pixels
                        [(cy as i32 + dy) as usize * (w as usize) + (cx as i32 + dx) as usize]
                        as i32;
                    let dev = px - center;
                    if dev > t {
                        bright_run += 1;
                        bright_run_max = bright_run_max.max(dev);
                        dark_run = 0;
                        dark_run_max = 0;
                    } else if dev < -t {
                        dark_run += 1;
                        dark_run_max = dark_run_max.max(-dev);
                        bright_run = 0;
                        bright_run_max = 0;
                    } else {
                        bright_run = 0;
                        dark_run = 0;
                        bright_run_max = 0;
                        dark_run_max = 0;
                    }
                    if bright_run >= 9 {
                        best = best.max(bright_run_max);
                    }
                    if dark_run >= 9 {
                        best = best.max(dark_run_max);
                    }
                }
                // `best == 0` means **no qualifying arc** at all: the 4-cardinal quick test
                // passed, but no 9-contiguous run exists, so the score buffer must keep its
                // `-1` sentinel for this pixel (the suppression pass treats any
                // non-negative entry as a candidate score). This is *not* the score floor —
                // for every `min_score >= 1` the second leaf rejects a zero score anyway, so
                // this leaf is shadowed by its sibling and pinned by no other test. It is the
                // *only* rejection at `min_score == 0`, a legal [`FastConfig`] (see
                // `a_pixel_with_no_arc_is_not_a_corner_even_with_a_zero_score_floor`).
                if best == 0 || best < config.min_score as i32 {
                    continue;
                }
                scores[cy * (w as usize) + cx] = best;
            }
        }

        if !config.non_max_suppression {
            // The user opted out: emit every accepted pixel with its score, and skip the
            // suppression pass entirely. (An earlier revision ran the suppression pass
            // unconditionally and then discarded it here when suppression was off — the
            // output was identical, so running the pass first was pure wasted work.)
            let mut raw = Vec::new();
            for y in 3..(h - 3) {
                for x in 3..(w - 3) {
                    let idx = (y as usize) * (w as usize) + (x as usize);
                    // `idx < w·h = scores.len()`, so this `None` arm is unreachable and
                    // untested by construction (the plain index would be equally safe).
                    if let Some(score) = scores.get(idx) {
                        if *score >= config.min_score as i32 {
                            raw.push(Corner {
                                x: x as u16,
                                y: y as u16,
                                score: *score as u16,
                            });
                        }
                    }
                }
            }
            return raw;
        }

        // Non-maximum suppression.
        for y in 1..(h - 1) {
            for x in 1..(w - 1) {
                let idx = (y as usize) * (w as usize) + (x as usize);
                let center = scores[idx];
                if center < 0 {
                    continue;
                }
                let mut is_max = true;
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let nx = x + dx;
                        let ny = y + dy;
                        let n_idx = (ny as usize) * (w as usize) + (nx as usize);
                        // `n_idx` is bounded by the loop ranges themselves — `x ± 1` stays
                        // inside `[0, w−1]` and `y ± 1` inside `[0, h−1]`, so `n_idx < w·h`,
                        // which is exactly `scores.len()`. The `get` is the non-panicking
                        // indexing idiom, not a live check: its `None` arm cannot be reached
                        // and so carries no test (direct `scores[n_idx]` is equally safe).
                        if let Some(neighbour) = scores.get(n_idx) {
                            if *neighbour > center {
                                is_max = false;
                                break;
                            }
                        }
                    }
                    if !is_max {
                        break;
                    }
                }
                if is_max {
                    corners.push(Corner {
                        x: x as u16,
                        y: y as u16,
                        score: center as u16,
                    });
                }
            }
        }
        corners
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 16×16 image with a single bright square: the only FAST-9 corner should be at
    /// the square's centre (or at the inner ring around it).
    fn bright_square() -> Vec<u8> {
        let mut p = vec![0u8; 16 * 16];
        for y in 6..10 {
            for x in 6..10 {
                p[y * 16 + x] = 255;
            }
        }
        p
    }

    #[test]
    fn a_fresh_detector_returns_no_corners_on_a_uniform_image() {
        let d = FastDetector::new();
        let p = vec![128u8; 32 * 32];
        let c = d.detect(&p, &FastConfig::conservative(32, 32));
        assert!(
            c.is_empty(),
            "uniform image has no corners, got {} corners",
            c.len()
        );
    }

    #[test]
    fn a_bright_square_on_a_dark_background_has_corners() {
        let d = FastDetector::new();
        let c = d.detect(&bright_square(), &FastConfig::conservative(16, 16));
        assert!(!c.is_empty(), "the bright square must produce corners");
        // The corners are on the inside ring of the square (the 9-of-16 test passes
        // when 9 ring pixels around the centre pixel are > 235).
        for corner in &c {
            assert!(corner.x >= 4 && corner.x <= 12, "x={}", corner.x);
            assert!(corner.y >= 4 && corner.y <= 12, "y={}", corner.y);
        }
    }

    #[test]
    fn a_too_small_image_is_refused() {
        // Correction (REQ-A1010 / F-SH-331): a 4x4 config makes the scan window
        // `3..(4-3)` empty, so `detect` returns before it ever indexes — the `width < 3`
        // / `height < 3` / `pixels.len() < pixel_count` leaves of the input guard are
        // all unexecuted by that fixture. The short-buffer case below is the one that
        // reaches the length leaf: a 16x16 window over an 8-byte buffer would index
        // `pixels[cy * 16 + cx]` out of bounds (len 8, index up to 11) were it not
        // refused up front.
        let d = FastDetector::new();
        let c = d.detect(&[0u8; 8], &FastConfig::conservative(4, 4));
        assert!(c.is_empty());

        let short = d.detect(&[0u8; 8], &FastConfig::conservative(16, 16));
        assert!(
            short.is_empty(),
            "a buffer shorter than width*height must be refused, got {short:?}"
        );
    }

    /// `FastDetector::default` must be the same stateless detector as `new` (it is reached
    /// by `#[derive(Default)]` on a caller's struct), so it must detect identically.
    #[test]
    fn the_default_detector_equals_a_fresh_one() {
        let p = bright_square();
        let cfg = FastConfig::conservative(16, 16);
        assert_eq!(
            FastDetector::default().detect(&p, &cfg),
            FastDetector::new().detect(&p, &cfg)
        );
    }

    #[test]
    fn a_corner_whose_arc_crosses_the_ring_seam_is_found() {
        // The 9-contiguous arc around the centre occupies ring indices
        // {15, 0, 1, …, 7} — it wraps across the 15→0 seam. A linear (non-cyclic) run
        // test splits it into runs of 1 and 8 and rejects a genuine corner. The four
        // cardinal pixels hold only 2 bright (indices 0, 4) and 2 dark (8, 12), so this
        // fixture also pins the ≥2 (not ≥3) necessary condition.
        let mut p = vec![0u8; 16 * 16];
        let (cx, cy) = (8i32, 8i32);
        // Ring pixels of the wrapping arc, brightest first so the score is well-defined.
        let arc = [
            (-1, -3),
            (0, -3),
            (1, -3),
            (2, -2),
            (3, -1),
            (3, 0),
            (3, 1),
            (2, 2),
            (1, 3),
        ];
        for (dx, dy) in arc {
            p[((cy + dy) as usize) * 16 + (cx + dx) as usize] = 255;
        }
        let d = FastDetector::new();
        let c = d.detect(&p, &FastConfig::conservative(16, 16));
        assert!(
            c.iter().any(|k| k.x == cx as u16 && k.y == cy as u16),
            "the seam-crossing corner at ({cx},{cy}) must be found, got {c:?}"
        );
    }

    #[test]
    fn non_max_suppression_off_returns_a_superset() {
        let d = FastDetector::new();
        let with = d.detect(&bright_square(), &FastConfig::conservative(16, 16));
        let cfg = FastConfig {
            non_max_suppression: false,
            ..FastConfig::conservative(16, 16)
        };
        let without = d.detect(&bright_square(), &cfg);
        // Set inclusion is the real claim (NMS only ever removes); a length comparison
        // would pass vacuously if both sets were empty.
        for k in &with {
            assert!(
                without.iter().any(|m| m.x == k.x && m.y == k.y),
                "every NMS survivor must also appear without NMS: {k:?}"
            );
        }
        assert!(
            !with.is_empty() && without.len() >= with.len(),
            "non-max suppresses; without it we have ≥ corners: {} vs {}",
            without.len(),
            with.len()
        );
    }

    /// NMS keeps one corner per *local maximum*, and the comparison is strict — so a
    /// plateau of equally-scored pixels survives whole rather than collapsing to one point.
    /// The bright square saturates (every corner scores 255), which makes it the fixture
    /// that separates "strict" from "non-strict": with `>=` in the suppression test, each
    /// pixel of the plateau disqualifies the others and the whole plateau disappears.
    #[test]
    fn non_max_suppression_keeps_a_plateau_of_equal_scores() {
        let d = FastDetector::new();
        let c = d.detect(&bright_square(), &FastConfig::conservative(16, 16));
        let saturated = c.iter().filter(|k| k.score == 255).count();
        assert!(
            saturated >= 2,
            "the square's corners saturate at 255 and must survive as a plateau, got {c:?}"
        );
        // And the survivors really are neighbours: "two saturated corners far apart" is
        // something any detector returns and would not pin the tie behaviour at all.
        let adjacent = c.iter().any(|p| {
            c.iter().any(|q| {
                p != q
                    && (p.x as i32 - q.x as i32).abs() <= 1
                    && (p.y as i32 - q.y as i32).abs() <= 1
            })
        });
        assert!(adjacent, "the plateau must be adjacent pixels, got {c:?}");
    }

    #[test]
    fn a_corner_scoring_exactly_the_min_score_is_kept() {
        // `min_score` is an *inclusive* floor (`best < min_score` rejects), so a corner
        // whose score equals the floor must survive. The low-contrast square (100 on 0)
        // scores exactly 100, which makes the boundary reachable without a synthetic
        // buffer; one above it must drop the corner. This pins the inclusive comparison —
        // `min_score_filters_weak_responses` only checks a floor far from any real score.
        let mut p = vec![0u8; 16 * 16];
        for y in 6..10 {
            for x in 6..10 {
                p[y * 16 + x] = 100;
            }
        }
        let d = FastDetector::new();
        let at = d.detect(
            &p,
            &FastConfig {
                min_score: 100,
                non_max_suppression: false,
                ..FastConfig::conservative(16, 16)
            },
        );
        let above = d.detect(
            &p,
            &FastConfig {
                min_score: 101,
                non_max_suppression: false,
                ..FastConfig::conservative(16, 16)
            },
        );
        assert!(
            !at.is_empty(),
            "a corner scoring exactly min_score must be kept"
        );
        assert!(
            at.iter().all(|k| k.score == 100),
            "the fixture scores exactly 100, got {at:?}"
        );
        assert!(
            above.is_empty(),
            "one above the score must reject the corner, got {above:?}"
        );
    }

    #[test]
    fn a_pixel_with_no_arc_is_not_a_corner_even_with_a_zero_score_floor() {
        // Correction (REQ-A1205 / F-SH-492): the acceptance guard's first leaf `best == 0`
        // is *executed* on almost every call (any pixel passing the 4-cardinal quick test
        // with no 9-arc), yet pinned by nothing — every other test uses a `min_score` of 30
        // or more, where `best == 0` implies `best < min_score` and the second leaf rejects
        // the pixel anyway. `min_score` is a `pub u8`, so 0 is a legal configuration, and
        // there this leaf is the *only* rejection: delete it and `scores[idx] = 0` is
        // written, which the suppression pass (sentinel `-1`, `if center < 0 { continue }`)
        // reads as a real score and emits as a corner of score 0.
        //
        // The fixture puts bright pixels at (8,5) and (8,11): the centre (8,8) sees ring
        // positions 0 and 8 bright, so the quick test passes, but those two sit 8 apart on
        // the 16-ring and no 9-contiguous arc exists — its score stays 0.
        let mut p = vec![0u8; 16 * 16];
        p[5 * 16 + 8] = 255;
        p[11 * 16 + 8] = 255;
        let d = FastDetector::new();
        for nms in [true, false] {
            let c = d.detect(
                &p,
                &FastConfig {
                    min_score: 0,
                    non_max_suppression: nms,
                    ..FastConfig::conservative(16, 16)
                },
            );
            assert!(
                !c.iter().any(|k| k.x == 8 && k.y == 8),
                "a pixel with no 9-arc must not be a corner (nms={nms}), got {c:?}"
            );
            assert!(
                c.iter().all(|k| k.score > 0),
                "no emitted corner may carry score 0 (nms={nms}), got {c:?}"
            );
        }
        // Control: the two genuinely bright pixels are corners and must still be found —
        // otherwise "nothing is ever emitted" would pass the assertions above.
        let c = d.detect(
            &p,
            &FastConfig {
                min_score: 0,
                ..FastConfig::conservative(16, 16)
            },
        );
        assert!(
            c.iter().any(|k| k.x == 8 && k.y == 5) && c.iter().any(|k| k.x == 8 && k.y == 11),
            "the two bright pixels are real corners, got {c:?}"
        );
    }

    #[test]
    fn an_image_whose_coordinates_do_not_fit_u16_is_refused() {
        // `Corner::x`/`y` are `u16`. A 70_000-wide image could not store its own
        // coordinates; without the up-front bound `x as u16` would truncate them mod
        // 65_536 and report a corner at a *wrong* column. The fixture puts a bright square
        // at x ≈ 66_000 so that, absent the refusal, a truncated corner would be emitted —
        // making the negative control (delete the bound ⇒ non-empty ⇒ red) real.
        let (w, h) = (70_000usize, 16usize);
        let mut p = vec![0u8; w * h];
        let sx = 66_000usize;
        for y in 6..10 {
            for x in sx..(sx + 4) {
                p[y * w + x] = 255;
            }
        }
        let d = FastDetector::new();
        let c = d.detect(&p, &FastConfig::conservative(w as u32, h as u32));
        assert!(
            c.is_empty(),
            "an image too wide for u16 coordinates must be refused, got {c:?}"
        );

        // Correction (REQ-A1011 / F-SH-332): the bound's *height* leaf is the other axis of
        // the same two-leaf guard; the fixture above overruns only on width, so without
        // this second fixture `config.height > u16::MAX + 2` is never the deciding leaf.
        // A 70_000-tall image with the square at row ~66_000 would, absent the bound,
        // emit `y as u16` truncated mod 65_536 (= 464) — a corner at the wrong row.
        let (w2, h2) = (16usize, 70_000usize);
        let mut p2 = vec![0u8; w2 * h2];
        let sy = 66_000usize;
        for y in sy..(sy + 4) {
            for x in 6..10 {
                p2[y * w2 + x] = 255;
            }
        }
        let tall = d.detect(&p2, &FastConfig::conservative(w2 as u32, h2 as u32));
        assert!(
            tall.is_empty(),
            "an image too tall for u16 coordinates must be refused, got {tall:?}"
        );
    }

    #[test]
    fn min_score_filters_weak_responses() {
        // A low-contrast square (100 on 0) gives corners a score of ≈100 — above the
        // loose threshold but below the strict one, so the two sets genuinely differ.
        let mut p = vec![0u8; 16 * 16];
        for y in 6..10 {
            for x in 6..10 {
                p[y * 16 + x] = 100;
            }
        }
        let d = FastDetector::new();
        let strict = d.detect(
            &p,
            &FastConfig {
                min_score: 200,
                ..FastConfig::conservative(16, 16)
            },
        );
        let loose = d.detect(
            &p,
            &FastConfig {
                min_score: 30,
                ..FastConfig::conservative(16, 16)
            },
        );
        assert!(!loose.is_empty(), "the loose threshold must admit corners");
        assert!(
            strict.is_empty(),
            "a 200 floor must reject ≈100-scored corners"
        );
        // The strict set must be a subset of the loose set (trivially true when empty,
        // but the assertions above pin that both sides are real).
        for k in &strict {
            assert!(
                loose.iter().any(|m| m.x == k.x && m.y == k.y),
                "a strict-threshold corner must survive the loose threshold: {k:?}"
            );
        }
        assert!(
            strict.len() < loose.len(),
            "the strict threshold must drop some"
        );
    }
}
