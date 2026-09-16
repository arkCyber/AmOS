//! The **platform profile**: one OS, six machines.
//!
//! AmOS-Link's middleware is form-factor-agnostic by construction (it moves bytes: key
//! expressions, frames, QoS, sequence accounting, the return path). What used to be
//! quadruped-shaped is the layer *above* it: `robot_hal`'s intent vocabulary (`stand`/`trot`/…),
//! its pose table, its 12 joints. A drone, an autonomous car, a surface vessel, an industrial
//! cell and a manipulator need that same safety core with **their own** actuators, units,
//! vocabulary and envelope — not a second copy of the e-stop latch and the deadman.
//!
//! A [`Platform`] is that description. It is **data**, not code:
//!
//! ```text
//!   Platform
//!   ├── actuators  what the machine has (role, unit, travel)      → frames
//!   ├── actions    what it accepts (key, class, pose, params)     → the vocabulary
//!   └── envelope   what it does when the link dies (deadman, failsafe manoeuvre)
//! ```
//!
//! Three things are deliberately **shared** with the reference quadruped, so the domains are
//! not five parallel implementations of the same safety mechanism:
//!
//! 1. **The frame.** A profile plans into the *shipping* [`MotorFrame`] (10 bytes, SOF, op,
//!    `i32` argument, CRC16-CCITT) — no second wire format. The frame's per-op argument bounds
//!    (`±90°`, `0..=100 %`) are the reference policy, and every profile's travel must fit inside
//!    them: an actuator whose set point does not (a linear axis in millimetres, a bidirectional
//!    thruster with negative thrust) is a **registered boundary** below, not a silent
//!    reinterpretation of the field.
//! 2. **The classes.** [`IntentClass`] is the shared shape of intent: `Arm` clears the latch,
//!    `Motion` is refused while e-stopped, `Halt` cuts torque and latches. A profile names its
//!    actions however its domain does (`trot`, `takeoff`, `lane_keep`, `station_keep`, `cycle`,
//!    `grip`) and maps each to one of the three classes — which is all the safety core needs to
//!    know. The *actuation* of a class is the profile's: a car's `Halt` is full brake, a
//!    manipulator's is a per-joint torque cut, a cell's is de-energize.
//! 3. **The deadman.** `RobotBridge` (`for_platform`) enforces the watchdog, the latch, the
//!    refusal-with-a-reason and the return path through one code path for every profile. What
//!    the bridge does when the link dies is the **minimum safe action at this layer** (a torque
//!    cut / a stop); the *manoeuvre* a machine should then perform is named by
//!    [`SafetyEnvelope::failsafe`] and enacted by its mission layer — an aircraft in cruise must
//!    not treat "cut the motors" as its link-loss plan, which is exactly why the manoeuvre is
//!    declared here instead of assumed.
//!
//! The reference quadruped is profile #1 ([`Platform::quadruped`]), and
//! `the_quadruped_profile_reproduces_the_shipping_planner` (integration tests) proves its
//! planning is **byte-identical** to the hand-written `robot_hal::plan` for every gait and
//! speed — so the profile layer is the same mechanism, not a second opinion.
//!
//! Usage:
//! ```text
//! let platform = Platform::drone();
//! let intent = platform.parse_intent(r#"{"action":"goto","params":{"north_mm":120000}}"#)?;
//! let frames = platform.plan(&intent)?;          // the shipping MotorFrame
//! ```
//!
//! **Registered boundaries** (see docs/robot-domains.md — none of these is hidden):
//!
//! * A profile is limited to **12 actuators** (`robot_hal::MAX_JOINT`): `JointId` refuses a larger index
//!   on both the constructor and the wire path. A 24-axis arm needs a profile-scoped id bound —
//!   the *layout* is already generic (`FRAME_LEN`), the bound is the reference machine's policy.
//! * The argument space is the reference policy too: `±90 000` milli-degrees (`SetPosition`) and
//!   `0..=100 000` milli-percent (`SetTorque`, **non-negative** — so "astern thrust" is not
//!   expressible today; the vessel profile documents it as a field item).
//! * There is no per-domain certification here (no DAL/ASIL/SIL claim) and no real-time
//!   guarantee: the profile describes *what* the machine has, not how fast a bus must be.

use std::time::Duration;

use crate::error::{LinkError, Result};
use crate::robot_hal::{
    parse_command, plan as plan_reference, JointId, MotorFrame, MotorOp, RobotCommand,
    MAX_JOINT_MILLI_DEG, MAX_TORQUE_MILLI_PERCENT, MAX_WATCHDOG_MS,
};

/// The domains this middleware serves.
///
/// A kind is a *label*, not a behaviour: everything behavioural lives in the profile's tables.
/// It exists so an operator's document, a log line and a test can say which machine they are
/// talking about without parsing the vocabulary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PlatformKind {
    /// The reference machine: four legs, three joints each.
    Quadruped,
    /// A fixed-base arm (industrial or embodied).
    Manipulator,
    /// A multirotor.
    Drone,
    /// A road vehicle (assisted or autonomous driving).
    GroundVehicle,
    /// A surface vessel.
    SurfaceVessel,
    /// A stationary automation cell (axes and a gripper).
    IndustrialCell,
}

impl PlatformKind {
    /// Stable key for documents, logs and tests.
    pub fn key(self) -> &'static str {
        match self {
            PlatformKind::Quadruped => "quadruped",
            PlatformKind::Manipulator => "manipulator",
            PlatformKind::Drone => "drone",
            PlatformKind::GroundVehicle => "ground-vehicle",
            PlatformKind::SurfaceVessel => "surface-vessel",
            PlatformKind::IndustrialCell => "industrial-cell",
        }
    }

    /// The six profiles this build ships, in a stable order.
    pub fn all() -> [PlatformKind; 6] {
        [
            PlatformKind::Quadruped,
            PlatformKind::Manipulator,
            PlatformKind::Drone,
            PlatformKind::GroundVehicle,
            PlatformKind::SurfaceVessel,
            PlatformKind::IndustrialCell,
        ]
    }

    /// Parse a stable key back. An unknown key is **not** invented (`None`).
    pub fn from_key(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "quadruped" => Some(PlatformKind::Quadruped),
            "manipulator" | "arm" => Some(PlatformKind::Manipulator),
            "drone" | "uav" | "multirotor" => Some(PlatformKind::Drone),
            "ground-vehicle" | "car" | "ugv" | "agv" => Some(PlatformKind::GroundVehicle),
            "surface-vessel" | "usv" | "boat" => Some(PlatformKind::SurfaceVessel),
            "industrial-cell" | "cell" | "plc" => Some(PlatformKind::IndustrialCell),
            _ => None,
        }
    }

    /// True for a machine whose safest end state is *not* "stop": its mission layer must perform
    /// the declared manoeuvre when the link is lost, because a torque cut is not a landing.
    pub fn must_manoeuvre_when_lost(self) -> bool {
        matches!(self, PlatformKind::Drone | PlatformKind::SurfaceVessel)
    }
}

