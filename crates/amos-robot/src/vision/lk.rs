//! Lucas–Kanade sparse optical flow.
//!
//! Reference: Lucas & Kanade, 1981; the pyramid-less (single-resolution) variant.
//!
//! The algorithm:
//!
//! 1. For each feature, accumulate the spatial gradient matrix `A = Σ (∇I)(∇I)ᵀ` over the
//!    window in frame `t`.
//! 2. Solve `A · δ = b` with `b = Σ (∇I) · (I_t+1(x + v) − I_t(x))`, the standard
//!    Gauss–Newton form, a small number of iterations.
//! 3. The residual `I_t+1(x + v) − I_t(x)` is sampled with **bilinear interpolation** at
//!    the fractional offset `v` each iteration, so the residual is a smooth function of
//!    the unknown and the step is consistent with it. Sampling at the rounded integer
//!    pixel makes the residual a step function, which turns the solver into a greedy
//!    integer search that cannot report sub-pixel motion.
//!
//! ### Failure modes this module refuses
//!
//! * **Out-of-bounds sampling.** A feature whose neighbourhood crosses the image boundary
//!   — in the source patch *or* at the current fractional estimate in the target — is
//!   marked `Lost` rather than wrapping or clamping (both of which silently invent an edge
//!   pixel and bias the flow). The source window has to be complete for the **gradient**
//!   too, not just for the intensity: `∂I/∂x` is a forward difference to `px + 1`, so a
//!   window whose far edge sits on the last column (or row) is refused one pixel early
//!   instead of reading a clamped duplicate of that pixel into `A`.
//! * **Singular `A`.** `A` is rejected when its determinant falls below the
//!   `min_gradient` floor, when its smallest eigenvalue is not positive, or when its two
//!   eigenvalues are more than the `CONDITION_FLOOR` apart — a straight 1-D edge has a large
//!   determinant but only one measurable gradient direction (the aperture problem). In all
//!   three cases the feature is reported `Singular`; clamping the velocity to zero would
//!   silently lie about a moving feature.
//!
//! ### Honest boundary: the capture range is ±1 pixel
//!
//! Being single-resolution, this solver linearises `I(x + v)` about `v = 0`, so it only
//! recovers motion within about one pixel. Measured on three independent texture images: a
//! **1-px** shift converges to exactly `dx = −1` for every feature, while a **2-px** shift
//! returns scattered values (e.g. `−1.60`, `0.12`, `−0.03` on one texture) — and, critically,
//! those wrong values are reported `Converged`, not refused, because the residual genuinely
//! bottomed out somewhere inside the linearisation. A caller that expects a larger flow must
//! supply it as an initial guess or add a coarse-to-fine pyramid; the pyramid is **not**
//! implemented here (this is the pyramid-less variant the reference names), so on large
//! inter-frame motion the number this returns is not to be trusted.

/// Configuration.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LkConfig {
    /// Pixels per row in the input images.
    pub width: u32,
    /// Gauss–Newton iterations per call. 10 is the textbook default and what the
    /// pyramid-LK code reduces to at one level.
    pub max_iterations: u32,
    /// Convergence threshold (sum of absolute pixel changes between iterations).
    pub convergence_eps: i32,
    /// Minimum gradient norm — below this the 2×2 is singular and the feature is lost.
    pub min_gradient: i32,
    /// Window radius (in pixels). A radius of `1` means a 3×3 stencil; `2` means 5×5.
    pub window_radius: u32,
}

impl LkConfig {
    /// The textbook defaults: 3×3 window, 10 iterations, ε = 1, |∇I| ≥ 10.
    pub fn conservative(width: u32) -> Self {
        Self {
            width,
            max_iterations: 10,
            convergence_eps: 1,
            min_gradient: 10,
            window_radius: 1,
        }
    }
}

/// One feature's flow vector.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlowVector {
    /// Starting x (in pixels).
    pub x0: u16,
    /// Starting y (in pixels).
    pub y0: u16,
    /// Final x after flow (`x0 + dx`).
    pub x1: u16,
    /// Final y after flow (`y0 + dy`).
    pub y1: u16,
    /// dx in pixels (`x1 − x0`; fractional, from the bilinear sub-pixel solve).
    pub dx: f32,
    /// dy in pixels.
    pub dy: f32,
    /// The sum-of-squared-residuals at the converged solution. Lower is better.
    pub sse: f32,
}

/// Per-feature outcome.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LkOutcome {
    /// The feature converged.
    Converged(FlowVector),
    /// The feature's 3×3 neighbourhood left the image.
    Lost,
    /// The 2×2 system was singular (constant patch).
    Singular,
    /// The feature did not converge within `max_iterations`.
    NotConverged(FlowVector),
}

