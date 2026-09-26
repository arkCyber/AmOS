//! A serial (UART / RS-485) driver behind [`RobotHal`].
//!
//! The driver is a thin wrapper over the middleware's [`StreamRobotHal`]: the wrapper
//! handles validation, wire-order arming and write-batching, and the driver adds a
//! **config sanity gate** and a **turnaround delay** on top.
//!
//! ### Wire format (what is *actually* written)
//!
//! ```text
//!     0xAA 0x55 ‖ 1-byte id (joint) ‖ 1-byte op ‖ 4-byte arg (i32) ‖ 2-byte CRC   // 10 bytes
//! ```
//!
//! The field order is `MotorFrame::encode`'s own (and `amos_link`'s wire doc, `0xAA 0x55 │ id
//! u8 │ op u8 │ arg i32 │ crc16 u16`): the **joint id comes first, then the op** (REQ-A686). An
//! earlier revision of the diagram above had those two bytes swapped — a receiver built from it
//! would have read the joint index as an opcode, so the order is now pinned by
//! `the_wire_diagram_lists_the_joint_before_the_op_and_encode_agrees`.
//!
//! That 10-byte frame is exactly what [`MotorFrame::encode`] produces, and it already
//! begins with the `0xAA 0x55` start-of-frame marker [`StreamRobotHal`] writes verbatim
//! — so the live write path emits **one 10-byte frame per frame, with no
//! extra bytes added here**. The 0xAA SOF is the re-sync marker a receiver scans for
//! between frames; the CRC inside the frame covers its content.
//!
//! ### The `delimited` / `encode` path is a test-only extension point
//!
//! [`SerialConfig::delimited`] and [`SerialRobotHal::encode`] describe a richer on-wire
//! form that appends a `0x55` end byte for symmetry:
//!
//! ```text
//!     0xAA 0x55 ‖ … frame … ‖ 0x55   // 11 bytes — NOT emitted by `apply`
//! ```
//!
//! That form is **not** on the wire yet: `apply` delegates the raw frames to the inner
//! HAL, and `encode` is called only by tests. It exists as the shape a real RS-485
//! turnaround would want, and is documented here so a reader is not misled into thinking
//! the extra end byte is carried today. [`SerialRobotHal::bytes_written`] counts the
//! bytes that really crossed the wire (10 per frame), not the `encode` helper's output.
//!
//! ### What `turnaround_us` is, and what it is not
//!
//! [`SerialConfig::turnaround_us`] is inserted by `apply` as **one delay after the whole
//! batch**: every frame goes out through the inner HAL (one `write_all` per frame, one
//! `flush` per batch) and only then does the driver sleep. So it separates consecutive
//! `apply` calls — it does **not** put a gap between the frames of a single batch, and with
//! `N > 1` frames in a batch a strict half-duplex bus sees them back to back.
//!
//! A real RS-485 turnaround is two things, and this driver models only the first: a
//! *delay* (so the far end has released the pair) and a *direction switch* on the
//! transceiver's DE/RE pin. An `AsyncWrite` cannot drive a pin, so the pin is out of this
//! type's reach entirely. A deployment that needs per-frame turnaround must therefore send
//! one frame per `apply` and let the delay separate them.
//!
//! ### Field testing notes
//!
//! * 1 Mbaud is the typical servo bus speed (`STServo` / `LewanSoul` / `Feetech`).
//! * `~100 µs` is the turnaround those transceivers need. Zero means full-duplex, no echo.
//! * A real servo also has a **read-back** half (encoder positions, current sense). This
//!   driver, like every HAL in this crate, is **write-only**: `amos_link`'s `RobotHal` seam
//!   carries frames *out* only. Read-back needs an input topic the middleware does not yet
//!   have (the Phase-2 frame channel in `docs/robot-autonomy.md` §5), so it is honestly
//!   absent here rather than faked — nothing in `crate::slam` reads a wire, either.

use std::time::Duration;

use amos_link::robot_hal::{MotorFrame, RobotHal, StreamRobotHal, FRAME_LEN};

use crate::driver::estop_frames;

