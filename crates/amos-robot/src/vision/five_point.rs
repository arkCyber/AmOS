//! Essential matrix estimation and pose recovery.
//!
//! References: Nistér, "An efficient solution to the five-point relative pose problem"
//! (CVPR 2003); Hartley, "In Defense of the Eight-Point Algorithm" (PAMI 19(6), 1997); and
//! Hartley & Zisserman §9.5.
//!
//! The 5-point algorithm is the standard *minimal* solver for a relative-pose front-end.
//! This crate implements the **eight-point** baseline instead, on top of Hartley
//! preconditioning (the `precondition` step below, which translates and scales each point
//! set to a canonical frame): Hartley's 1997 result is that the eight-point algorithm —
//! long dismissed as noise-sensitive — is comparable with the best iterative estimators
//! *once its inputs are normalised that way*, because that normalisation is what fixes the
//! condition of the linear system. Solving in the normalised image coordinates the caller
//! produces ([`CameraIntrinsics::normalise`]) is the calibrated analogue of that
//! preconditioning.
//!
//! The 5-point polynomial solver is **not** implemented: the 10-degree polynomial in
//! Gröbner-basis form is the natural extension point. Its advantage is largest in the
//! minimal regime — exactly five correspondences, and planar or otherwise degenerate
//! configurations where an over-determined eight-point solve is ill-posed — none of which
//! this crate's RANSAC-over-`n ≥ 8` path exercises (RANSAC here *samples* 8 but scores over
//! all `n`). The eight-point path below is the whole algorithm here.

use rand::rngs::SmallRng;
use rand::seq::SliceRandom;
use rand::SeedableRng;

/// The 2-D camera intrinsic parameters (in pixels). A real calibration is more elaborate;
/// the 5-point algorithm only needs `fx`, `fy`, `cx`, `cy` for the normalisation step.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CameraIntrinsics {
    /// Focal length in x (pixels).
    pub fx: f32,
    /// Focal length in y (pixels).
    pub fy: f32,
    /// Principal point x (pixels).
    pub cx: f32,
    /// Principal point y (pixels).
    pub cy: f32,
}

impl CameraIntrinsics {
    /// A reasonable pinhole approximation for a 640×480 image with a 60° horizontal FoV.
    pub fn typical_640x480() -> Self {
        Self {
            fx: 555.0,
            fy: 555.0,
            cx: 320.0,
            cy: 240.0,
        }
    }

    /// Normalise a pixel coordinate to the camera's normalised image plane.
    pub fn normalise(&self, x: f32, y: f32) -> (f32, f32) {
        ((x - self.cx) / self.fx, (y - self.cy) / self.fy)
    }
}

/// A 3×3 essential matrix (row-major).
pub type Essential = [f32; 9];

/// A 2-D pose recovered from an essential matrix: rotation `R` (3×3 row-major) and
/// translation direction `t` (unit length). The translation **magnitude is not
/// recoverable** from the essential matrix alone — the depth ambiguity is a property of
/// the geometry, not of the algorithm.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose2D {
    /// The 3×3 rotation matrix.
    pub rotation: [f32; 9],
    /// The unit translation direction.
    pub translation: [f32; 3],
    /// How many correspondences supported this pose. The **meaning is set by the producer**:
    /// [`recover_pose_from_essential`] fills it with the *cheirality* count (how many
    /// correspondences triangulate in front of both cameras for the chosen candidate), while
    /// [`ransac_essential`] overwrites it with the *Sampson inlier* count (how many
    /// correspondences fell inside the RANSAC threshold). The two are different quantities
    /// over the same correspondences; a caller that needs an inlier fraction should read it
    /// with [`Self::total`] and know which entry point produced the pose.
    pub inliers: u32,
    /// The total number of correspondences fed to RANSAC.
    pub total: u32,
}

/// The result of a single RANSAC iteration.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RansacReport {
    /// The best essential matrix found.
    pub essential: Essential,
    /// The best pose found.
    pub pose: Pose2D,
    /// The number of iterations actually run (≤ [`MAX_RANSAC_ITERATIONS`]).
    pub iterations: u32,
}

/// Largest RANSAC iteration count. The sample here is `n = 8` (the eight-point solver),
/// not 5, so the required count is `ln(1−p) / ln(1−w⁸)`: for a healthy `w = 0.7` and
/// `p = 0.999` that is ≈ 116, and 256 is a 2.2× margin. For much lower inlier ratios the
/// cap is *not* statistically sufficient — the loop's adaptive termination (below) is
/// what exits early when a good model is found, and this cap is the hard ceiling that
/// bounds the work.
pub const MAX_RANSAC_ITERATIONS: u32 = 256;

/// The default inlier threshold. This is the **squared Sampson distance in normalised
/// image-plane units** — the coordinates the caller passes are already normalised by
/// [`CameraIntrinsics::normalise`], so the unit is `tan(angle)²`, not pixels. A caller
/// working in pixels must divide by the focal length squared before comparing.
pub const DEFAULT_INLIER_THRESHOLD: f32 = 1.0;

/// Singular values at or below this fraction of the largest are treated as zero when
/// deciding whether the design matrix constrains a 2-D epipolar geometry.
const DEGENERATE_RANK_RATIO: f64 = 1e-9;

/// The norm below which a candidate basis vector is treated as undetermined.
const ORTHONORMAL_TOL: f64 = 1e-12;

/// Jacobi sweeps allowed for the 9×9 `MᵀM` eigen-solve. A sweep is `n(n−1)/2` rotations;
/// convergence is quadratic, so a handful of sweeps is ample, and the routine exits early
/// once the largest off-diagonal element is negligible.
const JACOBI_SWEEPS: u32 = 12;