/// The unit a set point is expressed in — integers only, never a float on the wire (two nodes
/// must not disagree about rounding; the reference machine's milli-degrees follow the same rule).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unit {
    /// Milli-degrees, the `SetPosition` argument space (`±90 000` = ±90°).
    MilliDegrees,
    /// Milli-percent of a rated quantity, the `SetTorque` argument space (`0..=100 000`).
    MilliPercent,
}

impl Unit {
    /// Stable key.
    pub fn key(self) -> &'static str {
        match self {
            Unit::MilliDegrees => "mdeg",
            Unit::MilliPercent => "mpercent",
        }
    }

    /// The wire operation this unit's set point travels as.
    ///
    /// Two units, two operations — and the *frame's* per-op bounds are the reference machine's
    /// policy, which is why a profile's travel has to fit inside them.
    pub fn op(self) -> MotorOp {
        match self {
            Unit::MilliDegrees => MotorOp::SetPosition,
            Unit::MilliPercent => MotorOp::SetTorque,
        }
    }

    /// The bounds the frame itself enforces for this unit.
    pub fn frame_bounds(self) -> (i32, i32) {
        match self {
            Unit::MilliDegrees => (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
            Unit::MilliPercent => (0, MAX_TORQUE_MILLI_PERCENT),
        }
    }
}

/// What an actuator physically is (its set point's meaning, for an operator and for a test).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActuatorRole {
    /// A rotating joint (a leg joint, an arm axis, a steering column, a control surface).
    RotaryJoint,
    /// A translating axis (a gantry, a lift). Its set point is a percentage of stroke — see the
    /// millimetre boundary in the module docs.
    LinearAxis,
    /// A propeller / screw / drive (its set point is thrust or throttle, in milli-percent).
    Thrust,
    /// A brake (milli-percent of maximum braking).
    Brake,
    /// A gripper (milli-percent of grip force or of jaw travel).
    Gripper,
}

impl ActuatorRole {
    /// Stable key.
    pub fn key(self) -> &'static str {
        match self {
            ActuatorRole::RotaryJoint => "rotary-joint",
            ActuatorRole::LinearAxis => "linear-axis",
            ActuatorRole::Thrust => "thrust",
            ActuatorRole::Brake => "brake",
            ActuatorRole::Gripper => "gripper",
        }
    }
}

/// One actuator: a bus index, what it is, the unit its set point is in, and its travel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Actuator {
    /// The bus index (the frame's `id` byte).
    pub index: u8,
    /// A name an operator reads (`FL_thigh`, `thruster_3`, `brake`).
    pub name: &'static str,
    /// What it physically is.
    pub role: ActuatorRole,
    /// What its set point means.
    pub unit: Unit,
    /// Travel / range, inclusive, in `unit`.
    pub travel: (i32, i32),
}

impl Actuator {
    /// The wire operation this actuator's set points travel as.
    pub fn op(&self) -> MotorOp {
        self.unit.op()
    }

    /// Check a set point against this actuator's travel **and** the frame's own bounds.
    ///
    /// The second check is not redundant: a profile whose travel is wider than the reference
    /// policy (say a ±180° axis) would build a frame that `MotorFrame::validate` refuses
    /// *later*, at the HAL — where the reason would name a joint instead of the profile that was
    /// wrong. Refusing here keeps the message about the thing that is actually misdeclared.
    pub fn check(&self, arg: i32) -> Result<()> {
        let (min, max) = self.travel;
        if !(min..=max).contains(&arg) {
            return Err(LinkError::Robot(format!(
                "actuator {} ({}) set point {arg} {} is outside its travel {min}..={max}",
                self.index,
                self.name,
                self.unit.key()
            )));
        }
        let (fmin, fmax) = self.unit.frame_bounds();
        if !(fmin..=fmax).contains(&arg) {
            return Err(LinkError::Robot(format!(
                "actuator {} ({}) set point {arg} {} is outside the frame's {fmin}..={fmax} {} \
                 argument space (a registered boundary of this layer)",
                self.index,
                self.name,
                self.unit.key(),
                self.unit.key()
            )));
        }
        Ok(())
    }
}

/// The shared shape of intent — the only three things the safety core has to know.
///
/// A profile's own words (`trot`, `takeoff`, `lane_keep`, `cycle`, …) map onto these; the
/// *actuation* stays the profile's (a car's `Halt` is full brake, a manipulator's is a
/// per-joint torque cut).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentClass {
    /// Energize the drives and clear a latched e-stop.
    Arm,
    /// Move (refused while e-stopped).
    Motion,
    /// Stop now: the profile's torque cut / brake / de-energize, and latch until an `Arm`.
    Halt,
}

impl IntentClass {
    /// Stable key.
    pub fn key(self) -> &'static str {
        match self {
            IntentClass::Arm => "arm",
            IntentClass::Motion => "motion",
            IntentClass::Halt => "halt",
        }
    }
}

/// A bounded integer parameter an action accepts (a geofence radius, a lane offset, a speed cap).
///
/// Parameters are how this layer carries **domain limits that are not actuator set points** —
/// the ones an operator argues about after an incident. They are validated before anything is
/// planned, and a value outside the range is refused *naming the limit*, never clamped: a
/// clamped geofence is a machine flying to a place nobody asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParamSpec {
    /// The JSON name (`north_mm`, `lane_offset_mm`, `speed_mm_s`).
    pub name: &'static str,
    /// The unit the value is in, as an operator reads it (`"mm"`, `"mm/s"`, `"ms"`,
    /// `"milli-percent"`). A string, not a [`Unit`]: a limit in millimetres is not a set point
    /// in milli-percent, and pretending otherwise would put a wrong word in a refusal.
    pub unit: &'static str,
    /// Inclusive bounds.
    pub range: (i32, i32),
}

