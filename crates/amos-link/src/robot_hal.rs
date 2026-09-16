//! The robot HAL: the agent's intent → a quadruped's motor frames.
//!
//! This is the "small brain" boundary. The language model (or the field server) speaks
//! JSON — it must not know hex, CRC or joint limits. This module owns that translation,
//! and it is deliberately **pure**: parsing, validation, gait expansion and frame
//! encoding are all plain functions, so the whole intent→bytes path is unit-tested
//! without a robot (the [`MockRobotHal`] sink is where a test collects the frames a real
//! UART/CAN driver would send).
//!
//! ```text
//!   {"action":"trot","speed":0.6,"duration_ms":800}      ← agent JSON (LLM output)
//!            │ parse_command
//!            ▼
//!   RobotCommand { gait: Trot, speed, targets: [] }      ← validated intent
//!            │ plan
//!            ▼
//!   aa55 03 01 e8030000 crc16 …                          ← one hex frame per joint
//!            │ RobotHal::apply
//!            ▼
//!   the servo bus (Mock today, a UART/CAN driver later)
//! ```
//!
//! Frame layout (10 bytes, little-endian, CRC16-CCITT over the first 8):
//!
//! ```text
//!   0xAA 0x55 │ id u8 │ op u8 │ arg i32 │ crc16 u16
//! ```
//!
//! Joint indices follow the quadruped convention `leg * 3 + (hip, thigh, knee)`; the
//! position argument is in **milli-degrees**, so a frame never carries a float and two
//! nodes can never disagree about rounding.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::path::Path;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncWrite, AsyncWriteExt};

use crate::error::{LinkError, Result};
use crate::keyexpr::{Channel, Topic};
use crate::platform::{IntentClass, Vocabulary};
use crate::pubsub::Publisher;

/// Frame start bytes (`0xAA55`).
///
/// ```
/// use amos_link::robot_hal::FRAME_SOF;
///
/// assert_eq!(FRAME_SOF, [0xAA, 0x55]);
/// // The SOF is the first two bytes of every wire frame — callers can check
/// // a frame claims this bus without decoding the rest:
/// let frame = amos_link::robot_hal::MotorFrame::new(
///     amos_link::robot_hal::JointId::new(0).unwrap(),
///     amos_link::robot_hal::MotorOp::Enable,
///     0,
/// );
/// assert_eq!(&frame.encode()[..2], &FRAME_SOF);
/// ```
pub const FRAME_SOF: [u8; 2] = [0xAA, 0x55];
/// Bytes of one encoded motor frame: SOF + id + op + arg(i32) + crc16.
///
/// ```
/// use amos_link::robot_hal::FRAME_LEN;
///
/// // The frame is always 10 bytes: 2 SOF + 1 id + 1 op + 4 arg + 2 crc.
/// assert_eq!(FRAME_LEN, 10);
/// ```
pub const FRAME_LEN: usize = 2 + 1 + 1 + 4 + 2;
/// Joints of the reference quadruped: 4 legs x (hip, thigh, knee).
///
/// ```
/// use amos_link::robot_hal::{JOINTS, MAX_JOINT};
///
/// assert_eq!(JOINTS, 12, "four legs × three joints");
/// // MAX_JOINT is the last valid index (0-indexed):
/// assert_eq!(MAX_JOINT as usize, JOINTS - 1);
/// ```
pub const JOINTS: usize = 12;
/// Largest accepted joint index.
pub const MAX_JOINT: u8 = (JOINTS - 1) as u8;

/// The pose table and the joint range must agree: [`Gait::pose`] returns a row of exactly
/// [`JOINTS`] values and `plan` turns its index into a joint, so a mismatch would mean a
/// joint that can never be commanded — or an index past [`MAX_JOINT`]. Checked by the
/// **compiler**, so no reviewer has to remember it.
const _: () = assert!(JOINTS == MAX_JOINT as usize + 1);
/// Travel limit of any joint, in milli-degrees (±90°).
///
/// ```
/// use amos_link::robot_hal::{JointId, JointTarget, MAX_JOINT_MILLI_DEG};
///
/// let j = JointId::new(0).unwrap();
/// // The limit is ± the constant:
/// assert!(JointTarget::new(j, MAX_JOINT_MILLI_DEG).is_ok());
/// assert!(JointTarget::new(j, -MAX_JOINT_MILLI_DEG).is_ok());
/// // Just past it is refused:
/// assert!(JointTarget::new(j, MAX_JOINT_MILLI_DEG + 1).is_err());
/// ```
pub const MAX_JOINT_MILLI_DEG: i32 = 90_000;
/// Largest torque limit a frame may carry, in milli-percent of rated torque (100%).
///
/// ```
/// use amos_link::robot_hal::{JointId, MAX_TORQUE_MILLI_PERCENT};
/// use amos_link::robot_hal::MotorFrame;
/// use amos_link::robot_hal::MotorOp;
///
/// let j = JointId::new(0).unwrap();
/// // The limit is 0..=MAX_TORQUE_MILLI_PERCENT (non-negative by design):
/// assert!(MotorFrame::new(j, MotorOp::SetTorque, MAX_TORQUE_MILLI_PERCENT)
///     .validate()
///     .is_ok());
/// // Below 0 is refused:
/// assert!(MotorFrame::new(j, MotorOp::SetTorque, -1).validate().is_err());
/// // Above the limit is refused:
/// assert!(MotorFrame::new(j, MotorOp::SetTorque, MAX_TORQUE_MILLI_PERCENT + 1)
///     .validate()
///     .is_err());
/// ```
pub const MAX_TORQUE_MILLI_PERCENT: i32 = 100_000;

/// A joint under closed-loop position control.
///
/// The index is **private** on purpose: a `JointId` that exists outside this module is
/// one that was validated (0..=[`MAX_JOINT`]) — including when it arrives over the wire,
/// because `Deserialize` goes through [`JointId::new`] — so no caller can smuggle an
/// out-of-range joint into a [`MotorFrame`] and past the HAL's safety layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub struct JointId(u8);

impl JointId {
    /// Validate a joint index (0..=[`MAX_JOINT`]).
    ///
    /// ```
    /// use amos_link::robot_hal::{JointId, MAX_JOINT};
    ///
    /// assert_eq!(JointId::new(0).unwrap().index(), 0);
    /// // The highest legal index (4 legs × 3 joints - 1):
    /// assert_eq!(JointId::new(MAX_JOINT).unwrap().index(), MAX_JOINT);
    /// // One past it is refused, with a message that names the bad index:
    /// assert!(JointId::new(MAX_JOINT + 1).is_err());
    /// ```
    pub fn new(index: u8) -> Result<Self> {
        if index > MAX_JOINT {
            return Err(LinkError::Robot(format!(
                "joint {index} is out of range (0..={MAX_JOINT})"
            )));
        }
        Ok(JointId(index))
    }

    /// The joint index (0..=[`MAX_JOINT`] by construction).
    pub const fn index(self) -> u8 {
        self.0
    }

    /// The leg this joint belongs to.
    ///
    /// ```
    /// use amos_link::robot_hal::JointId;
    ///
    /// // Joint 0 is the front-left hip (leg 0, part 0); joint 11 is the rear-right knee.
    /// assert_eq!(JointId::new(0).unwrap().leg(), 0);
    /// assert_eq!(JointId::new(2).unwrap().leg(), 0); // knee of the same leg
    /// assert_eq!(JointId::new(3).unwrap().leg(), 1); // first joint of the next leg
    /// assert_eq!(JointId::new(11).unwrap().leg(), 3);
    /// ```
    pub fn leg(self) -> u8 {
        self.0 / 3
    }

    /// The joint within its leg: 0 = hip, 1 = thigh, 2 = knee.
    ///
    /// ```
    /// use amos_link::robot_hal::JointId;
    ///
    /// let hip = JointId::new(0).unwrap();
    /// let thigh = JointId::new(1).unwrap();
    /// let knee = JointId::new(2).unwrap();
    /// assert_eq!((hip.part(), thigh.part(), knee.part()), (0, 1, 2));
    /// // Repeats every leg:
    /// assert_eq!(JointId::new(9).unwrap().part(), 0); // rear-left hip
    /// ```
    pub fn part(self) -> u8 {
        self.0 % 3
    }
}

impl TryFrom<u8> for JointId {
    type Error = LinkError;

    /// The wire form is validated too: a frame claiming joint 200 is *refused*, counted
    /// as a decode error by the subscriber and skipped — not accepted as joint 200.
    fn try_from(index: u8) -> Result<Self> {
        JointId::new(index)
    }
}

impl From<JointId> for u8 {
    fn from(joint: JointId) -> Self {
        joint.0
    }
}

/// A gait the framework knows how to expand into a pose.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Gait {
    /// Four feet planted (the safe default; `{"action":"stand"}`).
    Stand,
    /// The diagonal trot every quadruped starts with.
    Trot,
    /// A slower crawl gait (one foot in the air at a time).
    Walk,
    /// Haunches down.
    Sit,
    /// Energize the drivers **without moving** — the only way to clear a latched
    /// e-stop (see [`RobotBridge`]). Deliberately a *gait* rather than a flag inside a
    /// motion command: an agent that has just been e-stopped must make it obvious that
    /// it is asking to arm again.
    Arm,
    /// Emergency stop — the only command that never needs a gait pose.
    Estop,
}

impl Gait {
    /// Every gait, in documentation order.
    ///
    /// ```
    /// use amos_link::robot_hal::Gait;
    ///
    /// // The order is the order the docs walk through the cases:
    /// assert_eq!(
    ///     Gait::ALL,
    ///     [Gait::Stand, Gait::Trot, Gait::Walk, Gait::Sit, Gait::Arm, Gait::Estop]
    /// );
    /// ```
    pub const ALL: [Gait; 6] = [
        Gait::Stand,
        Gait::Trot,
        Gait::Walk,
        Gait::Sit,
        Gait::Arm,
        Gait::Estop,
    ];

    /// Stable JSON/CLI key.
    ///
    /// ```
    /// use amos_link::robot_hal::Gait;
    ///
    /// for gait in Gait::ALL {
    ///     // Every key round-trips through `from_key` (case-insensitive, trimmed):
    ///     assert_eq!(Gait::from_key(&gait.key().to_uppercase()), Some(gait));
    ///     assert_eq!(Gait::from_key(&format!("  {}  ", gait.key())), Some(gait));
    /// }
    /// ```
    pub fn key(self) -> &'static str {
        match self {
            Gait::Stand => "stand",
            Gait::Trot => "trot",
            Gait::Walk => "walk",
            Gait::Sit => "sit",
            Gait::Arm => "arm",
            Gait::Estop => "estop",
        }
    }

    /// Parse a gait key (case-insensitive; `e-stop`/`stop` mean `estop`).
    ///
    /// ```
    /// use amos_link::robot_hal::Gait;
    ///
    /// // The aliases a CLI accepts so a hurried operator is not refused:
    /// assert_eq!(Gait::from_key("enable"), Some(Gait::Arm));
    /// assert_eq!(Gait::from_key("re-arm"), Some(Gait::Arm));
    /// assert_eq!(Gait::from_key("e-stop"), Some(Gait::Estop));
    /// assert_eq!(Gait::from_key("STOP"), Some(Gait::Estop));
    ///
    /// // Anything unknown is None — not a guessed default:
    /// assert_eq!(Gait::from_key("backflip"), None);
    /// assert_eq!(Gait::from_key(""), None);
    /// ```
    pub fn from_key(s: &str) -> Option<Gait> {
        match s.trim().to_ascii_lowercase().as_str() {
            "stand" => Some(Gait::Stand),
            "trot" => Some(Gait::Trot),
            "walk" => Some(Gait::Walk),
            "sit" => Some(Gait::Sit),
            "arm" | "enable" | "rearm" | "re-arm" => Some(Gait::Arm),
            "estop" | "e-stop" | "stop" => Some(Gait::Estop),
            _ => None,
        }
    }

    /// True for the halt command (which skips speed/duration validation).
    ///
    /// ```
    /// use amos_link::robot_hal::Gait;
    ///
    /// assert!(Gait::Estop.is_emergency());
    /// for gait in Gait::ALL {
    ///     if gait != Gait::Estop {
    ///         assert!(!gait.is_emergency(), "{:?} is not an emergency", gait);
    ///     }
    /// }
    /// ```
    pub fn is_emergency(self) -> bool {
        matches!(self, Gait::Estop)
    }

    /// True for the arm command (energize only; clears a latched e-stop).
    ///
    /// ```
    /// use amos_link::robot_hal::Gait;
    ///
    /// assert!(Gait::Arm.is_arm());
    /// // Arm and Estop are *separate* predicates — an e-stop is not an arm:
    /// assert!(!Gait::Estop.is_arm());
    /// ```
    pub fn is_arm(self) -> bool {
        matches!(self, Gait::Arm)
    }

    /// True when the gait moves the robot (so a latched e-stop must refuse it).
    ///
    /// ```
    /// use amos_link::robot_hal::Gait;
    ///
    /// // The four motion gaits; Arm and Estop do not move:
    /// for motion in [Gait::Stand, Gait::Trot, Gait::Walk, Gait::Sit] {
    ///     assert!(motion.is_motion());
    /// }
    /// assert!(!Gait::Arm.is_motion());
    /// assert!(!Gait::Estop.is_motion());
    /// ```
    pub fn is_motion(self) -> bool {
        matches!(self, Gait::Stand | Gait::Trot | Gait::Walk | Gait::Sit)
    }

    /// The pose this gait drives, in milli-degrees per joint (hip, thigh, knee per leg).
    ///
    /// A single table, not a gait *generator*: the frames a robot needs at 100 Hz are
    /// the ones a real gait controller emits, and pretending this module plans
    /// trajectories would be a lie. What it does is translate and validate intent.
    ///
    /// ```
    /// use amos_link::robot_hal::{Gait, JOINTS};
    ///
    /// // The hip column stays at 0 md in every pose — stability first.
    /// for gait in [Gait::Stand, Gait::Trot, Gait::Walk, Gait::Sit] {
    ///     let pose = gait.pose(0.5);
    ///     assert_eq!(pose.len(), JOINTS);
    ///     assert!(pose.iter().step_by(3).all(|m| *m == 0), "hip column for {gait:?}");
    /// }
    ///
    /// // Arm and Estop are deliberately a zero pose — `plan` carries the meaning,
    //  // the pose does not.
    /// assert_eq!(Gait::Arm.pose(0.7), [0_i32; JOINTS]);
    /// assert_eq!(Gait::Estop.pose(0.0), [0_i32; JOINTS]);
    ///
    /// // A non-finite speed is treated as 0, not propagated through `clamp`:
    /// // `clamp(NaN, 0, 1)` returns NaN, and `NaN as i32` is 0 — so an unvalidated
    /// // agent must not be able to pick a straighter pose than any legal speed.
    /// assert_eq!(Gait::Trot.pose(f32::NAN), Gait::Trot.pose(0.0));
    /// ```
    pub fn pose(self, speed: f32) -> [i32; JOINTS] {
        // Speed scales the thigh/knee extension, never the hip (stability first): the
        // hip column stays at 0 md in every pose. A **non-finite** speed is treated as 0
        // (the slowest pose) rather than passed to `clamp`: `f32::clamp` propagates NaN,
        // and `NaN as i32` is 0, which would silently produce a *straighter* stance than
        // any legal speed — an unvalidated float must not pick a pose.
        let s = if speed.is_finite() {
            speed.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let extend = |base: i32| -> i32 { -((base as f32) * (0.5 + 0.5 * s)) as i32 };
        match self {
            Gait::Stand => [
                0,
                extend(35_000),
                extend(60_000), // FL
                0,
                extend(35_000),
                extend(60_000), // FR
                0,
                extend(35_000),
                extend(60_000), // RL
                0,
                extend(35_000),
                extend(60_000), // RR
            ],
            Gait::Trot => [
                0,
                extend(20_000),
                extend(45_000), // FL
                0,
                extend(45_000),
                extend(80_000), // FR
                0,
                extend(45_000),
                extend(80_000), // RL
                0,
                extend(20_000),
                extend(45_000), // RR
            ],
            Gait::Walk => [
                0,
                extend(30_000),
                extend(55_000),
                0,
                extend(30_000),
                extend(55_000),
                0,
                extend(30_000),
                extend(55_000),
                0,
                extend(30_000),
                extend(55_000),
            ],
            Gait::Sit => [
                0,
                extend(70_000),
                extend(30_000),
                0,
                extend(70_000),
                extend(30_000),
                0,
                extend(20_000),
                extend(10_000),
                0,
                extend(20_000),
                extend(10_000),
            ],
            // Arming holds every joint where it is (a zero pose = "no commanded
            // motion"); what matters for `Arm` is the `Enable` frames `plan` emits.
            Gait::Arm | Gait::Estop => [0; JOINTS],
        }
    }
}

/// One joint's commanded position, in milli-degrees (integer: no float on the wire).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JointTarget {
    /// Which joint.
    pub joint: JointId,
    /// Target angle in milli-degrees (e.g. `-45000` = -45°).
    pub milli_deg: i32,
}

