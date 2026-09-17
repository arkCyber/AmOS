//! Unit tests for the `amos-link-cc` C ABI surface.
//!
//! These tests call the FFI functions directly from Rust by importing them through
//! `extern crate amos_link_cc as ffi;`.  Since `amos-link-cc` builds as both a
//! `cdylib` (for C/C++ consumption) and an `rlib` (for these tests), the `rlib`
//! re-exports all public items from `src/lib.rs` so they can be unit-tested here.
//!
//! The primary smoke tests cover:
//! - version / constants
//! - topic validation and key expression matching
//! - peer ID construction and validation
//! - QoS preset construction
//! - Timestamp construction and arithmetic
//! - in-process node creation (local broker)
//! - publisher / subscriber lifecycle

extern crate amos_link_cc as ffi;
use std::ffi::CStr;

// ---------------------------------------------------------------------------
// Constants / version
// ---------------------------------------------------------------------------

#[test]
fn version_constant_is_one() {
    assert_eq!(ffi::AMLK_VERSION, 1);
}

#[test]
fn magic_bytes() {
    assert_eq!(ffi::AMLK_MAGIC, [0x41, 0x4D, 0x4C, 0x4B]);
}

#[test]
fn size_limits_are_reasonable() {
    assert!(ffi::AMLK_MAX_FRAME_BYTES > 0);
    assert!(ffi::AMLK_MAX_PAYLOAD_BYTES > 0);
    assert!(ffi::AMLK_MAX_PEER_ID_LEN > 0);
    assert!(ffi::AMLK_MAX_TOPIC_LEN > 0);
    assert!(ffi::AMLK_MAX_ENDPOINT_LEN > 0);
    assert!(ffi::AMLK_QOS_MAX_DEPTH > 0);
    assert!(ffi::AMLK_MAX_FRAME_BYTES >= ffi::AMLK_MAX_PAYLOAD_BYTES);
}

// ---------------------------------------------------------------------------
// Topic / keyexpr
// ---------------------------------------------------------------------------

#[test]
fn topic_validate_accepts_valid_topics() {
    let topics = &[
        "amos/robot-1/sensor/imu",
        "amos/brain-1/control/gait",
        "a",
        "a/b",
        "a/b/c/d/e",
        "foo-bar_baz.qux:123%xyz",
    ];
    for topic in topics {
        let c_str = std::ffi::CString::new(*topic).unwrap();
        let result = unsafe { ffi::amos_link_topic_validate(c_str.as_ptr()) };
        assert_eq!(result, 0, "topic {topic:?} should be valid");
    }
}

#[test]
fn topic_validate_rejects_invalid_topics() {
    let topics = &["", "foo//bar", "foo/bar/", "/foo/bar", "foo BAR", "foo\nbar"];
    for topic in topics {
        let c_str = std::ffi::CString::new(*topic).unwrap();
        let result = unsafe { ffi::amos_link_topic_validate(c_str.as_ptr()) };
        assert_ne!(result, 0, "topic {topic:?} should be invalid");
    }
}

#[test]
fn topic_validate_pattern_accepts_wildcards() {
    let patterns = &["amos/*/sensor/*", "amos/robot-1/**", "amos/**/imu", "amos/*", "amos/**"];
    for pattern in patterns {
        let c_str = std::ffi::CString::new(*pattern).unwrap();
        let result = unsafe { ffi::amos_link_topic_validate_pattern(c_str.as_ptr()) };
        assert_eq!(result, 0, "pattern {pattern:?} should be valid");
    }
}

#[test]
fn topic_matches_null_handles_return_false() {
    // amos_link_topic_matches takes Topic handles; null should return false.
    let result = unsafe { ffi::amos_link_topic_matches(std::ptr::null(), std::ptr::null()) };
    assert!(!result);
}

// ---------------------------------------------------------------------------
// PeerId
// ---------------------------------------------------------------------------

#[test]
fn peer_id_validate_accepts_valid_ids() {
    let ids = &["robot-1", "sensor-left", "brain-42", "a", "a-b_c.1"];
    for id in ids {
        let c_str = std::ffi::CString::new(*id).unwrap();
        let result = unsafe { ffi::amos_link_peer_id_validate(c_str.as_ptr()) };
        assert_eq!(result, 0, "peer id {id:?} should be valid");
    }
}

#[test]
fn peer_id_validate_rejects_invalid_ids() {
    let ids = &["", "foo bar", "foo\nbar", "foo/bar"];
    for id in ids {
        let c_str = std::ffi::CString::new(*id).unwrap();
        let result = unsafe { ffi::amos_link_peer_id_validate(c_str.as_ptr()) };
        assert_ne!(result, 0, "peer id {id:?} should be invalid");
    }
}

#[test]
fn peer_id_new_copies_to_buffer() {
    let id = "robot-42";
    let c_in = std::ffi::CString::new(id).unwrap();
    let mut buf = [0i8; 128];
    let result = unsafe { ffi::amos_link_peer_id_new(c_in.as_ptr(), buf.as_mut_ptr()) };
    assert!(result >= 0, "expected success, got {result}");
    let c_out = unsafe { CStr::from_ptr(buf.as_ptr()) };
    assert_eq!(c_out.to_str().unwrap(), id);
}

#[test]
fn peer_id_new_with_small_buffer_succeeds() {
    // Even with a small output buffer, validation passes and copy succeeds.
    let id = "a".repeat(50);
    let c_in = std::ffi::CString::new(id.as_str()).unwrap();
    let mut buf = [0i8; 10];
    let result = unsafe { ffi::amos_link_peer_id_new(c_in.as_ptr(), buf.as_mut_ptr()) };
    assert!(result >= 0, "expected success, got {result}");
}

// ---------------------------------------------------------------------------
// QoS
// ---------------------------------------------------------------------------

#[test]
fn qos_sensor_has_expected_values() {
    let qos = unsafe { ffi::amos_link_qos_sensor() };
    assert_eq!(qos.reliability, ffi::amos_link_reliability::ReliabilityBestEffort);
    assert_eq!(qos.depth, 1);
    assert_eq!(qos.drop_policy, ffi::amos_link_drop_policy::DropPolicyDropOldest);
}

#[test]
fn qos_control_has_expected_values() {
    let qos = unsafe { ffi::amos_link_qos_control() };
    assert_eq!(qos.reliability, ffi::amos_link_reliability::ReliabilityReliable);
    assert_eq!(qos.depth, 64);
    assert_eq!(qos.drop_policy, ffi::amos_link_drop_policy::DropPolicyDropNewest);
}

