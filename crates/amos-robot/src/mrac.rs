//! **Model-Reference Adaptive Control** (MRAC) — the controller that learns the
//! uncertainty.
//!
//! A PID controller (next module) is correct *when the model is right*. A drone whose mass
//! changes when it picks up a payload, or a manipulator whose inertia depends on the joint
//! angle, has a model that the deployment does not fully know. MRAC's adaptive term
//! (Narendra–Valavani, 1978) tracks the unknown dynamics in the **error against a
//! reference model** — a stable linear system that says "this is how a perfect plant
//! should respond".
//!
//! The shape:
//!
//! ```text
//!   ẋ  = am · x + bm · (u + θ · ω)   // plant (state, control, unknown θ)
//!   ẋm = am · xm + bm · r            // reference model (what the plant does at θ̂ = θ)
//!   u  = r − θ̂ · ω                    // control law
//!   θ̂̇  = −γ · ω · e · p · bm          // adaptation law (Lyapunov-proved stable)
//! ```
//!
//! The reference model is the plant itself with the unknown matched (`θ̂ = θ`): the control
//! law then delivers `u = r`, and `ẋ = am·x + bm·r` **is** `ẋm`. That identity is what the
//! Lyapunov argument needs, and it is why the model carries the `bm·r` feedforward rather
//! than a lag toward `bm·r`. An earlier revision wrote `ẋm = am · (xm − bm · r)`; the two
//! agree **only at `am = −1`** — the constructor's fallback and the pole of every fixture —
//! so the error went unseen. At any other pole the old form left a persistent
//! `−bm·r·(am + 1)` term in `ė`, the cited proof no longer closed, and `θ̂` settled at
//! `θ + r·(am + 1)/ω` instead of `θ`
//! (see `the_estimate_converges_to_the_true_unknown_at_a_pole_other_than_minus_one`).
//!
//! The shape we ship here is **first-order, single-input, single-output** — the smallest
//! non-trivial case the Lyapunov proof fits, and what every aerospace-grade MRAC
//! implementation I know builds on (`Astolfi & Marconi`, 2015; `Hovakimyan & Cao`,
//! 2010). A multi-axis deploy layers one of these per axis and feeds cross-terms through
//! `omega`.
//!
//! ### Honest boundaries
//!
//! 1. **The proof assumes bounded `r` and bounded `omega`.** A reference signal whose
//!    energy exceeds the reference model's small-signal envelope will push the
//!    adaptation out of its linear regime — the proof does not extend.
//! 2. **There is no anti-windup.** A control input that saturates means the adaptation
//!    is integrating error on a signal it never reached; a deployment uses the same
//!    back-calculation PID uses (this is the deliberate intersection with [`Pid`]).
//! 3. **Sampling is the caller's.** MRAC does not own a timer; the [`MracController`]
//!    takes `dt_s` as a parameter, and a loop enforces the periodicity.
//! 4. **Initial θ̂ is zero by default.** A deployment that has a prior estimate passes it
//!    in; otherwise the controller "learns from rest", which is correct asymptotically
//!    but takes longer to settle.
//!
//! ### The projection operator
//!
//! The bare adaptation law `θ̂̇ = −γ ω e p b` is only Lyapunov-stable on a *bounded*
//! parameter set. Under a fault — a dropped sensor making `e` persist, a stuck
//! regression vector — the law integrates without limit and an unbounded θ̂ becomes an
//! unbounded `u`. We therefore apply the standard projection operator (Ioannou & Sun,
//! *Robust Adaptive Control*, §4.3) against [`MracController::theta_bound`], so that
//! `|θ̂| ≤ theta_bound` holds **unconditionally**.
//!
//! For a **scalar** parameter the projection operator reduces to a saturating clamp on
//! θ̂ itself. (A vector parameter is the case where the distinction bites: there only the
//! outward radial component is removed and the tangential component is preserved. Here
//! there is no tangential direction.) The clamp is applied to the *estimate*, not to a
//! separate integrator, so once the error changes sign the estimate relaxes off the bound
//! on the very next step rather than staying stuck.

/// Default projection bound on |θ̂|. A deployment that knows its uncertainty band passes a
/// tighter `theta_bound` through [`MracController::with_theta_bound`]; the default is the
/// widest band this controller is willing to call "an estimate" rather than a runaway.
pub const DEFAULT_THETA_BOUND: f64 = 100.0;