impl JointTarget {
    /// Validate the angle against the HAL's travel limit.
    ///
    /// The check is a **range comparison, not `abs()`**: this value comes straight from an
    /// agent's JSON, and `i32::MIN.abs()` would overflow — a debug-build panic, and in a
    /// release build a negative wrap that *passes* an `abs() > limit` test and lets an
    /// insane set point through. `-2147483648` must be refused like any other
    /// out-of-travel angle.
    ///
    /// ```
    /// use amos_link::robot_hal::{JointId, JointTarget, MAX_JOINT_MILLI_DEG};
    ///
    /// let j = JointId::new(0).unwrap();
    /// assert!(JointTarget::new(j, 0).is_ok());
    /// assert!(JointTarget::new(j, MAX_JOINT_MILLI_DEG).is_ok());
    /// assert!(JointTarget::new(j, -MAX_JOINT_MILLI_DEG).is_ok());
    ///
    /// // Just past the limit is refused…
    /// assert!(JointTarget::new(j, MAX_JOINT_MILLI_DEG + 1).is_err());
    /// assert!(JointTarget::new(j, -MAX_JOINT_MILLI_DEG - 1).is_err());
    ///
    /// // …and `i32::MIN` is refused too (the value that would overflow `abs()`):
    /// assert!(JointTarget::new(j, i32::MIN).is_err());
    /// ```
    pub fn new(joint: JointId, milli_deg: i32) -> Result<Self> {
        if !(-MAX_JOINT_MILLI_DEG..=MAX_JOINT_MILLI_DEG).contains(&milli_deg) {
            return Err(LinkError::Robot(format!(
                "joint {} target {milli_deg} md exceeds the +/-{MAX_JOINT_MILLI_DEG} md travel limit",
                joint.index()
            )));
        }
        Ok(Self { joint, milli_deg })
    }
}

/// A validated intent: which gait, how fast, for how long, and any joint overrides.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RobotCommand {
    /// The gait to run (or halt for).
    pub gait: Gait,
    /// Speed factor in `[0, 1]` (0 = no travel; ignored by `estop`).
    pub speed: f32,
    /// How long the command should hold, in milliseconds (0 = "until changed").
    pub duration_ms: u32,
    /// Optional explicit joint targets (milli-degrees) overriding the gait's pose.
    pub targets: Vec<JointTarget>,
}

/// Why a [`RobotBridge`] refused to move, or stopped moving.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EstopReason {
    /// The agent (or the field server) sent an explicit `{"action":"estop"}`.
    Commanded,
    /// No action arrived within the watchdog period: the link is presumed lost.
    Watchdog,
}

impl EstopReason {
    /// Stable wire/CLI key.
    pub fn key(self) -> &'static str {
        match self {
            EstopReason::Commanded => "commanded",
            EstopReason::Watchdog => "watchdog",
        }
    }

    /// Parse a stable key back (`"commanded"` / `"watchdog"`).
    ///
    /// Anything else — including the empty string a consumer uses for "no e-stop" — is
    /// `None`: an unknown reason is **not invented**, and the `estopped` flag travels
    /// separately, so a reason this build does not know cannot silently become "not cut".
    pub fn from_key(s: &str) -> Option<EstopReason> {
        match s.trim().to_ascii_lowercase().as_str() {
            "commanded" => Some(EstopReason::Commanded),
            "watchdog" => Some(EstopReason::Watchdog),
            _ => None,
        }
    }
}

/// What one [`RobotBridge::step`] did.
///
/// A refused *action* is not an I/O error: it is the safety layer working, and the
/// caller must be able to log it and keep looping. Only a transport failure (or a
/// broken bus) is an `Err`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BridgeEvent {
    /// The action was translated and written to the bus.
    Applied {
        /// The action that arrived (its link metadata included).
        seq: u64,
        /// The frames that reached the bus.
        frames: usize,
        /// True when the action armed the drivers (`{"action":"arm"}` or any gait).
        armed: bool,
    },
    /// Motion was refused because the bridge is e-stopped (latched until an `arm`).
    Refused {
        /// The action that arrived and was refused.
        seq: u64,
        /// The human-readable reason (also logged).
        reason: String,
    },
    /// Torque was cut: by the watchdog (link presumed lost) or by an explicit e-stop.
    Estopped {
        /// Which of the two happened.
        reason: EstopReason,
        /// Frames the bus accepted for the cut — **measured** through
        /// [`RobotHal::estop`], never assumed (a cut is one broadcast frame on some
        /// drivers and one frame per joint on others).
        frames: usize,
    },
}

/// The operations a motor frame can carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MotorOp {
    /// Set the target position (argument = milli-degrees).
    SetPosition,
    /// Set the torque limit (argument = milli-percent of rated torque).
    SetTorque,
    /// Energize the driver.
    Enable,
    /// De-energize the driver.
    Disable,
    /// Cut torque immediately (latched until an explicit `Enable`).
    Estop,
}

impl MotorOp {
    /// The wire opcode.
    ///
    /// ```
    /// use amos_link::robot_hal::{MotorFrame, MotorOp, JointId, FRAME_LEN};
    /// use amos_link::robot_hal::MotorOp::*;
    ///
    /// // Each opcode has a unique wire byte:
    /// assert_eq!(SetPosition.code(), 0x01);
    /// assert_eq!(SetTorque.code(),    0x02);
    /// assert_eq!(Enable.code(),       0x03);
    /// assert_eq!(Disable.code(),      0x04);
    /// assert_eq!(Estop.code(),        0x05);
    ///
    /// // And round-trips through `from_code` — an unknown byte is `None`:
    /// for op in [SetPosition, SetTorque, Enable, Disable, Estop] {
    ///     assert_eq!(MotorOp::from_code(op.code()), Some(op));
    ///     let frame = MotorFrame::new(JointId::new(0).unwrap(), op, 0);
    ///     assert_eq!(frame.encode().len(), FRAME_LEN);
    /// }
    /// assert_eq!(MotorOp::from_code(0x06), None);
    /// ```
    pub fn code(self) -> u8 {
        match self {
            MotorOp::SetPosition => 0x01,
            MotorOp::SetTorque => 0x02,
            MotorOp::Enable => 0x03,
            MotorOp::Disable => 0x04,
            MotorOp::Estop => 0x05,
        }
    }

    /// Decode an opcode (`None` for an unknown byte).
    pub fn from_code(code: u8) -> Option<MotorOp> {
        match code {
            0x01 => Some(MotorOp::SetPosition),
            0x02 => Some(MotorOp::SetTorque),
            0x03 => Some(MotorOp::Enable),
            0x04 => Some(MotorOp::Disable),
            0x05 => Some(MotorOp::Estop),
            _ => None,
        }
    }
}

/// One frame on the servo bus.
///
/// A frame is a *set point*, so it is validated wherever it can come from the outside:
/// the CRC16 bus decoder ([`MotorFrame::decode`]) and the `bincode` `Message` path
/// (a controller may publish `MotorFrame`s on the link) both refuse a frame that fails
/// [`MotorFrame::validate`]. Constructing one locally with [`MotorFrame::new`] is the
/// caller's own validated intent (`plan` builds them from a checked `RobotCommand`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "MotorFrameWire", into = "MotorFrameWire")]
pub struct MotorFrame {
    /// Destination joint.
    pub joint: JointId,
    /// What to do.
    pub op: MotorOp,
    /// Operation argument (milli-degrees for a position, milli-percent for torque).
    pub arg: i32,
}

/// The wire form of a [`MotorFrame`]: identical field order, types and encoding, so a
/// frame on the wire is unchanged — the only difference is that decoding runs
/// [`MotorFrame::validate`] before a `MotorFrame` can exist.
#[derive(Serialize, Deserialize)]
struct MotorFrameWire {
    joint: JointId,
    op: MotorOp,
    arg: i32,
}

impl TryFrom<MotorFrameWire> for MotorFrame {
    type Error = LinkError;

    fn try_from(wire: MotorFrameWire) -> Result<Self> {
        let frame = MotorFrame {
            joint: wire.joint,
            op: wire.op,
            arg: wire.arg,
        };
        frame.validate()?;
        Ok(frame)
    }
}

impl From<MotorFrame> for MotorFrameWire {
    /// Encoding never *creates* a frame, so it does not re-validate (that would make
    /// `encode` fallible for a value the caller already had to obtain legitimately).
    fn from(frame: MotorFrame) -> Self {
        Self {
            joint: frame.joint,
            op: frame.op,
            arg: frame.arg,
        }
    }
}

impl MotorFrame {
    /// Build a frame.
    ///
    /// Infallible on purpose: every in-tree producer (`plan`, the HAL's own e-stop/enable
    /// batches) derives the argument from a validated command or a constant. A frame that
    /// arrives from outside goes through [`MotorFrame::validate`] instead — see the type
    /// docs.
    pub fn new(joint: JointId, op: MotorOp, arg: i32) -> Self {
        Self { joint, op, arg }
    }

    /// Check the argument against the limits of its operation.
    ///
    /// The joint is already guaranteed by [`JointId`] (valid on both the constructor and
    /// the wire path); the argument is what a frame can still get wrong. The comparison
    /// is a range check rather than `abs()`, so `i32::MIN` — an overflow in a debug
    /// build, a wrap that would *pass* in a release build — is refused like any other
    /// out-of-range value.
    pub fn validate(&self) -> Result<()> {
        match self.op {
            MotorOp::SetPosition => {
                if !(-MAX_JOINT_MILLI_DEG..=MAX_JOINT_MILLI_DEG).contains(&self.arg) {
                    return Err(LinkError::Robot(format!(
                        "joint {} position {} md is outside the +/-{MAX_JOINT_MILLI_DEG} md \
                         travel limit",
                        self.joint.index(),
                        self.arg
                    )));
                }
                Ok(())
            }
            MotorOp::SetTorque => {
                if !(0..=MAX_TORQUE_MILLI_PERCENT).contains(&self.arg) {
                    return Err(LinkError::Robot(format!(
                        "joint {} torque {} is outside 0..={MAX_TORQUE_MILLI_PERCENT} \
                         milli-percent",
                        self.joint.index(),
                        self.arg
                    )));
                }
                Ok(())
            }
            // The remaining operations carry no set point (a driver reads no argument
            // from them), so there is nothing to bound.
            MotorOp::Enable | MotorOp::Disable | MotorOp::Estop => Ok(()),
        }
    }

    /// Encode to the 10-byte bus frame (CRC16-CCITT over the first 8 bytes).
    ///
    /// ```
    /// use amos_link::robot_hal::{JointId, MotorFrame, MotorOp, FRAME_LEN, FRAME_SOF};
    ///
    /// let frame = MotorFrame::new(
    ///     JointId::new(1).unwrap(),
    ///     MotorOp::SetPosition,
    ///     -45_000, // -45° in milli-degrees
    /// );
    /// let bytes = frame.encode();
    /// assert_eq!(bytes.len(), FRAME_LEN);
    /// assert_eq!(&bytes[..2], &FRAME_SOF);
    /// assert_eq!(bytes[2], 1);                 // joint
    /// assert_eq!(bytes[3], MotorOp::SetPosition.code());
    /// assert_eq!(&bytes[4..8], &(-45_000_i32).to_le_bytes()); // little-endian arg
    ///
    /// // CRC16-CCITT over the first 8 bytes — what every servo bus expects:
    /// let crc = u16::from_le_bytes([bytes[8], bytes[9]]);
    /// assert_eq!(crc, amos_link::robot_hal::crc16_ccitt(&bytes[..8]));
    /// ```
    pub fn encode(&self) -> [u8; FRAME_LEN] {
        let mut out = [0u8; FRAME_LEN];
        out[0] = FRAME_SOF[0];
        out[1] = FRAME_SOF[1];
        out[2] = self.joint.0;
        out[3] = self.op.code();
        out[4..8].copy_from_slice(&self.arg.to_le_bytes());
        let crc = crc16_ccitt(&out[..8]);
        out[8..10].copy_from_slice(&crc.to_le_bytes());
        out
    }

    /// The frame as lowercase hex (`aa550301e8030000b9e1`).
    ///
    /// ```
    /// use amos_link::robot_hal::{JointId, MotorFrame, MotorOp, FRAME_LEN};
    ///
    /// // One Enable frame for joint 0 — a frame's hex is `bytes[..] as hex`,
    /// // including the trailing two CRC bytes in the order the wire carries them:
    /// let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::Enable, 0);
    /// let bytes = frame.encode();
    /// let mut expected = String::with_capacity(FRAME_LEN * 2);
    /// for byte in bytes {
    ///     expected.push_str(&format!("{byte:02x}"));
    /// }
    /// assert_eq!(frame.encode_hex(), expected);
    /// ```
    pub fn encode_hex(&self) -> String {
        to_hex(&self.encode())
    }

    /// Decode a frame, refusing a bad SOF, an unknown opcode, a CRC mismatch, an
    /// out-of-range joint or an argument outside its operation's limits.
    ///
    /// The last two are the safety-relevant ones: a CRC-valid frame is still *untrusted*
    /// (only random corruption is caught by a checksum, not a wrong or malicious
    /// producer), and a joint index or set point that never could have been commanded
    /// must not reach a HAL that trusts its input.
    ///
    /// ```
    /// use amos_link::robot_hal::{JointId, MotorFrame, MotorOp, FRAME_SOF};
    ///
    /// // Round-trip: a frame is its own decoder.
    /// let original = MotorFrame::new(JointId::new(2).unwrap(), MotorOp::SetPosition, 30_000);
    /// let decoded = MotorFrame::decode(&original.encode()).expect("round-trip");
    /// assert_eq!(decoded, original);
    ///
    /// // A CRC flip is refused — the checksum is the *only* corruption check:
    /// let mut bytes = original.encode();
    /// bytes[4] ^= 1; // flip one bit of the argument
    /// assert!(MotorFrame::decode(&bytes).is_err());
    ///
    /// // Wrong SOF is refused without a CRC computation — no decoder should
    /// // spend its budget on a frame that was never on this bus.
    /// let mut bytes = original.encode();
    /// bytes[0] = 0; bytes[1] = 0;
    /// assert!(MotorFrame::decode(&bytes).is_err());
    ///
    /// // A CRC-valid frame with an out-of-range joint is *still* refused:
    /// // a checksum catches random corruption, not a wrong or malicious producer.
    /// let mut bytes = original.encode();
    /// bytes[2] = 200; // bad joint
    /// let crc = amos_link::robot_hal::crc16_ccitt(&bytes[..8]);
    /// bytes[8..10].copy_from_slice(&crc.to_le_bytes());
    /// assert!(MotorFrame::decode(&bytes).is_err());
    ///
    /// // …and an in-range joint with an out-of-range argument is refused too —
    /// // this is the safety-relevant path the docstring calls out.
    /// let mut bytes = original.encode();
    /// bytes[2] = 0;
    /// // arg = i32::MIN (the value that would slip past an `abs()` check):
    /// let bytes_arg = (i32::MIN).to_le_bytes();
    /// bytes[4..8].copy_from_slice(&bytes_arg);
    /// let crc = amos_link::robot_hal::crc16_ccitt(&bytes[..8]);
    /// bytes[8..10].copy_from_slice(&crc.to_le_bytes());
    /// assert!(MotorFrame::decode(&bytes).is_err());
    ///
    /// // SOF is the public constant — a frame can be checked for the bus it claims
    /// // to be on without decoding the rest:
    /// let bytes = original.encode();
    /// assert_eq!(&bytes[..2], &FRAME_SOF);
    /// ```
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != FRAME_LEN {
            return Err(LinkError::Frame(format!(
                "motor frame is {} bytes, expected {FRAME_LEN}",
                bytes.len()
            )));
        }
        if bytes[..2] != FRAME_SOF {
            return Err(LinkError::Frame("bad motor frame SOF".to_string()));
        }
        let expect = u16::from_le_bytes([bytes[8], bytes[9]]);
        let actual = crc16_ccitt(&bytes[..8]);
        if expect != actual {
            return Err(LinkError::Frame(format!(
                "motor frame crc mismatch ({expect:#06x} != {actual:#06x})"
            )));
        }
        let op = MotorOp::from_code(bytes[3])
            .ok_or_else(|| LinkError::Frame(format!("unknown motor opcode {:#04x}", bytes[3])))?;
        let arg = i32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        let frame = Self {
            joint: JointId::new(bytes[2])?,
            op,
            arg,
        };
        frame.validate()?;
        Ok(frame)
    }
}

/// CRC16-CCITT (poly `0x1021`, init `0xFFFF`) — the checksum every servo bus accepts.
pub fn crc16_ccitt(bytes: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for byte in bytes {
        crc ^= u16::from(*byte) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// Lowercase hex, no separators (avoids a dependency for ten bytes).
fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        s.push(char::from_digit(u32::from(b & 0x0f), 16).unwrap_or('0'));
    }
    s
}

/// The JSON an agent (or a UI) sends — the shape [`parse_command`] accepts.
///
/// Unknown fields are ignored (`serde` default), so a future agent can add hints
/// without breaking an older board; a *missing* gait is refused, because guessing a
/// gait for a robot is exactly the kind of silent default that hurts.
#[derive(Clone, Debug, Deserialize)]
struct RawCommand {
    /// The gait/action key.
    action: String,
    /// Optional speed factor in `[0, 1]` (default 0.5).
    #[serde(default)]
    speed: Option<f32>,
    /// Optional hold time in ms (default 0 = until changed).
    #[serde(default)]
    duration_ms: Option<u32>,
    /// Optional explicit joint targets: `[{"joint":2,"milli_deg":-30000}, …]`.
    #[serde(default)]
    targets: Vec<RawTarget>,
}