/// Estimate the essential matrix from `n ≥ 8` correspondences using the eight-point
/// algorithm.
///
/// Returns `None` — never a plausible-looking but meaningless matrix — when the input
/// carries no 2-D epipolar information:
///   * fewer than 8 correspondences, or mismatched lengths;
///   * any non-finite coordinate;
///   * a rank-deficient design matrix (the second singular value collapses to zero, e.g.
///     all points coincident), where the "smallest singular vector" is arbitrary.
#[allow(
    clippy::identity_op,
    clippy::erasing_op,
    clippy::no_effect_underscore_binding
)] // the `+ 0`/`* 9` form mirrors the Hartley & Zisserman §9.5 matrix layout; rewriting to `i * 9` breaks the visual correspondence with the textbook.
pub fn essential_matrix_eight_point(a: &[(f32, f32)], b: &[(f32, f32)]) -> Option<Essential> {
    if a.len() < 8 || a.len() != b.len() {
        return None;
    }
    if a.iter()
        .chain(b.iter())
        .any(|&(x, y)| !x.is_finite() || !y.is_finite())
    {
        return None;
    }
    let n = a.len();
    // ① Centre and scale-normalise each point set (Hartley preconditioning).
    let (at, ta) = precondition(a);
    let (bt, tb) = precondition(b);
    // ② Build the 9×n design matrix.
    let mut m = vec![0.0f64; 9 * n];
    for i in 0..n {
        let (x1_raw, y1_raw) = at[i];
        let (x2_raw, y2_raw) = bt[i];
        let x1 = x1_raw as f64;
        let y1 = y1_raw as f64;
        let x2 = x2_raw as f64;
        let y2 = y2_raw as f64;
        // The row of M for the epipolar constraint `bᵀ E a = 0`, with the unknown vector
        // `e = [E11,E12,E13,E21,E22,E23,E31,E32,E33]` (row-major). Expanding
        // `x2·(E11·x1 + E12·y1 + E13) + y2·(E21·x1 + E22·y1 + E23) + (E31·x1 + E32·y1 + E33)`
        // gives the nine products below — each of `x1x2, x1y2, x1, y1x2, y1y2, y1, x2, y2, 1`
        // must appear exactly once, in the slot of the E entry it multiplies.
        m[i * 9 + 0] = x1 * x2; // E11
        m[i * 9 + 1] = y1 * x2; // E12
        m[i * 9 + 2] = x2; // E13
        m[i * 9 + 3] = x1 * y2; // E21
        m[i * 9 + 4] = y1 * y2; // E22
        m[i * 9 + 5] = y2; // E23
        m[i * 9 + 6] = x1; // E31
        m[i * 9 + 7] = y1; // E32
        m[i * 9 + 8] = 1.0; // E33
    }
    // ③ Solve M · e = 0 by the smallest singular vector of M (a power-iteration surrogate
    // is too crude; we accumulate `Mᵀ M` and take its smallest eigenvector via the Jacobi
    // sweep on the symmetric 9×9 — same shape as the planner's heuristic, but at 9×9
    // the cost is bounded by 9³ · iterations).
    let mut ata = vec![0.0f64; 9 * 9];
    for col in 0..9 {
        for row in 0..9 {
            let mut sum = 0.0f64;
            for i in 0..n {
                sum += m[i * 9 + col] * m[i * 9 + row];
            }
            ata[col * 9 + row] = sum;
        }
    }
    let mut v = identity_vec(9);
    // Jacobi needs a few sweeps to converge at 9×9; one sweep is n(n−1)/2 = 36 rotations,
    // so `JACOBI_SWEEPS × 36` bounds the work (the routine stops early once the largest
    // off-diagonal element is below its threshold). The old bound of 30 was *less than a
    // single sweep* and left the eigenvector unconverged.
    let eig = jacobi_eigen(ata, &mut v, JACOBI_SWEEPS * 36);
    let mut smallest_index = 0usize;
    let mut smallest_value = f64::INFINITY;
    for (i, value) in eig.iter().enumerate() {
        if *value < smallest_value {
            smallest_value = *value;
            smallest_index = i;
        }
    }
    // `jacobi_eigen` leaves the eigenvectors in the **columns** of `v`, so the eigenvector
    // for `smallest_index` is that column, `v[j * 9 + smallest_index]` — not the row
    // `v[smallest_index * 9 + j]`, which is a different (and non-null) vector.
    let mut ef = [0.0f64; 9];
    for j in 0..9 {
        ef[j] = v[j * 9 + smallest_index];
    }
    // ④ Enforce rank-2 by zeroing the smallest singular value (3×3 SVD via the Jacobi
    // routine).
    let (u, s, vt) = svd3x3(ef);
    // A rank-deficient design matrix (`s₁ ≈ 0` relative to `s₀`) means the correspondences
    // do not pin a 2-D epipolar geometry — the smallest singular vector is arbitrary and
    // the resulting "essential matrix" would be noise dressed as a transform. Refuse it.
    if !s[0].is_finite() || s[0] <= 0.0 || s[1] <= s[0] * DEGENERATE_RANK_RATIO {
        return None;
    }
    let s2 = [s[0], s[1], 0.0];
    let mut rank2 = [0.0f64; 9];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                rank2[i * 3 + j] += u[i * 3 + k] * s2[k] * vt[k * 3 + j];
            }
        }
    }
    // ⑤ De-condition: `a_norm = Ta·a_orig`, `b_norm = Tb·b_orig`, so the constraint
    // `b_normᵀ E_norm a_norm = 0` becomes `b_origᵀ (Tbᵀ·E_norm·Ta) a_orig = 0` — that is,
    // `E_orig = Tbᵀ · E_norm · Ta`. (The previous code multiplied `Ta` on the left and
    // `Tb` on the right, the transpose-pair of the correct product.)
    let mut out = [0.0f32; 9];
    for r in 0..3 {
        for c in 0..3 {
            let mut acc = 0.0f64;
            for i in 0..3 {
                for j in 0..3 {
                    acc += tb[i * 3 + r] * rank2[i * 3 + j] * ta[j * 3 + c];
                }
            }
            out[r * 3 + c] = acc as f32;
        }
    }
    Some(out)
}

