# amos-robot — the AmOS autonomy stack (fusion · planning · control)

`amos-robot` is the layer **above** [AmOS-Link](../amos-link/README.md): the middleware answers
"who said what to whom, and did the bytes arrive", and this crate answers the three questions a
robot asks before it can move — *which way am I pointing*, *how do I get there*, and *is the loop
holding its cadence*. Part of **[Amos](../../README.md)**, an AI-first OS built as one Cargo
workspace.

> ⚠️ Amos is a research prototype — **not** qualified for flight/medical/DAL-A systems or any
> other safety-critical use (see the [root README](../../README.md)).

## What it is

Three modules, in the order data flows:

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
  route read as cheaper than the route it was made from.
- **`control`** — a cadence-measured control loop around `amos_link::RobotBridge`: `CycleStats`
  distinguishes *lateness* (the tick started late) from *overruns* (the work was longer than the
  period), percentiles come from a bounded window that says so (`window_full`), and `Unknown` is a
  real third verdict for "fewer than two ticks, so there is no interval to judge".

The join to the machine is `Actuator::check` and `Platform::plan`: the planner emits the profile's
own set points (`0` steering, `1` throttle, `2` brake for `ground-vehicle`), so a command that
cannot be a frame is refused **here**, naming the profile, instead of at the bus naming a joint.

## Layout

| Path | Contents |
|---|---|
| `src/lib.rs` | crate docs, the module tree, the P0-1 panic gate |
| `src/fusion.rs` | `ImuSample`, `AttitudeEstimator`, `Attitude`, `GravityCorrection`, `YawReference` |
| `src/planning.rs` | `Grid` (`from_rows`/`from_occupancy`/`inflated`/`occupancy`), `plan` (A*), `Path::simplified`/`is_contiguous`/`cost`, `pursuit`/`DriveCommand` |
| `src/control.rs` | `CycleStats`, `CycleVerdict`, `CadenceHealth`, `ControlLoop` |
| `examples/patrol_loop.rs` | plan → drive → estimate → tick, offline, one runnable file |
| `tests/stack_e2e.rs` | the cross-crate joins: set points → JSON → topic → bridge → frames, and a closed-loop drive |

## Build & test

```bash
cargo test -p amos-robot                 # 51 unit + 2 end-to-end + 10 doc tests, offline
cargo clippy -p amos-robot --all-targets -- -D warnings
cargo run -p amos-robot --example patrol_loop
```

## Examples

| Example | What it shows |
|---|---|
| `patrol_loop` | A full offline patrol: an occupancy map at 1 m cells with a 2-cell inflation, an A* route that is smoothed and then **driven** by a kinematic bicycle under pure pursuit, an attitude estimate fed the run's own IMU, and a real `ControlLoop` over the `ground-vehicle` profile whose cadence line is printed (`cadence=held … late=0/4 overruns=0`) — followed by the commander going quiet and the profile's 100 ms deadman stopping the vehicle. |
| `serial_loopback` | The **join** between two separately-tested halves: a serial frame validated by the driver, then folded by `RobotBridge`'s arm/disarm state machine over an in-memory `Loopback` writer that records what was really written (`cargo run -p amos-robot --example serial_loopback`). A unit test on `SerialRobotHal` proves the wire format and one on `RobotBridge` proves the safety core; neither proves they meet. |

## Honest boundaries

1. **No real-time guarantee.** `ControlLoop` paces with `tokio::time` and *measures* what it
   achieved; there is no RT scheduling class, no priority inheritance, no `mlock` and no WCET
   analysis behind it. A deployment that needs bounded lateness needs a machine to validate on —
   and this loop will then report what that machine actually did.
2. **No SLAM and no perception.** `Grid` is occupancy the **caller** supplies; nothing here
   estimates a map, matches scans or processes an image. That is the Phase-2 seam (see
   [`docs/robot-autonomy.md`](../../docs/robot-autonomy.md)), and an uninflated or stale map is a
   stale plan.
3. **`fusion` is 6-DOF and has no covariance.** No magnetometer, no linear-acceleration
   compensation, no Kalman state — hence a category (`GravityCorrection`) rather than a σ.
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
7. **No device was ever driven** by this crate. The bus in every test and example is
   `MockRobotHal`; the real descriptor path is the middleware's `StreamRobotHal`
   (`docs/amos-link.md` §3.5).

## Related

- [`docs/robot-autonomy.md`](../../docs/robot-autonomy.md) — design record, the two defects the
  closed-loop test found, the Phase-2 seam for SLAM/vision, and the verification entry points.
- [`docs/amos-link.md`](../../docs/amos-link.md) — the middleware underneath, including §4/§6 where
  it says orchestration and odometry belong to this layer.
- [`docs/robot-domains.md`](../../docs/robot-domains.md) — the six platform profiles, their
  actuator tables and their per-domain cadences.