/// First-order MRAC for a single SISO plant. The `f64` precision is for the integration —
/// the saturation and the bounding live in `f64` and the inner step is one multiply-add.
#[derive(Clone, Debug)]
pub struct MracController {
    /// Reference-model pole — **negative** for stability. The model is
    /// `ẋm = am · xm + bm · r`, a first-order lag toward `−bm · r / am` with time constant
    /// `1 / |am|`. (`−bm · r / am` is `bm · r` **only** at `am = −1`; the earlier model
    /// `am · (xm − bm · r)` hard-coded that one case and settled at the wrong equilibrium
    /// for every other pole.)
    pub am: f64,
    /// Reference model gain — the feedforward `bm · r` in `ẋm = am · xm + bm · r`.
    pub bm: f64,
    /// Adaptation rate (γ in the Lyapunov proof). Higher = faster adaptation, more noise
    /// amplification. `// chosen:` — `0.5 .. 5.0` is this crate's own starting range for the
    /// fixtures, not a figure from the cited proof, which bounds only `γ > 0`.
    pub gamma: f64,
    /// The P matrix from the Lyapunov proof `V = xᵀ P x + trace(θ̃ᵀ Γ⁻¹ θ̃)`. For the
    /// first-order case `P` solves the scalar Lyapunov equation `2 · am · P = −Q` for any
    /// `Q > 0`; this crate fixes `Q = bm²`, giving `P = bm² / (2 · |am|)`. That is **a**
    /// solution, `// chosen:` alongside `Q` — not the unique one, and any other `Q > 0` would
    /// give a different, equally valid `P` with the same `V̇ = 2 · am · p · e² ≤ 0`.
    pub p: f64,
    /// Current adaptive estimate θ̂. Default zero.
    pub theta_hat: f64,
    /// Projection bound: |θ̂| is kept `≤ theta_bound`. The Lyapunov proof only holds on a
    /// bounded parameter set — under a fault (a sensor drop-out, a stuck regression
    /// vector) the raw law integrates error without limit, and an unbounded θ̂ turns into
    /// an unbounded control input. Default [`DEFAULT_THETA_BOUND`].
    pub theta_bound: f64,
    /// Last ω (regression vector), kept **for telemetry only**. The next `step` takes its own
    /// `omega` argument; nothing in the algorithm reads this field, so a caller that logs
    /// `summary()` sees the last regressor the controller was handed, not one it needs.
    pub omega: f64,
    /// The current reference-model state.
    pub xm: f64,
    /// The current tracking error `e = xm − x`.
    pub e: f64,
}

impl MracController {
    /// A controller from the three reference-model / adaptation parameters, starting at
    /// `θ̂ = 0`. A real deployment tunes these for the plant. Each argument has a fallback
    /// when it is not a usable value — a non-finite or non-negative `am` (the pole must be
    /// negative), a non-finite or non-positive `bm`, the same for `γ` — and the fallback is
    /// `am = −1.0`, `bm = 1.0`, `γ = 1.0` respectively, so a caller that passes nonsense gets
    /// a stable controller rather than a `NaN` one.
    pub fn new(am: f64, bm: f64, gamma: f64) -> Self {
        let am = if am.is_finite() && am < 0.0 { am } else { -1.0 };
        let bm = if bm.is_finite() && bm > 0.0 { bm } else { 1.0 };
        let gamma = if gamma.is_finite() && gamma > 0.0 {
            gamma
        } else {
            1.0
        };
        let p = (bm * bm) / (2.0 * am.abs());
        Self {
            am,
            bm,
            gamma,
            p,
            theta_hat: 0.0,
            theta_bound: DEFAULT_THETA_BOUND,
            omega: 0.0,
            xm: 0.0,
            e: 0.0,
        }
    }

    /// Set the projection bound on |θ̂|. A non-finite or non-positive bound is ignored
    /// (the default stands), matching the constructor's treatment of the gains.
    pub fn with_theta_bound(mut self, bound: f64) -> Self {
        // `is_finite()` is not redundant with `bound > 0.0`: `+inf > 0.0` is **true**, so only
        // this half refuses an infinite bound — and an infinite bound makes the clamp below an
        // identity, dropping the "`|θ̂| ≤ theta_bound` unconditionally" guarantee.
        if bound.is_finite() && bound > 0.0 {
            self.theta_bound = bound;
        }
        self
    }