/// Recover a 2-D pose (rotation + translation direction) from the essential matrix.
///
/// Picks the rotation in front of the cameras (the standard "cheirality check") and the
/// translation direction such that the triangulated points are in front of **both**
/// cameras.
///
/// Returns `None` — never a plausible-looking but unsupported pose — when:
///   * the correspondence lists are empty or of unequal length;
///   * any entry of `essential` is non-finite;
///   * **no** correspondence triangulates in front of both cameras for *any* of the four
///     `(R, t)` candidates. The initial guess (`candidates[0]`) is only a tie-break among
///     candidates that scored `> 0`; a zero best score means the matrix explains nothing,
///     and returning that untested candidate would be a fabricated motion. (An earlier
///     revision could return exactly that: a zero essential matrix yielded `Some` with
///     `inliers: 0` and an arbitrary rotation built from the undetermined SVD frame.)
pub fn recover_pose_from_essential(
    essential: &Essential,
    a: &[(f32, f32)],
    b: &[(f32, f32)],
) -> Option<Pose2D> {
    if a.len() != b.len() || a.is_empty() {
        return None;
    }
    if essential.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let mut e = [0.0f64; 9];
    for i in 0..9 {
        e[i] = essential[i] as f64;
    }
    let (u, _s, vt) = svd3x3(e);
    // The two rotation solutions of `E = U diag(1,1,0) Vᵀ` are `U·W·Vᵀ` and `U·Wᵀ·Vᵀ`
    // with W = [[0,-1,0],[1,0,0],[0,0,1]]. Both are proper rotations (det = +1); `−R` is
    // a *reflection* (det = −1) and is not a pose, so the candidate set must use R₂, not
    // `−R₁`.
    let w = [0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    let w_t = [0.0, 1.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    let r1 = matmul3(matmul3(u, w), vt);
    let r2 = matmul3(matmul3(u, w_t), vt);
    // Translation is ±the third column of U (or its negation); the SVD noise makes it
    // slightly off unit, so we normalise it before scoring.
    let raw_t: [f64; 3] = [u[2], u[5], u[8]];
    let t_norm = (raw_t[0] * raw_t[0] + raw_t[1] * raw_t[1] + raw_t[2] * raw_t[2])
        .sqrt()
        .max(1e-12);
    let t_z: [f64; 3] = [raw_t[0] / t_norm, raw_t[1] / t_norm, raw_t[2] / t_norm];
    let neg_tz = [-t_z[0], -t_z[1], -t_z[2]];
    // The four (R, t) candidates; the cheirality check picks the physically consistent one.
    let candidates = [(r1, t_z), (r1, neg_tz), (r2, t_z), (r2, neg_tz)];
    let mut best = (0usize, 0u32);
    for (idx, (r, t)) in candidates.iter().enumerate() {
        let in_front = cheirality_count(a, b, r, t);
        if in_front > best.1 {
            best = (idx, in_front);
        }
    }
    // No candidate put even one correspondence in front of both cameras: the matrix carries
    // no recoverable motion over this data, so there is no honest pose to report.
    if best.1 == 0 {
        return None;
    }
    let r_best = candidates[best.0].0;
    let t_best = candidates[best.0].1;
    // Project the rotation back to SO(3) via the nearest orthonormal matrix:
    // Gram–Schmidt on the first two columns, then a cross-product for the third.
    // A non-unit rotation is the failure mode the aerospace-grade recover has to
    // refuse (a pose that drifts in scale is not a pose).
    let r_so3 = enforce_rotation(&r_best)?;
    Some(Pose2D {
        rotation: r_so3,
        translation: [t_best[0] as f32, t_best[1] as f32, t_best[2] as f32],
        inliers: best.1,
        total: a.len() as u32,
    })
}

/// Project a 3×3 row-major matrix onto SO(3): the closest rotation matrix in
/// Frobenius norm. This is the Hartleys–Hastie step the textbook recovery
/// needs after `U · W · Vᵀ` to fix SVD noise.
///
/// Returns `None` when the input has no rotation to project onto — a zero first row, or a
/// second row parallel to the first. In that case there is no honest rotation to report,
/// and returning a fabricated one (the old `.max(1e-12)` silently produced the zero matrix)
/// would let a `NaN`-adjacent pose through.
fn enforce_rotation(m: &[f64; 9]) -> Option<[f32; 9]> {
    // Row 0, normalised.
    let row0 = [m[0], m[1], m[2]];
    let n0 = norm3(row0);
    if n0 <= ORTHONORMAL_TOL {
        return None;
    }
    let r0 = [row0[0] / n0, row0[1] / n0, row0[2] / n0];
    // Row 1, orthogonalised against row 0.
    let row1 = [m[3], m[4], m[5]];
    let dot = dot3(r0, row1);
    let proj = [
        row1[0] - dot * r0[0],
        row1[1] - dot * r0[1],
        row1[2] - dot * r0[2],
    ];
    let n1 = norm3(proj);
    if n1 <= ORTHONORMAL_TOL {
        return None;
    }
    let r1 = [proj[0] / n1, proj[1] / n1, proj[2] / n1];
    // Row 2 = r0 × r1.
    let r2 = cross3(r0, r1);
    Some([
        r0[0] as f32,
        r0[1] as f32,
        r0[2] as f32,
        r1[0] as f32,
        r1[1] as f32,
        r1[2] as f32,
        r2[0] as f32,
        r2[1] as f32,
        r2[2] as f32,
    ])
}

/// RANSAC over [`essential_matrix_eight_point`] + [`recover_pose_from_essential`].
///
/// `seed` makes the iteration reproducible: a regression test passes the same seed and
/// expects the same pose. This is the aerospace rule: every random decision is pinned.
pub fn ransac_essential(
    a: &[(f32, f32)],
    b: &[(f32, f32)],
    threshold: f32,
    max_iterations: u32,
    seed: u64,
) -> Option<RansacReport> {
    if a.len() < 8 || a.len() != b.len() {
        return None;
    }
    let mut rng = SmallRng::seed_from_u64(seed);
    let mut indices: Vec<usize> = (0..a.len()).collect();
    let mut best_inliers: u32 = 0;
    let mut best_essential: Option<Essential> = None;
    let mut best_iteration: u32 = 0;

    let iterations = max_iterations.min(MAX_RANSAC_ITERATIONS);
    for it in 0..iterations {
        indices.shuffle(&mut rng);
        let sample: Vec<usize> = indices.iter().take(8).copied().collect();
        let a_sample: Vec<(f32, f32)> = sample.iter().map(|&i| a[i]).collect();
        let b_sample: Vec<(f32, f32)> = sample.iter().map(|&i| b[i]).collect();
        let Some(ess) = essential_matrix_eight_point(&a_sample, &b_sample) else {
            continue;
        };
        let inliers = count_inliers(&ess, a, b, threshold);
        if inliers > best_inliers {
            best_inliers = inliers;
            best_essential = Some(ess);
            best_iteration = it + 1;
            // Early termination if the inlier ratio is high enough that further
            // iterations are unlikely to improve on the model.
            let ratio = inliers as f64 / a.len() as f64;
            if ratio > 0.0 {
                let eight = (1.0 - ratio.powi(8)).max(1e-12);
                let required = ((1.0 - 0.999_f64).ln() / eight.ln()).ceil() as u32;
                if required < it {
                    break;
                }
            }
        }
    }

    let essential = best_essential?;
    let pose = recover_pose_from_essential(&essential, a, b)?;
    Some(RansacReport {
        essential,
        pose: Pose2D {
            inliers: best_inliers,
            total: pose.total,
            ..pose
        },
        iterations: best_iteration,
    })
}

/// Sampson distance, the geometric error the RANSAC inlier test uses.
fn sampson_distance(essential: &Essential, a: (f32, f32), b: (f32, f32)) -> f32 {
    // The Sampson distance is the geometric refinement of the algebraic error
    // `a' E b`: it divides the squared residual by the gradient of the error
    // with respect to the measurement. For a single correspondence
    // `(a, b)` and essential matrix `E`, with `e_p = E' b` and `e_l = E a`:
    //
    //     d = (a' E b)² / ( ‖e_l[0..2]‖² + ‖e_p[0..2]‖² )
    //
    // (the third component is dropped because fixing one variable pins the
    // scale of the homogeneous measurement).
    let eb = [
        essential[0] * b.0 + essential[3] * b.1 + essential[6],
        essential[1] * b.0 + essential[4] * b.1 + essential[7],
        essential[2] * b.0 + essential[5] * b.1 + essential[8],
    ];
    let ea = [
        essential[0] * a.0 + essential[1] * a.1 + essential[2],
        essential[3] * a.0 + essential[4] * a.1 + essential[5],
        essential[6] * a.0 + essential[7] * a.1 + essential[8],
    ];
    let num = a.0 * eb[0] + a.1 * eb[1] + eb[2];
    let denom = ea[0] * ea[0] + ea[1] * ea[1] + eb[0] * eb[0] + eb[1] * eb[1];
    if denom < 1e-9 {
        return f32::INFINITY;
    }
    // Every intermediate here is `f32`: `Essential` is `[f32; 9]` and the two
    // correspondences are `(f32, f32)`, so `eb`, `ea`, `num` and `denom` are all `f32`
    // and there is no `f64` work to narrow. (An earlier revision wrote `… as f32` behind
    // an `#[allow(clippy::unnecessary_cast)]` justified by a claim of "intermediate
    // `f64` work"; clippy flags the cast and the claim was false — the cast was a
    // genuine no-op and removing it changes no bits.)
    num * num / denom
}

fn count_inliers(essential: &Essential, a: &[(f32, f32)], b: &[(f32, f32)], threshold: f32) -> u32 {
    let mut n = 0u32;
    for i in 0..a.len() {
        if sampson_distance(essential, a[i], b[i]) <= threshold {
            n = n.saturating_add(1);
        }
    }
    n
}

fn precondition(points: &[(f32, f32)]) -> (Vec<(f32, f32)>, [f64; 9]) {
    let n = points.len() as f64;
    let mut cx = 0.0f64;
    let mut cy = 0.0f64;
    for &(x, y) in points {
        cx += x as f64;
        cy += y as f64;
    }
    cx /= n;
    cy /= n;
    let mut avg_dist = 0.0f64;
    for &(x, y) in points {
        let dx = x as f64 - cx;
        let dy = y as f64 - cy;
        avg_dist += (dx * dx + dy * dy).sqrt();
    }
    avg_dist /= n;
    let scale = if avg_dist > 1e-9 {
        (2.0f64).sqrt() / avg_dist
    } else {
        1.0
    };
    let t = [
        scale,
        0.0,
        -scale * cx,
        0.0,
        scale,
        -scale * cy,
        0.0,
        0.0,
        1.0,
    ];
    let mut out = Vec::with_capacity(points.len());
    for &(x, y) in points {
        out.push((
            ((x as f64 - cx) * scale) as f32,
            ((y as f64 - cy) * scale) as f32,
        ));
    }
    (out, t)
}

/// Cheirality check: how many correspondences are in front of **both** cameras for a
/// candidate `(R, t)`.
///
/// `a` and `b` are in the **normalised** image plane. For each pair we solve the depth
/// pair `(λ1, λ2)` that best explains the two rays under the candidate motion
/// `X₂ = R·X₁ + t`:
///
/// ```text
///     λ2 · d2 − λ1 · R·d1 = t ,   d1 = (x1, y1, 1),  d2 = (x2, y2, 1)
/// ```
///
/// This is a 3-equation, 2-unknown linear least-squares problem; the `2×2` normal
/// equations give `λ1`, `λ2` in closed form. Since `d` carries `z = 1`, `λ` *is* the
/// depth along the optical axis, so "in front of both cameras" is simply `λ1 > 0` **and**
/// `λ2 > 0`. A degenerate pair (the two rays are parallel, `det ≈ 0`) is not counted — it
/// carries no depth evidence either way.
///
/// Because `t` is unit length, the depths are in units of `|t|`; only their sign is used.
fn cheirality_count(a: &[(f32, f32)], b: &[(f32, f32)], r: &[f64; 9], t: &[f64; 3]) -> u32 {
    let mut count = 0u32;
    for i in 0..a.len() {
        // Ray directions in their own camera frames (`z = 1`).
        let d1 = [a[i].0 as f64, a[i].1 as f64, 1.0];
        let d2 = [b[i].0 as f64, b[i].1 as f64, 1.0];
        // Rotate the first ray into the second camera's frame.
        let rd1 = [
            r[0] * d1[0] + r[1] * d1[1] + r[2] * d1[2],
            r[3] * d1[0] + r[4] * d1[1] + r[5] * d1[2],
            r[6] * d1[0] + r[7] * d1[1] + r[8] * d1[2],
        ];
        let aa = rd1[0] * rd1[0] + rd1[1] * rd1[1] + rd1[2] * rd1[2];
        let bb = rd1[0] * d2[0] + rd1[1] * d2[1] + rd1[2] * d2[2];
        let cc = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2];
        let det = aa * cc - bb * bb;
        if det.abs() < 1e-12 {
            continue; // parallel rays: no depth evidence
        }
        let rhs1 = -(rd1[0] * t[0] + rd1[1] * t[1] + rd1[2] * t[2]);
        let rhs2 = d2[0] * t[0] + d2[1] * t[1] + d2[2] * t[2];
        let lambda1 = (cc * rhs1 + bb * rhs2) / det;
        let lambda2 = (bb * rhs1 + aa * rhs2) / det;
        if lambda1.is_finite() && lambda2.is_finite() && lambda1 > 0.0 && lambda2 > 0.0 {
            count = count.saturating_add(1);
        }
    }
    count
}

// ----- 3×3 helpers (Jacobi + SVD) -----

fn matmul3(a: [f64; 9], b: [f64; 9]) -> [f64; 9] {
    let mut out = [0.0f64; 9];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                out[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
            }
        }
    }
    out
}

