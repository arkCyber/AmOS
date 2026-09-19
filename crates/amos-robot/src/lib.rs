//! `amos-robot` — the autonomy stack that sits **above** AmOS-Link.
//!
//! [`amos_link`](https://docs.rs/amos-link) answers "who said what to whom, and did the
//! bytes arrive": topics, frames, QoS, discovery, the motor-frame HAL and the safety core
//! (e-stop latch + deadman + refusal-with-a-reason). It deliberately does **not** answer
//! three questions a robot asks before it can move, and `docs/amos-link.md` §4/§6 says so
//! in its own words — orchestration and odometry belong to `amos-robot`, and the profile
//! layer "is not a planner: `goto` generates no trajectory, `lane_keep` does no lateral
//! control" (`docs/robot-domains.md` §6.6). This crate is that missing half:
//!
//! ```text
//!   ① where am I / which way am I pointing     fusion    ← IMU samples
//!   ② how do I get there                        planning  ← occupancy grid + pose
//!   ③ keep doing it on time                     control   ← profile set points
//!         ▲                                                     │
//!         └──────── amos-link: topics · frames · RobotBridge ◄───┘
//! ```
//!
//! * [`fusion`] — one attitude estimator (Mahony, 6-DOF, quaternion internals) that
//!   refuses to lie about what it could not see: an unusable accelerometer yields
//!   `GravityCorrection::GyroOnly { reason }` instead of a drift-free-looking roll, a
//!   stall longer than [`fusion::MAX_DT_S`] is a refused gap rather than silent
//!   continuity, and yaw carries [`fusion::YawReference::DeadReckoned`] until an external
//!   heading was actually supplied (a 6-axis IMU cannot observe yaw — a number that reads
//!   like a heading while being an integral is the defect this field exists to prevent).
//!   The 9-DOF extension (`update_with_mag`) upgrades yaw to [`fusion::YawReference::Magnetic`]
//!   when a magnetometer is present, and [`fusion::AllanVariance`] is the IMU health
//!   monitor (NASA GNC §3.4.4).
//! * [`planning`] — an occupancy [`planning::Grid`] with a bounded cell count, an integer
//!   A* (deterministic tie-breaking: two runs on one map give the same path), diagonal
//!   motion that refuses to cut corners, a line-of-sight smoothing pass, and pure pursuit
//!   that emits [`planning::DriveCommand`] — which is a set-point triple **validated
//!   against the profile's own actuator travel**, not a private coordinate system.
//! * [`control`] — a cadence-measured control loop around [`amos_link::RobotBridge`]. The
//!   loop holds the bridge's [`step`](amos_link::robot_hal::RobotBridge::step) at a
//!   period and *measures* its own lateness/overrun on a bounded window; it does not
//!   claim a real-time guarantee (there is no RT kernel, no priority inheritance, no
//!   `mlock` behind it — see [`control::CycleStats::health`]).
//! * [`mrac`] — Model-Reference Adaptive Control (Lyapunov-proved stable, first-order
//!   SISO), with a classical PID for the deterministic loops and an anti-windup variant
//!   for the saturating ones.
//! * [`safety`] — the **safety monitor** that sits *before* the bus. Heartbeat +
//!   watchdog + divergence + sanity checks, with a bounded fault log and named rules
//!   (`R1` … `R5`).
//! * [`slam`] — EKF-SLAM 2-D (state, prediction, JCBB-style data association,
//!   Mahalanobis-gated nearest neighbour, brute-force 2-D scan-match loop closure, log-odds
//!   occupancy grid mapper, bounded landmark count).
//! * [`vision`] — sparse visual-odometry pipeline (FAST-9 corner detection, sparse
//!   Lucas–Kanade optical flow, 8-point essential matrix + RANSAC, frame-to-frame VO
//!   glue).
//! * [`driver`] — real motor-driver skeletons (`SerialRobotHal`, `CanRobotHal`,
//!   `UdpControlRobotHal`) backed by [`amos_link::robot_hal::StreamRobotHal`]. The
//!   mock HAL remains the default in tests; these drivers are the production wire.
//!
//! Every module here is pure Rust and offline: no network, no device, no clock beyond the
//! caller's. The one cross-crate contract is the profile table — plan output is checked
//! with `Actuator::check`, so a plan that cannot be a frame is refused where the profile
//! is, not at the bus.
//!
//! Registered as `REQ-A408` in `docs/TRACEABILITY_MATRIX.md`; design, honest boundaries
//! and verification entry points are in `docs/robot-autonomy.md`.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod control;
pub mod driver;
pub mod fusion;
pub mod mrac;
pub mod planning;
pub mod safety;
pub mod slam;
pub mod vision;

pub use control::{
    CadenceHealth, ControlLoop, CycleStats, CycleVerdict, LoopError, MAX_CYCLE_SAMPLES,
};
pub use driver::{
    CanFrame, CanId, CanRobotHal, SerialConfig, SerialRobotHal, UdpControlRobotHal,
    UdpDiscoveryRobotHal, MAX_CAN_PAYLOAD, MAX_CAN_TX_RETRIES, MAX_UDP_DISCOVERY_BYTES,
};
pub use fusion::{
    AccelRejection, AllanVariance, AllanVerdict, Attitude, AttitudeEstimator, FusionError,
    GravityCorrection, ImuSample, MagSample, NineAxisStep, YawReference, ACCEL_MAX_G, ACCEL_MIN_G,
    MAX_DT_S, MIN_MAG_FIELD_UT, STANDARD_GRAVITY_M_S2,
};
pub use mrac::{MracController, MracStep, Pid};
pub use planning::{
    plan, Cell, Connectivity, DriveCommand, Grid, Path, PlanError, Pose, PursuitLimits,
    MAX_GRID_CELLS,
};
pub use safety::{FaultCode, FaultRecord, Heartbeat, SafetyLimits, SafetyMonitor, MAX_FAULT_LOG};
pub use slam::{
    scan_match, AssocScratch, Association, EkfSlam, Landmark, LoopClosureReport, OccupancyCell,
    OccupancyError, OccupancyGrid, OccupancyLogodds, ScanMatchConfig, ScanMatchError,
    ScanMatchResult, SlamControl, SlamError, SlamObservation, SlamState, VelocityCommand,
    MAX_LANDMARKS, MAX_SCAN_OPERATIONS, MAX_SCAN_SIZE,
};
pub use vision::{
    track_frame_to_frame, CameraIntrinsics, Corner, Essential, FastConfig, FastDetector,
    FlowVector, LkConfig, LkOutcome, Pose2D, RansacReport, VisualObservation, VisualTracker,
    MAX_RANSAC_ITERATIONS, MAX_TRACKED_FEATURES,
};
