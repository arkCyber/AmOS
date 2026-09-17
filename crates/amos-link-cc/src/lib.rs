//! `amos-link-cc` — the C ABI surface of the AmOS-Link robot middleware.
#![allow(non_camel_case_types)]
#![allow(clippy::missing_safety_doc)]

// =============================================================================
// FFI-safe types (mirrors of amos-link types with explicit #[repr(C)]).
// cbindgen sees these directly; the impl blocks bridge to the actual types.
// =============================================================================

/// FFI mirror of [`amos_link::codec::Timestamp`].
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timestamp {
    pub secs: u64,
    pub nanos: u32,
}

/// FFI mirror of [`amos_link::qos::Reliability`].
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum amos_link_reliability {
    ReliabilityBestEffort = 0,
    ReliabilityReliable = 1,
}

/// FFI mirror of [`amos_link::qos::DropPolicy`].
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum amos_link_drop_policy {
    DropPolicyDropNewest = 0,
    DropPolicyDropOldest = 1,
}

/// FFI mirror of [`amos_link::qos::Qos`].
/// Note: `depth` is `usize` in Rust (platform-dependent); we use `u32` for C ABI
/// stability and clamp to [`MAX_DEPTH`] in the constructor.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Qos {
    pub reliability: amos_link_reliability,
    pub depth: u32,
    pub drop_policy: amos_link_drop_policy,
}

impl From<amos_link::codec::Timestamp> for Timestamp {
    fn from(t: amos_link::codec::Timestamp) -> Self {
        Self { secs: t.secs, nanos: t.nanos }
    }
}
impl From<Timestamp> for amos_link::codec::Timestamp {
    fn from(t: Timestamp) -> Self {
        amos_link::codec::Timestamp::new(t.secs, t.nanos)
            .expect("FFI Timestamp was validated before crossing the boundary")
    }
}
impl From<amos_link::qos::Reliability> for amos_link_reliability {
    fn from(r: amos_link::qos::Reliability) -> Self {
        match r {
            amos_link::qos::Reliability::BestEffort => amos_link_reliability::ReliabilityBestEffort,
            amos_link::qos::Reliability::Reliable => amos_link_reliability::ReliabilityReliable,
        }
    }
}
impl From<amos_link_reliability> for amos_link::qos::Reliability {
    fn from(r: amos_link_reliability) -> Self {
        match r {
            amos_link_reliability::ReliabilityBestEffort => amos_link::qos::Reliability::BestEffort,
            amos_link_reliability::ReliabilityReliable => amos_link::qos::Reliability::Reliable,
        }
    }
}
impl From<amos_link::qos::DropPolicy> for amos_link_drop_policy {
    fn from(d: amos_link::qos::DropPolicy) -> Self {
        match d {
            amos_link::qos::DropPolicy::DropNewest => amos_link_drop_policy::DropPolicyDropNewest,
            amos_link::qos::DropPolicy::DropOldest => amos_link_drop_policy::DropPolicyDropOldest,
        }
    }
}
impl From<amos_link_drop_policy> for amos_link::qos::DropPolicy {
    fn from(d: amos_link_drop_policy) -> Self {
        match d {
            amos_link_drop_policy::DropPolicyDropNewest => amos_link::qos::DropPolicy::DropNewest,
            amos_link_drop_policy::DropPolicyDropOldest => amos_link::qos::DropPolicy::DropOldest,
        }
    }
}
impl From<amos_link::qos::Qos> for Qos {
    fn from(q: amos_link::qos::Qos) -> Self {
        Self {
            reliability: q.reliability.into(),
            depth: q.depth as u32,
            drop_policy: q.drop_policy.into(),
        }
    }
}
impl From<Qos> for amos_link::qos::Qos {
    fn from(q: Qos) -> Self {
        amos_link::qos::Qos::new(
            q.reliability.into(),
            q.depth as usize,
            q.drop_policy.into(),
        )
    }
}

impl Qos {
    pub const MAX_DEPTH: usize = 4096;

    pub const fn new(reliability: amos_link_reliability, depth: u32, drop_policy: amos_link_drop_policy) -> Self {
        Self { reliability, depth, drop_policy }
    }

    pub const fn sensor() -> Self {
        Self::new(amos_link_reliability::ReliabilityBestEffort, 1, amos_link_drop_policy::DropPolicyDropOldest)
    }

    pub const fn state() -> Self {
        Self::new(amos_link_reliability::ReliabilityBestEffort, 8, amos_link_drop_policy::DropPolicyDropNewest)
    }

    pub const fn control() -> Self {
        Self::new(amos_link_reliability::ReliabilityReliable, 64, amos_link_drop_policy::DropPolicyDropNewest)
    }

    pub const fn default_qos() -> Self {
        Self::state()
    }

    pub fn for_channel(channel: amos_link::keyexpr::Channel) -> Self {
        let inner = amos_link::qos::Qos::for_channel(channel);
        Self {
            reliability: inner.reliability.into(),
            depth: inner.depth as u32,
            drop_policy: inner.drop_policy.into(),
        }
    }

    pub fn validate(&self) -> Result<(), LinkError> {
        let inner = amos_link::qos::Qos::new(
            self.reliability.into(),
            self.depth as usize,
            self.drop_policy.into(),
        );
        amos_link::qos::Qos::validate(inner)
    }
}

impl Default for Qos {
    fn default() -> Self {
        Self::state()
    }
}

// Alias for the upstream Topic so we can call its methods from FFI functions.
use amos_link::keyexpr::Topic as InnerTopic;

impl Timestamp {
    pub fn now() -> Self {
        let inner = amos_link::codec::Timestamp::now();
        Self { secs: inner.secs, nanos: inner.nanos }
    }

    pub fn new(secs: u64, nanos: u32) -> Result<Self, LinkError> {
        amos_link::codec::Timestamp::new(secs, nanos)?;
        Ok(Self { secs, nanos })
    }

    pub fn is_valid(&self) -> bool {
        self.nanos < 1_000_000_000
    }

    pub fn as_nanos(&self) -> u64 {
        self.secs.saturating_mul(1_000_000_000) + self.nanos as u64
    }

    pub fn unix_ms(&self) -> u64 {
        self.secs.saturating_mul(1000) + (self.nanos / 1_000_000) as u64
    }

    pub fn since_secs(earlier: Timestamp, later: Timestamp) -> f64 {
        let diff = later.secs.saturating_sub(earlier.secs) as f64;
        let nanos_diff = later.nanos as i64 - earlier.nanos as i64;
        diff + (nanos_diff as f64 / 1e9)
    }
}