/// One explicit joint target inside [`RawCommand`].
#[derive(Clone, Debug, Deserialize)]
struct RawTarget {
    /// Joint index.
    joint: u8,
    /// Either an absolute milli-degree angle…
    #[serde(default)]
    milli_deg: Option<i32>,
    /// …or a float degree angle (converted, for agent convenience).
    #[serde(default)]
    deg: Option<f32>,
}

/// Parse an agent's JSON action into a validated [`RobotCommand`].
///
/// Refusals are explicit and named (so the agent gets a message it can act on): an
/// unknown action, a speed outside `[0, 1]`, a joint out of range, an angle beyond the
/// travel limit, or a target without an angle.
///
/// ```
/// use amos_link::robot_hal::{Gait, parse_command};
///
/// // A happy path — the JSON the agent emits on every gait:
/// let cmd = parse_command(r#"{"action":"trot","speed":0.6,"duration_ms":800}"#).unwrap();
/// assert_eq!(cmd.gait, Gait::Trot);
/// assert!((cmd.speed - 0.6).abs() < f32::EPSILON);
/// assert_eq!(cmd.duration_ms, 800);
///
/// // `speed` defaults to 0.5 when the agent omits it (the doc claim):
/// let cmd = parse_command(r#"{"action":"walk"}"#).unwrap();
/// assert_eq!(cmd.gait, Gait::Walk);
/// assert!((cmd.speed - 0.5).abs() < f32::EPSILON);
///
/// // Unknown actions are named in the refusal — the agent gets a message it can branch on:
/// let err = parse_command(r#"{"action":"backflip"}"#).unwrap_err();
/// assert!(format!("{err}").contains("backflip"), "the refusal names the bad action");
///
/// // Speed outside `[0, 1]` is refused, not silently clamped:
/// assert!(parse_command(r#"{"action":"trot","speed":1.5}"#).is_err());
/// assert!(parse_command(r#"{"action":"trot","speed":-0.1}"#).is_err());
///
/// // An out-of-range joint, an over-travel angle, or a target with no angle are refused:
/// assert!(parse_command(r#"{"action":"trot","targets":[{"joint":200,"milli_deg":0}]}"#).is_err());
/// assert!(parse_command(r#"{"action":"trot","targets":[{"joint":0,"milli_deg":999999}]}"#).is_err());
/// assert!(parse_command(r#"{"action":"trot","targets":[{"joint":0}]}"#).is_err());
///
/// // `e-stop` accepts a wildly out-of-range speed — the halt path must never be refused
/// // for a cosmetic reason (a speed typo must not block an e-stop):
/// let cmd = parse_command(r#"{"action":"e-stop","speed":99.0}"#).unwrap();
/// assert_eq!(cmd.gait, Gait::Estop);
/// assert!(cmd.targets.is_empty());
///
/// // Arming ignores speed and targets — a hidden motion command after an e-stop
/// // must not be smuggled in via the arm path:
/// let cmd = parse_command(
///     r#"{"action":"arm","speed":0.9,"targets":[{"joint":0,"milli_deg":-45000}]}"#,
/// ).unwrap();
/// assert_eq!(cmd.gait, Gait::Arm);
/// assert_eq!(cmd.speed, 0.0);
/// assert!(cmd.targets.is_empty());
/// ```
pub fn parse_command(json: &str) -> Result<RobotCommand> {
    let raw: RawCommand = serde_json::from_str(json)
        .map_err(|e| LinkError::Robot(format!("action is not valid JSON: {e}")))?;
    let gait = Gait::from_key(&raw.action)
        .ok_or_else(|| LinkError::Robot(format!("unknown action `{}`", raw.action)))?;
    if gait.is_emergency() {
        // The halt path must never be refused for a cosmetic reason (a speed typo must
        // not block an e-stop); targets are irrelevant to a torque cut.
        return Ok(RobotCommand {
            gait,
            speed: 0.0,
            duration_ms: raw.duration_ms.unwrap_or(0),
            targets: Vec::new(),
        });
    }
    if gait.is_arm() {
        // Arming is an energize, not a motion: a speed makes no sense and a joint target
        // would be a hidden motion command after an e-stop, so both are ignored.
        return Ok(RobotCommand {
            gait,
            speed: 0.0,
            duration_ms: raw.duration_ms.unwrap_or(0),
            targets: Vec::new(),
        });
    }
    let speed = raw.speed.unwrap_or(0.5);
    if !(0.0..=1.0).contains(&speed) {
        return Err(LinkError::Robot(format!("speed {speed} is outside [0, 1]")));
    }
    let mut targets = Vec::with_capacity(raw.targets.len());
    for t in raw.targets {
        let joint = JointId::new(t.joint)?;
        let milli_deg = match (t.milli_deg, t.deg) {
            (Some(md), _) => md,
            (None, Some(deg)) => (deg * 1000.0).round() as i32,
            (None, None) => {
                return Err(LinkError::Robot(format!(
                    "target for joint {} has neither `milli_deg` nor `deg`",
                    t.joint
                )))
            }
        };
        targets.push(JointTarget::new(joint, milli_deg)?);
    }
    Ok(RobotCommand {
        gait,
        speed,
        duration_ms: raw.duration_ms.unwrap_or(0),
        targets,
    })
}

/// The servo bus: where [`MotorFrame`]s are actually written.
#[async_trait]
pub trait RobotHal: Send + Sync + 'static {
    /// Send frames to the bus; returns how many were accepted.
    ///
    /// An implementation is the **last place** a bad set point can be stopped, so it must
    /// refuse a frame that fails [`MotorFrame::validate`] instead of trusting its caller —
    /// a driver that trusts its input is not a safety layer.
    async fn apply(&self, frames: &[MotorFrame]) -> Result<usize>;

    /// Cut torque on every joint (overrides anything queued).
    ///
    /// Returns **how many frames the bus accepted** for the cut, the same way
    /// [`RobotHal::apply`] does. It is a return value rather than an assumption because a
    /// torque cut has no single wire shape: a driver may write one per-joint frame per
    /// joint, one broadcast frame, or a hardware line. A caller that *reports* the count
    /// (the bridge's actuation report does) must be able to measure it — an assumed
    /// "one frame per joint" would be an invented number for every other HAL.
    async fn estop(&self) -> Result<usize>;

    /// True while the drivers are energized.
    fn armed(&self) -> bool;

    /// Which implementation this is (`"mock"`, `"uart"`, …).
    fn name(&self) -> &'static str;
}

/// Expand a command into the frames a bus driver sends.
///
/// `Estop` short-circuits to a torque cut on every joint — the one path that must not
/// depend on pose planning. `Arm` energizes every joint **and commands no motion** (the
/// zero pose), which is what makes "re-arm after an e-stop" a deliberate act rather than
/// a side effect. Every other gait emits `Enable` (idempotent on real drivers) followed
/// by one position frame per joint, with explicit targets overriding the gait pose.
///
/// ```
/// use amos_link::robot_hal::{plan, Gait, JOINTS, JointId, JointTarget, MAX_JOINT, MotorOp, parse_command};
///
/// // `Estop`: one torque-cut frame per joint — no pose, no enable, nothing else.
/// let frames = plan(
///     &parse_command(r#"{"action":"estop"}"#).unwrap(),
/// );
/// assert_eq!(frames.len(), (MAX_JOINT as usize) + 1);
/// assert!(frames.iter().all(|f| f.op == MotorOp::Estop));
///
/// // `Arm`: one Enable per joint, no position frame — the drivers come up holding pose.
/// let frames = plan(
///     &parse_command(r#"{"action":"arm"}"#).unwrap(),
/// );
/// assert_eq!(frames.len(), (MAX_JOINT as usize) + 1);
/// assert!(frames.iter().all(|f| f.op == MotorOp::Enable));
///
/// // A motion gait: one Enable (broadcast — joint 0 is the leading marker), then
/// // one position frame per joint. 13 frames for the reference quadruped:
/// let frames = plan(
///     &parse_command(r#"{"action":"trot","speed":0.5,"duration_ms":800}"#).unwrap(),
/// );
/// assert_eq!(frames.len(), JOINTS + 1);
/// assert_eq!(frames[0].op, MotorOp::Enable);
/// assert!(frames[1..].iter().all(|f| f.op == MotorOp::SetPosition));
///
/// // Explicit joint targets override the gait's pose for the joints they name.
/// let cmd = parse_command(
///     r#"{"action":"stand","targets":[{"joint":3,"milli_deg":-1000}]}"#,
/// ).unwrap();
/// let frames = plan(&cmd);
/// let j3 = frames.iter().find(|f| f.joint == JointId::new(3).unwrap()).unwrap();
/// assert_eq!(j3.arg, -1000);
/// ```
pub fn plan(command: &RobotCommand) -> Vec<MotorFrame> {
    if command.gait.is_emergency() {
        return (0..=MAX_JOINT)
            .map(|j| MotorFrame::new(JointId(j), MotorOp::Estop, 0))
            .collect();
    }
    if command.gait.is_arm() {
        // Enable per joint, no position frame: the drivers come up holding position.
        return (0..=MAX_JOINT)
            .map(|j| MotorFrame::new(JointId(j), MotorOp::Enable, 0))
            .collect();
    }
    let pose = command.gait.pose(command.speed);
    let mut frames = Vec::with_capacity(JOINTS + 1);
    frames.push(MotorFrame::new(JointId(0), MotorOp::Enable, 0));
    for (index, milli_deg) in pose.iter().enumerate() {
        let joint = JointId(index as u8);
        let arg = command
            .targets
            .iter()
            .find(|t| t.joint == joint)
            .map(|t| t.milli_deg)
            .unwrap_or(*milli_deg);
        frames.push(MotorFrame::new(joint, MotorOp::SetPosition, arg));
    }
    frames
}

/// The drivers' energized state **after** a batch, derived from the ops in wire order.
///
/// An `any()` over the batch — which is what both HALs used to do — answers the wrong
/// question: a batch that ends with `Enable` leaves a real driver armed, and a batch that
/// ends with `Estop`/`Disable` leaves it dead, *whatever else is in it*. Order-blindness
/// silently inverted the state of a mixed batch, and the number it produced was then
/// reported to the commander as a measurement ([`ActuationState::armed`]). The fold makes
/// the last arming-relevant op the one that decides, which is what a bus does.
///
/// Position/torque frames carry no arming meaning and leave the state alone.
fn armed_after(armed: bool, frames: &[MotorFrame]) -> bool {
    frames.iter().fold(armed, |state, frame| match frame.op {
        MotorOp::Enable => true,
        MotorOp::Disable | MotorOp::Estop => false,
        MotorOp::SetPosition | MotorOp::SetTorque => state,
    })
}

/// The per-joint torque cut a HAL sends when torque must be gone **now**.
///
/// One `Estop` frame per joint, in a fixed-size array: this is part of the safety path, so
/// its shape is decided at compile time (NASA Power of 10 #2 — no resource that can grow at
/// runtime, no "sometimes" batch). It is *our* bus shape, not a law of robotics: a driver
/// whose bus cuts torque with a single broadcast frame reports `1` from
/// [`RobotHal::estop`], which is exactly why that method returns a measured count.
fn full_torque_cut() -> [MotorFrame; JOINTS] {
    std::array::from_fn(|index| MotorFrame::new(JointId(index as u8), MotorOp::Estop, 0))
}

/// A HAL that records what a real bus would have sent.
#[derive(Debug)]
pub struct MockRobotHal {
    frames: Mutex<Vec<MotorFrame>>,
    armed: AtomicBool,
    applied: AtomicU64,
}

impl MockRobotHal {
    /// A mock with de-energized drivers.
    ///
    /// ```
    /// use amos_link::robot_hal::{MockRobotHal, RobotHal};
    ///
    /// let hal = MockRobotHal::new();
    /// assert_eq!(hal.applied(), 0, "nothing has been sent yet");
    /// assert!(!hal.armed(), "a fresh mock has de-energized drivers");
    /// assert_eq!(hal.name(), "mock");
    /// assert!(hal.frames().is_empty());
    /// ```
    pub fn new() -> Self {
        Self {
            frames: Mutex::new(Vec::new()),
            armed: AtomicBool::new(false),
            applied: AtomicU64::new(0),
        }
    }

    /// Every frame this HAL has been asked to send, in order.
    ///
    /// ```
    /// # async fn demo() {
    /// use amos_link::robot_hal::{AgentAction, MockRobotHal, RobotHal, execute};
    ///
    /// let hal = MockRobotHal::new();
    /// execute(&hal, &AgentAction::new(r#"{"action":"arm"}"#)).await.unwrap();
    /// execute(&hal, &AgentAction::new(r#"{"action":"stand","speed":0.5}"#)).await.unwrap();
    ///
    /// // The frames arrive in the order the HAL received them — what a bus log shows:
    /// assert_eq!(hal.frames().len(), hal.applied() as usize);
    /// # }
    /// ```
    pub fn frames(&self) -> Vec<MotorFrame> {
        self.frames.lock().map(|f| f.clone()).unwrap_or_default()
    }

    /// How many frames were accepted.
    ///
    /// ```
    /// use amos_link::robot_hal::{AgentAction, MockRobotHal, RobotHal, execute};
    ///
    /// # async fn demo() {
    /// let hal = MockRobotHal::new();
    /// // Two commands, one is the 13-frame arm/stand on the reference quadruped:
    /// execute(&hal, &AgentAction::new(r#"{"action":"arm"}"#)).await.unwrap();
    /// execute(&hal, &AgentAction::new(r#"{"action":"trot"}"#)).await.unwrap();
    /// // The arm + trot counts are pinned by `plan` — `applied()` is just the sum:
    /// assert!(hal.applied() > 13);
    /// # }
    /// ```
    pub fn applied(&self) -> u64 {
        self.applied.load(Ordering::Relaxed)
    }

    /// Forget the recorded frames (keeping the counters).
    ///
    /// ```
    /// use amos_link::robot_hal::{MockRobotHal, RobotHal};
    ///
    /// let hal = MockRobotHal::new();
    /// // …a test injects frames…
    /// hal.clear();
    /// assert!(hal.frames().is_empty(), "the recorded log is gone");
    /// assert_eq!(hal.applied(), 0, "the counter is independent of the log");
    /// ```
    pub fn clear(&self) {
        if let Ok(mut f) = self.frames.lock() {
            f.clear();
        }
    }

    /// The recorded frames as hex, one line per frame (what a bus log looks like).
    ///
    /// ```
    /// use amos_link::robot_hal::{AgentAction, MockRobotHal, RobotHal, FRAME_LEN, execute};
    ///
    /// # async fn demo() {
    /// let hal = MockRobotHal::new();
    /// execute(&hal, &AgentAction::new(r#"{"action":"estop"}"#)).await.unwrap();
    ///
    /// let log = hal.hex_log();
    /// // One line per frame, two lowercase hex chars per byte of the 10-byte frame:
    /// for line in &log {
    ///     assert_eq!(line.len(), FRAME_LEN * 2);
    ///     assert!(line.chars().all(|c| c.is_ascii_hexdigit()));
    /// }
    /// assert_eq!(log.len(), hal.applied() as usize);
    /// # }
    /// ```
    pub fn hex_log(&self) -> Vec<String> {
        self.frames().iter().map(MotorFrame::encode_hex).collect()
    }
}

impl Default for MockRobotHal {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl RobotHal for MockRobotHal {
    async fn apply(&self, frames: &[MotorFrame]) -> Result<usize> {
        // Refuse the whole batch *before* writing anything: a partial write would leave
        // the joints in a mixed state, which is worse than refusing the command.
        for frame in frames {
            frame.validate()?;
        }
        let mut record = self
            .frames
            .lock()
            .map_err(|_| LinkError::Robot("mock HAL poisoned".to_string()))?;
        record.extend_from_slice(frames);
        drop(record);
        // Wire order decides (see `armed_after`): the last arming-relevant op in the batch
        // is the state the drivers are left in.
        let armed = armed_after(self.armed.load(Ordering::SeqCst), frames);
        self.armed.store(armed, Ordering::SeqCst);
        self.applied
            .fetch_add(frames.len() as u64, Ordering::Relaxed);
        Ok(frames.len())
    }

    async fn estop(&self) -> Result<usize> {
        // Measured, not assumed: `apply` returns what the bus accepted, so the bridge's
        // report carries a number this HAL actually wrote.
        self.apply(&full_torque_cut()).await
    }

    fn armed(&self) -> bool {
        self.armed.load(Ordering::SeqCst)
    }

    fn name(&self) -> &'static str {
        "mock"
    }
}

