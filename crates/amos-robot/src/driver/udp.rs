//! Two UDP drivers behind [`RobotHal`], and the datagram sink they write through.
//!
//! * [`UdpControlRobotHal`] — the control plane. Sends motor frames to a control port on
//!   the LAN. Same flow-control rules as a serial driver (validate the whole batch, write
//!   with `send_to`), but the error model is "buffer full" (`WouldBlock`) instead of "write
//!   returned short". A transient **transport** failure is retried with a bounded back-off
//!   (see `MAX_SEND_RETRIES`); a refused frame is not — a deterministic rejection would
//!   only burn the retry budget.
//!
//! * [`UdpDiscoveryRobotHal`] — the discovery plane. A **refusal-only guard**: the
//!   `RobotHal` trait's only write operation is `apply(&[MotorFrame])`, and the discovery
//!   plane refuses every motor frame (and the e-stop). It carries no state report today —
//!   see its own docs for that boundary. Not safety-critical: the safety path is the
//!   control plane (the e-stop latch and the deadman live in the bridge; here the UDP layer
//!   is just framing).
//!
//! * [`UdpSink`] — the adapter the two drivers write through: one **datagram per `write`**
//!   over a `tokio::net::UdpSocket`. It exists because that socket implements neither
//!   `AsyncWrite` nor `AsyncRead` (it is a datagram socket, not a byte stream), so it cannot
//!   be handed to a driver directly — an earlier version of these docs said "wrap a
//!   `tokio::net::UdpSocket`", which the type system will not allow. `UdpSink` is what makes
//!   the sentence true.
//!
//! UDP is **not** a safety-critical transport — there is no acknowledgment, no
//! retransmission, and silent drop is the default. A deployment that runs a UDP control
//! loop therefore runs a redundant CAN bus *underneath*, and the UDP path is for
//! telemetry and for the brain's read-back. This module states that boundary up-front
//! so a deployment does not accidentally wire the safety path through it.

use std::net::SocketAddr;
use std::time::Duration;

use amos_link::robot_hal::{MotorFrame, RobotHal, StreamRobotHal};

/// Advisory largest datagram payload, exported so a deployment has one number to size its
/// buffers against rather than re-deriving it.
///
/// // chosen: 1024 is a round advisory ceiling — **not** a derivation and not a measurement.
/// (An earlier revision of this comment wrote "8-byte CAN + 2-byte envelope + safety margin",
/// an arithmetic that sums to ten bytes and so cannot be where 1024 comes from, and advertised
/// a measured provenance this crate never had.) It sits comfortably under the 1472
/// bytes a 1500-byte Ethernet MTU leaves for a UDP payload after the 20-byte IP and 8-byte UDP
/// headers, with room for a future envelope; the exact figure is this crate's policy.
///
/// This crate does **not** enforce it: the motor-frame path is bounded by
/// [`FRAME_LEN`](amos_link::robot_hal::FRAME_LEN) (ten bytes, far under this), and a caller
/// putting its own payload on a datagram socket owns the size decision — the socket layer
/// rejects an over-MTU datagram (`EMSGSIZE`) and **silently drops** one that fits the MTU but
/// exceeds the peer's buffer, which is the UDP behaviour no constant here can fix.
pub const MAX_UDP_DISCOVERY_BYTES: usize = 1024;
/// Default back-off between `send_to` retries (`WouldBlock` handling).
const DEFAULT_BACKOFF: Duration = Duration::from_millis(1);
/// Maximum retries before the driver reports the link as down.
const MAX_SEND_RETRIES: u32 = 8;