    /// One MRAC step: advance the reference model with `r`, compute the error against the
    /// plant's current state `x`, integrate the adaptation, and return the input.
    ///
    /// `omega` is the regression vector (the plant's known input basis: `x` and `r`,
    /// typically). The proof assumes `omega ⊂ ℝⁿ`, but the common case is a scalar.
    ///
    /// A **non-finite** `x`, `r`, `omega` or `dt_s` (or `dt_s ≤ 0`) makes the step a
    /// **safe-off**: it returns `u = 0.0` and leaves every piece of controller state
    /// untouched. `0.0` is the zero-input command, not an error code — distinguishing "the
    /// controller commands zero" from "the controller was handed garbage" is the caller's
    /// safety monitor's job (see `crate::safety`), and the adaptation must not integrate
    /// against a reading it cannot trust.
    pub fn step(&mut self, x: f64, r: f64, omega: f64, dt_s: f64) -> MracStep {
        if !x.is_finite()
            || !r.is_finite()
            || !omega.is_finite()
            || !dt_s.is_finite()
            || dt_s <= 0.0
        {
            return MracStep {
                u: 0.0,
                xm: self.xm,
                e: self.e,
                theta_hat: self.theta_hat,
            };
        }
        // ① Reference model: ẋm = am · xm + bm · r — the plant at θ̂ = θ, where the control
        //    law delivers `u = r` and `ẋ = am·x + bm·r` *is* this model.
        self.xm = self.xm + dt_s * (self.am * self.xm + self.bm * r);
        // ② Tracking error.
        self.e = self.xm - x;
        // ③ Adaptive law: θ̂̇ = −γ · ω · e · p · bm.
        // With the reference model above, ė = am·e + bm·θ̃·ω and
        // V̇ = 2·am·p·e² ≤ 0 for `am < 0`, `p > 0` (standard MRAC proof). The earlier
        // `am·(xm − bm·r)` broke this: it added a persistent `−bm·r·(am + 1)` to ė.
        let theta_dot = -self.gamma * omega * self.e * self.p * self.bm;
        // Projection operator (Ioannou & Sun, §4.3). For a scalar parameter this is a
        // saturating clamp on θ̂: it guarantees `|θ̂| ≤ theta_bound` unconditionally —
        // including when the bound was *tightened* below an estimate that had already grown
        // past it, where a branch that only freezes *outward* motion leaves θ̂ stranded
        // outside the bound. (That earlier branch is gone, so the figure once quoted here
        // cannot be re-measured against the shipped code — the test below pins the corrected
        // behaviour instead.) See the module doc for why the scalar case needs no
        // tangential-component machinery.
        self.theta_hat =
            (self.theta_hat + dt_s * theta_dot).clamp(-self.theta_bound, self.theta_bound);
        // ④ Control law: u = r − θ̂ᵀ ω. (Reference feedforward minus the adaptive
        //   estimate of the unknown input gain; the Lyapunov proof the module
        //   cites assumes this exact form — a feedforward of `kr · r` plus the
        //   state-feedback term `−kr · xm` would change the closed-loop
        //   reference-model pole and break the proof.)
        let u = r - self.theta_hat * omega;
        self.omega = omega;
        MracStep {
            u,
            xm: self.xm,
            e: self.e,
            theta_hat: self.theta_hat,
        }
    }

    /// Reset the adaptive estimate (after a mode change, a fault, or a known-good restart).
    /// Note: this is the same operation a PID `reset` performs; the comment is the same:
    /// throwing away evidence.
    pub fn reset(&mut self) {
        self.theta_hat = 0.0;
        self.omega = 0.0;
        self.xm = 0.0;
        self.e = 0.0;
    }

    /// One line an operator can read.
    pub fn summary(&self) -> String {
        format!(
            "mrac: am={} bm={} γ={} θ̂={:.4} e={:.4} ω={:.4}",
            self.am, self.bm, self.gamma, self.theta_hat, self.e, self.omega
        )
    }
}

/// One step's report — the input to apply, and the values the loop may log.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MracStep {
    /// The control input (the plant's set-point, signed).
    pub u: f64,
    /// The reference-model state.
    pub xm: f64,
    /// The tracking error (`xm − x`).
    pub e: f64,
    /// The adaptive estimate at this step.
    pub theta_hat: f64,
}

/// A first-order PID controller, with anti-windup via back-calculation — the standard
/// add-on for low-cost industrial motion controllers (Åström & Hägglund, 2006).
///
/// The shape we ship is `f64` for the integration, `f64` for the gains. The bounded
/// parameters are the same three as every PID implementation: `kp`, `ki`, `kd`. The
/// anti-windup gain is `kt` (the rate at which the integrator is drained when the
/// output saturates).
#[derive(Clone, Debug)]
pub struct Pid {
    pub kp: f64,
    pub ki: f64,
    pub kd: f64,
    pub kt: f64,
    pub out_min: f64,
    pub out_max: f64,
    integrator: f64,
    last_pv: f64,
    /// False until the first `step` has run. The derivative term is `(pv − last_pv) / dt`,
    /// and there is no *previous* `pv` on the first call — using the initialised `0.0` would
    /// emit a spurious `−kd · pv / dt` kick (measured: `u = −1000` for a D-only controller
    /// whose first `pv` is `10` at `dt = 0.01`). So the derivative is suppressed on the first
    /// sample and `last_pv` is simply recorded.
    primed: bool,
}

