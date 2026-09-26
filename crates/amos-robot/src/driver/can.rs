//! A CAN bus driver behind [`RobotHal`].
//!
//! ### Wire format (CAN 2.0A, 11-bit ID)
//!
//! ```text
//!     SOF ‖ ID (11) ‖ RTR (1) ‖ IDE (1) ‖ r0 (1) ‖ DLC (4) ‖ DATA (0..8) ‖ CRC (15) ‖ ACK (1) ‖ EOF (7)
//! ```
//!
//! We do **not** implement CAN arbitration or bit timing here (it is the controller
//! chip's job — see `SocketCAN` on Linux, `CANpie` for bare-metal).
//!
//! ### What `apply` writes today
//!
//! The live write path writes the raw [`MotorFrame::encode`] bytes to the underlying
//! stream — **not** a CAN bus frame. On a real deployment the byte stream is fed to a
//! CAN controller; the framing above (and everything the rest of this section describes)
//! is the CANopen mapping that controller expects, and it is exercised only by the
//! [`CanFrame`] / [`CanId`] helpers and their tests:
//!
//! * **COB-ID**: the 11-bit identifier is a 4-bit function code in bits 7..10 and a 7-bit
//!   node ID in bits 0..6 ([`CanId::encode`]). CiA 301's *Predefined Connection Set* fixes
//!   the function code per object — RPDO1, the object a servo maps its set-point to (so the
//!   direction this driver writes) is `0x200 + node_id` and therefore function nibble `4`;
//!   its sibling TPDO1 is `0x180 + node_id` (nibble `3`). This crate does **not choose** the
//!   COB-ID: `function_tx` is supplied by the deployment, because CiA 301 (`1800h`/`1400h`
//!   sub-index 1) lets a node's PDO mapping be reconfigured, and a frame sent on the wrong
//!   nibble is one the drive silently ignores.
//! * **Data**: up to 8 bytes. A [`MotorFrame`]'s body is 10 bytes (a 2-byte SOF plus an
//!   8-byte payload), so after stripping the SOF the 8-byte payload fits [`MAX_CAN_PAYLOAD`]
//!   exactly. A frame whose payload exceeds the cap is **refused, never truncated** — a
//!   set-point split across two CAN frames is a deeper protocol problem this HAL does not
//!   pretend to solve.
//!
//! ### Bounded retries
//!
//! [`MAX_CAN_TX_RETRIES`] bounds how many times `apply` re-hands the same batch to the
//! controller on a **transient** failure
//! ([`LinkError::Transport`](amos_link::error::LinkError::Transport)) — the bus wedged or
//! the mailbox full, not a bad command. A refused command
//! ([`LinkError::Robot`](amos_link::error::LinkError::Robot)) is the
//! command's fault: it is returned immediately and never retried. There is no delay
//! between attempts; holding a frame for arbitration is the controller chip's job, and a
//! sleep here would delay the e-stop. Re-sending is safe because every `MotorOp` in this
//! protocol is an absolute set-point or a mode op — a batch that partially landed leaves
//! each joint in the state it already reached.

use amos_link::robot_hal::{MotorFrame, RobotHal, StreamRobotHal, FRAME_LEN};
/// Maximum payload bytes a CAN 2.0A frame can carry.
///
/// // cited: ISO 11898-1 — the classic CAN data field is 0..=8 bytes (CAN FD extends this to
/// 64, which this 2.0A driver does not use).
pub const MAX_CAN_PAYLOAD: usize = 8;
/// Maximum re-transmissions on a transient transport failure (`no mailbox free`).
///
/// // chosen: this is a policy bound, and deliberately **not** a citation — no part of
/// ISO 11898-1 fixes a software retry budget. A CAN controller already retries at the bit
/// level (arbitration and error frames are the hardware's job), and its TX mailboxes are
/// hardware whose depth this crate does not know. `4` re-transmissions caps the worst case
/// at five bus attempts before the driver reports the mailbox wedged; because there is no
/// sleep between attempts (a sleep would delay the e-stop), the cost of the bound is bus
/// traffic, not wall time. A deployment that knows its controller's mailbox depth should
/// read `4` as the ceiling it must stay under, not as a target.
///
/// `retries = 4` therefore means at most `4` re-transmissions, i.e. `5` attempts total.
pub const MAX_CAN_TX_RETRIES: u32 = 4;