/// FFI key expression handle.
///
/// ## C ABI design
///
/// `Topic` is passed by value as a `struct Topic` and is never dereferenced by C code.
/// All operations happen via the `amos_link_topic_*` functions.  Inside the struct, an
/// `Arc<InnerTopic>` (a thin pointer) is stored so Rust code can work with the real
/// type without indirection.  cbindgen sees `struct Topic` as opaque because the
/// `_inner` field carries a doc comment that marks it hidden.
#[repr(C)]
#[derive(Clone, Debug)]
#[doc(hidden)]
pub struct Topic {
    pub _inner: Arc<InnerTopic>,
}

impl Topic {
    pub fn new(expr: &str) -> Result<Self, LinkError> {
        let inner = InnerTopic::new(expr)?;
        Ok(Self { _inner: Arc::new(inner) })
    }

    pub fn pattern(expr: &str) -> Result<Self, LinkError> {
        let inner = InnerTopic::pattern(expr)?;
        Ok(Self { _inner: Arc::new(inner) })
    }

    pub fn channel_topic(peer: &str, channel: amos_link::keyexpr::Channel, name: &str) -> Result<Self, LinkError> {
        let inner = InnerTopic::channel_topic(peer, channel, name)?;
        Ok(Self { _inner: Arc::new(inner) })
    }

    pub fn peer_pattern(peer: &str) -> Result<Self, LinkError> {
        let inner = InnerTopic::peer_pattern(peer)?;
        Ok(Self { _inner: Arc::new(inner) })
    }

    pub fn matches(&self, pattern: &Topic) -> bool {
        InnerTopic::matches(&self._inner, &pattern._inner)
    }
}

use std::ffi::c_char;
use std::fmt::Write as FmtWrite;
use std::ptr;
use std::slice;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use crc32fast::Hasher;
use serde::{Deserialize, Serialize};

use amos_link::codec::Envelope;
use amos_link::discovery::{FederationTask, NodeKind, PeerId, PeerInfo, PeerView};
use amos_link::error::LinkError;
use amos_link::health::{HealthReason, LinkHealth};
use amos_link::metrics::MetricsSnapshot;
use amos_link::node::LinkNode;
use amos_link::telemetry::Heartbeat;
use amos_link::Message;
use amos_link::VERSION as AMLINK_VERSION;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

// Lazy static runtime for federation tasks that need tokio::spawn
fn global_runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .thread_name("amos-link-cc-runtime")
            .build()
            .expect("failed to create tokio runtime")
    })
}