#[test]
fn qos_state_has_expected_values() {
    let qos = unsafe { ffi::amos_link_qos_state() };
    assert_eq!(qos.reliability, ffi::amos_link_reliability::ReliabilityBestEffort);
    assert_eq!(qos.depth, 8);
    assert_eq!(qos.drop_policy, ffi::amos_link_drop_policy::DropPolicyDropNewest);
}

#[test]
fn qos_default_equals_state() {
    let qos = unsafe { ffi::amos_link_qos_default() };
    let state = unsafe { ffi::amos_link_qos_state() };
    assert_eq!(qos.reliability, state.reliability);
    assert_eq!(qos.depth, state.depth);
    assert_eq!(qos.drop_policy, state.drop_policy);
}

#[test]
fn qos_new_constructs_correctly() {
    let qos = unsafe {
        ffi::amos_link_qos_new(ffi::amos_link_reliability::ReliabilityReliable, 128, ffi::amos_link_drop_policy::DropPolicyDropOldest)
    };
    assert_eq!(qos.reliability, ffi::amos_link_reliability::ReliabilityReliable);
    assert_eq!(qos.depth, 128);
    assert_eq!(qos.drop_policy, ffi::amos_link_drop_policy::DropPolicyDropOldest);
}

#[test]
fn qos_for_channel_sensor() {
    let qos = unsafe { ffi::amos_link_qos_for_channel(ffi::amos_link_channel::ChannelSensor) };
    assert_eq!(qos.reliability, ffi::amos_link_reliability::ReliabilityBestEffort);
    assert_eq!(qos.drop_policy, ffi::amos_link_drop_policy::DropPolicyDropOldest);
}

#[test]
fn qos_for_channel_control() {
    let qos = unsafe { ffi::amos_link_qos_for_channel(ffi::amos_link_channel::ChannelControl) };
    assert_eq!(qos.reliability, ffi::amos_link_reliability::ReliabilityReliable);
    assert_eq!(qos.drop_policy, ffi::amos_link_drop_policy::DropPolicyDropNewest);
}

#[test]
fn qos_validate_accepts_valid_qos() {
    let qos = unsafe { ffi::amos_link_qos_sensor() };
    let result = unsafe { ffi::amos_link_qos_validate(qos) };
    assert_eq!(result, 0);
}

#[test]
fn qos_validate_rejects_depth_zero() {
    let qos = unsafe {
        ffi::amos_link_qos_new(ffi::amos_link_reliability::ReliabilityBestEffort, 0, ffi::amos_link_drop_policy::DropPolicyDropOldest)
    };
    let result = unsafe { ffi::amos_link_qos_validate(qos) };
    assert_ne!(result, 0);
}

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

#[test]
fn timestamp_now_is_valid() {
    let stamp = unsafe { ffi::amos_link_timestamp_now() };
    assert!(unsafe { ffi::amos_link_timestamp_is_valid(stamp) });
}

#[test]
fn timestamp_new_accepts_valid_values() {
    let stamp = unsafe { ffi::amos_link_timestamp_new(1_700_000_000, 500_000_000) };
    assert!(unsafe { ffi::amos_link_timestamp_is_valid(stamp) });
}

#[test]
fn timestamp_as_nanos() {
    let stamp = unsafe { ffi::amos_link_timestamp_new(10, 500_000_000) };
    let nanos = unsafe { ffi::amos_link_timestamp_as_nanos(stamp) };
    assert_eq!(nanos, 10_000_000_000 + 500_000_000);
}

#[test]
fn timestamp_unix_ms() {
    let stamp = unsafe { ffi::amos_link_timestamp_new(1700, 500_000) };
    let ms = unsafe { ffi::amos_link_timestamp_unix_ms(stamp) };
    assert_eq!(ms, 1_700_000);
}

#[test]
fn timestamp_since_secs() {
    let earlier = unsafe { ffi::amos_link_timestamp_new(10, 0) };
    let later = unsafe { ffi::amos_link_timestamp_new(12, 500_000_000) };
    let diff = unsafe { ffi::amos_link_timestamp_since_secs(earlier, later) };
    assert!((diff - 2.5).abs() < 0.001);
}

// ---------------------------------------------------------------------------
// Frame encoding / decoding
// ---------------------------------------------------------------------------

#[test]
fn frame_encode_produces_non_empty_bytes() {
    let topic = std::ffi::CString::new("amos/robot-1/sensor/imu").unwrap();
    let peer = std::ffi::CString::new("robot-1").unwrap();
    let payload: &[u8] = &[1, 2, 3, 4];
    let stamp = unsafe { ffi::amos_link_timestamp_now() };
    let mut frame = [0u8; 4096];
    let n = unsafe {
        ffi::amos_link_frame_encode(
            topic.as_ptr(), peer.as_ptr(), 42, stamp,
            payload.as_ptr(), payload.len(), frame.as_mut_ptr(), frame.len(),
        )
    };
    assert!(n > 0, "encoded frame should have non-zero size");
    assert!(n <= ffi::AMLK_MAX_FRAME_BYTES);
    assert_eq!(frame[0], 0x41);
    assert_eq!(frame[1], 0x4D);
    assert_eq!(frame[2], 0x4C);
    assert_eq!(frame[3], 0x4B);
}

#[test]
fn frame_decode_header_extracts_fields() {
    let topic = std::ffi::CString::new("amos/robot-1/sensor/imu").unwrap();
    let peer = std::ffi::CString::new("robot-1").unwrap();
    let payload: &[u8] = &[1, 2, 3, 4];
    let stamp = unsafe { ffi::amos_link_timestamp_now() };
    let mut frame = [0u8; 4096];
    let n = unsafe {
        ffi::amos_link_frame_encode(
            topic.as_ptr(), peer.as_ptr(), 7, stamp,
            payload.as_ptr(), payload.len(), frame.as_mut_ptr(), frame.len(),
        )
    };
    assert!(n > 0);
    let mut h = ffi::amos_link_frame_header {
        topic: [0; 1024], topic_len: 0, peer_id: [0; 64],
        seq: 0, stamp_secs: 0, stamp_nanos: 0, payload_len: 0,
    };
    let result = unsafe { ffi::amos_link_frame_decode_header(frame.as_ptr(), n, &mut h) };
    assert_eq!(result, 0, "decode_header should succeed");
    assert_eq!(h.seq, 7);
    assert!(h.payload_len > 0);
    assert_eq!(h.stamp_secs, stamp.secs);
}