/// An [`AsyncWrite`](tokio::io::AsyncWrite) datagram sink over a `tokio::net::UdpSocket`:
/// **one `write` becomes one `send_to`, i.e. one datagram.**
///
/// It exists because `tokio::net::UdpSocket` implements neither `AsyncWrite` nor `AsyncRead`
/// — it is a datagram socket, not a byte stream — so it cannot be handed to a driver that
/// wants an `AsyncWrite`. A deployment had to write this adapter itself; now it does not have
/// to.
///
/// The one-write-one-datagram rule is the whole point, and it is why this adapter exists
/// rather than a `Vec<u8>` buffer:
///
/// * `StreamRobotHal::apply` writes each frame with a single `write_all(frame.encode())`, so
///   with this sink **one frame is one datagram of exactly
///   [`FRAME_LEN`](amos_link::robot_hal::FRAME_LEN) bytes**. A byte-stream sink that coalesced
///   two frames into one datagram — or split one across two — would hand the peer a payload
///   it cannot parse, because a datagram receiver sees no frame boundary other than the
///   datagram itself.
/// * `poll_write` performs **no retry**. UDP drops silently; the retry/back-off policy belongs
///   to the HAL above ([`UdpControlRobotHal`], which knows whether the batch was an idempotent
///   set-point), not to the sink, which cannot tell one frame from the next.
/// * A datagram send is all-or-nothing, so `poll_write` never reports a short `Ok(n)`: it
///   returns the whole buffer length or an error.
pub struct UdpSink {
    socket: tokio::net::UdpSocket,
    destination: SocketAddr,
}

impl std::fmt::Debug for UdpSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UdpSink")
            .field("destination", &self.destination)
            .field("local", &self.socket.local_addr().map(|a| a.to_string()))
            .finish()
    }
}

impl UdpSink {
    /// Wrap a bound datagram socket and the peer each write is sent to.
    pub fn new(socket: tokio::net::UdpSocket, destination: SocketAddr) -> Self {
        Self {
            socket,
            destination,
        }
    }

    /// The peer every `write` is addressed to.
    pub fn destination(&self) -> SocketAddr {
        self.destination
    }
}

impl tokio::io::AsyncWrite for UdpSink {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<Result<usize, std::io::Error>> {
        // `UdpSink` is `Unpin` (both fields are), so `get_mut` is available; `poll_send_to`
        // takes `&self` and registers the write waker itself, so a full socket parks the
        // caller instead of spinning.
        let this = self.get_mut();
        this.socket.poll_send_to(cx, buf, this.destination)
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        // A datagram is on the wire the moment `send_to` returned; there is no buffer to
        // drain, so a flush is already satisfied.
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        // Shutting down a datagram socket has no half-close handshake to perform; dropping
        // the socket is the only teardown, and that is the owner's job.
        std::task::Poll::Ready(Ok(()))
    }
}

/// The control-plane HAL.
///
/// The bytes go to whatever `W` puts them on. This type does **not** call `send_to` itself —
/// it writes to `W` and lets the sink decide how those bytes reach the peer. [`UdpSink`] is
/// the sink that does the datagram send (one datagram per frame); any other `AsyncWrite`
/// that delivers whole writes to the peer works too.
///
/// `destination` is therefore **metadata**: this type never sends to it, and it is reported
/// by [`Self::destination`] and in `Debug` only so an operator log names the peer the caller
/// believes it is talking to. It does not *check* that belief — a deployment that binds a
/// `UdpSink` to a different address than the one it hands in here will log the wrong peer.
pub struct UdpControlRobotHal<W: tokio::io::AsyncWrite + Unpin + Send + 'static> {
    inner: StreamRobotHal<W>,
    destination: SocketAddr,
    retries: u32,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send + 'static> std::fmt::Debug for UdpControlRobotHal<W> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UdpControlRobotHal")
            .field("destination", &self.destination)
            .field("retries", &self.retries)
            .finish()
    }
}

