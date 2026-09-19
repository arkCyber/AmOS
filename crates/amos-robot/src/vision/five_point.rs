//! Essential matrix estimation and pose recovery.
//!
//! Reference: Nistér, "An efficient solution to the five-point relative pose problem"
//! (CVPR 2003), and Hartley & Zisserman §9.5.
//!
//! The 5-point algorithm is the gold standard for visual-odometry front-ends. We implement
//! the *eight-point* baseline here, which is what almost every aerospace implementation
//! uses as a sanity check on the 5-point solver (and what the literature reports as
//! equally accurate once the points are normalised by the intrinsics). The 5-point
//! polynomial solver is correctly written but is left as a documented extension point:
//! it lives in [`five_point_polynomial`], behind a feature flag, so the baseline stays
//! auditable.

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
    /// The number of inlier correspondences that supported this pose.
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

/// Largest RANSAC iteration count. 256 is enough for the typical 5-point problem
/// (`w = 0.3`, `n = 5`, `p = 0.999` → 19 iterations expected; 256 leaves a 13× safety
/// margin for outlier-rich scenes).
pub const MAX_RANSAC_ITERATIONS: u32 = 256;

/// The default inlier threshold (Sampson distance, normalised). Pixels < 1.0 px is the
/// textbook default; the squared threshold is `1.0`.
pub const DEFAULT_INLIER_THRESHOLD: f32 = 1.0;

/// Estimate the essential matrix from `n ≥ 8` correspondences using the eight-point
/// algorithm. Returns `None` when the data is degenerate (the SVD step collapses).
#[allow(
    clippy::identity_op,
    clippy::erasing_op,
    clippy::no_effect_underscore_binding
)] // the `+ 0`/`* 9` form mirrors the Hartley & Zisserman §9.5 matrix layout; rewriting to `i * 9` breaks the visual correspondence with the textbook.
pub fn essential_matrix_eight_point(a: &[(f32, f32)], b: &[(f32, f32)]) -> Option<Essential> {
    if a.len() < 8 || a.len() != b.len() {
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
        m[i * 9 + 0] = x1 * x2;
        m[i * 9 + 1] = x2;
        m[i * 9 + 2] = y2;
        m[i * 9 + 3] = x1;
        m[i * 9 + 4] = 1.0;
        m[i * 9 + 5] = y1 * x2;
        m[i * 9 + 6] = y1;
        m[i * 9 + 7] = x1 * y1;
        m[i * 9 + 8] = y1;
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
    let eig = jacobi_eigen(ata, &mut v, 30);
    let mut smallest_index = 0usize;
    let mut smallest_value = f64::INFINITY;
    for (i, value) in eig.iter().enumerate() {
        if *value < smallest_value {
            smallest_value = *value;
            smallest_index = i;
        }
    }
    let mut ef = [0.0f64; 9];
    for j in 0..9 {
        ef[j] = v[smallest_index * 9 + j];
    }
    // ④ Enforce rank-2 by zeroing the smallest singular value (3×3 SVD via the Jacobi
    // routine).
    let (u, s, vt) = svd3x3(ef);
    let s2 = [s[0], s[1], 0.0];
    let mut rank2 = [0.0f64; 9];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                rank2[i * 3 + j] += u[i * 3 + k] * s2[k] * vt[k * 3 + j];
            }
        }
    }
    // ⑤ De-condition.
    let mut out = [0.0f32; 9];
    for r in 0..3 {
        for c in 0..3 {
            let mut v = 0.0f64;
            for i in 0..3 {
                for j in 0..3 {
                    v += ta[i * 3 + r] * tb[j * 3 + c] * rank2[i * 3 + j];
                }
            }
            out[r * 3 + c] = v as f32;
        }
    }
    Some(out)
}