impl Pid {
    /// A controller with the three gains you pass, **no** anti-windup, and **no** output
    /// limits (`out_min`/`out_max` are `∓∞`, so `kt` has nothing to act on until
    /// [`Pid::with_anti_windup`] is called).
    pub fn new(kp: f64, ki: f64, kd: f64) -> Self {
        Self {
            kp,
            ki,
            kd,
            kt: 0.0,
            out_min: f64::NEG_INFINITY,
            out_max: f64::INFINITY,
            integrator: 0.0,
            last_pv: 0.0,
            primed: false,
        }
    }

    /// Configure anti-windup (the rate at which the integrator is drained when the output
    /// saturates). A value of `kt = 0` disables the back-calculation (the integrator
    /// runs freely).
    pub fn with_anti_windup(mut self, kt: f64, out_min: f64, out_max: f64) -> Self {
        self.kt = kt;
        self.out_min = out_min;
        self.out_max = out_max;
        self
    }

    /// One PID step.
    pub fn step(&mut self, setpoint: f64, pv: f64, dt_s: f64) -> f64 {
        if !setpoint.is_finite() || !pv.is_finite() || !dt_s.is_finite() || dt_s <= 0.0 {
            return 0.0;
        }
        let e = setpoint - pv;
        // Derivative on PV, not error — the standard "derivative kick" defence. The
        // derivative is suppressed on the first sample after construction or `reset`, where
        // there is no previous `pv` and the initialised `0.0` would otherwise fabricate a
        // kick out of the plant's starting measurement.
        let d_pv = if self.primed {
            (pv - self.last_pv) / dt_s
        } else {
            0.0
        };
        let p_term = self.kp * e;
        let i_term = self.ki * self.integrator;
        let d_term = -self.kd * d_pv;
        let mut u = p_term + i_term + d_term;
        // `clamped` is the explicit "was the command limited?" flag. Testing `saturation
        // != u` afterwards would be a floating-point equality test; deriving the flag from
        // the branch that *did* the limiting is exact by construction.
        let (saturation, clamped) = if u > self.out_max {
            (self.out_max, true)
        } else if u < self.out_min {
            (self.out_min, true)
        } else {
            (u, false)
        };
        // Anti-windup: when saturated, drain the integrator at rate `kt · (saturation − u)`.
        if self.kt > 0.0 && clamped {
            self.integrator += self.kt * (saturation - u) * dt_s;
        }
        // Integrate.
        self.integrator += e * dt_s;
        // Apply the saturation to the output.
        u = saturation;
        self.last_pv = pv;
        self.primed = true;
        u
    }