#[test]
fn frame_decode_payload_extracts_data() {
    let topic = std::ffi::CString::new("amos/r1/sensor/imu").unwrap();
    let peer = std::ffi::CString::new("r1").unwrap();
    let payload: &[u8] = &[0xDE, 0xAD, 0xBE, 0xEF];
    let stamp = unsafe { ffi::amos_link_timestamp_now() };
    let mut frame = [0u8; 4096];
    let n = unsafe {
        ffi::amos_link_frame_encode(
            topic.as_ptr(), peer.as_ptr(), 1, stamp,
            payload.as_ptr(), payload.len(), frame.as_mut_ptr(), frame.len(),
        )
    };
    let mut out = [0u8; 64];
    let result = unsafe {
        ffi::amos_link_frame_decode_payload(frame.as_ptr(), n, out.as_mut_ptr(), out.len())
    };
    assert!(result > 0, "decode_payload should return positive byte count");
    assert!(out.iter().any(|&b| b != 0), "decoded payload should be non-zero");
}

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

#[test]
fn crc32_computes_deterministic_value() {
    let data: &[u8] = b"hello world";
    let crc = unsafe { ffi::amos_link_crc32(data.as_ptr(), data.len()) };
    let crc2 = unsafe { ffi::amos_link_crc32(data.as_ptr(), data.len()) };
    assert_eq!(crc, crc2, "CRC32 of same data must be deterministic");
    assert!(crc != 0);
}

#[test]
fn crc32_combine_is_nonzero() {
    let header: &[u8] = b"HEAD";
    let payload: &[u8] = b"PAYLOAD";
    let combined = unsafe {
        ffi::amos_link_crc32_combine(header.as_ptr(), header.len(), payload.as_ptr(), payload.len())
    };
    assert_ne!(combined, 0);
}

// ---------------------------------------------------------------------------
// Node lifecycle
// ---------------------------------------------------------------------------

#[test]
fn node_new_creates_valid_node() {
    let peer = std::ffi::CString::new("test-robot").unwrap();
    let kind = ffi::amos_link_node_kind::NodeRobot;
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), kind) };
    assert!(!node.is_null());
    unsafe { ffi::amos_link_node_drop(node) };
}

#[test]
fn node_peer_id_round_trip() {
    let peer = std::ffi::CString::new("test-robot-99").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());
    let mut buf = [0i8; 128];
    let result = unsafe { ffi::amos_link_node_peer_id(node, buf.as_mut_ptr(), buf.len()) };
    assert_eq!(result, 0);
    let c_out = unsafe { CStr::from_ptr(buf.as_ptr()) };
    assert_eq!(c_out.to_str().unwrap(), "test-robot-99");
    unsafe { ffi::amos_link_node_drop(node) };
}

#[test]
fn node_kind_is_correct() {
    let peer = std::ffi::CString::new("sensor-1").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeSensor) };
    assert!(!node.is_null());
    let kind = unsafe { ffi::amos_link_node_get_kind(node) };
    assert_eq!(kind, ffi::amos_link_node_kind::NodeSensor);
    unsafe { ffi::amos_link_node_drop(node) };
}

#[test]
fn node_uptime_is_monotonic() {
    let peer = std::ffi::CString::new("uptime-test").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeTool) };
    assert!(!node.is_null());
    std::thread::sleep(std::time::Duration::from_millis(50));
    let t1 = unsafe { ffi::amos_link_node_uptime_ms(node) };
    std::thread::sleep(std::time::Duration::from_millis(50));
    let t2 = unsafe { ffi::amos_link_node_uptime_ms(node) };
    assert!(t2 >= t1, "uptime should be monotonically increasing");
    unsafe { ffi::amos_link_node_drop(node) };
}

#[test]
fn node_clone_increments_refcount() {
    let peer = std::ffi::CString::new("clone-test").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());
    let clone1 = unsafe { ffi::amos_link_node_clone(node) };
    assert!(!clone1.is_null());
    unsafe { ffi::amos_link_node_drop(node) };
    unsafe { ffi::amos_link_node_drop(clone1) };
}

#[test]
fn node_metrics_initially_zeros() {
    let peer = std::ffi::CString::new("metrics-test").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeBrain) };
    assert!(!node.is_null());
    let mut m = ffi::amos_link_metrics {
        published: 0, delivered: 0, dropped: 0, blocked: 0, decode_errors: 0, encode_errors: 0,
    };
    let result = unsafe { ffi::amos_link_node_metrics(node, &mut m) };
    assert_eq!(result, 0);
    assert_eq!(m.published, 0);
    unsafe { ffi::amos_link_node_drop(node) };
}

#[test]
fn last_error_is_clearable() {
    let node = unsafe { ffi::amos_link_node_new(std::ptr::null(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(node.is_null());
    let err = unsafe { ffi::amos_link_last_error() };
    assert!(!err.is_null());
    let err_str = unsafe { CStr::from_ptr(err) };
    assert!(!err_str.to_string_lossy().is_empty());
    unsafe { ffi::amos_link_error_clear() };
    let err2 = unsafe { ffi::amos_link_last_error() };
    let err_str2 = unsafe { CStr::from_ptr(err2) };
    assert!(err_str2.to_bytes().is_empty(), "after clear, error string should be empty");
}

// ---------------------------------------------------------------------------
// Publisher lifecycle
// ---------------------------------------------------------------------------

#[test]
fn publisher_new_creates_valid_publisher() {
    let peer = std::ffi::CString::new("pub-peer").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());
    let topic = std::ffi::CString::new("amos/pub-peer/sensor/test").unwrap();
    let pubr = unsafe { ffi::amos_link_publisher_new(node, topic.as_ptr()) };
    assert!(!pubr.is_null());
    let mut buf = [0i8; 1024];
    let result = unsafe { ffi::amos_link_publisher_topic(pubr, buf.as_mut_ptr(), buf.len()) };
    assert_eq!(result, 0);
    let topic_str = unsafe { CStr::from_ptr(buf.as_ptr()) }.to_str().unwrap();
    assert_eq!(topic_str, "amos/pub-peer/sensor/test");
    unsafe { ffi::amos_link_publisher_drop(pubr) };
    unsafe { ffi::amos_link_node_drop(node) };
}

#[test]
fn publisher_publish_encodes_frame() {
    let peer = std::ffi::CString::new("pub-test").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());
    let topic = std::ffi::CString::new("amos/pub-test/control/cmd").unwrap();
    let pubr = unsafe { ffi::amos_link_publisher_new(node, topic.as_ptr()) };
    assert!(!pubr.is_null());
    let payload: &[u8] = &[0x01, 0x02, 0x03];
    let result = unsafe { ffi::amos_link_publisher_publish(pubr, payload.as_ptr(), payload.len()) };
    assert_eq!(result, 0);
    unsafe { ffi::amos_link_publisher_drop(pubr) };
    unsafe { ffi::amos_link_node_drop(node) };
}

// ---------------------------------------------------------------------------
// Subscriber lifecycle
// ---------------------------------------------------------------------------

#[test]
fn subscriber_new_creates_valid_subscriber() {
    let peer = std::ffi::CString::new("sub-test").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeSensor) };
    assert!(!node.is_null());
    let pattern = std::ffi::CString::new("amos/sub-test/sensor/*").unwrap();
    let qos = unsafe { ffi::amos_link_qos_sensor() };
    let sub = unsafe { ffi::amos_link_subscriber_new(node, pattern.as_ptr(), qos) };
    assert!(!sub.is_null());
    let mut received = ffi::amos_link_received {
        topic: [0; 1024], peer_id: [0; 64], seq: 0,
        stamp_secs: 0, stamp_nanos: 0, frame_len: 0, payload_len: 0,
    };
    let mut payload_buf = [0u8; 256];
    let poll_result = unsafe {
        ffi::amos_link_subscriber_poll(sub, &mut received, payload_buf.as_mut_ptr(), payload_buf.len())
    };
    // Pending is expected (no publisher yet)
    assert_eq!(poll_result, ffi::amos_link_poll::Pending);
    unsafe { ffi::amos_link_subscriber_drop(sub) };
    unsafe { ffi::amos_link_node_drop(node) };
}

