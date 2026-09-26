# AmOS Robot Autonomy — Aerospace-Grade Extension Plan

**Target standards**: DO-178C DAL-B/C objectives (subset achievable in a research crate),
NASA NPR 7150.2 / Power of 10, MISRA-C "essential" subset, EKF-SLAM reference
(Probabilistic Robotics Ch. 10), SVO/ORB-SLAM-style visual front-end, PX4 EKF2 safety
patterns.

**Out of scope**: FAA / EASA certification (those need full lifecycle tooling), formal
methods (Coq/SPARK-style proof), distributed consensus, RT-scheduling integration.

---

## Status today (after the work in this change)

| Function | Before | After |
|---|---|---|
| 6-DOF IMU fusion (Mahony) | ✅ | ✅ + Allan-variance health monitor + magnetometer (9-DOF) reference |
| Path planning (A* + pure pursuit) | ✅ | ✅ + multi-resolution frontier (planned) + kinematic-feasible DWA ✅ (2026-09-19) |
| SLAM | ❌ | ✅ **EKF-SLAM 2D** (prediction, observation, data association, loop closure) |
| Vision | ❌ | ✅ **Sparse visual odometry** (FAST corners + LK optical flow + Hartley-normalised **eight-point** RANSAC — the 5-point polynomial solver is deliberately absent, see `vision/five_point.rs`) |
| Real motor driver | ❌ (Mock) | ✅ **Serial/CAN/UDP driver skeleton** behind `RobotHal`, Mock remains as default |
| Local planning (DWA) | ❌ | ✅ **Dynamic Window Approach** (Fox/Burgard/Thrun, 1997): bounded candidate scan, kinematic-feasible trajectories, scored by progress + clearance + speed (2026-09-19); **reachable** — `LocalPlanner` + `DriveCommand::from_velocity` join the `(v, ω)` window to the profile's set points and drive it against a live map, with a closed-loop test **and its negative control** (2026-09-20) |

---

## New modules

The tree below is checked against the filesystem **in both directions** by
`crates/amos-robot/tests/plan_tree.rs` — every `.rs` name here must exist under `src/`, **and**
every `.rs` file under `src/` must be named here (REQ-A682, REQ-A1027) — so neither a module the
crate does not have can sit in this tree unnoticed, nor a module the crate *does* have stay off
it. (The earlier revision named a `driver/traits.rs` that never existed and described three
modules as algorithms they do not implement; the one-directional version of the test then let
`watchdog.rs` — the external watchdog — sit outside the map entirely, FMEA `F-SH-345`.)

```
crates/amos-robot/src/
├── lib.rs              — the crate root: the module declarations and the crate-level docs
├── fusion.rs           (existing — extended with 9-DOF magnetometer + Allan variance)
├── planning.rs         (existing — extended with DWA + the reactive join; multi-resolution
│                        frontier is still *planned*, not shipped — see the Status table)
├── control.rs          (existing — extended with PID, MRAC, safety monitor)
├── localization.rs     — Monte Carlo Localization: a bounded, deterministic particle filter on a
│                        **known** landmark map — the *global* half of the pose question the
│                        unimodal EKF below cannot answer. Detects a kidnapped robot (`Diverged`);
│                        does not rescue one (no re-seeding).
├── slam/
│   ├── mod.rs
│   ├── ekf.rs          — Extended Kalman Filter core (state `3 + 2·N`: robot x/y/θ, then
│   │                     one (x, y) per landmark — `ROBOT_DIM` 3, `LM_DIM` 2)
│   ├── landmarks.rs    — the `Landmark` struct (position + 2×2 covariance + `ever_observed`)
│   │                     and the squared-Mahalanobis metric the gate is stated in. The gate
│   │                     itself runs in `data_assoc.rs`; there is no bounding box here.
│   ├── data_assoc.rs   — Mahalanobis-gated **nearest neighbour** over a landmark cloud. The
│   │                     EKF's own association is the innovation gate; JCBB (Joint Compatibility
│   │                     Branch and Bound) runs in `ekf.rs` for whole-batch association
│   ├── loop_closure.rs — brute-force correlative **scan match** (Olson, ICRA 2009) whose
│   │                     accepted relative pose is a virtual observation. Not a pose graph;
│   │                     the acceptance thresholds (`MIN_MATCH_RATIO`, `MIN_COST_DROP`) are
│   │                     this crate's policy, not figures from a paper.
│   └── occupancy.rs    — log-odds 2D grid mapper
├── vision/
│   ├── mod.rs
│   ├── fast.rs         — FAST-9 corner detector (machine-generated feature table)
│   ├── lk.rs           — Lucas-Kanade sparse optical flow
│   ├── five_point.rs   — Hartley-normalised **eight-point** essential matrix + RANSAC
│   │                     (the 5-point polynomial solver is *not* implemented — the module
│   │                     doc states why; the filename is a legacy misnomer)
│   └── vo.rs           — Visual odometry pipeline glue (deterministic frame-to-frame)
├── driver/
│   ├── mod.rs          — the `RobotHal` contract is `amos_link::robot_hal`'s; this module
│   │                     re-exports the three drivers, it does not redeclare the trait
│   ├── serial.rs       — UART driver (CRC-checked frames, fixed bytes)
│   ├── can.rs          — CAN bus driver (CAN 2.0A, 11-bit ID)
│   └── udp.rs          — UDP discovery + control port driver
├── safety.rs           — Safety monitor (heartbeat, the R1 watchdog *check*, redundancy, fault tree)
├── watchdog.rs         — **External** watchdog (REQ-A701): a supervisor that owns its own clock
│                        and catches the case the in-loop monitor cannot see — a control loop that
│                        has *stopped* calling in. A separate module, not part of `safety.rs`.
└── mrac.rs             — Model-Reference Adaptive Control for uncertain dynamics
```

---

## Verification strategy

| Layer | Technique |
|---|---|
| **Unit** | Property tests against ground truth (EKF vs. analytic linear case, ICP vs. known transform) |
| **Integration** | Monte Carlo: 1000 trials, seed-controlled RNG, statistical bounds |
| **Fault injection** | Sensor dropout, spike, drift, packet loss — each has a regression test |
| **Closed loop** | Simulated 2D world → map → plan → drive → reach goal |
| **Determinism** | Two runs on same seed → bit-exact output |

---

## Coding standards applied (every new module)

1. **No `unwrap` / `expect` / `panic` in production code** (clippy deny already on).
2. **No floating-point equality** — explicit `approx_eq` with documented epsilon.
3. **Bounded loops** — every iteration bound is a `const`, no `while true`.
4. **No allocation in inner loops** — buffers reused (NASA Power of 10 #2).
5. **All math is integer or `f32` with documented bounds** — no hidden precision promotion.
6. **Errors are typed, not strings** — `enum XxxError` with `Display + Error`.
7. **Every public function has at least one doc-test or unit test** referencing it.
8. **Every magic number is a `const` with a `// measured:` / `// cited:` comment** when
   the value comes from an external source.
