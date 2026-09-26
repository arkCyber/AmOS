# amos-robot — the AmOS autonomy stack

`amos-robot` is the layer **above** [AmOS-Link](../amos-link/README.md): the middleware answers
"who said what to whom, and did the bytes arrive", and this crate answers the three questions a
robot asks before it can move — *which way am I pointing*, *how do I get there*, and *is the loop
holding its cadence*. Part of **[Amos](../../README.md)**, an AI-first OS built as one Cargo
workspace.

> ⚠️ Amos is a research prototype — **not** qualified for flight/medical/DAL-A systems or any
> other safety-critical use (see the [root README](../../README.md)).

## What it is

The autonomy core is three modules, in the order data flows:

```text
  ① which way am I pointing    fusion    ← IMU samples (SI units, body frame)
  ② how do I get there         planning  ← occupancy grid + pose → profile set points
  ③ keep doing it on time      control   ← RobotBridge steps + a measured cadence
        ▲                                                       │
        └────────── amos-link: topics · frames · safety core ◄───┘
```

- **`fusion`** — one attitude estimator (Mahony, 6-DOF, quaternion state) that refuses to lie
  about what it could not see. An unusable accelerometer is reported as
  `GravityCorrection::GyroOnly { reason }` instead of a drift-free-looking roll; a stall longer
  than `MAX_DT_S` is a refused `FusionError::Gap` instead of silent continuity; and yaw carries
  `YawReference::DeadReckoned` until `set_heading` was actually called, because a 6-axis unit
  cannot observe yaw.
