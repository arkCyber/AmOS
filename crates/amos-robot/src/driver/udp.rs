//! Two UDP drivers behind [`RobotHal`](amos_link::robot_hal::RobotHal).
//!
//! * [`UdpControlRobotHal`] — the control plane. Sends motor frames to a control port on
//!   the LAN. Same flow-control rules as a serial driver (validate the whole batch, write
//!   with `send_to`), but the error model is "buffer full" (`WouldBlock`) instead of "write
//!   returned short".
//!
//! * [`UdpDiscoveryRobotHal`] — the discovery plane. Used only for `state` reports and for
//!   the bus's *ping* frame. Not safety-critical: the safety path is the control plane
//!   (the e-stop latch and the deadman live in the bridge; here the UDP layer is just
//!   framing).
//!
//! UDP is **not** a safety-critical transport — there is no acknowledgment, no
//! retransmission, and silent drop is the default. A deployment that runs a UDP control
//! loop therefore runs a redundant CAN bus *underneath*, and the UDP path is for
//! telemetry and for the brain's read-back. This module states that boundary up-front
//! so a deployment does not accidentally wire the safety path through it.

use std::net::SocketAddr;
use std::time::Duration;

use amos_link::robot_hal::{MotorFrame, RobotHal, StreamRobotHal};

/// Largest datagram payload (8-byte CAN + 2-byte envelope + safety margin).
pub const MAX_UDP_DISCOVERY_BYTES: usize = 1024;
/// Default back-off between `send_to` retries (`WouldBlock` handling).
const DEFAULT_BACKOFF: Duration = Duration::from_millis(1);
/// Maximum retries before the driver reports the link as down.
const MAX_SEND_RETRIES: u32 = 8;

/// The control-plane HAL.
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
    /// Wrap a `tokio::net::UdpSocket` and a destination address.
    pub fn new(socket: W, destination: SocketAddr) -> Self {
        Self {
            inner: StreamRobotHal::new(socket),
            destination,
            retries: MAX_SEND_RETRIES,
        }
    }

    /// Frames sent.
    pub fn frames_written(&self) -> u64 {
        self.inner.frames_written()
    }

    /// The destination address.
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
        // A bounded retry loop with a constant back-off: real UDP sockets return
        // `WouldBlock` on a full send buffer; the driver backs off and re-tries
        // `retries` times before giving up (the safety path fails closed).
        let mut attempt = 0u32;
        loop {
            let result = self.inner.apply(frames).await;
            if result.is_ok() {
                return result;
            }
            attempt = attempt.saturating_add(1);
            if attempt > self.retries {
                return result;
            }
            tokio::time::sleep(DEFAULT_BACKOFF).await;
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

/// The discovery-plane HAL. Smaller scope, less safety to demonstrate; "state" reports
/// only — never motor frames.
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
    /// Wrap a UDP socket for the discovery (state) plane only.
    pub fn new(socket: W) -> Self {
        Self {
            inner: StreamRobotHal::new(socket),
        }
    }

    /// Bytes written.
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

    #[tokio::test]
    async fn the_discovery_plane_refuses_estop() {
        let sink = Loopback::default();
        let hal = UdpDiscoveryRobotHal::new(sink);
        assert!(hal.estop().await.is_err());
    }
}