const FRAME_EOF: u8 = 0x55;
/// Length on the wire: `FRAME_LEN ‖ EOF` (one trailing byte).
const DELIMITED_LEN: usize = FRAME_LEN + 1;

/// Default servo-bus baud rate.
///
/// // cited: 1 Mbaud is the published default of the `STServo` / `LewanSoul` / `Feetech`
/// hobby servo buses this driver targets.
const DEFAULT_SERVO_BAUD: u32 = 1_000_000;

/// Default RS-485 half-duplex turnaround delay, in microseconds. Zero = full duplex, no
/// echo — the safe default. A half-duplex deployment sets this instead; the module doc
/// notes `~100 µs` as the turnaround those transceivers need.
const DEFAULT_RS485_TURNAROUND_US: u32 = 0;

/// Configuration for the serial driver.
#[derive(Clone, Debug, PartialEq)]
pub struct SerialConfig {
    /// Baud rate (bits per second). A real driver does **not** configure the port — the
    /// deployment sets termios before the node starts (`stty -F /dev/ttyUSB0 1M raw`).
    pub baud: u32,
    /// RS-485 turnaround delay (microseconds), inserted **once after the batch** — see the
    /// module doc for what that does and does not buy. Zero means "full duplex, no echo".
    pub turnaround_us: u32,
    /// Whether the [`SerialRobotHal::encode`] helper appends a trailing `0x55` end byte.
    /// This does **not** affect what `apply` writes today (see the module doc): the live
    /// wire path always emits the raw 10-byte [`MotorFrame`].
    pub delimited: bool,
}

impl SerialConfig {
    /// A safe default: 1 Mbaud, no RS-485 turnaround, delimited on.
    pub fn safe_default() -> Self {
        Self {
            baud: DEFAULT_SERVO_BAUD,
            turnaround_us: DEFAULT_RS485_TURNAROUND_US,
            delimited: true,
        }
    }

    /// True when the configuration is internally consistent (a non-zero baud).
    pub fn is_sane(&self) -> bool {
        self.baud > 0
    }

    /// The length of [`SerialRobotHal::encode`]'s output, in bytes (`DELIMITED_LEN` when
    /// `delimited`, else `FRAME_LEN`). This describes the test-only helper, not the live
    /// wire path, which always emits `FRAME_LEN` bytes per frame.
    pub fn frame_bytes(&self) -> usize {
        if self.delimited {
            DELIMITED_LEN
        } else {
            FRAME_LEN
        }
    }
}

/// A serial-port-backed robot HAL that wraps any `AsyncWrite` destination.
pub struct SerialRobotHal<W: tokio::io::AsyncWrite + Unpin + Send + 'static> {
    inner: StreamRobotHal<W>,
    config: SerialConfig,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send + 'static> std::fmt::Debug for SerialRobotHal<W> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SerialRobotHal")
            .field("config", &self.config)
            .field("frames_written", &self.inner.frames_written())
            .finish()
    }
}

impl<W: tokio::io::AsyncWrite + Unpin + Send + 'static> SerialRobotHal<W> {
    /// Wrap a serial port with the given configuration.
    pub fn new(writer: W, config: SerialConfig) -> Self {
        Self {
            inner: StreamRobotHal::new(writer),
            config,
        }
    }

    /// Read the odometer — frames the wire actually carried.
    pub fn frames_written(&self) -> u64 {
        self.inner.frames_written()
    }

    /// Bytes the wire actually carried. `apply` writes the raw `MotorFrame::encode()`
    /// bytes, `FRAME_LEN` per frame — independent of the `delimited` flag, which only
    /// affects the test-only `encode` helper. Reporting `frame_bytes()` here would
    /// over-count by one byte per frame for the default (delimited) config.
    pub fn bytes_written(&self) -> u64 {
        self.frames_written().saturating_mul(FRAME_LEN as u64)
    }

    /// The configuration.
    pub fn config(&self) -> &SerialConfig {
        &self.config
    }

    /// Encode one frame into the wire bytes (used by tests, not by `apply`).
    pub fn encode(&self, frame: &MotorFrame) -> Vec<u8> {
        let body = frame.encode();
        if self.config.delimited {
            // The body already starts with the 2-byte SOF; the wire layer only
            // adds the trailing EOF for RS-485 turnaround. So the on-wire form
            // is `body ‖ EOF`, which is `FRAME_LEN + 1` bytes.
            let mut buf = Vec::with_capacity(DELIMITED_LEN);
            buf.extend_from_slice(&body);
            buf.push(FRAME_EOF);
            buf
        } else {
            body.to_vec()
        }
    }
}