fn transpose3(a: [f64; 9]) -> [f64; 9] {
    let mut out = [0.0f64; 9];
    for i in 0..3 {
        for j in 0..3 {
            out[j * 3 + i] = a[i * 3 + j];
        }
    }
    out
}

fn identity_vec(n: usize) -> Vec<f64> {
    let mut out = vec![0.0f64; n * n];
    for i in 0..n {
        out[i * n + i] = 1.0;
    }
    out
}

/// Classical Jacobi eigenvalue decomposition for symmetric matrices. Returns the
/// eigenvalues (diagonal of the diagonalised matrix). The eigenvectors accumulate in
/// `v` (the rotation matrix).
fn jacobi_eigen(mut a: Vec<f64>, v: &mut [f64], max_iter: u32) -> Vec<f64> {
    let n = ((a.len() as f64).sqrt()) as usize;
    debug_assert!(n * n == a.len());
    debug_assert!(v.len() == n * n);
    let mut iter = 0;
    while iter < max_iter {
        // Find the off-diagonal element with the largest absolute value.
        let mut p = 0usize;
        let mut q = 1usize;
        let mut max = 0.0f64;
        for i in 0..n {
            for j in (i + 1)..n {
                let v_ij = (a[i * n + j]).abs();
                if v_ij > max {
                    max = v_ij;
                    p = i;
                    q = j;
                }
            }
        }
        if max < 1e-12 {
            break;
        }
        let app = a[p * n + p];
        let aqq = a[q * n + q];
        let apq = a[p * n + q];
        let theta = if (aqq - app).abs() < 1e-30 {
            std::f64::consts::FRAC_PI_4
        } else {
            0.5 * (2.0 * apq / (aqq - app)).atan()
        };
        let cs = theta.cos();
        let sn = theta.sin();
        let app_new = cs * cs * app - 2.0 * cs * sn * apq + sn * sn * aqq;
        let aqq_new = sn * sn * app + 2.0 * cs * sn * apq + cs * cs * aqq;
        a[p * n + p] = app_new;
        a[q * n + q] = aqq_new;
        a[p * n + q] = 0.0;
        a[q * n + p] = 0.0;
        for i in 0..n {
            if i != p && i != q {
                let aip = a[i * n + p];
                let aiq = a[i * n + q];
                a[i * n + p] = cs * aip - sn * aiq;
                a[i * n + q] = sn * aip + cs * aiq;
                a[p * n + i] = a[i * n + p];
                a[q * n + i] = a[i * n + q];
            }
            let vip = v[i * n + p];
            let viq = v[i * n + q];
            v[i * n + p] = cs * vip - sn * viq;
            v[i * n + q] = sn * vip + cs * viq;
        }
        iter += 1;
    }
    let mut eig = vec![0.0f64; n];
    for i in 0..n {
        eig[i] = a[i * n + i];
    }
    eig
}