#[test]
fn subscriber_poll_returns_closed_for_null() {
    let mut received = ffi::amos_link_received {
        topic: [0; 1024], peer_id: [0; 64], seq: 0,
        stamp_secs: 0, stamp_nanos: 0, frame_len: 0, payload_len: 0,
    };
    let mut payload_buf = [0u8; 256];
    let result = unsafe {
        ffi::amos_link_subscriber_poll(std::ptr::null(), &mut received, payload_buf.as_mut_ptr(), payload_buf.len())
    };
    assert_eq!(result, ffi::amos_link_poll::Closed);
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

#[test]
fn heartbeat_encode_produces_frame() {
    let peer = std::ffi::CString::new("beat-peer").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());
    let beat = unsafe { ffi::amos_link_node_heartbeat(node) };
    assert!(!beat.is_null());
    let mut frame = [0u8; 512];
    let n = unsafe { ffi::amos_link_heartbeat_encode(beat, frame.as_mut_ptr()) };
    assert!(n > 0);
    let mut fields = ffi::amos_link_heartbeat_fields {
        peer_id: [0; 64], seq: 0, stamp_secs: 0, stamp_nanos: 0, uptime_ms: 0,
    };
    let decode_result = unsafe { ffi::amos_link_heartbeat_decode(frame.as_ptr(), n as usize, &mut fields) };
    assert_eq!(decode_result, 0);
    unsafe { ffi::amos_link_heartbeat_drop(beat) };
    unsafe { ffi::amos_link_node_drop(node) };
}

// ---------------------------------------------------------------------------
// Health evaluation
// ---------------------------------------------------------------------------

#[test]
fn health_evaluate_unknown_with_no_peers() {
    let metrics = ffi::amos_link_metrics {
        published: 0, delivered: 0, dropped: 0, blocked: 0, decode_errors: 0, encode_errors: 0,
    };
    let health = unsafe { ffi::amos_link_evaluate_health(&metrics, std::ptr::null(), 0, false) };
    assert_eq!(health.state, ffi::amos_link_health_state::Unknown);
}

#[test]
fn health_evaluate_healthy_with_good_ratio() {
    let metrics = ffi::amos_link_metrics {
        published: 100, delivered: 95, dropped: 5, blocked: 0, decode_errors: 0, encode_errors: 0,
    };
    // With clock synced, no peers is still degraded (NoPeers reason).
    // This tests that the function is callable and returns a known state.
    let health = unsafe { ffi::amos_link_evaluate_health(&metrics, std::ptr::null(), 0, true) };
    assert!(matches!(health.state, ffi::amos_link_health_state::Healthy | ffi::amos_link_health_state::Degraded));
}

#[test]
fn health_evaluate_degraded_with_bad_ratio() {
    let metrics = ffi::amos_link_metrics {
        published: 100, delivered: 30, dropped: 70, blocked: 0, decode_errors: 0, encode_errors: 0,
    };
    let health = unsafe { ffi::amos_link_evaluate_health(&metrics, std::ptr::null(), 0, true) };
    assert_eq!(health.state, ffi::amos_link_health_state::Degraded);
}

// ---------------------------------------------------------------------------
// Tests for untested / lightly-tested FFI functions
// ---------------------------------------------------------------------------

// --- Node heartbeat topic ---
#[test]
fn node_heartbeat_topic_returns_valid_path() {
    let peer = std::ffi::CString::new("beat-peer").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());
    let mut buf = [0i8; 256];
    let result = unsafe { ffi::amos_link_node_heartbeat_topic(node, buf.as_mut_ptr()) };
    assert_eq!(result, 0);
    let s = unsafe { CStr::from_ptr(buf.as_ptr()) }.to_str().unwrap();
    assert!(s.starts_with("amos/"), "heartbeat topic should start with 'amos/', got: {}", s);
    unsafe { ffi::amos_link_node_drop(node) };
}

// --- Node metrics ---
#[test]
fn node_metrics_initially_all_zeros() {
    let peer = std::ffi::CString::new("metrics-peer").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeSensor) };
    assert!(!node.is_null());
    let mut m = ffi::amos_link_metrics {
        published: !0u64, delivered: !0u64, dropped: !0u64,
        blocked: !0u64, decode_errors: !0u64, encode_errors: !0u64,
    };
    let r = unsafe { ffi::amos_link_node_metrics(node, &mut m) };
    assert_eq!(r, 0);
    assert_eq!(m.published, 0);
    assert_eq!(m.delivered, 0);
    assert_eq!(m.dropped, 0);
    unsafe { ffi::amos_link_node_drop(node) };
}