/// One action of a profile's vocabulary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ActionSpec {
    /// The key an intent names (`trot`, `takeoff`, …).
    pub key: &'static str,
    /// Which of the three shared classes it belongs to.
    pub class: IntentClass,
    /// Per-actuator set points for a `Motion` (one entry per actuator, in the profile's units).
    /// Empty for `Arm`/`Halt`, whose frames the profile derives from its actuator table.
    pub pose: &'static [i32],
    /// Scale the pose by the intent's speed factor (the reference machine's rule: a positive
    /// base becomes `-((base as f32) * (0.5 + 0.5 * speed)) as i32`). A profile that has no such
    /// rule leaves this `false` and its pose is used literally.
    pub speed_scaled: bool,
    /// The parameters this action accepts (validated against [`ParamSpec::range`]).
    pub params: &'static [ParamSpec],
}

/// What a machine should do when the link is lost — the manoeuvre, declared instead of assumed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failsafe {
    /// Keep the last set points and rely on the drives (a rigid, braked axis).
    Hold,
    /// Stop where it is: the profile's `Halt` actuation.
    Stop,
    /// Fly/drive back to the home position (needs a mission layer that knows where home is).
    ReturnToBase,
    /// Descend and land (a multirotor).
    Land,
    /// Reach the road vehicle's minimal-risk state (brake to a stop in lane).
    MinimalRiskManoeuvre,
    /// Keep station within a radius instead of stopping (a vessel in a seaway).
    Loiter,
}

impl Failsafe {
    /// Stable key.
    pub fn key(self) -> &'static str {
        match self {
            Failsafe::Hold => "hold",
            Failsafe::Stop => "stop",
            Failsafe::ReturnToBase => "return-to-base",
            Failsafe::Land => "land",
            Failsafe::MinimalRiskManoeuvre => "minimal-risk-manoeuvre",
            Failsafe::Loiter => "loiter",
        }
    }

    /// Parse a stable key back. An unknown key is **not** invented (`None`).
    pub fn from_key(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "hold" => Some(Failsafe::Hold),
            "stop" => Some(Failsafe::Stop),
            "return-to-base" | "rtl" => Some(Failsafe::ReturnToBase),
            "land" => Some(Failsafe::Land),
            "minimal-risk-manoeuvre" | "mrm" => Some(Failsafe::MinimalRiskManoeuvre),
            "loiter" => Some(Failsafe::Loiter),
            _ => None,
        }
    }

    /// True when the manoeuvre *is* the immediate stop (no mission layer needed).
    pub fn is_stop(self) -> bool {
        matches!(self, Failsafe::Stop | Failsafe::Hold)
    }
}

/// The machine's own safety declaration: how long silence is tolerated, and what is owed to the
/// machine afterwards.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SafetyEnvelope {
    /// The deadman period the bridge runs with (validated against [`MAX_WATCHDOG_MS`]).
    pub watchdog: Duration,
    /// The manoeuvre a mission layer must perform once the bridge has stopped the machine.
    pub failsafe: Failsafe,
}

impl SafetyEnvelope {
    /// Check the envelope is one a bridge can actually honour.
    pub fn validate(&self) -> Result<()> {
        if self.watchdog.is_zero() {
            return Err(LinkError::Robot(
                "a zero deadman period cannot be scheduled (and is not a watchdog)".to_string(),
            ));
        }
        let ms = self.watchdog.as_millis();
        if ms > u128::from(MAX_WATCHDOG_MS) {
            return Err(LinkError::Robot(format!(
                "deadman period {ms}ms exceeds the {MAX_WATCHDOG_MS}ms ceiling a report may carry"
            )));
        }
        Ok(())
    }
}

/// One actuator's set point inside an intent (a joint target, a wheel torque, a steering angle).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SetPoint {
    /// The bus index of the actuator (validated against the profile's table).
    pub actuator: u8,
    /// The argument in the actuator's own unit.
    pub arg: i32,
}

/// A validated intent: what the machine was asked to do, in the machine's own vocabulary.
#[derive(Clone, Debug, PartialEq)]
pub struct Intent {
    /// The action key, as the profile spells it.
    pub action: &'static str,
    /// Which of the three shared classes it belongs to.
    pub class: IntentClass,
    /// The speed factor (`0..=1`), meaningless for `Arm`/`Halt` (kept at 0).
    pub speed: f32,
    /// How long the command should hold, in milliseconds (`0` = until changed).
    pub duration_ms: u32,
    /// Explicit set points that override the action's pose.
    pub set_points: Vec<SetPoint>,
    /// The bounded parameters the action accepted (a geofence target, a lane offset, …).
    pub params: Vec<(&'static str, i32)>,
}

impl Intent {
    /// One accepted parameter, if the intent carried it.
    pub fn param(&self, name: &str) -> Option<i32> {
        self.params
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| *v)
    }
}

/// A machine's description: its actuators, its vocabulary and its safety envelope.
///
/// Built-in profiles are `const`s ([`Platform::quadruped`], [`Platform::drone`], …), so a
/// deployment picks one at compile time and every value is checked by the tests in the
/// integration suite (a vocabulary that disagrees with its own pose table cannot ship).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Platform {
    kind: PlatformKind,
    actuators: &'static [Actuator],
    actions: &'static [ActionSpec],
    envelope: SafetyEnvelope,
    /// A `Motion` plan starts with an `Enable` on actuator 0 — the reference machine's shape.
    /// A profile that arms explicitly (via its `Arm` action) leaves this `false`.
    arm_on_motion: bool,
}

impl Platform {
    /// The machine's kind.
    pub fn kind(&self) -> PlatformKind {
        self.kind
    }

    /// Its actuators, in bus order.
    pub fn actuators(&self) -> &'static [Actuator] {
        self.actuators
    }

    /// Its vocabulary.
    pub fn actions(&self) -> &'static [ActionSpec] {
        self.actions
    }

    /// Its safety declaration.
    pub fn envelope(&self) -> SafetyEnvelope {
        self.envelope
    }

    /// One actuator by bus index.
    pub fn actuator(&self, index: u8) -> Option<&'static Actuator> {
        self.actuators.iter().find(|a| a.index == index)
    }

    /// One action by key.
    pub fn action(&self, key: &str) -> Option<&'static ActionSpec> {
        self.actions.iter().find(|a| a.key == key)
    }

    /// The single action of a class, when the profile declares exactly one (every profile
    /// declares exactly one `Arm` and one `Halt`; the tests pin that).
    pub fn action_of_class(&self, class: IntentClass) -> Option<&'static ActionSpec> {
        let mut found = self.actions.iter().filter(|a| a.class == class);
        let first = found.next()?;
        found.next().is_none().then_some(first)
    }
}