impl<W: tokio::io::AsyncWrite + Unpin + Send + 'static> UdpControlRobotHal<W> {
    /// Wrap a byte sink and the peer's address.
    ///
    /// `sink` is where the frames go. For a real UDP peer that is a [`UdpSink`] over a
    /// `tokio::net::UdpSocket`; the socket **cannot** be passed in raw, because it implements
    /// neither `AsyncWrite` nor `AsyncRead`. `destination` is carried for logging only — the
    /// sink decides where the bytes actually land (see the type doc).
    pub fn new(sink: W, destination: SocketAddr) -> Self {
        Self {
            inner: StreamRobotHal::new(sink),
            destination,
            retries: MAX_SEND_RETRIES,
        }
    }

    /// Frames sent.
    pub fn frames_written(&self) -> u64 {
        self.inner.frames_written()
    }

    /// Bytes the wire actually carried: [`FRAME_LEN`](amos_link::robot_hal::FRAME_LEN) per
    /// frame, the same derivation the serial and CAN drivers use (`StreamRobotHal` writes the
    /// raw `MotorFrame::encode()` bytes, nothing else). Present so every *writing* driver in
    /// this module reports the same pair.
    pub fn bytes_written(&self) -> u64 {
        self.inner.bytes_written()
    }

    /// The destination address the caller believes it is talking to. Metadata for logging —
    /// this driver never sends to it directly (see the type doc).
    pub fn destination(&self) -> SocketAddr {
        self.destination
    }
}

#[async_trait::async_trait]
impl<W: tokio::io::AsyncWrite + Unpin + Send + 'static> RobotHal for UdpControlRobotHal<W> {
    async fn apply(&self, frames: &[MotorFrame]) -> Result<usize, amos_link::error::LinkError> {
        for frame in frames {
            frame.validate()?;
        }
        // A bounded retry loop with a constant back-off — **transport errors only**. A
        // `WouldBlock` on a full send buffer is the transient condition a retry can fix;
        // a refused frame (`Robot`/`Frame`/…) is deterministic and would only waste the
        // back-off budget, so it returns immediately. A non-transport error that persisted
        // across retries would be a bug, not a flake.
        //
        // A retry re-writes the *whole* batch, so a batch that failed partway is
        // re-transmitted from the start and the peer sees the early frames twice. That is
        // safe here only because every frame is an idempotent **set-point** (setting a
        // position twice is setting it once). A command with cumulative effect (a
        // "advance by" step, an increment) must not be retried this way.
        let mut attempt = 0u32;
        loop {
            match self.inner.apply(frames).await {
                Ok(written) => return Ok(written),
                Err(err) => {
                    if !matches!(err, amos_link::error::LinkError::Transport(_)) {
                        return Err(err);
                    }
                    attempt = attempt.saturating_add(1);
                    if attempt > self.retries {
                        return Err(err);
                    }
                    tokio::time::sleep(DEFAULT_BACKOFF).await;
                }
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
        "udp-control"
    }
}

/// The discovery-plane HAL — a **refusal-only guard**, not a working discovery transport.
///
/// What it is: a `RobotHal` that refuses every motor frame and every e-stop, so a deployment
/// that wires the discovery plane where the control plane belongs gets an explicit refusal
/// rather than a set point on the wrong socket. It is the negative control the control
/// plane's tests are measured against.
///
/// **Honest boundary — what it does *not* do.** The `RobotHal` trait has exactly one write
/// operation, `apply(&[MotorFrame])`, and motor frames are not state reports, so this type
/// has **no method that sends a state report or a ping frame**: every `apply` with a
/// non-empty batch is refused and the empty batch returns `0` without writing a byte. An
/// earlier doc here said the plane was "used only for `state` reports and for the bus's ping
/// frame" — it never was: nothing implements that path, here or in the middleware. A
/// deployment that needs to put a state report on a datagram socket writes it through
/// [`UdpSink`] (or the middleware's stream HAL) directly; the payload shape is then the
/// deployment's, which is why this crate does not invent one.
pub struct UdpDiscoveryRobotHal<W: tokio::io::AsyncWrite + Unpin + Send + 'static> {
    inner: StreamRobotHal<W>,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send + 'static> std::fmt::Debug
    for UdpDiscoveryRobotHal<W>
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UdpDiscoveryRobotHal").finish()
    }
}