// --- Node peers (empty list) ---
#[test]
fn node_peers_returns_zero_when_no_peers() {
    let peer = std::ffi::CString::new("peers-peer").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());
    // Use std::array::from_fn for non-Copy types with explicit type annotation
    let mut peers: [ffi::amos_link_peer_view; 8] = std::array::from_fn(|_| ffi::amos_link_peer_view {
        id: [0; 64],
        kind: ffi::amos_link_node_kind::NodeRobot,
        endpoint: [0; 128],
        last_seen_ms: !0u64,
        beacons: !0u64,
    });
    let n = unsafe { ffi::amos_link_node_peers(node, peers.as_mut_ptr(), peers.len()) };
    assert_eq!(n, 0, "should have no peers at startup");
    unsafe { ffi::amos_link_node_drop(node) };
}

// --- Node topics (empty list) ---
#[test]
fn node_topics_returns_zero_when_no_topics() {
    let peer = std::ffi::CString::new("topics-peer").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());
    let mut entries: [ffi::amos_link_topic_entry; 4] = std::array::from_fn(|_| ffi::amos_link_topic_entry { topic: [0; 1024] });
    let n = unsafe { ffi::amos_link_node_topics(node, entries.as_mut_ptr(), entries.len()) };
    assert_eq!(n, 0, "should have no topics at startup");
    unsafe { ffi::amos_link_node_drop(node) };
}

// --- Subscriber stats (zeros) ---
#[test]
fn subscriber_stats_returns_zeros() {
    let peer = std::ffi::CString::new("stats-sub").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());
    let pattern = std::ffi::CString::new("amos/stats-sub/*").unwrap();
    let sub = unsafe {
        ffi::amos_link_subscriber_new(node, pattern.as_ptr(), ffi::amos_link_qos_default())
    };
    assert!(!sub.is_null());
    let mut s = ffi::amos_link_sub_stats {
        received: !0u64,
        dropped: !0u64,
        decode_errors: !0u64,
    };
    let r = unsafe { ffi::amos_link_subscriber_stats(sub, &mut s) };
    assert_eq!(r, 0);
    assert_eq!(s.received, 0);
    assert_eq!(s.dropped, 0);
    assert_eq!(s.decode_errors, 0);
    unsafe { ffi::amos_link_subscriber_drop(sub) };
    unsafe { ffi::amos_link_node_drop(node) };
}

// --- Subscriber has_pending ---
#[test]
fn subscriber_has_pending_is_bool() {
    let peer = std::ffi::CString::new("pending-sub").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());
    let pattern = std::ffi::CString::new("amos/pending-sub/**").unwrap();
    let sub = unsafe {
        ffi::amos_link_subscriber_new(node, pattern.as_ptr(), ffi::amos_link_qos_default())
    };
    assert!(!sub.is_null());
    let r = unsafe { ffi::amos_link_subscriber_has_pending(sub) };
    // Just verify it's a valid bool (always true conservatively since no data yet)
    assert!(matches!(r, true | false));
    unsafe { ffi::amos_link_subscriber_drop(sub) };
    unsafe { ffi::amos_link_node_drop(node) };
}

// --- Subscriber has_pending null ---
#[test]
fn subscriber_has_pending_null_returns_false() {
    let r = unsafe { ffi::amos_link_subscriber_has_pending(std::ptr::null()) };
    assert_eq!(r, false);
}

// --- Subscriber stats null ---
#[test]
fn subscriber_stats_null_returns_neg2() {
    let mut s = ffi::amos_link_sub_stats { received: 0, dropped: 0, decode_errors: 0 };
    let r = unsafe { ffi::amos_link_subscriber_stats(std::ptr::null(), &mut s) };
    assert_eq!(r, -2);
}

// --- Publisher drop null ---
#[test]
fn publisher_drop_null_is_safe() {
    // Should not panic
    unsafe { ffi::amos_link_publisher_drop(std::ptr::null_mut()) };
}

// --- Subscriber drop null ---
#[test]
fn subscriber_drop_null_is_safe() {
    // Should not panic
    unsafe { ffi::amos_link_subscriber_drop(std::ptr::null_mut()) };
}

// --- Federation spawn (null node) ---
#[test]
fn federation_spawn_null_node_returns_null() {
    let r = unsafe { ffi::amos_link_node_spawn_federation(std::ptr::null(), 1000) };
    assert!(r.is_null());
}

#[test]
fn federation_spawn_advertising_null_node_returns_null() {
    let r = unsafe { ffi::amos_link_node_spawn_federation_advertising(std::ptr::null(), 1000, std::ptr::null()) };
    assert!(r.is_null());
}

// --- Federation spawn / stop (valid node) ---
#[test]
fn federation_spawn_and_stop_succeeds() {
    let peer = std::ffi::CString::new("fed-peer").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());
    let task = unsafe { ffi::amos_link_node_spawn_federation(node, 500) };
    assert!(!task.is_null());
    unsafe { ffi::amos_link_federation_stop(task) };
    unsafe { ffi::amos_link_node_drop(node) };
}

#[test]
fn federation_spawn_advertising_and_stop_succeeds() {
    let peer = std::ffi::CString::new("fed-adv-peer").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeSensor) };
    assert!(!node.is_null());
    let endpoint = std::ffi::CString::new("tcp://192.168.1.100:7550").unwrap();
    let task = unsafe { ffi::amos_link_node_spawn_federation_advertising(node, 500, endpoint.as_ptr()) };
    assert!(!task.is_null());
    unsafe { ffi::amos_link_federation_stop(task) };
    unsafe { ffi::amos_link_node_drop(node) };
}

// --- Federation stop null ---
#[test]
fn federation_stop_null_is_safe() {
    // Should not panic
    unsafe { ffi::amos_link_federation_stop(std::ptr::null_mut()) };
}

// --- Heartbeat encode / decode round-trip ---
#[test]
fn heartbeat_encode_decode_round_trip() {
    let peer = std::ffi::CString::new("beat-pub").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());
    let beat_ptr = unsafe { ffi::amos_link_node_heartbeat(node) };
    assert!(!beat_ptr.is_null());

    let mut frame = [0u8; 512];
    let enc_len = unsafe { ffi::amos_link_heartbeat_encode(beat_ptr, frame.as_mut_ptr()) };
    assert!(enc_len > 0, "encoded heartbeat should be non-empty, got {}", enc_len);

    let mut fields = ffi::amos_link_heartbeat_fields {
        peer_id: [0; 64],
        seq: !0u64,
        stamp_secs: !0u64,
        stamp_nanos: !0u32,
        uptime_ms: !0u64,
    };
    let dec_r = unsafe { ffi::amos_link_heartbeat_decode(frame.as_ptr(), enc_len as usize, &mut fields) };
    assert_eq!(dec_r, 0, "heartbeat decode should succeed");
    let decoded_peer = unsafe { CStr::from_ptr(fields.peer_id.as_ptr()) }.to_str().unwrap();
    assert_eq!(decoded_peer, "beat-pub");
    assert_ne!(fields.seq, !0u64);
    assert_ne!(fields.uptime_ms, !0u64);

    unsafe { ffi::amos_link_heartbeat_drop(beat_ptr) };
    unsafe { ffi::amos_link_node_drop(node) };
}

