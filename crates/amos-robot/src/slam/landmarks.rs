//! A 2-D point landmark: its estimated position, its covariance, and the bookkeeping that
//! says whether it has ever been observed (which decides what it costs to drop).
//!
//! The shape is deliberately small — `f32` for position, a 2×2 `f32` matrix for covariance
//! — because the inner loop touches many of them. A `Landmark` is `Copy + 16 bytes` (with
//! padding: `4 + 4 + 4 + 8 + 4 + 4 = 28` rounded to 32), so a thousand of them fit in the
//! L1 cache.
//!
//! Two invariants the rest of the crate depends on:
//!
//! 1. **`ever_observed` is monotonic.** Once `true`, it stays `true`; a landmark that has
//!    contributed to the map is not silently forgotten.
//! 2. **The covariance is symmetric.** [`Landmark::new`] zeroes it; the EKF update writes
//!    the upper triangle and mirrors it down (so a stray half-write does not leak into a
//!    query).

/// One landmark: position, covariance, observation counter, and the "ever observed" flag.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Landmark {
    /// Estimated x (metres, world frame).
    pub x_m: f32,
    /// Estimated y (metres, world frame).
    pub y_m: f32,
    /// 2×2 covariance, **row-major**. `cov[0]` = `σ_xx`, `cov[1]` = `cov[2]` = `σ_xy`,
    /// `cov[3]` = `σ_yy`.
    pub cov: [f32; 4],
    /// How many times this landmark has been updated. Capped at `u16::MAX` (a sensor
    /// running for 13 days at 1 Hz has saturated it).
    pub observations: u16,
    /// True once the landmark has been integrated at least once. Monotonic — see module docs.
    pub ever_observed: bool,
}

impl Landmark {
    /// A landmark with the given position and the covariance `diag(sx², sy²)`. The off-diagonal
    /// is zero (an isotropic initialisation — the safe choice when no prior exists).
    pub fn new(x_m: f32, y_m: f32, sigma_m: f32) -> Self {
        let v = sigma_m.max(0.0) * sigma_m.max(0.0);
        Self {
            x_m,
            y_m,
            cov: [v, 0.0, 0.0, v],
            observations: 0,
            ever_observed: false,
        }
    }

    /// The Mahalanobis distance from this landmark to `(qx, qy)`:
    /// `√((q − μ)ᵀ Σ⁻¹ (q − μ))`. Returns `f32::INFINITY` when the covariance is
    /// singular (a perfectly certain landmark never diverges — the gate is open).
    ///
    /// This is the **gating metric** that [`crate::slam::data_assoc::associate`] uses to
    /// reject spurious matches: a candidate whose Mahalanobis distance exceeds the gate
    /// is "too far" to be this landmark, regardless of Euclidean distance.
    pub fn mahalanobis(&self, qx: f32, qy: f32) -> f32 {
        let det = self.cov[0] * self.cov[3] - self.cov[1] * self.cov[2];
        if det <= 0.0 || !det.is_finite() {
            return f32::INFINITY;
        }
        let dx = qx - self.x_m;
        let dy = qy - self.y_m;
        // Σ⁻¹ = (1/det) · [[σ_yy, -σ_xy], [-σ_xy, σ_xx]]
        let inv00 = self.cov[3] / det;
        let inv01 = -self.cov[1] / det;
        let inv11 = self.cov[0] / det;
        let a = inv00 * dx + inv01 * dy;
        let b = inv01 * dx + inv11 * dy;
        let sq = dx * a + dy * b;
        if sq < 0.0 {
            // Numerical: the matrix "looked" non-PD — fall back to Euclidean to keep
            // a finite answer rather than refusing every observation near zero.
            (dx * dx + dy * dy).sqrt()
        } else {
            sq.sqrt()
        }
    }

    /// Enforce symmetry (`cov[1] = cov[2]`). The EKF writes the upper triangle and
    /// mirrors it; this method catches the cases where a half-update slipped through.
    pub fn symmetrise(&mut self) {
        let avg = 0.5 * (self.cov[1] + self.cov[2]);
        self.cov[1] = avg;
        self.cov[2] = avg;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_landmark_is_isotropic_and_unobserved() {
        let lm = Landmark::new(1.0, 2.0, 0.5);
        assert_eq!(lm.x_m, 1.0);
        assert_eq!(lm.y_m, 2.0);
        assert_eq!(lm.cov, [0.25, 0.0, 0.0, 0.25]);
        assert_eq!(lm.observations, 0);
        assert!(!lm.ever_observed);
    }

    #[test]
    fn mahalanobis_is_zero_at_the_mean() {
        let lm = Landmark::new(3.0, 4.0, 0.1);
        let d = lm.mahalanobis(3.0, 4.0);
        assert!(d.abs() < 1e-5, "at the mean the distance is zero, got {d}");
    }

    #[test]
    fn mahalanobis_grows_with_euclidean_distance() {
        let lm = Landmark::new(0.0, 0.0, 0.5);
        let near = lm.mahalanobis(0.1, 0.0);
        let far = lm.mahalanobis(1.0, 0.0);
        assert!(far > near, "Mahalanobis must grow with distance");
    }

    #[test]
    fn a_singular_covariance_does_not_panic() {
        // A covariance whose determinant is zero would make `Σ⁻¹` undefined; the function
        // returns `INFINITY` instead of panicking — a NaN distance would silently trip
        // every gate below it.
        let mut lm = Landmark::new(0.0, 0.0, 0.1);
        lm.cov = [0.0; 4];
        assert_eq!(lm.mahalanobis(1.0, 0.0), f32::INFINITY);
    }

    #[test]
    fn symmetrise_catches_an_asymmetric_write() {
        let mut lm = Landmark::new(0.0, 0.0, 0.1);
        lm.cov[1] = 0.5;
        lm.cov[2] = -0.5;
        lm.symmetrise();
        assert_eq!(lm.cov[1], lm.cov[2]);
        assert_eq!(lm.cov[1], 0.0);
    }
}