/// The JSON an agent (or a plan, or a tool) sends — the profile decides what is valid.
#[derive(serde::Deserialize)]
struct RawIntent {
    /// The action key.
    action: String,
    /// Optional speed factor (`0..=1`).
    #[serde(default)]
    speed: Option<f32>,
    /// Optional hold time in ms.
    #[serde(default)]
    duration_ms: Option<u32>,
    /// Optional explicit set points (validated against the actuator's travel).
    #[serde(default)]
    targets: Vec<RawSetPoint>,
    /// Optional bounded parameters (validated against the action's [`ParamSpec`] list).
    #[serde(default)]
    params: std::collections::BTreeMap<String, i32>,
}

/// One set point in its JSON form.
#[derive(serde::Deserialize)]
struct RawSetPoint {
    /// The actuator's bus index.
    actuator: u8,
    /// The argument, in the actuator's unit.
    arg: i32,
}

impl Platform {
    /// Parse and validate an intent for **this** machine.
    ///
    /// The rules mirror the reference machine's `parse_command` on purpose:
    ///
    /// * a `Halt` is never refused for a cosmetic reason (a speed typo must not block an
    ///   e-stop), and its targets/parameters are ignored — a stop does not need them;
    /// * an `Arm` ignores a speed and any set points (arming is an energize, not a motion, and a
    ///   joint target after an e-stop would be a hidden motion command);
    /// * a `Motion` validates its speed, its set points (travel **and** the frame's argument
    ///   space) and its parameters. An **unknown** parameter is refused: an unrecognised limit is
    ///   not a hint, and silently dropping a geofence parameter is the failure this layer exists
    ///   to catch.
    pub fn parse_intent(&self, json: &str) -> Result<Intent> {
        let raw: RawIntent = serde_json::from_str(json)
            .map_err(|e| LinkError::Robot(format!("action is not valid JSON: {e}")))?;
        let spec = self.action(&raw.action).ok_or_else(|| {
            LinkError::Robot(format!(
                "unknown action `{}` for platform {} (this profile has: {})",
                raw.action,
                self.kind.key(),
                self.actions
                    .iter()
                    .map(|a| a.key)
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })?;
        let duration_ms = raw.duration_ms.unwrap_or(0);
        if !matches!(spec.class, IntentClass::Motion) {
            return Ok(Intent {
                action: spec.key,
                class: spec.class,
                speed: 0.0,
                duration_ms,
                set_points: Vec::new(),
                params: Vec::new(),
            });
        }
        let speed = raw.speed.unwrap_or(0.5);
        if !(0.0..=1.0).contains(&speed) {
            return Err(LinkError::Robot(format!("speed {speed} is outside [0, 1]")));
        }
        let mut set_points = Vec::with_capacity(raw.targets.len());
        for t in &raw.targets {
            let actuator = self.actuator(t.actuator).ok_or_else(|| {
                LinkError::Robot(format!(
                    "platform {} has no actuator {}",
                    self.kind.key(),
                    t.actuator
                ))
            })?;
            actuator.check(t.arg)?;
            set_points.push(SetPoint {
                actuator: t.actuator,
                arg: t.arg,
            });
        }
        let mut params = Vec::with_capacity(raw.params.len());
        for (name, value) in &raw.params {
            let param = spec.params.iter().find(|p| p.name == name).ok_or_else(|| {
                LinkError::Robot(format!(
                    "action `{}` on platform {} has no parameter `{name}`",
                    spec.key,
                    self.kind.key()
                ))
            })?;
            let (min, max) = param.range;
            if !(min..=max).contains(value) {
                return Err(LinkError::Robot(format!(
                    "{name} {value} {} is outside the limit {min}..={max} of action `{}` ({})",
                    param.unit,
                    spec.key,
                    self.kind.key()
                )));
            }
            params.push((param.name, *value));
        }
        Ok(Intent {
            action: spec.key,
            class: spec.class,
            speed,
            duration_ms,
            set_points,
            params,
        })
    }
}

impl Platform {
    /// Plan a validated intent into the **shipping** motor frames.
    ///
    /// * `Halt` — each brake goes to full braking, every other actuator is cut (`Estop`): one
    ///   rule that expresses all three meanings (the reference machine has no brake, so its halt
    ///   is the per-joint cut it always was);
    /// * `Arm` — `Enable` per actuator (the reference machine's 12-frame batch);
    /// * `Motion` — one set point per actuator from the action's pose, overridden by the
    ///   intent's targets; the reference machine's leading `Enable` is kept for it alone.
    ///
    /// Every frame is validated here (travel **and** the frame's own argument space), so a
    /// misdeclared profile fails at planning with a message naming the profile, instead of at the
    /// HAL with one naming a joint.
    pub fn plan(&self, intent: &Intent) -> Result<Vec<MotorFrame>> {
        match intent.class {
            IntentClass::Halt => self.halt_frames(),
            IntentClass::Arm => self.enable_frames(),
            IntentClass::Motion => self.motion_frames(intent),
        }
    }

    /// The stop: full braking on every brake, a torque cut on everything else.
    pub fn halt_frames(&self) -> Result<Vec<MotorFrame>> {
        self.actuators
            .iter()
            .map(|a| match a.role {
                ActuatorRole::Brake => {
                    let frame = MotorFrame::new(self.joint(a)?, MotorOp::SetTorque, a.travel.1);
                    frame.validate()?;
                    Ok(frame)
                }
                _ => Ok(MotorFrame::new(self.joint(a)?, MotorOp::Estop, 0)),
            })
            .collect()
    }

    /// The energize: one `Enable` per actuator.
    pub fn enable_frames(&self) -> Result<Vec<MotorFrame>> {
        self.actuators
            .iter()
            .map(|a| Ok(MotorFrame::new(self.joint(a)?, MotorOp::Enable, 0)))
            .collect()
    }

    /// A motion: the action's pose, overridden by the intent's set points.
    fn motion_frames(&self, intent: &Intent) -> Result<Vec<MotorFrame>> {
        let spec = self.action(intent.action).ok_or_else(|| {
            LinkError::Robot(format!(
                "platform {} has no action `{}`",
                self.kind.key(),
                intent.action
            ))
        })?;
        if spec.pose.is_empty() {
            // An empty pose means "the intent must name every actuator" (the teleop shape): a
            // partial vector is refused, never completed with zeros — a zero is a set point.
            for actuator in self.actuators {
                if !intent
                    .set_points
                    .iter()
                    .any(|s| s.actuator == actuator.index)
                {
                    return Err(LinkError::Robot(format!(
                        "action `{}` on platform {} needs a set point for every actuator, and \
                         actuator {} ({}) is missing",
                        spec.key,
                        self.kind.key(),
                        actuator.index,
                        actuator.name
                    )));
                }
            }
        } else if spec.pose.len() != self.actuators.len() {
            return Err(LinkError::Robot(format!(
                "platform {}: action `{}` has {} pose entries for {} actuators",
                self.kind.key(),
                spec.key,
                spec.pose.len(),
                self.actuators.len()
            )));
        }
        if spec.pose.is_empty() && spec.speed_scaled {
            return Err(LinkError::Robot(format!(
                "platform {}: action `{}` has no pose to scale by speed",
                self.kind.key(),
                spec.key
            )));
        }
        let mut frames = Vec::with_capacity(self.actuators.len() + 1);
        if self.arm_on_motion {
            frames.push(MotorFrame::new(
                self.joint(&self.actuators[0])?,
                MotorOp::Enable,
                0,
            ));
        }
        for (index, actuator) in self.actuators.iter().enumerate() {
            // The intent's set point wins; otherwise the action's pose, scaled by speed when the
            // profile scales (the reference machine's rule). An empty pose has no base at all —
            // the completeness check above already refused a missing set point, and `get` keeps
            // that honest instead of indexing past a short table.
            let arg = match intent
                .set_points
                .iter()
                .find(|s| s.actuator == actuator.index)
            {
                Some(target) => target.arg,
                None => {
                    let base = spec.pose.get(index).copied().ok_or_else(|| {
                        LinkError::Robot(format!(
                            "platform {}: action `{}` has no pose entry for actuator {} ({})",
                            self.kind.key(),
                            spec.key,
                            actuator.index,
                            actuator.name
                        ))
                    })?;
                    if spec.speed_scaled {
                        // The reference machine's rule, kept verbatim (its poses store a
                        // *positive* base that the speed factor extends).
                        -((base as f32) * (0.5 + 0.5 * intent.speed)) as i32
                    } else {
                        base
                    }
                }
            };
            actuator.check(arg)?;
            let frame = MotorFrame::new(self.joint(actuator)?, actuator.op(), arg);
            frame.validate()?;
            frames.push(frame);
        }
        Ok(frames)
    }

    /// The `JointId` for an actuator — the profile's length is the only reason this can fail
    /// (the tests pin that every built-in profile fits; see the 12-actuator boundary).
    fn joint(&self, actuator: &Actuator) -> Result<JointId> {
        JointId::new(actuator.index)
    }
}

// ── the six profiles ───────────────────────────────────────────────────────────────
//
// A profile is a `const` table: a deployment picks one, and the integration tests check every
// one of them (a vocabulary that disagrees with its own pose table cannot ship).

/// The reference machine's actuators: four legs × (hip, thigh, knee), travel ±90°.
const QUADRUPED_ACTUATORS: &[Actuator] = &[
    Actuator {
        index: 0,
        name: "FL_hip",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 1,
        name: "FL_thigh",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 2,
        name: "FL_knee",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 3,
        name: "FR_hip",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 4,
        name: "FR_thigh",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 5,
        name: "FR_knee",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 6,
        name: "RL_hip",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 7,
        name: "RL_thigh",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 8,
        name: "RL_knee",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 9,
        name: "RR_hip",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 10,
        name: "RR_thigh",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 11,
        name: "RR_knee",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
];

/// The reference machine's vocabulary. The poses are the **positive bases** `Gait::pose` feeds to
/// its speed rule, which is why `speed_scaled` is true for all four gaits.
const QUADRUPED_ACTIONS: &[ActionSpec] = &[
    ActionSpec {
        key: "stand",
        class: IntentClass::Motion,
        speed_scaled: true,
        params: &[],
        pose: &[
            0, 35_000, 60_000, 0, 35_000, 60_000, 0, 35_000, 60_000, 0, 35_000, 60_000,
        ],
    },
    ActionSpec {
        key: "trot",
        class: IntentClass::Motion,
        speed_scaled: true,
        params: &[],
        pose: &[
            0, 20_000, 45_000, 0, 45_000, 80_000, 0, 45_000, 80_000, 0, 20_000, 45_000,
        ],
    },
    ActionSpec {
        key: "walk",
        class: IntentClass::Motion,
        speed_scaled: true,
        params: &[],
        pose: &[
            0, 30_000, 55_000, 0, 30_000, 55_000, 0, 30_000, 55_000, 0, 30_000, 55_000,
        ],
    },
    ActionSpec {
        key: "sit",
        class: IntentClass::Motion,
        speed_scaled: true,
        params: &[],
        pose: &[
            0, 70_000, 30_000, 0, 70_000, 30_000, 0, 20_000, 10_000, 0, 20_000, 10_000,
        ],
    },
    ActionSpec {
        key: "arm",
        class: IntentClass::Arm,
        speed_scaled: false,
        params: &[],
        pose: &[0; 12],
    },
    ActionSpec {
        key: "estop",
        class: IntentClass::Halt,
        speed_scaled: false,
        params: &[],
        pose: &[0; 12],
    },
];

/// The multirotor profile: four thrusters and two elevons.
///
/// What it makes explicit that a pure pub/sub demo would hide: `goto` carries a **geofence
/// target** (`north_mm`/`east_mm`/`altitude_mm`) that is refused outside the envelope, and the
/// link-loss answer is `return-to-base` — a torque cut is not a landing, so the manoeuvre is
/// declared here and performed by the mission layer (the case).
const DRONE_ACTUATORS: &[Actuator] = &[
    Actuator {
        index: 0,
        name: "thruster_1",
        role: ActuatorRole::Thrust,
        unit: Unit::MilliPercent,
        travel: (0, MAX_TORQUE_MILLI_PERCENT),
    },
    Actuator {
        index: 1,
        name: "thruster_2",
        role: ActuatorRole::Thrust,
        unit: Unit::MilliPercent,
        travel: (0, MAX_TORQUE_MILLI_PERCENT),
    },
    Actuator {
        index: 2,
        name: "thruster_3",
        role: ActuatorRole::Thrust,
        unit: Unit::MilliPercent,
        travel: (0, MAX_TORQUE_MILLI_PERCENT),
    },
    Actuator {
        index: 3,
        name: "thruster_4",
        role: ActuatorRole::Thrust,
        unit: Unit::MilliPercent,
        travel: (0, MAX_TORQUE_MILLI_PERCENT),
    },
    Actuator {
        index: 4,
        name: "elevon_left",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-30_000, 30_000),
    },
    Actuator {
        index: 5,
        name: "elevon_right",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-30_000, 30_000),
    },
];

/// The drone's geofence: 300 m from the pad, 120 m up. The bounds belong to the *action*, which
/// is why a refusal can name exactly which limit was asked to be exceeded.
const DRONE_FENCE: &[ParamSpec] = &[
    ParamSpec {
        name: "north_mm",
        unit: "mm",
        range: (-300_000, 300_000),
    },
    ParamSpec {
        name: "east_mm",
        unit: "mm",
        range: (-300_000, 300_000),
    },
    ParamSpec {
        name: "altitude_mm",
        unit: "mm",
        range: (0, 120_000),
    },
];

const DRONE_ACTIONS: &[ActionSpec] = &[
    ActionSpec {
        key: "takeoff",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[],
        pose: &[55_000, 55_000, 55_000, 55_000, 0, 0],
    },
    ActionSpec {
        key: "hover",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[],
        pose: &[55_000, 55_000, 55_000, 55_000, 0, 0],
    },
    ActionSpec {
        key: "goto",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: DRONE_FENCE,
        pose: &[58_000, 58_000, 58_000, 58_000, 0, 0],
    },
    ActionSpec {
        key: "rtl",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[],
        pose: &[60_000, 60_000, 60_000, 60_000, 0, 0],
    },
    ActionSpec {
        key: "land",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[],
        pose: &[35_000, 35_000, 35_000, 35_000, 0, 0],
    },
    ActionSpec {
        key: "arm",
        class: IntentClass::Arm,
        speed_scaled: false,
        params: &[],
        pose: &[0; 6],
    },
    ActionSpec {
        key: "estop",
        class: IntentClass::Halt,
        speed_scaled: false,
        params: &[],
        pose: &[0; 6],
    },
];

/// The manipulator profile: six rotary axes and a gripper.
///
/// `move` and `grip` have an **empty pose**, which means "the intent must supply a set point for
/// every actuator" — the teleop shape. It exists so a partial command can never be silently
/// completed with zeros: a short vector is refused, not interpreted.
const MANIPULATOR_ACTUATORS: &[Actuator] = &[
    Actuator {
        index: 0,
        name: "j1",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 1,
        name: "j2",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 2,
        name: "j3",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 3,
        name: "j4",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 4,
        name: "j5",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 5,
        name: "j6",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-MAX_JOINT_MILLI_DEG, MAX_JOINT_MILLI_DEG),
    },
    Actuator {
        index: 6,
        name: "gripper",
        role: ActuatorRole::Gripper,
        unit: Unit::MilliPercent,
        travel: (0, MAX_TORQUE_MILLI_PERCENT),
    },
];