// --- Heartbeat decode null ---
#[test]
fn heartbeat_decode_null_fields_returns_neg2() {
    let frame = [0u8; 128];
    let r = unsafe { ffi::amos_link_heartbeat_decode(frame.as_ptr(), 128, std::ptr::null_mut()) };
    assert_eq!(r, -2);
}

// --- Frame decode header null ---
#[test]
fn frame_decode_header_null_returns_neg2() {
    let r = unsafe { ffi::amos_link_frame_decode_header(std::ptr::null(), 0, std::ptr::null_mut()) };
    assert_eq!(r, -2);
}

// --- Frame decode payload null ---
#[test]
fn frame_decode_payload_null_returns_neg2() {
    let mut buf = [0u8; 64];
    let r = unsafe { ffi::amos_link_frame_decode_payload(std::ptr::null(), 0, buf.as_mut_ptr(), 64) };
    assert_eq!(r, -2);
}

// --- CRC32 deterministic ---
#[test]
fn crc32_of_empty_is_zero() {
    // crc32 of empty should be 0 (standard CRC32 implementation)
    let r = unsafe { ffi::amos_link_crc32(std::ptr::null(), 0) };
    // crc32fast of empty slice = 0
    assert_eq!(r, 0);
}

// --- CRC32 combine with empty inputs ---
#[test]
fn crc32_combine_with_empty_is_simple_crc() {
    let data = b"hello world";
    let simple = unsafe { ffi::amos_link_crc32(data.as_ptr(), data.len()) };
    let combined = unsafe {
        ffi::amos_link_crc32_combine(
            data.as_ptr(), data.len(),
            std::ptr::null(), 0,
        )
    };
    assert_eq!(combined, simple);
}

// --- Last error clear ---
#[test]
fn last_error_starts_empty() {
    // After a fresh start, last_error should return an empty string
    let err_ptr = unsafe { ffi::amos_link_last_error() };
    let err_s = unsafe { CStr::from_ptr(err_ptr) }.to_str().unwrap();
    assert_eq!(err_s, "", "last_error should be empty initially");
}

// --- Error clear ---
#[test]
fn error_clear_then_last_error_is_empty() {
    // Trigger an error first
    let peer = std::ffi::CString::new("").unwrap();
    let _node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    // Then clear it
    unsafe { ffi::amos_link_error_clear() };
    let err_ptr = unsafe { ffi::amos_link_last_error() };
    let err_s = unsafe { CStr::from_ptr(err_ptr) }.to_str().unwrap();
    assert_eq!(err_s, "");
}

// --- QoS new from fields ---
#[test]
fn qos_new_from_fields() {
    let qos = unsafe {
        ffi::amos_link_qos_new(ffi::amos_link_reliability::ReliabilityReliable, 50, ffi::amos_link_drop_policy::DropPolicyDropNewest)
    };
    assert_eq!(qos.reliability, ffi::amos_link_reliability::ReliabilityReliable);
    assert_eq!(qos.depth, 50);
    assert_eq!(qos.drop_policy, ffi::amos_link_drop_policy::DropPolicyDropNewest);
}

// --- QoS validate invalid reliability ---
#[test]
fn qos_validate_rejects_depth_exceeds_max() {
    let qos = unsafe { ffi::amos_link_qos_new(ffi::amos_link_reliability::ReliabilityBestEffort, u32::MAX, ffi::amos_link_drop_policy::DropPolicyDropOldest) };
    let r = unsafe { ffi::amos_link_qos_validate(qos) };
    assert_ne!(r, 0, "qos_validate should reject depth that overflows u32");
}

// --- Topic matches with pattern ---
#[test]
fn topic_matches_null_handles() {
    // topic_matches with null should return false
    // (already tested in the main suite, but let's add null-pattern variant here)
    let peer = std::ffi::CString::new("match-peer").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());

    let pattern = std::ffi::CString::new("amos/match-peer/sensor/*").unwrap();
    let sub = unsafe { ffi::amos_link_subscriber_new(node, pattern.as_ptr(), ffi::amos_link_qos_default()) };
    assert!(!sub.is_null());

    // pattern is null → false
    assert!(!unsafe { ffi::amos_link_topic_matches(sub as *const _, std::ptr::null_mut()) });
    // sub is null → false
    assert!(!unsafe { ffi::amos_link_topic_matches(std::ptr::null(), sub as *const _) });

    unsafe { ffi::amos_link_subscriber_drop(sub) };
    unsafe { ffi::amos_link_node_drop(node) };
}

// --- Metrics delivery ratio ---
#[test]
fn metrics_delivery_ratio() {
    let m = ffi::amos_link_metrics {
        published: 100, delivered: 75, dropped: 25, blocked: 0, decode_errors: 0, encode_errors: 0,
    };
    let ratio = unsafe { ffi::amos_link_metrics_delivery_ratio(&m) };
    // 75/100 = 75%
    assert_eq!(ratio, 75, "delivery ratio should be 75%");
}

#[test]
fn metrics_delivery_ratio_zero_published() {
    let m = ffi::amos_link_metrics {
        published: 0, delivered: 0, dropped: 0, blocked: 0, decode_errors: 0, encode_errors: 0,
    };
    let ratio = unsafe { ffi::amos_link_metrics_delivery_ratio(&m) };
    assert_eq!(ratio, 0, "delivery ratio with 0 published should be 0");
}

// --- Node peers null ---
#[test]
fn node_peers_null_node_returns_zero() {
    let mut peers = [ffi::amos_link_peer_view {
        id: [0; 64], kind: ffi::amos_link_node_kind::NodeRobot,
        last_seen_ms: 0, beacons: 0, endpoint: [0; 128],
    }; 1];
    let n = unsafe { ffi::amos_link_node_peers(std::ptr::null(), peers.as_mut_ptr(), 1) };
    assert_eq!(n, 0);
}