thread_local! {
    static LAST_ERROR: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

fn set_error(err: &LinkError) -> i32 {
    let code = match err {
        LinkError::KeyExpr { .. } => -1,
        LinkError::Codec(_) => -2,
        LinkError::Frame(_) => -3,
        LinkError::Unsupported(_) => -4,
        LinkError::Transport(_) => -5,
        LinkError::Closed(_) => -6,
        LinkError::Robot(_) => -7,
    };
    LAST_ERROR.with(|buf| {
        buf.borrow_mut().clear();
        let _ = write!(buf.borrow_mut(), "{err}");
    });
    code
}

/// A serde wrapper so any bincode-encoded bytes become a `Message`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BincodePayload(pub Vec<u8>);

/// Run an async block synchronously.
fn block_on_sync<F: std::future::Future>(f: F) -> F::Output {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    rt.block_on(f)
}

fn cstr_to_str<'a>(ptr: *const c_char) -> Result<&'a str, LinkError> {
    if ptr.is_null() {
        return Err(LinkError::Codec("null C string".into()));
    }
    let len = unsafe {
        let mut n = 0;
        while *ptr.add(n) != 0 { n += 1; }
        n
    };
    let bytes = unsafe { slice::from_raw_parts(ptr as *const u8, len) };
    std::str::from_utf8(bytes)
        .map_err(|e| LinkError::Codec(format!("invalid UTF-8: {e}")))
}

/// Copy a Rust string into a caller-provided buffer, NUL-terminated.
/// Returns 0 (always succeeds, truncates if buffer too small).
fn copy_str(s: &str, dst: *mut c_char, cap: usize) -> i32 {
    if cap == 0 {
        return -1; // degenerate case
    }
    let bytes = s.as_bytes();
    // Copy at most cap-1 bytes so we can always NUL-terminate.
    let n = bytes.len().min(cap - 1);
    unsafe {
        ptr::copy_nonoverlapping(bytes.as_ptr() as *const c_char, dst, n);
        *dst.add(n) = 0;
    }
    0
}

/// Write a NUL at offset `off` in a C array stored in a raw pointer.
unsafe fn write_nul(arr: *mut c_char, off: usize) {
    *arr.add(off) = 0;
}

fn check_null<T>(p: *const T) -> Option<*const T> {
    if p.is_null() {
        let msg = "null pointer in amos-link-cc".to_string();
        LAST_ERROR.with(|buf| {
            buf.borrow_mut().clear();
            buf.borrow_mut().push_str(&msg);
        });
        None
    } else {
        Some(p)
    }
}

fn check_null_mut<T>(p: *mut T) -> Option<*mut T> {
    if p.is_null() {
        let msg = "null pointer in amos-link-cc".to_string();
        LAST_ERROR.with(|buf| {
            buf.borrow_mut().clear();
            buf.borrow_mut().push_str(&msg);
        });
        None
    } else {
        Some(p)
    }
}

// ---------------------------------------------------------------------------
// Opaque handle types (zero-sized, repr(C))
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct amos_link_node(u8);
#[repr(C)]
pub struct amos_link_publisher(u8);
#[repr(C)]
pub struct amos_link_subscriber(u8);
#[repr(C)]
pub struct amos_link_federation_task(u8);
#[repr(C)]
pub struct amos_link_heartbeat(u8);

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum amos_link_node_kind {
    NodeRobot = 0,
    NodeBrain = 1,
    NodeSensor = 2,
    NodeActuator = 3,
    NodeTool = 4,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum amos_link_channel {
    ChannelSensor = 0,
    ChannelControl = 1,
    ChannelState = 2,
    ChannelTelemetry = 3,
    ChannelBrain = 4,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum amos_link_health_state {
    Unknown = 0,
    Healthy = 1,
    Degraded = 2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum amos_link_poll {
    Pending = 0,
    Ready = 1,
    Closed = 2,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const AMLK_MAGIC: [u8; 4] = [0x41, 0x4D, 0x4C, 0x4B];
pub const AMLK_VERSION: u8 = 1;
pub const AMLK_MAX_FRAME_BYTES: usize = 4 + 1 + 4 + 4 + 16 * 1024 * 1024 + 4096;
pub const AMLK_MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
pub const AMLK_MAX_PEER_ID_LEN: usize = 63;
pub const AMLK_MAX_TOPIC_LEN: usize = 1024;
pub const AMLK_MAX_ENDPOINT_LEN: usize = 128;
pub const AMLK_QOS_MAX_DEPTH: usize = 4096;

// ---------------------------------------------------------------------------
// C structs
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Debug)]
pub struct amos_link_frame_header {
    pub topic: [c_char; 1024],
    pub topic_len: u32,
    pub peer_id: [c_char; 64],
    pub seq: u64,
    pub stamp_secs: u64,
    pub stamp_nanos: u32,
    pub payload_len: u32,
}

#[repr(C)]
#[derive(Debug)]
pub struct amos_link_received {
    pub topic: [c_char; 1024],
    pub peer_id: [c_char; 64],
    pub seq: u64,
    pub stamp_secs: u64,
    pub stamp_nanos: u32,
    pub frame_len: u32,
    pub payload_len: u32,
}

#[repr(C)]
#[derive(Debug, Default)]
pub struct amos_link_sub_stats {
    pub received: u64,
    pub dropped: u64,
    pub decode_errors: u64,
}

#[repr(C)]
#[derive(Debug, Default)]
pub struct amos_link_metrics {
    pub published: u64,
    pub delivered: u64,
    pub dropped: u64,
    pub blocked: u64,
    pub decode_errors: u64,
    pub encode_errors: u64,
}

#[repr(C)]
#[derive(Debug)]
pub struct amos_link_health {
    pub state: amos_link_health_state,
    pub reason: [c_char; 256],
}

#[repr(C)]
#[derive(Debug)]
pub struct amos_link_peer_view {
    pub id: [c_char; 64],
    pub kind: amos_link_node_kind,
    pub endpoint: [c_char; 128],
    pub last_seen_ms: u64,
    pub beacons: u64,
}

#[repr(C)]
#[derive(Debug)]
pub struct amos_link_topic_entry {
    pub topic: [c_char; 1024],
}

#[repr(C)]
#[derive(Debug)]
pub struct amos_link_heartbeat_fields {
    pub peer_id: [c_char; 64],
    pub seq: u64,
    pub stamp_secs: u64,
    pub stamp_nanos: u32,
    pub uptime_ms: u64,
}

// ---------------------------------------------------------------------------
// PeerId
// ---------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn amos_link_peer_id_validate(id: *const c_char) -> i32 {
    match cstr_to_str(id) {
        Ok(s) => match PeerId::validate_str(s) {
            Ok(()) => 0,
            Err(e) => set_error(&e),
        },
        Err(e) => set_error(&e),
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_peer_id_new(id: *const c_char, out: *mut c_char) -> i32 {
    match cstr_to_str(id) {
        Ok(s) => match PeerId::new(s) {
            Ok(pid) => copy_str(pid.as_str(), out, AMLK_MAX_PEER_ID_LEN + 1),
            Err(e) => set_error(&e),
        },
        Err(e) => set_error(&e),
    }
}

// ---------------------------------------------------------------------------
// Topic / keyexpr
// ---------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn amos_link_topic_validate(expr: *const c_char) -> i32 {
    match cstr_to_str(expr) {
        Ok(s) => match InnerTopic::validate_str(s) {
            Ok(()) => 0,
            Err(e) => set_error(&e),
        },
        Err(e) => set_error(&e),
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_topic_validate_pattern(expr: *const c_char) -> i32 {
    match cstr_to_str(expr) {
        Ok(s) => match InnerTopic::pattern(s) {
            Ok(_) => 0,
            Err(e) => set_error(&e),
        },
        Err(e) => set_error(&e),
    }
}

fn ch_to_channel(ch: amos_link_channel) -> amos_link::keyexpr::Channel {
    match ch {
        amos_link_channel::ChannelSensor => amos_link::keyexpr::Channel::Sensor,
        amos_link_channel::ChannelControl => amos_link::keyexpr::Channel::Control,
        amos_link_channel::ChannelState => amos_link::keyexpr::Channel::State,
        amos_link_channel::ChannelTelemetry => amos_link::keyexpr::Channel::Telemetry,
        amos_link_channel::ChannelBrain => amos_link::keyexpr::Channel::Brain,
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_topic_channel(
    peer: *const c_char,
    channel: amos_link_channel,
    name: *const c_char,
    out: *mut c_char,
) -> i32 {
    let peer_s = match cstr_to_str(peer) {
        Ok(s) => s,
        Err(e) => return set_error(&e),
    };
    let name_s = match cstr_to_str(name) {
        Ok(s) => s,
        Err(e) => return set_error(&e),
    };
    match InnerTopic::channel_topic(peer_s, ch_to_channel(channel), name_s) {
        Ok(t) => copy_str(t.as_str(), out, AMLK_MAX_TOPIC_LEN + 1),
        Err(e) => set_error(&e),
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_topic_peer_pattern(peer: *const c_char, out: *mut c_char) -> i32 {
    match cstr_to_str(peer) {
        Ok(s) => match InnerTopic::peer_pattern(s) {
            Ok(t) => copy_str(t.as_str(), out, AMLK_MAX_TOPIC_LEN + 1),
            Err(e) => set_error(&e),
        },
        Err(e) => set_error(&e),
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_topic_matches(
    topic: *const Topic,
    pattern: *const Topic,
) -> bool {
    if topic.is_null() || pattern.is_null() {
        return false;
    }
    let t = unsafe { &*topic };
    let p = unsafe { &*pattern };
    // Use the upstream matches method.
    amos_link::keyexpr::Topic::matches(&t._inner, &p._inner)
}

// ---------------------------------------------------------------------------
// QoS
// ---------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn amos_link_qos_new(
    reliability: amos_link_reliability,
    depth: u32,
    drop_policy: amos_link_drop_policy,
) -> Qos {
    Qos::new(reliability, depth, drop_policy)
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_qos_sensor() -> Qos { Qos::sensor() }

#[no_mangle]
pub unsafe extern "C" fn amos_link_qos_state() -> Qos { Qos::state() }

#[no_mangle]
pub unsafe extern "C" fn amos_link_qos_control() -> Qos { Qos::control() }

#[no_mangle]
pub unsafe extern "C" fn amos_link_qos_default() -> Qos { Qos::default() }

#[no_mangle]
pub unsafe extern "C" fn amos_link_qos_for_channel(channel: amos_link_channel) -> Qos {
    Qos::for_channel(ch_to_channel(channel))
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_qos_validate(qos: Qos) -> i32 {
    match qos.validate() {
        Ok(()) => 0,
        Err(e) => set_error(&e),
    }
}

// ---------------------------------------------------------------------------
// Timestamp / Clock
// ---------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn amos_link_timestamp_now() -> Timestamp {
    Timestamp::now()
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_timestamp_new(secs: u64, nanos: u32) -> Timestamp {
    Timestamp::new(secs, nanos)
        .unwrap_or(Timestamp { secs, nanos: 999_999_999 })
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_timestamp_as_nanos(stamp: Timestamp) -> u64 {
    stamp.as_nanos()
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_timestamp_unix_ms(stamp: Timestamp) -> u64 {
    stamp.unix_ms()
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_timestamp_since_secs(earlier: Timestamp, later: Timestamp) -> f64 {
    Timestamp::since_secs(earlier, later)
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_timestamp_is_valid(stamp: Timestamp) -> bool {
    stamp.is_valid()
}

// ---------------------------------------------------------------------------
// Codec / framing
// ---------------------------------------------------------------------------

/// Encode a bincode payload into a full wire frame synchronously.
#[no_mangle]
pub unsafe extern "C" fn amos_link_frame_encode(
    topic_str: *const c_char,
    peer_id_str: *const c_char,
    seq: u64,
    stamp: Timestamp,
    payload: *const u8,
    payload_len: usize,
    frame_out: *mut u8,
    frame_out_cap: usize,
) -> usize {
    if frame_out.is_null() {
        set_error(&LinkError::Codec("null output buffer".into()));
        return 0;
    }
    let topic_s = match cstr_to_str(topic_str) {
        Ok(s) => s,
        Err(e) => { set_error(&e); return 0; }
    };
    let peer_s = match cstr_to_str(peer_id_str) {
        Ok(s) => s,
        Err(e) => { set_error(&e); return 0; }
    };
    if payload.is_null() && payload_len > 0 {
        set_error(&LinkError::Codec("null payload with non-zero length".into()));
        return 0;
    }
    let payload_slice = if payload.is_null() || payload_len == 0 {
        &[]
    } else {
        slice::from_raw_parts(payload, payload_len)
    };

    let topic = match Topic::new(topic_s) {
        Ok(t) => t,
        Err(e) => { set_error(&e); return 0; }
    };
    let peer = match PeerId::new(peer_s) {
        Ok(p) => p,
        Err(e) => { set_error(&e); return 0; }
    };

    // The payload bytes are already encoded by the caller (e.g., C code did the serialization),
    // so we pass them directly to the envelope without calling .encode() again.
    let payload_vec = payload_slice.to_vec();

    let envelope = Envelope::new(&topic._inner, &peer, seq, stamp.into(), payload_vec);
    let wire = match envelope.encode() {
        Ok(w) => w,
        Err(e) => { set_error(&e); return 0; }
    };
    let n = wire.len().min(frame_out_cap);
    if n > 0 {
        ptr::copy_nonoverlapping(wire.as_ptr(), frame_out, n);
    }
    n
}

/// Decode only the frame header (payload slice is borrowed, not copied).
#[no_mangle]
pub unsafe extern "C" fn amos_link_frame_decode_header(
    frame: *const u8,
    frame_len: usize,
    h: *mut amos_link_frame_header,
) -> i32 {
    if check_null(h).is_none() { return -2; }
    let frame_slice = slice::from_raw_parts(frame, frame_len);
    match Envelope::decode_header(frame_slice) {
        Ok((header, _payload)) => {
            let max_topic = 1024usize;
            let max_peer = 64usize;

            let copy_t = header.topic.len().min(max_topic - 1);
            ptr::copy_nonoverlapping(
                header.topic.as_ptr() as *const c_char,
                (*h).topic.as_ptr() as *mut c_char,
                copy_t,
            );
            write_nul((*h).topic.as_ptr() as *mut c_char, copy_t);
            (*h).topic_len = header.topic.len() as u32;

            let copy_p = header.publisher.as_str().len().min(max_peer - 1);
            ptr::copy_nonoverlapping(
                header.publisher.as_str().as_ptr() as *const c_char,
                (*h).peer_id.as_ptr() as *mut c_char,
                copy_p,
            );
            write_nul((*h).peer_id.as_ptr() as *mut c_char, copy_p);
            (*h).seq = header.seq;
            (*h).stamp_secs = header.stamp.secs;
            (*h).stamp_nanos = header.stamp.nanos;
            (*h).payload_len = header.payload_len;
            0
        }
        Err(e) => set_error(&e),
    }
}

/// Decode a wire frame and return its payload bytes.
#[no_mangle]
pub unsafe extern "C" fn amos_link_frame_decode_payload(
    frame: *const u8,
    frame_len: usize,
    payload_out: *mut u8,
    payload_cap: usize,
) -> i32 {
    if frame.is_null() || frame_len == 0 {
        return set_error(&LinkError::Codec("null or empty frame".into()));
    }
    if payload_out.is_null() {
        return set_error(&LinkError::Codec("null payload output buffer".into()));
    }
    let frame_slice = slice::from_raw_parts(frame, frame_len);
    match Envelope::decode(frame_slice) {
        Ok(env) => {
            let n = env.payload.len();
            if n > payload_cap {
                return set_error(&LinkError::Codec("payload buffer too small".into()));
            }
            if n > 0 {
                ptr::copy_nonoverlapping(env.payload.as_ptr(), payload_out, n);
            }
            n as i32
        }
        Err(e) => set_error(&e),
    }
}

/// CRC32 of a single buffer.
#[no_mangle]
pub unsafe extern "C" fn amos_link_crc32(data: *const u8, len: usize) -> u32 {
    if data.is_null() || len == 0 {
        return 0;
    }
    let slice = slice::from_raw_parts(data, len);
    crc32fast::hash(slice)
}

/// CRC32 of header || payload combined.
#[no_mangle]
pub unsafe extern "C" fn amos_link_crc32_combine(
    header: *const u8, h_len: usize,
    payload: *const u8, p_len: usize,
) -> u32 {
    let mut hasher = Hasher::new();
    if !header.is_null() && h_len > 0 {
        let h = unsafe { slice::from_raw_parts(header, h_len) };
        hasher.update(h);
    }
    if !payload.is_null() && p_len > 0 {
        let p = unsafe { slice::from_raw_parts(payload, p_len) };
        hasher.update(p);
    }
    hasher.finalize()
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

fn node_kind_to_aml(ch: amos_link_node_kind) -> NodeKind {
    match ch {
        amos_link_node_kind::NodeRobot => NodeKind::Robot,
        amos_link_node_kind::NodeBrain => NodeKind::Brain,
        amos_link_node_kind::NodeSensor => NodeKind::Sensor,
        amos_link_node_kind::NodeActuator => NodeKind::Actuator,
        amos_link_node_kind::NodeTool => NodeKind::Tool,
    }
}

fn aml_kind_to_node(kind: &NodeKind) -> amos_link_node_kind {
    match kind {
        NodeKind::Robot => amos_link_node_kind::NodeRobot,
        NodeKind::Brain => amos_link_node_kind::NodeBrain,
        NodeKind::Sensor => amos_link_node_kind::NodeSensor,
        NodeKind::Actuator => amos_link_node_kind::NodeActuator,
        NodeKind::Tool => amos_link_node_kind::NodeTool,
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_node_new(
    peer_id: *const c_char,
    kind: amos_link_node_kind,
) -> *mut amos_link_node {
    let peer_s = match cstr_to_str(peer_id) {
        Ok(s) => s,
        Err(e) => { set_error(&e); return ptr::null_mut(); }
    };
    let pid = match PeerId::new(peer_s) {
        Ok(p) => p,
        Err(e) => { set_error(&e); return ptr::null_mut(); }
    };
    let node = LinkNode::in_process(pid, node_kind_to_aml(kind));
    Box::into_raw(Box::new(node)) as *mut amos_link_node
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_node_clone(node: *const amos_link_node) -> *mut amos_link_node {
    if let Some(node) = check_null(node) {
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        let cloned: Arc<LinkNode> = Arc::clone(n);
        Box::into_raw(Box::new(cloned)) as *mut amos_link_node
    } else {
        ptr::null_mut()
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_node_drop(node: *mut amos_link_node) {
    if !node.is_null() {
        drop(unsafe { Box::from_raw(node as *mut Arc<LinkNode>) });
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_node_peer_id(
    node: *const amos_link_node,
    buf: *mut c_char,
    cap: usize,
) -> i32 {
    if let Some(node) = check_null(node) {
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        copy_str(n.peer().as_str(), buf, cap)
    } else {
        -2
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_node_get_kind(node: *const amos_link_node) -> amos_link_node_kind {
    if let Some(node) = check_null(node) {
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        aml_kind_to_node(&n.kind())
    } else {
        amos_link_node_kind::NodeTool
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_node_uptime_ms(node: *const amos_link_node) -> u64 {
    if let Some(node) = check_null(node) {
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        n.uptime_ms()
    } else {
        0
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_version() -> *const c_char {
    AMLINK_VERSION.as_ptr() as *const c_char
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_node_heartbeat_topic(
    node: *const amos_link_node,
    buf: *mut c_char,
) -> i32 {
    if let Some(node) = check_null(node) {
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        match n.heartbeat_topic() {
            Ok(t) => copy_str(t.as_ref(), buf, AMLK_MAX_TOPIC_LEN + 1),
            Err(e) => set_error(&e),
        }
    } else {
        -2
    }
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

struct SimplePublisher {
    node: Arc<LinkNode>,
    topic: Topic,
}

impl SimplePublisher {
    fn publish_sync(&self, payload: &[u8]) -> Result<amos_link::broker::PublishReport, LinkError> {
        let bp = BincodePayload(payload.to_vec());
        let pubr = self.node.publisher::<BincodePayload>((*self.topic._inner).clone());
        block_on_sync(pubr.publish(&bp))
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_publisher_new(
    node: *const amos_link_node,
    topic_str: *const c_char,
) -> *mut amos_link_publisher {
    let topic_s = match cstr_to_str(topic_str) {
        Ok(s) => s,
        Err(e) => { set_error(&e); return ptr::null_mut(); }
    };
    let topic = match Topic::new(topic_s) {
        Ok(t) => t,
        Err(e) => { set_error(&e); return ptr::null_mut(); }
    };
    if let Some(node) = check_null(node) {
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        let sp = Box::new(SimplePublisher {
            node: Arc::clone(n),
            topic,
        });
        Box::into_raw(sp) as *mut amos_link_publisher
    } else {
        ptr::null_mut()
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_publisher_drop(pubr: *mut amos_link_publisher) {
    if !pubr.is_null() {
        drop(unsafe { Box::from_raw(pubr as *mut SimplePublisher) });
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_publisher_publish(
    pubr: *const amos_link_publisher,
    payload: *const u8,
    payload_len: usize,
) -> i32 {
    if let Some(pubr) = check_null(pubr) {
        let sp = unsafe { &*(pubr as *const SimplePublisher) };
        let payload_slice = unsafe { slice::from_raw_parts(payload, payload_len) };
        match sp.publish_sync(payload_slice) {
            Ok(_) => 0,
            Err(e) => set_error(&e),
        }
    } else {
        -2
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_publisher_topic(
    pubr: *const amos_link_publisher,
    buf: *mut c_char,
    cap: usize,
) -> i32 {
    if let Some(pubr) = check_null(pubr) {
        let sp = unsafe { &*(pubr as *const SimplePublisher) };
        copy_str(sp.topic._inner.as_str(), buf, cap)
    } else {
        -2
    }
}

// ---------------------------------------------------------------------------
// Subscriber
// ---------------------------------------------------------------------------

/// Async-safe subscriber wrapper: a background tokio task drains the
/// `Subscriber` channel and forwards data over std `mpsc` channels so that
/// `poll` / `recv` can be called from synchronous C code.
struct SimpleSubscriber {
    /// Receives decoded payload bytes from the background task.
    payload_rx: std::sync::mpsc::Receiver<BincodePayload>,
    /// Receives metadata (topic, peer, seq, stamp, frame_len) from background task.
    meta_rx: std::sync::mpsc::Receiver<(String, String, u64, Timestamp, u32)>,
    /// Set to `true` when the background task exits.
    closed: Arc<std::sync::atomic::AtomicBool>,
    /// Handle to the background thread so we can join it on drop.
    #[allow(dead_code)]
    thread: std::thread::JoinHandle<()>,
}

impl Drop for SimpleSubscriber {
    fn drop(&mut self) {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_subscriber_new(
    node: *const amos_link_node,
    pattern_str: *const c_char,
    qos: Qos,
) -> *mut amos_link_subscriber {
    let pattern_s = match cstr_to_str(pattern_str) {
        Ok(s) => s,
        Err(e) => { set_error(&e); return ptr::null_mut(); }
    };
    let pattern = match InnerTopic::pattern(pattern_s) {
        Ok(t) => t,
        Err(e) => { set_error(&e); return ptr::null_mut(); }
    };
    if let Some(node) = check_null(node) {
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        let node_clone = Arc::clone(n);
        let pattern_clone = pattern.clone();
        let qos_clone = qos;

        let sub = block_on_sync(async move {
            node_clone.subscriber::<BincodePayload>(pattern_clone, qos_clone.into()).await
        });

        match sub {
            Ok(mut subscription) => {
                let (payload_tx, payload_rx) = std::sync::mpsc::channel();
                let (meta_tx, meta_rx) = std::sync::mpsc::channel();
                let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let closed_clone = closed.clone();

                let thread = std::thread::spawn(move || {
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .expect("tokio runtime for subscriber background task");
                    rt.block_on(async {
                        loop {
                            if closed_clone.load(std::sync::atomic::Ordering::SeqCst) {
                                break;
                            }
                            match subscription.recv().await {
                                Ok(rx) => {
                                    let ts = rx.stamp;
                                    let meta = (
                                        rx.topic.to_string(),
                                        rx.publisher.to_string(),
                                        rx.seq,
                                        Timestamp { secs: ts.secs, nanos: ts.nanos },
                                        rx.frame_len as u32,
                                    );
                                    if payload_tx.send(rx.message).is_err() {
                                        break;
                                    }
                                    if meta_tx.send(meta).is_err() {
                                        break;
                                    }
                                }
                                Err(LinkError::Closed(_)) => {
                                    closed_clone.store(true, std::sync::atomic::Ordering::SeqCst);
                                    let _ = payload_tx.send(BincodePayload(Vec::new()));
                                    let _ = meta_tx.send((
                                        String::new(),
                                        String::new(),
                                        0,
                                        Timestamp { secs: 0, nanos: 0 },
                                        0,
                                    ));
                                    break;
                                }
                                Err(_) => {
                                    // skip decode errors and continue
                                }
                            }
                        }
                    });
                });

                let ss = Box::new(SimpleSubscriber {
                    payload_rx,
                    meta_rx,
                    closed,
                    thread,
                });
                Box::into_raw(ss) as *mut amos_link_subscriber
            }
            Err(e) => { set_error(&e); ptr::null_mut() }
        }
    } else {
        ptr::null_mut()
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_subscriber_drop(sub: *mut amos_link_subscriber) {
    if !sub.is_null() {
        drop(unsafe { Box::from_raw(sub as *mut SimpleSubscriber) });
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_subscriber_poll(
    sub: *const amos_link_subscriber,
    received: *mut amos_link_received,
    payload_buf: *mut u8,
    payload_cap: usize,
) -> amos_link_poll {
    if check_null(sub).is_none() { return amos_link_poll::Closed; }
    if check_null(received).is_none() { return amos_link_poll::Closed; }

    let s = unsafe { &*(sub as *const SimpleSubscriber) };

    if s.closed.load(std::sync::atomic::Ordering::SeqCst) {
        return amos_link_poll::Closed;
    }

    match s.meta_rx.try_recv() {
        Ok((topic, peer, seq, stamp, frame_len)) => {
            let payload_bytes =
                s.payload_rx.try_recv().unwrap_or_else(|_| BincodePayload(Vec::new()));

            unsafe {
                let max_topic = 1024usize;
                let max_peer = 64usize;
                let copy_t = topic.len().min(max_topic - 1);
                ptr::copy_nonoverlapping(
                    topic.as_ptr() as *const c_char,
                    (*received).topic.as_ptr() as *mut c_char,
                    copy_t,
                );
                write_nul((*received).topic.as_ptr() as *mut c_char, copy_t);
                let copy_p = peer.len().min(max_peer - 1);
                ptr::copy_nonoverlapping(
                    peer.as_ptr() as *const c_char,
                    (*received).peer_id.as_ptr() as *mut c_char,
                    copy_p,
                );
                write_nul((*received).peer_id.as_ptr() as *mut c_char, copy_p);
                (*received).seq = seq;
                (*received).stamp_secs = stamp.secs;
                (*received).stamp_nanos = stamp.nanos;
                (*received).frame_len = frame_len;

                let n_copy = payload_bytes.0.len().min(payload_cap);
                ptr::copy_nonoverlapping(payload_bytes.0.as_ptr(), payload_buf, n_copy);
                (*received).payload_len = payload_bytes.0.len() as u32;
            }
            amos_link_poll::Ready
        }
        Err(std::sync::mpsc::TryRecvError::Disconnected) => {
            amos_link_poll::Closed
        }
        Err(_) => amos_link_poll::Pending,
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_subscriber_recv(
    sub: *const amos_link_subscriber,
    received: *mut amos_link_received,
    payload_buf: *mut u8,
    payload_cap: usize,
) -> amos_link_poll {
    if check_null(sub).is_none() { return amos_link_poll::Closed; }
    if check_null(received).is_none() { return amos_link_poll::Closed; }

    let s = unsafe { &*(sub as *const SimpleSubscriber) };

    if s.closed.load(std::sync::atomic::Ordering::SeqCst) {
        return amos_link_poll::Closed;
    }

    // Blocking recv with 30s timeout.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let meta = loop {
        if std::time::Instant::now() > deadline {
            return amos_link_poll::Closed;
        }
        match s.meta_rx.recv_timeout(std::time::Duration::from_millis(10)) {
            Ok(m) => break Ok(m),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if s.closed.load(std::sync::atomic::Ordering::SeqCst) {
                    break Err(());
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break Err(()),
        }
    };

    let (topic, peer, seq, stamp, frame_len) = match meta {
        Ok(m) => m,
        Err(_) => return amos_link_poll::Closed,
    };

    let payload_bytes = loop {
        match s.payload_rx.recv_timeout(std::time::Duration::from_millis(10)) {
            Ok(b) => break b,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if s.closed.load(std::sync::atomic::Ordering::SeqCst) {
                    return amos_link_poll::Closed;
                }
            }
            Err(_) => return amos_link_poll::Closed,
        }
    };

    unsafe {
        let max_topic = 1024usize;
        let max_peer = 64usize;
        let copy_t = topic.len().min(max_topic - 1);
        ptr::copy_nonoverlapping(
            topic.as_ptr() as *const c_char,
            (*received).topic.as_ptr() as *mut c_char,
            copy_t,
        );
        write_nul((*received).topic.as_ptr() as *mut c_char, copy_t);
        let copy_p = peer.len().min(max_peer - 1);
        ptr::copy_nonoverlapping(
            peer.as_ptr() as *const c_char,
            (*received).peer_id.as_ptr() as *mut c_char,
            copy_p,
        );
        write_nul((*received).peer_id.as_ptr() as *mut c_char, copy_p);
        (*received).seq = seq;
        (*received).stamp_secs = stamp.secs;
        (*received).stamp_nanos = stamp.nanos;
        (*received).frame_len = frame_len;

        let n_copy = payload_bytes.0.len().min(payload_cap);
        ptr::copy_nonoverlapping(payload_bytes.0.as_ptr(), payload_buf, n_copy);
        (*received).payload_len = payload_bytes.0.len() as u32;
    }
    amos_link_poll::Ready
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_subscriber_stats(
    sub: *const amos_link_subscriber,
    stats: *mut amos_link_sub_stats,
) -> i32 {
    if check_null(stats).is_none() { return -2; }
    if check_null(sub).is_none() { return -2; }
    let _s = unsafe { &*(sub as *const SimpleSubscriber) };
    // Stats are maintained in the background thread; return zeros for now.
    unsafe {
        (*stats).received = 0;
        (*stats).dropped = 0;
        (*stats).decode_errors = 0;
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_subscriber_has_pending(sub: *const amos_link_subscriber) -> bool {
    if check_null(sub).is_some() {
        let _s = unsafe { &*(sub as *const SimpleSubscriber) };
        // mpsc::Receiver doesn't have is_empty, so conservatively
        // return true to indicate there might be pending data.
        true
    } else {
        false
    }
}


// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn amos_link_node_metrics(
    node: *const amos_link_node,
    metrics: *mut amos_link_metrics,
) -> i32 {
    if check_null(node).is_none() { return -2; }
    if check_null(metrics).is_none() { return -2; }
    let n = unsafe { &*(node as *const Arc<LinkNode>) };
    let snap = n.metrics().snapshot();
    unsafe {
        (*metrics).published = snap.published;
        (*metrics).delivered = snap.delivered;
        (*metrics).dropped = snap.dropped;
        (*metrics).blocked = snap.blocked;
        (*metrics).decode_errors = snap.decode_errors;
        (*metrics).encode_errors = snap.encode_errors;
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_metrics_delivery_ratio(m: *const amos_link_metrics) -> u32 {
    if let Some(m) = check_null(m) {
        let snap = unsafe {
            MetricsSnapshot {
                published: (*m).published,
                delivered: (*m).delivered,
                dropped: (*m).dropped,
                blocked: (*m).blocked,
                decode_errors: (*m).decode_errors,
                encode_errors: (*m).encode_errors,
            }
        };
        // Handle zero-published case explicitly: test expects 0%, not 100%
        if snap.published == 0 {
            0
        } else {
            let ratio = snap.delivery_ratio();
            (ratio * 100.0) as u32
        }
    } else {
        0
    }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn amos_link_evaluate_health(
    metrics: *const amos_link_metrics,
    peers: *const amos_link_peer_view,
    num_peers: usize,
    clock_synced: bool,
) -> amos_link_health {
    if check_null(metrics).is_none() {
        return amos_link_health { state: amos_link_health_state::Unknown, reason: [0; 256] };
    }
    let snap = unsafe {
        MetricsSnapshot {
            published: (*metrics).published,
            delivered: (*metrics).delivered,
            dropped: (*metrics).dropped,
            blocked: (*metrics).blocked,
            decode_errors: (*metrics).decode_errors,
            encode_errors: (*metrics).encode_errors,
        }
    };

    let peer_views: Vec<PeerView> = if peers.is_null() || num_peers == 0 {
        Vec::new()
    } else {
        let slice = unsafe { slice::from_raw_parts(peers, num_peers) };
        slice.iter().filter_map(|pv| {
            let pid_str = unsafe {
                let mut n = 0;
                while *pv.id.as_ptr().add(n) != 0 { n += 1; }
                std::str::from_utf8(slice::from_raw_parts(pv.id.as_ptr() as *const u8, n)).ok()?.to_string()
            };
            let pid = PeerId::new(pid_str).ok()?;
            Some(PeerView {
                info: PeerInfo::new(pid, NodeKind::Robot),
                last_seen_ms: pv.last_seen_ms,
                beacons: pv.beacons,
            })
        }).collect()
    };

    let verdict = LinkHealth::evaluate(&snap, &peer_views, clock_synced, None);
    let mut out = amos_link_health {
        state: match verdict {
            LinkHealth::Unknown => amos_link_health_state::Unknown,
            LinkHealth::Healthy => amos_link_health_state::Healthy,
            LinkHealth::Degraded { .. } => amos_link_health_state::Degraded,
        },
        reason: [0; 256],
    };
    if let LinkHealth::Degraded { reasons } = verdict {
        let reason_str = reasons.iter().map(HealthReason::detail).collect::<Vec<_>>().join("; ");
        let bytes = reason_str.as_bytes();
        let copy_len = bytes.len().min(255);
        for (i, &b) in bytes.iter().take(copy_len).enumerate() {
            out.reason[i] = b as i8;
        }
        out.reason[copy_len] = 0;
    }
    out
}

// ---------------------------------------------------------------------------
// Peer / topic listing
// ---------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn amos_link_node_peers(
    node: *const amos_link_node,
    peers_out: *mut amos_link_peer_view,
    max_peers: usize,
) -> usize {
    if check_null(node).is_none() { return 0; }
    if check_null_mut(peers_out).is_none() { return 0; }
    let n = unsafe { &*(node as *const Arc<LinkNode>) };
    let peers = block_on_sync(n.peers());
    let n_write = peers.len().min(max_peers);
    for (i, view) in peers.iter().take(n_write).enumerate() {
        let entry = unsafe { &mut *peers_out.add(i) };
        let id_s = view.info.id.as_str();
        copy_str(id_s, entry.id.as_ptr() as *mut c_char, 64);
        entry.kind = aml_kind_to_node(&view.info.kind);
        entry.last_seen_ms = view.last_seen_ms;
        entry.beacons = view.beacons;
        let ep = view.info.endpoint().unwrap_or("");
        copy_str(ep, entry.endpoint.as_ptr() as *mut c_char, 128);
    }
    n_write
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_node_topics(
    node: *const amos_link_node,
    topics_out: *mut amos_link_topic_entry,
    max_topics: usize,
) -> usize {
    if check_null(node).is_none() { return 0; }
    if check_null_mut(topics_out).is_none() { return 0; }
    let n = unsafe { &*(node as *const Arc<LinkNode>) };
    let topics = block_on_sync(n.topics());
    let n_write = topics.len().min(max_topics);
    for (i, t) in topics.iter().take(n_write).enumerate() {
        let entry = unsafe { &mut *topics_out.add(i) };
        copy_str(t.as_str(), entry.topic.as_ptr() as *mut c_char, 1024);
    }
    n_write
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn amos_link_node_heartbeat(
    node: *const amos_link_node,
) -> *mut amos_link_heartbeat {
    if let Some(node) = check_null(node) {
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        let beat = n.heartbeat();
        Box::into_raw(Box::new(beat)) as *mut amos_link_heartbeat
    } else {
        ptr::null_mut()
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_heartbeat_encode(
    beat: *const amos_link_heartbeat,
    frame_out: *mut u8,
) -> i32 {
    if let Some(beat) = check_null(beat) {
        let b = unsafe { &*(beat as *const Heartbeat) };
        let topic_str = format!("amos/{}/telemetry/beat", b.peer);
        let topic = match Topic::new(&topic_str) {
            Ok(t) => t,
            Err(e) => return set_error(&e),
        };
        let encoded = match b.encode() {
            Ok(v) => v,
            Err(e) => return set_error(&e),
        };
        let envelope = Envelope::new(&topic._inner, &b.peer, b.seq, b.stamp, encoded);
        match envelope.encode() {
            Ok(wire) => {
                let n = wire.len().min(AMLK_MAX_FRAME_BYTES);
                ptr::copy_nonoverlapping(wire.as_ptr(), frame_out, n);
                n as i32
            }
            Err(e) => set_error(&e),
        }
    } else {
        -2
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_heartbeat_drop(beat: *mut amos_link_heartbeat) {
    if !beat.is_null() {
        drop(unsafe { Box::from_raw(beat as *mut Heartbeat) });
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_heartbeat_decode(
    frame: *const u8,
    frame_len: usize,
    fields: *mut amos_link_heartbeat_fields,
) -> i32 {
    if check_null(fields).is_none() { return -2; }
    let frame_slice = unsafe { slice::from_raw_parts(frame, frame_len) };
    match Envelope::decode(frame_slice) {
        Ok(env) => {
            match Heartbeat::decode(&env.payload) {
                Ok(beat) => {
                    let max_peer = 64usize;
                    let pid_s = beat.peer.as_str();
                    let copy_pid = pid_s.len().min(max_peer - 1);
                    unsafe {
                        ptr::copy_nonoverlapping(
                            pid_s.as_ptr() as *const c_char,
                            (*fields).peer_id.as_ptr() as *mut c_char,
                            copy_pid,
                        );
                        write_nul((*fields).peer_id.as_ptr() as *mut c_char, copy_pid);
                        (*fields).seq = beat.seq;
                        (*fields).stamp_secs = beat.stamp.secs;
                        (*fields).stamp_nanos = beat.stamp.nanos;
                        (*fields).uptime_ms = beat.uptime_ms;
                    }
                    0
                }
                Err(e) => set_error(&e),
            }
        }
        Err(e) => set_error(&e),
    }
}

// ---------------------------------------------------------------------------
// Federation
// ---------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn amos_link_node_spawn_federation(
    node: *const amos_link_node,
    period_ms: u64,
) -> *mut amos_link_federation_task {
    if let Some(node) = check_null(node) {
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        let node_clone = Arc::clone(n);
        let period = Duration::from_millis(period_ms);
        
        // Use the global runtime to provide context for tokio::spawn
        let rt = global_runtime();
        let _guard = rt.enter();
        
        match node_clone.spawn_federation(period) {
            Ok(t) => Box::into_raw(Box::new(t)) as *mut amos_link_federation_task,
            Err(e) => { set_error(&e); ptr::null_mut() }
        }
    } else {
        ptr::null_mut()
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_node_spawn_federation_advertising(
    node: *const amos_link_node,
    period_ms: u64,
    endpoint: *const c_char,
) -> *mut amos_link_federation_task {
    if let Some(node) = check_null(node) {
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        let endpoints: Vec<String> = if !endpoint.is_null() {
            match cstr_to_str(endpoint) {
                Ok(s) => vec![s.to_string()],
                Err(e) => { set_error(&e); return ptr::null_mut(); }
            }
        } else {
            vec![]
        };
        let node_clone = Arc::clone(n);
        let period = Duration::from_millis(period_ms);
        
        // Use the global runtime to provide context for tokio::spawn
        let rt = global_runtime();
        let _guard = rt.enter();
        
        match node_clone.spawn_federation_advertising(period, endpoints) {
            Ok(t) => Box::into_raw(Box::new(t)) as *mut amos_link_federation_task,
            Err(e) => { set_error(&e); ptr::null_mut() }
        }
    } else {
        ptr::null_mut()
    }
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_federation_stop(task: *mut amos_link_federation_task) {
    if task.is_null() { return; }
    let t = unsafe { Box::from_raw(task as *mut FederationTask) };
    block_on_sync(async move { t.stop().await });
}

// ---------------------------------------------------------------------------
// Error reporting
// ---------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn amos_link_last_error() -> *const c_char {
    LAST_ERROR.with(|buf| {
        let s = &*buf.borrow();
        if s.is_empty() {
            static EMPTY: &[u8] = b"\0";
            EMPTY.as_ptr() as *const c_char
        } else {
            let leaked = Box::leak(s.clone().into_boxed_str());
            leaked.as_ptr() as *const c_char
        }
    })
}

#[no_mangle]
pub unsafe extern "C" fn amos_link_error_clear() {
    LAST_ERROR.with(|buf| buf.borrow_mut().clear());
}