const MANIPULATOR_ACTIONS: &[ActionSpec] = &[
    ActionSpec {
        key: "home",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[],
        pose: &[0; 7],
    },
    ActionSpec {
        key: "ready",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[],
        pose: &[10_000, -20_000, 15_000, 0, -10_000, 5_000, 0],
    },
    ActionSpec {
        key: "move",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[ParamSpec {
            name: "speed_milli_percent",
            unit: "milli-percent",
            range: (0, MAX_TORQUE_MILLI_PERCENT),
        }],
        pose: &[],
    },
    ActionSpec {
        key: "grip",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[ParamSpec {
            name: "force_milli_percent",
            unit: "milli-percent",
            range: (0, MAX_TORQUE_MILLI_PERCENT),
        }],
        pose: &[],
    },
    ActionSpec {
        key: "arm",
        class: IntentClass::Arm,
        speed_scaled: false,
        params: &[],
        pose: &[0; 7],
    },
    ActionSpec {
        key: "estop",
        class: IntentClass::Halt,
        speed_scaled: false,
        params: &[],
        pose: &[0; 7],
    },
];

/// The road-vehicle profile: steering, throttle, brake.
///
/// Its `estop` is **full braking**, not a torque cut — which is the point of the shared class:
/// `Halt` means "stop now by this machine's own definition". The link-loss answer is the
/// minimal-risk manoeuvre, and the `cruise`/`slow` actions carry the speed and deceleration
/// limits the envelope allows.
const VEHICLE_ACTUATORS: &[Actuator] = &[
    Actuator {
        index: 0,
        name: "steering",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-40_000, 40_000),
    },
    Actuator {
        index: 1,
        name: "throttle",
        role: ActuatorRole::Thrust,
        unit: Unit::MilliPercent,
        travel: (0, MAX_TORQUE_MILLI_PERCENT),
    },
    Actuator {
        index: 2,
        name: "brake",
        role: ActuatorRole::Brake,
        unit: Unit::MilliPercent,
        travel: (0, MAX_TORQUE_MILLI_PERCENT),
    },
];