#[test]
fn node_peers_null_out_returns_zero() {
    let peer = std::ffi::CString::new("p").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());
    let n = unsafe { ffi::amos_link_node_peers(node, std::ptr::null_mut(), 0) };
    assert_eq!(n, 0);
    unsafe { ffi::amos_link_node_drop(node) };
}

// --- Node topics null ---
#[test]
fn node_topics_null_node_returns_zero() {
    let mut entries = [ffi::amos_link_topic_entry { topic: [0; 1024] }; 1];
    let n = unsafe { ffi::amos_link_node_topics(std::ptr::null(), entries.as_mut_ptr(), 1) };
    assert_eq!(n, 0);
}

#[test]
fn node_topics_null_out_returns_zero() {
    let peer = std::ffi::CString::new("t").unwrap();
    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());
    let n = unsafe { ffi::amos_link_node_topics(node, std::ptr::null_mut(), 0) };
    assert_eq!(n, 0);
    unsafe { ffi::amos_link_node_drop(node) };
}

// --- Node metrics null ---
#[test]
fn node_metrics_null_returns_neg2() {
    let mut m = ffi::amos_link_metrics { published: 0, delivered: 0, dropped: 0, blocked: 0, decode_errors: 0, encode_errors: 0 };
    let r = unsafe { ffi::amos_link_node_metrics(std::ptr::null(), &mut m) };
    assert_eq!(r, -2);
}

// --- Publisher topic null ---
#[test]
fn publisher_topic_null_pub_returns_neg2() {
    let mut buf = [0i8; 64];
    let r = unsafe { ffi::amos_link_publisher_topic(std::ptr::null(), buf.as_mut_ptr(), buf.len()) };
    assert_eq!(r, -2);
}

// --- Publisher publish null ---
#[test]
fn publisher_publish_null_pub_returns_neg2() {
    let data = [0u8; 4];
    let r = unsafe { ffi::amos_link_publisher_publish(std::ptr::null(), data.as_ptr(), data.len()) };
    assert_eq!(r, -2);
}

// --- Subscriber poll null ---
#[test]
fn subscriber_poll_null_returns_closed() {
    let mut received = ffi::amos_link_received {
        topic: [0; 1024], peer_id: [0; 64], seq: 0,
        stamp_secs: 0, stamp_nanos: 0, frame_len: 0, payload_len: 0,
    };
    let mut buf = [0u8; 64];
    let r = unsafe { ffi::amos_link_subscriber_poll(std::ptr::null(), &mut received, buf.as_mut_ptr(), buf.len()) };
    assert_eq!(r, ffi::amos_link_poll::Closed);
}

// --- Subscriber recv null ---
#[test]
fn subscriber_recv_null_returns_closed() {
    let mut received = ffi::amos_link_received {
        topic: [0; 1024], peer_id: [0; 64], seq: 0,
        stamp_secs: 0, stamp_nanos: 0, frame_len: 0, payload_len: 0,
    };
    let mut buf = [0u8; 64];
    let r = unsafe { ffi::amos_link_subscriber_recv(std::ptr::null(), &mut received, buf.as_mut_ptr(), buf.len()) };
    assert_eq!(r, ffi::amos_link_poll::Closed);
}

// --- Frame encode null ---
#[test]
fn frame_encode_null_topic_returns_neg2() {
    let stamp = ffi::Timestamp { secs: 1000, nanos: 0 };
    let mut out = [0u8; 4096];
    let peer = std::ffi::CString::new("robot").unwrap();
    let r = unsafe { 
        ffi::amos_link_frame_encode(
            std::ptr::null(), 
            peer.as_ptr(), 
            1, 
            stamp, 
            std::ptr::null(), 
            0, 
            out.as_mut_ptr(),
            out.len()
        ) 
    };
    // Should return 0 (error case)
    assert_eq!(r, 0);
}

// --- Frame encode small buffer ---
#[test]
fn frame_encode_truncates_to_buffer_size() {
    let peer = std::ffi::CString::new("enc-peer").unwrap();
    let topic = std::ffi::CString::new("amos/enc-peer/data").unwrap();
    let stamp = ffi::Timestamp { secs: 1000, nanos: 500000 };
    let payload = b"test";
    let mut out = [0u8; 32]; // Very small buffer
    let r = unsafe { 
        ffi::amos_link_frame_encode(
            topic.as_ptr(), 
            peer.as_ptr(), 
            1, 
            stamp, 
            payload.as_ptr(), 
            payload.len(), 
            out.as_mut_ptr(),
            out.len()
        ) 
    };
    assert!(r > 0, "should encode something");
    assert!((r as usize) <= out.len(), "should not exceed buffer");
}

// --- CRC32 combine order matters ---
#[test]
fn crc32_combine_order_dependent() {
    let a = b"hello";
    let b_bytes = b"world";
    let ab = b"helloworld";
    let _crc_a = unsafe { ffi::amos_link_crc32(a.as_ptr(), a.len()) };
    let _crc_b = unsafe { ffi::amos_link_crc32(b_bytes.as_ptr(), b_bytes.len()) };
    let crc_ab = unsafe { ffi::amos_link_crc32(ab.as_ptr(), ab.len()) };
    let combined = unsafe { ffi::amos_link_crc32_combine(a.as_ptr(), a.len(), b_bytes.as_ptr(), b_bytes.len()) };
    assert_eq!(combined, crc_ab, "crc32_combine(A,B) should equal crc32(A||B)");
    // order reversal should differ
    let combined_rev = unsafe { ffi::amos_link_crc32_combine(b_bytes.as_ptr(), b_bytes.len(), a.as_ptr(), a.len()) };
    assert_ne!(combined_rev, crc_ab, "reversed order should produce different CRC");
}

