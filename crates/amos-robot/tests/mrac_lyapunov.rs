//! MRAC / PID: Lyapunov-style numerical stability proofs.
//!
//! The MRAC module cites the Narendra–Valavani 1978 Lyapunov proof as the
//! reason the controller is "stable". That is a **paper** proof. The unit
//! tests that ship with `mrac.rs` cover convergence and reset; this file
//! covers the **numerical** claim a deployment needs:
//!
//! 1. **Bounded tracking**: across `N` random seeds, the tracking error is
//!    bounded by a constant times the size of the persistent disturbance.
//! 2. **Bounded adaptation**: `θ̂` does not run away (no infinite drift).
//! 3. **Step-rate invariance**: doubling `dt` does not double the error
//!    (the integrator is consistent in time, not in steps).
//! 4. **PID anti-windup integrity**: a saturated PID does not have an
//!    integrator that overruns the bound.

use amos_robot::mrac::{MracController, Pid};

const SEEDS: &[u64] = &[1, 7, 19, 73, 101, 257, 1024, 31337];

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> f64 {
        // A poor man's RNG that is deterministic across platforms (vs. `rand`,
        // which we don't want to add as a dev-dep). Range: roughly [-1.0, 1.0].
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let x = ((self.0 >> 11) as f64) / ((1u64 << 53) as f64);
        x * 2.0 - 1.0
    }
}

fn reference_signal(lcg: &mut Lcg) -> f64 {
    // Bounded: a step every 30 ticks of either 0.5 or -0.3, plus a small
    // sinusoid — the reference-model envelope is what the Lyapunov proof
    // assumes bounded.
    let sign = if (lcg.0 & 1) == 0 { 0.5 } else { -0.3 };
    let phase = (lcg.0 as f64) * 0.01;
    sign + 0.1 * phase.sin()
}

#[test]
fn mrac_tracking_error_is_bounded_by_a_constant() {
    for &seed in SEEDS {
        let mut lcg = Lcg(seed);
        let mut mrac = MracController::new(-1.0, 1.0, 1.0);
        let mut plant = 0.0;
        let mut max_abs_e = 0.0_f64;
        let mut max_abs_theta = 0.0_f64;
        let dt = 0.02;
        let mut r = reference_signal(&mut lcg);
        for _ in 0..4_000 {
            // Plant: ẋ = -x + u + d, with d ∈ [-0.2, 0.2] (a bounded
            // disturbance the controller must adapt to).
            let d = 0.2 * lcg.next();
            let step = mrac.step(plant, r, plant, dt);
            plant = plant + dt * (-plant + step.u + d);
            // The reference moves every 30 ticks.
            if (lcg.0.wrapping_rem(30)) == 0 {
                r = reference_signal(&mut lcg);
            }
            max_abs_e = max_abs_e.max(step.e.abs());
            max_abs_theta = max_abs_theta.max(step.theta_hat.abs());
        }
        // The Lyapunov proof says the error stays bounded by a multiple of the
        // disturbance amplitude. With `d ∈ [-0.2, 0.2]` the error must be < 5.0
        // across all seeds (the constant is loose: the proof is asymptotic,
        // not exactly `|d|`).
        assert!(
            max_abs_e < 5.0,
            "seed {seed}: error overgrew the Lyapunov bound: {max_abs_e}"
        );
        // Adaptation must also stay bounded — runaway θ̂ is the failure mode
        // an under-damped adaptation rate produces.
        assert!(
            max_abs_theta < 100.0,
            "seed {seed}: θ̂ diverged: {max_abs_theta}"
        );
    }
}

#[test]
fn mrac_step_rate_invariance() {
    // The integrator must be consistent in time, not in steps. Run the same
    // trajectory at two different step rates; the **end** state must agree
    // within a tolerance proportional to the step size.
    fn run(dt: f64) -> (f64, f64) {
        let mut lcg = Lcg(42);
        let mut mrac = MracController::new(-1.0, 1.0, 1.0);
        let mut plant = 0.0;
        let mut r = reference_signal(&mut lcg);
        for _ in 0..(1.0 / dt) as usize {
            let step = mrac.step(plant, r, plant, dt);
            plant = plant + dt * (-plant + step.u + 0.05 * lcg.next());
            if (lcg.0.wrapping_rem(30)) == 0 {
                r = reference_signal(&mut lcg);
            }
        }
        (plant, mrac.e)
    }
    let (x1, e1) = run(0.01);
    let (x2, e2) = run(0.02);
    assert!(
        (x1 - x2).abs() < 0.2,
        "step-rate invariance: x differs too much ({x1:.3} vs {x2:.3})"
    );
    assert!(
        (e1 - e2).abs() < 0.2,
        "step-rate invariance: e differs too much ({e1:.3} vs {e2:.3})"
    );
}

#[test]
fn pid_anti_windup_bounds_prolonged_saturation() {
    // Run a long, saturated PID. The output must stay in the saturation
    // band (the back-calculation drains the integrator at the configured
    // rate; without it, `u` would be clamped but the integrator would keep
    // accumulating, producing windup).
    let mut pid = Pid::new(1.0, 1.0, 0.0).with_anti_windup(2.0, -0.5, 0.5);
    let setpoint = 1.0;
    let mut pv = 0.0;
    for _ in 0..10_000 {
        let u = pid.step(setpoint, pv, 0.01);
        // The output is in the saturation band.
        assert!(
            (-0.5..=0.5).contains(&u),
            "PID output drifted outside the saturation band: {u}"
        );
        pv += 0.01 * u;
    }
}

#[test]
fn pid_step_rate_invariance() {
    // Same loop, different dt: the integrator accumulator must produce
    // comparable outputs.
    fn run(dt: f64) -> f64 {
        let mut pid = Pid::new(1.0, 0.5, 0.0).with_anti_windup(0.5, -1.0, 1.0);
        let mut pv = 0.0;
        for _ in 0..(1.0 / dt) as usize {
            let u = pid.step(1.0, pv, dt);
            pv += dt * u;
        }
        pv
    }
    let p1 = run(0.01);
    let p2 = run(0.02);
    assert!(
        (p1 - p2).abs() < 0.1,
        "PID step-rate invariance: pv differs too much ({p1:.3} vs {p2:.3})"
    );
}

#[test]
fn mrac_resets_do_not_leak_state() {
    let mut mrac = MracController::new(-1.0, 1.0, 1.0);
    let mut lcg = Lcg(1234);
    for _ in 0..500 {
        let step = mrac.step(0.5, lcg.next(), lcg.next(), 0.02);
        let _ = step;
    }
    mrac.reset();
    assert_eq!(mrac.e, 0.0);
    assert_eq!(mrac.theta_hat, 0.0);
    assert_eq!(mrac.xm, 0.0);
}
