//! A 2-D point landmark: its estimated position, its covariance, and the bookkeeping that
//! says whether it has ever been observed (which decides what it costs to drop).
//!
//! The shape is deliberately small — `f32` for position, a 2×2 `f32` matrix for covariance
//! — because the inner loop touches many of them. A `Landmark` is `Copy + 28 bytes`:
//! `x(4) + y(4) + cov(16) + observations(2) + ever_observed(1) = 27`, padded to the `f32`
//! alignment (**28**). A thousand of them fit in the L1 cache. The size is asserted by a
//! test so this line cannot drift from the layout.
//!
//! Two invariants the rest of the crate depends on:
//!
//! 1. **`ever_observed` is monotonic.** Once `true`, it stays `true`; a landmark that has
//!    contributed to the map is not silently forgotten.
//! 2. **The covariance is symmetric.** [`Landmark::new`] builds it as `diag(σ², σ²)` — a
//!    zero *off-diagonal*, not a zero matrix — and the EKF fills it by copying the 2×2 block
//!    out of the joint covariance *after* `SlamState::symmetrise_covariance` has mirrored
//!    both triangles. [`Landmark::symmetrise`] is the direct-call safety net for a caller
//!    that writes the block itself; on the EKF path the block it averages is already
//!    symmetric, so it is a no-op there.

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
    /// How many times this landmark has been updated. The saturation at `u16::MAX` is the
    /// *caller's* to enforce — this struct does no arithmetic on the field — and
    /// `slam::ekf` does so with `saturating_add` at both of its update sites. At 1 Hz a
    /// landmark saturates after `u16::MAX` seconds ≈ **18.2 hours**. (An earlier revision of
    /// this line said "13 days at 1 Hz"; 13 days at 1 Hz is 1 123 200 counts, ~17× the cap.)
    pub observations: u16,
    /// True once the landmark has been integrated at least once. Monotonic — see module docs.
    pub ever_observed: bool,
}

impl Landmark {
    /// A landmark with the given position and the covariance `diag(sx², sy²)`. The off-diagonal
    /// is zero (an isotropic initialisation — the safe choice when no prior exists).
    ///
    /// **`sigma_m` is sanitised, not validated.** `f32::max` returns the *non-NaN* operand,
    /// so `NaN.max(0.0) == 0.0`, and a negative σ also clamps to `0.0`; either way `v`
    /// becomes **zero** — a "perfectly known" landmark, the opposite of the wide prior this
    /// constructor is meant to seed. A caller that must *reject* a bad σ has to check it
    /// before calling this, which is exactly what `SlamState::observe` now does for
    /// `initial_landmark_variance` (see `slam::ekf`).
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
    /// `√((q − μ)ᵀ Σ⁻¹ (q − μ))`.
    ///
    /// Returns `f32::INFINITY` when the covariance is not positive-definite — a
    /// non-positive determinant (singular or reflected) **or** a quadratic form that comes
    /// out negative (an indefinite matrix such as `[[−1,0],[0,−1]]`, whose determinant is
    /// `+1`) **or** any non-finite intermediate — including a determinant that overflows
    /// `f32` while both covariance entries stay finite (`σ ≥ ~4.3e9` in [`Landmark::new`],
    /// where `det = σ⁴`; see
    /// `an_overflowing_determinant_is_refused_not_read_as_a_perfect_match`). `INFINITY` **fails** every gate
    /// (`d² ≤ gate`), so a degenerate landmark is never re-associated — every observation
    /// near it starts a new landmark. That is a deliberate "refuse the degenerate input
    /// loudly" choice over silently letting a corrupted landmark absorb *any* query.
    ///
    /// The indefinite case is why the quadratic form is checked and not just the
    /// determinant: an earlier version fell back to the *Euclidean* distance when `sq` came
    /// out negative, which is a small number that passes the gate — the exact opposite of
    /// refusing loudly, and a way for a corrupted covariance to swallow every observation
    /// in range.
    ///
    /// This is the metric [`crate::slam::data_assoc::associate`] gates on: a candidate whose
    /// Mahalanobis distance exceeds the gate is "too far" to be this landmark, regardless of
    /// Euclidean distance. It weights the error by the landmark's **position** covariance
    /// only; the EKF's own `observe` instead gates on the full innovation `νᵀ S⁻¹ ν` (which
    /// also carries the robot-pose uncertainty and the sensor noise). `Landmark.cov` is kept
    /// in step with the filter's marginal block, so this gate is meaningful for callers that
    /// hold only a landmark cloud.
    ///
    /// Prefer [`Self::mahalanobis_squared`] against a `χ²` threshold — it is the form the
    /// threshold is quoted in, and it avoids a `sqrt` whose result is immediately squared
    /// again. This method exists for reporting the distance itself.
    ///
    /// Equivalent to `self.mahalanobis_squared(qx, qy).sqrt()`, including the `INFINITY`
    /// refusals (`INFINITY.sqrt()` is `INFINITY`).
    pub fn mahalanobis(&self, qx: f32, qy: f32) -> f32 {
        self.mahalanobis_squared(qx, qy).sqrt()
    }