#[async_trait::async_trait]
impl<W: tokio::io::AsyncWrite + Unpin + Send + 'static> RobotHal for SerialRobotHal<W> {
    async fn apply(&self, frames: &[MotorFrame]) -> Result<usize, amos_link::error::LinkError> {
        // The wrapper accepts only what the inner writer can validate; we re-route the
        // frames through the inner HAL so the wire-write / arm-fold logic is single-
        // sourced. The driver itself adds only the config gate below and the turnaround
        // delay after the write — the delimiters live in `encode`, which `apply` never
        // calls (module doc).
        if !self.config.is_sane() {
            return Err(amos_link::error::LinkError::Robot(
                "serial driver refused an insane configuration".into(),
            ));
        }
        // Validate the entire batch first; a refused frame must not leave any byte on
        // the wire (the same rule `StreamRobotHal` applies downstream).
        for frame in frames {
            frame.validate()?;
        }
        // Hand the inner HAL the frames — it has the validated write path.
        let written = self.inner.apply(frames).await?;
        if self.config.turnaround_us > 0 {
            tokio::time::sleep(Duration::from_micros(self.config.turnaround_us as u64)).await;
        }
        Ok(written)
    }

    async fn estop(&self) -> Result<usize, amos_link::error::LinkError> {
        let frames = estop_frames()
            .ok_or_else(|| amos_link::error::LinkError::Robot("no JointId available".into()))?;
        self.apply(&frames).await
    }

    fn armed(&self) -> bool {
        // Read from the inner HAL — it folds the ops the wire actually saw.
        self.inner.armed()
    }

    fn name(&self) -> &'static str {
        "serial"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_link::robot_hal::{JointId, MotorOp, FRAME_SOF, JOINTS};
    use std::sync::{Arc, Mutex};

    /// An `AsyncWrite` that records everything written — the loopback equivalent of a
    /// mock UART.
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
            let mut g = self.written.lock().unwrap();
            g.extend_from_slice(buf);
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
    fn encode_emits_a_delimited_frame() {
        let hal = SerialRobotHal::new(Loopback::default(), SerialConfig::safe_default());
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 1000);
        let bytes = hal.encode(&frame);
        assert_eq!(bytes[0], FRAME_SOF[0]);
        assert_eq!(bytes[1], FRAME_SOF[1]);
        assert_eq!(*bytes.last().unwrap(), FRAME_EOF);
        assert_eq!(bytes.len(), DELIMITED_LEN);
    }

    #[test]
    fn sane_config_rejects_zero_baud() {
        let sane = SerialConfig {
            baud: 0,
            ..SerialConfig::safe_default()
        };
        assert!(!sane.is_sane());
    }

    #[tokio::test]
    async fn apply_writes_frames_and_counts_them() {
        let sink = Loopback::default();
        let written = Arc::clone(&sink.written);
        let hal = SerialRobotHal::new(sink, SerialConfig::safe_default());
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 1000);
        let n = hal
            .apply(std::slice::from_ref(&frame))
            .await
            .expect("apply");
        assert_eq!(n, 1);
        // The inner HAL wrote 10 bytes (one raw frame); the driver's encode adds the
        // delimiters at this layer in the encode() helper, which is what tests inspect.
        assert_eq!(*written.lock().unwrap(), frame.encode().to_vec());
        assert_eq!(hal.frames_written(), 1);
        // The byte counter must match what actually crossed the wire (10 raw bytes), not
        // the delimited `encode` helper's 11-byte form.
        assert_eq!(hal.bytes_written(), written.lock().unwrap().len() as u64);
        assert_eq!(hal.bytes_written(), FRAME_LEN as u64);
    }

    #[tokio::test]
    async fn an_invalid_frame_is_refused_before_any_byte_hits_the_wire() {
        let sink = Loopback::default();
        let written = Arc::clone(&sink.written);
        let hal = SerialRobotHal::new(sink, SerialConfig::safe_default());
        let bad = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, i32::MAX);
        assert!(hal.apply(&[bad]).await.is_err());
        assert!(
            written.lock().unwrap().is_empty(),
            "no byte must have been written for a refused batch"
        );
    }

    #[tokio::test]
    async fn an_insane_config_is_refused() {
        let sink = Loopback::default();
        let bad_config = SerialConfig {
            baud: 0,
            ..SerialConfig::safe_default()
        };
        let hal = SerialRobotHal::new(sink, bad_config);
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 0);
        assert!(hal.apply(&[frame]).await.is_err());
    }

    /// `frame_bytes` describes the **`encode` helper's** form (11 bytes when delimited),
    /// not the live wire form (always 10). Pinning both branches keeps the helper's
    /// contract from silently collapsing onto the wire path.
    #[test]
    fn frame_bytes_counts_the_helper_form_per_the_delimited_flag() {
        let delimited = SerialConfig::safe_default();
        assert_eq!(delimited.frame_bytes(), DELIMITED_LEN);
        assert_eq!(delimited.frame_bytes(), FRAME_LEN + 1);

        let plain = SerialConfig {
            delimited: false,
            ..SerialConfig::safe_default()
        };
        assert_eq!(plain.frame_bytes(), FRAME_LEN);
    }

    /// The undelimited `encode` is byte-for-byte the raw frame — no trailing EOF. Without
    /// this, a `delimited: false` deployment would silently get an 11th byte on a bus that
    /// has no use for it.
    #[test]
    fn an_undelimited_encode_is_exactly_one_raw_frame() {
        let hal = SerialRobotHal::new(
            Loopback::default(),
            SerialConfig {
                delimited: false,
                ..SerialConfig::safe_default()
            },
        );
        let frame = MotorFrame::new(JointId::new(3).unwrap(), MotorOp::SetTorque, 5000);
        assert_eq!(hal.encode(&frame), frame.encode().to_vec());
        assert_ne!(*hal.encode(&frame).last().unwrap(), FRAME_EOF);
    }

    #[test]
    fn the_config_and_debug_view_report_the_driver_state() {
        let hal = SerialRobotHal::new(Loopback::default(), SerialConfig::safe_default());
        assert_eq!(hal.config().baud, DEFAULT_SERVO_BAUD);
        assert_eq!(hal.config().turnaround_us, DEFAULT_RS485_TURNAROUND_US);
        assert_eq!(hal.name(), "serial");
        let shown = format!("{hal:?}");
        assert!(shown.contains("SerialRobotHal"), "got {shown}");
        assert!(shown.contains("frames_written"), "got {shown}");
    }

    /// The turnaround delay is a delay, not a wire artifact: enabling it must not change a
    /// single byte, the odometer, or the returned count. This pins the boundary the module
    /// doc draws — `apply` sleeps *after* the batch, so the same frames land either way, and
    /// a deployment that sets `turnaround_us` expecting "different framing" gets nothing.
    ///
    /// The bug shape it guards is a delay path that *replaces* the write (e.g. a
    /// `turnaround > 0` arm that sleeps and reports frames it never sent, or one that emits
    /// the `encode` helper's 11-byte delimited form because the delay is "the RS-485 bit").
    /// Both leave every byte-count assertion in the other tests untouched when the flag is
    /// zero — which is the default, and why this test has to turn it on to see anything.
    #[tokio::test]
    async fn a_turnaround_delay_changes_no_byte_and_no_count() {
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 1000);

        let quiet = Loopback::default();
        let quiet_written = Arc::clone(&quiet.written);
        let quiet_hal = SerialRobotHal::new(quiet, SerialConfig::safe_default());
        let quiet_n = quiet_hal
            .apply(std::slice::from_ref(&frame))
            .await
            .expect("apply");

        let delayed = Loopback::default();
        let delayed_written = Arc::clone(&delayed.written);
        let delayed_hal = SerialRobotHal::new(
            delayed,
            SerialConfig {
                turnaround_us: 100,
                ..SerialConfig::safe_default()
            },
        );
        let delayed_n = delayed_hal
            .apply(std::slice::from_ref(&frame))
            .await
            .expect("apply");

        // The return value is the count of frames actually written, so a delay path that
        // reported a write it never made is caught here as well as on the wire below.
        assert_eq!(delayed_n, quiet_n);
        assert_eq!(delayed_n, 1);
        assert_eq!(delayed_hal.frames_written(), quiet_hal.frames_written());
        assert_eq!(delayed_hal.bytes_written(), quiet_hal.bytes_written());
        assert_eq!(
            *delayed_written.lock().unwrap(),
            *quiet_written.lock().unwrap()
        );
        assert_eq!(*delayed_written.lock().unwrap(), frame.encode().to_vec());
    }

    /// The module doc's wire diagram is the map a reader plans an RS-485 parser against, so
    /// its field order must be the order `MotorFrame::encode` actually writes — **id (joint)
    /// first, then op**. Both halves are pinned: the diagram's own text (read back from this
    /// file with `include_str!`, the idiom `amos-tauri`'s `RotationGlue` binding uses for the
    /// same reason) and the bytes on the wire. The defect this guards is a diagram that swaps
    /// the two 1-byte fields — a receiver built from it would read the joint index as an
    /// opcode and vice versa, which is a wrong joint on every frame.
    #[test]
    fn the_wire_diagram_lists_the_joint_before_the_op_and_encode_agrees() {
        let src = include_str!("serial.rs");
        let diagram = src
            .lines()
            .find(|l| l.contains("2-byte CRC"))
            .expect("the module doc carries the wire diagram");
        let joint_at = diagram
            .find("joint")
            .unwrap_or_else(|| panic!("the diagram must name the joint byte: {diagram}"));
        let op_at = diagram
            .find("op")
            .unwrap_or_else(|| panic!("the diagram must name the op byte: {diagram}"));
        assert!(
            joint_at < op_at,
            "the diagram must put the joint (id) byte before op, as `encode` writes it: {diagram}"
        );

        // …and the code really writes it that way: byte 2 is the joint index, byte 3 the op
        // code. A nonzero joint with a distinguishable op makes a swap fail loudly.
        let frame = MotorFrame::new(JointId::new(3).unwrap(), MotorOp::SetTorque, 0);
        let bytes = frame.encode();
        assert_eq!(bytes[2], 3, "byte 2 is the joint index (id)");
        assert_eq!(bytes[3], MotorOp::SetTorque.code(), "byte 3 is the op code");
    }

    /// The e-stop path, end to end on the wire: one `Estop` frame per joint, each exactly
    /// `FRAME_LEN` bytes, and the HAL left **disarmed** with a measured frame count.
    ///
    /// This is the one driver method whose failure mode is "the machine did not stop", so a
    /// test that only checked `Ok(..)` would not be enough: the count must equal the frames
    /// the bus really took, and the bytes must be the raw frames (the module doc's promise).
    #[tokio::test]
    async fn estop_cuts_torque_on_every_joint_and_disarms() {
        let sink = Loopback::default();
        let written = Arc::clone(&sink.written);
        let hal = SerialRobotHal::new(sink, SerialConfig::safe_default());
        // Arm first, so "disarmed" is a change the e-stop caused rather than the initial state.
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

        let wire = written.lock().unwrap();
        // The arm frame plus the e-stop batch, every one exactly FRAME_LEN bytes.
        assert_eq!(wire.len(), (JOINTS + 1) * FRAME_LEN);
        assert_eq!(hal.bytes_written(), wire.len() as u64);
        // Every e-stop frame is an Estop op carrying joint 0..=MAX_JOINT in order.
        for (i, chunk) in wire[FRAME_LEN..].chunks(FRAME_LEN).enumerate() {
            assert_eq!(chunk[2], i as u8, "frame {i} must address joint {i}");
            assert_eq!(chunk[3], MotorOp::Estop.code());
        }
    }
}