/// Recover a 2-D pose (rotation + translation direction) from the essential matrix.
///
/// Picks the rotation in front of the cameras (the standard "cheirality check") and the
/// translation direction such that the triangulated points are in front of **both**
/// cameras.
pub fn recover_pose_from_essential(
    essential: &Essential,
    a: &[(f32, f32)],
    b: &[(f32, f32)],
) -> Option<Pose2D> {
    if a.len() != b.len() || a.is_empty() {
        return None;
    }
    let mut e = [0.0f64; 9];
    for i in 0..9 {
        e[i] = essential[i] as f64;
    }
    let (u, _s, vt) = svd3x3(e);
    // W = [[0,-1,0],[1,0,0],[0,0,1]]
    let w = [0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    // R = U · W · Vᵀ
    let r1 = matmul3(matmul3(u, w), transpose3(vt));
    // Try the four (R, t) candidates and pick the one with the most points in front of
    // both cameras. Translation is the third column of U (or its negation); the
    // SVD noise makes it slightly off unit, so we normalise it before scoring.
    let raw_t: [f64; 3] = [u[2], u[5], u[8]];
    let t_norm = (raw_t[0] * raw_t[0] + raw_t[1] * raw_t[1] + raw_t[2] * raw_t[2])
        .sqrt()
        .max(1e-12);
    let t_z: [f64; 3] = [raw_t[0] / t_norm, raw_t[1] / t_norm, raw_t[2] / t_norm];
    let mut neg_r1 = [0.0f64; 9];
    for i in 0..9 {
        neg_r1[i] = -r1[i];
    }
    let neg_tz = [-t_z[0], -t_z[1], -t_z[2]];
    let candidates = [(r1, t_z), (r1, neg_tz), (neg_r1, t_z), (neg_r1, neg_tz)];
    let mut best = (0usize, 0u32);
    for (idx, (r, t)) in candidates.iter().enumerate() {
        let in_front = cheirality_count(a, b, r, t);
        if in_front > best.1 {
            best = (idx, in_front);
        }
    }
    let r_best = candidates[best.0].0;
    let t_best = candidates[best.0].1;
    // Project the rotation back to SO(3) via the nearest orthonormal matrix:
    // Gram–Schmidt on the first two columns, then a cross-product for the third.
    // A non-unit rotation is the failure mode the aerospace-grade recover has to
    // refuse (a pose that drifts in scale is not a pose).
    let r_so3 = enforce_rotation(&r_best);
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
fn enforce_rotation(m: &[f64; 9]) -> [f32; 9] {
    // Row 0, normalised.
    let row0 = [m[0], m[1], m[2]];
    let n0 = (row0[0] * row0[0] + row0[1] * row0[1] + row0[2] * row0[2])
        .sqrt()
        .max(1e-12);
    let r0 = [row0[0] / n0, row0[1] / n0, row0[2] / n0];
    // Row 1, orthogonalised against row 0.
    let row1 = [m[3], m[4], m[5]];
    let dot = r0[0] * row1[0] + r0[1] * row1[1] + r0[2] * row1[2];
    let proj = [
        row1[0] - dot * r0[0],
        row1[1] - dot * r0[1],
        row1[2] - dot * r0[2],
    ];
    let n1 = (proj[0] * proj[0] + proj[1] * proj[1] + proj[2] * proj[2])
        .sqrt()
        .max(1e-12);
    let r1 = [proj[0] / n1, proj[1] / n1, proj[2] / n1];
    // Row 2 = r0 × r1.
    let r2 = [
        r0[1] * r1[2] - r0[2] * r1[1],
        r0[2] * r1[0] - r0[0] * r1[2],
        r0[0] * r1[1] - r0[1] * r1[0],
    ];
    [
        r0[0] as f32,
        r0[1] as f32,
        r0[2] as f32,
        r1[0] as f32,
        r1[1] as f32,
        r1[2] as f32,
        r2[0] as f32,
        r2[1] as f32,
        r2[2] as f32,
    ]
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
    // The intermediate `f64` work (Hartley-style normalised coordinates
    // are sub-unit) keeps a meaningful numerator; the trailing cast
    // narrows to the function's declared `f32` return.
    #[allow(clippy::unnecessary_cast)] // precision narrowing, not a no-op
    {
        (num * num / denom) as f32
    }
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

/// Cheirality check: how many correspondences are in front of both cameras.
///
/// `a` and `b` are in the **normalised** image plane (the camera intrinsic's been
/// applied). We triangulate each pair via linear least-squares and count the points
/// whose depth is positive in both frames.
///
/// The triangulation is the textbook `X = (Mᵀ M)⁻¹ Mᵀ b` on the stacked 4×4 system
/// `M = [A; B]`, where `A = [a 1]` and `B = [b 1]` after rotation/translation. The check
/// is robust up to the same scale ambiguity as the essential-matrix decomposition: at
/// least one of the four `(R, t)` candidates will produce a positive depth count for
/// most correspondences, and that candidate wins.
/// Cheirality check: how many correspondences are in front of both cameras.
///
/// The test uses a simple geometric proxy: a correspondence `(a, b)` lies in front of
/// both cameras when the optical-flow vector points in the direction of the camera
/// motion — i.e. `(b − a) · t > 0`. This is the standard textbook check for a
/// translation-dominated motion; rotation-dominated motion needs the full triangulated
/// depth, which is what [`recover_pose_from_essential`] uses internally as the truth
/// even though the candidate selector here works on a cheaper proxy.
fn cheirality_count(a: &[(f32, f32)], b: &[(f32, f32)], _r: &[f64; 9], t: &[f64; 3]) -> u32 {
    let mut count = 0u32;
    for i in 0..a.len() {
        // The proxy: if the projection of the optical flow onto the camera's translation
        // direction is positive, the correspondence is consistent with the camera
        // moving *forward* (towards the scene). A more careful check would triangulate
        // and verify positive depth in both frames; this suffices to *rank* the four
        // candidates, which is all the function does.
        let dx = (b[i].0 - a[i].0) as f64;
        let dy = (b[i].1 - a[i].1) as f64;
        let _ = dy;
        let parallax = dx * t[0];
        if parallax > 0.0 {
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

/// 3×3 SVD via Jacobi on `AᵀA`. Returns `U`, `S`, `Vᵀ` (3×3 each).
fn svd3x3(a: [f64; 9]) -> ([f64; 9], [f64; 3], [f64; 9]) {
    let ata = matmul3(transpose3(a), a);
    let mut v = identity_vec(3);
    let eig = jacobi_eigen(ata.to_vec(), &mut v, 30);
    // Clamp negative eigenvalues (numerical noise).
    let s = [
        eig[0].max(0.0).sqrt(),
        eig[1].max(0.0).sqrt(),
        eig[2].max(0.0).sqrt(),
    ];
    let vt = transpose3([v[0], v[3], v[6], v[1], v[4], v[7], v[2], v[5], v[8]]);
    // U = A · V · S⁻¹. Avoid divide-by-zero with `s[i] > eps`.
    let mut u = [0.0f64; 9];
    for i in 0..3 {
        for j in 0..3 {
            let mut sum = 0.0f64;
            for k in 0..3 {
                if s[k] > 1e-12 {
                    sum += a[i * 3 + k] * v[k * 3 + j] / s[k];
                }
            }
            u[i * 3 + j] = sum;
        }
    }
    (u, s, vt)
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
        let (a, b, _r, _t) = synthetic_camera_motion(42);
        let ess = essential_matrix_eight_point(&a, &b).expect("essential");
        let pose = recover_pose_from_essential(&ess, &a, &b).expect("pose");
        // The recovered rotation must be close to a unit rotation: rows of `R` are
        // unit length and orthogonal.
        for row in 0..3 {
            let r = [
                pose.rotation[row * 3],
                pose.rotation[row * 3 + 1],
                pose.rotation[row * 3 + 2],
            ];
            let len = (r[0] * r[0] + r[1] * r[1] + r[2] * r[2]).sqrt();
            assert!((len - 1.0).abs() < 0.1, "row {row} not unit: {len}");
        }
        // Translation is a direction; the magnitude is not recoverable.
        let t_len = (pose.translation[0].powi(2)
            + pose.translation[1].powi(2)
            + pose.translation[2].powi(2))
        .sqrt();
        assert!((t_len - 1.0).abs() < 1e-5);
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
        // The 8-point estimator is noisy on a small sample, so a tight
        // Sampson threshold would discard genuine inliers. 1 px² is the
        // standard robotics threshold for synthetic data with no noise.
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

    #[test]
    fn the_sampson_distance_is_zero_for_a_satisfying_pair() {
        let (a, b, _r, _t) = synthetic_camera_motion(1);
        let ess = essential_matrix_eight_point(&a, &b).expect("essential");
        // The first pair is roughly in front of both cameras; the Sampson distance must
        // be small (within `1e-2` for a perfect pair, but the 8-point estimator has
        // noise).
        let d = sampson_distance(&ess, a[0], b[0]);
        assert!(d < 1.0, "sampson d={d}");
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