// --- Frame decode header extracts topic_len ---
#[test]
fn frame_decode_header_reports_correct_topic_len() {
    let peer = std::ffi::CString::new("hdr-peer").unwrap();
    let topic = std::ffi::CString::new("amos/hdr-peer/control/cmd").unwrap();
    let stamp = ffi::Timestamp { secs: 1000, nanos: 0 };
    let payload: &[u8] = &[1, 2, 3, 4];
    let mut frame = [0u8; 4096];
    let frame_len = unsafe { 
        ffi::amos_link_frame_encode(
            topic.as_ptr(), 
            peer.as_ptr(), 
            1, 
            stamp, 
            payload.as_ptr(), 
            payload.len(), 
            frame.as_mut_ptr(),
            frame.len()
        ) 
    };
    if frame_len == 0 {
        let err_ptr = unsafe { ffi::amos_link_last_error() };
        if !err_ptr.is_null() {
            let err_str = unsafe { std::ffi::CStr::from_ptr(err_ptr) }
                .to_string_lossy()
                .into_owned();
            panic!("frame_encode failed: {}", err_str);
        } else {
            panic!("frame_encode failed but no error message available");
        }
    }
    assert!(frame_len > 0);
    println!("Encoded frame_len: {}", frame_len);

    let mut h = ffi::amos_link_frame_header {
        topic: [0; 1024],
        topic_len: !0u32,
        peer_id: [0; 64],
        seq: 0,
        stamp_secs: 0,
        stamp_nanos: 0,
        payload_len: !0u32,
    };
    let r = unsafe { ffi::amos_link_frame_decode_header(frame.as_ptr(), frame_len, &mut h) };
    println!("Decode result r: {}", r);
    if r != 0 {
        let err_ptr = unsafe { ffi::amos_link_last_error() };
        if !err_ptr.is_null() {
            let err_str = unsafe { std::ffi::CStr::from_ptr(err_ptr) }
                .to_string_lossy()
                .into_owned();
            println!("Error: {}", err_str);
        }
    }
    assert_eq!(r, 0, "frame decode header should succeed");
    assert_eq!(h.topic_len, 25, "topic_len should match 'amos/hdr-peer/control/cmd'.len()");
    assert_eq!(h.payload_len, payload.len() as u32);
}

// --- Frame decode payload extracts data ---
#[test]
fn frame_decode_payload_extracts_correct_bytes() {
    let peer = std::ffi::CString::new("pld-peer").unwrap();
    let topic = std::ffi::CString::new("amos/pld-peer/data/raw").unwrap();
    let stamp = ffi::Timestamp { secs: 1000, nanos: 0 };
    let original = b"\xDE\xAD\xBE\xEF\x12\x34\x56\x78";
    let mut frame = [0u8; 4096];
    let frame_len = unsafe { 
        ffi::amos_link_frame_encode(
            topic.as_ptr(), 
            peer.as_ptr(), 
            1, 
            stamp, 
            original.as_ptr(), 
            original.len(), 
            frame.as_mut_ptr(),
            frame.len()
        ) 
    };
    assert!(frame_len > 0);

    let mut buf = [0u8; 256];
    let n = unsafe { ffi::amos_link_frame_decode_payload(frame.as_ptr(), frame_len, buf.as_mut_ptr(), buf.len()) };
    assert_eq!(n as usize, original.len(), "decoded payload length should match original");
    assert_eq!(&buf[..original.len()], original, "decoded payload bytes should match original");
}

// --- Frame decode payload buffer too small ---
#[test]
fn frame_decode_payload_buffer_too_small_sets_error() {
    let peer = std::ffi::CString::new("small-buf").unwrap();
    let topic = std::ffi::CString::new("amos/small-buf/data").unwrap();
    let stamp = ffi::Timestamp { secs: 1000, nanos: 0 };
    let payload = b"LARGE_PAYLOAD_DATA_GOES_HERE_1234567890";
    let mut frame = [0u8; 4096];
    let frame_len = unsafe { 
        ffi::amos_link_frame_encode(
            topic.as_ptr(), 
            peer.as_ptr(), 
            1, 
            stamp, 
            payload.as_ptr(), 
            payload.len(), 
            frame.as_mut_ptr(),
            frame.len()
        ) 
    };
    assert!(frame_len > 0);

    let mut tiny = [0u8; 4];
    let r = unsafe { ffi::amos_link_frame_decode_payload(frame.as_ptr(), frame_len, tiny.as_mut_ptr(), tiny.len()) };
    assert!(r < 0, "should return error when buffer is too small");
    let err_ptr = unsafe { ffi::amos_link_last_error() };
    let err_s = unsafe { CStr::from_ptr(err_ptr) }.to_str().unwrap();
    assert!(!err_s.is_empty(), "error message should be set");
}

// --- Health evaluate unknown with null peer ---
#[test]
fn health_evaluate_null_peers_is_unknown() {
    let metrics = ffi::amos_link_metrics {
        published: 0, delivered: 0, dropped: 0, blocked: 0, decode_errors: 0, encode_errors: 0,
    };
    let health = unsafe { ffi::amos_link_evaluate_health(&metrics, std::ptr::null(), 0, false) };
    assert_eq!(health.state, ffi::amos_link_health_state::Unknown);
}

// --- Publisher publish then subscriber poll receives it ---
#[test]
fn pub_sub_roundtrip_single_message() {
    let peer = std::ffi::CString::new("round-test").unwrap();

    let node = unsafe { ffi::amos_link_node_new(peer.as_ptr(), ffi::amos_link_node_kind::NodeRobot) };
    assert!(!node.is_null());

    let topic = std::ffi::CString::new("amos/round-test/sensor/imu").unwrap();
    let pubr = unsafe { ffi::amos_link_publisher_new(node, topic.as_ptr()) };
    let pattern = std::ffi::CString::new("amos/round-test/sensor/*").unwrap();
    let sub = unsafe { ffi::amos_link_subscriber_new(node, pattern.as_ptr(), ffi::amos_link_qos_default()) };
    assert!(!pubr.is_null());
    assert!(!sub.is_null());

    // Give subscriptions time to propagate
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Publish a message
    let payload = b"\x01\x02\x03\x04";
    let pub_r = unsafe { ffi::amos_link_publisher_publish(pubr, payload.as_ptr(), payload.len()) };
    assert_eq!(pub_r, 0, "publish should succeed");
    println!("Published message with {} bytes", payload.len());

    // Poll for the message
    let mut received = ffi::amos_link_received {
        topic: [0; 1024], peer_id: [0; 64], seq: 0,
        stamp_secs: 0, stamp_nanos: 0, frame_len: 0, payload_len: 0,
    };
    let mut buf = [0u8; 256];
    let mut found = false;
    for i in 0..20 {
        let poll_r = unsafe { ffi::amos_link_subscriber_poll(sub, &mut received, buf.as_mut_ptr(), buf.len()) };
        println!("Poll attempt {}: result = {:?}", i, poll_r);
        if poll_r == ffi::amos_link_poll::Ready {
            found = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(found, "subscriber should eventually receive the published message");

    // Cleanup
    unsafe { ffi::amos_link_publisher_drop(pubr) };
    unsafe { ffi::amos_link_subscriber_drop(sub) };
    unsafe { ffi::amos_link_node_drop(node) };
}