    /// Clear the integrator (after a mode change / fault). Also un-primes the derivative, so
    /// the first step after a reset is treated like the first step after construction.
    pub fn reset(&mut self) {
        self.integrator = 0.0;
        self.last_pv = 0.0;
        self.primed = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plant_with_a_zero_unknown_is_tracked_perfectly() {
        // Plant: ẋ = am · x + bm · u. With am = −1, bm = 1 (and the unknown θ = 0), the
        // reference model and the plant are identical, so `e` should stay ≈ 0 once
        // the controller has converged. (The pole must be **negative** — `am = +1` is not a
        // stable reference model and `MracController::new` rejects it, falling back to −1.)
        let mut mrac = MracController::new(-1.0, 1.0, 2.0);
        let mut x = 0.0;
        let am = -1.0;
        let bm = 1.0;
        let r = 1.0;
        for _ in 0..400 {
            let step = mrac.step(x, r, x, 0.02);
            x = x + 0.02 * (am * x + bm * step.u);
        }
        // After 8 s the error must be small.
        assert!(mrac.e.abs() < 0.1, "e={}", mrac.e);
    }

    #[test]
    fn the_adaptation_estimate_reacts_to_a_persistent_perturbation() {
        // Plant with an unknown offset of 0.5 on the input: with persistent stimulus the
        // adaptive estimate should drift toward the matching value θ̂ = 0.5 (steady state:
        // `u + 0.5 = r` ⇒ `1 − θ̂·x + 0.5 = 1` with `x → r = 1`). Pin both the estimate
        // and the residual — asserting only that `e` got small would pass even if the
        // adaptation were dead and the offset happened to cancel.
        let mut mrac = MracController::new(-1.0, 1.0, 4.0);
        let mut x = 0.0;
        let r = 1.0;
        for _ in 0..400 {
            let step = mrac.step(x, r, x, 0.02);
            x += 0.02 * (-x + (step.u + 0.5));
        }
        assert!(
            (mrac.theta_hat - 0.5).abs() < 0.01,
            "θ̂={} should have converged to the plant's unknown 0.5",
            mrac.theta_hat
        );
        assert!(mrac.e.abs() < 1e-3, "e={}", mrac.e);
    }

    /// The reference model must be the perfect plant at **every** admissible `am`, not just
    /// `am = −1`. The shipped model was `ẋm = am · (xm − bm · r)`, which equals the correct
    /// `ẋm = am · xm + bm · r` only at `am = −1` — the constructor's fallback and the pole
    /// every other fixture used. At any other pole the old form left a persistent
    /// `−bm · r · (am + 1)` in `ė`: the cited Lyapunov argument no longer closed, and `θ̂`
    /// settled at `θ + r · (am + 1)/ω` rather than the plant's true `θ`. This fixture is
    /// `am = −2`, where the two forms differ by a full unit of `θ̂` (measured before the fix:
    /// `θ̂ = −0.5` for a true `θ = 0.5`).
    #[test]
    fn the_estimate_converges_to_the_true_unknown_at_a_pole_other_than_minus_one() {
        let (am, bm, theta, r) = (-2.0_f64, 1.0_f64, 0.5_f64, 1.0_f64);
        let mut mrac = MracController::new(am, bm, 4.0);
        let mut x = 0.0;
        let dt = 0.02;
        for _ in 0..2_000 {
            let step = mrac.step(x, r, x, dt);
            x += dt * (am * x + bm * (step.u + theta * x));
        }
        assert!(
            (mrac.theta_hat - theta).abs() < 1e-2,
            "θ̂={} must converge to the plant's unknown {theta}; the `am = −1`-only model \
             settled it at the biased {}",
            mrac.theta_hat,
            theta + (am + 1.0) / bm
        );
        assert!(mrac.e.abs() < 1e-3, "e={}", mrac.e);
    }

    /// A runaway stimulus (an unmodelled disturbance that never lets the error settle)
    /// must not let θ̂ grow without bound: the projection holds it at `theta_bound`.
    #[test]
    fn the_projection_keeps_theta_hat_bounded() {
        let mut mrac = MracController::new(-1.0, 1.0, 4.0).with_theta_bound(2.0);
        // `omega` fixed at 1.0 and `e` driven persistently positive: the raw law would
        // integrate θ̂ without limit.
        for _ in 0..10_000 {
            mrac.step(0.0, 5.0, 1.0, 0.02);
        }
        assert!(
            mrac.theta_hat.abs() <= 2.0,
            "θ̂={} escaped the projection bound",
            mrac.theta_hat
        );
        assert!(
            mrac.theta_hat.abs() >= 2.0 - 1e-9,
            "the projection should have driven θ̂ to the bound, got {}",
            mrac.theta_hat
        );
    }

    /// Tightening `theta_bound` below an estimate that already grew past it must pull θ̂ back
    /// inside on the next step. The old branchy projection only froze *outward* motion, so an
    /// estimate sitting outside the bound and moving inward was left stranded outside (the
    /// figure once quoted here described that removed branch and cannot be re-measured now).
    /// The projection's whole contract is `|θ̂| ≤ theta_bound`, so this is the invariant test.
    #[test]
    fn tightening_the_bound_pulls_an_out_of_range_estimate_back_in() {
        let mut mrac = MracController::new(-1.0, 1.0, 4.0); // default bound 100
        for _ in 0..2_000 {
            mrac.step(0.0, 5.0, 1.0, 0.02);
        }
        assert!(
            mrac.theta_hat.abs() > 3.0,
            "fixture must grow θ̂ past the new bound, got {}",
            mrac.theta_hat
        );
        // Tighten below the current estimate, then take one step in *either* direction.
        let mut mrac = MracController::new(-1.0, 1.0, 4.0).with_theta_bound(2.0);
        mrac.theta_hat = -100.0;
        mrac.step(0.0, 5.0, -1.0, 0.02); // inward-moving (θ̇ > 0)
        assert!(
            mrac.theta_hat.abs() <= 2.0,
            "one step must restore |θ̂| ≤ bound, got {}",
            mrac.theta_hat
        );
        let mut mrac = MracController::new(-1.0, 1.0, 4.0).with_theta_bound(2.0);
        mrac.theta_hat = -100.0;
        mrac.step(0.0, 5.0, 1.0, 0.02); // outward-moving (θ̇ < 0)
        assert!(
            mrac.theta_hat.abs() <= 2.0,
            "an outward step from outside the bound must also be clamped, got {}",
            mrac.theta_hat
        );
    }

    /// A non-positive or non-finite bound is ignored; the default stands.
    #[test]
    fn a_nonsense_theta_bound_is_ignored() {
        let mrac = MracController::new(-1.0, 1.0, 1.0).with_theta_bound(-3.0);
        assert_eq!(mrac.theta_bound, DEFAULT_THETA_BOUND);
        let mrac = MracController::new(-1.0, 1.0, 1.0).with_theta_bound(f64::NAN);
        assert_eq!(mrac.theta_bound, DEFAULT_THETA_BOUND);
    }

    /// The two halves of the bound guard are not interchangeable. `bound > 0.0` cannot stand
    /// in for `bound.is_finite()`: `+inf > 0.0` is **true**, so only `is_finite()` refuses an
    /// infinite bound. Adopting one turns the saturating clamp into the identity and drops the
    /// module's "`|θ̂| ≤ theta_bound` holds **unconditionally**" guarantee (the bounded
    /// parameter set the Lyapunov proof needs) without a word. The sibling test above cannot
    /// catch that: its `-3.0` and `NaN` inputs are both already rejected by `bound > 0.0`, so
    /// it never exercises this half of the guard.
    #[test]
    fn an_infinite_theta_bound_is_ignored_not_adopted() {
        let mrac = MracController::new(-1.0, 1.0, 1.0).with_theta_bound(f64::INFINITY);
        assert_eq!(mrac.theta_bound, DEFAULT_THETA_BOUND);
    }

    /// A nonsense adaptation gain falls back to the documented default (`1.0`), the same
    /// way a nonsense `am`/`bm` does — the constructor must not accept a `NaN` γ, which
    /// would make every later `θ̂` update `NaN`.
    #[test]
    fn a_nonsense_adaptation_gain_falls_back_to_the_default() {
        for bad in [f64::NAN, 0.0, -2.0, f64::INFINITY] {
            assert_eq!(
                MracController::new(-1.0, 1.0, bad).gamma,
                1.0,
                "γ={bad} must fall back to the default"
            );
        }
        assert_eq!(MracController::new(-1.0, 1.0, 3.5).gamma, 3.5);
    }

    /// The `am`/`bm` fallbacks — the two siblings the `γ` test above names *in prose*
    /// ("the same way a nonsense `am`/`bm` does") but never exercises. Measured before this
    /// test existed: neutralising either leaf alone, or both together, left all 18 `mrac`
    /// tests green, and the neutralised pair left the **whole 426-test `amos-robot` suite**
    /// green — the constructor's documented contract had no test at all.
    ///
    /// They are load-bearing, not defensive padding. `step` advances the reference model
    /// with `ẋm = am·xm + bm·r` and never re-checks `am`/`bm` afterwards, so a **positive**
    /// `am` is an unstable pole the cited Lyapunov proof does not cover, and a **non-finite**
    /// one makes `xm`, `e` and `u` `NaN` forever — `step`'s own safe-off tests only its
    /// *arguments*, never its state, so that `NaN` reaches the control path.
    #[test]
    fn a_nonsense_reference_model_falls_back_to_the_stable_default() {
        // `am` must be finite and strictly negative — the proof's pole.
        for bad_am in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, 2.0] {
            let mrac = MracController::new(bad_am, 1.0, 1.0);
            assert_eq!(
                mrac.am, -1.0,
                "am={bad_am} must fall back to the stable pole, not be kept"
            );
        }
        // `bm` must be finite and strictly positive — the input-gain sign.
        for bad_bm in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -3.0] {
            let mrac = MracController::new(-1.0, bad_bm, 1.0);
            assert_eq!(mrac.bm, 1.0, "bm={bad_bm} must fall back to the default");
        }
        // The other side of the seam, so the assertions above cannot be green merely
        // because the constructor refuses everything.
        let kept = MracController::new(-2.5, 3.0, 1.0);
        assert_eq!(kept.am, -2.5);
        assert_eq!(kept.bm, 3.0);