- **`planning`** — an occupancy `Grid` with a bounded cell count (constructible from an ASCII
  map or from a scanner's dense `occupancy()` buffer, which `from_occupancy` reads back),
  integer A* with deterministic tie-breaking (the same map always gives the same route), an
  explicit corner rule for diagonal steps, line-of-sight smoothing, `Grid::inflated` for the
  footprint a grid cannot know, and pure pursuit whose aim point is measured from the
  vehicle's **projection onto the route** — a stateless distance test aims behind a vehicle
  that has driven past a waypoint. `Path::cost()` prices a *step sequence* and answers `None`
  for a smoothed waypoint list, because pricing a multi-cell leg as one step made a smoothed
  route read as cheaper than the route it was made from. The world origin is a cell's
  north-west **corner** and `cell_centre` adds the half-cell offset back, so `clearance_mm`
  measures to the obstacle's *own square* — an earlier version returned the corner under the
  name "centre" and measured to a square offset half a cell, reporting clearance for a point
  inside a blocked cell.
- **`control`** — a cadence-measured control loop around `amos_link::RobotBridge`: `CycleStats`
  distinguishes *lateness* (the tick started late) from *overruns* (the work was longer than the
  period), percentiles come from a bounded window that says so (`window_full`), and `Unknown` is a
  real third verdict for "fewer than two ticks, so there is no interval to judge".

Six more modules ship in this crate. They are **library code with their own unit tests** —
none of them is consumed by `ControlLoop` or by the example (see boundary 2). A seventh,
`watchdog`, **is** consumed (a loop optionally pets its token), and is listed last:

- **`slam`** — 2-D EKF-SLAM: state and covariance, the prediction and observation updates,
  Mahalanobis-gated nearest-neighbour data association (the gate runs in **squared** `χ²` units
  and the verdict reports the root, and a caller-owned `AssocScratch` carries each observation's
  nearest neighbour out of the inner loop while the loop itself allocates nothing),
  deterministic scan-match loop closure, a log-odds occupancy grid mapper, and a bounded landmark
  count (`MapFull` is a refusal, not an unbounded map). The covariance is a public output.
- **`vision`** — sparse visual odometry: FAST-9 corners, sparse Lucas–Kanade flow, a
  Hartley-normalised eight-point essential matrix with a seed-pinned RANSAC, and frame-to-frame
  VO glue.
- **`localization`** — Monte Carlo Localization: the *global* half of the pose question the
  EKF in `slam` structurally cannot answer. A bounded, deterministic particle filter on a
  **known** landmark map — `new` spreads the cloud uniformly over the map (global
  localization), `new_at` seeds it around a known pose (tracking), `predict`/`update` sample
  the motion model and weight against the map, and `estimate` returns a pose, a 3×3
  covariance, an `effective_particles` figure, a `match_quality` consistency score and a
  `LocalizationHealth` verdict. Every step is bound-checked and the four hot methods allocate
  nothing. It **detects** a kidnapped robot (the readings stop matching the map and the health
  goes `Diverged`); it does not rescue one — there is no re-seeding, and that is stated. Its map
  is a `Vec<Landmark>` the caller supplies; the one the crate itself *builds* comes out of a SLAM
  run through `SlamState::landmarks` (`EkfSlam` has no landmark accessor), and
  `tests/localization_e2e.rs` drives that join — noting that the localizer's 256-landmark ceiling
  is below `slam`'s 512, so a large SLAM map is refused with `TooManyLandmarks` and must be
  trimmed first. That join runs a scanner at a **non-zero body-frame offset**, so it pins the
  body-to-world offset rotation both halves apply alongside the heading term; the two halves
  have an offset guard each, which is what makes a sign error in either cross-term fail a test
  rather than pass quietly.
- **`mrac`** — Model-Reference Adaptive Control (Narendra–Valavani) plus a PID with anti-windup.
- **`safety`** — a bounded fault log and a monitor that *detects* rather than predicts, naming the
  rule that fired. It is the last layer before the bus.
- **`driver`** — the three physical-layer drivers (`SerialRobotHal`, `CanRobotHal`,
  `UdpControlRobotHal`) plus `UdpDiscoveryRobotHal`, each wrapping the middleware's
  `StreamRobotHal`. They write real bytes to any `AsyncWrite` (UART device, TCP); the CAN driver
  re-transmits a batch only on a *transient* transport failure. The UDP pair needs `UdpSink`, an
  `AsyncWrite` that turns **one `write` into one datagram** over a `tokio::net::UdpSocket` — the
  socket is not an `AsyncWrite` itself, so an earlier doc's "wrap a `UdpSocket`" was a sentence the
  type system would not accept, and a byte-stream sink that coalesced two frames into one datagram
  would hand the peer a payload it cannot parse. The CAN driver's COB-ID mapping is stated once
  against CiA 301 (`RPDO1 = 0x200 + node_id`, nibble `4`) and the nibble is the deployment's
  choice — this crate has no default for it.
- **`watchdog`** — the **external supervisor** `safety` says it cannot be: a `PetCounter` the
  control loop bumps once per tick (`ControlLoop::with_watchdog`, one relaxed atomic increment,
  no clock read) and a supervisor-side `Watchdog` that owns the clock and polls on its own
  schedule. It detects the one case the in-loop `R1` explicitly cannot — a loop that has
  *stopped calling in altogether* — reporting `WatchdogVerdict::{Alive, Expired}` and the async
  `supervise` helper a deployment spawns. `Watchdog::poll` takes `now` as an argument, so the
  expiry logic is deterministic and testable without real time; the deadline (strict `>`:
  exactly the deadline is not yet expired) is a **policy** the deployment passes. It *reports*;
  it does not act, and it is a software supervisor, not a hardware timer.

The join to the machine is `Actuator::check` and `Platform::plan`: the planner emits the profile's
own set points (`0` steering, `1` throttle, `2` brake for `ground-vehicle`), so a command that
cannot be a frame is refused **here**, naming the profile, instead of at the bus naming a joint.

## Layout

| Path | Contents |
|---|---|
| `src/lib.rs` | crate docs, the module tree, the P0-1 panic gate |
| `src/fusion.rs` | `ImuSample`, `AttitudeEstimator`, `Attitude`, `GravityCorrection`, `YawReference` |
| `src/planning.rs` | `Grid` (`from_rows`/`from_occupancy`/`inflated`/`occupancy`), `plan` (A*), `Path::simplified`/`is_contiguous`/`cost`, `pursuit`/`DriveCommand`, `dwa`/`DwaLimits`/`DwaScore`, `LocalPlanner` (the reactive layer: route supplies the goal, the window supplies the command), `VehicleGeometry` + `DriveCommand::from_velocity` (the `(v, ω)` → set-point join) |
| `src/control.rs` | `CycleStats`, `CycleVerdict`, `CadenceHealth`, `ControlLoop` |
| `src/localization.rs` | `McLocalizer` (particle filter on a known map: `predict`/`update`/`estimate`), `McControl`, `PoseEstimate`, `Particle`, `LocalizationError`, `LocalizationHealth`, `MAX_PARTICLES`, `MAX_LOCALIZATION_LANDMARKS`, `MAX_OBSERVATIONS_PER_UPDATE`, `MATCH_QUALITY_FLOOR` |
| `src/mrac.rs` | `MracController`, `MracStep`, `Pid` |
| `src/safety.rs` | `SafetyMonitor`, `SafetyLimits`, `Heartbeat`, `FaultCode`, `FaultRecord`, `MAX_FAULT_LOG` |
| `src/watchdog.rs` | `PetCounter`, `Watchdog`, `WatchdogVerdict`, `WatchdogOutcome`, `WatchdogError`, `supervise` |
| `src/slam/` | `ekf` (state + updates, single-reading gate + **JCBB** batch association), `landmarks`, `data_assoc` (the standalone gate over a landmark cloud), `loop_closure` (scan match), `occupancy` (log-odds grid) |
| `src/vision/` | `fast` (FAST-9), `lk` (sparse optical flow), `five_point` (eight-point + RANSAC), `vo` (frame-to-frame glue) |
| `src/driver/` | `serial`, `can`, `udp` (its HALs + `UdpSink`) — the physical-layer wire |
| `examples/patrol_loop.rs` | plan → drive → **react** → estimate → tick, offline, one runnable file |
| `examples/serial_loopback.rs` | a serial frame → `RobotBridge` arm/disarm over an in-memory writer |
| `tests/stack_e2e.rs` | the cross-crate joins: set points → JSON → topic → bridge → frames, and a closed-loop drive |
| `tests/{slam_e2e,vision_e2e,mrac_lyapunov,safety_inject}.rs` | the four library modules' end-to-end suites |
| `tests/localization_e2e.rs` | the SLAM→localizer **join**: a map `SlamState` built is handed to `McLocalizer` (plus its bound-mismatch and near-noiseless negative controls) |
| `tests/plan_tree.rs` | `AEROSPACE_PLAN.md`'s module tree names only `.rs` files that exist under `src/` |

## Build & test

```bash
cargo test -p amos-robot                 # 391 unit + 38 integration + 12 doctests, offline
cargo clippy -p amos-robot --all-targets -- -D warnings
cargo run -p amos-robot --example patrol_loop
```

## Examples

| Example | What it shows |
|---|---|
| `patrol_loop` | A full offline patrol: an occupancy map at 1 m cells with a 2-cell inflation, an A* route that is smoothed and then **driven** by a kinematic bicycle under pure pursuit; then the same route re-driven after a pallet the plan never saw appears on it — `LocalPlanner` scores the machine's own reachable velocities (`dwa`) against a *live* map and swerves around it (`closest pass 780 mm from the pallet's centre`); an attitude estimate fed the run's own IMU; and a real `ControlLoop` over the `ground-vehicle` profile whose cadence line is printed (`cadence=held … late=0/4 overruns=0`) — followed by the commander going quiet and the profile's 100 ms deadman stopping the vehicle. |
| `serial_loopback` | The **join** between two separately-tested halves: a serial frame validated by the driver, then folded by `RobotBridge`'s arm/disarm state machine over an in-memory `Loopback` writer that records what was really written (`cargo run -p amos-robot --example serial_loopback`). A unit test on `SerialRobotHal` proves the wire format and one on `RobotBridge` proves the safety core; neither proves they meet. |

## Honest boundaries

1. **No real-time guarantee.** `ControlLoop` paces with `tokio::time` and *measures* what it
   achieved; there is no RT scheduling class, no priority inheritance, no `mlock` and no WCET
   analysis behind it. A deployment that needs bounded lateness needs a machine to validate on —
   and this loop will then report what that machine actually did.
2. **SLAM and vision are not wired to the loop.** The algorithms exist and are unit-tested
   (`slam`: EKF-SLAM with a full covariance, occupancy mapping, scan-match loop closure, data
   association; `vision`: FAST/LK/eight-point/RANSAC frame-to-frame VO), but **nothing consumes
   them here**: `ControlLoop` and the example still take `Pose` and `Grid` from the caller, and no
   camera frame byte reaches Rust — `proto/sensor.proto` ships image *metadata* only, and the
   vision tests build their own pixel buffers. `fusion`'s
   `Attitude` is the natural attitude input for SLAM, but its yaw is dead-reckoned, so a SLAM
   back-end also needs an absolute reference. That closed-loop seam is the Phase-2 work (see
   [`docs/robot-autonomy.md`](../../docs/robot-autonomy.md) §5); an uninflated or stale map is a
   stale plan.
3. **`fusion` is 6-DOF by default and has no covariance.** No linear-acceleration
   compensation, no Kalman state — hence a category (`GravityCorrection`) rather than a σ. A
   9-DOF magnetometer path *does* ship (`AttitudeEstimator::update_with_mag`, `MagSample`,
   `YawReference::Magnetic`), but it too publishes no covariance: it supplies a heading
   reference, not a filter. (The separate `slam::ekf` module *does* carry a full covariance, but
   it is library code, not what `fusion` publishes.)
4. **`pursuit` is a law, not a controller with a stability proof.** One lookahead, one gain, a
   saturation at the actuator's travel; `arrive_radius_mm` must be larger than the machine's
   minimum turn radius (`wheelbase / tan(max steer)`), or the pursuer orbits a goal it cannot turn
   tightly enough to reach.
5. **One vehicle-shaped output.** `DriveCommand` is the `ground-vehicle` set-point triple; a
   quadruped, a drone or a manipulator needs its own command shape (the profile table and the
   frames underneath are shared, the *plan output* is not).
6. **The closed-loop fixtures are geometry, not dynamics.** `BikeModel` in the test and the
   example has no slip, no mass, no tyre model and no actuator lag; it exists to assert "the route
   was driven and the goal was reached", which a real vehicle validation does not inherit.
7. **No device was ever driven.** The `driver` HALs write real bytes into any `AsyncWrite`, but
   nearly every fixture is an in-memory `Loopback`, and the loop in every test and example runs
   over `MockRobotHal`. The one exception is
   `driver::udp::tests::the_udp_sink_sends_one_frame_per_datagram`, which binds two loopback UDP
   sockets so the "one frame is one datagram" contract is measured on a real socket rather than
   asserted about an abstraction — loopback, still, not a servo. No UART, CAN controller, network
   peer, servo or vehicle has been attached to this crate; the real descriptor path in production
   is the middleware's `StreamRobotHal` (`docs/amos-link.md` §3.5).

## Related

- [`docs/robot-autonomy.md`](../../docs/robot-autonomy.md) — design record, the three defects the
  closed-loop test found (§2), the eighteen audit rounds that followed (§3, §6, §7, §8, §9, §10, §11,
  §12, §13, §14, §15, §16, §17, §18, §19, §20, §21, §22 — the last sixteen the half-cell `cell_centre`/`clearance_mm` geometry fix, the UDP
  sink that had been documented but never existed, the CAN COB-ID mapping that was documented three
  different ways, a data-association gate that computed `sqrt` only to square it back, a scan-match
  module whose citation to "Olson *et al.*, IROS 2005" names a paper that does not exist, an LK
  gradient stencil that clamped where its own module doc forbids clamping, a pose-recovery path
  that returned a fabricated motion when no candidate put a correspondence in front of both
  cameras, a doc-only round that also turned up six rustdoc links `cargo doc` refuses, the
  flagship `fusion` module where a `Kp:Ki` ratio was attributed to a paper that states no ratio and
  a `measured: 3.3°` figure reproduces only at `Ki = 0`, and the `mrac` reference model that
  reproduced the perfect plant only at `am = −1` — every fixture's pole and the constructor's
  fallback — so the cited Lyapunov argument did not close and `θ̂` settled biased for any other
  pole, and the `safety` monitor where a `FaultCode` claimed a wire format that does not exist
  (no serde, no reader), four `DEFAULT_*` constants wore `// measured:` for policy choices — one
  of them in a sentence that already said "chosen" — an attitude bound cited a SLAM gate that
  gates *position*, a `u8` index that neither fits 256 nor exists, and an `ISO 80000-3`
  citation for a bound the standard does not state), and the `control` module where a
  `CadenceHealth::Unknown` variant doc claimed a threshold one judged interval wider than
  `health()` implements, a `late_by` field doc measured lateness from the *period* rather than
  `period + slack`, and a "quotation" from the (Chinese) middleware section that appears in
  neither language, and the `slam/ekf` `observe` path where a negative or `NaN`
  `initial_landmark_variance` was silently sanitised — `f32::max` returns the non-NaN operand, so
  `sqrt(NaN)` collapsed through `Landmark::new` to a **zero** covariance, a "perfectly known"
  landmark, while `add_landmark`'s own guard saw only the sanitised `0.0`, and the
  `slam/occupancy` mapper whose `with_origin` doc called its origin the cell's **centre** while
  claiming it matched `planning::Grid`'s — which defines it as the north-west **corner**, a
  half-cell contradiction, and the `vision/fast` detector where a corner's `u16` coordinate was
  silently truncated mod 65 536 for an image wider than `u16::MAX` — a *wrong* corner, not a
  refused one — while its default threshold was said to come from a "`t = 10 .. 20` working range"
  the paper does not state, and the `vision/vo` glue whose `MAX_TRACKED_FEATURES` doc claimed a cap the
  code only applies to *generated* features — a caller-supplied set is tracked verbatim, so the
  bounded-work guarantee the constant exists for is the caller's to keep — while its detector doc
  promised a "spatially-distributed" result the score sort cannot give), the Phase-2 seam for
  SLAM/vision (§5), the verification entry points (§23), and the external watchdog (§32) — the
  supervisor `safety` said it could not be, now wired into `ControlLoop::with_watchdog`.
- [`docs/amos-link.md`](../../docs/amos-link.md) — the middleware underneath, including §4/§6 where
  it says orchestration and odometry belong to this layer.
- [`docs/robot-domains.md`](../../docs/robot-domains.md) — the six platform profiles, their
  actuator tables and their per-domain cadences.
