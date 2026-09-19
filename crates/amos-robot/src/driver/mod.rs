//! Real motor driver implementations behind the [`RobotHal`](amos_link::robot_hal::RobotHal)
//! trait.
//!
//! This module builds on top of [`amos_link::robot_hal::StreamRobotHal`], the generic
//! stream-wrapper the middleware already ships. The split is by **physical layer**, not by
//! robot:
//!
//! | Submodule | Bus | Latency (typ.) | Use |
//! |---|---|---|---|
//! | [`serial`] | UART (RS-485 / RS-232) | ~1 ms at 1 Mbaud | Single-board servos, MCUs |
//! | [`can`] | CAN 2.0A | ~1 ms at 1 Mbaud | Vehicle ECUs, industrial cells |
//! | [`udp`] | UDP (LAN) | ~0.1 ms | Discovery + control plane, not safety-critical |
//!
//! The **safety path remains in the middleware**: `RobotBridge` is the one place the e-stop
//! latch, the deadman and the refusal logic live. These drivers are *just* the wire — they
//! are written so a bug in the physical layer cannot leak past the bridge.
//!
//! ### Why three drivers instead of one
//!
//! A single `RobotHal::apply` over an abstract `AsyncWrite` is correct on paper. On a
//! vehicle, the **error model** is what defines the safety argument:
//!
//! * **UART**: a single `write_all` returns `Ok(n)` when `n < frame_size` ⇒ truncation;
//!   `Err(_)` ⇒ write retry. The driver's contract is "no truncated frames ever hit
//!   the wire", and that needs `write_all` on each frame.
//! * **CAN**: a controller reports "no mailbox free" — the driver must back off and
//!   re-tx with the CANopen-style retry counter (we don't implement CANopen, only the
//!   arbitration pass).
//! * **UDP**: a `send_to` may silently drop on a full buffer (no ENOBUFS, just a `would
//!   block`); the driver applies a bounded back-off loop.
//!
//! All three wrap around [`amos_link::robot_hal::StreamRobotHal`], which already enforces
//! "validate the whole batch before any byte hits the wire". A reader who only knows the
//! middleware need not read this module to understand the safety argument.

pub mod can;
pub mod serial;
pub mod udp;

pub use can::{CanFrame, CanId, CanRobotHal, MAX_CAN_PAYLOAD, MAX_CAN_TX_RETRIES};
pub use serial::{SerialConfig, SerialRobotHal};
pub use udp::{UdpControlRobotHal, UdpDiscoveryRobotHal, MAX_UDP_DISCOVERY_BYTES};

use amos_link::robot_hal::{JointId, MotorFrame, MotorOp, MAX_JOINT};

/// Build the per-joint Estop frame array (one `Estop` frame per `JointId` plus a
/// broadcast at index 0).
///
/// This is shared by every [`RobotHal`](amos_link::robot_hal::RobotHal) implementation in
/// this crate: the joint IDs are produced via [`JointId::new`] (the only public
/// constructor), so a failed validation bubbles up as `None`. The function exists once
/// in the driver module so the error-handling rule has a single owner.
pub(crate) fn estop_frames() -> Option<Vec<MotorFrame>> {
    let mut frames = Vec::with_capacity((MAX_JOINT as usize).saturating_add(1));
    for i in 0..=MAX_JOINT {
        let Ok(joint) = JointId::new(i) else {
            return None;
        };
        frames.push(MotorFrame::new(joint, MotorOp::Estop, 0));
    }
    Some(frames)
}

/// The shared prelude for tests that need to drive a real bus shape through a mock port.
pub mod prelude {
    pub use super::serial::SerialConfig;
    pub use amos_link::robot_hal::{MotorFrame, MotorOp, StreamRobotHal, FRAME_LEN, FRAME_SOF};
}
