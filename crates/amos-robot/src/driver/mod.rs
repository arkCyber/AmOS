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
//! * **UART**: a bare `write` may complete a frame only partially (`Ok(n)`, `n < frame
//!   length`), which a caller that ignores `n` would ship as a truncated frame. The
//!   driver's contract is "no truncated frames ever hit the wire", so the inner
//!   [`StreamRobotHal`](amos_link::robot_hal::StreamRobotHal) writes each frame with
//!   `write_all` — which loops until the frame is whole or returns `Err`, never a short
//!   `Ok`.
//! * **CAN**: a controller reports "no mailbox free" — a transient transport failure, not a
//!   bad command. `can.rs::apply` re-hands the same batch against a bounded counter
//!   ([`MAX_CAN_TX_RETRIES`]), and returns a `Transport` error once the budget is spent. A
//!   refused command (`Robot`) is returned immediately and never retried (see that file's
//!   "Bounded retries" section). We don't implement CANopen, only the arbitration pass.
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
pub use udp::{UdpControlRobotHal, UdpDiscoveryRobotHal, UdpSink, MAX_UDP_DISCOVERY_BYTES};

use amos_link::robot_hal::{JointId, MotorFrame, MotorOp, MAX_JOINT};

/// Build the per-joint Estop frame array: one `Estop` frame per `JointId`, joints
/// `0..=MAX_JOINT` in order. There is **no separate broadcast frame** — index 0 is joint 0,
/// and a bus that ignores the joint byte simply sees every frame.
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

#[cfg(test)]
mod tests {
    use super::*;
    use amos_link::robot_hal::JOINTS;

    /// The e-stop batch this crate's drivers share: one `Estop` frame per joint, addressed
    /// `0..=MAX_JOINT` in order, each with argument `0`, plus the index-0 entry (which is
    /// joint 0, not a separate broadcast — the doc calls it "plus a broadcast at index 0"
    /// because a bus that ignores the joint byte sees every frame).
    #[test]
    fn estop_frames_cover_every_joint_in_order() {
        let frames = estop_frames().expect("every joint id in 0..=MAX_JOINT is valid");
        assert_eq!(frames.len(), JOINTS);
        for (i, frame) in frames.iter().enumerate() {
            assert_eq!(
                frame.joint.index() as usize,
                i,
                "frame {i} must address joint {i}"
            );
            assert_eq!(frame.op, MotorOp::Estop);
            assert_eq!(frame.arg, 0, "an e-stop carries no set point");
        }
        // The `None` arm is unreachable *by construction*: `MAX_JOINT == JOINTS - 1`, so
        // every index the loop builds is a valid joint. Pinning that here is what makes the
        // `Option` a defensive signature rather than a live error path.
        assert!(JointId::new(MAX_JOINT).is_ok());
    }
}