    /// The **squared** Mahalanobis distance `sq = (q − μ)ᵀ Σ⁻¹ (q − μ)`, without the square
    /// root. Returns `f32::INFINITY` under exactly the conditions [`Self::mahalanobis`]
    /// documents.
    ///
    /// This is the form the gate is stated in: `χ²` thresholds are squared-Mahalanobis
    /// values, so [`crate::slam::data_assoc::associate`] compares against this directly. The
    /// root is for reporting a metric to a human; the squared value is for comparing against
    /// a threshold.
    ///
    /// The saving is a `sqrt` **per landmark per observation** in the association inner loop
    /// that the caller would otherwise immediately undo by squaring. It is a **cost** fix,
    /// not a behaviour fix: the round trip is not exact in `f32`, but the discrepancy was not
    /// observable at the shipped [`crate::slam::data_assoc::CHI2_2DOF_95`] gate — every
    /// representable `f32` squared distance just above the gate squares back to just above
    /// it, so the two forms return the same verdict. Comparing squared values is still the
    /// more honest thing to do: it is the form the threshold is quoted in.
    pub fn mahalanobis_squared(&self, qx: f32, qy: f32) -> f32 {
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
        if !sq.is_finite() || sq < 0.0 {
            // The quadratic form is not a valid squared distance: the covariance is
            // indefinite (or the inputs are non-finite). Refuse — `INFINITY` fails every
            // gate, which is the loud failure this function is documented to give. Never
            // substitute a different metric here: a small Euclidean value would *pass* the
            // gate and let a corrupted landmark absorb observations.
            return f32::INFINITY;
        }
        sq
    }

    /// Enforce symmetry (`cov[1] = cov[2] = (cov[1] + cov[2]) / 2`). This is the
    /// direct-call safety net for a caller that assembles the 2×2 block itself and writes
    /// only one triangle. The EKF does not need it: `SlamState::symmetrise_covariance`
    /// mirrors the joint matrix first, and `refresh_landmark_covariances` then copies the
    /// already-symmetric block, so on that path this averages two equal values.
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

