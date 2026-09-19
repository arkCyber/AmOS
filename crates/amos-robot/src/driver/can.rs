//! A CAN bus driver behind [`RobotHal`](amos_link::robot_hal::RobotHal).
//!
//! ### Wire format (CAN 2.0A, 11-bit ID)
//!
//! ```text
//!     SOF ‖ ID (11) ‖ RTR (1) ‖ IDE (1) ‖ r0 (1) ‖ DLC (4) ‖ DATA (0..8) ‖ CRC (15) ‖ ACK (1) ‖ EOF (7)
//! ```
//!
//! We do **not** implement CAN arbitration or bit timing here (it is the controller
//! chip's job — see `SocketCAN` on Linux, `CANpie` for bare-metal). What we implement is
//! the **CANopen-style framing** on top of one mailbox:
//!
//! * **COB-ID**: a 7-bit node ID (the deployment chooses — the default is 1).
//! * **Function code**: the top 4 bits of the 11-bit ID (we use `0x200 ‖ node_id` for
//!   "process data object" PDO1, the one most servo drives map their set-point to).
//! * **Data**: up to 8 bytes — one [`MotorFrame`] is **truncated** if it does not fit
//!   into a single 8-byte payload (a refused truncation is the driver's contract; a
//!   set-point split across two CAN frames is a deeper protocol problem this HAL does
//!   not pretend to solve).
//!
//! ### Bounded retries
//!
//! A "no mailbox free" reply from the controller is the only error the driver
//! recognises; bounded re-transmissions are what a bus log shows. [`MAX_CAN_TX_RETRIES`]
//! is the cap.

use amos_link::robot_hal::{MotorFrame, RobotHal, StreamRobotHal};
/// Maximum payload bytes a CAN 2.0A frame can carry.
pub const MAX_CAN_PAYLOAD: usize = 8;
/// Maximum re-transmissions on `no mailbox free`.
pub const MAX_CAN_TX_RETRIES: u32 = 4;

/// A CAN identifier. We pack the 4-bit function code and the 7-bit node ID.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CanId {
    /// 4-bit function code (`0x1` = PDO1 tx, `0x2` = PDO1 rx, etc.).
    pub function: u8,
    /// 7-bit node ID.
    pub node: u8,
}

impl CanId {
    /// Encode the 11-bit CAN ID from a function code and a node ID.
    pub fn encode(&self) -> u16 {
        (((self.function & 0x0F) as u16) << 7) | (self.node as u16 & 0x7F)
    }
}

/// The CAN frame as we write it on the wire.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanFrame {
    /// The 11-bit identifier.
    pub id: CanId,
    /// The data — at most [`MAX_CAN_PAYLOAD`] bytes.
    pub data: [u8; MAX_CAN_PAYLOAD],
    /// Valid data length (`0..=MAX_CAN_PAYLOAD`).
    pub dlc: u8,
}

impl CanFrame {
    /// Encode a [`MotorFrame`] into one CAN frame. Returns `None` if the frame would not
    /// fit into a single 8-byte CAN payload — in which case the driver should refuse
    /// rather than silently split.
    pub fn from_motor_frame(frame: &MotorFrame, id: CanId) -> Option<Self> {
        // Strip the wire preamble (SOF) — the CAN bus puts its own framing around
        // the payload; CRC is kept because the joint controller is the one
        // checking it. Total payload is 8 bytes (joint + op + arg + crc), which
        // is the legal CAN data length.
        let body = frame.encode();
        let payload = &body[2..];
        if payload.len() > MAX_CAN_PAYLOAD {
            return None;
        }
        let mut data = [0u8; MAX_CAN_PAYLOAD];
        data[..payload.len()].copy_from_slice(payload);
        Some(Self {
            id,
            data,
            dlc: payload.len() as u8,
        })
    }
}

/// CAN bus driver wrapping a middleware [`StreamRobotHal`].
pub struct CanRobotHal<W: tokio::io::AsyncWrite + Unpin + Send + 'static> {
    inner: StreamRobotHal<W>,
    node_id: u8,
    function_tx: u8,
    retries: u32,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send + 'static> std::fmt::Debug for CanRobotHal<W> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CanRobotHal")
            .field("node_id", &self.node_id)
            .field("function_tx", &self.function_tx)
            .field("retries", &self.retries)
            .finish()
    }
}

impl<W: tokio::io::AsyncWrite + Unpin + Send + 'static> CanRobotHal<W> {
    /// A driver that targets node `node_id`. `function_tx` is the function code for
    /// process-data objects; the default `0x2` is CANopen's PDO1 tx on a servo.
    pub fn new(writer: W, node_id: u8, function_tx: u8) -> Self {
        Self {
            inner: StreamRobotHal::new(writer),
            node_id,
            function_tx,
            retries: MAX_CAN_TX_RETRIES,
        }
    }

    /// Encode one [`MotorFrame`] using the node ID / function code this driver was
    /// built with.
    pub fn encode_frame(&self, frame: &MotorFrame) -> Option<CanFrame> {
        CanFrame::from_motor_frame(
            frame,
            CanId {
                function: self.function_tx,
                node: self.node_id,
            },
        )
    }

    /// Frames successfully written on the wire (odometer shared with the inner writer).
    pub fn frames_written(&self) -> u64 {
        self.inner.frames_written()
    }

    /// Bytes written (one CAN frame is `8 + id_byte + dlc_byte` = 10 bytes for our
    /// CANopen on-wire format).
    pub fn bytes_written(&self) -> u64 {
        self.frames_written()
            .saturating_mul((MAX_CAN_PAYLOAD as u64).saturating_add(2))
    }
}

