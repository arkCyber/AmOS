//! The hardware boundary, on a real descriptor.
//!
//! [`MockRobotHal`] proves the *plan*; it cannot prove what reaches a device, because it
//! never writes to one. These tests carry the frames from agent JSON → `plan` → a real Unix
//! socket and read the bytes back with [`MotorFrame::decode`] — the same decode a driver on
//! the far side of a UART or a controller socket would run. What is pinned:
//!
//! * the bytes on the wire are exactly the planned frames, CRC16 included;
//! * a batch containing one bad frame writes **nothing** (the safety layer runs before the
//!   descriptor, so no joint is left half-commanded);
//! * the count a HAL reports as accepted is the count really written;
//! * `armed()` follows the ops that were written, **in wire order**.
//!
//! A `UnixStream` pair stands in for a UART/CAN bridge on purpose: the HAL's contract is "a
//! byte stream", and a socket is that contract with no hardware in the loop. Opening a real
//! device port additionally needs termios setup (`stty -F /dev/ttyUSB0 1M raw`), which the
//! deployment owns — see `StreamRobotHal::open_device`.
//!
//! [`MockRobotHal`]: amos_link::robot_hal::MockRobotHal
//! [`MotorFrame::decode`]: amos_link::robot_hal::MotorFrame::decode

#![cfg(unix)]

use std::time::Duration;

use amos_link::error::LinkError;
use amos_link::robot_hal::{
    parse_command, plan, JointId, MotorFrame, MotorOp, RobotHal, StreamRobotHal, FRAME_LEN, JOINTS,
    MAX_JOINT_MILLI_DEG,
};
use tokio::io::AsyncReadExt;

/// Read exactly `frames` motor frames off the far end of the bus and decode them.
async fn read_frames<R: AsyncReadExt + Unpin>(reader: &mut R, frames: usize) -> Vec<MotorFrame> {
    let mut buf = vec![0u8; frames * FRAME_LEN];
    reader
        .read_exact(&mut buf)
        .await
        .expect("the bus carried the frames");
    buf.chunks(FRAME_LEN)
        .map(|chunk| MotorFrame::decode(chunk).expect("a driver on this bus decodes the frame"))
        .collect()
}

fn joint(index: u8) -> JointId {
    JointId::new(index).expect("joint in range")
}

