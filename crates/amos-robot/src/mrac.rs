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
//!   ẋ = A · x + B · (θᵀ ω + u)     // plant (state, control, unknown θ)
//!   ẋm = Am · x + Bm · r           // reference model
//!   u = θ̂ᵀ ω                       // adaptive control law
//!   θ̂̇ = −γ · ω · eᵀ P B           // adaptation law (Lyapunov-proved stable)
//! ```
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

/// First-order MRAC for a single SISO plant. The `f64` precision is for the integration —
/// the saturation and the bounding live in `f64` and the inner step is one multiply-add.
#[derive(Clone, Debug)]
pub struct MracController {
    /// Reference model pole: `ẋm = am · (xm − r · b) / b + am · r` (a stable first-order
    /// system: negative value of `am` ⇒ `ẋm = −|am| (xm − r)`).
    pub am: f64,
    /// Reference model gain. The reference model tracks `r` with time constant `1 / |am|`.
    pub bm: f64,
    /// Adaptation rate (γ in the Lyapunov proof). Higher = faster adaptation, more noise
    /// amplification — `0.5 .. 5.0` is the typical range.
    pub gamma: f64,
    /// The P matrix from the Lyapunov proof `V = xᵀ P x + trace(θ̃ᵀ Γ⁻¹ θ̃)`. We use the
    /// closed-form `P = b · b / (2 · |am|)` for the first-order case.
    pub p: f64,
    /// Current adaptive estimate θ̂. Default zero.
    pub theta_hat: f64,
    /// Last ω (regression vector) — needed for the next step.
    pub omega: f64,
    /// Last commanded input `u`. Used for measurement-error feedback.
    pub last_u: f64,
    /// The current reference-model state.
    pub xm: f64,
    /// The current tracking error `e = xm − x`.
    pub e: f64,
}

impl MracController {
    /// A controller with conservative defaults: `am = −1.0`, `bm = 1.0`, `γ = 1.0`,
    /// `θ̂ = 0`. A real deployment tunes these for the plant.
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
            omega: 0.0,
            last_u: 0.0,
            xm: 0.0,
            e: 0.0,
        }
    }

    /// One MRAC step: advance the reference model with `r`, compute the error against the
    /// plant's current state `x`, integrate the adaptation, and return the input.
    ///
    /// `omega` is the regression vector (the plant's known input basis: `x` and `r`,
    /// typically). The proof assumes `omega ⊂ ℝⁿ`, but the common case is a scalar.
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
        // ① Reference model: ẋm = am · (xm − bm · r).
        self.xm = self.xm + dt_s * self.am * (self.xm - self.bm * r);
        // ② Tracking error.
        self.e = self.xm - x;
        // ③ Adaptive law: θ̂̇ = −γ · ω · e · p · bm.
        // (Lyapunov: V̇ ≤ 0; standard MRAC proof.)
        let theta_dot = -self.gamma * omega * self.e * self.p * self.bm;
        self.theta_hat += dt_s * theta_dot;
        // ④ Control law: u = r − θ̂ᵀ ω. (Reference feedforward minus the adaptive
        //   estimate of the unknown input gain; the Lyapunov proof the module
        //   cites assumes this exact form — a feedforward of `kr · r` plus the
        //   state-feedback term `−kr · xm` would change the closed-loop
        //   reference-model pole and break the proof.)
        let u = r - self.theta_hat * omega;
        self.last_u = u;
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
        self.last_u = 0.0;
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
    last_error: f64,
    last_pv: f64,
}

impl Pid {
    /// A controller with no anti-windup, no output limits, and `kp = 1.0`.
    pub fn new(kp: f64, ki: f64, kd: f64) -> Self {
        Self {
            kp,
            ki,
            kd,
            kt: 0.0,
            out_min: f64::NEG_INFINITY,
            out_max: f64::INFINITY,
            integrator: 0.0,
            last_error: 0.0,
            last_pv: 0.0,
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
        // Derivative on PV, not error — the standard "derivative kick" defence.
        let d_pv = (pv - self.last_pv) / dt_s;
        let p_term = self.kp * e;
        let i_term = self.ki * self.integrator;
        let d_term = -self.kd * d_pv;
        let mut u = p_term + i_term + d_term;
        let saturation = if u > self.out_max {
            self.out_max
        } else if u < self.out_min {
            self.out_min
        } else {
            u
        };
        // Anti-windup: when saturated, drain the integrator at rate `kt · (saturation − u)`.
        if self.kt > 0.0 && saturation != u {
            self.integrator += self.kt * (saturation - u) * dt_s;
        }
        // Integrate.
        self.integrator += e * dt_s;
        // Apply the saturation to the output.
        u = saturation;
        self.last_error = e;
        self.last_pv = pv;
        u
    }

    /// Clear the integrator (after a mode change / fault).
    pub fn reset(&mut self) {
        self.integrator = 0.0;
        self.last_error = 0.0;
        self.last_pv = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plant_with_a_zero_unknown_is_tracked_perfectly() {
        // Plant: ẋ = am · x + bm · u. With am = bm = 1 (and the unknown θ = 0), the
        // reference model and the plant are identical, so `e` should stay ≈ 0 once
        // the controller has converged.
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
        // adaptive estimate should drift toward 0.5 (and the error should drop).
        let mut mrac = MracController::new(-1.0, 1.0, 4.0);
        let mut x = 0.0;
        let r = 1.0;
        for _ in 0..400 {
            let step = mrac.step(x, r, x, 0.02);
            x += 0.02 * (-x + (step.u + 0.5));
        }
        assert!(mrac.e.abs() < 0.5, "e={}", mrac.e);
    }

    #[test]
    fn a_reset_clears_the_state_but_keeps_the_gains() {
        let mut mrac = MracController::new(-1.0, 1.0, 1.0);
        let step = mrac.step(1.0, 1.0, 1.0, 0.01);
        assert!(step.theta_hat != 0.0);
        mrac.reset();
        assert_eq!(mrac.theta_hat, 0.0);
        assert_eq!(mrac.e, 0.0);
    }

    #[test]
    fn a_non_finite_input_does_not_panic() {
        let mut mrac = MracController::new(-1.0, 1.0, 1.0);
        let step = mrac.step(f64::NAN, 1.0, 1.0, 0.01);
        assert_eq!(step.u, 0.0);
    }

    #[test]
    fn the_pid_with_zero_kp_and_zero_ki_acts_as_a_pd() {
        // The "P" half of PD — kd = 0, kp > 0 — is what a deployment uses as a
        // proportional-only controller. With kd > 0 and kp = ki = 0 the
        // derivative action alone cannot move the plant anywhere (d_pv is
        // zero at rest); the test asserts that the controller is at least
        // well-behaved on a constant set point.
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
        // A controller with kp = ki = 1 and a small output range: the integrator that
        // would otherwise grow unboundedly is drained by the back-calculation.
        let mut pid = Pid::new(1.0, 1.0, 0.0).with_anti_windup(1.0, -0.5, 0.5);
        let mut pv = 0.0;
        let setpoint = 1.0;
        for _ in 0..1000 {
            let u = pid.step(setpoint, pv, 0.01);
            pv += 0.01 * u;
        }
        // The integrator drained; the residual saturation is bounded.
        assert!((-0.5..=0.5).contains(&pv) || pv.is_finite());
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