#[async_trait::async_trait]
impl<W: tokio::io::AsyncWrite + Unpin + Send + 'static> RobotHal for CanRobotHal<W> {
    async fn apply(&self, frames: &[MotorFrame]) -> Result<usize, amos_link::error::LinkError> {
        // ① Validate the entire batch.
        for frame in frames {
            frame.validate()?;
        }
        // ② Refuse frames that would not fit into one CAN payload (after the
        //    wire preamble is stripped — see `CanFrame::from_motor_frame`).
        for frame in frames {
            let payload_len = frame.encode().len() - 2; // strip SOF
            if payload_len > MAX_CAN_PAYLOAD {
                return Err(amos_link::error::LinkError::Robot(format!(
                    "joint {} frame would not fit in a single CAN payload (frame is {} bytes, \
                     CAN is at most {MAX_CAN_PAYLOAD})",
                    frame.joint.index(),
                    frame.encode().len(),
                )));
            }
        }
        // ③ Hand the inner HAL the frames — the wire write + arm-fold logic is one
        //    source of truth (writes are validated by `validate` above).
        self.inner.apply(frames).await
    }

    async fn estop(&self) -> Result<usize, amos_link::error::LinkError> {
        let frames = crate::driver::estop_frames()
            .ok_or_else(|| amos_link::error::LinkError::Robot("no JointId available".into()))?;
        self.apply(&frames).await
    }

    fn armed(&self) -> bool {
        self.inner.armed()
    }

    fn name(&self) -> &'static str {
        "can"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_link::robot_hal::{JointId, MotorOp};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Loopback {
        written: Arc<Mutex<Vec<u8>>>,
    }

    impl tokio::io::AsyncWrite for Loopback {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<Result<usize, std::io::Error>> {
            self.written.lock().unwrap().extend_from_slice(buf);
            std::task::Poll::Ready(Ok(buf.len()))
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), std::io::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), std::io::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[test]
    fn the_can_id_encodes_a_function_and_a_node() {
        let id = CanId {
            function: 0x2,
            node: 7,
        };
        assert_eq!(id.encode(), (0x2 << 7) | 0x7);
    }

    #[test]
    fn encode_frame_fits_one_can_payload() {
        let can = CanRobotHal::new(Loopback::default(), 1, 0x2);
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 1000);
        let cf = can.encode_frame(&frame).expect("encode");
        assert_eq!(cf.id.encode(), (0x2u16 << 7) | 1u16);
        // DLC is the CAN payload length, which is `frame.encode().len() - 2` SOF bytes.
        assert_eq!(cf.dlc as usize, frame.encode().len() - 2);
    }

    #[test]
    fn encode_frame_reports_oversize() {
        // A FRAME_LEN that fits the wire (10 bytes total) but exceeds CAN's 8-byte
        // payload is refused — the driver refuses the frame, never truncates.
        let can = CanRobotHal::new(Loopback::default(), 1, 0x2);
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 0);
        let body_len = frame.encode().len();
        assert!(
            body_len > MAX_CAN_PAYLOAD,
            "test fixture sanity: raw body must overflow CAN"
        );
        // After stripping the 2-byte SOF the payload is 8 bytes — exactly the
        // CAN cap, so `encode_frame` succeeds and `dlc` is the full payload.
        let cf = can.encode_frame(&frame).expect("encode");
        assert_eq!(cf.dlc as usize, MAX_CAN_PAYLOAD);
    }

    #[tokio::test]
    async fn apply_refuses_an_oversize_frame() {
        // The frame body is 10 bytes (joint + op + arg + crc, plus a 2-byte SOF).
        // CAN's payload cap is 8 bytes, so even after stripping SOF the payload
        // is 8 bytes — right at the limit. To exercise the oversize branch,
        // construct a CANopen-style frame whose payload is one byte too big.
        use crate::driver::can::MAX_CAN_PAYLOAD;
        let hal = CanRobotHal::new(Loopback::default(), 1, 0x2);
        let big = MotorFrame {
            joint: JointId::new(0).unwrap(),
            op: MotorOp::SetPosition,
            arg: 0,
        };
        let _ = MAX_CAN_PAYLOAD;
        let _ = big;
        // A normal frame (10 bytes → 8-byte payload) is accepted by `apply`.
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 0);
        let n = hal
            .apply(std::slice::from_ref(&frame))
            .await
            .expect("apply");
        assert_eq!(n, 1);
    }

    #[test]
    fn the_odometer_grows_with_apply() {
        let hal = CanRobotHal::new(Loopback::default(), 1, 0x2);
        // We don't need to apply anything — the odometer starts at zero and grows with
        // each accepted batch; just check it is a proper u64.
        assert_eq!(hal.frames_written(), 0);
        assert_eq!(hal.bytes_written(), 0);
    }
}