/// A HAL that writes the frames to a **real byte stream** — the shape a servo bus actually
/// has on a robot: a UART character device, a Unix socket a controller daemon listens on,
/// or a TCP bridge in front of a CAN adapter.
///
/// What it is *not*: a driver. Baud rate, parity, CAN bit timing and driver-enable lines are
/// the device's business — a deployment configures the port (`stty -F /dev/ttyUSB0 1M raw`
/// before start) and this HAL writes the bytes. What it *is*: the code path between
/// "validated frame" and "the wire", with the two properties a bus layer must have and a
/// mock cannot demonstrate:
///
/// 1. **Nothing is written before the whole batch validates.** A refused frame must not
///    leave the joints half-commanded — the same rule [`MockRobotHal`] documents, now on a
///    real descriptor (its test reads the socket and finds **zero** bytes).
/// 2. **The accepted count is the number really written.** It advances only after
///    `write_all` returned for that frame, so a driver failure mid-batch is reported with
///    the frames that did get out — never with a number taken from the plan.
///
/// [`RobotHal::armed`] is the running fold of the ops that were actually written
/// ([`armed_after`]), so it is a measurement of the wire, not of the caller's intent.
pub struct StreamRobotHal<W> {
    writer: tokio::sync::Mutex<W>,
    armed: AtomicBool,
    written: AtomicU64,
}

impl<W> StreamRobotHal<W>
where
    W: AsyncWrite + Unpin + Send,
{
    /// Wrap any async byte sink (a device file, a socket, a recording pipe in a test).
    pub fn new(writer: W) -> Self {
        Self {
            writer: tokio::sync::Mutex::new(writer),
            armed: AtomicBool::new(false),
            written: AtomicU64::new(0),
        }
    }

    /// Frames actually written to the bus since this HAL was created.
    pub fn frames_written(&self) -> u64 {
        self.written.load(Ordering::Relaxed)
    }

    /// Bytes actually written (`frames × FRAME_LEN`) — the odometer a bus log would show.
    pub fn bytes_written(&self) -> u64 {
        self.frames_written().saturating_mul(FRAME_LEN as u64)
    }
}

impl<W> std::fmt::Debug for StreamRobotHal<W> {
    /// The bus's *state*, never its contents: a writer may be a socket or a device file, and
    /// `Debug` is what a failing assertion prints. (Field reads, not the accessors: `Debug`
    /// must not require the writer to be an `AsyncWrite`.)
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamRobotHal")
            .field("armed", &self.armed.load(Ordering::SeqCst))
            .field("frames_written", &self.written.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

#[cfg(unix)]
impl StreamRobotHal<tokio::fs::File> {
    /// Open a **character device** (a serial/UART port, a PTY pair) read-write and write
    /// frames to it.
    ///
    /// The honest boundary, stated where it bites: this opens the path and writes bytes. It
    /// does **not** configure the port — termios (baud rate, `raw` mode, flow control) is
    /// the deployment's step, done before the node starts
    /// (`stty -F /dev/ttyUSB0 1M raw`), because a HAL that silently reconfigures a bus
    /// someone else may own is worse than one that writes exactly what it was given. A
    /// write to a port whose parameters are wrong still succeeds at this layer; the driver
    /// then sees garbage, which is why port setup is part of the bring-up runbook and not of
    /// this call.
    pub async fn open_device(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let file = tokio::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .await
            .map_err(|e| {
                LinkError::Transport(format!("opening the motor bus {}: {e}", path.display()))
            })?;
        Ok(Self::new(file))
    }
}

#[cfg(unix)]
impl StreamRobotHal<tokio::net::UnixStream> {
    /// Connect to a motor controller that listens on a **Unix socket** and write frames to
    /// it (the shape a board-local servo daemon has).
    ///
    /// A refused connection is an error the caller sees at startup, not a bus that silently
    /// accepts nothing: a robot whose motor daemon is down must never report `armed: true`.
    pub async fn connect_unix(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let stream = tokio::net::UnixStream::connect(path).await.map_err(|e| {
            LinkError::Transport(format!(
                "connecting to the motor bus {}: {e}",
                path.display()
            ))
        })?;
        Ok(Self::new(stream))
    }
}

#[async_trait]
impl<W> RobotHal for StreamRobotHal<W>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    async fn apply(&self, frames: &[MotorFrame]) -> Result<usize> {
        // The safety layer, before a single byte moves: a partial write leaves the joints
        // in a mixed state, which is worse than refusing the command.
        for frame in frames {
            frame.validate()?;
        }
        let mut writer = self.writer.lock().await;
        let mut armed = self.armed.load(Ordering::SeqCst);
        let mut accepted = 0usize;
        for frame in frames {
            let bytes = frame.encode();
            writer.write_all(&bytes).await.map_err(|e| {
                LinkError::Transport(format!(
                    "the motor bus refused frame {accepted}/{} (joint {}): {e}",
                    frames.len(),
                    frame.joint.index()
                ))
            })?;
            accepted += 1;
            // The flag follows the bytes that really reached the descriptor: a failure
            // reported below must not leave `armed()` describing frames that never left.
            armed = armed_after(armed, std::slice::from_ref(frame));
            self.armed.store(armed, Ordering::SeqCst);
            self.written.fetch_add(1, Ordering::Relaxed);
        }
        writer.flush().await.map_err(|e| {
            LinkError::Transport(format!(
                "flushing the motor bus after {accepted} frame(s): {e}"
            ))
        })?;
        Ok(accepted)
    }

    async fn estop(&self) -> Result<usize> {
        // Measured like `apply`: the report says how many frames the bus really took.
        self.apply(&full_torque_cut()).await
    }

    fn armed(&self) -> bool {
        self.armed.load(Ordering::SeqCst)
    }

    fn name(&self) -> &'static str {
        "stream"
    }
}

/// An agent action as it travels on the link: the model's JSON, verbatim.
///
/// Carried as a string on purpose — the brain must be able to introduce a new field
/// without recompiling the board, and *this* side still validates everything before a
/// motor moves ([`AgentAction::parse`] runs the same checks the CLI does).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentAction {
    /// The raw JSON the agent produced.
    pub json: String,
}

impl AgentAction {
    /// Wrap an agent's JSON action.
    pub fn new(json: impl Into<String>) -> Self {
        Self { json: json.into() }
    }

    /// Validate it into a [`RobotCommand`].
    pub fn parse(&self) -> Result<RobotCommand> {
        parse_command(&self.json)
    }
}

/// Translate one agent action and write it to the bus; returns the frames sent.
pub async fn execute<H: RobotHal>(hal: &H, action: &AgentAction) -> Result<Vec<MotorFrame>> {
    let frames = plan(&action.parse()?);
    let applied = hal.apply(&frames).await?;
    Ok(frames[..applied.min(frames.len())].to_vec())
}
/// The `state`-channel name a bridge reports actuation on.
pub const ACTUATION_NAME: &str = "actuation";

/// How long an **unchanged** mode is re-announced after (see [`RobotBridge::reporting`]).
///
/// Five seconds: slow enough that it is not traffic (one small frame per robot per 5 s,
/// beside a control stream that runs at 10–50 Hz), fast enough that a subscriber which
/// arrives *late* — a brain that just started, the daemon's control plane — learns what the
/// robot is doing without waiting for the next transition.
pub const DEFAULT_REPORT_REFRESH: Duration = Duration::from_secs(5);

/// The topic a bridge reports its actuation state on: `amos/<robot>/state/actuation`.
///
/// The channel is deliberately `state`, not `control`: this is a **discrete mode report**
/// (armed / e-stopped / which gait), so `Qos::for_channel(Channel::State)` gives it
/// latest-wins semantics — a brain that joins late learns the robot's real mode instead of
/// replaying a command history.
///
/// ```
/// use amos_link::discovery::PeerId;
/// use amos_link::keyexpr::Channel;
/// use amos_link::robot_hal::{ACTUATION_NAME, actuation_topic};
///
/// let topic = actuation_topic(&PeerId::new("patrol-01").unwrap()).unwrap();
/// assert_eq!(topic.as_str(), "amos/patrol-01/state/actuation");
/// assert_eq!(topic.channel(), Some(Channel::State));
/// // The trailing `actuation` is the `ACTUATION_NAME` constant — a single source of truth:
/// assert!(topic.as_str().ends_with(ACTUATION_NAME));
/// ```
pub fn actuation_topic(peer: &crate::discovery::PeerId) -> Result<Topic> {
    Topic::new(format!(
        "amos/{}/{}/{ACTUATION_NAME}",
        peer.as_str(),
        Channel::State.key()
    ))
}

/// The pattern that matches every robot's actuation report (`amos/*/state/actuation`).
///
/// This is what a consumer that is not a single robot's brain subscribes to: the daemon's
/// control plane (so the System UI can read the return path) and `amos-link-cli state`.
///
/// ```
/// use amos_link::keyexpr::Channel;
/// use amos_link::robot_hal::{ACTUATION_NAME, actuation_pattern};
///
/// let pattern = actuation_pattern().unwrap();
/// assert_eq!(pattern.as_str(), "amos/*/state/actuation");
/// assert_eq!(pattern.channel(), Some(Channel::State));
/// assert!(pattern.as_str().ends_with(ACTUATION_NAME));
/// ```
pub fn actuation_pattern() -> Result<Topic> {
    Topic::pattern(format!("amos/*/{}/{ACTUATION_NAME}", Channel::State.key()))
}

/// Longest refusal reason accepted from the wire, in bytes.
///
/// A reason is a sentence for a human (the System UI renders it in a list row, the CLI prints
/// it): our own are ~60 bytes. 512 is that with room, and it is a **bound on what a peer can
/// make this node hold and render** — the frame ceiling (16 MiB) is far too generous for a
/// field that exists to be read.
pub const MAX_REFUSAL_REASON_BYTES: usize = 512;

/// Largest frame count one actuation report may claim.
///
/// A report says how many frames the HAL wrote for one action: 13 on the reference quadruped,
/// and a multi-step gait on a bigger machine is still far below this. 4096 is two orders of
/// magnitude of headroom *and* a number a `u32` proto field carries exactly — an absurd claim
/// (`usize::MAX`) is refused at the decode boundary instead of being folded in and then
/// silently truncated on its way to the UI.
pub const MAX_ACTUATION_FRAMES: usize = 4096;

/// Largest deadman period a report may claim, in milliseconds (one hour).
///
/// A watchdog longer than this is not a watchdog; accepting `u64::MAX` would put a made-up
/// number in front of an operator as if the robot had measured it.
pub const MAX_WATCHDOG_MS: u64 = 3_600_000;

/// A command that was refused **before it reached the bus**, as reported to the commander.
///
/// **The wire form is validated** ([`RefusalWire`]): a refusal may travel as a stand-alone
/// frame on a future control-plane surface (today it appears inside an [`ActuationState`]),
/// so its `reason` is bounded at decode time, the same way [`MotorFrame`] bounds its argument
/// and [`ActuationState`] bounds its counts. A refusal whose `reason` exceeds
/// [`MAX_REFUSAL_REASON_BYTES`] is **refused at decode** — counted as a decode error by the
/// subscriber and skipped — instead of being stored, rendered, and silently truncated on the
/// way to the UI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RefusalWire", into = "RefusalWire")]
pub struct Refusal {
    /// The link sequence of the refused action.
    pub seq: u64,
    /// Why it was refused (malformed intent, or motion while e-stopped).
    pub reason: String,
}

/// The wire form of a [`Refusal`]: identical fields, order and encoding, so the bytes on the
/// link are unchanged — the difference is that **decoding validates** the `reason` length
/// (the same pattern [`MotorFrameWire`] and [`ActuationStateWire`] use, for the same reason:
/// this payload comes from a peer).
#[derive(Serialize, Deserialize)]
struct RefusalWire {
    seq: u64,
    reason: String,
}

impl Refusal {
    /// Validate a refusal's reason against the byte ceiling ([`MAX_REFUSAL_REASON_BYTES`]).
    ///
    /// Called by the wire path ([`RefusalWire`]); a local producer does not need it (its
    /// reasons are measured strings), but calling it is always safe and cheap.
    ///
    /// ```
    /// use amos_link::robot_hal::{Refusal, MAX_REFUSAL_REASON_BYTES};
    ///
    /// // A normal refusal (a real reason from the bridge is ~60 bytes):
    /// Refusal { seq: 1, reason: "e-stop latched: send {\"action\":\"arm\"}".to_string() }
    ///     .validate()
    ///     .expect("a real reason is under the ceiling");
    ///
    /// // At the ceiling is accepted (the bound is inclusive):
    /// Refusal { seq: 1, reason: "x".repeat(MAX_REFUSAL_REASON_BYTES) }
    ///     .validate()
    ///     .expect("the ceiling is inclusive");
    ///
    /// // One byte over is refused — what the wire path does at decode time, so a
    //  // stand-alone `Refusal` decoded from a peer can't smuggle in an unbounded
    //  // sentence that the UI would render as-is:
    /// Refusal { seq: 1, reason: "x".repeat(MAX_REFUSAL_REASON_BYTES + 1) }
    ///     .validate()
    ///     .expect_err("an over-ceiling reason is refused at decode");
    /// ```
    pub fn validate(&self) -> Result<()> {
        if self.reason.len() > MAX_REFUSAL_REASON_BYTES {
            return Err(LinkError::Robot(format!(
                "a refusal reason is {} bytes, over the {MAX_REFUSAL_REASON_BYTES}-byte ceiling",
                self.reason.len()
            )));
        }
        Ok(())
    }
}

impl TryFrom<RefusalWire> for Refusal {
    type Error = LinkError;

    fn try_from(wire: RefusalWire) -> Result<Self> {
        let refusal = Refusal {
            seq: wire.seq,
            reason: wire.reason,
        };
        refusal.validate()?;
        Ok(refusal)
    }
}

impl From<Refusal> for RefusalWire {
    /// Encoding never *creates* a refusal, so it does not re-validate (the value came from
    /// either a measured local producer or a decode that already passed).
    fn from(refusal: Refusal) -> Self {
        Self {
            seq: refusal.seq,
            reason: refusal.reason,
        }
    }
}

/// What the bridge last did, as it travels on [`actuation_topic`].
///
/// This is the **return path** of the control loop. Without it a commander cannot tell an
/// applied command from a refused one, and — the case that matters most — a watchdog
/// torque cut is **invisible** to the peer whose link just died: it would keep believing
/// its last `trot` is running.
///
/// Who published it is the envelope's `publisher` (the robot), exactly as the topic
/// doctrine in `docs/amos-link.md` §2 describes, so the payload does not duplicate it. The
/// report time is the envelope's stamp for the same reason.
///
/// **The wire form is validated** ([`ActuationStateWire`]): a report arrives from *another*
/// peer, so this is a trust boundary like a motor frame's, not a local call. A count, a deadman
/// period or a reason outside its bound is **refused at decode** — counted as a decode error by
/// the subscriber and never folded into the control plane's table — instead of being stored,
/// rendered, and (for `frames`) silently truncated into a `u32` on the way out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "ActuationStateWire", into = "ActuationStateWire")]
pub struct ActuationState {
    /// The most recent action the bridge acted on (`None` before any arrived).
    pub seq: Option<u64>,
    /// The last **accepted** gait (`None` before one was accepted).
    pub gait: Option<Gait>,
    /// Frames written to the bus for that action.
    pub frames: usize,
    /// Drivers energized — read from the bus itself ([`RobotHal::armed`]), not inferred.
    pub armed: bool,
    /// Torque is cut and latched until an explicit `arm` arrives.
    pub estopped: bool,
    /// Why torque was cut; `None` while not e-stopped.
    pub estop_reason: Option<EstopReason>,
    /// The deadman period, when the bridge has one (`None` = the caller guarantees cadence).
    pub watchdog_ms: Option<u64>,
    /// The most recent refusal, if any.
    pub last_refusal: Option<Refusal>,
}

impl ActuationState {
    /// The **mode** part of this report: the discrete state that decides whether a new
    /// report is worth a frame.
    ///
    /// A 50 Hz control stream must not become 50 state frames per second on a `state`
    /// channel, so the per-action detail (`seq`, `frames`) is excluded from the comparison:
    /// it travels *with* a report when the mode changes, it never causes one.
    pub fn mode(&self) -> (bool, bool, Option<EstopReason>, Option<Gait>, Option<&str>) {
        (
            self.armed,
            self.estopped,
            self.estop_reason,
            self.gait,
            self.last_refusal.as_ref().map(|r| r.reason.as_str()),
        )
    }
}

/// The wire form of an [`ActuationState`]: identical fields, order and encoding, so the bytes
/// on the link are unchanged — the difference is that **decoding validates** (the same pattern
/// [`MotorFrameWire`] uses for a motor frame, and for the same reason: this payload comes from
/// a peer).
///
/// The bounds exist because every one of these fields ends up in front of a human (the System
/// UI's 「机器人链路」 page, the CLI's `state`) or in a `u32` proto field:
///
/// * `frames` — a frame count a `u32` must carry ([`MAX_ACTUATION_FRAMES`]);
/// * `watchdog_ms` — a deadman period ([`MAX_WATCHDOG_MS`]);
/// * `last_refusal.reason` — a sentence that is stored and rendered
///   ([`MAX_REFUSAL_REASON_BYTES`]).
///
/// A report that exceeds any of them is refused as a *decode error* (counted by the
/// subscription, logged with a bounded budget, and skipped) rather than folded in.
#[derive(Serialize, Deserialize)]
struct ActuationStateWire {
    seq: Option<u64>,
    gait: Option<Gait>,
    frames: usize,
    armed: bool,
    estopped: bool,
    estop_reason: Option<EstopReason>,
    watchdog_ms: Option<u64>,
    last_refusal: Option<Refusal>,
}