/// 3×3 SVD via Jacobi on `AᵀA`. Returns `U`, `S`, `Vᵀ` (3×3 each), with the singular
/// values in **descending** order (`s[0] ≥ s[1] ≥ s[2] ≥ 0`).
///
/// The descending order is load-bearing: every caller treats `s[2]` as the smallest (the
/// rank-2 truncation zeroes it) and reads `u`'s third column as the null-space direction
/// (the translation of the essential matrix). `jacobi_eigen` returns eigenvalues in
/// unsorted diagonal order, so the permutation below is what makes the callers' indexing
/// assumptions true.
fn svd3x3(a: [f64; 9]) -> ([f64; 9], [f64; 3], [f64; 9]) {
    let ata = matmul3(transpose3(a), a);
    let mut v = identity_vec(3);
    let eig = jacobi_eigen(ata.to_vec(), &mut v, 30);
    // Sort the eigen-decomposition by descending eigenvalue, permuting `v`'s eigenvector
    // *columns* in lockstep so `v`'s column `j` still belongs to `eig[j]`.
    let mut order = [0usize, 1, 2];
    // Insertion sort on three elements (no allocation, no `while`, fixed bound).
    for i in 1..3 {
        let key = order[i];
        let key_val = eig[key];
        let mut j = i;
        while j > 0 && eig[order[j - 1]] < key_val {
            order[j] = order[j - 1];
            j -= 1;
        }
        order[j] = key;
    }
    let mut v_sorted = [0.0f64; 9];
    let mut s_sorted = [0.0f64; 3];
    for j in 0..3 {
        let src = order[j];
        s_sorted[j] = eig[src].max(0.0).sqrt();
        for i in 0..3 {
            v_sorted[i * 3 + j] = v[i * 3 + src];
        }
    }
    let s = s_sorted;
    // `v_sorted` is row-major with the eigenvectors in its *columns* (`V[i][j] =
    // v_sorted[i*3+j]`), so `Vᵀ` is the index-swapped gather below.
    let vt = [
        v_sorted[0],
        v_sorted[3],
        v_sorted[6],
        v_sorted[1],
        v_sorted[4],
        v_sorted[7],
        v_sorted[2],
        v_sorted[5],
        v_sorted[8],
    ];
    // U = A · V · S⁻¹: column `j` is scaled by `1/s[j]` — the singular value that belongs
    // to *that* column — so the divisor is indexed by `j`, never by the summation index
    // `k`. A singular value of zero (a rank-deficient `A`) leaves that column untold by
    // `A`; it is left zero here rather than dividing by zero, and `orthonormal_frame`
    // completes it from the columns that *are* determined.
    let mut u = [0.0f64; 9];
    for j in 0..2 {
        if s[j] <= 0.0 {
            continue;
        }
        let inv = 1.0 / s[j];
        for i in 0..3 {
            let mut sum = 0.0f64;
            for k in 0..3 {
                sum += a[i * 3 + k] * v_sorted[k * 3 + j];
            }
            u[i * 3 + j] = sum * inv;
        }
    }
    // The third left singular vector: for a full-rank `A` it is `A·v₂/s₂`, but the
    // essential matrix is rank-2 by construction so `s₂ ≈ 0` and that column would be
    // undetermined (and `1/s₂` a division by ~0). Complete the orthonormal basis with the
    // cross product of the first two columns instead — for a rank-2 `A` this is exactly
    // the left null vector (the translation direction). Its sign is arbitrary, which is
    // harmless: `recover_pose_from_essential` tests both `+t` and `−t`.
    //
    // `orthonormal_frame` is what makes this function total: a column left zero by a zero
    // singular value, or left non-unit by rounding, is replaced by a Gram–Schmidt
    // completion instead of carrying `inf`/`NaN` into the caller.
    (orthonormal_frame(u), s, vt)
}