fn trot() -> Vec<MotorFrame> {
    plan(&parse_command(r#"{"action":"trot","speed":0.5}"#).expect("intent parses"))
}

#[tokio::test]
async fn the_plan_reaches_a_real_socket_byte_for_byte() {
    let (bus, mut driver) = tokio::net::UnixStream::pair().expect("socket pair");
    let hal = StreamRobotHal::new(bus);
    let frames = trot();
    assert!(
        frames.len() > JOINTS,
        "a gait is enable + one frame per joint"
    );

    let accepted = hal.apply(&frames).await.expect("apply");
    assert_eq!(accepted, frames.len(), "every frame was written");
    assert_eq!(hal.frames_written(), frames.len() as u64);
    assert_eq!(
        hal.bytes_written(),
        (frames.len() * FRAME_LEN) as u64,
        "the odometer counts bytes that really left"
    );

    // What a servo driver sees: the same frames, and the CRC decides whether it trusts them.
    let decoded = read_frames(&mut driver, frames.len()).await;
    assert_eq!(
        decoded, frames,
        "the wire carries the plan, not something like it"
    );
    assert!(hal.armed(), "the batch enabled the joints");
    assert_eq!(hal.name(), "stream");
}

#[tokio::test]
async fn a_batch_with_one_bad_frame_never_reaches_the_wire() {
    let (bus, mut driver) = tokio::net::UnixStream::pair().expect("socket pair");
    let hal = StreamRobotHal::new(bus);
    let good = MotorFrame::new(joint(0), MotorOp::Enable, 0);
    let bad = MotorFrame::new(
        joint(1),
        MotorOp::SetPosition,
        MAX_JOINT_MILLI_DEG + 1, // past the travel limit
    );

    let err = hal
        .apply(&[good, bad])
        .await
        .expect_err("a set point past the travel limit must be refused");
    assert!(matches!(err, LinkError::Robot(_)), "got: {err:?}");
    assert_eq!(
        hal.frames_written(),
        0,
        "the refusal precedes the descriptor"
    );
    assert!(
        !hal.armed(),
        "nothing was written, so nothing may be reported as energized"
    );

    // The measurement: an open socket that delivered zero bytes. (A short read window is the
    // only way to observe "nothing arrived" on a stream that is still open.)
    let mut buf = [0u8; FRAME_LEN];
    match tokio::time::timeout(Duration::from_millis(150), driver.read(&mut buf)).await {
        Err(_elapsed) => {}
        Ok(Ok(0)) => {}
        Ok(Ok(n)) => panic!("{n} byte(s) reached the bus despite the refusal"),
        Ok(Err(e)) => panic!("the bus failed while proving it stayed quiet: {e}"),
    }
}

#[tokio::test]
async fn estop_reports_the_frames_it_really_wrote() {
    let (bus, mut driver) = tokio::net::UnixStream::pair().expect("socket pair");
    let hal = StreamRobotHal::new(bus);

    let accepted = hal.estop().await.expect("estop");
    assert_eq!(
        accepted, JOINTS,
        "this bus shape cuts torque with one frame per joint — and the number is measured"
    );
    assert!(!hal.armed(), "torque is cut, so the drivers are not armed");
    let decoded = read_frames(&mut driver, accepted).await;
    assert!(
        decoded.iter().all(|f| f.op == MotorOp::Estop),
        "every frame on the wire is a torque cut"
    );
}

#[tokio::test]
async fn the_armed_flag_follows_the_wire_order_of_a_mixed_batch() {
    // The defect this pins: both HALs answered with two `any()` passes over the batch, so a
    // batch that *ended* with `Enable` still reported `armed: false` if an `Estop` appeared
    // anywhere in it — an inverted safety state, reported to the commander as a measurement.
    let (bus, _driver) = tokio::net::UnixStream::pair().expect("socket pair");
    let hal = StreamRobotHal::new(bus);
    let enable = MotorFrame::new(joint(0), MotorOp::Enable, 0);
    let estop = MotorFrame::new(joint(1), MotorOp::Estop, 0);

    hal.apply(&[estop, enable])
        .await
        .expect("a re-arm after a cut is one batch");
    assert!(
        hal.armed(),
        "the last op was Enable, so the drivers are energized"
    );

    hal.apply(&[enable, estop]).await.expect("apply");
    assert!(!hal.armed(), "the last op was Estop, so torque is gone");
}

#[tokio::test]
async fn a_hal_can_attach_to_a_listening_motor_daemon() {
    // The shape a board-local servo daemon has: a controller listening on a Unix socket.
    let dir = std::env::temp_dir().join(format!("amos-link-hal-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("motor.sock");
    let _ = std::fs::remove_file(&path);
    let listener = tokio::net::UnixListener::bind(&path).expect("bind motor daemon");

    let daemon = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("a node attached");
        let mut buf = vec![0u8; 2 * FRAME_LEN];
        socket.read_exact(&mut buf).await.expect("frames arrive");
        buf
    });

    let hal = StreamRobotHal::connect_unix(&path)
        .await
        .expect("connecting to the motor daemon");
    let frames = trot();
    let accepted = hal.apply(&frames[..2]).await.expect("apply");
    assert_eq!(accepted, 2);

    let got = daemon.await.expect("daemon task");
    let expected: Vec<u8> = frames[..2]
        .iter()
        .flat_map(|f| f.encode().to_vec())
        .collect();
    assert_eq!(got, expected, "the daemon reads the frames unsplit");
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn a_missing_motor_daemon_is_an_error_not_a_silent_bus() {
    // A robot whose motor daemon is down must fail loudly: a bus that accepts nothing would
    // otherwise keep reporting `armed: true` from the last successful batch.
    let missing = std::env::temp_dir().join("amos-link-no-such-motor-daemon.sock");
    let _ = std::fs::remove_file(&missing);
    let err = StreamRobotHal::connect_unix(&missing)
        .await
        .expect_err("no daemon, no bus");
    assert!(matches!(err, LinkError::Transport(_)), "got: {err:?}");
    assert!(
        err.to_string().contains("motor bus"),
        "the message names what failed: {err}"
    );
}