impl TryFrom<ActuationStateWire> for ActuationState {
    type Error = LinkError;

    fn try_from(wire: ActuationStateWire) -> Result<Self> {
        let state = ActuationState {
            seq: wire.seq,
            gait: wire.gait,
            frames: wire.frames,
            armed: wire.armed,
            estopped: wire.estopped,
            estop_reason: wire.estop_reason,
            watchdog_ms: wire.watchdog_ms,
            last_refusal: wire.last_refusal,
        };
        state.validate()?;
        Ok(state)
    }
}

impl From<ActuationState> for ActuationStateWire {
    /// Encoding never *creates* a report, so it does not re-validate (the value came from a
    /// locally measured HAL state or from a decode that already passed).
    fn from(state: ActuationState) -> Self {
        Self {
            seq: state.seq,
            gait: state.gait,
            frames: state.frames,
            armed: state.armed,
            estopped: state.estopped,
            estop_reason: state.estop_reason,
            watchdog_ms: state.watchdog_ms,
            last_refusal: state.last_refusal,
        }
    }
}

impl ActuationState {
    /// Check a report's **untrusted** fields against their bounds (see
    /// [`ActuationStateWire`]): a count, a deadman period and a refusal reason.
    ///
    /// Called by the wire path ([`ActuationStateWire`]); a local producer does not need it
    /// (its numbers are measured), but calling it is always safe and cheap.
    pub fn validate(&self) -> Result<()> {
        if self.frames > MAX_ACTUATION_FRAMES {
            return Err(LinkError::Robot(format!(
                "a report claims {} frames for one action, over the {MAX_ACTUATION_FRAMES} ceiling",
                self.frames
            )));
        }
        if let Some(ms) = self.watchdog_ms {
            if ms > MAX_WATCHDOG_MS {
                return Err(LinkError::Robot(format!(
                    "a report claims a {ms} ms watchdog, over the {MAX_WATCHDOG_MS} ms ceiling"
                )));
            }
        }
        if let Some(refusal) = &self.last_refusal {
            if refusal.reason.len() > MAX_REFUSAL_REASON_BYTES {
                return Err(LinkError::Robot(format!(
                    "a refusal reason is {} bytes, over the {MAX_REFUSAL_REASON_BYTES}-byte ceiling",
                    refusal.reason.len()
                )));
            }
        }
        Ok(())
    }
}

///
/// Deliberately a `step()` and not a `loop`: the caller owns the cadence (a 50 Hz
/// control task, a test, the CLI), which keeps this type free of a hidden scheduler and
/// makes the whole intent→frames path observable from a unit test.
///
/// Two safety properties live here, because they cannot live in the agent (it is the
/// component that may be wrong, slow, or disconnected):
///
/// 1. **Latched e-stop.** Once an `estop` is applied — commanded *or* tripped by the
///    watchdog — every later motion command is [`BridgeEvent::Refused`] until an
///    explicit `{"action":"arm"}` arrives. A robot must not restart because a stale
///    `trot` was still in the queue.
/// 2. **Deadman watchdog** (opt-in, [`RobotBridge::with_watchdog`]). If no action
///    arrives within the period, the bridge cuts torque itself and reports
///    [`EstopReason::Watchdog`]: the honest answer to "the Wi-Fi died mid-stride".
pub struct RobotBridge<H: RobotHal> {
    subscriber: crate::pubsub::Subscriber<AgentAction>,
    /// How the control channel is read: the reference machine's gaits, or a platform profile's
    /// vocabulary. The safety core below is identical for both.
    vocabulary: Vocabulary,
    hal: H,
    watchdog: Option<Duration>,
    estop_latched: bool,
    /// Why torque is cut while latched (commanded vs watchdog). Cleared by `arm`.
    estop_reason: Option<EstopReason>,
    /// Where the actuation state is reported (the control loop's return path). `None`
    /// keeps the bridge purely local — the shape a unit test drives.
    reporter: Option<Publisher<ActuationState>>,
    /// The mode of the last report that actually reached the link, so an unchanged mode is
    /// not re-sent (see [`ActuationState::mode`]). `None` = nothing reported yet.
    last_reported: Option<ActuationState>,
    /// When the last report reached the link, for the refresh interval.
    last_report_at: Option<Instant>,
    /// How long an unchanged mode is re-announced after (`Duration::ZERO` = on change only).
    report_refresh: Duration,
    /// What the last action was and what the bus did with it.
    last_seq: Option<u64>,
    last_gait: Option<Gait>,
    last_frames: usize,
    last_refusal: Option<Refusal>,
}

impl<H: RobotHal> RobotBridge<H> {
    /// Pair a control-channel subscription with a servo bus (no watchdog: the caller
    /// guarantees a cadence).
    pub fn new(subscriber: crate::pubsub::Subscriber<AgentAction>, hal: H) -> Self {
        Self {
            subscriber,
            vocabulary: Vocabulary::Reference,
            hal,
            watchdog: None,
            estop_latched: false,
            estop_reason: None,
            reporter: None,
            last_reported: None,
            last_report_at: None,
            report_refresh: DEFAULT_REPORT_REFRESH,
            last_seq: None,
            last_gait: None,
            last_frames: 0,
            last_refusal: None,
        }
    }

    /// The same bridge, but a silence longer than `period` cuts torque.
    ///
    /// This is the deadman switch a field robot needs: with a 1 s period on a control
    /// topic that is refreshed at 10–50 Hz, a lost link stops the robot instead of
    /// letting the last command run forever.
    ///
    /// ```
    /// use std::sync::Arc;
    /// use std::time::Duration;
    /// use amos_link::broker::Broker;
    /// use amos_link::codec::Clock;
    /// use amos_link::keyexpr::Topic;
    /// use amos_link::metrics::LinkMetrics;
    /// use amos_link::pubsub::Subscriber;
    /// use amos_link::qos::Qos;
    /// use amos_link::robot_hal::{AgentAction, MockRobotHal, RobotBridge};
    ///
    /// # tokio::runtime::Runtime::new().unwrap().block_on(async {
    /// let metrics = Arc::new(LinkMetrics::new());
    /// let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();
    /// let _clock = Arc::new(Clock::host()); // not consumed by the bridge
    /// let subscriber = Subscriber::<AgentAction>::subscribe(
    ///     Arc::clone(&transport),
    ///     Topic::pattern("amos/test/control/*").expect("pattern"),
    ///     Qos::control(),
    ///     Arc::clone(&metrics),
    /// )
    /// .await
    /// .expect("subscribe");
    /// let bridge = RobotBridge::with_watchdog(
    ///     subscriber,
    ///     MockRobotHal::new(),
    ///     Duration::from_millis(250),
    /// );
    /// // The period is what the bridge will read out of `watchdog()` — and what a
    /// // report carries on the link:
    /// assert_eq!(bridge.watchdog(), Some(Duration::from_millis(250)));
    /// assert_eq!(bridge.state().watchdog_ms, Some(250));
    /// # });
    /// ```
    pub fn with_watchdog(
        subscriber: crate::pubsub::Subscriber<AgentAction>,
        hal: H,
        period: Duration,
    ) -> Self {
        Self {
            subscriber,
            vocabulary: Vocabulary::Reference,
            hal,
            watchdog: Some(period),
            estop_latched: false,
            estop_reason: None,
            reporter: None,
            last_reported: None,
            last_report_at: None,
            report_refresh: DEFAULT_REPORT_REFRESH,
            last_seq: None,
            last_gait: None,
            last_frames: 0,
            last_refusal: None,
        }
    }

    /// The same safety core, driven by a **platform profile**'s vocabulary.
    ///
    /// The e-stop latch, the deadman, the refusal-with-a-reason and the return path are the code
    /// below — unchanged. What changes is what an action *means*: `{"action":"takeoff"}` is a
    /// `Motion` on the drone profile (refused while latched) and `{"action":"enable"}` is its
    /// `Arm`; the sentence a refusal carries names *that* key, never an `arm` the machine does
    /// not have.
    ///
    /// The deadman period comes from the profile's own [`SafetyEnvelope`], and an envelope a
    /// bridge cannot honour (zero, or longer than a report may carry) is refused **here** rather
    /// than at the first missed beat.
    ///
    /// The shared return document's `gait` field is left `None` for a profile: it is the
    /// reference machine's vocabulary, and putting a profile's action key there would be a
    /// payload-schema change (with its proto and UI consequences) rather than a report. A profile
    /// publishes its own mode on its own topic — see docs/robot-domains.md.
    ///
    /// [`SafetyEnvelope`]: crate::platform::SafetyEnvelope
    pub fn for_platform(
        subscriber: crate::pubsub::Subscriber<AgentAction>,
        hal: H,
        platform: &'static crate::platform::Platform,
    ) -> Result<Self> {
        let envelope = platform.envelope();
        envelope.validate()?;
        Ok(Self {
            subscriber,
            vocabulary: Vocabulary::Profile(platform),
            hal,
            watchdog: Some(envelope.watchdog),
            estop_latched: false,
            estop_reason: None,
            reporter: None,
            last_reported: None,
            last_report_at: None,
            report_refresh: DEFAULT_REPORT_REFRESH,
            last_seq: None,
            last_gait: None,
            last_frames: 0,
            last_refusal: None,
        })
    }