        // And the *consequence*, not just the boundary: the fallback pole is one `step` can
        // actually integrate. Keep either bad `am` and the reference state either goes `NaN`
        // or grows away from zero instead of decaying — a wrong control input where the
        // contract promises a stable controller.
        for bad_am in [f64::NAN, 2.0] {
            let mut mrac = MracController::new(bad_am, 1.0, 1.0);
            mrac.xm = 1.0; // a displaced reference state
            let step = mrac.step(0.0, 0.0, 1.0, 0.5);
            assert!(
                step.u.is_finite() && step.xm.is_finite(),
                "am={bad_am} must not put a non-finite value on the control path: {step:?}"
            );
            assert!(
                step.xm.abs() < 1.0,
                "the fallback pole must decay the reference state, got xm={}",
                step.xm
            );
        }
    }

    /// The operator line must name the gains and the current state, so a log reader can
    /// tell a tuned controller from an untuned one without dumping fields.
    #[test]
    fn the_summary_names_the_gains_and_the_state() {
        let mut mrac = MracController::new(-2.0, 3.0, 4.0);
        let idle = mrac.summary();
        assert!(idle.contains("am=-2"), "{idle}");
        assert!(idle.contains("bm=3"), "{idle}");
        assert!(idle.contains("γ=4"), "{idle}");
        mrac.step(1.0, 0.0, 0.5, 0.01);
        let moved = mrac.summary();
        assert_ne!(idle, moved, "the summary must reflect the adapted state");
    }

    /// The PID's non-finite guard mirrors the MRAC's: a `NaN` step must return `0.0` and
    /// leave the integrator untouched rather than poison it for every later step.
    #[test]
    fn pid_refuses_a_non_finite_input_without_touching_the_integrator() {
        let mut pid = Pid::new(1.0, 1.0, 1.0);
        assert_eq!(pid.step(f64::NAN, 0.0, 0.01), 0.0);
        assert_eq!(pid.step(1.0, f64::NAN, 0.01), 0.0);
        assert_eq!(pid.step(1.0, 0.0, 0.0), 0.0, "a zero dt has no meaning");
        assert_eq!(pid.step(1.0, 0.0, -1.0), 0.0);
        assert_eq!(pid.step(1.0, 0.0, f64::INFINITY), 0.0);
        // Nothing above may have advanced the integrator, so a real step now behaves as
        // the first real step: a zero error contributes nothing.
        assert_eq!(pid.step(0.0, 0.0, 0.01), 0.0);
    }

    /// The output must be limited on **both** rails. A set point far below the plant drives
    /// `u` under `out_min`, and the command must clamp there (the mirror of the `out_max`
    /// case the anti-windup test already covers).
    #[test]
    fn pid_clamps_at_the_lower_output_rail() {
        let mut pid = Pid::new(1.0, 0.0, 0.0).with_anti_windup(0.0, -0.5, 0.5);
        let u = pid.step(-10.0, 10.0, 0.01);
        assert_eq!(u, -0.5, "a large negative error must clamp at out_min");
    }

    #[test]
    fn a_reset_clears_the_state_but_keeps_the_gains() {
        let mut mrac = MracController::new(-1.0, 1.0, 1.0);
        let step = mrac.step(1.0, 1.0, 1.0, 0.01);
        assert!(step.theta_hat != 0.0);
        mrac.reset();
        assert_eq!(mrac.theta_hat, 0.0);
        assert_eq!(mrac.e, 0.0);
        // …and the gains (the name's other half — reset must not touch the tuning).
        assert_eq!(mrac.am, -1.0);
        assert_eq!(mrac.bm, 1.0);
        assert_eq!(mrac.gamma, 1.0);
    }

    #[test]
    fn a_non_finite_input_does_not_panic() {
        let mut mrac = MracController::new(-1.0, 1.0, 1.0);
        let step = mrac.step(f64::NAN, 1.0, 1.0, 0.01);
        assert_eq!(step.u, 0.0);
    }

    /// Every argument [`MracController::step`]'s doc calls out — a non-finite `x`, `r`, `omega`
    /// or `dt_s`, or a non-positive `dt_s` — must be a **safe-off**: `u = 0.0` and every piece of
    /// controller state left untouched. The doc promises all five; before this test only the
    /// `x = NaN` case above was exercised, so neutralizing *any* of the other four conditions
    /// left the whole `mrac` suite green. A non-finite `omega` is the sharpest of them: it flows
    /// through the adaptation law into `θ̂` and then into `u`, so the plant receives a `NaN`
    /// command — silently, since `step` still returns a full [`MracStep`].
    #[test]
    fn every_non_finite_or_non_positive_argument_is_a_safe_off() {
        let cases: [(&str, f64, f64, f64, f64); 5] = [
            ("x not finite", f64::NAN, 1.0, 1.0, 0.01),
            ("r not finite", 1.0, f64::INFINITY, 1.0, 0.01),
            ("omega not finite", 1.0, 1.0, f64::NAN, 0.01),
            ("dt not finite", 1.0, 1.0, 1.0, f64::INFINITY),
            ("dt not positive", 1.0, 1.0, 1.0, 0.0),
        ];
        for (label, x, r, omega, dt) in cases {
            // Take one real step first, so there is adapted state to preserve.
            let mut mrac = MracController::new(-1.0, 1.0, 1.0);
            mrac.step(0.5, 0.5, 0.5, 0.01);
            let before = (mrac.xm, mrac.e, mrac.theta_hat, mrac.omega);
            let step = mrac.step(x, r, omega, dt);
            assert_eq!(step.u, 0.0, "{label}: the safe-off must command zero");
            assert_eq!(
                (mrac.xm, mrac.e, mrac.theta_hat, mrac.omega),
                before,
                "{label}: the safe-off must not touch the controller state"
            );
            assert_eq!(
                (step.xm, step.e, step.theta_hat),
                (before.0, before.1, before.2),
                "{label}: the report must be the pre-step state, not a partial advance"
            );
        }
        // Non-vacuity: a *valid* step must still adapt, so the assertions above cannot pass on
        // a controller that simply never does anything.
        let mut valid = MracController::new(-1.0, 1.0, 1.0);
        let s0 = valid.step(0.5, 0.5, 0.5, 0.01);
        let s1 = valid.step(0.4, 0.6, 0.5, 0.01);
        assert_ne!(s1.theta_hat, s0.theta_hat, "a valid step must adapt");
    }

    #[test]
    fn a_proportional_only_controller_drives_a_constant_setpoint_to_zero() {
        // kp > 0, ki = kd = 0: a plain P controller. On a first-order plant with a
        // constant set point it settles toward the set point (a steady-state offset is
        // expected without an integrator, so the bound is loose).
        let mut pid = Pid::new(1.0, 0.0, 0.0);
        let mut pv = 2.0;
        let setpoint = 0.0;
        for _ in 0..200 {
            let u = pid.step(setpoint, pv, 0.02);
            pv += 0.02 * u;
        }
        assert!(pv.abs() < 1.0, "pv={}", pv);
    }

    #[test]
    fn pid_anti_windup_caps_the_integrator_under_prolonged_saturation() {
        // A set point the output can never reach (max output 0.5, |setpoint| = 10)
        // forces a permanent error, which is the condition that makes a naive
        // integrator wind up without bound. The anti-windup version's integrator must
        // stay far smaller than the unbounded controller's.
        let setpoint = 10.0;
        let dt = 0.01;
        let steps = 2000;

        let mut wound_up = Pid::new(1.0, 1.0, 0.0).with_anti_windup(0.0, -0.5, 0.5);
        let mut guarded = Pid::new(1.0, 1.0, 0.0).with_anti_windup(1.0, -0.5, 0.5);
        let mut pv = 0.0;
        for _ in 0..steps {
            let u = wound_up.step(setpoint, pv, dt);
            pv += dt * u;
        }
        let wound_up_integrator = wound_up.integrator.abs();
        pv = 0.0;
        for _ in 0..steps {
            let u = guarded.step(setpoint, pv, dt);
            pv += dt * u;
        }
        let guarded_integrator = guarded.integrator.abs();

        // Without anti-windup the integrator grows at ~setpoint·t ≈ 200; with it, the
        // back-calculation holds it near the saturation scale (order 1).
        assert!(
            wound_up_integrator > 50.0,
            "unbounded integrator should wind up, got {wound_up_integrator}"
        );
        assert!(
            guarded_integrator < 1.0,
            "anti-windup should cap the integrator, got {guarded_integrator}"
        );
    }

    /// A derivative-only PID must not kick on its first sample: there is no previous `pv` to
    /// difference against, so the term is suppressed rather than fabricated from the
    /// initialised `0.0`. (Measured before the fix: `u = −1000` for a first `pv` of `10`.)
    #[test]
    fn the_derivative_term_does_not_kick_on_the_first_sample() {
        let mut pid = Pid::new(0.0, 0.0, 1.0);
        let first = pid.step(0.0, 10.0, 0.01);
        assert_eq!(
            first, 0.0,
            "no previous pv ⇒ no derivative term on sample 0"
        );
        // A *second* sample with the same pv still has zero rate of change.
        assert_eq!(pid.step(0.0, 10.0, 0.01), 0.0);
        // But a real change now produces a real derivative: pv moved 10 → 9 over 0.01 s is
        // −100/s, so the D term is −(1)(−100) = +100.
        let moved = pid.step(0.0, 9.0, 0.01);
        assert!((moved - 100.0).abs() < 1e-9, "got {moved}");
    }

    /// `reset` un-primes the derivative, so the first step after a reset matches a freshly
    /// constructed controller — even when the plant measurement is non-zero.
    #[test]
    fn a_reset_reprimes_the_derivative() {
        let mut pid = Pid::new(0.0, 0.0, 1.0);
        pid.step(0.0, 10.0, 0.01);
        pid.reset();
        let after_reset = pid.step(0.0, 10.0, 0.01);
        let mut fresh = Pid::new(0.0, 0.0, 1.0);
        let fresh_first = fresh.step(0.0, 10.0, 0.01);
        assert_eq!(after_reset, fresh_first);
    }

    #[test]
    fn a_reset_clears_pid_internal_state() {
        let mut pid = Pid::new(1.0, 1.0, 0.0);
        pid.step(1.0, 0.0, 0.01);
        pid.reset();
        // Same input after reset ⇒ same output.
        let u1 = pid.step(1.0, 0.0, 0.01);
        let mut pid2 = Pid::new(1.0, 1.0, 0.0);
        let u2 = pid2.step(1.0, 0.0, 0.01);
        assert!((u1 - u2).abs() < 1e-6, "{u1} vs {u2}");
    }
}