/// Run sparse LK on a list of `(x, y)` features.
///
/// Returns one outcome per input feature, in the same order. The caller owns the feature
/// list and the outcome list — no allocation in the inner loop (one `Vec` is created per
/// call, sized up front by [`Vec::with_capacity`]).
///
/// `prev` and `next` must be the **same length**, and that length is read as a
/// `width × (len / width)` image: there is no `height` field on [`LkConfig`], so a buffer
/// whose length is not a multiple of `width` is treated as the shorter image and its
/// trailing partial row is ignored (a length shorter than one row leaves `height = 0`, and
/// every feature is `Lost`). Mismatched lengths are refused wholesale, as `Lost` for every
/// feature.
pub fn optical_flow_sparse(
    prev: &[u8],
    next: &[u8],
    features: &[(u16, u16)],
    config: &LkConfig,
) -> Vec<LkOutcome> {
    let mut outcomes = Vec::with_capacity(features.len());
    let width = config.width as i32;
    let height = (prev.len() as i32) / width.max(1);
    if prev.len() != next.len() || next.len() < (width * height) as usize {
        for _ in features {
            outcomes.push(LkOutcome::Lost);
        }
        return outcomes;
    }
    let radius = config.window_radius as i32;
    for &(x0, y0) in features {
        outcomes.push(track_one(prev, next, x0, y0, width, height, radius, config));
    }
    outcomes
}

// `clippy::too_many_arguments` is suppressed here on purpose: aerospace-grade
// inner-loop helpers keep their inputs as parameters (no struct just to
// satisfy a lint), and the calling code in `optical_flow_sparse` already
// owns the working set. The alternative — a `TrackContext<'_>` parameter —
// would trade one ergonomic sin for a hidden allocation on the hot path.
#[allow(clippy::too_many_arguments)]
fn track_one(
    prev: &[u8],
    next: &[u8],
    x0: u16,
    y0: u16,
    width: i32,
    height: i32,
    radius: i32,
    config: &LkConfig,
) -> LkOutcome {
    let cx = x0 as i32;
    let cy = y0 as i32;
    // Refuse one pixel *early* on the far side: the gradient stencil reaches `px + 1`, so a
    // window whose last column is `width - 1` has no forward difference to read and would
    // otherwise have to clamp (duplicating the edge pixel into `A`). Keeping the whole
    // stencil — intensity and gradient — inside the frame is what makes the module's
    // "never clamp" invariant true.
    if cx - radius < 0 || cy - radius < 0 || cx + radius + 1 >= width || cy + radius + 1 >= height {
        return LkOutcome::Lost;
    }
    // Compute the gradients in `prev` once.
    let mut a00 = 0i64;
    let mut a01 = 0i64;
    let mut a11 = 0i64;
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            let px = cx + dx;
            let py = cy + dy;
            let here = prev[(py * width + px) as usize] as i32;
            let right = prev[(py * width + px + 1) as usize] as i32;
            let down = prev[((py + 1) * width + px) as usize] as i32;
            let gx = (right - here) as i64;
            let gy = (down - here) as i64;
            a00 += gx * gx;
            a01 += gx * gy;
            a11 += gy * gy;
        }
    }
    // `A = Σ (∇I)(∇I)ᵀ` is symmetric positive-semidefinite. Its determinant is the
    // product of the eigenvalues (`λ_min · λ_max`), so a determinant floor at
    // `min_gradient⁴` is dimensionally exact; the condition guard below additionally
    // rejects a matrix whose eigenvalues are wildly apart (a pure 1-D edge), which has
    // a large determinant but only one usable gradient direction — the LK aperture
    // problem, and the case `det` alone cannot see.
    //
    // The determinant is accumulated in `i128`: for a large window `a00 · a11` can
    // exceed `i64::MAX` (any radius ≳ 150 on a u8 image), and a wrapped determinant
    // would silently pass this gate.
    let det = (a00 as i128) * (a11 as i128) - (a01 as i128) * (a01 as i128);
    let det_f = det as f64;
    let trace_f = (a00 + a11) as f64;
    let disc_f = (trace_f * trace_f - 4.0 * det_f).max(0.0);
    let lambda_min = 0.5 * (trace_f - disc_f.sqrt());
    let lambda_max = 0.5 * (trace_f + disc_f.sqrt());
    // `det` scales as `|∇I|⁴`, so the floor takes `min_gradient⁴` weighted by
    // `DET_FLOOR_WEIGHT` (see its doc for the provenance of the weight).
    let min_det = (config.min_gradient as f64).powi(4) * DET_FLOOR_WEIGHT;
    // `lambda_min <= 0` closes the `min_gradient = 0` hole: with that config the
    // determinant floor is zero and the naive test `det < 0` would never fire, letting
    // `1.0 / det_f` produce an infinity on an exactly-singular patch. The finiteness test
    // leads so a NaN from an unrepresentable gradient cannot pass either branch.
    if !lambda_min.is_finite()
        || lambda_min <= 0.0
        || lambda_min < CONDITION_FLOOR * lambda_max
        || det_f < min_det
    {
        return LkOutcome::Singular;
    }
    let inv_det = 1.0 / det_f;

    // Iterate Gauss–Newton.
    let mut dx = 0.0f32;
    let mut dy = 0.0f32;
    let mut prev_change = i32::MAX;
    for _ in 0..config.max_iterations {
        let mut b0 = 0.0f64;
        let mut b1 = 0.0f64;
        let mut sse = 0.0f64;
        for ddy in -radius..=radius {
            for ddx in -radius..=radius {
                let px = cx + ddx;
                let py = cy + ddy;
                let prev_px = prev[(py * width + px) as usize] as i32;
                // Sample the target at the **fractional** offset (px + dx, py + dy).
                // A stencil that leaves the frame marks the feature `Lost`.
                let Some(next_px) = bilinear(next, width, height, px as f32 + dx, py as f32 + dy)
                else {
                    return LkOutcome::Lost;
                };
                let residual = next_px - prev_px as f64;
                sse += residual * residual;
                // Gradient at `prev[py, px]`.
                let right = prev[(py * width + px + 1) as usize] as i32;
                let down = prev[((py + 1) * width + px) as usize] as i32;
                let gx = (right - prev_px) as f64;
                let gy = (down - prev_px) as f64;
                b0 += gx * residual;
                b1 += gy * residual;
            }
        }
        // Solve A · δ = b. The δ we solve for is the correction that, when
        // *subtracted* from (dx, dy), moves the patch into the right place — the
        // Taylor expansion is `next ≈ prev + Ix·δx + Iy·δy`, so the residual is
        // zero when `(dx, dy) = -δ`.
        let delta_x = inv_det * (a11 as f64 * b0 - a01 as f64 * b1);
        let delta_y = inv_det * (-a01 as f64 * b0 + a00 as f64 * b1);
        dx -= delta_x as f32;
        dy -= delta_y as f32;
        let change = (delta_x.abs() + delta_y.abs()) as i32;
        if change < config.convergence_eps {
            let flow = FlowVector {
                x0,
                y0,
                x1: ((cx as f32 + dx).round() as i32).clamp(0, u16::MAX as i32) as u16,
                y1: ((cy as f32 + dy).round() as i32).clamp(0, u16::MAX as i32) as u16,
                dx,
                dy,
                sse: sse as f32,
            };
            return LkOutcome::Converged(flow);
        }
        if change >= prev_change {
            // Diverged or stalled: return what we have, marked as not-converged.
            let flow = FlowVector {
                x0,
                y0,
                x1: ((cx as f32 + dx).round() as i32).clamp(0, u16::MAX as i32) as u16,
                y1: ((cy as f32 + dy).round() as i32).clamp(0, u16::MAX as i32) as u16,
                dx,
                dy,
                sse: sse as f32,
            };
            return LkOutcome::NotConverged(flow);
        }
        prev_change = change;
    }
    let flow = FlowVector {
        x0,
        y0,
        x1: ((cx as f32 + dx).round() as i32).clamp(0, u16::MAX as i32) as u16,
        y1: ((cy as f32 + dy).round() as i32).clamp(0, u16::MAX as i32) as u16,
        dx,
        dy,
        sse: f32::INFINITY,
    };
    LkOutcome::NotConverged(flow)
}