const VEHICLE_ACTIONS: &[ActionSpec] = &[
    ActionSpec {
        key: "hold",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[],
        pose: &[0, 0, 0],
    },
    ActionSpec {
        key: "lane_keep",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[ParamSpec {
            name: "lane_offset_mm",
            unit: "mm",
            range: (-1_750, 1_750),
        }],
        pose: &[0, 20_000, 0],
    },
    ActionSpec {
        key: "cruise",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[ParamSpec {
            name: "speed_mm_s",
            unit: "mm/s",
            range: (0, 36_000),
        }],
        pose: &[0, 30_000, 0],
    },
    ActionSpec {
        key: "slow",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[ParamSpec {
            name: "decel_mm_s2",
            unit: "mm/s2",
            range: (0, 4_000),
        }],
        pose: &[0, 0, 60_000],
    },
    ActionSpec {
        key: "arm",
        class: IntentClass::Arm,
        speed_scaled: false,
        params: &[],
        pose: &[0; 3],
    },
    ActionSpec {
        key: "estop",
        class: IntentClass::Halt,
        speed_scaled: false,
        params: &[],
        pose: &[0; 3],
    },
];

/// The surface-vessel profile: two thrusters and a rudder.
///
/// **Registered boundary**: the frame's `SetTorque` argument is non-negative, so *astern* thrust
/// is not expressible today (see the module docs) — this profile is a twin-screw boat that
/// steers with the rudder and answers a lost link by **loitering** within a declared radius.
const VESSEL_ACTUATORS: &[Actuator] = &[
    Actuator {
        index: 0,
        name: "thruster_port",
        role: ActuatorRole::Thrust,
        unit: Unit::MilliPercent,
        travel: (0, MAX_TORQUE_MILLI_PERCENT),
    },
    Actuator {
        index: 1,
        name: "thruster_starboard",
        role: ActuatorRole::Thrust,
        unit: Unit::MilliPercent,
        travel: (0, MAX_TORQUE_MILLI_PERCENT),
    },
    Actuator {
        index: 2,
        name: "rudder",
        role: ActuatorRole::RotaryJoint,
        unit: Unit::MilliDegrees,
        travel: (-35_000, 35_000),
    },
];