/// Orthonormalise the three columns of the row-major 3×3 `m` into a right-handed frame.
///
/// This is the guard that keeps [`svd3x3`] total. A singular value of zero leaves `A·v/s`
/// undefined; rather than yield `inf`/`NaN`, that column arrives here as zero and is
/// replaced by a Gram–Schmidt completion of the two that are determined.
fn orthonormal_frame(m: [f64; 9]) -> [f64; 9] {
    let col0 = [m[0], m[3], m[6]];
    let n0 = norm3(col0);
    let e0 = if n0 > ORTHONORMAL_TOL {
        [col0[0] / n0, col0[1] / n0, col0[2] / n0]
    } else {
        [1.0, 0.0, 0.0]
    };
    let col1 = [m[1], m[4], m[7]];
    let d1 = dot3(e0, col1);
    let proj = [
        col1[0] - d1 * e0[0],
        col1[1] - d1 * e0[1],
        col1[2] - d1 * e0[2],
    ];
    let n1 = norm3(proj);
    let e1 = if n1 > ORTHONORMAL_TOL {
        [proj[0] / n1, proj[1] / n1, proj[2] / n1]
    } else {
        // `col1` is parallel to `col0` (or zero): any unit vector perpendicular to `e0`.
        perpendicular(e0)
    };
    let e2 = cross3(e0, e1);
    [
        e0[0], e1[0], e2[0], //
        e0[1], e1[1], e2[1], //
        e0[2], e1[2], e2[2],
    ]
}

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm3(a: [f64; 3]) -> f64 {
    dot3(a, a).sqrt()
}

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// A unit vector perpendicular to `u` (which is assumed unit). Crosses with whichever
/// basis vector is least aligned, so the result is never near-degenerate.
fn perpendicular(u: [f64; 3]) -> [f64; 3] {
    let basis = if u[0].abs() <= u[1].abs() && u[0].abs() <= u[2].abs() {
        [1.0, 0.0, 0.0]
    } else if u[1].abs() <= u[2].abs() {
        [0.0, 1.0, 0.0]
    } else {
        [0.0, 0.0, 1.0]
    };
    let c = cross3(u, basis);
    let n = norm3(c);
    [c[0] / n, c[1] / n, c[2] / n]
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::Rng;

    /// A synthetic frame pair with the ground-truth rotation/translation.
    type SyntheticMotion = (Vec<(f32, f32)>, Vec<(f32, f32)>, [f64; 9], [f64; 3]);

    fn synthetic_camera_motion(seed: u64) -> SyntheticMotion {
        // Build a synthetic scene: 20 3-D points at random depths, observed by a
        // camera that translates by (0.1, 0.0, 0.0) and rotates by 1° around z.
        let mut rng = SmallRng::seed_from_u64(seed);
        let mut pts3d = Vec::new();
        for _ in 0..20 {
            pts3d.push([
                (rng.gen_range(-1.0..1.0) * 5.0),
                rng.gen_range(-1.0..1.0) * 5.0,
                2.0 + rng.gen_range(-1.0..1.0),
            ]);
        }
        let theta = 1.0_f64.to_radians();
        let r = [
            theta.cos(),
            -theta.sin(),
            0.0,
            theta.sin(),
            theta.cos(),
            0.0,
            0.0,
            0.0,
            1.0,
        ];
        let t = [0.1, 0.0, 0.0];
        let mut a = Vec::new();
        let mut b = Vec::new();
        for p in &pts3d {
            // Project into the first frame (camera at origin, looking down +z).
            let x_a = p[0] / p[2];
            let y_a = p[1] / p[2];
            // Project into the second frame.
            let p_b = [
                r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + t[0],
                r[3] * p[0] + r[4] * p[1] + r[5] * p[2] + t[1],
                r[6] * p[0] + r[7] * p[1] + r[8] * p[2] + t[2],
            ];
            let x_b = p_b[0] / p_b[2];
            let y_b = p_b[1] / p_b[2];
            a.push((x_a as f32, y_a as f32));
            b.push((x_b as f32, y_b as f32));
        }
        (a, b, r, t)
    }

    #[test]
    fn the_eight_point_solver_recovers_a_synthetic_motion() {
        let (a, b, r_gt, t_gt) = synthetic_camera_motion(42);
        let ess = essential_matrix_eight_point(&a, &b).expect("essential");
        let pose = recover_pose_from_essential(&ess, &a, &b).expect("pose");

        // The recovered rotation must match the *ground truth* (1° about z), not merely
        // be some orthonormal matrix — `enforce_rotation` guarantees orthonormality for
        // any input, so checking that alone proves nothing.
        for (i, expected) in r_gt.iter().enumerate() {
            let diff = (pose.rotation[i] - *expected as f32).abs();
            assert!(
                diff < 0.05,
                "rotation[{i}] = {} vs ground truth {} (diff {diff})",
                pose.rotation[i],
                expected
            );
        }
        // A rotation, not a reflection: det(R) must be +1.
        let det = pose.rotation[0]
            * (pose.rotation[4] * pose.rotation[8] - pose.rotation[5] * pose.rotation[7])
            - pose.rotation[1]
                * (pose.rotation[3] * pose.rotation[8] - pose.rotation[5] * pose.rotation[6])
            + pose.rotation[2]
                * (pose.rotation[3] * pose.rotation[7] - pose.rotation[4] * pose.rotation[6]);
        assert!((det - 1.0).abs() < 1e-3, "det(R) = {det}, not a rotation");

        // Translation is a direction (magnitude not recoverable); the *sign* is fixed by
        // cheirality, so it must point along the ground-truth `(0.1, 0, 0)`.
        let t_len = (pose.translation[0].powi(2)
            + pose.translation[1].powi(2)
            + pose.translation[2].powi(2))
        .sqrt();
        assert!((t_len - 1.0).abs() < 1e-5, "t not unit: {t_len}");
        let t_gt_len = (t_gt[0] * t_gt[0] + t_gt[1] * t_gt[1] + t_gt[2] * t_gt[2]).sqrt();
        let dot = (pose.translation[0] as f64 * t_gt[0]
            + pose.translation[1] as f64 * t_gt[1]
            + pose.translation[2] as f64 * t_gt[2])
            / t_gt_len;
        assert!(
            dot > 0.9,
            "t = {:?} not aligned with ground truth {t_gt:?}",
            pose.translation
        );
    }

    #[test]
    fn ransac_finds_inliers_under_contamination() {
        let (a, b, _r, _t) = synthetic_camera_motion(7);
        let mut a_noisy = a.clone();
        let mut b_noisy = b.clone();
        // Replace 6 of 20 with pure noise.
        for i in 0..6 {
            a_noisy[i] = (10.0 + i as f32, -10.0 - i as f32);
            b_noisy[i] = (-10.0 - i as f32, 10.0 + i as f32);
        }
        // The points are in *normalised* image-plane coordinates, so the threshold is a
        // squared normalised distance (see `DEFAULT_INLIER_THRESHOLD`), not pixels. The
        // 8-point estimator is noisy on a small sample, so a tight threshold would
        // discard genuine inliers; 1.0 is a loose bound that keeps the 14 true matches.
        let report = ransac_essential(&a_noisy, &b_noisy, 1.0, 200, 11).expect("ransac");
        assert!(
            report.pose.inliers >= 12,
            "got {} inliers",
            report.pose.inliers
        );
    }

    #[test]
    fn fewer_than_eight_points_is_refused() {
        let a = vec![(0.0, 0.0); 7];
        let b = vec![(0.0, 0.0); 7];
        assert!(essential_matrix_eight_point(&a, &b).is_none());
    }

    /// Coincident correspondences leave the design matrix rank-deficient: the second
    /// singular value collapses and there is no epipolar geometry to recover. Must be
    /// `None`, not a plausible-looking matrix built from numerical noise.
    #[test]
    fn a_rank_deficient_set_is_refused() {
        let a = vec![(0.5, 0.5); 10];
        let b = vec![(0.5, 0.5); 10];
        assert!(
            essential_matrix_eight_point(&a, &b).is_none(),
            "all-coincident points must not yield an essential matrix"
        );
    }

    /// A non-finite coordinate poisons every downstream product; it is refused up front.
    #[test]
    fn a_non_finite_coordinate_is_refused() {
        let a = vec![(0.0, 0.0); 8];
        let mut b = vec![(0.1, 0.1); 8];
        b[3] = (f32::NAN, 0.0);
        assert!(essential_matrix_eight_point(&a, &b).is_none());
    }

    /// Every coordinate field of the two point sets — the `x` **and** `y` of both `a` and `b` —
    /// is refused when non-finite.
    ///
    /// This test exists because the guard's `!y.is_finite()` half had no case at all:
    /// `a_non_finite_coordinate_is_refused` breaks only an **x** (`b[3] = (NAN, 0.0)`). With
    /// `|| !y.is_finite()` deleted the whole suite stayed green (367 passed) — and its loss is
    /// not cosmetic: a point with a finite `x` but a non-finite `y` clears the guard, is
    /// preconditioned, and is fed to the SVD, poisoning the design matrix into either a `NaN`
    /// essential matrix or an arbitrary one built from numerical noise. Same family as the robot
    /// stack's other input guards (REQ-A725/A728/A733/A737/A746/A752): a guard is only as good as
    /// the conditions someone pins.
    #[test]
    fn every_non_finite_coordinate_field_is_refused() {
        let (a, b, ..) = synthetic_camera_motion(42);
        /// One way to break the input: set one coordinate of one point to a non-finite value.
        type Corrupt = fn(&mut (f32, f32));
        let bad: [(&str, Corrupt); 4] = [
            ("a.x", |p| p.0 = f32::NAN),
            ("a.y", |p| p.1 = f32::INFINITY),
            ("b.x", |p| p.0 = f32::NEG_INFINITY),
            ("b.y", |p| p.1 = f32::NAN),
        ];
        for (field, corrupt) in bad {
            let (mut a, mut b, ..) = synthetic_camera_motion(42);
            if field.starts_with('a') {
                corrupt(&mut a[3]);
            } else {
                corrupt(&mut b[3]);
            }
            assert!(
                essential_matrix_eight_point(&a, &b).is_none(),
                "a non-finite {field} must be refused, not fed to the SVD"
            );
        }
        // The complement, so this test cannot pass by refusing everything: the untouched
        // synthetic motion must still yield a matrix.
        assert!(
            essential_matrix_eight_point(&a, &b).is_some(),
            "well-formed correspondences must yield an essential matrix"
        );
    }

    /// A non-finite essential matrix is refused by the pose recovery rather than returned
    /// as a `Some` full of `NaN`s.
    #[test]
    fn a_non_finite_essential_is_refused_by_recovery() {
        let ess = [f32::NAN; 9];
        let a = vec![(0.0, 0.0); 8];
        let b = vec![(0.1, 0.1); 8];
        assert!(recover_pose_from_essential(&ess, &a, &b).is_none());
    }

    /// A matrix with no rotation in it is refused, not silently projected to the zero
    /// matrix (the old `.max(1e-12)` behaviour).
    #[test]
    fn enforce_rotation_refuses_degenerate_input() {
        assert!(enforce_rotation(&[0.0; 9]).is_none(), "zero matrix");
        // Row 0 valid, row 1 parallel to it: no second independent axis.
        let parallel = [1.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        assert!(enforce_rotation(&parallel).is_none(), "parallel rows");
        // And a genuine rotation projects to itself (rows are the identity).
        let ident = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let r = enforce_rotation(&ident).expect("identity is a rotation");
        assert_eq!(r, [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
    }

    /// `svd3x3` must always return an orthonormal frame, even for a zero matrix — this is
    /// the property that keeps `recover_pose_from_essential` from emitting a `NaN` pose.
    #[test]
    fn the_svd_frame_is_orthonormal_for_a_degenerate_input() {
        let (u, s, vt) = svd3x3([0.0; 9]);
        for c in [u, vt] {
            for i in 0..3 {
                for j in 0..3 {
                    let col_i = [c[i], c[3 + i], c[6 + i]];
                    let col_j = [c[j], c[3 + j], c[6 + j]];
                    let expect = if i == j { 1.0 } else { 0.0 };
                    let got = dot3(col_i, col_j);
                    assert!(
                        (got - expect).abs() < 1e-9,
                        "columns {i},{j} dot to {got}, not {expect}"
                    );
                }
            }
        }
        assert!(s.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn the_sampson_distance_is_near_zero_for_a_satisfying_pair() {
        let (a, b, _r, _t) = synthetic_camera_motion(1);
        let ess = essential_matrix_eight_point(&a, &b).expect("essential");
        // The correspondence was used to *fit* `ess`, so its Sampson residual must be
        // near zero — orders of magnitude below the RANSAC threshold of 1.0, not merely
        // under it. (Asserting only `< 1.0` would pass for an unrelated bad pair too.)
        let d = sampson_distance(&ess, a[0], b[0]);
        assert!(d < 1e-3, "sampson d={d} for an in-sample pair");
        // And a correspondence that violates the geometry must be far outside.
        let bad = sampson_distance(&ess, a[0], (b[0].0 + 50.0, b[0].1 - 50.0));
        assert!(bad > 1.0, "sampson d={bad} for a violating pair");
    }

    /// The two guards on the RANSAC entry point: it needs at least eight *matching* pairs,
    /// and a short or ragged input must be refused before the sampler indexes `b[i]`.
    #[test]
    fn ransac_refuses_a_short_or_ragged_input() {
        let (a, b, _r, _t) = synthetic_camera_motion(7);
        assert!(
            ransac_essential(&a[..7], &b[..7], 1.0, 200, 3).is_none(),
            "seven pairs is below the eight-point minimum"
        );
        assert!(
            ransac_essential(&a, &b[..b.len() - 1], 1.0, 200, 3).is_none(),
            "a length mismatch must be refused, not indexed out of bounds"
        );
    }

    /// Every 8-sample drawn from an all-coincident set is rank-deficient, so the solver
    /// returns `None` on each and RANSAC must exhaust its budget and report no model —
    /// exercising the `continue` that skips a failed minimal solve.
    #[test]
    fn ransac_skips_every_degenerate_sample_and_reports_no_model() {
        let a = vec![(0.5f32, 0.5f32); 12];
        let b = a.clone();
        assert!(
            ransac_essential(&a, &b, 1.0, 50, 5).is_none(),
            "a set with no epipolar geometry must yield no model"
        );
    }

    /// The pose-recovery guard: it requires equal-length, non-empty correspondences before
    /// touching the solves, so a ragged or empty call is `None` rather than a panic.
    #[test]
    fn pose_recovery_refuses_empty_or_ragged_correspondences() {
        let (a, b, _r, _t) = synthetic_camera_motion(21);
        let ess = essential_matrix_eight_point(&a, &b).expect("essential");
        assert!(
            recover_pose_from_essential(&ess, &[], &[]).is_none(),
            "empty"
        );
        assert!(
            recover_pose_from_essential(&ess, &a, &b[..b.len() - 1]).is_none(),
            "ragged lengths must be refused"
        );
    }

    /// A degenerate essential matrix drives the Sampson denominator to zero; the distance
    /// must read as `INFINITY` (an unusable residual) rather than `0/0 = NaN`, which would
    /// compare false against every threshold and silently count as an inlier.
    #[test]
    fn a_degenerate_sampson_denominator_is_infinite_not_nan() {
        let d = sampson_distance(&[0.0; 9], (0.0, 0.0), (0.0, 0.0));
        assert_eq!(
            d,
            f32::INFINITY,
            "a zero denominator is an unusable residual"
        );
        assert!(!d.is_nan());
    }

    /// A matrix that explains no correspondence is refused, not turned into the untested
    /// first `(R, t)` candidate. The zero essential matrix has no motion in it; every
    /// candidate's cheirality count is zero (an all-zero `E` also makes every ray pair
    /// parallel, so each correspondence is skipped), and the old code returned
    /// `Some { inliers: 0, rotation: <arbitrary SVD frame> }`.
    #[test]
    fn a_pose_with_no_in_front_correspondence_is_refused() {
        let a = vec![(0.0f32, 0.0f32); 8];
        let b = vec![(0.1f32, 0.1f32); 8];
        assert!(
            recover_pose_from_essential(&[0.0; 9], &a, &b).is_none(),
            "a zero essential matrix must not yield a pose"
        );
        // A rank-2 matrix that still leaves every point behind both cameras is likewise
        // refused — the guard is on the cheirality evidence, not on the matrix being zero.
        let diag = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0];
        let coincident_a = vec![(0.0f32, 0.0f32); 8];
        let coincident_b = vec![(0.0f32, 0.0f32); 8];
        assert!(
            recover_pose_from_essential(&diag, &coincident_a, &coincident_b).is_none(),
            "coincident correspondences carry no depth evidence and must not yield a pose"
        );
    }

    /// Cheirality is "in front of **both** cameras" — the guard's `lambda1 > 0.0` half (the
    /// **first** camera) had no case at all: with that leaf dropped the whole suite stayed
    /// green (48 passed), so a correspondence behind camera 1 but in front of camera 2 was
    /// counted as depth evidence. That inflates a wrong `(R, t)` candidate's in-front count,
    /// which is exactly the score `recover_pose_from_essential` picks its winner by — a
    /// mis-registered pose reported as a valid recovery.
    ///
    /// The negative case is hand-derived: with `R = I`, `t = (0,0,1)`, `a = (1,0)`,
    /// `b = (0,1)` the normal equations give `lambda1 = -1/3` (behind the first camera) and
    /// `lambda2 = +1/3` (in front of the second). The complement — the true synthetic motion —
    /// puts its correspondences in front of both, so the test cannot pass by counting nothing.
    #[test]
    fn cheirality_requires_the_point_in_front_of_the_first_camera() {
        let identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let t_z = [0.0, 0.0, 1.0];
        assert_eq!(
            cheirality_count(&[(1.0, 0.0)], &[(0.0, 1.0)], &identity, &t_z),
            0,
            "a point behind the first camera must not count as cheirality evidence, \
             even though it is in front of the second"
        );
        let (a, b, r, t) = synthetic_camera_motion(9);
        assert!(
            cheirality_count(&a, &b, &r, &t) > 0,
            "the true motion must put its correspondences in front of both cameras"
        );
    }

    /// `perpendicular` must return a unit vector orthogonal to its input along every basis
    /// arm. This pins the *outcome* (a valid perpendicular), not which arm was taken: all
    /// three arms return a valid perpendicular, and they differ only in how far the input is
    /// from the crossed basis vector, which is a conditioning choice. The three inputs below
    /// do drive all three arms (`[0,0,1]` and `[0,1,0]` take the first, `[1,0,0]` the
    /// second, `[0.6,0.7,0.1]` the third), so a mutation that broke the final normalisation
    /// or the cross product fails here.
    #[test]
    fn perpendicular_returns_a_unit_vector_orthogonal_to_the_input() {
        for u in [
            [0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.6, 0.7, 0.1],
        ] {
            let p = perpendicular(u);
            let len = norm3(p);
            assert!(
                (len - 1.0).abs() < 1e-12,
                "perpendicular({u:?}) has length {len}, not 1"
            );
            assert!(
                dot3(u, p).abs() < 1e-12,
                "perpendicular({u:?}) = {p:?} is not orthogonal to its input"
            );
        }
    }

    #[test]
    fn a_deterministic_seed_yields_a_deterministic_pose() {
        let (a, b, _r, _t) = synthetic_camera_motion(99);
        let r1 = ransac_essential(&a, &b, 1e-3, 200, 17).expect("ransac");
        let r2 = ransac_essential(&a, &b, 1e-3, 200, 17).expect("ransac");
        assert_eq!(r1.pose.rotation, r2.pose.rotation);
        assert_eq!(r1.pose.translation, r2.pose.translation);
    }
}