/// A CAN identifier. We pack the 4-bit function code and the 7-bit node ID.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CanId {
    /// The 4-bit function code — bits 7..10 of the 11-bit COB-ID. What it *means* is fixed
    /// by the deployment's PDO mapping, not by this crate: CiA 301's predefined connection
    /// set puts RPDO1 at nibble `4` (`0x200 + node_id`) and TPDO1 at nibble `3`
    /// (`0x180 + node_id`). See the module doc.
    pub function: u8,
    /// The 7-bit node ID — bits 0..6 of the 11-bit COB-ID.
    pub node: u8,
}

impl CanId {
    /// Encode the 11-bit CAN ID from a function code and a node ID.
    pub fn encode(&self) -> u16 {
        (((self.function & 0x0F) as u16) << 7) | (self.node as u16 & 0x7F)
    }
}

/// A CAN 2.0A frame in the CANopen mapping this driver documents. Constructed by
/// [`CanFrame::from_motor_frame`] and [`CanRobotHal::encode_frame`] for inspection and
/// tests; `apply` does not emit this type (see the module doc).
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
    ///
    /// That `None` arm is **unreachable for a well-formed [`MotorFrame`]**:
    /// [`MotorFrame::encode`] hands back a fixed `[u8; FRAME_LEN]`, so the payload left
    /// after the 2-byte SOF is always `FRAME_LEN - 2`, and `FRAME_LEN - 2` equals
    /// [`MAX_CAN_PAYLOAD`] today (pinned by `encode_frame_fits_exactly_at_the_can_cap` and
    /// `apply_accepts_a_full_frame_at_the_can_cap`). It is a defensive signature, not a live
    /// error path: it is what keeps the cap a *check* instead of an assumption, so it starts
    /// answering differently the moment `FRAME_LEN` moves. It is deliberately not covered by
    /// a test that fabricates an oversized frame — no such frame is constructible through
    /// this crate's API.
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
    /// A driver that targets node `node_id`, addressing process-data objects with the
    /// 4-bit COB-ID function code `function_tx`.
    ///
    /// There is **no default** for `function_tx` — it is a required argument because the
    /// right nibble is a property of the deployment, not of this crate: CiA 301 lets a node
    /// remap its PDOs, and a frame on the wrong nibble is one the drive silently ignores.
    /// For a servo still on the predefined connection set, the set-point direction is
    /// RPDO1 = `0x200 + node_id`, so pass `0x4`. The tests here pass `0x2` (COB-ID
    /// `0x100 + node_id`), which is **not** a CiA 301 assignment — it is a placeholder that
    /// exists to prove `encode_frame` threads the nibble through, nothing more.
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

    /// Bytes the wire actually carried: [`FRAME_LEN`] per frame, since `apply` writes the
    /// raw `MotorFrame::encode()` bytes.
    ///
    /// Do **not** derive this from the CAN mapping. [`MAX_CAN_PAYLOAD`] plus the 2 stripped
    /// SOF bytes happens to equal `FRAME_LEN` today, but the CAN payload shape is not what
    /// crosses the wire — a driver that counted it would keep reporting a plausible number
    /// after `FRAME_LEN` moved, which is the failure mode this crate counts bytes to
    /// prevent. The serial driver derives the same quantity from `FRAME_LEN`; so does this.
    pub fn bytes_written(&self) -> u64 {
        self.frames_written().saturating_mul(FRAME_LEN as u64)
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
        //    source of truth (writes are validated by `validate` above). Re-transmit a
        //    bounded number of times on a *transient* transport failure only.
        let mut attempt = 0u32;
        loop {
            match self.inner.apply(frames).await {
                Ok(n) => return Ok(n),
                // A `Transport` failure is the bus, not the command: hand the same batch
                // over again, bounded by `self.retries`. This cannot corrupt the machine —
                // every `MotorOp` in this protocol is an absolute set-point or a mode op,
                // so re-sending a batch that partially landed leaves each joint in the
                // state it already reached; the retry only adds bus traffic. There is
                // deliberately no sleep: a sleep here would delay the e-stop, and holding
                // a frame for arbitration is the controller chip's job (module doc).
                Err(amos_link::error::LinkError::Transport(_)) if attempt < self.retries => {
                    attempt += 1;
                }
                // A `Robot` refusal is the command's fault — retrying it cannot help.
                Err(e) => return Err(e),
            }
        }
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
    use amos_link::error::LinkError;
    use amos_link::robot_hal::{JointId, MotorOp, JOINTS};
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

    /// A writer that fails the first `fails_left` frame writes with a transport-shaped
    /// `io::Error` (what [`StreamRobotHal`] maps to [`LinkError::Transport`]), then behaves
    /// like [`Loopback`]. `attempts` counts every frame write the driver attempted,
    /// successful or not.
    struct Flaky {
        written: Arc<Mutex<Vec<u8>>>,
        attempts: Arc<Mutex<u32>>,
        fails_left: Mutex<u32>,
    }

    impl Flaky {
        fn new(fails: u32) -> Self {
            Self {
                written: Arc::new(Mutex::new(Vec::new())),
                attempts: Arc::new(Mutex::new(0)),
                fails_left: Mutex::new(fails),
            }
        }
    }

    impl tokio::io::AsyncWrite for Flaky {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<Result<usize, std::io::Error>> {
            *self.attempts.lock().unwrap() += 1;
            let mut left = self.fails_left.lock().unwrap();
            if *left > 0 {
                *left -= 1;
                return std::task::Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    "no mailbox free",
                )));
            }
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

    /// A transient transport failure within the retry budget must not surface to the
    /// caller, and the batch must land on the wire **exactly once** — a retry is not a
    /// duplicate write.
    #[tokio::test]
    async fn apply_succeeds_after_a_transient_failure_within_the_budget() {
        let sink = Flaky::new(2);
        let attempts = Arc::clone(&sink.attempts);
        let written = Arc::clone(&sink.written);
        let hal = CanRobotHal::new(sink, 1, 0x2);
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 0);
        let n = hal
            .apply(std::slice::from_ref(&frame))
            .await
            .expect("the third attempt is within the budget");
        assert_eq!(n, 1);
        assert_eq!(*attempts.lock().unwrap(), 3, "two failures then success");
        assert_eq!(
            written.lock().unwrap().len(),
            FRAME_LEN,
            "the frame must reach the wire exactly once"
        );
    }

    /// A bus that never accepts a frame must be reported, not spun on: exactly
    /// `MAX_CAN_TX_RETRIES + 1` attempts, then a `Transport` error.
    #[tokio::test]
    async fn apply_gives_up_after_the_bounded_retry_budget() {
        let sink = Flaky::new(u32::MAX);
        let attempts = Arc::clone(&sink.attempts);
        let hal = CanRobotHal::new(sink, 1, 0x2);
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 0);
        match hal.apply(std::slice::from_ref(&frame)).await {
            Err(LinkError::Transport(_)) => {}
            other => panic!("a wedged bus must surface as Transport, got {other:?}"),
        }
        assert_eq!(
            *attempts.lock().unwrap(),
            MAX_CAN_TX_RETRIES + 1,
            "the budget is the initial attempt plus MAX_CAN_TX_RETRIES re-transmissions"
        );
        assert_eq!(hal.frames_written(), 0, "nothing landed");
    }

    /// A refused command is the command's fault: retrying cannot help, so it must be
    /// returned on the first attempt — never re-sent.
    #[tokio::test]
    async fn a_refused_command_is_not_retried() {
        let sink = Flaky::new(0); // the bus is healthy; only the command is bad
        let attempts = Arc::clone(&sink.attempts);
        let hal = CanRobotHal::new(sink, 1, 0x2);
        // SetPosition outside ±90_000 mdeg is refused by `MotorFrame::validate`.
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 90_001);
        match hal.apply(std::slice::from_ref(&frame)).await {
            Err(LinkError::Robot(_)) => {}
            other => panic!("an out-of-range set-point must be refused, got {other:?}"),
        }
        assert_eq!(
            *attempts.lock().unwrap(),
            0,
            "a refused command must never reach the wire"
        );
    }

    #[test]
    fn the_can_id_encodes_a_function_and_a_node() {
        let id = CanId {
            function: 0x2,
            node: 7,
        };
        assert_eq!(id.encode(), (0x2 << 7) | 0x7);
    }

    /// The COB-ID the module doc cites, checked against CiA 301's *Predefined Connection
    /// Set* rather than against this file's own arithmetic: RPDO1 is `0x200 + node_id` (the
    /// object a servo maps its set-point to), so its function nibble is `4`; TPDO1 is
    /// `0x180 + node_id` (nibble `3`). The point is the *nibble*, not the shift — a
    /// deployment that passed `0x20` for "0x200" would put `0x1000` on the wire, which the
    /// previous test cannot catch because it re-derives the expected value from the same
    /// expression `encode` uses.
    #[test]
    fn the_documented_cia301_nibbles_reproduce_their_cob_ids() {
        for node in [1u8, 7, 63, 127] {
            let rpdo1 = CanId {
                function: 0x4,
                node,
            };
            assert_eq!(
                rpdo1.encode(),
                0x200 | u16::from(node),
                "RPDO1 (set-point direction) for node {node}"
            );
        }
        let tpdo1 = CanId {
            function: 0x3,
            node: 7,
        };
        assert_eq!(tpdo1.encode(), 0x180 + 7, "TPDO1 for node 7");

        // The placeholder the tests and `new`'s doc name is deliberately **not** a CiA 301
        // assignment — it lands on `0x100 + node`, which the predefined set leaves
        // unassigned. If this ever became `0x200 + node` the doc sentence would be false,
        // so the sentence is pinned here rather than trusted.
        let placeholder = CanId {
            function: 0x2,
            node: 7,
        };
        assert_eq!(placeholder.encode(), 0x100 + 7);
        assert_ne!(placeholder.encode(), 0x200 | 7);
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
    fn encode_frame_fits_exactly_at_the_can_cap() {
        // The raw body is 10 bytes (> CAN's 8-byte payload), but stripping the 2-byte SOF
        // leaves exactly 8 — the cap — so `encode_frame` succeeds with a full DLC.
        let can = CanRobotHal::new(Loopback::default(), 1, 0x2);
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 0);
        assert!(
            frame.encode().len() > MAX_CAN_PAYLOAD,
            "test fixture sanity: raw body must overflow CAN"
        );
        let cf = can.encode_frame(&frame).expect("encode");
        assert_eq!(cf.dlc as usize, MAX_CAN_PAYLOAD);
        // The invariant itself, stated rather than implied: this equality is *why*
        // `from_motor_frame`'s `None` arm cannot be reached, so it is the thing to pin if
        // `FRAME_LEN` or `MAX_CAN_PAYLOAD` ever moves.
        assert_eq!(FRAME_LEN - 2, MAX_CAN_PAYLOAD);
    }

    #[tokio::test]
    async fn apply_accepts_a_full_frame_at_the_can_cap() {
        // The frame body is 10 bytes (2-byte SOF + joint + op + arg + 2-byte CRC), so its
        // CAN payload (`body − SOF`) is exactly 8 = MAX_CAN_PAYLOAD. The oversize branch in
        // `apply` is therefore unreachable with a well-formed MotorFrame — this test
        // pins that invariant, and that the boundary frame is accepted.
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 0);
        assert_eq!(frame.encode().len() - 2, MAX_CAN_PAYLOAD);
        let hal = CanRobotHal::new(Loopback::default(), 1, 0x2);
        let n = hal
            .apply(std::slice::from_ref(&frame))
            .await
            .expect("apply");
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn the_odometer_grows_with_apply() {
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 0);
        let sink = Loopback::default();
        let written = Arc::clone(&sink.written);
        let hal = CanRobotHal::new(sink, 1, 0x2);
        // Starts at zero...
        assert_eq!(hal.frames_written(), 0);
        assert_eq!(hal.bytes_written(), 0);
        // ...and grows by the batch size on a real write.
        let n = hal
            .apply(std::slice::from_ref(&frame))
            .await
            .expect("apply");
        assert_eq!(n, 1);
        assert_eq!(hal.frames_written(), 1);
        // This pins the **value** against what the sink really recorded, not the derivation:
        // `MAX_CAN_PAYLOAD + 2` and `FRAME_LEN` are numerically equal today, so no runtime
        // assertion can tell the two formulas apart. The derivation was changed anyway —
        // counting the CAN payload shape would keep reporting a plausible number after
        // `FRAME_LEN` moved, which is the failure mode a byte count exists to prevent.
        assert_eq!(hal.bytes_written(), written.lock().unwrap().len() as u64);
        assert_eq!(hal.bytes_written(), FRAME_LEN as u64);
    }

    #[test]
    fn the_debug_view_names_the_node_function_and_retry_budget() {
        let hal = CanRobotHal::new(Loopback::default(), 7, 0x1);
        assert_eq!(hal.name(), "can");
        let shown = format!("{hal:?}");
        assert!(shown.contains("CanRobotHal"), "got {shown}");
        // The retry budget is the enforced cap, not a zero — a reader of the debug view
        // can see the number `apply` re-transmits up to.
        assert!(shown.contains("retries: 4"), "got {shown}");
    }

    /// The e-stop path on the CAN driver: one `Estop` frame per joint, the CAN-shaped byte
    /// count, and the HAL left disarmed. Same contract as the serial driver's, on a bus
    /// whose payload is the reason the frames must fit in 8 bytes.
    #[tokio::test]
    async fn estop_cuts_torque_on_every_joint_and_disarms() {
        let sink = Loopback::default();
        let written = Arc::clone(&sink.written);
        let hal = CanRobotHal::new(sink, 1, 0x2);
        hal.apply(&[MotorFrame::new(
            JointId::new(0).unwrap(),
            MotorOp::Enable,
            0,
        )])
        .await
        .expect("arm");
        assert!(hal.armed(), "the HAL must be armed before the e-stop");

        let n = hal.estop().await.expect("estop");
        assert_eq!(n, JOINTS, "one Estop frame per joint");
        assert!(!hal.armed(), "an e-stop must leave the bus disarmed");
        assert_eq!(
            hal.bytes_written(),
            ((JOINTS + 1) as u64) * (FRAME_LEN as u64)
        );
        // The raw write path emits the full `MotorFrame` (10 bytes), not the 8-byte CAN
        // payload — `apply` writes bytes and leaves framing to the controller (module doc).
        let wire = written.lock().unwrap();
        assert_eq!(wire.len(), (JOINTS + 1) * FRAME_LEN);
        for (i, chunk) in wire[FRAME_LEN..].chunks(FRAME_LEN).enumerate() {
            assert_eq!(chunk[2], i as u8, "frame {i} must address joint {i}");
            assert_eq!(chunk[3], MotorOp::Estop.code());
        }
    }
}