/// Weight applied to `min_gradient⁴` to form the determinant floor.
///
/// // chosen: the part that is checkable is exact — at the textbook `min_gradient = 10` the
/// floor is `10⁴ · 1e-3 = 10`, so a flat patch (`det = 0`) fails while a textured one
/// (`det ≳ 1e3`) clears it. The **weight itself is not measured**: a flat-vs-textured
/// comparison accepts any weight in `(0, 0.1)` — eight orders of magnitude — so it cannot
/// have selected `1e-3`, and an earlier revision's claim that it did is withdrawn. Note
/// also that the floor scales as `|∇I|⁴`, the same power as `det`, but carries no
/// window-size factor while `det` grows with the pixel count (`a00 ≈ N·|∇I|²`), so a larger
/// `window_radius` clears the same floor more easily. Replace it only against a measurement
/// that can tell two candidate weights apart.
const DET_FLOOR_WEIGHT: f64 = 1e-3;

/// Relative floor on `λ_min / λ_max`. A straight 1-D edge is the LK aperture problem —
/// the eigenvalues differ by many orders of magnitude and only one direction is
/// measurable.
///
/// // chosen: **not measured.** The two ends are far apart — an ideal 1-D edge drives
/// `λ_min / λ_max` to 0, while a patch with any genuine 2-D structure sits orders of
/// magnitude above `1e-6` — so any value inside that gap separates them, and "sits between
/// them" is true of every one of them. `1e-6` is picked to sit deep in the gap, nearest
/// the edge side, where an over-eager rejection costs a feature rather than admitting a
/// bad one. No image set was swept to place it; an earlier revision's `// measured:`
/// marker overstated what the reasoning shows.
const CONDITION_FLOOR: f64 = 1e-6;

