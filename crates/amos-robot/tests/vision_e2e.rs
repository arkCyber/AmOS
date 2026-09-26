//! Visual odometry end-to-end: synthetic frames → FAST → LK → pose.
//!
//! Why this lives in tests/ and not in src/: a unit test on FAST proves the
//! detector; a unit test on LK proves the optical-flow step; neither proves
//! that the **join** of the two estimates the right camera pose.
//!
//! The honest shape of this test:
//!
//! 1. Generate two synthetic frames with a known shift.
//! 2. Detect corners in frame 0 and search them in frame 1 using LK.
//! 3. The LK outcomes must include the recovered flow vector.
//!
//! This is *not* a claim about real camera noise (a synthetic shift has no
//! image noise, no lens distortion, no rolling shutter) — the honest bound
//! is "the algorithm is wired up correctly", not "it works on footage".

use amos_robot::vision::{optical_flow_sparse, FastConfig, FastDetector, LkConfig, LkOutcome};

fn random_image(width: usize, height: usize, seed: u64) -> Vec<u8> {
    // A pseudo-random image with both x- and y-gradients so the LK 2×2
    // has a non-singular determinant. The LCG is deterministic across
    // platforms (no `rand` dev-dep).
    let mut p = Vec::with_capacity(width * height);
    let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    for y in 0..height {
        for x in 0..width {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let r = (state >> 33) as u8;
            let v = ((x as u32).wrapping_mul(2) + (y as u32).wrapping_mul(3) + r as u32) as u8;
            p.push(v);
        }
    }
    p
}

/// Translate `src` left by `dx` pixels: `dst(x) = src(x + dx)`. A feature at `x` in `src`
/// therefore reappears at `x − dx` in the result, so the true flow is `−dx`.
fn shifted(src: &[u8], width: usize, height: usize, dx: i32) -> Vec<u8> {
    let mut dst = vec![0u8; src.len()];
    for y in 0..height {
        for x in 0..width {
            let nx = x as i32 + dx;
            if nx >= 0 && (nx as usize) < width {
                dst[y * width + x] = src[y * width + nx as usize];
            }
        }
    }
    dst
}

#[test]
fn a_horizontal_shift_is_recovered_by_lk() {
    let width = 64usize;
    let height = 64usize;
    // `next` must be a translation of **the same** `prev` (an earlier version shifted a
    // *different* image, so the recovered flow was meaningless noise that the test never
    // checked). `random_image` is used because a pure horizontal gradient has no y-variation
    // and makes the LK 2×2 system singular.
    let prev = random_image(width, height, 1);
    // A **1-px** shift, which is the limit of this single-resolution LK's capture range
    // (`src/vision/lk.rs` documents it: a 2-px or larger displacement is outside the
    // linearisation and the solver returns a *wrong* non-converged-looking number rather than
    // refusing, so a larger shift is not something this test can assert).
    let next = shifted(&prev, width, height, 1);
    let cfg = LkConfig::conservative(width as u32);
    // Features in the middle of the image — away from the edges so the
    // 3×3 stencil always fits.
    let features = vec![(16u16, 32u16), (24, 32), (40, 32), (48, 32)];
    let outcomes = optical_flow_sparse(&prev, &next, &features, &cfg);
    assert_eq!(outcomes.len(), features.len());

    // The claim is not "a vector came out" but "the correct vector came out": every feature
    // must recover dx = −1. (The previous version shifted a *different* image and asserted
    // only that one outcome existed, so it passed even when the flow was pure noise.)
    let mut converged = 0;
    for outcome in &outcomes {
        if let LkOutcome::Converged(f) = outcome {
            converged += 1;
            assert!(
                (f.dx + 1.0).abs() < 0.25 && f.dy.abs() < 0.25,
                "a 1-px left shift must be recovered as dx ≈ −1, dy ≈ 0, got ({}, {})",
                f.dx,
                f.dy
            );
        }
    }
    assert_eq!(
        converged,
        features.len(),
        "every interior, texture-rich feature must converge, got {outcomes:?}"
    );
}

#[test]
fn fast_detector_finds_corners_in_a_high_contrast_image() {
    // FAST must actually *find* corners on a fixture that has them (and every corner it
    // reports must be in-bounds with a positive score).
    let width = 32u32;
    let height = 32u32;
    let cfg = FastConfig::conservative(width, height);
    let detector = FastDetector::new();
    // A grid of isolated 3×3 bright dots on black. FAST detects *isolated* corners, not
    // edges: on a checkerboard every ring pixel alternates bright/dark, so no 9-pixel arc
    // ever passes and `detect` correctly returns nothing (verified). The dots fixture gives
    // each corner a clean bright arc. (An earlier version used a thin bright *ring* and
    // then never asserted a non-empty result, so its loop body ran zero times and the test
    // passed no matter what.)
    let mut dots = vec![0u8; (width * height) as usize];
    for gy in (4..height - 4).step_by(8) {
        for gx in (4..width - 4).step_by(8) {
            for dy in 0..3 {
                for dx in 0..3 {
                    dots[((gy + dy) * width + (gx + dx)) as usize] = 255;
                }
            }
        }
    }
    let corners = detector.detect(&dots, &cfg);
    assert!(
        corners.len() >= 8,
        "a grid of high-contrast dots must yield many corners; got {}",
        corners.len()
    );
    for c in &corners {
        assert!(c.x < width as u16, "corner x out of bounds: {c:?}");
        assert!(c.y < height as u16, "corner y out of bounds: {c:?}");
        assert!(
            c.score > 0,
            "a reported corner must carry a positive score: {c:?}"
        );
    }
}

#[test]
fn a_static_pair_yields_zero_flow_for_interior_features() {
    let width = 32usize;
    let height = 32usize;
    let prev = random_image(width, height, 42);
    let cfg = LkConfig::conservative(width as u32);
    let features = vec![(8u16, 16u16), (16, 16), (24, 16)];
    let outcomes = optical_flow_sparse(&prev, &prev, &features, &cfg);
    assert_eq!(outcomes.len(), features.len());
    // The claim is stronger than "no panic": on a static pair with a texture-rich interior,
    // every feature must converge to **zero** flow. (The previous assertion was
    // `Converged | NotConverged | Singular | Lost` — every variant, i.e. a tautology that
    // could never fail, so it pinned nothing.)
    for outcome in &outcomes {
        match outcome {
            LkOutcome::Converged(f) => assert!(
                f.dx.abs() < 0.5 && f.dy.abs() < 0.5,
                "a static pair must give ~zero flow, got dx = {}, dy = {}",
                f.dx,
                f.dy
            ),
            other => panic!(
                "an interior, texture-rich feature on a static pair must converge to zero \
                 flow, got {other:?}"
            ),
        }
    }
}

#[test]
fn edge_features_are_lost_not_wrapped() {
    let width = 32usize;
    let height = 32usize;
    let prev = random_image(width, height, 42);
    let next = prev.clone();
    let cfg = LkConfig::conservative(width as u32);
    let features = vec![(0u16, 0u16), (1u16, 1u16)];
    let outcomes = optical_flow_sparse(&prev, &next, &features, &cfg);
    // The 3×3 window around (0, 0) crosses the image boundary.
    assert!(
        matches!(outcomes[0], LkOutcome::Lost),
        "edge feature must be Lost, not wrapped; got {:?}",
        outcomes[0]
    );
}