const VESSEL_ACTIONS: &[ActionSpec] = &[
    ActionSpec {
        key: "station_keep",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[ParamSpec {
            name: "radius_mm",
            unit: "mm",
            range: (0, 50_000),
        }],
        pose: &[40_000, 40_000, 0],
    },
    ActionSpec {
        key: "waypoint",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[
            ParamSpec {
                name: "x_mm",
                unit: "mm",
                range: (-500_000, 500_000),
            },
            ParamSpec {
                name: "y_mm",
                unit: "mm",
                range: (-500_000, 500_000),
            },
            ParamSpec {
                name: "speed_mm_s",
                unit: "mm/s",
                range: (0, 8_000),
            },
        ],
        pose: &[50_000, 50_000, 0],
    },
    ActionSpec {
        key: "loiter",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[ParamSpec {
            name: "radius_mm",
            unit: "mm",
            range: (0, 50_000),
        }],
        pose: &[30_000, 30_000, 0],
    },
    ActionSpec {
        key: "arm",
        class: IntentClass::Arm,
        speed_scaled: false,
        params: &[],
        pose: &[0; 3],
    },
    ActionSpec {
        key: "estop",
        class: IntentClass::Halt,
        speed_scaled: false,
        params: &[],
        pose: &[0; 3],
    },
];

/// The industrial-cell profile: three axes (as a percentage of stroke — see the millimetre
/// boundary) and a gripper.
///
/// Its `stop` is a **de-energize** (every actuator gets an `Estop` frame), which is what a
/// guarded cell does; the envelope's deadman is the shortest of the six (a cell has people in
/// it, and its link is usually a wire).
const CELL_ACTUATORS: &[Actuator] = &[
    Actuator {
        index: 0,
        name: "axis_x",
        role: ActuatorRole::LinearAxis,
        unit: Unit::MilliPercent,
        travel: (0, MAX_TORQUE_MILLI_PERCENT),
    },
    Actuator {
        index: 1,
        name: "axis_y",
        role: ActuatorRole::LinearAxis,
        unit: Unit::MilliPercent,
        travel: (0, MAX_TORQUE_MILLI_PERCENT),
    },
    Actuator {
        index: 2,
        name: "axis_z",
        role: ActuatorRole::LinearAxis,
        unit: Unit::MilliPercent,
        travel: (0, MAX_TORQUE_MILLI_PERCENT),
    },
    Actuator {
        index: 3,
        name: "gripper",
        role: ActuatorRole::Gripper,
        unit: Unit::MilliPercent,
        travel: (0, MAX_TORQUE_MILLI_PERCENT),
    },
];

const CELL_ACTIONS: &[ActionSpec] = &[
    ActionSpec {
        key: "home",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[],
        pose: &[0, 0, 0, 0],
    },
    ActionSpec {
        key: "cycle",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[ParamSpec {
            name: "cycle_ms",
            unit: "ms",
            range: (100, 60_000),
        }],
        pose: &[50_000, 50_000, 50_000, 0],
    },
    ActionSpec {
        key: "pick",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[],
        pose: &[40_000, 40_000, 20_000, 70_000],
    },
    ActionSpec {
        key: "release",
        class: IntentClass::Motion,
        speed_scaled: false,
        params: &[],
        pose: &[40_000, 40_000, 20_000, 0],
    },
    ActionSpec {
        key: "enable",
        class: IntentClass::Arm,
        speed_scaled: false,
        params: &[],
        pose: &[0; 4],
    },
    ActionSpec {
        key: "stop",
        class: IntentClass::Halt,
        speed_scaled: false,
        params: &[],
        pose: &[0; 4],
    },
];

impl Platform {
    /// The reference machine: four legs, twelve joints, the vocabulary `robot_hal` shipped with.
    pub const fn quadruped() -> Self {
        Self {
            kind: PlatformKind::Quadruped,
            actuators: QUADRUPED_ACTUATORS,
            actions: QUADRUPED_ACTIONS,
            envelope: SafetyEnvelope {
                watchdog: Duration::from_millis(500),
                failsafe: Failsafe::Stop,
            },
            // Its gait frames carry a leading `Enable` on joint 0 — kept verbatim, because the
            // profile layer must reproduce what the machine already did, quirk included.
            arm_on_motion: true,
        }
    }

    /// A fixed-base arm: six axes and a gripper, torque cut on `estop`.
    pub const fn manipulator() -> Self {
        Self {
            kind: PlatformKind::Manipulator,
            actuators: MANIPULATOR_ACTUATORS,
            actions: MANIPULATOR_ACTIONS,
            envelope: SafetyEnvelope {
                watchdog: Duration::from_millis(100),
                failsafe: Failsafe::Hold,
            },
            arm_on_motion: false,
        }
    }

    /// A multirotor: four thrusters and two elevons, `return-to-base` on a lost link.
    pub const fn drone() -> Self {
        Self {
            kind: PlatformKind::Drone,
            actuators: DRONE_ACTUATORS,
            actions: DRONE_ACTIONS,
            envelope: SafetyEnvelope {
                watchdog: Duration::from_millis(300),
                failsafe: Failsafe::ReturnToBase,
            },
            arm_on_motion: false,
        }
    }

    /// A road vehicle: steering, throttle, brake; `estop` is full braking.
    pub const fn ground_vehicle() -> Self {
        Self {
            kind: PlatformKind::GroundVehicle,
            actuators: VEHICLE_ACTUATORS,
            actions: VEHICLE_ACTIONS,
            envelope: SafetyEnvelope {
                // 100 Hz control with a 100 ms deadman: ten missed set points, not one.
                watchdog: Duration::from_millis(100),
                failsafe: Failsafe::MinimalRiskManoeuvre,
            },
            arm_on_motion: false,
        }
    }