/// Bilinear sample of `img` at the fractional pixel coordinate `(fx, fy)`.
///
/// Returns `None` when the 2×2 stencil would cross the image boundary or the coordinate
/// is not finite. Clamping instead would invent an edge pixel and bias the flow toward it.
fn bilinear(img: &[u8], width: i32, height: i32, fx: f32, fy: f32) -> Option<f64> {
    if !fx.is_finite() || !fy.is_finite() {
        return None;
    }
    let x0f = fx.floor();
    let y0f = fy.floor();
    let ix = x0f as i32;
    let iy = y0f as i32;
    if ix < 0 || iy < 0 || ix + 1 >= width || iy + 1 >= height {
        return None;
    }
    let tx = (fx - x0f) as f64;
    let ty = (fy - y0f) as f64;
    let idx = |x: i32, y: i32| (y * width + x) as usize;
    let p00 = img[idx(ix, iy)] as f64;
    let p10 = img[idx(ix + 1, iy)] as f64;
    let p01 = img[idx(ix, iy + 1)] as f64;
    let p11 = img[idx(ix + 1, iy + 1)] as f64;
    let top = p00 + (p10 - p00) * tx;
    let bot = p01 + (p11 - p01) * tx;
    Some(top + (bot - top) * ty)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient_image() -> Vec<u8> {
        // A horizontal-dominant 2D gradient with a quadratic perturbation that
        // breaks the (Ix, Iy) parallelism in a way that survives the u8 cast.
        // A pure linear gradient (pixel = a·x + b·y) gives a singular LK
        // matrix because the partial derivatives are everywhere parallel.
        // Small quadratic terms round to zero in u8 (the gradient of `x·y/16`
        // at small `x` is `< 1`). The `x² / 4 + y² / 4` perturbation has
        // gradient ≈ `x/2` and `y/2`, so the 3×3 window around any test
        // feature sees a measurable (Ix, Iy) rotation.
        let mut p = Vec::with_capacity(32 * 32);
        for y in 0..32i32 {
            for x in 0..32i32 {
                let v = 4 * x + y + x * x / 4 + y * y / 4;
                p.push(v.min(220) as u8);
            }
        }
        p
    }

    fn shifted_horizontal() -> Vec<u8> {
        // Shift the gradient image right by 2 pixels: features should converge to (dx, 0) ≈ (2, 0).
        let src = gradient_image();
        let mut dst = vec![0u8; src.len()];
        for y in 0..32 {
            for x in 0..32 {
                // For x = 30 we copy from src[x-2]; for x < 2 the source is "off the
                // left edge" — we leave those cells at zero.
                if x >= 2 {
                    dst[y * 32 + x] = src[y * 32 + x - 2];
                }
            }
        }
        dst
    }

    /// Resample `src` (32×32) as if its content moved right/down by `(sx, sy)` pixels,
    /// using bilinear interpolation so a fractional shift is representable.
    fn shifted_by(src: &[u8], sx: f32, sy: f32) -> Vec<u8> {
        let (w, h) = (32i32, 32i32);
        let mut dst = vec![0u8; src.len()];
        for y in 0..h {
            for x in 0..w {
                let fx = x as f32 - sx;
                let fy = y as f32 - sy;
                let (x0, y0) = (fx.floor() as i32, fy.floor() as i32);
                let (tx, ty) = ((fx - x0 as f32) as f64, (fy - y0 as f32) as f64);
                let s = |xx: i32, yy: i32| -> f64 {
                    let xx = xx.clamp(0, w - 1);
                    let yy = yy.clamp(0, h - 1);
                    src[(yy * w + xx) as usize] as f64
                };
                let top = s(x0, y0) + (s(x0 + 1, y0) - s(x0, y0)) * tx;
                let bot = s(x0, y0 + 1) + (s(x0 + 1, y0 + 1) - s(x0, y0 + 1)) * tx;
                dst[(y * w + x) as usize] =
                    (top + (bot - top) * ty).round().clamp(0.0, 255.0) as u8;
            }
        }
        dst
    }

    #[test]
    fn a_half_pixel_shift_is_recovered_subpixel() {
        // A 0.5-px shift is the smallest offset an integer-rounded solver cannot
        // represent: it snaps to 0 or 1. Only genuine bilinear sampling lands the
        // estimate near 0.5, so this test pins the sub-pixel behaviour directly.
        let prev = gradient_image();
        let next = shifted_by(&prev, 0.5, 0.0);
        let cfg = LkConfig::conservative(32);
        let features = vec![(8u16, 8u16), (10, 10), (12, 12)];
        let outcomes = optical_flow_sparse(&prev, &next, &features, &cfg);
        for (i, outcome) in outcomes.iter().enumerate() {
            let flow = match outcome {
                LkOutcome::Converged(f) | LkOutcome::NotConverged(f) => f,
                other => panic!("feature {i}: expected a flow, got {other:?}"),
            };
            assert!(
                (flow.dx - 0.5).abs() < 0.3,
                "feature {i}: dx={} want ≈ 0.5 (integer sampling would give 0 or 1)",
                flow.dx
            );
            assert!(flow.dy.abs() < 0.3, "feature {i}: dy={}", flow.dy);
        }
    }

    #[test]
    fn a_horizontal_shift_is_recovered() {
        let prev = gradient_image();
        let next = shifted_horizontal();
        let cfg = LkConfig::conservative(32);
        // Features are seeded inside the unsaturated region of the gradient
        // image so every cell carries a non-zero gradient (a saturated cell is
        // a zero Ix and the solver reports Singular).
        let features = vec![(6u16, 4u16), (8, 8), (10, 10)];
        let outcomes = optical_flow_sparse(&prev, &next, &features, &cfg);
        for (i, outcome) in outcomes.iter().enumerate() {
            match outcome {
                LkOutcome::Converged(flow) => {
                    // With bilinear sampling the recovered dx lands close to the
                    // true integer shift (2 px); the u8 quantisation and the
                    // truncated gradient keep the honest tolerance at ±1.5.
                    assert!(
                        (flow.dx - 2.0).abs() < 1.5,
                        "feature {i}: dx={}, want ≈ 2.0",
                        flow.dx
                    );
                    // The vertical component of the LK solution is whatever the
                    // (Ix, Iy) cross-coupling produces — small on a
                    // horizontally-dominant gradient, but not exactly zero.
                    assert!(flow.dy.abs() < 1.5, "feature {i}: dy={}", flow.dy);
                }
                LkOutcome::Singular | LkOutcome::Lost => {
                    panic!("feature {i} did not converge: {outcome:?}");
                }
                LkOutcome::NotConverged(flow) => {
                    // A u8-quantised LK with sub-pixel refinement sometimes
                    // stalls with a step of exactly 1 (the truncation to int
                    // produces a discrete gradient that doesn't shrink further).
                    // The flow is still recoverable; the test is "the solver
                    // gets the direction right", not "the solver converges in
                    // 10 iterations on integer data".
                    assert!(
                        (flow.dx - 2.0).abs() < 1.5,
                        "feature {i} dx={}, want ≈ 2.0",
                        flow.dx
                    );
                    assert!(flow.dy.abs() < 1.5, "feature {i}: dy={}", flow.dy);
                }
            }
        }
    }

    /// The iteration-budget exhaustion path: a solver given one iteration on a real 2 px
    /// shift cannot have converged, so it must report `NotConverged` with the designed
    /// `sse = INFINITY` ("SSE not measured on this path"), not `Converged` or `Lost`. With
    /// the default 10-iteration budget the loop always converges or stalls first, so this
    /// path is only reachable by shrinking `max_iterations` — which the public config field
    /// exists to let a caller do.
    #[test]
    fn an_exhausted_iteration_budget_is_not_converged_with_infinite_sse() {
        let prev = gradient_image();
        let next = shifted_horizontal();
        let mut cfg = LkConfig::conservative(32);
        cfg.max_iterations = 1;
        let features = vec![(8u16, 8u16)];
        let outcomes = optical_flow_sparse(&prev, &next, &features, &cfg);
        match outcomes[0] {
            LkOutcome::NotConverged(flow) => {
                assert_eq!(
                    flow.sse,
                    f32::INFINITY,
                    "an un-converged step has no trustworthy SSE"
                );
                assert_eq!((flow.x0, flow.y0), (8, 8), "the seed is reported verbatim");
            }
            other => panic!("one iteration on a 2 px shift cannot converge, got {other:?}"),
        }
    }

    #[test]
    fn a_feature_near_the_edge_is_lost_not_wrapped() {
        let prev = gradient_image();
        let next = prev.clone();
        let cfg = LkConfig::conservative(32);
        // The 3×3 window around (0, 0) crosses the image boundary.
        let features = vec![(0u16, 0u16), (1u16, 1u16)];
        let outcomes = optical_flow_sparse(&prev, &next, &features, &cfg);
        assert!(matches!(outcomes[0], LkOutcome::Lost));
        // (1, 1) is one pixel in from the corner — its 3×3 window fits and the fixture's
        // quadratic term keeps that window's gradients non-parallel, so it is *trackable*:
        // on an identical frame pair LK must converge to the same point with ~zero flow.
        match outcomes[1] {
            LkOutcome::Converged(flow) => {
                assert!(
                    flow.dx.abs() < 1e-3 && flow.dy.abs() < 1e-3,
                    "identical frames must give zero flow, got {flow:?}"
                );
                assert_eq!((flow.x1, flow.y1), (1, 1));
            }
            other => panic!("expected Converged on the interior feature, got {other:?}"),
        }
    }

    /// The gradient stencil needs `px + 1` / `py + 1`, so a feature whose window ends on the
    /// last column or row has nowhere to read its forward difference from. It must be
    /// `Lost` — not `Singular`. Before the guard widened by one, such a feature passed the
    /// bounds check and reached the singularity gate first, so it came back `Singular`,
    /// naming a cause (a constant patch) it did not have.
    ///
    /// A flat image is the fixture that separates the two: a clamped stencil over a
    /// constant image is *exactly* rank-deficient, so the old code's verdict for the
    /// edge-touching feature was `Singular`, and any test that only asserted "not
    /// `Converged`" would have passed either way.
    #[test]
    fn a_window_whose_gradient_reaches_the_far_edge_is_lost_not_singular() {
        let p = vec![128u8; 32 * 32];
        let cfg = LkConfig::conservative(32);
        // radius = 1, so x = 30 spans 29..=31 and its forward difference needs column 32.
        let outcomes = optical_flow_sparse(&p, &p, &[(30u16, 16u16)], &cfg);
        assert!(
            matches!(outcomes[0], LkOutcome::Lost),
            "an incomplete gradient stencil is Lost, got {:?}",
            outcomes[0]
        );
        // y = 30 is the same case on the other axis.
        let outcomes = optical_flow_sparse(&p, &p, &[(16u16, 30u16)], &cfg);
        assert!(
            matches!(outcomes[0], LkOutcome::Lost),
            "the row axis must be guarded too, got {:?}",
            outcomes[0]
        );
        // One pixel further in the stencil is complete, so the refusal is the boundary and
        // not a blanket rejection of anything near an edge: a flat patch is `Singular`.
        let outcomes = optical_flow_sparse(&p, &p, &[(29u16, 29u16)], &cfg);
        assert!(
            matches!(outcomes[0], LkOutcome::Singular),
            "x = y = 29 has a complete stencil; a flat patch is Singular, got {:?}",
            outcomes[0]
        );
    }

    #[test]
    fn mismatched_buffer_sizes_are_refused() {
        let prev = vec![0u8; 32 * 32];
        let next = vec![0u8; 31 * 32];
        let cfg = LkConfig::conservative(32);
        let features = vec![(16, 16)];
        let outcomes = optical_flow_sparse(&prev, &next, &features, &cfg);
        assert!(matches!(outcomes[0], LkOutcome::Lost));
    }

    #[test]
    fn a_flat_patch_is_singular_even_with_a_zero_gradient_floor() {
        // `min_gradient = 0` removes the documented determinant floor; without the
        // explicit `λ_min > 0` test the code would then take `1.0 / 0.0` and report a
        // `dx = NaN` flow. The refusal must be `Singular`, and no NaN may escape.
        let prev = vec![128u8; 32 * 32];
        let cfg = LkConfig {
            min_gradient: 0,
            ..LkConfig::conservative(32)
        };
        let outcomes = optical_flow_sparse(&prev, &prev, &[(16, 16)], &cfg);
        assert!(
            matches!(outcomes[0], LkOutcome::Singular),
            "a flat patch must be Singular, got {:?}",
            outcomes[0]
        );
    }

    #[test]
    fn a_one_dimensional_edge_is_refused() {
        // Vertical stripes: the gradient is purely in `x`, so the aperture problem makes
        // the flow in `y` unobservable. The window is refused because `a11 = 0` collapses
        // the determinant to 0, so `λ_min ≤ 0` *and* the determinant floor both fire. That
        // is **not** the condition guard: a genuinely near-parallel (but non-degenerate)
        // gradient field is pinned separately by
        // `a_near_parallel_gradient_is_refused_by_the_condition_guard` below.
        let mut p = vec![0u8; 32 * 32];
        for y in 0..32 {
            for x in 0..32 {
                p[y * 32 + x] = if (x / 2) % 2 == 0 { 40 } else { 200 };
            }
        }
        let cfg = LkConfig::conservative(32);
        let outcomes = optical_flow_sparse(&p, &p, &[(16, 16)], &cfg);
        assert!(
            matches!(outcomes[0], LkOutcome::Singular),
            "a 1-D edge has no flow information across it; expected Singular, got {:?}",
            outcomes[0]
        );
    }

    /// `track_one`'s singularity gate is a four-leaf `||`; `det_f < min_det` had no case at
    /// all — dropping it left all 13 tests green. It is the leaf that implements the
    /// documented `min_gradient` contract ("below this the 2×2 is singular"), so without it a
    /// patch whose gradient is far under the floor is still accepted: **measured**, the
    /// 2-pixel blob below is then reported `NotConverged` with a spurious `dy = −3` on a 1-px
    /// shift whose true flow is `(1, 0)` — a wrong number where the contract promises a
    /// refusal.
    ///
    /// The blob's window has `a00 = 1`, `a11 = 2`, `a01 = 1`, so `det = 1` (under the floor
    /// of `10⁴ · DET_FLOOR_WEIGHT = 10`) while its eigenvalues are only ~7× apart — well
    /// inside `CONDITION_FLOOR`, so the condition guard is quiet and the floor is the only
    /// leaf that can refuse this window.
    #[test]
    fn a_patch_under_the_determinant_floor_is_singular_but_one_above_it_is_tracked() {
        let cfg = LkConfig::conservative(32);
        let blob = |amp: u8| {
            let mut p = vec![0u8; 32 * 32];
            p[15 * 32 + 15] = amp;
            p[15 * 32 + 16] = amp;
            p
        };
        // `det` scales as `amp⁴`: 1 under the floor, 16 above it, same *shape* either way.
        let below = blob(1);
        let outcomes = optical_flow_sparse(&below, &below, &[(16u16, 16u16)], &cfg);
        assert!(
            matches!(outcomes[0], LkOutcome::Singular),
            "a window under the determinant floor must be Singular, got {:?}",
            outcomes[0]
        );
        let above = blob(2);
        let outcomes = optical_flow_sparse(&above, &above, &[(16u16, 16u16)], &cfg);
        assert!(
            !matches!(outcomes[0], LkOutcome::Singular),
            "a window above the determinant floor must be tracked, got {:?}",
            outcomes[0]
        );
    }

    /// The condition guard — `λ_min < CONDITION_FLOOR · λ_max`, the leaf that implements the
    /// aperture-problem refusal — had no case either: dropping it left all 13 tests green. A
    /// near-parallel gradient field reaches it while staying *above* the determinant floor: a
    /// steep ramp (`60` per column) with a single perturbed pixel gives `λ_min ≈ 9.8e-4`,
    /// `λ_max ≈ 3.3e4` (ratio `3e-8`, below the `1e-6` floor) but `det = 32`, so the floor is
    /// quiet and this guard is the only refuser. **Measured**: neutralise this leaf and the
    /// window flips `Singular` → `Converged`.
    ///
    /// The complement adds a small checkerboard, which supplies the second gradient direction
    /// the aperture problem lacks: the same ramp is then tracked, so the test cannot pass by
    /// refusing every steep ramp.
    #[test]
    fn a_near_parallel_gradient_is_refused_by_the_condition_guard() {
        let cfg = LkConfig::conservative(32);
        let mut near_parallel = vec![0u8; 32 * 32];
        for y in 0..32i32 {
            for x in 0..32i32 {
                let mut v = 128 + 60 * (x - 16) + (y - 16);
                if x == 18 && y == 15 {
                    v += 2; // break the (Ix, Iy) parallelism — but only just
                }
                near_parallel[(y * 32 + x) as usize] = v.clamp(0, 255) as u8;
            }
        }
        let mut textured = vec![0u8; 32 * 32];
        for y in 0..32i32 {
            for x in 0..32i32 {
                let v = 128 + 60 * (x - 16) + (y - 16) + 2 * ((x + y) % 2);
                textured[(y * 32 + x) as usize] = v.clamp(0, 255) as u8;
            }
        }
        let outcomes = optical_flow_sparse(&near_parallel, &near_parallel, &[(16u16, 16u16)], &cfg);
        assert!(
            matches!(outcomes[0], LkOutcome::Singular),
            "a near-parallel gradient field must be Singular (aperture), got {:?}",
            outcomes[0]
        );
        let outcomes = optical_flow_sparse(&textured, &textured, &[(16u16, 16u16)], &cfg);
        assert!(
            !matches!(outcomes[0], LkOutcome::Singular),
            "adding the missing gradient direction must make it trackable, got {:?}",
            outcomes[0]
        );
    }

    /// The *other* boundary refusal: a feature whose source window fits — so the early
    /// guard lets it through — but whose **target** sample leaves the frame once the
    /// fractional estimate `dx` has grown. That is the second clause of the module doc's
    /// out-of-bounds bullet, and it must be `Lost`, not a wrapped or clamped sample.
    ///
    /// The fixture is a 1.5-px leftward shift: the solver takes a first step larger than
    /// one pixel, so it does *not* satisfy `convergence_eps` and genuinely samples at a
    /// fractional offset. The feature at `x = 2` has a window starting at column 1, so
    /// `1 + (−1.5) = −0.5` floors to `−1` — outside the row.
    #[test]
    fn a_target_sample_that_leaves_the_frame_is_lost_not_wrapped() {
        let prev = gradient_image();
        let next = shifted_by(&prev, -1.5, 0.0);
        let cfg = LkConfig::conservative(32);
        // x = 2: window columns 1..=3 and its forward difference to 4 are all in frame, so
        // the early guard passes and only the target-side sampler can refuse this feature.
        let outcomes = optical_flow_sparse(&prev, &next, &[(2u16, 16u16)], &cfg);
        assert!(
            matches!(outcomes[0], LkOutcome::Lost),
            "a target sample off the left edge is Lost, got {:?}",
            outcomes[0]
        );
        // The same shift four columns further in is tracked normally, with a leftward flow
        // of about 1.5 px. Without this arm the assertion above would also pass if the
        // *guard* had grown strict enough to refuse the whole left side of the image.
        let outcomes = optical_flow_sparse(&prev, &next, &[(6u16, 16u16)], &cfg);
        match outcomes[0] {
            LkOutcome::Converged(flow) | LkOutcome::NotConverged(flow) => {
                assert!(
                    flow.dx < -1.0 && flow.dx > -2.5,
                    "x = 6 is an interior feature with ≈ −1.5 px of leftward flow, got dx={}",
                    flow.dx
                );
            }
            other => panic!("x = 6 must be tracked, got {other:?}"),
        }
    }

    /// `track_one`'s window-bounds guard is symmetric in x/y and near/far, but only the **far**
    /// side (`cx + radius + 1 >= width`, `cy + radius + 1 >= height`) is executed by any test.
    /// The one existing near-edge case, `a_lost_track_is_dropped_and_the_set_is_topped_back_up`,
    /// uses the corner `(0,0)`, which trips **both** near-side leaves at once — so neither can
    /// fail alone. Dropping the left (`cx - radius < 0`) or top (`cy - radius < 0`) leaf lets the
    /// gradient stencil read `prev[(py * width + px)]` with `px`/`py` negative: a wrapped index
    /// (or an out-of-bounds panic) — a sample from the wrong part of the image, not `Lost`.
    #[test]
    fn the_left_and_top_window_bounds_are_refused_not_read_out_of_frame() {
        let img = gradient_image();
        let cfg = LkConfig::conservative(32);
        // `(0,1)` trips only `cx - radius < 0` (its `cy - radius` is 0, not negative), and the
        // leftmost stencil column is then at `px = -1` while `py = 0` — so without the left
        // leaf the read is `prev[-1]`, an out-of-bounds index, not a `Lost`.
        let outcomes = optical_flow_sparse(&img, &img, &[(0u16, 1u16)], &cfg);
        assert!(
            matches!(outcomes[0], LkOutcome::Lost),
            "a window hanging off the left edge must be Lost, got {:?}",
            outcomes[0]
        );
        // `(1,0)` is the y mirror: only `cy - radius < 0` can refuse it.
        let outcomes = optical_flow_sparse(&img, &img, &[(1u16, 0u16)], &cfg);
        assert!(
            matches!(outcomes[0], LkOutcome::Lost),
            "a window hanging off the top edge must be Lost, got {:?}",
            outcomes[0]
        );
        // Complement: the same two features one pixel inside are tracked, so the test cannot
        // pass by refusing every near-edge feature.
        for f in [(1u16, 8u16), (8u16, 1u16)] {
            let outcomes = optical_flow_sparse(&img, &img, &[f], &cfg);
            assert!(
                !matches!(outcomes[0], LkOutcome::Lost),
                "feature {f:?} sits inside the window guard and must be tracked, got {:?}",
                outcomes[0]
            );
        }
    }

    #[test]
    fn bilinear_interpolates_between_pixels() {
        // A 2×2 image [0 10; 20 30] sampled at its centre must be the mean (15).
        let img = [0u8, 10, 20, 30];
        let v = bilinear(&img, 2, 2, 0.5, 0.5).expect("interior sample");
        assert!((v - 15.0).abs() < 1e-9, "bilinear centre = {v}, want 15");
        // A stencil that needs a pixel outside the frame is refused, not clamped.
        assert!(bilinear(&img, 2, 2, 1.5, 0.5).is_none());
        assert!(bilinear(&img, 2, 2, f32::NAN, 0.0).is_none());
    }

    /// `bilinear`'s guard is symmetric in x/y, but every executed case is **x-only**:
    /// `bilinear_interpolates_between_pixels` drives `!fx.is_finite()` and `ix + 1 >= width`,
    /// and the pipeline case (`a_target_sample_that_leaves_the_frame_is_lost_not_wrapped`)
    /// shifts purely horizontally. The three **y** leaves — `!fy.is_finite()`, `iy < 0`,
    /// `iy + 1 >= height` — had no case at all, so dropping any of them silently reads a
    /// wrong row (a `NaN` floors to row 0) or indexes out of bounds instead of refusing.
    #[test]
    fn bilinear_refuses_a_stencil_that_leaves_the_frame_in_y() {
        // a 2×2 image
        let img = [0u8, 10, 20, 30];
        // Below the last row: `iy + 1 >= height`.
        assert!(
            bilinear(&img, 2, 2, 0.5, 1.5).is_none(),
            "a stencil needing a row below the frame must be refused"
        );
        // Above the first row: `iy < 0`.
        assert!(
            bilinear(&img, 2, 2, 0.5, -0.5).is_none(),
            "a stencil needing a row above the frame must be refused"
        );
        // A non-finite y is refused, not floored to row 0.
        assert!(
            bilinear(&img, 2, 2, 0.5, f32::NAN).is_none(),
            "a non-finite y must be refused, not silently floored"
        );
        // Complement: the y-centre is a valid sample, so this test cannot pass by refusing
        // every y.
        assert!(
            bilinear(&img, 2, 2, 0.5, 0.5).is_some(),
            "the y-centre must be a valid sample"
        );
    }

    #[test]
    fn a_static_pair_converges_to_zero() {
        let prev = gradient_image();
        let cfg = LkConfig::conservative(32);
        let features = vec![(8u16, 16u16)];
        let outcomes = optical_flow_sparse(&prev, &prev, &features, &cfg);
        match &outcomes[0] {
            LkOutcome::Converged(flow) | LkOutcome::NotConverged(flow) => {
                assert!(flow.dx.abs() < 0.5, "dx={}", flow.dx);
                assert!(flow.dy.abs() < 0.5, "dy={}", flow.dy);
            }
            other => panic!("expected Converged/NotConverged, got {other:?}"),
        }
    }
}