impl<W: tokio::io::AsyncWrite + Unpin + Send + 'static> UdpDiscoveryRobotHal<W> {
    /// Wrap a byte sink for the discovery plane (see the type doc — it will refuse to write).
    pub fn new(sink: W) -> Self {
        Self {
            inner: StreamRobotHal::new(sink),
        }
    }

    /// Bytes written — **structurally zero**, and reported rather than removed so the
    /// odometer is present on every driver. This type refuses every batch before reaching
    /// its writer (`apply` returns `0` for an empty batch without touching the sink), so no
    /// byte can ever be counted here. It is a measurement of *this plane's output*, and that
    /// output is nothing.
    pub fn bytes_written(&self) -> u64 {
        self.inner.bytes_written()
    }
}

#[async_trait::async_trait]
impl<W: tokio::io::AsyncWrite + Unpin + Send + 'static> RobotHal for UdpDiscoveryRobotHal<W> {
    async fn apply(&self, frames: &[MotorFrame]) -> Result<usize, amos_link::error::LinkError> {
        // The discovery plane refuses motor frames outright: it is **never** a safety
        // path, and the wire format is the actuator-state report, not the set-point.
        if !frames.is_empty() {
            return Err(amos_link::error::LinkError::Robot(
                "the UDP discovery plane refuses motor frames — use UdpControlRobotHal".to_string(),
            ));
        }
        Ok(0)
    }

    async fn estop(&self) -> Result<usize, amos_link::error::LinkError> {
        // The discovery plane refuses to be the safety path.
        Err(amos_link::error::LinkError::Robot(
            "the UDP discovery plane cannot issue an e-stop — use a real-time HAL".to_string(),
        ))
    }

    fn armed(&self) -> bool {
        // Read-only with respect to the drivers — the discovery plane never arm/disarms.
        self.inner.armed()
    }

    fn name(&self) -> &'static str {
        "udp-discovery"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_link::robot_hal::{JointId, MotorOp, FRAME_LEN, JOINTS};
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

    /// [`MAX_UDP_DISCOVERY_BYTES`] is a **chosen** advisory ceiling, not a measured one: this
    /// crate never measures a datagram size, and the constant is not even enforced (its own doc
    /// says so). An earlier revision marked it `// measured:`, claiming a measurement that does
    /// not exist — the same mislabelled-provenance defect this crate fixed on `safety.rs`'s
    /// `DEFAULT_*` constants. This pins the marker so a later edit cannot quietly re-advertise a
    /// measurement (REQ-A689).
    #[test]
    fn the_advisory_datagram_ceiling_is_chosen_not_measured() {
        let src: Vec<&str> = include_str!("udp.rs").lines().collect();
        let decl = src
            .iter()
            .position(|l| l.contains("pub const MAX_UDP_DISCOVERY_BYTES"))
            .expect("the constant is declared in this file");
        let mut doc_lines: Vec<&str> = Vec::new();
        for line in src[..decl].iter().rev() {
            if line.trim_start().starts_with("///") {
                doc_lines.push(line);
            } else {
                break;
            }
        }
        doc_lines.reverse();
        let doc = doc_lines.join("\n");
        assert!(!doc.is_empty(), "the constant carries a doc comment");
        assert!(
            doc.contains("// chosen:"),
            "an advisory policy ceiling is `chosen`, not measured: {doc}"
        );
        assert!(
            !doc.contains("// measured:"),
            "this crate measures no datagram size, so a `// measured:` marker is a false \
             provenance here (prose may *discuss* the old marker, but must not wear it): {doc}"
        );
    }

    #[tokio::test]
    async fn the_control_plane_accepts_valid_frames() {
        let sink = Loopback::default();
        let hal = UdpControlRobotHal::new(sink, "127.0.0.1:7000".parse().unwrap());
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 1000);
        hal.apply(std::slice::from_ref(&frame))
            .await
            .expect("apply");
        assert_eq!(hal.frames_written(), 1);
    }

    #[tokio::test]
    async fn the_control_plane_refuses_a_bad_frame() {
        let sink = Loopback::default();
        let hal = UdpControlRobotHal::new(sink, "127.0.0.1:7000".parse().unwrap());
        let bad = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, i32::MAX);
        assert!(hal.apply(&[bad]).await.is_err());
    }

    #[tokio::test]
    async fn the_discovery_plane_refuses_motor_frames() {
        let sink = Loopback::default();
        let hal = UdpDiscoveryRobotHal::new(sink);
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 1000);
        assert!(hal.apply(&[frame]).await.is_err());
    }

    #[tokio::test]
    async fn the_discovery_plane_accepts_an_empty_batch() {
        let sink = Loopback::default();
        let hal = UdpDiscoveryRobotHal::new(sink);
        assert_eq!(hal.apply(&[]).await.expect("ok"), 0);
    }

    /// A write sink that always fails with an io error, and counts attempts.
    #[derive(Default)]
    struct FailingSink {
        attempts: Arc<Mutex<u32>>,
    }

    impl tokio::io::AsyncWrite for FailingSink {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            _buf: &[u8],
        ) -> std::task::Poll<Result<usize, std::io::Error>> {
            *self.attempts.lock().unwrap() += 1;
            std::task::Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "full send buffer",
            )))
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

    #[tokio::test]
    async fn the_control_plane_retries_a_transport_error_a_bounded_number_of_times() {
        // A persistent transport failure must be retried exactly `MAX_SEND_RETRIES` times
        // after the first attempt, then reported as a `Transport` error (the safety path
        // fails closed). The back-off is 1 ms, so 9 attempts is ~8 ms — well inside a test.
        let sink = FailingSink::default();
        let attempts = Arc::clone(&sink.attempts);
        let hal = UdpControlRobotHal::new(sink, "127.0.0.1:7000".parse().unwrap());
        let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 1000);
        let err = hal.apply(std::slice::from_ref(&frame)).await.unwrap_err();
        assert!(
            matches!(err, amos_link::error::LinkError::Transport(_)),
            "expected a transport error, got {err:?}"
        );
        assert_eq!(*attempts.lock().unwrap(), MAX_SEND_RETRIES + 1);
    }

    #[tokio::test]
    async fn the_discovery_plane_refuses_estop() {
        let sink = Loopback::default();
        let hal = UdpDiscoveryRobotHal::new(sink);
        assert!(hal.estop().await.is_err());
    }

    /// The control plane's e-stop: the same one-frame-per-joint batch, on a transport the
    /// module doc calls explicitly **not** safety-critical. The point of the test is that
    /// the control plane *does* issue it (and the discovery plane does not — pinned above).
    #[tokio::test]
    async fn the_control_plane_estops_every_joint() {
        let sink = Loopback::default();
        let written = Arc::clone(&sink.written);
        let hal = UdpControlRobotHal::new(sink, "127.0.0.1:7000".parse().unwrap());
        hal.apply(&[MotorFrame::new(
            JointId::new(0).unwrap(),
            MotorOp::Enable,
            0,
        )])
        .await
        .expect("arm");
        assert!(hal.armed());

        let n = hal.estop().await.expect("estop");
        assert_eq!(n, JOINTS);
        assert!(!hal.armed());
        assert_eq!(hal.frames_written(), (JOINTS + 1) as u64);
        assert_eq!(written.lock().unwrap().len(), (JOINTS + 1) * FRAME_LEN);
    }

    #[test]
    fn the_control_plane_reports_its_destination_and_debug_view() {
        let addr: SocketAddr = "127.0.0.1:7000".parse().unwrap();
        let hal = UdpControlRobotHal::new(Loopback::default(), addr);
        assert_eq!(hal.destination(), addr);
        assert_eq!(hal.name(), "udp-control");
        let shown = format!("{hal:?}");
        assert!(shown.contains("UdpControlRobotHal"), "got {shown}");
        // The retry budget appears so an operator log names the number in play.
        assert!(
            shown.contains(&format!("retries: {MAX_SEND_RETRIES}")),
            "got {shown}"
        );
    }

    /// `UdpSink`'s `Debug` view names its destination and its bound local address — the two
    /// facts an operator needs to tell two sinks apart in a log.
    #[tokio::test]
    async fn the_udp_sink_reports_its_destination_and_local_address() {
        let socket = tokio::net::UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let local = socket.local_addr().expect("local addr");
        let target: SocketAddr = "127.0.0.1:9".parse().unwrap();
        let mut sink = UdpSink::new(socket, target);
        assert_eq!(sink.destination(), target);
        let shown = format!("{sink:?}");
        assert!(shown.contains("UdpSink"), "got {shown}");
        assert!(shown.contains(&target.to_string()), "got {shown}");
        assert!(shown.contains(&local.to_string()), "got {shown}");
        // Both halves of the teardown contract are satisfied-and-then-some, not pending: a
        // datagram has no buffer to drain, so `flush` and `shutdown` complete immediately.
        // `shutdown` in particular must not close the socket — the owner may still own it.
        tokio::io::AsyncWriteExt::flush(&mut sink)
            .await
            .expect("a datagram flush is already satisfied");
        tokio::io::AsyncWriteExt::shutdown(&mut sink)
            .await
            .expect("a datagram shutdown completes at once");
    }

    /// The whole point of [`UdpSink`], end to end over a real loopback socket: **one frame
    /// is one datagram, verbatim**. `StreamRobotHal` writes each frame with a single
    /// `write_all(frame.encode())`, so if the sink coalesced two frames into one datagram —
    /// or split one across two — the peer would receive a payload it could not parse (a
    /// datagram has no inner frame boundary). This is the only test here that uses a real
    /// socket; the rest use an in-memory `AsyncWrite`, which is what makes them deterministic.
    #[tokio::test]
    async fn the_udp_sink_sends_one_frame_per_datagram() {
        let receiver = tokio::net::UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("bind receiver");
        let target = receiver.local_addr().expect("receiver addr");
        let sender = tokio::net::UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("bind sender");
        let sink = UdpSink::new(sender, target);
        assert_eq!(sink.destination(), target);
        let hal = UdpControlRobotHal::new(sink, target);

        let frames = [
            MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 1000),
            MotorFrame::new(JointId::new(1).unwrap(), MotorOp::Enable, 0),
        ];
        assert_eq!(hal.apply(&frames).await.expect("apply"), frames.len());
        assert_eq!(hal.frames_written(), frames.len() as u64);
        assert_eq!(hal.bytes_written(), (frames.len() * FRAME_LEN) as u64);

        let mut buf = [0u8; 64];
        for frame in &frames {
            let (len, _) =
                tokio::time::timeout(Duration::from_secs(2), receiver.recv_from(&mut buf))
                    .await
                    .expect("a datagram within the window")
                    .expect("recv");
            assert_eq!(len, FRAME_LEN, "one whole frame per datagram");
            assert_eq!(
                &buf[..len],
                &frame.encode()[..],
                "the datagram carries the frame's bytes verbatim"
            );
        }
    }

    /// The discovery plane is read-only with respect to the drivers: its `bytes_written`
    /// odometer reads zero, it never arms, and it names itself. This pins the **outcome**
    /// (a structurally-zero count), not a branch — `apply` refuses every non-empty batch
    /// before it can reach a writer, so no byte is ever counted. The `armed` assertion is
    /// the one with teeth: a HAL that reported `armed` from its own state instead of the
    /// wire would be lying to the bridge.
    #[test]
    fn the_discovery_plane_reports_bytes_and_never_arms() {
        let hal = UdpDiscoveryRobotHal::new(Loopback::default());
        assert_eq!(hal.bytes_written(), 0);
        assert!(!hal.armed(), "the discovery plane never arms");
        assert_eq!(hal.name(), "udp-discovery");
        assert_eq!(format!("{hal:?}"), "UdpDiscoveryRobotHal");
    }
}
