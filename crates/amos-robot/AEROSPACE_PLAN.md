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
| Path planning (A* + pure pursuit) | ✅ | ✅ + multi-resolution frontier + kinematic-feasible DWA |
| SLAM | ❌ | ✅ **EKF-SLAM 2D** (prediction, observation, data association, loop closure) |
| Vision | ❌ | ✅ **Sparse visual odometry** (FAST corners + LK optical flow + 5-point RANSAC) |
| Real motor driver | ❌ (Mock) | ✅ **Serial/CAN/UDP driver skeleton** behind `RobotHal`, Mock remains as default |

---

## New modules

```
crates/amos-robot/src/
├── fusion.rs           (existing — extended with 9-DOF magnetometer + Allan variance)
├── planning.rs         (existing — extended with DWA + multires)
├── control.rs          (existing — extended with PID, MRAC, safety monitor)
├── slam/
│   ├── mod.rs
│   ├── ekf.rs          — Extended Kalman Filter core (fixed 4-D state + N landmarks)
│   ├── landmarks.rs    — landmark observations + bounding-box gates
│   ├── data_assoc.rs   — JCBB / nearest-neighbour, Mahalanobis-gated
│   ├── loop_closure.rs — pose-graph relocalisation, bounding thresholds
│   └── occupancy.rs    — log-odds 2D grid mapper
├── vision/
│   ├── mod.rs
│   ├── fast.rs         — FAST-9 corner detector (machine-generated feature table)
│   ├── lk.rs           — Lucas-Kanade sparse optical flow
│   ├── five_point.rs   — 5-point essential matrix (Stewenius / Nistér) + RANSAC
│   └── vo.rs           — Visual odometry pipeline glue (deterministic frame-to-frame)
├── driver/
│   ├── mod.rs
│   ├── traits.rs       — Re-export / extend RobotHal contract
│   ├── serial.rs       — UART driver (CRC-checked frames, fixed bytes)
│   ├── can.rs          — CAN bus driver (CAN 2.0A, 11-bit ID)
│   └── udp.rs          — UDP discovery + control port driver
├── safety.rs           — Safety monitor (heartbeat, watchdog, redundancy, fault tree)
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