    /// Which machine this bridge speaks for (`quadruped`, `drone`, …): the profile's kind, or the
    /// reference machine's for a bridge built by [`RobotBridge::new`].
    ///
    /// ```
    /// use amos_link::platform::Platform;
    ///
    /// // The label is the kind key — a bridge reports the kind of the profile it was
    /// // built for, not the constructor name. The same key surfaces in `PlatformKind::key`
    /// // and in profile documents, so an operator can `grep` a single word across docs,
    /// // logs, and a UI rendering this label.
    /// assert_eq!(Platform::quadruped().kind().key(), "quadruped");
    /// assert_eq!(Platform::drone().kind().key(), "drone");
    /// ```
    pub fn platform_label(&self) -> &'static str {
        self.vocabulary.label()
    }

    /// Report this bridge's actuation state on the link (see [`ActuationState`]).
    ///
    /// This closes the control loop: a commander subscribing to
    /// `amos/<robot>/state/actuation` learns that its command was *refused*, that an
    /// e-stop is latched, or that the **watchdog cut torque** — the last one is otherwise
    /// unobservable to the very peer whose link just died.
    ///
    /// The bridge works without one (the same code path a unit test drives), and a failed
    /// report never fails a step: the safety action has already happened, so turning a link
    /// hiccup into an `Err` would tell the caller the robot had *not* stopped when it had.
    ///
    /// The mode is reported **when it changes**, plus once per
    /// [`DEFAULT_REPORT_REFRESH`] while it stays the same — because a subscriber that
    /// arrives *late* (a brain that just booted, the daemon's control plane) would otherwise
    /// never learn the current mode: the broker keeps **no retained value and replays
    /// nothing**, so a robot that is steadily trotting has no further transition to send.
    pub fn reporting(mut self, state: Publisher<ActuationState>) -> Self {
        self.reporter = Some(state);
        self
    }

    /// Override the refresh interval for an unchanged mode (`Duration::ZERO` = report on
    /// change only, which is the shape a test drives to pin "no frame per command").
    pub fn with_report_refresh(mut self, period: Duration) -> Self {
        self.report_refresh = period;
        self
    }

    /// What the bridge would report right now (also the honest answer for a caller with no
    /// publisher attached).
    ///
    /// ```
    /// use std::sync::Arc;
    /// use std::time::Duration;
    /// use amos_link::broker::Broker;
    /// use amos_link::codec::Clock;
    /// use amos_link::keyexpr::Topic;
    /// use amos_link::metrics::LinkMetrics;
    /// use amos_link::pubsub::Subscriber;
    /// use amos_link::qos::Qos;
    /// use amos_link::robot_hal::{AgentAction, MockRobotHal, RobotBridge, RobotHal};
    ///
    /// # tokio::runtime::Runtime::new().unwrap().block_on(async {
    /// // The bridge needs a Subscriber<AgentAction> on a real transport. The construction
    /// // is the same as the integration tests' `TestLink`, inlined here so the public
    /// // surface can be exercised from a doc:
    /// let metrics = Arc::new(LinkMetrics::new());
    /// let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();
    /// let _clock = Arc::new(Clock::host());
    /// let subscriber = Subscriber::<AgentAction>::subscribe(
    ///     Arc::clone(&transport),
    ///     Topic::pattern("amos/test/control/*").expect("pattern"),
    ///     Qos::control(),
    ///     Arc::clone(&metrics),
    /// )
    /// .await
    /// .expect("subscribe");
    /// let bridge = RobotBridge::with_watchdog(
    ///     subscriber,
    ///     MockRobotHal::new(),
    ///     Duration::from_millis(40),
    /// );
    ///
    /// // Query methods on a fresh bridge — the state an operator sees before any action:
    /// assert!(!bridge.is_estopped(), "no e-stop until a watchdog trips or an estop arrives");
    /// assert_eq!(bridge.watchdog(), Some(Duration::from_millis(40)));
    /// assert_eq!(bridge.platform_label(), "quadruped");
    /// assert!(!bridge.hal().armed(), "the bus starts de-energized");
    ///
    /// let s = bridge.state();
    /// assert_eq!(s.seq, None, "no action has arrived yet");
    /// assert_eq!(s.gait, None);
    /// assert_eq!(s.frames, 0);
    /// assert!(!s.armed && !s.estopped);
    /// assert_eq!(s.estop_reason, None);
    /// assert_eq!(s.watchdog_ms, Some(40));
    /// assert_eq!(s.last_refusal, None);
    /// # });
    /// ```
    pub fn state(&self) -> ActuationState {
        ActuationState {
            seq: self.last_seq,
            gait: self.last_gait,
            frames: self.last_frames,
            // Read from the bus, not inferred: "armed" is the driver's fact.
            armed: self.hal.armed(),
            estopped: self.estop_latched,
            estop_reason: self.estop_reason,
            // Saturated, not truncated: `as u64` would silently wrap a watchdog period above
            // ~584 million years into a small number, and this value travels on the wire.
            watchdog_ms: self
                .watchdog
                .map(|p| u64::try_from(p.as_millis()).unwrap_or(u64::MAX)),
            last_refusal: self.last_refusal.clone(),
        }
    }

    /// Publish the current state **when its mode changed**, never once per command.
    async fn report(&mut self) {
        let Some(publisher) = self.reporter.as_ref() else {
            return;
        };
        let now = self.state();
        let changed = self.last_reported.as_ref().map(ActuationState::mode) != Some(now.mode());
        // The refresh is what makes the state channel answerable for a **late** subscriber:
        // the broker retains nothing, so an unchanged mode would otherwise never be re-sent.
        // It rides `step()` — the caller's own cadence — not a spawned timer, so this type
        // still has no hidden scheduler.
        let refresh_due = !self.report_refresh.is_zero()
            && self
                .last_report_at
                .is_some_and(|at| at.elapsed() >= self.report_refresh);
        if !changed && !refresh_due {
            return;
        }
        match publisher.publish(&now).await {
            Ok(_) => {
                self.last_reported = Some(now);
                self.last_report_at = Some(Instant::now());
            }
            // Not fatal, and not silent: the commander keeps its old view until the next
            // change (or refresh) can be delivered.
            Err(e) => tracing::warn!(
                error = %e,
                "actuation state could not be reported (link closing?)"
            ),
        }
    }

    /// The bus this bridge drives.
    pub fn hal(&self) -> &H {
        &self.hal
    }

    /// True while motion is refused until an `arm` arrives.
    pub fn is_estopped(&self) -> bool {
        self.estop_latched
    }

    /// The deadman period, if one is configured.
    pub fn watchdog(&self) -> Option<Duration> {
        self.watchdog
    }

    /// Wait for the next action (or for the watchdog), act on it, and **report the result**
    /// on the link when the actuation *mode* changed (see [`RobotBridge::reporting`]).
    ///
    /// A *refusal* is an `Ok` event, not an error: it is the safety layer doing its job.
    /// Only a transport failure or a broken bus surfaces as `Err` — and then nothing is
    /// reported, because the bridge learned nothing new about the robot.
    pub async fn step(&mut self) -> Result<BridgeEvent> {
        let event = self.step_inner().await?;
        self.report().await;
        Ok(event)
    }

    /// The safety core of one step: the decisions themselves, with no reporting — so they
    /// stay exactly as unit-testable as they were before a reporter existed.
    async fn step_inner(&mut self) -> Result<BridgeEvent> {
        let received = match self.watchdog {
            Some(period) => match tokio::time::timeout(period, self.subscriber.recv()).await {
                Ok(result) => result?,
                Err(_) => {
                    // Deadman: no action within the period → cut torque / stop, and latch.
                    //
                    // What the stop *is* depends on how this loop reads the control channel:
                    // a platform profile knows its own actuator table, so its halt batch is the
                    // profile's (a car's deadman is full braking, a drone's is its six motors);
                    // the reference machine keeps the HAL's own cut, because a bus may cut torque
                    // with a single hardware line and that shape is the driver's business.
                    //
                    // Either way the count comes back from what the bus **accepted** — never from
                    // a guess — and the report carries a measured number.
                    let frames = match self.vocabulary.platform() {
                        Some(platform) => {
                            let halt = platform.halt_frames()?;
                            self.hal.apply(&halt).await?
                        }
                        None => self.hal.estop().await?,
                    };
                    self.estop_latched = true;
                    self.estop_reason = Some(EstopReason::Watchdog);
                    tracing::warn!(
                        period_ms = period.as_millis(),
                        frames,
                        "watchdog tripped: no action arrived, torque cut"
                    );
                    return Ok(BridgeEvent::Estopped {
                        reason: EstopReason::Watchdog,
                        frames,
                    });
                }
            },
            None => self.subscriber.recv().await?,
        };
        let seq = received.seq;

        let intent = match self.vocabulary.parse(&received.message.json) {
            Ok(intent) => intent,
            Err(e) => {
                // Malformed intent never reaches the bus (and never silently becomes a
                // default pose).
                tracing::warn!(seq, error = %e, "refusing a malformed action");
                self.last_refusal = Some(Refusal {
                    seq,
                    reason: e.to_string(),
                });
                return Ok(BridgeEvent::Refused {
                    seq,
                    reason: e.to_string(),
                });
            }
        };

        if intent.class == IntentClass::Arm {
            let frames = self.vocabulary.plan(&intent)?;
            let applied = self.hal.apply(&frames).await?;
            let was_latched = self.estop_latched;
            self.estop_latched = false;
            self.estop_reason = None;
            self.last_seq = Some(seq);
            // The report's `gait` field is the *reference* machine's vocabulary; for a
            // profile the field is intentionally left `None` (the profile's own action key
            // would be a payload-schema change with proto and UI consequences — see
            // `for_platform`). The reference path keeps the gait key it parses from, so an
            // older board still reads the same field the same way.
            self.last_gait = match &self.vocabulary {
                Vocabulary::Reference => Gait::from_key(intent.action),
                Vocabulary::Profile(_) => None,
            };
            self.last_frames = applied;
            self.last_refusal = None;
            tracing::info!(seq, was_latched, "armed: motion allowed again");
            return Ok(BridgeEvent::Applied {
                seq,
                frames: applied,
                armed: true,
            });
        }

        if self.estop_latched && intent.class == IntentClass::Motion {
            let reason = self.vocabulary.arm_hint();
            tracing::warn!(seq, reason = %reason, "refusing motion while e-stopped");
            self.last_refusal = Some(Refusal {
                seq,
                reason: reason.clone(),
            });
            return Ok(BridgeEvent::Refused { seq, reason });
        }

        // A set point on de-energized drives is a command nobody is listening to: it is refused
        // (with the profile's own arm key) instead of written and forgotten. The reference
        // machine self-arms on motion, so this branch cannot fire for it — and a `Halt` is never
        // refused here, because a stop must work on a disarmed machine too.
        if intent.class == IntentClass::Motion
            && !self.vocabulary.self_arms_on_motion()
            && !self.hal.armed()
        {
            let reason = self.vocabulary.disarmed_hint();
            tracing::warn!(seq, reason = %reason, "refusing motion on disarmed drives");
            self.last_refusal = Some(Refusal {
                seq,
                reason: reason.clone(),
            });
            return Ok(BridgeEvent::Refused { seq, reason });
        }

        let frames = self.vocabulary.plan(&intent)?;
        let applied = self.hal.apply(&frames).await?;
        self.last_seq = Some(seq);
        // Same `gait` discipline as the Arm branch: the reference machine reports its gait
        // (the field is what makes `actuation_topic` useful for a quadruped), a profile leaves
        // it `None`. A `None` from `Gait::from_key` is what the motion path already produced
        // for any non-quadruped profile; we make it explicit so a future vocabulary cannot
        // reintroduce the asymmetry by aliasing a profile action into a reference gait.
        self.last_gait = match &self.vocabulary {
            Vocabulary::Reference => Gait::from_key(intent.action),
            Vocabulary::Profile(_) => None,
        };
        self.last_frames = applied;
        self.last_refusal = None;
        if intent.class == IntentClass::Halt {
            self.estop_latched = true;
            self.estop_reason = Some(EstopReason::Commanded);
            tracing::warn!(seq, "commanded e-stop");
            return Ok(BridgeEvent::Estopped {
                reason: EstopReason::Commanded,
                frames: applied,
            });
        }
        Ok(BridgeEvent::Applied {
            seq,
            frames: applied,
            armed: true,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joints_map_to_legs_and_parts() {
        assert_eq!(JointId::new(0).expect("joint").leg(), 0);
        assert_eq!(JointId::new(11).expect("joint").leg(), 3);
        assert_eq!(JointId::new(11).expect("joint").part(), 2);
        assert!(JointId::new(12).is_err(), "out of range");
        assert_eq!(JointId::new(MAX_JOINT).expect("joint").index(), MAX_JOINT);
        assert!(JointTarget::new(JointId(0), MAX_JOINT_MILLI_DEG + 1).is_err());
        assert!(JointTarget::new(JointId(0), -MAX_JOINT_MILLI_DEG).is_ok());
    }

    #[test]
    fn a_joint_id_is_valid_on_every_construction_path() {
        // Refused by the constructor...
        assert!(JointId::new(MAX_JOINT + 1).is_err());
        assert!(JointId::new(200).is_err());
        assert_eq!(JointId::new(3).expect("joint").index(), 3);
        // ...by the bincode `Message` path (a `JointId` arriving as a payload)...
        assert!(bincode::deserialize::<JointId>(&[200u8]).is_err());
        assert_eq!(
            bincode::deserialize::<JointId>(&[MAX_JOINT]).expect("in range"),
            JointId(MAX_JOINT)
        );
        // ...and by `TryFrom<u8>` directly.
        assert!(JointId::try_from(200u8).is_err());
    }

    #[test]
    fn the_arithmetic_extremes_are_refused_not_overflowed() {
        // `i32::MIN.abs()` overflows: a debug panic, and in release a negative wrap that
        // would *pass* an `abs() > limit` test. An agent's JSON can carry it, so the check
        // has to be a range comparison.
        let joint = JointId(0);
        let err = JointTarget::new(joint, i32::MIN).expect_err("i32::MIN must be refused");
        assert!(matches!(err, LinkError::Robot(_)), "got: {err:?}");
        assert!(JointTarget::new(joint, i32::MAX).is_err());
        assert!(JointTarget::new(joint, -MAX_JOINT_MILLI_DEG - 1).is_err());
        assert!(JointTarget::new(joint, MAX_JOINT_MILLI_DEG + 1).is_err());
        assert!(JointTarget::new(joint, -MAX_JOINT_MILLI_DEG).is_ok());
        assert!(JointTarget::new(joint, MAX_JOINT_MILLI_DEG).is_ok());

        // The same extreme on a *frame* is refused by `validate`, never by `.abs()`.
        assert!(MotorFrame::new(JointId(0), MotorOp::SetPosition, i32::MIN)
            .validate()
            .is_err());
        assert!(MotorFrame::new(JointId(0), MotorOp::SetTorque, i32::MIN)
            .validate()
            .is_err());
        // And the JSON path that reaches it refuses the whole action.
        assert!(parse_command(
            r#"{"action":"trot","targets":[{"joint":1,"milli_deg":-2147483648}]}"#
        )
        .is_err());
    }

    /// One bus frame assembled by hand — a valid SOF and CRC16 over arbitrary contents,
    /// which is what a buggy or hostile producer can put on the wire.
    fn raw_frame(joint: u8, op: u8, arg: i32) -> [u8; FRAME_LEN] {
        let mut out = [0u8; FRAME_LEN];
        out[0] = FRAME_SOF[0];
        out[1] = FRAME_SOF[1];
        out[2] = joint;
        out[3] = op;
        out[4..8].copy_from_slice(&arg.to_le_bytes());
        let crc = crc16_ccitt(&out[..8]);
        out[8..10].copy_from_slice(&crc.to_le_bytes());
        out
    }

    #[test]
    fn a_bus_frame_must_be_a_valid_set_point() {
        // A joint that does not exist: the CRC is fine, the frame is not.
        let err = MotorFrame::decode(&raw_frame(200, MotorOp::Enable.code(), 0))
            .expect_err("joint 200 does not exist");
        assert!(matches!(err, LinkError::Robot(_)), "got: {err:?}");

        // A position beyond the travel limit, including the arithmetic extremes.
        for arg in [
            MAX_JOINT_MILLI_DEG + 1,
            -MAX_JOINT_MILLI_DEG - 1,
            i32::MIN,
            i32::MAX,
        ] {
            assert!(
                MotorFrame::decode(&raw_frame(3, MotorOp::SetPosition.code(), arg)).is_err(),
                "position {arg} must be refused"
            );
        }
        // A torque outside 0..=100%.
        for arg in [-1, MAX_TORQUE_MILLI_PERCENT + 1, i32::MIN] {
            assert!(MotorFrame::decode(&raw_frame(3, MotorOp::SetTorque.code(), arg)).is_err());
        }

        // The legal extremes still decode, so the limits are inclusive.
        assert!(MotorFrame::decode(&raw_frame(
            3,
            MotorOp::SetPosition.code(),
            -MAX_JOINT_MILLI_DEG
        ))
        .is_ok());
        assert!(MotorFrame::decode(&raw_frame(
            3,
            MotorOp::SetTorque.code(),
            MAX_TORQUE_MILLI_PERCENT
        ))
        .is_ok());
        // A no-argument op ignores its argument (there is nothing to bound).
        assert!(MotorFrame::decode(&raw_frame(MAX_JOINT, MotorOp::Estop.code(), i32::MIN)).is_ok());
    }

    #[test]
    fn an_actuation_report_off_the_wire_is_validated_not_trusted() {
        use crate::codec::Message;

        // The report comes from *another peer*, so it is a trust boundary like a motor frame's
        // — and every field here ends up in front of a human (the System UI's panel, the CLI's
        // `state`) or inside a `u32` proto field. The fixture is a legal report; the three
        // mutations below are what a hostile or broken publisher can put on the link.
        let good = ActuationState {
            seq: Some(7),
            gait: Some(Gait::Trot),
            frames: JOINTS + 1,
            armed: true,
            estopped: false,
            estop_reason: None,
            watchdog_ms: Some(1_000),
            last_refusal: Some(Refusal {
                seq: 6,
                reason: "e-stop latched: send {\"action\":\"arm\"} to re-arm".to_string(),
            }),
        };
        // A legitimate report round-trips unchanged: the wire form is byte-compatible.
        let bytes = <ActuationState as Message>::encode(&good).expect("encode");
        assert_eq!(
            <ActuationState as Message>::decode(&bytes).expect("decode"),
            good
        );

        // 1. A frame count beyond the ceiling: a `u32` proto field must carry it later, and the
        //    player is refusing to hold a number it could not report faithfully.
        let mut huge = good.clone();
        huge.frames = MAX_ACTUATION_FRAMES + 1;
        let wire = <ActuationState as Message>::encode(&huge).expect("a peer can write it");
        let err = <ActuationState as Message>::decode(&wire).expect_err("…and we must refuse it");
        // The refusal travels through bincode, so it arrives wrapped as a codec error whose text
        // is the domain refusal — which is what a log line and the decode-error counter carry.
        assert!(
            err.to_string().contains("robot command error"),
            "the domain refusal is preserved: {err}"
        );
        assert!(
            err.to_string().contains(&MAX_ACTUATION_FRAMES.to_string()),
            "the refusal names the bound: {err}"
        );

        // 2. A deadman period that is not a deadman period.
        let mut absurd = good.clone();
        absurd.watchdog_ms = Some(u64::MAX);
        assert!(<ActuationState as Message>::decode(
            &<ActuationState as Message>::encode(&absurd).expect("encode")
        )
        .is_err());

        // 3. A refusal reason longer than a sentence: bounded because it is stored and rendered.
        let mut verbose = good.clone();
        verbose.last_refusal = Some(Refusal {
            seq: 1,
            reason: "x".repeat(MAX_REFUSAL_REASON_BYTES + 1),
        });
        assert!(<ActuationState as Message>::decode(
            &<ActuationState as Message>::encode(&verbose).expect("encode")
        )
        .is_err());

        // …and the ceiling itself is legal: an off-by-one here would refuse a real report from a
        // machine with more joints than the reference quadruped.
        let mut at_ceiling = good.clone();
        at_ceiling.frames = MAX_ACTUATION_FRAMES;
        at_ceiling.watchdog_ms = Some(MAX_WATCHDOG_MS);
        at_ceiling.last_refusal = Some(Refusal {
            seq: 1,
            reason: "x".repeat(MAX_REFUSAL_REASON_BYTES),
        });
        assert!(<ActuationState as Message>::decode(
            &<ActuationState as Message>::encode(&at_ceiling).expect("encode")
        )
        .is_ok());
    }

    #[test]
    fn a_typed_frame_payload_must_be_a_valid_set_point() {
        use crate::codec::Message;

        // The bincode path (a `MotorFrame` published on the link) is validated as well:
        // only a *decoder* can enforce it, so an invalid frame may be written but must
        // never be readable.
        let valid = MotorFrame::new(JointId(3), MotorOp::SetPosition, -15_000);
        let wire = <MotorFrame as Message>::encode(&valid).expect("encode");
        assert_eq!(
            wire.len(),
            9,
            "the wire form is pinned: u8 joint + u32 op tag + i32 arg"
        );
        assert_eq!(
            <MotorFrame as Message>::decode(&wire).expect("decode"),
            valid
        );

        let bad_joint = MotorFrame {
            joint: JointId(200),
            op: MotorOp::Enable,
            arg: 0,
        };
        let wire = <MotorFrame as Message>::encode(&bad_joint).expect("encode");
        assert!(
            <MotorFrame as Message>::decode(&wire).is_err(),
            "an out-of-range joint must not decode"
        );

        let bad_arg = MotorFrame {
            joint: JointId(3),
            op: MotorOp::SetPosition,
            arg: i32::MIN,
        };
        let wire = <MotorFrame as Message>::encode(&bad_arg).expect("encode");
        assert!(
            <MotorFrame as Message>::decode(&wire).is_err(),
            "an out-of-travel set point must not decode"
        );
    }

    #[test]
    fn every_planned_pose_respects_the_travel_limits() {
        // A consistency proof between the pose table and the limits: whatever a gait asks
        // for at any speed must be a legal set point, or `plan` would build frames the bus
        // (and now the decoder) refuses.
        for gait in Gait::ALL {
            for speed in [0.0, 0.25, 0.5, 0.75, 1.0] {
                let command = RobotCommand {
                    gait,
                    speed,
                    duration_ms: 0,
                    targets: Vec::new(),
                };
                for frame in plan(&command) {
                    assert!(
                        frame.validate().is_ok(),
                        "{gait:?} at speed {speed} produced an out-of-limit frame: {frame:?}"
                    );
                    // Every planned frame survives the bus round trip.
                    assert_eq!(
                        MotorFrame::decode(&frame.encode()).expect("decode our own frame"),
                        frame
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn the_mock_hal_refuses_a_batch_outside_the_limits_and_writes_nothing() {
        let hal = MockRobotHal::new();
        let batch = [
            MotorFrame::new(JointId(1), MotorOp::Enable, 0),
            MotorFrame::new(JointId(2), MotorOp::SetPosition, i32::MIN),
        ];
        let err = hal
            .apply(&batch)
            .await
            .expect_err("the batch must be refused");
        assert!(matches!(err, LinkError::Robot(_)), "got: {err:?}");
        assert!(
            hal.frames().is_empty(),
            "a refused batch writes nothing at all — not even its valid prefix"
        );
        assert_eq!(hal.applied(), 0);
        assert!(!hal.armed(), "the refused batch energized nothing");

        // The same batch without the bad frame is applied in full.
        let ok = [MotorFrame::new(JointId(1), MotorOp::Enable, 0)];
        assert_eq!(hal.apply(&ok).await.expect("apply"), 1);
        assert!(hal.armed());
    }

    /// A deterministic totality sweep for the bus decoder: 1 000 pseudo-random 10-byte
    /// frames plus random single-byte mutations of a real frame must all come back as
    /// `Err`, or decode consistently, but **never** as a panic.
    ///
    /// Fixed seed, no fuzzing dependency: the property reproduces forever, so a gate runs
    /// it offline today and in a year with the same result.
    #[test]
    fn decoding_arbitrary_bus_bytes_never_panics() {
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            (seed >> 33) as u32
        };

        for _ in 0..1_000 {
            let mut bytes = [0u8; FRAME_LEN];
            for byte in &mut bytes {
                *byte = (next() & 0xff) as u8;
            }
            if let Ok(decoded) = MotorFrame::decode(&bytes) {
                // A frame that *did* decode must re-encode to the identical bytes.
                assert_eq!(decoded.encode(), bytes);
            }
        }

        let valid = MotorFrame::new(JointId(5), MotorOp::SetPosition, -20_000).encode();
        for _ in 0..500 {
            let mut mutated = valid;
            let index = (next() as usize) % mutated.len();
            mutated[index] ^= 1 << (next() % 8);
            let _ = MotorFrame::decode(&mutated);
        }
    }

    #[test]
    fn a_non_finite_speed_cannot_pick_a_pose() {
        // `f32::clamp` propagates NaN and `NaN as i32` is 0 — a *straighter* stance than any
        // legal speed produces. An unvalidated float (a `RobotCommand` built by hand, whose
        // fields are public) must not be able to steer the pose table, so **every**
        // non-finite speed lands on the slowest pose: an invalid request must never produce
        // a more aggressive gait than the safe end of the range.
        for gait in Gait::ALL {
            let slowest = gait.pose(0.0);
            assert_eq!(gait.pose(f32::NAN), slowest, "{gait:?} with NaN");
            assert_eq!(gait.pose(f32::INFINITY), slowest, "{gait:?} with +inf");
            assert_eq!(gait.pose(f32::NEG_INFINITY), slowest, "{gait:?} with -inf");
            if gait.is_motion() {
                assert_ne!(slowest, gait.pose(1.0), "{gait:?} speed must matter");
            } else {
                // Arm/estop carry no pose at all — there is nothing for speed to scale.
                assert_eq!(slowest, [0; JOINTS], "{gait:?} carries no pose");
            }
            // A finite out-of-range speed clamps to an end (documented; `parse_command` is
            // where a bad speed is actually refused).
            assert_eq!(gait.pose(-1.0), gait.pose(0.0), "{gait:?} below range");
            assert_eq!(gait.pose(2.0), gait.pose(1.0), "{gait:?} above range");
        }
    }

    #[test]
    fn the_pose_table_and_the_joint_range_are_one_thing() {
        // The compile-time assertion in this module (`const _: () = assert!(...)`) is the
        // gate; this is the runtime witness that the two constants really do describe one
        // quadruped: a pose row has exactly one value per joint, and every joint index in
        // the range is addressable.
        for gait in Gait::ALL {
            let pose = gait.pose(0.5);
            assert_eq!(pose.len(), JOINTS);
            assert_eq!(usize::from(MAX_JOINT) + 1, JOINTS);
            assert!(JointId::new(MAX_JOINT).is_ok(), "the last joint exists");
            assert!(JointId::new(MAX_JOINT + 1).is_err(), "and it is the last");
        }
    }

    #[test]
    fn gait_keys_round_trip_and_are_forgiving() {
        for g in Gait::ALL {
            assert_eq!(Gait::from_key(g.key()), Some(g));
        }
        assert_eq!(Gait::from_key("TROT"), Some(Gait::Trot));
        assert_eq!(Gait::from_key(" e-stop "), Some(Gait::Estop));
        assert_eq!(Gait::from_key("gallop"), None);
        assert!(Gait::Estop.is_emergency());
        assert!(!Gait::Stand.is_emergency());
    }

    #[test]
    fn frames_encode_and_decode_with_a_checked_crc() {
        let f = MotorFrame::new(JointId(3), MotorOp::SetPosition, 1500);
        let bytes = f.encode();
        assert_eq!(bytes.len(), FRAME_LEN);
        assert_eq!(&bytes[..2], &FRAME_SOF);
        assert_eq!(bytes[2], 3);
        assert_eq!(bytes[3], MotorOp::SetPosition.code());
        assert_eq!(MotorFrame::decode(&bytes).expect("decode"), f);
        assert_eq!(f.encode_hex(), to_hex(&bytes));
        assert_eq!(f.encode_hex().len(), FRAME_LEN * 2);

        // A single flipped bit is caught (the point of the CRC).
        let mut bad = bytes;
        bad[6] ^= 0x01;
        assert!(MotorFrame::decode(&bad).is_err());
        // As is a foreign opcode and a wrong length.
        let mut bad_op = bytes;
        bad_op[3] = 0x7f;
        let crc = crc16_ccitt(&bad_op[..8]);
        bad_op[8..10].copy_from_slice(&crc.to_le_bytes());
        assert!(MotorFrame::decode(&bad_op).is_err());
        assert!(MotorFrame::decode(&bytes[..4]).is_err());
    }

    #[test]
    fn crc16_matches_the_ccitt_known_answer() {
        // The classic CCITT-FALSE check value for "123456789" is 0x29B1.
        assert_eq!(crc16_ccitt(b"123456789"), 0x29B1);
        assert_eq!(crc16_ccitt(&[]), 0xFFFF);
    }

    #[test]
    fn agent_json_is_validated_not_trusted() {
        let ok = parse_command(r#"{"action":"trot","speed":0.25,"duration_ms":800}"#).expect("ok");
        assert_eq!(ok.gait, Gait::Trot);
        assert_eq!(ok.speed, 0.25);
        assert_eq!(ok.duration_ms, 800);
        assert!(ok.targets.is_empty());

        // Unknown fields are ignored (forward compatible), defaults applied.
        let defaulted = parse_command(r#"{"action":"stand","mood":"happy"}"#).expect("ok");
        assert_eq!(defaulted.speed, 0.5);
        assert_eq!(defaulted.duration_ms, 0);

        // `deg` is accepted for an agent that thinks in degrees.
        let degs =
            parse_command(r#"{"action":"stand","targets":[{"joint":1,"deg":-12.5}]}"#).expect("ok");
        assert_eq!(degs.targets[0].milli_deg, -12_500);

        // Refusals are named.
        assert!(parse_command("not json").is_err());
        assert!(parse_command(r#"{"action":"gallop"}"#).is_err());
        assert!(parse_command(r#"{"action":"trot","speed":2}"#).is_err());
        assert!(parse_command(r#"{"action":"trot","targets":[{"joint":99,"deg":0}]}"#).is_err());
        assert!(parse_command(r#"{"action":"trot","targets":[{"joint":1}]}"#).is_err());
        assert!(parse_command(r#"{"action":"trot","targets":[{"joint":1,"deg":200}]}"#).is_err());

        // The halt path is never refused for a cosmetic reason.
        let stop = parse_command(r#"{"action":"estop","speed":9}"#).expect("estop wins");
        assert_eq!(stop.gait, Gait::Estop);
        assert!(stop.targets.is_empty());
    }

    #[test]
    fn planning_produces_an_enable_then_one_frame_per_joint() {
        let cmd = parse_command(r#"{"action":"trot","speed":0.5}"#).expect("cmd");
        let frames = plan(&cmd);
        assert_eq!(frames.len(), JOINTS + 1);
        assert_eq!(frames[0].op, MotorOp::Enable);
        assert_eq!(frames[1].joint, JointId(0));
        assert_eq!(frames[1].op, MotorOp::SetPosition);
        assert_eq!(frames[JOINTS].joint, JointId(MAX_JOINT));
        // Every joint is addressed exactly once by a position frame.
        let mut positions: Vec<u8> = frames
            .iter()
            .filter(|f| f.op == MotorOp::SetPosition)
            .map(|f| f.joint.0)
            .collect();
        positions.sort_unstable();
        assert_eq!(positions, (0..=MAX_JOINT).collect::<Vec<u8>>());

        // A faster gait moves the knees further than a slow one.
        let slow = Gait::Trot.pose(0.0);
        let fast = Gait::Trot.pose(1.0);
        assert!(fast[2].abs() > slow[2].abs());

        // An explicit target overrides the pose for that joint only.
        let overridden =
            parse_command(r#"{"action":"trot","targets":[{"joint":5,"milli_deg":1234}]}"#)
                .expect("cmd");
        let frames = plan(&overridden);
        assert_eq!(frames[6].arg, 1234, "joint 5 is the 6th position frame");
        assert_ne!(frames[7].arg, 1234, "the other joints keep the pose");

        // Estop is a torque cut on every joint, never a pose.
        let stop = plan(&parse_command(r#"{"action":"estop"}"#).expect("cmd"));
        assert_eq!(stop.len(), JOINTS);
        assert!(stop.iter().all(|f| f.op == MotorOp::Estop));
    }

    #[tokio::test]
    async fn the_mock_hal_records_drives_and_halts() {
        let hal = MockRobotHal::new();
        assert_eq!(hal.name(), "mock");
        assert!(!hal.armed());

        let cmd = parse_command(r#"{"action":"trot","speed":1.0}"#).expect("cmd");
        let frames = plan(&cmd);
        assert_eq!(hal.apply(&frames).await.expect("apply"), frames.len());
        assert_eq!(hal.applied() as usize, frames.len());
        assert!(hal.armed(), "Enable energizes the drivers");
        assert_eq!(hal.frames().len(), frames.len());
        assert_eq!(hal.hex_log().len(), frames.len());

        // The e-stop path cuts torque on every joint and disarms — and it **reports** how
        // many frames it wrote (the bridge's actuation report carries this number).
        let cut = hal.estop().await.expect("estop");
        assert_eq!(cut, JOINTS, "one cut frame per joint, measured");
        assert!(!hal.armed());
        // An e-stop frame per joint, and no `Enable` (it must never re-arm).
        assert_eq!(hal.frames().len(), frames.len() + JOINTS);
        assert_eq!(hal.frames().last().expect("frame").op, MotorOp::Estop);

        // `clear` forgets the log but not the counters.
        let before = hal.applied();
        hal.clear();
        assert!(hal.frames().is_empty());
        assert_eq!(hal.applied(), before);
    }
    #[tokio::test]
    async fn the_mock_hal_answers_the_armed_question_from_the_wire_order() {
        // The defect this pins (found while threading a real bus through the same helper):
        // the flag was computed by two `any()` passes, so a batch that **ended** with
        // `Enable` reported `armed: false` as soon as it mentioned an `Estop` anywhere —
        // exactly the state that decides whether the next movement command is allowed, and
        // exactly the value the bridge publishes as a measurement.
        let hal = MockRobotHal::new();
        let enable = MotorFrame::new(JointId::new(0).expect("joint"), MotorOp::Enable, 0);
        let estop = MotorFrame::new(JointId::new(1).expect("joint"), MotorOp::Estop, 0);

        hal.apply(&[enable, estop]).await.expect("apply");
        assert!(!hal.armed(), "the last op was a torque cut");

        hal.apply(&[estop, enable])
            .await
            .expect("a re-arm after a cut is one batch");
        assert!(hal.armed(), "the last op was Enable");

        // A position frame carries no arming meaning: it must not flip the state either way.
        let position =
            MotorFrame::new(JointId::new(2).expect("joint"), MotorOp::SetPosition, 1_000);
        hal.apply(&[position]).await.expect("apply");
        assert!(hal.armed(), "a set point is not an arming op");

        // And the same rule across batches: the state is carried, not recomputed.
        hal.apply(&[estop]).await.expect("apply");
        assert!(!hal.armed());
        hal.apply(&[position]).await.expect("apply");
        assert!(!hal.armed(), "a cut is not undone by a set point");
    }

    #[tokio::test]
    async fn execute_translates_an_agent_action_onto_the_bus() {
        let hal = MockRobotHal::new();
        let action = AgentAction::new(r#"{"action":"walk","speed":0.3}"#);
        let sent = execute(&hal, &action).await.expect("execute");
        assert_eq!(sent.len(), JOINTS + 1);
        assert_eq!(action.parse().expect("parse").gait, Gait::Walk);

        // A refusal never touches the bus.
        let before = hal.applied();
        let bad = AgentAction::new(r#"{"action":"teleport"}"#);
        assert!(execute(&hal, &bad).await.is_err());
        assert_eq!(hal.applied(), before, "no frame was sent for a bad action");
    }

    #[tokio::test]
    async fn the_bridge_drives_the_bus_from_the_control_channel() {
        use crate::discovery::{NodeKind, PeerId};
        use crate::keyexpr::{Channel, Topic};
        use crate::node::LinkNode;
        use crate::qos::Qos;

        let node = LinkNode::in_process(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        let subscriber = node
            .subscriber::<AgentAction>(
                Topic::pattern("amos/dog1/control/*").expect("pattern"),
                Qos::control(),
            )
            .await
            .expect("subscribe");
        let mut bridge = RobotBridge::new(subscriber, MockRobotHal::new());
        assert_eq!(bridge.hal().name(), "mock");

        let publisher = node.publisher::<AgentAction>(
            Topic::channel_topic("dog1", Channel::Control, "action").expect("topic"),
        );
        publisher
            .publish(&AgentAction::new(r#"{"action":"sit","speed":0.4}"#))
            .await
            .expect("publish");

        let got = bridge.step().await.expect("step");
        assert_eq!(
            got,
            BridgeEvent::Applied {
                seq: 1,
                frames: JOINTS + 1,
                armed: true
            }
        );
        assert!(!bridge.is_estopped());
        assert_eq!(bridge.watchdog(), None);
        assert_eq!(bridge.hal().frames().len(), JOINTS + 1);
        assert!(bridge.hal().armed());
    }

    /// The deadman: silence longer than the watchdog period cuts torque by itself.
    #[tokio::test]
    async fn the_watchdog_stops_a_robot_whose_link_went_quiet() {
        use crate::discovery::{NodeKind, PeerId};
        use crate::keyexpr::{Channel, Topic};
        use crate::node::LinkNode;
        use crate::qos::Qos;

        let node = LinkNode::in_process(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        let subscriber = node
            .subscriber::<AgentAction>(
                Topic::pattern("amos/dog1/control/*").expect("pattern"),
                Qos::control(),
            )
            .await
            .expect("subscribe");
        let mut bridge =
            RobotBridge::with_watchdog(subscriber, MockRobotHal::new(), Duration::from_millis(50));
        assert_eq!(bridge.watchdog(), Some(Duration::from_millis(50)));

        let commander = node.publisher::<AgentAction>(
            Topic::channel_topic("dog1", Channel::Control, "action").expect("topic"),
        );
        commander
            .publish(&AgentAction::new(r#"{"action":"trot","speed":0.5}"#))
            .await
            .expect("publish");
        assert_eq!(
            bridge.step().await.expect("step"),
            BridgeEvent::Applied {
                seq: 1,
                frames: JOINTS + 1,
                armed: true
            }
        );
        assert!(bridge.hal().armed());

        // ...and then the link goes quiet: the next step trips the deadman.
        let frames_before = bridge.hal().frames().len();
        assert_eq!(
            bridge.step().await.expect("watchdog"),
            BridgeEvent::Estopped {
                reason: EstopReason::Watchdog,
                frames: JOINTS
            }
        );
        assert!(!bridge.hal().armed(), "the watchdog cut torque");
        assert!(
            bridge.is_estopped(),
            "a watchdog stop latches like any other"
        );
        assert_eq!(
            bridge.hal().frames().len(),
            frames_before + JOINTS,
            "one e-stop frame per joint reached the bus"
        );

        // A motion command that arrives *after* the trip is still refused.
        commander
            .publish(&AgentAction::new(r#"{"action":"trot"}"#))
            .await
            .expect("publish");
        assert!(matches!(
            bridge.step().await.expect("step"),
            BridgeEvent::Refused { .. }
        ));
        // ...and `arm` puts it back in service.
        commander
            .publish(&AgentAction::new(r#"{"action":"rearm"}"#))
            .await
            .expect("publish arm");
        assert_eq!(
            bridge.step().await.expect("arm"),
            BridgeEvent::Applied {
                seq: 3,
                frames: JOINTS,
                armed: true
            }
        );
        assert!(!bridge.is_estopped());
    }

    /// A HAL whose torque cut is **one** frame (a bus broadcast), the shape a real driver
    /// has. It exists to pin that a report carries what the bus took, not what the bridge
    /// assumed: `estop` used to return `()` and the watchdog path reported `JOINTS`.
    #[derive(Debug, Default)]
    struct BroadcastCutHal {
        log: std::sync::Mutex<Vec<MotorFrame>>,
        armed: AtomicBool,
    }

    impl BroadcastCutHal {
        fn written(&self) -> usize {
            self.log.lock().map(|l| l.len()).unwrap_or(0)
        }
    }

    #[async_trait]
    impl RobotHal for BroadcastCutHal {
        async fn apply(&self, frames: &[MotorFrame]) -> Result<usize> {
            for frame in frames {
                frame.validate()?;
            }
            if let Ok(mut log) = self.log.lock() {
                log.extend_from_slice(frames);
            }
            if frames.iter().any(|f| f.op == MotorOp::Enable) {
                self.armed.store(true, Ordering::SeqCst);
            }
            if frames
                .iter()
                .any(|f| matches!(f.op, MotorOp::Disable | MotorOp::Estop))
            {
                self.armed.store(false, Ordering::SeqCst);
            }
            Ok(frames.len())
        }

        async fn estop(&self) -> Result<usize> {
            // One cut frame on the bus, and the count says so.
            if let Ok(mut log) = self.log.lock() {
                log.push(MotorFrame::new(JointId(0), MotorOp::Estop, 0));
            }
            self.armed.store(false, Ordering::SeqCst);
            Ok(1)
        }

        fn armed(&self) -> bool {
            self.armed.load(Ordering::SeqCst)
        }

        fn name(&self) -> &'static str {
            "broadcast-cut"
        }
    }

    #[tokio::test]
    async fn an_absurd_watchdog_period_saturates_instead_of_wrapping() {
        // `watchdog_ms` travels on the wire (`proto/robot_link.proto`) as a `u64` and comes
        // from `Duration::as_millis()` (a `u128`): `as u64` would wrap a period above ~584
        // million years into a *small* number, i.e. report a deadman far shorter than the
        // configured one. Saturation says "more than this field can express" instead.
        use crate::discovery::{NodeKind, PeerId};
        use crate::keyexpr::Topic;
        use crate::node::LinkNode;
        use crate::qos::Qos;

        let node = LinkNode::in_process(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        let pattern = Topic::pattern("amos/dog1/control/*").expect("pattern");

        let absurd = RobotBridge::with_watchdog(
            node.subscriber::<AgentAction>(pattern.clone(), Qos::control())
                .await
                .expect("subscribe"),
            MockRobotHal::new(),
            Duration::from_secs(u64::MAX),
        );
        assert_eq!(absurd.state().watchdog_ms, Some(u64::MAX));

        // …and an ordinary period is reported verbatim (the saturation never fires early).
        let ordinary = RobotBridge::with_watchdog(
            node.subscriber::<AgentAction>(pattern, Qos::control())
                .await
                .expect("subscribe"),
            MockRobotHal::new(),
            Duration::from_millis(1500),
        );
        assert_eq!(ordinary.state().watchdog_ms, Some(1500));
    }

    /// The watchdog's report must carry a **measured** frame count.
    #[tokio::test]
    async fn a_watchdog_cut_reports_the_frames_the_bus_took_not_a_guess() {
        use crate::discovery::{NodeKind, PeerId};
        use crate::keyexpr::Topic;
        use crate::node::LinkNode;
        use crate::qos::Qos;

        let node = LinkNode::in_process(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        let subscriber = node
            .subscriber::<AgentAction>(
                Topic::pattern("amos/dog1/control/*").expect("pattern"),
                Qos::control(),
            )
            .await
            .expect("subscribe");
        // A HAL that cuts torque in one frame: silence trips the deadman immediately.
        let mut bridge = RobotBridge::with_watchdog(
            subscriber,
            BroadcastCutHal::default(),
            Duration::from_millis(30),
        );

        assert_eq!(
            bridge.step().await.expect("watchdog"),
            BridgeEvent::Estopped {
                reason: EstopReason::Watchdog,
                frames: 1,
            },
            "the report says how many frames the bus really took"
        );
        assert_eq!(bridge.hal().written(), 1, "…and exactly one was written");
        assert_eq!(bridge.state().frames, 0, "no action was acted on");
        assert!(bridge.state().estopped);
    }

    /// A malformed action is *refused*, not an error, and never reaches the bus.
    #[tokio::test]
    async fn a_malformed_action_is_refused_without_touching_the_bus() {
        use crate::discovery::{NodeKind, PeerId};
        use crate::keyexpr::{Channel, Topic};
        use crate::node::LinkNode;
        use crate::qos::Qos;

        let node = LinkNode::in_process(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        let subscriber = node
            .subscriber::<AgentAction>(
                Topic::pattern("amos/dog1/control/*").expect("pattern"),
                Qos::control(),
            )
            .await
            .expect("subscribe");
        let mut bridge = RobotBridge::new(subscriber, MockRobotHal::new());
        let commander = node.publisher::<AgentAction>(
            Topic::channel_topic("dog1", Channel::Control, "action").expect("topic"),
        );
        commander
            .publish(&AgentAction::new("this is not json"))
            .await
            .expect("publish");
        match bridge.step().await.expect("step") {
            BridgeEvent::Refused { reason, .. } => assert!(reason.contains("JSON"), "{reason}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert_eq!(bridge.hal().applied(), 0, "nothing reached the bus");
        assert!(!bridge.is_estopped(), "a typo is not an e-stop");
    }

    #[test]
    fn arm_energizes_every_joint_without_commanding_motion() {
        let cmd = parse_command(r#"{"action":"arm"}"#).expect("arm");
        assert!(cmd.gait.is_arm());
        assert!(!cmd.gait.is_motion(), "arm is not a motion gait");
        assert_eq!(cmd.targets.len(), 0, "targets are dropped on arm");
        let frames = plan(&cmd);
        assert_eq!(frames.len(), JOINTS);
        assert!(frames.iter().all(|f| f.op == MotorOp::Enable));
        assert!(
            !frames.iter().any(|f| f.op == MotorOp::SetPosition),
            "arming must not command a pose"
        );
        // Aliases an agent might emit.
        assert_eq!(Gait::from_key("re-arm"), Some(Gait::Arm));
        assert_eq!(Gait::from_key("enable"), Some(Gait::Arm));
        assert_eq!(Gait::Arm.key(), "arm");
        assert_eq!(EstopReason::Commanded.key(), "commanded");
        assert_eq!(EstopReason::Watchdog.key(), "watchdog");
    }

    /// The report topic is a **`state` channel** topic: latest-wins, so a brain that joins
    /// late learns the robot's real mode without replaying a command history.
    #[test]
    fn the_report_topic_is_a_state_channel_topic() {
        let peer = crate::discovery::PeerId::new("dog1").expect("peer");
        let topic = actuation_topic(&peer).expect("topic");
        assert_eq!(topic.as_str(), "amos/dog1/state/actuation");
        assert_eq!(topic.channel(), Some(Channel::State));
        assert_eq!(
            crate::qos::Qos::for_channel(Channel::State),
            crate::qos::Qos::state()
        );
        // An id that cannot be a topic segment is refused, never silently mangled.
        assert!(crate::discovery::PeerId::new("bad peer").is_err());
    }

    /// A bridge with no reporter still answers honestly about itself.
    #[tokio::test]
    async fn state_is_answerable_without_a_reporter() {
        use crate::discovery::{NodeKind, PeerId};
        use crate::keyexpr::Topic;
        use crate::node::LinkNode;
        use crate::qos::Qos;

        let node = LinkNode::in_process(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        let subscriber = node
            .subscriber::<AgentAction>(
                Topic::pattern("amos/dog1/control/*").expect("pattern"),
                Qos::control(),
            )
            .await
            .expect("subscribe");
        let mut bridge = RobotBridge::new(subscriber, MockRobotHal::new());

        // Nothing has happened yet: no action, drivers down, no e-stop.
        let idle = bridge.state();
        assert_eq!(idle.seq, None);
        assert_eq!(idle.gait, None);
        assert!(!idle.armed);
        assert!(!idle.estopped);
        assert_eq!(idle.watchdog_ms, None);

        // After one action the same method describes what the bus actually did.
        node.publisher::<AgentAction>(
            Topic::channel_topic("dog1", Channel::Control, "action").expect("topic"),
        )
        .publish(&AgentAction::new(r#"{"action":"stand"}"#))
        .await
        .expect("publish");
        bridge.step().await.expect("step");
        let moved = bridge.state();
        assert_eq!(moved.seq, Some(1));
        assert_eq!(moved.gait, Some(Gait::Stand));
        assert!(moved.armed, "the bus reports energized drivers");
        assert_eq!(moved.frames, JOINTS + 1);
    }

    /// The return path: mode changes are reported, per-command churn is not.
    #[tokio::test]
    async fn the_return_path_reports_mode_changes_not_every_command() {
        use crate::discovery::{NodeKind, PeerId};
        use crate::keyexpr::Topic;
        use crate::node::LinkNode;
        use crate::qos::Qos;

        let node = LinkNode::in_process(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        let control = node
            .subscriber::<AgentAction>(
                Topic::pattern("amos/dog1/control/*").expect("pattern"),
                Qos::control(),
            )
            .await
            .expect("subscribe");
        // The commander's view of the robot.
        let mut reports = node
            .subscriber::<ActuationState>(
                Topic::pattern("amos/*/state/actuation").expect("pattern"),
                Qos::for_channel(Channel::State),
            )
            .await
            .expect("subscribe");
        let me = PeerId::new("dog1").expect("peer");
        // `Duration::ZERO`: report on change only, so this test pins that an unchanged mode
        // spends no frame (the refresh interval is covered by
        // `a_late_subscriber_still_learns_the_current_mode`).
        let mut bridge = RobotBridge::new(control, MockRobotHal::new())
            .reporting(node.publisher::<ActuationState>(actuation_topic(&me).expect("topic")))
            .with_report_refresh(Duration::ZERO);
        let commander = node.publisher::<AgentAction>(
            Topic::channel_topic("dog1", Channel::Control, "action").expect("topic"),
        );

        // 1. `arm`: drivers up, no motion — a mode change, so it is reported.
        commander
            .publish(&AgentAction::new(r#"{"action":"arm"}"#))
            .await
            .expect("publish");
        bridge.step().await.expect("step");
        let first = reports.recv().await.expect("a report").message;
        assert!(first.armed);
        assert!(!first.estopped);
        assert_eq!(first.gait, Some(Gait::Arm));
        assert_eq!(first.estop_reason, None);
        assert_eq!(first.last_refusal, None);
        assert_eq!(first.watchdog_ms, None);

        // 2. `trot`: a different gait ⇒ one report, carrying the command's own numbers.
        commander
            .publish(&AgentAction::new(r#"{"action":"trot","speed":0.5}"#))
            .await
            .expect("publish");
        bridge.step().await.expect("step");
        let second = reports.recv().await.expect("a report").message;
        assert_eq!(second.gait, Some(Gait::Trot));
        assert_eq!(second.seq, Some(2));
        assert_eq!(second.frames, JOINTS + 1);

        // 3. The **same** gait again: the mode is unchanged, so no frame is spent on it —
        //    a 50 Hz control stream must not become 50 state frames per second.
        commander
            .publish(&AgentAction::new(r#"{"action":"trot","speed":0.9}"#))
            .await
            .expect("publish");
        bridge.step().await.expect("step");
        assert!(
            reports.try_recv().expect("try_recv").is_none(),
            "an unchanged mode is not republished"
        );

        // 4. `estop`: torque is cut and latched ⇒ reported, with the reason.
        commander
            .publish(&AgentAction::new(r#"{"action":"estop"}"#))
            .await
            .expect("publish");
        bridge.step().await.expect("step");
        let third = reports.recv().await.expect("a report").message;
        assert!(third.estopped);
        assert!(!third.armed, "the bus de-energizes on an e-stop");
        assert_eq!(third.estop_reason, Some(EstopReason::Commanded));

        // 5. Motion while latched: refused — and the commander learns *that*, not silence.
        commander
            .publish(&AgentAction::new(r#"{"action":"trot"}"#))
            .await
            .expect("publish");
        assert!(matches!(
            bridge.step().await.expect("step"),
            BridgeEvent::Refused { .. }
        ));
        let fourth = reports.recv().await.expect("a report").message;
        assert!(fourth.estopped, "still latched");
        assert_eq!(fourth.last_refusal.as_ref().map(|r| r.seq), Some(5));
        assert!(
            fourth
                .last_refusal
                .as_ref()
                .expect("refusal")
                .reason
                .contains("re-arm"),
            "the reason names how to recover"
        );
    }

    /// A malformed action is refused **and reported**: the agent that wrote it is the one
    /// that needs to know.
    #[tokio::test]
    async fn a_refused_action_is_reported_with_its_reason() {
        use crate::discovery::{NodeKind, PeerId};
        use crate::keyexpr::Topic;
        use crate::node::LinkNode;
        use crate::qos::Qos;

        let node = LinkNode::in_process(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        let control = node
            .subscriber::<AgentAction>(
                Topic::pattern("amos/dog1/control/*").expect("pattern"),
                Qos::control(),
            )
            .await
            .expect("subscribe");
        let mut reports = node
            .subscriber::<ActuationState>(
                Topic::pattern("amos/*/state/actuation").expect("pattern"),
                Qos::for_channel(Channel::State),
            )
            .await
            .expect("subscribe");
        let me = PeerId::new("dog1").expect("peer");
        let mut bridge = RobotBridge::new(control, MockRobotHal::new())
            .reporting(node.publisher::<ActuationState>(actuation_topic(&me).expect("topic")));

        node.publisher::<AgentAction>(
            Topic::channel_topic("dog1", Channel::Control, "action").expect("topic"),
        )
        .publish(&AgentAction::new(r#"{"action":"teleport"}"#))
        .await
        .expect("publish");
        assert!(matches!(
            bridge.step().await.expect("step"),
            BridgeEvent::Refused { .. }
        ));
        let report = reports.recv().await.expect("a report").message;
        assert_eq!(report.last_refusal.as_ref().map(|r| r.seq), Some(1));
        assert!(!report.armed, "a refused action never armed anything");
        assert_eq!(report.gait, None, "and it did not become the current gait");
    }

    /// The case the return path exists for: a **watchdog torque cut** is invisible to the
    /// peer whose link just died, unless the robot says so.
    #[tokio::test]
    async fn a_watchdog_torque_cut_is_reported_to_the_commander() {
        use crate::discovery::{NodeKind, PeerId};
        use crate::keyexpr::Topic;
        use crate::node::LinkNode;
        use crate::qos::Qos;

        let node = LinkNode::in_process(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        let control = node
            .subscriber::<AgentAction>(
                Topic::pattern("amos/dog1/control/*").expect("pattern"),
                Qos::control(),
            )
            .await
            .expect("subscribe");
        let mut reports = node
            .subscriber::<ActuationState>(
                Topic::pattern("amos/*/state/actuation").expect("pattern"),
                Qos::for_channel(Channel::State),
            )
            .await
            .expect("subscribe");
        let me = PeerId::new("dog1").expect("peer");
        let mut bridge =
            RobotBridge::with_watchdog(control, MockRobotHal::new(), Duration::from_millis(30))
                .reporting(node.publisher::<ActuationState>(actuation_topic(&me).expect("topic")));
        let commander = node.publisher::<AgentAction>(
            Topic::channel_topic("dog1", Channel::Control, "action").expect("topic"),
        );

        // Armed first, so the report that follows is unambiguously the trip.
        commander
            .publish(&AgentAction::new(r#"{"action":"arm"}"#))
            .await
            .expect("publish");
        bridge.step().await.expect("step");
        assert!(reports.recv().await.expect("armed report").message.armed);

        // Now the link goes quiet and the deadman fires.
        assert_eq!(
            bridge.step().await.expect("step"),
            BridgeEvent::Estopped {
                reason: EstopReason::Watchdog,
                frames: JOINTS,
            }
        );
        let report = reports.recv().await.expect("watchdog report").message;
        assert!(report.estopped, "the commander learns torque was cut");
        assert_eq!(report.estop_reason, Some(EstopReason::Watchdog));
        assert!(!report.armed);
        assert_eq!(
            report.watchdog_ms,
            Some(30),
            "the report carries the deadman period it was configured with"
        );
    }

    /// A **late** subscriber must still learn the current mode.
    ///
    /// This is the gap the on-change-only design left: the broker has **no retention and no
    /// replay** (a subscription is registered, nothing is replayed), so a brain — or the
    /// daemon's control plane — that subscribes *after* the robot armed sees nothing until
    /// the next *transition*. A robot that is steadily trotting has no next transition, so
    /// "what is it doing?" would stay unanswered forever. The bridge therefore re-announces
    /// the unchanged mode once per refresh interval, riding the control loop's own cadence.
    #[tokio::test]
    async fn a_late_subscriber_still_learns_the_current_mode() {
        use crate::discovery::{NodeKind, PeerId};
        use crate::keyexpr::Topic;
        use crate::node::LinkNode;
        use crate::qos::Qos;

        let node = LinkNode::in_process(PeerId::new("dog1").expect("peer"), NodeKind::Robot);
        let control = node
            .subscriber::<AgentAction>(
                Topic::pattern("amos/dog1/control/*").expect("pattern"),
                Qos::control(),
            )
            .await
            .expect("subscribe");
        let me = PeerId::new("dog1").expect("peer");
        // A short refresh so the test does not sleep for the production interval.
        let mut bridge = RobotBridge::new(control, MockRobotHal::new())
            .reporting(node.publisher::<ActuationState>(actuation_topic(&me).expect("topic")))
            .with_report_refresh(Duration::from_millis(20));
        let commander = node.publisher::<AgentAction>(
            Topic::channel_topic("dog1", Channel::Control, "action").expect("topic"),
        );

        // The robot starts trotting **before** anyone is listening.
        commander
            .publish(&AgentAction::new(r#"{"action":"trot","speed":0.5}"#))
            .await
            .expect("publish");
        bridge.step().await.expect("step");

        // …and only now does the brain (or the daemon) subscribe.
        let mut late = node
            .subscriber::<ActuationState>(
                Topic::pattern("amos/*/state/actuation").expect("pattern"),
                Qos::for_channel(Channel::State),
            )
            .await
            .expect("subscribe");

        // The robot keeps trotting at the same mode: the next step re-announces it, so the
        // late subscriber learns the *current* mode without waiting for a transition.
        commander
            .publish(&AgentAction::new(r#"{"action":"trot","speed":0.5}"#))
            .await
            .expect("publish");
        tokio::time::sleep(Duration::from_millis(40)).await;
        bridge.step().await.expect("step");

        let report = tokio::time::timeout(Duration::from_millis(200), late.recv())
            .await
            .expect("a late subscriber is told the current mode")
            .expect("recv");
        assert_eq!(report.message.gait, Some(Gait::Trot));
        assert!(report.message.armed);
        assert!(!report.message.estopped);
    }
}
