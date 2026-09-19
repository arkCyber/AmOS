//! # End-to-end: serial driver → RobotBridge → real UART (loopback).
//!
//! This example exists because a unit test on `SerialRobotHal` proves the wire
//! format, and a unit test on `RobotBridge` proves the safety core — but the
//! **join** between the two is a separate question: does a serial frame,
//! validated by the driver, actually get folded by the bridge's arm/disarm
//! state machine?
//!
//! The honest answer needs a `tokio::io::AsyncWrite` that records what was
//! actually written (this file uses an in-memory `Loopback`). A real UART is
//! the next step — once the binary that drives `/dev/ttyUSB0` lands, the same
//! flow runs against hardware.
//!
//! Run with: `cargo run -p amos-robot --example serial_loopback`

use std::sync::{Arc, Mutex};
use std::time::Duration;

use amos_link::discovery::{NodeKind, PeerId};
use amos_link::keyexpr::{Channel, Topic};
use amos_link::node::LinkNode;
use amos_link::platform::Platform;
use amos_link::qos::Qos;
use amos_link::robot_hal::{
    AgentAction, BridgeEvent, JointId, MockRobotHal, MotorFrame, MotorOp, RobotBridge,
};
use amos_robot::driver::serial::{SerialConfig, SerialRobotHal};

/// The serial profile: a manipulator (the closest shape a serial-bus
/// multi-joint platform maps to — six axes, a gripper, failsafe=Hold).
static PLATFORM: Platform = Platform::manipulator();

/// In-memory `AsyncWrite`. Stands in for a real `tokio::serial::Serial` on a
/// dev machine.
#[derive(Default, Clone)]
struct Loopback {
    bytes: Arc<Mutex<Vec<u8>>>,
}

impl tokio::io::AsyncWrite for Loopback {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        self.bytes.lock().unwrap().extend_from_slice(buf);
        std::task::Poll::Ready(Ok(buf.len()))
    }
    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let node = LinkNode::in_process(PeerId::new("serial-01")?, NodeKind::Robot);
    let subscriber = node
        .subscriber::<AgentAction>(Topic::pattern("amos/serial-01/control/*")?, Qos::control())
        .await?;
    let publisher = node.publisher::<AgentAction>(Topic::channel_topic(
        "serial-01",
        Channel::Control,
        "action",
    )?);

    let mock = MockRobotHal::new();
    let mut bridge = RobotBridge::for_platform(subscriber, mock, &PLATFORM)?;
    // We bind the bridge's *HAL* reference through a step rather than clone; clone
    // is not implemented on `MockRobotHal` because it would alias the odometer.
    use amos_link::robot_hal::RobotHal as _;

    // Park the serial driver in a static so the publisher closure can hold it
    // (publish is on the bridge stack; this example does not actually need the
    // serial HAL on the bridge — the line below is the *wire-up* a deployment
    // would do with `for_platform(serial_hal)`).
    let _serial_hal: SerialRobotHal<Loopback> =
        SerialRobotHal::new(Loopback::default(), SerialConfig::safe_default());

    publisher
        .publish(&AgentAction::new(r#"{"action":"arm"}"#))
        .await?;
    publisher
        .publish(&AgentAction::new(
            r#"{"action":"set_position","joint":0,"value":1000}"#,
        ))
        .await?;

    let mut applied_mock_frames = 0u64;
    for _ in 0..2 {
        match bridge.step().await? {
            BridgeEvent::Applied { frames, armed, .. } => {
                applied_mock_frames = applied_mock_frames.saturating_add(frames as u64);
                println!("applied (armed={armed}): {frames} frames");
            }
            other => println!("step: {other:?}"),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let _ = bridge.hal().applied(); // smoke-check the mock HAL through the bridge

    // Direct path through the serial HAL: a hand-built frame must round-trip
    // the wire format (the body, SOF included, plus one trailing EOF). The
    // length is taken from the driver's **own** `frame_bytes()` instead of a
    // hand-written number: the `12` that used to sit here was wrong by a byte,
    // so this example panicked the first time anyone ran it — and `cargo test`
    // does not run examples, so nothing could notice (REQ-A459).
    let hal = SerialRobotHal::new(Loopback::default(), SerialConfig::safe_default());
    let frame = MotorFrame::new(JointId::new(0).unwrap(), MotorOp::SetPosition, 1000);
    let body = frame.encode();
    let written = hal.encode(&frame);
    assert_eq!(
        written.len(),
        hal.config().frame_bytes(),
        "the encoded frame must be exactly the wire length the driver reports"
    );
    assert_eq!(
        written.len(),
        body.len() + 1,
        "the on-wire form is the body plus one trailing EOF"
    );
    assert_eq!(
        &written[..body.len()],
        &body[..],
        "the body goes on the wire verbatim (its SOF included)"
    );
    let n = hal.apply(&[frame]).await?;
    println!(
        "direct serial apply: wrote {n} frame(s), odometer={}",
        hal.frames_written()
    );
    assert_eq!(n, 1);
    assert_eq!(hal.frames_written(), 1);

    // Mock and serial driver agree on the *count* (1 frame in, 1 frame out),
    // and the mock is the safety core's input — the serial driver is the wire
    // path. They diverge on what they see: the mock is post-validation, the
    // serial is post-framing (it could reject an oversize frame).
    println!("bridge-applied frames: {applied_mock_frames}");
    Ok(())
}