    /// The constructor **sanitises** σ rather than validating it: `f32::max(0.0)` returns
    /// the non-`NaN` operand, so a negative and a `NaN` σ both collapse to `v = 0.0` — a
    /// "perfectly known" landmark, the opposite of the wide prior a bad σ was meant to seed.
    /// Pinned rather than merely documented so that a "fix" turning a bad σ into a wide prior
    /// has to change this test explicitly: rejecting a bad σ is `SlamState::observe`'s job,
    /// and this constructor must not start doing it by accident.
    #[test]
    fn a_negative_or_nan_sigma_is_sanitised_to_a_zero_covariance() {
        let negative = Landmark::new(0.0, 0.0, -0.5);
        assert_eq!(
            negative.cov,
            [0.0, 0.0, 0.0, 0.0],
            "a negative sigma clamps to zero; it must not square back to a positive variance"
        );
        let nan = Landmark::new(0.0, 0.0, f32::NAN);
        assert_eq!(
            nan.cov,
            [0.0, 0.0, 0.0, 0.0],
            "`NaN.max(0.0)` is 0.0, so a NaN sigma gives a zero covariance — not NaN"
        );
        // A well-formed σ still sets the diagonal, so the sanitising branch is not the only
        // one this test touches.
        let good = Landmark::new(0.0, 0.0, 0.5);
        assert_eq!(good.cov, [0.25, 0.0, 0.0, 0.25]);
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

    /// The isotropic test above passes for a Euclidean implementation. This one uses an
    /// **anisotropic** covariance and a hand-computed value, so a broken implementation that
    /// ignores `cov` (or the off-diagonal) fails.
    ///
    /// Σ = [[4, 1], [1, 1]], det = 3. Σ⁻¹ = (1/3)·[[1, −1], [−1, 4]].
    /// At q − μ = (1, 0): sq = (1/3)(1·1 + 0) = 1/3, so d = √(1/3) ≈ 0.5774.
    #[test]
    fn mahalanobis_uses_the_full_anisotropic_covariance() {
        let mut lm = Landmark::new(0.0, 0.0, 1.0);
        lm.cov = [4.0, 1.0, 1.0, 1.0];
        let d = lm.mahalanobis(1.0, 0.0);
        assert!(
            (d - (1.0f32 / 3.0).sqrt()).abs() < 1e-5,
            "expected √(1/3), got {d}"
        );
        // And the axes are genuinely weighted differently (a Euclidean or isotropic
        // implementation would make these equal).
        let along_x = lm.mahalanobis(1.0, 0.0);
        let along_y = lm.mahalanobis(0.0, 1.0);
        assert!(
            (along_x - along_y).abs() > 0.1,
            "an anisotropic covariance must weight x and y differently: {along_x} vs {along_y}"
        );
    }

    /// The squared form is exactly the square of the root, on an anisotropic covariance
    /// where a Euclidean implementation would disagree with both. Hand-computed: at
    /// q − μ = (1, 0) with Σ = [[4, 1], [1, 1]], `sq = 1/3`.
    #[test]
    fn mahalanobis_squared_is_the_square_of_the_root() {
        let mut lm = Landmark::new(0.0, 0.0, 1.0);
        lm.cov = [4.0, 1.0, 1.0, 1.0];
        let sq = lm.mahalanobis_squared(1.0, 0.0);
        assert!(
            (sq - 1.0 / 3.0).abs() < 1e-6,
            "expected the quadratic form 1/3, got {sq}"
        );
        let root = lm.mahalanobis(1.0, 0.0);
        // The root is the square root of *that same* quantity, not merely a value that
        // happens to satisfy `root² ≈ sq` for a Euclidean fallback.
        assert!(
            (root * root - sq).abs() < 1e-5,
            "the root must square back to the squared form: {root}² vs {sq}"
        );
        // A second, off-axis point, so a sign or transpose error in `Σ⁻¹` shows up.
        let off = lm.mahalanobis_squared(0.5, 0.5);
        let expected = (1.0f32 / 3.0) * (0.5 * 0.5 - 2.0 * 0.5 * 0.5 + 4.0 * 0.5 * 0.5);
        assert!(
            (off - expected).abs() < 1e-6,
            "expected {expected}, got {off}"
        );
    }

    /// The squared form refuses the same degenerate covariances the root does: a singular
    /// covariance, an indefinite one, and non-finite inputs all give `INFINITY`, which
    /// fails every gate. A `f32::INFINITY.sqrt()` of `INFINITY` is `INFINITY`, so the two
    /// forms agree on the refusals as well as on the finite values.
    #[test]
    fn mahalanobis_squared_refuses_the_same_degenerate_covariances() {
        let mut lm = Landmark::new(0.0, 0.0, 1.0);
        lm.cov = [0.0; 4]; // singular
        assert_eq!(lm.mahalanobis_squared(1.0, 0.0), f32::INFINITY);
        assert_eq!(lm.mahalanobis(1.0, 0.0), f32::INFINITY);
        lm.cov = [-1.0, 0.0, 0.0, -1.0]; // indefinite, det = +1
        assert_eq!(lm.mahalanobis_squared(1.0, 0.0), f32::INFINITY);
        assert_eq!(lm.mahalanobis(1.0, 0.0), f32::INFINITY);
        lm.cov = [1.0, 0.0, 0.0, 1.0];
        assert_eq!(lm.mahalanobis_squared(f32::NAN, 0.0), f32::INFINITY);
    }

    /// An **indefinite** covariance (det > 0 but not positive-definite) must be refused, not
    /// silently turned into a Euclidean distance — which would be small and pass the gate.
    #[test]
    fn an_indefinite_covariance_is_refused_not_fallen_back_to_euclidean() {
        let mut lm = Landmark::new(0.0, 0.0, 1.0);
        // det = (−1)(−1) − 0 = +1, so the determinant test alone accepts it.
        lm.cov = [-1.0, 0.0, 0.0, -1.0];
        assert_eq!(
            lm.mahalanobis(1.0, 0.0),
            f32::INFINITY,
            "an indefinite covariance must fail the gate loudly"
        );
        // Non-finite inputs likewise.
        assert_eq!(lm.mahalanobis(f32::NAN, 0.0), f32::INFINITY);
    }

    /// The module doc states the exact size; this keeps it from drifting.
    #[test]
    fn the_landmark_layout_is_28_bytes() {
        assert_eq!(core::mem::size_of::<Landmark>(), 28);
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

    /// The determinant guard's **second** leaf — `!det.is_finite()` — is not the same input
    /// class as the quadratic-form guard below it, and it is the only thing between a
    /// landmark with **finite** covariance entries and a bogus "perfect match".
    ///
    /// `Landmark::new(x, y, σ)` stores `cov = diag(σ², σ²)`, so `det = σ⁴`. At `σ = 4.3e9`
    /// the determinant overflows `f32` (`σ⁴ ≈ 3.4e38`) while both entries stay finite
    /// (`σ² ≈ 1.85e19`). Delete the leaf and the reciprocal `Σ⁻¹ = (1/det)·[[σ²,0],[0,σ²]]`
    /// is formed with `det = INFINITY`: every entry underflows to `0`, `sq` collapses to
    /// exactly `0.0`, and the function answers "distance zero" for *any* query — so the
    /// association gate `d² ≤ χ²` accepts every observation against a landmark that should
    /// have been refused loudly. That is the "corrupted landmark absorbs observations"
    /// outcome the method doc says this guard prevents, reached silently instead of loudly.
    /// Measured: deleting the leaf leaves all 385 `amos-robot` unit tests *and* the whole
    /// integration suite green, and turns the `σ = 1.0e19` answer from `INFINITY` into `0.0`.
    ///
    /// The `!sq.is_finite()` leaf does **not** cover this: `det` has already been divided by,
    /// so the overflow is gone by the time `sq` is formed. A genuinely infinite covariance
    /// *entry* (`σ = 1.0e20`, so `σ²` itself overflows) is a different input — `inf/inf` is
    /// `NaN` — and that one the `sq` leaf does catch.
    #[test]
    fn an_overflowing_determinant_is_refused_not_read_as_a_perfect_match() {
        for &sigma in &[4.3e9f32, 5.0e9, 1.0e10, 1.0e15, 1.0e19] {
            let lm = Landmark::new(0.0, 0.0, sigma);
            assert!(
                lm.cov[0].is_finite() && lm.cov[3].is_finite(),
                "σ = {sigma:e}: this case is specifically the *finite entries* one"
            );
            let det = lm.cov[0] * lm.cov[3] - lm.cov[1] * lm.cov[2];
            assert!(
                !det.is_finite(),
                "σ = {sigma:e}: det = σ⁴ must overflow f32"
            );
            // Standing on the landmark, a metre away, kilometres away — all refused.
            for &(qx, qy) in &[(0.0f32, 0.0f32), (1.0, 1.0), (1.0e6, -1.0e6)] {
                assert_eq!(
                    lm.mahalanobis_squared(qx, qy),
                    f32::INFINITY,
                    "σ = {sigma:e} at ({qx}, {qy}): an overflowing determinant must fail the \
                     gate, not answer 0"
                );
                assert_eq!(lm.mahalanobis(qx, qy), f32::INFINITY);
            }
        }
        // Contrast: `σ = 4.0e9` keeps `det = σ⁴ ≈ 2.56e38` finite, so this is a legitimate
        // (if absurdly wide) covariance and is *not* refused — the guard is about overflow,
        // not about magnitude.
        let wide = Landmark::new(0.0, 0.0, 4.0e9);
        assert!((wide.cov[0] * wide.cov[3]).is_finite());
        assert!(wide.mahalanobis_squared(1.0e6, -1.0e6).is_finite());
    }

    /// The determinant guard's **first** leaf — `det <= 0.0` — is only *incidentally* covered
    /// by the existing tests, and not in the state that makes it decisive.
    ///
    /// `a_singular_covariance_does_not_panic` uses `cov = [0; 4]`, whose `det` is exactly
    /// `0.0`, so the leaf *does* fire — but that test cannot tell: with the leaf neutralised
    /// the same input falls through to `inv = 0/0 = NaN`, and the **quadratic-form** leaf
    /// (`!sq.is_finite()`) refuses it anyway. Measured: replacing the leaf with
    /// `det <= f32::NEG_INFINITY` leaves all 12 `landmarks` tests green. The input class the
    /// leaf uniquely guards is a **reflected** covariance — `det < 0`, e.g.
    /// `cov = [1, 0, 0, -1]` (`det = −1`) — which a caller assembling the 2×2 block by hand
    /// can write, and which the doc names explicitly.
    ///
    /// Without the leaf, `Σ⁻¹ = (1/−1)·[[−1,0],[0,1]] = [[1,0],[0,−1]]`, so the form
    /// `sq = dx² − dy²` is a **small** number along the positive eigenvector and *passes* the
    /// association gate. Measured with the leaf neutralised: `sq(1, 0) = 1.0` and
    /// `sq(2, 0) = 4.0` for `cov = [1,0,0,−1]` — the corrupted landmark absorbs every
    /// observation it is queried against near the x-axis, the exact "swallow observations"
    /// failure the doc says this guard exists to prevent. (The `sq < 0.0` leaf catches only
    /// the *other* axis: `sq(0, 1) = −1 < 0` ⇒ `INFINITY`.)
    #[test]
    fn a_reflected_covariance_is_refused_not_read_as_a_small_distance() {
        let mut lm = Landmark::new(0.0, 0.0, 1.0);
        lm.cov = [1.0, 0.0, 0.0, -1.0]; // reflected (negative-definite along x), det = −1
        assert_eq!(lm.cov[0] * lm.cov[3] - lm.cov[1] * lm.cov[2], -1.0);
        for &(qx, qy) in &[(1.0f32, 0.0f32), (2.0, 0.0), (0.5, 0.0)] {
            assert_eq!(
                lm.mahalanobis_squared(qx, qy),
                f32::INFINITY,
                "a reflected covariance must fail the gate, not answer a small distance"
            );
            assert_eq!(lm.mahalanobis(qx, qy), f32::INFINITY);
        }
        // A negative-definite covariance in *both* axes (`−I`, `det = +1`) is caught by the
        // quadratic-form leaf instead — both leaves are live, on different inputs.
        let mut neg = Landmark::new(0.0, 0.0, 1.0);
        neg.cov = [-1.0, 0.0, 0.0, -1.0];
        assert_eq!(neg.mahalanobis_squared(1.0, 0.0), f32::INFINITY);
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