    /// A surface vessel: two thrusters and a rudder, `loiter` on a lost link.
    pub const fn surface_vessel() -> Self {
        Self {
            kind: PlatformKind::SurfaceVessel,
            actuators: VESSEL_ACTUATORS,
            actions: VESSEL_ACTIONS,
            envelope: SafetyEnvelope {
                watchdog: Duration::from_millis(500),
                failsafe: Failsafe::Loiter,
            },
            arm_on_motion: false,
        }
    }

    /// An industrial cell: three axes and a gripper, de-energize on `stop`.
    pub const fn industrial_cell() -> Self {
        Self {
            kind: PlatformKind::IndustrialCell,
            actuators: CELL_ACTUATORS,
            actions: CELL_ACTIONS,
            envelope: SafetyEnvelope {
                // The shortest deadman of the six: a cell has people in it, and its link is
                // usually a wire.
                watchdog: Duration::from_millis(50),
                failsafe: Failsafe::Stop,
            },
            arm_on_motion: false,
        }
    }

    /// The profile of a kind — the six this build ships.
    pub const fn of_kind(kind: PlatformKind) -> Self {
        match kind {
            PlatformKind::Quadruped => Self::quadruped(),
            PlatformKind::Manipulator => Self::manipulator(),
            PlatformKind::Drone => Self::drone(),
            PlatformKind::GroundVehicle => Self::ground_vehicle(),
            PlatformKind::SurfaceVessel => Self::surface_vessel(),
            PlatformKind::IndustrialCell => Self::industrial_cell(),
        }
    }
}

/// How a control loop reads the control channel: the reference machine's vocabulary, or a
/// platform profile's.
///
/// This is the seam that keeps **one** safety core: `RobotBridge` holds a `Vocabulary`, so the
/// e-stop latch, the deadman, the refusal-with-a-reason and the return path are the same code
/// for a quadruped, a drone and a car. `Reference` is the shipping behaviour, byte for byte — a
/// test pins that it is not a re-spelling of it.
#[derive(Clone, Copy, Debug)]
pub enum Vocabulary {
    /// `robot_hal`'s own gaits (`stand`/`trot`/`walk`/`sit`/`arm`/`estop`).
    Reference,
    /// A platform profile's vocabulary ([`Platform`]).
    Profile(&'static Platform),
}

impl Vocabulary {
    /// Parse an action into the shared intent shape.
    pub fn parse(&self, json: &str) -> Result<Intent> {
        match self {
            Vocabulary::Reference => {
                let command = parse_command(json)?;
                let class = if command.gait.is_arm() {
                    IntentClass::Arm
                } else if command.gait.is_emergency() {
                    IntentClass::Halt
                } else {
                    IntentClass::Motion
                };
                Ok(Intent {
                    action: command.gait.key(),
                    class,
                    speed: command.speed,
                    duration_ms: command.duration_ms,
                    set_points: command
                        .targets
                        .iter()
                        .map(|t| SetPoint {
                            actuator: t.joint.index(),
                            arg: t.milli_deg,
                        })
                        .collect(),
                    params: Vec::new(),
                })
            }
            Vocabulary::Profile(platform) => platform.parse_intent(json),
        }
    }

    /// Plan a validated intent into the shipping frames.
    pub fn plan(&self, intent: &Intent) -> Result<Vec<MotorFrame>> {
        match self {
            Vocabulary::Reference => {
                // The reference path expects an action that is one of the six `Gait` keys
                // (`stand`/`trot`/…); the bridge's contract is that every intent entering the
                // `Reference` vocabulary arrived via [`Vocabulary::parse`] (or `RobotHal::plan`),
                // both of which validate against the gait table. A hand-built `Intent` with an
                // action outside those keys will fail with the bare `"unknown action \`…\`"`
                // — that is the intentional message, since this vocabulary is the reference
                // machine's vocabulary and a non-gait key has no frame shape here.
                let gait = crate::robot_hal::Gait::from_key(intent.action).ok_or_else(|| {
                    LinkError::Robot(format!("unknown action `{}`", intent.action))
                })?;
                let mut targets = Vec::with_capacity(intent.set_points.len());
                for point in &intent.set_points {
                    targets.push(crate::robot_hal::JointTarget::new(
                        JointId::new(point.actuator)?,
                        point.arg,
                    )?);
                }
                Ok(plan_reference(&RobotCommand {
                    gait,
                    speed: intent.speed,
                    duration_ms: intent.duration_ms,
                    targets,
                }))
            }
            Vocabulary::Profile(platform) => platform.plan(intent),
        }
    }

    /// The sentence a refusal carries: which action re-arms this machine.
    ///
    /// The wording is the reference machine's, verbatim, for `Reference`; a profile substitutes
    /// its own arm key (`enable` for a cell), so an operator is never told to send an action this
    /// machine does not have.
    pub fn arm_hint(&self) -> String {
        format!(
            "e-stop latched: send {{\"action\":\"{}\"}} to re-arm",
            self.arm_key()
        )
    }

    /// The `Arm` action's key for this vocabulary.
    pub fn arm_key(&self) -> &'static str {
        match self {
            Vocabulary::Reference => "arm",
            Vocabulary::Profile(platform) => platform
                .action_of_class(IntentClass::Arm)
                .map(|a| a.key)
                .unwrap_or("arm"),
        }
    }

    /// True when a `Motion` plan energizes the drives itself.
    ///
    /// The reference machine's gaits carry a leading `Enable`, so they do. A profile that arms
    /// explicitly (a drone, a car, a cell) does not — and then a set point on **disarmed** drives
    /// is refused rather than written: "the throttle moved and nothing happened" is the shape of
    /// accident this check exists to prevent.
    pub fn self_arms_on_motion(&self) -> bool {
        match self {
            Vocabulary::Reference => true,
            Vocabulary::Profile(platform) => platform.arm_on_motion,
        }
    }

    /// The sentence for a motion while the drives are de-energized.
    pub fn disarmed_hint(&self) -> String {
        format!(
            "not armed: send {{\"action\":\"{}\"}} first",
            self.arm_key()
        )
    }

    /// The profile behind this vocabulary, when there is one (see `RobotBridge`'s deadman: a
    /// profile's stop is its own halt batch; the reference machine's is its HAL's).
    pub fn platform(&self) -> Option<&'static Platform> {
        match self {
            Vocabulary::Reference => None,
            Vocabulary::Profile(platform) => Some(platform),
        }
    }

    /// Which machine this vocabulary speaks for (logs, reports, tests).
    pub fn label(&self) -> &'static str {
        match self {
            Vocabulary::Reference => PlatformKind::Quadruped.key(),
            Vocabulary::Profile(platform) => platform.kind().key(),
        }
    }
}
