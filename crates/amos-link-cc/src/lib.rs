//! `amos-link-cc` — the C ABI surface of the AmOS-Link robot middleware.
//!
//! # The pointer contract this file documents
//!
//! Every `pub unsafe extern "C" fn` below says, in its `# Safety` section, what the **C
//! caller** owes it. The rules repeat because the ABI does:
//!
//! * **C strings** (`*const c_char`) are NUL-terminated UTF-8. A null pointer is answered
//!   with an error code (`amos_link_last_error` explains it) — never undefined behaviour.
//! * **Handles** come from the matching `amos_link_*_new` / `_clone` / `_spawn_*` and stay
//!   valid until their `_drop` / `_stop`. A handle used afterwards, or dropped twice, is
//!   undefined behaviour. They are `Box`es leaked into the ABI, holding `Arc`s where the
//!   upstream type is shared (`LinkNode` is returned as `Arc<LinkNode>` upstream).
//! * **Out-buffers** (`*mut c_char` + `cap`, or an out-struct) must be writable for the size
//!   the note names; the functions truncate (`copy_str`) or refuse (`*_decode_payload`)
//!   rather than write past it.
//! * **Input bytes** (`*const u8` + `len`) must point to `len` readable bytes — the caller's
//!   promise, which this crate cannot check.
//! * **Error text** from `amos_link_last_error` is thread-local and valid until the next
//!   `amos-link-cc` call **on the same thread** (`strerror`'s contract).
//!
//! Nothing here may panic: an unwinding panic would cross the C ABI boundary, so the P0-1
//! gate below turns `unwrap`/`expect`/`panic!` into compile errors in production code.
#![allow(non_camel_case_types)]
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

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
        Self {
            secs: t.secs,
            nanos: t.nanos,
        }
    }
}
impl From<Timestamp> for amos_link::codec::Timestamp {
    fn from(t: Timestamp) -> Self {
        // A `From` impl can neither report an error nor panic (P0-1). An out-of-range
        // `nanos` from C is clamped exactly the way `amos_link_timestamp_new` clamps it,
        // so both entry paths agree on the value instead of one of them aborting.
        amos_link::codec::Timestamp::new(t.secs, t.nanos).unwrap_or(amos_link::codec::Timestamp {
            secs: t.secs,
            nanos: 999_999_999,
        })
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
        amos_link::qos::Qos::new(q.reliability.into(), q.depth as usize, q.drop_policy.into())
    }
}

impl Qos {
    pub const MAX_DEPTH: usize = 4096;

    pub const fn new(
        reliability: amos_link_reliability,
        depth: u32,
        drop_policy: amos_link_drop_policy,
    ) -> Self {
        Self {
            reliability,
            depth,
            drop_policy,
        }
    }

    pub const fn sensor() -> Self {
        Self::new(
            amos_link_reliability::ReliabilityBestEffort,
            1,
            amos_link_drop_policy::DropPolicyDropOldest,
        )
    }

    pub const fn state() -> Self {
        Self::new(
            amos_link_reliability::ReliabilityBestEffort,
            8,
            amos_link_drop_policy::DropPolicyDropNewest,
        )
    }

    pub const fn control() -> Self {
        Self::new(
            amos_link_reliability::ReliabilityReliable,
            64,
            amos_link_drop_policy::DropPolicyDropNewest,
        )
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
        Self {
            secs: inner.secs,
            nanos: inner.nanos,
        }
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
        Ok(Self {
            _inner: Arc::new(inner),
        })
    }

    pub fn pattern(expr: &str) -> Result<Self, LinkError> {
        let inner = InnerTopic::pattern(expr)?;
        Ok(Self {
            _inner: Arc::new(inner),
        })
    }

    pub fn channel_topic(
        peer: &str,
        channel: amos_link::keyexpr::Channel,
        name: &str,
    ) -> Result<Self, LinkError> {
        let inner = InnerTopic::channel_topic(peer, channel, name)?;
        Ok(Self {
            _inner: Arc::new(inner),
        })
    }

    pub fn peer_pattern(peer: &str) -> Result<Self, LinkError> {
        let inner = InnerTopic::peer_pattern(peer)?;
        Ok(Self {
            _inner: Arc::new(inner),
        })
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
fn global_runtime() -> Result<&'static tokio::runtime::Runtime, LinkError> {
    static RT: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .thread_name("amos-link-cc-runtime")
            .build()
            .map_err(|e| format!("tokio runtime: {e}"))
    })
    .as_ref()
    .map_err(|e| LinkError::Transport(e.clone()))
}

thread_local! {
    static LAST_ERROR: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
    /// The NUL-terminated copy handed out by [`amos_link_last_error`]. Refreshed on every
    /// call, so the pointer stays valid until the next `amos-link-cc` call **on the same
    /// thread** — the ordinary `strerror` contract. Before REQ-A388 this function
    /// `Box::leak`ed a fresh string per call: a C error loop leaked every byte it read.
    static LAST_ERROR_C: std::cell::RefCell<Option<std::ffi::CString>> =
        const { std::cell::RefCell::new(None) };
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
fn block_on_sync<F: std::future::Future>(f: F) -> Result<F::Output, LinkError> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| LinkError::Transport(format!("tokio runtime: {e}")))?;
    Ok(rt.block_on(f))
}

fn cstr_to_str<'a>(ptr: *const c_char) -> Result<&'a str, LinkError> {
    if ptr.is_null() {
        return Err(LinkError::Codec("null C string".into()));
    }
    // SAFETY: `ptr` was checked non-null above and the C ABI requires a NUL-terminated string; the loop stops at the first NUL, so it only reads bytes the caller promised.
    let len = unsafe {
        let mut n = 0;
        while *ptr.add(n) != 0 {
            n += 1;
        }
        n
    };
    // SAFETY: `len` was measured by scanning this very pointer for its NUL just above, so `ptr` holds `len` readable bytes.
    let bytes = unsafe { slice::from_raw_parts(ptr as *const u8, len) };
    std::str::from_utf8(bytes).map_err(|e| LinkError::Codec(format!("invalid UTF-8: {e}")))
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
    // SAFETY: `dst` is the caller's out-buffer with `cap > 0` (checked above) and `n <= cap - 1`; `src` is our own Rust string, so the two ranges cannot overlap.
    unsafe {
        ptr::copy_nonoverlapping(bytes.as_ptr() as *const c_char, dst, n);
        *dst.add(n) = 0;
    }
    0
}

/// Write a NUL at offset `off` in a C array stored in a raw pointer.
/// # Safety
///
/// `arr` must be writable at `off` bytes past its base: callers pass either an out-struct's
/// fixed-size array (see `amos_link_received` / `amos_link_frame_header` in the C header) or
/// a buffer whose capacity they documented in the same call.
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

/// # Safety
///
/// `id` must be a NUL-terminated UTF-8 C string (a null pointer is answered with an error code,
/// never undefined behaviour).
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

/// # Safety
///
/// `id` must be a NUL-terminated UTF-8 C string (a null pointer is answered with an error code,
/// never undefined behaviour); `out` must be writable for `AMLK_MAX_PEER_ID_LEN + 1` bytes.
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

/// # Safety
///
/// `expr` must be a NUL-terminated UTF-8 C string (a null pointer is answered with an error code,
/// never undefined behaviour).
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

/// # Safety
///
/// `expr` must be a NUL-terminated UTF-8 C string (a null pointer is answered with an error code,
/// never undefined behaviour).
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

/// # Safety
///
/// `peer` and `name` must be a NUL-terminated UTF-8 C string (a null pointer is answered with an
/// error code, never undefined behaviour); `out` must be writable for `AMLK_MAX_TOPIC_LEN + 1`
/// bytes.
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

/// # Safety
///
/// `peer` must be a NUL-terminated UTF-8 C string (a null pointer is answered with an error code,
/// never undefined behaviour); `out` must be writable for `AMLK_MAX_TOPIC_LEN + 1` bytes.
#[no_mangle]
pub unsafe extern "C" fn amos_link_topic_peer_pattern(
    peer: *const c_char,
    out: *mut c_char,
) -> i32 {
    match cstr_to_str(peer) {
        Ok(s) => match InnerTopic::peer_pattern(s) {
            Ok(t) => copy_str(t.as_str(), out, AMLK_MAX_TOPIC_LEN + 1),
            Err(e) => set_error(&e),
        },
        Err(e) => set_error(&e),
    }
}

/// # Safety
///
/// `topic` and `pattern` must be live pointers to this crate's `#[repr(C)]` mirror of `Topic` (null
/// answers `false`). NOTE: no entry point hands a `Topic` out yet, so a C caller cannot obtain a
/// valid argument — this function is unreachable until a constructor exists (recorded in
/// `CHANGELOG.md`, REQ-A388).
#[no_mangle]
pub unsafe extern "C" fn amos_link_topic_matches(
    topic: *const Topic,
    pattern: *const Topic,
) -> bool {
    if topic.is_null() || pattern.is_null() {
        return false;
    }
    // SAFETY: `topic` was checked non-null above; per the C ABI it is a live pointer to this crate's `#[repr(C)]` mirror of `Topic`, and only a shared reference is taken.
    let t = unsafe { &*topic };
    // SAFETY: `pattern` was checked non-null above; same contract as `topic` above.
    let p = unsafe { &*pattern };
    // Use the upstream matches method.
    amos_link::keyexpr::Topic::matches(&t._inner, &p._inner)
}

// ---------------------------------------------------------------------------
// QoS
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn amos_link_qos_new(
    reliability: amos_link_reliability,
    depth: u32,
    drop_policy: amos_link_drop_policy,
) -> Qos {
    Qos::new(reliability, depth, drop_policy)
}

#[no_mangle]
pub extern "C" fn amos_link_qos_sensor() -> Qos {
    Qos::sensor()
}

#[no_mangle]
pub extern "C" fn amos_link_qos_state() -> Qos {
    Qos::state()
}

#[no_mangle]
pub extern "C" fn amos_link_qos_control() -> Qos {
    Qos::control()
}

#[no_mangle]
pub extern "C" fn amos_link_qos_default() -> Qos {
    Qos::default()
}

#[no_mangle]
pub extern "C" fn amos_link_qos_for_channel(channel: amos_link_channel) -> Qos {
    Qos::for_channel(ch_to_channel(channel))
}

#[no_mangle]
pub extern "C" fn amos_link_qos_validate(qos: Qos) -> i32 {
    match qos.validate() {
        Ok(()) => 0,
        Err(e) => set_error(&e),
    }
}

// ---------------------------------------------------------------------------
// Timestamp / Clock
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn amos_link_timestamp_now() -> Timestamp {
    Timestamp::now()
}

#[no_mangle]
pub extern "C" fn amos_link_timestamp_new(secs: u64, nanos: u32) -> Timestamp {
    Timestamp::new(secs, nanos).unwrap_or(Timestamp {
        secs,
        nanos: 999_999_999,
    })
}

#[no_mangle]
pub extern "C" fn amos_link_timestamp_as_nanos(stamp: Timestamp) -> u64 {
    stamp.as_nanos()
}

#[no_mangle]
pub extern "C" fn amos_link_timestamp_unix_ms(stamp: Timestamp) -> u64 {
    stamp.unix_ms()
}

#[no_mangle]
pub extern "C" fn amos_link_timestamp_since_secs(earlier: Timestamp, later: Timestamp) -> f64 {
    Timestamp::since_secs(earlier, later)
}

#[no_mangle]
pub extern "C" fn amos_link_timestamp_is_valid(stamp: Timestamp) -> bool {
    stamp.is_valid()
}

// ---------------------------------------------------------------------------
// Codec / framing
// ---------------------------------------------------------------------------

/// Encode a bincode payload into a full wire frame synchronously.
/// # Safety
///
/// `topic_str` and `peer_id_str` must be a NUL-terminated UTF-8 C string (a null pointer is
/// answered with an error code, never undefined behaviour); `payload` must point to `payload_len`
/// readable bytes (`NULL, 0` is the empty payload, `NULL, n>0` is refused); `frame_out` must be
/// writable for `frame_out_cap` bytes.
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
        Err(e) => {
            set_error(&e);
            return 0;
        }
    };
    let peer_s = match cstr_to_str(peer_id_str) {
        Ok(s) => s,
        Err(e) => {
            set_error(&e);
            return 0;
        }
    };
    if payload.is_null() && payload_len > 0 {
        set_error(&LinkError::Codec(
            "null payload with non-zero length".into(),
        ));
        return 0;
    }
    let payload_slice = if payload.is_null() || payload_len == 0 {
        &[]
    } else {
        slice::from_raw_parts(payload, payload_len)
    };

    let topic = match Topic::new(topic_s) {
        Ok(t) => t,
        Err(e) => {
            set_error(&e);
            return 0;
        }
    };
    let peer = match PeerId::new(peer_s) {
        Ok(p) => p,
        Err(e) => {
            set_error(&e);
            return 0;
        }
    };

    // The payload bytes are already encoded by the caller (e.g., C code did the serialization),
    // so we pass them directly to the envelope without calling .encode() again.
    let payload_vec = payload_slice.to_vec();

    let envelope = Envelope::new(&topic._inner, &peer, seq, stamp.into(), payload_vec);
    let wire = match envelope.encode() {
        Ok(w) => w,
        Err(e) => {
            set_error(&e);
            return 0;
        }
    };
    let n = wire.len().min(frame_out_cap);
    if n > 0 {
        ptr::copy_nonoverlapping(wire.as_ptr(), frame_out, n);
    }
    n
}

/// Decode only the frame header (payload slice is borrowed, not copied).
/// # Safety
///
/// `frame` must point to `frame_len` readable bytes — this function does **not** check for null or
/// zero, it decodes immediately; `h` must be a caller-owned `amos_link_frame_header` whose
/// `topic`/`peer_id` arrays use the header's sizes (`AMLK_MAX_TOPIC_LEN` / `AMLK_MAX_PEER_ID_LEN`).
#[no_mangle]
pub unsafe extern "C" fn amos_link_frame_decode_header(
    frame: *const u8,
    frame_len: usize,
    h: *mut amos_link_frame_header,
) -> i32 {
    if check_null(h).is_none() {
        return -2;
    }
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
/// # Safety
///
/// `frame` must point to `frame_len` readable bytes (null/0 is refused with an error);
/// `payload_out` must be writable for `payload_cap` bytes — a payload that does not fit is refused,
/// not truncated.
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
/// # Safety
///
/// `data` must point to `len` readable bytes (`NULL`/`0` returns `0`).
#[no_mangle]
pub unsafe extern "C" fn amos_link_crc32(data: *const u8, len: usize) -> u32 {
    if data.is_null() || len == 0 {
        return 0;
    }
    let slice = slice::from_raw_parts(data, len);
    crc32fast::hash(slice)
}

/// CRC32 of header || payload combined.
/// # Safety
///
/// `header`/`payload` must each point to their `_len` readable bytes; a null or zero-length part is
/// skipped.
#[no_mangle]
pub unsafe extern "C" fn amos_link_crc32_combine(
    header: *const u8,
    h_len: usize,
    payload: *const u8,
    p_len: usize,
) -> u32 {
    let mut hasher = Hasher::new();
    if !header.is_null() && h_len > 0 {
        // SAFETY: the null/zero-length case is excluded by the branch above, so `header` points to `h_len` readable bytes per the caller contract.
        let h = unsafe { slice::from_raw_parts(header, h_len) };
        hasher.update(h);
    }
    if !payload.is_null() && p_len > 0 {
        // SAFETY: as above for `header`: the branch above guarantees `payload` points to `p_len` readable bytes.
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

/// # Safety
///
/// `peer_id` must be a NUL-terminated UTF-8 C string (a null pointer is answered with an error
/// code, never undefined behaviour). The returned handle owns a `Box<Arc<LinkNode>>` and must be
/// released with `amos_link_node_drop` (each clone counts separately).
#[no_mangle]
pub unsafe extern "C" fn amos_link_node_new(
    peer_id: *const c_char,
    kind: amos_link_node_kind,
) -> *mut amos_link_node {
    let peer_s = match cstr_to_str(peer_id) {
        Ok(s) => s,
        Err(e) => {
            set_error(&e);
            return ptr::null_mut();
        }
    };
    let pid = match PeerId::new(peer_s) {
        Ok(p) => p,
        Err(e) => {
            set_error(&e);
            return ptr::null_mut();
        }
    };
    let node = LinkNode::in_process(pid, node_kind_to_aml(kind));
    Box::into_raw(Box::new(node)) as *mut amos_link_node
}

/// # Safety
///
/// `node` must be a live handle from `amos_link_node_new`/`amos_link_node_clone` that has not been
/// dropped. The returned handle is a new owned reference and must be dropped too.
#[no_mangle]
pub unsafe extern "C" fn amos_link_node_clone(node: *const amos_link_node) -> *mut amos_link_node {
    if let Some(node) = check_null(node) {
        // SAFETY: `node` passed `check_null` above and is a live `Box<Arc<LinkNode>>`. The cast is the same shape `amos_link_node_new` created (`Box::into_raw(Box::new(Arc<LinkNode>))`), so reading it as an `Arc` is the correct type — `Arc::clone` below is what makes the new handle a real second owner.
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        let cloned: Arc<LinkNode> = Arc::clone(n);
        Box::into_raw(Box::new(cloned)) as *mut amos_link_node
    } else {
        ptr::null_mut()
    }
}

/// # Safety
///
/// `node` must be a handle from `amos_link_node_new`/`_clone` that has **not** been dropped: this
/// takes ownership back. Using the handle afterwards (including a second drop) is undefined
/// behaviour. A null pointer is ignored.
#[no_mangle]
pub unsafe extern "C" fn amos_link_node_drop(node: *mut amos_link_node) {
    if !node.is_null() {
        // SAFETY: takes back the `Box` that `amos_link_node_new`/`_clone` leaked. The C contract is that a handle reaches its drop exactly once and is never used afterwards (the null case is excluded above).
        drop(unsafe { Box::from_raw(node as *mut Arc<LinkNode>) });
    }
}

/// # Safety
///
/// `node` must be a live handle (see `amos_link_node_drop`); `buf` must be writable for `cap`
/// bytes.
#[no_mangle]
pub unsafe extern "C" fn amos_link_node_peer_id(
    node: *const amos_link_node,
    buf: *mut c_char,
    cap: usize,
) -> i32 {
    if let Some(node) = check_null(node) {
        // SAFETY: `node` passed the null check above and is a live handle from `amos_link_node_new`/`_clone` — a `Box<Arc<LinkNode>>` that stays allocated until `amos_link_node_drop`; a shared reference for the duration of the call is sound, and the `Arc` is what lets several threads read the same node.
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        copy_str(n.peer().as_str(), buf, cap)
    } else {
        -2
    }
}

/// # Safety
///
/// `node` must be a live handle (see `amos_link_node_drop`); null answers `NodeTool`.
#[no_mangle]
pub unsafe extern "C" fn amos_link_node_get_kind(
    node: *const amos_link_node,
) -> amos_link_node_kind {
    if let Some(node) = check_null(node) {
        // SAFETY: `node` passed the null check above and is a live handle from `amos_link_node_new`/`_clone` — a `Box<Arc<LinkNode>>` that stays allocated until `amos_link_node_drop`; a shared reference for the duration of the call is sound, and the `Arc` is what lets several threads read the same node.
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        aml_kind_to_node(&n.kind())
    } else {
        amos_link_node_kind::NodeTool
    }
}

/// # Safety
///
/// `node` must be a live handle (see `amos_link_node_drop`); null answers `0`.
#[no_mangle]
pub unsafe extern "C" fn amos_link_node_uptime_ms(node: *const amos_link_node) -> u64 {
    if let Some(node) = check_null(node) {
        // SAFETY: `node` passed the null check above and is a live handle from `amos_link_node_new`/`_clone` — a `Box<Arc<LinkNode>>` that stays allocated until `amos_link_node_drop`; a shared reference for the duration of the call is sound, and the `Arc` is what lets several threads read the same node.
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        n.uptime_ms()
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn amos_link_version() -> *const c_char {
    AMLINK_VERSION.as_ptr() as *const c_char
}

/// # Safety
///
/// `node` must be a live handle (see `amos_link_node_drop`); `buf` must be writable for
/// `AMLK_MAX_TOPIC_LEN + 1` bytes.
#[no_mangle]
pub unsafe extern "C" fn amos_link_node_heartbeat_topic(
    node: *const amos_link_node,
    buf: *mut c_char,
) -> i32 {
    if let Some(node) = check_null(node) {
        // SAFETY: `node` passed the null check above and is a live handle from `amos_link_node_new`/`_clone` — a `Box<Arc<LinkNode>>` that stays allocated until `amos_link_node_drop`; a shared reference for the duration of the call is sound, and the `Arc` is what lets several threads read the same node.
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
        let pubr = self
            .node
            .publisher::<BincodePayload>((*self.topic._inner).clone());
        block_on_sync(pubr.publish(&bp))?
    }
}

/// # Safety
///
/// `node` must be a live handle (see `amos_link_node_drop`); `topic_str` must be a NUL-terminated
/// UTF-8 C string (a null pointer is answered with an error code, never undefined behaviour). The
/// returned publisher must be released with `amos_link_publisher_drop` **before** the node it was
/// built from.
#[no_mangle]
pub unsafe extern "C" fn amos_link_publisher_new(
    node: *const amos_link_node,
    topic_str: *const c_char,
) -> *mut amos_link_publisher {
    let topic_s = match cstr_to_str(topic_str) {
        Ok(s) => s,
        Err(e) => {
            set_error(&e);
            return ptr::null_mut();
        }
    };
    let topic = match Topic::new(topic_s) {
        Ok(t) => t,
        Err(e) => {
            set_error(&e);
            return ptr::null_mut();
        }
    };
    if let Some(node) = check_null(node) {
        // SAFETY: `node` passed the null check above and is a live handle from `amos_link_node_new`/`_clone` — a `Box<Arc<LinkNode>>` that stays allocated until `amos_link_node_drop`; a shared reference for the duration of the call is sound, and the `Arc` is what lets several threads read the same node.
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

/// # Safety
///
/// `pubr` must be a publisher from `amos_link_publisher_new` that has not been dropped; this takes
/// ownership back (a second drop, or publishing afterwards, is undefined behaviour). A null pointer
/// is ignored.
#[no_mangle]
pub unsafe extern "C" fn amos_link_publisher_drop(pubr: *mut amos_link_publisher) {
    if !pubr.is_null() {
        // SAFETY: takes back the `Box<SimplePublisher>` created by `amos_link_publisher_new`; the handle must reach its drop exactly once (the null case is excluded above).
        drop(unsafe { Box::from_raw(pubr as *mut SimplePublisher) });
    }
}

/// # Safety
///
/// `pubr` must be a live publisher handle; `payload` must point to `payload_len` readable bytes
/// (`NULL, 0` publishes an empty payload, `NULL, n>0` is refused).
#[no_mangle]
pub unsafe extern "C" fn amos_link_publisher_publish(
    pubr: *const amos_link_publisher,
    payload: *const u8,
    payload_len: usize,
) -> i32 {
    if let Some(pubr) = check_null(pubr) {
        // SAFETY: `pubr` passed `check_null` above and is a live `Box<SimplePublisher>` handle.
        let sp = unsafe { &*(pubr as *const SimplePublisher) };
        // `NULL, 0` is how C spells "empty payload" and `amos_link_frame_encode` accepts
        // it; `slice::from_raw_parts` does **not** (a null pointer is UB even for len 0),
        // so build the empty slice here. `NULL, n>0` is a caller bug and is reported
        // instead of silently publishing nothing (same sentence as frame_encode).
        if payload.is_null() && payload_len > 0 {
            return set_error(&LinkError::Codec(
                "null payload with non-zero length".into(),
            ));
        }
        let payload_slice: &[u8] = if payload.is_null() || payload_len == 0 {
            &[]
        } else {
            // SAFETY: the null/empty cases are handled by the guard just above, so `payload` points to `payload_len` readable bytes (the caller's promise, stated in this function's `# Safety`).
            unsafe { slice::from_raw_parts(payload, payload_len) }
        };
        match sp.publish_sync(payload_slice) {
            Ok(_) => 0,
            Err(e) => set_error(&e),
        }
    } else {
        -2
    }
}

/// # Safety
///
/// `pubr` must be a live publisher handle; `buf` must be writable for `cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn amos_link_publisher_topic(
    pubr: *const amos_link_publisher,
    buf: *mut c_char,
    cap: usize,
) -> i32 {
    if let Some(pubr) = check_null(pubr) {
        // SAFETY: `pubr` passed `check_null` above and is a live `Box<SimplePublisher>` handle.
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

/// # Safety
///
/// `node` must be a live handle (see `amos_link_node_drop`); `pattern_str` must be a NUL-terminated
/// UTF-8 C string (a null pointer is answered with an error code, never undefined behaviour). The
/// returned subscriber owns a background thread and must be released with
/// `amos_link_subscriber_drop`.
#[no_mangle]
pub unsafe extern "C" fn amos_link_subscriber_new(
    node: *const amos_link_node,
    pattern_str: *const c_char,
    qos: Qos,
) -> *mut amos_link_subscriber {
    let pattern_s = match cstr_to_str(pattern_str) {
        Ok(s) => s,
        Err(e) => {
            set_error(&e);
            return ptr::null_mut();
        }
    };
    let pattern = match InnerTopic::pattern(pattern_s) {
        Ok(t) => t,
        Err(e) => {
            set_error(&e);
            return ptr::null_mut();
        }
    };
    if let Some(node) = check_null(node) {
        // SAFETY: `node` passed the null check above and is a live handle from `amos_link_node_new`/`_clone` — a `Box<Arc<LinkNode>>` that stays allocated until `amos_link_node_drop`; a shared reference for the duration of the call is sound, and the `Arc` is what lets several threads read the same node.
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        let node_clone = Arc::clone(n);
        let pattern_clone = pattern.clone();
        let qos_clone = qos;

        let sub = match block_on_sync(async move {
            node_clone
                .subscriber::<BincodePayload>(pattern_clone, qos_clone.into())
                .await
        }) {
            Ok(s) => s,
            Err(e) => {
                set_error(&e);
                return ptr::null_mut();
            }
        };

        match sub {
            Ok(mut subscription) => {
                let (payload_tx, payload_rx) = std::sync::mpsc::channel();
                let (meta_tx, meta_rx) = std::sync::mpsc::channel();
                let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let closed_clone = closed.clone();

                let thread = std::thread::spawn(move || {
                    let rt = match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(rt) => rt,
                        Err(_) => {
                            // No runtime means no reader: mark the subscription closed so
                            // `poll`/`recv` answer `Closed` instead of a caller waiting
                            // forever — and never panic in a thread we spawned (P0-1).
                            closed_clone.store(true, std::sync::atomic::Ordering::SeqCst);
                            return;
                        }
                    };
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
                                        Timestamp {
                                            secs: ts.secs,
                                            nanos: ts.nanos,
                                        },
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
            Err(e) => {
                set_error(&e);
                ptr::null_mut()
            }
        }
    } else {
        ptr::null_mut()
    }
}

/// # Safety
///
/// `sub` must be a subscriber from `amos_link_subscriber_new` that has not been dropped; this takes
/// ownership back and stops its background thread. A second drop, or polling afterwards, is
/// undefined behaviour. A null pointer is ignored.
#[no_mangle]
pub unsafe extern "C" fn amos_link_subscriber_drop(sub: *mut amos_link_subscriber) {
    if !sub.is_null() {
        // SAFETY: takes back the `Box<SimpleSubscriber>` created by `amos_link_subscriber_new`; the handle must reach its drop exactly once (the null case is excluded above).
        drop(unsafe { Box::from_raw(sub as *mut SimpleSubscriber) });
    }
}

/// # Safety
///
/// `sub` must be a live subscriber handle; `received` must be a caller-owned `amos_link_received`
/// with the header's array sizes; `payload_buf` must be writable for `payload_cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn amos_link_subscriber_poll(
    sub: *const amos_link_subscriber,
    received: *mut amos_link_received,
    payload_buf: *mut u8,
    payload_cap: usize,
) -> amos_link_poll {
    if check_null(sub).is_none() {
        return amos_link_poll::Closed;
    }
    if check_null(received).is_none() {
        return amos_link_poll::Closed;
    }

    // SAFETY: `sub` passed the null checks above and is a live `Box<SimpleSubscriber>` handle.
    let s = unsafe { &*(sub as *const SimpleSubscriber) };

    if s.closed.load(std::sync::atomic::Ordering::SeqCst) {
        return amos_link_poll::Closed;
    }

    match s.meta_rx.try_recv() {
        Ok((topic, peer, seq, stamp, frame_len)) => {
            let payload_bytes = s
                .payload_rx
                .try_recv()
                .unwrap_or_else(|_| BincodePayload(Vec::new()));

            // SAFETY: `received` was checked non-null above and the C header fixes its array sizes (topic `AMLK_MAX_TOPIC_LEN`, peer_id `AMLK_MAX_PEER_ID_LEN`); every copy is bounded by `min(len, max - 1)` and the payload by `payload_cap`.
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
        Err(std::sync::mpsc::TryRecvError::Disconnected) => amos_link_poll::Closed,
        Err(_) => amos_link_poll::Pending,
    }
}

/// # Safety
///
/// `sub` must be a live subscriber handle; `received` must be a caller-owned `amos_link_received`
/// with the header's array sizes; `payload_buf` must be writable for `payload_cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn amos_link_subscriber_recv(
    sub: *const amos_link_subscriber,
    received: *mut amos_link_received,
    payload_buf: *mut u8,
    payload_cap: usize,
) -> amos_link_poll {
    if check_null(sub).is_none() {
        return amos_link_poll::Closed;
    }
    if check_null(received).is_none() {
        return amos_link_poll::Closed;
    }

    // SAFETY: `sub` passed the null checks above and is a live `Box<SimpleSubscriber>` handle.
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
        match s
            .payload_rx
            .recv_timeout(std::time::Duration::from_millis(10))
        {
            Ok(b) => break b,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if s.closed.load(std::sync::atomic::Ordering::SeqCst) {
                    return amos_link_poll::Closed;
                }
            }
            Err(_) => return amos_link_poll::Closed,
        }
    };

    // SAFETY: `received` was checked non-null above and the C header fixes its array sizes (topic `AMLK_MAX_TOPIC_LEN`, peer_id `AMLK_MAX_PEER_ID_LEN`); every copy is bounded by `min(len, max - 1)` and the payload by `payload_cap`.
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

/// # Safety
///
/// `sub` must be a live subscriber handle; `stats` must be a caller-owned, writable
/// `amos_link_sub_stats`.
#[no_mangle]
pub unsafe extern "C" fn amos_link_subscriber_stats(
    sub: *const amos_link_subscriber,
    stats: *mut amos_link_sub_stats,
) -> i32 {
    if check_null(stats).is_none() {
        return -2;
    }
    if check_null(sub).is_none() {
        return -2;
    }
    // SAFETY: `sub` passed the null checks above and is a live `Box<SimpleSubscriber>` handle.
    let _s = unsafe { &*(sub as *const SimpleSubscriber) };
    // Stats are maintained in the background thread; return zeros for now.
    // SAFETY: `stats` was checked non-null above and is a caller-owned, writable `amos_link_sub_stats` (the header's contract for this parameter).
    unsafe {
        (*stats).received = 0;
        (*stats).dropped = 0;
        (*stats).decode_errors = 0;
    }
    0
}

/// # Safety
///
/// `sub` must be a live subscriber handle; null answers `false`.
#[no_mangle]
pub unsafe extern "C" fn amos_link_subscriber_has_pending(
    sub: *const amos_link_subscriber,
) -> bool {
    if check_null(sub).is_some() {
        // SAFETY: `sub` passed the null checks above and is a live `Box<SimpleSubscriber>` handle.
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

/// # Safety
///
/// `node` must be a live handle (see `amos_link_node_drop`); `metrics` must be a caller-owned,
/// writable `amos_link_metrics`.
#[no_mangle]
pub unsafe extern "C" fn amos_link_node_metrics(
    node: *const amos_link_node,
    metrics: *mut amos_link_metrics,
) -> i32 {
    if check_null(node).is_none() {
        return -2;
    }
    if check_null(metrics).is_none() {
        return -2;
    }
    // SAFETY: `node` passed the null check above and is a live handle from `amos_link_node_new`/`_clone` — a `Box<Arc<LinkNode>>` that stays allocated until `amos_link_node_drop`; a shared reference for the duration of the call is sound, and the `Arc` is what lets several threads read the same node.
    let n = unsafe { &*(node as *const Arc<LinkNode>) };
    let snap = n.metrics().snapshot();
    // SAFETY: `metrics` was checked non-null above and is a caller-owned, writable `amos_link_metrics` the caller handed us for exactly this write.
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

/// # Safety
///
/// `m` must point to a readable `amos_link_metrics` — normally the struct a caller filled through
/// `amos_link_node_metrics` or `amos_link_evaluate_health`; null answers `0`.
#[no_mangle]
pub unsafe extern "C" fn amos_link_metrics_delivery_ratio(m: *const amos_link_metrics) -> u32 {
    if let Some(m) = check_null(m) {
        // SAFETY: `m` passed `check_null` above and points to a readable `amos_link_metrics` — normally the struct a caller filled through `amos_link_node_metrics`.
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

/// # Safety
///
/// `metrics` must point to a readable `amos_link_metrics`; `peers` must point to `num_peers`
/// `amos_link_peer_view` values whose `id` arrays are NUL-terminated (a null pointer or `0` counts
/// as an empty peer list).
#[no_mangle]
pub unsafe extern "C" fn amos_link_evaluate_health(
    metrics: *const amos_link_metrics,
    peers: *const amos_link_peer_view,
    num_peers: usize,
    clock_synced: bool,
) -> amos_link_health {
    if check_null(metrics).is_none() {
        return amos_link_health {
            state: amos_link_health_state::Unknown,
            reason: [0; 256],
        };
    }
    // SAFETY: `metrics` was checked non-null above and points to a readable `amos_link_metrics`; the fields are copied out by value, nothing is retained.
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
        // SAFETY: the null/zero case is excluded by the branch above, so `peers` points to `num_peers` `amos_link_peer_view` values the caller owns.
        let slice = unsafe { slice::from_raw_parts(peers, num_peers) };
        slice
            .iter()
            .filter_map(|pv| {
                // SAFETY: each `id` array is a fixed-size `char` array the caller filled and NUL-terminated (the header's contract, repeated in this function's `# Safety`); the scan stops at the first NUL, and `pv` comes from the slice above, which is in bounds.
                let pid_str = unsafe {
                    let mut n = 0;
                    while *pv.id.as_ptr().add(n) != 0 {
                        n += 1;
                    }
                    std::str::from_utf8(slice::from_raw_parts(pv.id.as_ptr() as *const u8, n))
                        .ok()?
                        .to_string()
                };
                let pid = PeerId::new(pid_str).ok()?;
                Some(PeerView {
                    info: PeerInfo::new(pid, NodeKind::Robot),
                    last_seen_ms: pv.last_seen_ms,
                    beacons: pv.beacons,
                })
            })
            .collect()
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
        let reason_str = reasons
            .iter()
            .map(HealthReason::detail)
            .collect::<Vec<_>>()
            .join("; ");
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

/// # Safety
///
/// `node` must be a live handle (see `amos_link_node_drop`); `peers_out` must be writable for
/// `max_peers` `amos_link_peer_view` values (fewer are written if there are fewer).
#[no_mangle]
pub unsafe extern "C" fn amos_link_node_peers(
    node: *const amos_link_node,
    peers_out: *mut amos_link_peer_view,
    max_peers: usize,
) -> usize {
    if check_null(node).is_none() {
        return 0;
    }
    if check_null_mut(peers_out).is_none() {
        return 0;
    }
    // SAFETY: `node` passed the null check above and is a live handle from `amos_link_node_new`/`_clone` — a `Box<Arc<LinkNode>>` that stays allocated until `amos_link_node_drop`; a shared reference for the duration of the call is sound, and the `Arc` is what lets several threads read the same node.
    let n = unsafe { &*(node as *const Arc<LinkNode>) };
    let peers = match block_on_sync(n.peers()) {
        Ok(p) => p,
        Err(e) => {
            set_error(&e);
            return 0;
        }
    };
    let n_write = peers.len().min(max_peers);
    for (i, view) in peers.iter().take(n_write).enumerate() {
        // SAFETY: `peers_out` was checked non-null above and `i` runs over `min(peers.len(), max_peers)`, so each `add(i)` stays inside the caller's array; the loop writes each element once, so no two `&mut` overlap.
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

/// # Safety
///
/// `node` must be a live handle (see `amos_link_node_drop`); `topics_out` must be writable for
/// `max_topics` `amos_link_topic_entry` values (fewer are written if there are fewer).
#[no_mangle]
pub unsafe extern "C" fn amos_link_node_topics(
    node: *const amos_link_node,
    topics_out: *mut amos_link_topic_entry,
    max_topics: usize,
) -> usize {
    if check_null(node).is_none() {
        return 0;
    }
    if check_null_mut(topics_out).is_none() {
        return 0;
    }
    // SAFETY: `node` passed the null check above and is a live handle from `amos_link_node_new`/`_clone` — a `Box<Arc<LinkNode>>` that stays allocated until `amos_link_node_drop`; a shared reference for the duration of the call is sound, and the `Arc` is what lets several threads read the same node.
    let n = unsafe { &*(node as *const Arc<LinkNode>) };
    let topics = match block_on_sync(n.topics()) {
        Ok(t) => t,
        Err(e) => {
            set_error(&e);
            return 0;
        }
    };
    let n_write = topics.len().min(max_topics);
    for (i, t) in topics.iter().take(n_write).enumerate() {
        // SAFETY: `topics_out` was checked non-null above and `i` runs over `min(topics.len(), max_topics)`, so each `add(i)` stays inside the caller's array.
        let entry = unsafe { &mut *topics_out.add(i) };
        copy_str(t.as_str(), entry.topic.as_ptr() as *mut c_char, 1024);
    }
    n_write
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/// # Safety
///
/// `node` must be a live handle (see `amos_link_node_drop`). The returned heartbeat owns a
/// `Box<Heartbeat>` and must be released with `amos_link_heartbeat_drop`.
#[no_mangle]
pub unsafe extern "C" fn amos_link_node_heartbeat(
    node: *const amos_link_node,
) -> *mut amos_link_heartbeat {
    if let Some(node) = check_null(node) {
        // SAFETY: `node` passed the null check above and is a live handle from `amos_link_node_new`/`_clone` — a `Box<Arc<LinkNode>>` that stays allocated until `amos_link_node_drop`; a shared reference for the duration of the call is sound, and the `Arc` is what lets several threads read the same node.
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        let beat = n.heartbeat();
        Box::into_raw(Box::new(beat)) as *mut amos_link_heartbeat
    } else {
        ptr::null_mut()
    }
}

/// # Safety
///
/// `beat` must be a live heartbeat handle; `frame_out` must be writable for `AMLK_MAX_FRAME_BYTES`
/// bytes — the signature carries no capacity parameter, so that constant *is* the capacity contract
/// (a heartbeat frame is far smaller in practice; see the `CHANGELOG.md` note, REQ-A388).
#[no_mangle]
pub unsafe extern "C" fn amos_link_heartbeat_encode(
    beat: *const amos_link_heartbeat,
    frame_out: *mut u8,
) -> i32 {
    if frame_out.is_null() {
        return set_error(&LinkError::Codec("null output buffer".into()));
    }
    if let Some(beat) = check_null(beat) {
        // SAFETY: `beat` passed `check_null` above and is a live heartbeat handle created by `amos_link_node_heartbeat` (a `Box` leaked to the ABI, released by `amos_link_heartbeat_drop`).
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

/// # Safety
///
/// `beat` must be a heartbeat from `amos_link_node_heartbeat` that has not been dropped; this takes
/// ownership back. A null pointer is ignored.
#[no_mangle]
pub unsafe extern "C" fn amos_link_heartbeat_drop(beat: *mut amos_link_heartbeat) {
    if !beat.is_null() {
        // SAFETY: takes back the `Box` created by `amos_link_node_heartbeat`; the handle must reach its drop exactly once (the null case is excluded above).
        drop(unsafe { Box::from_raw(beat as *mut Heartbeat) });
    }
}

/// # Safety
///
/// `frame` must point to `frame_len` readable bytes; `fields` must be a caller-owned, writable
/// `amos_link_heartbeat_fields` with the header's array sizes.
#[no_mangle]
pub unsafe extern "C" fn amos_link_heartbeat_decode(
    frame: *const u8,
    frame_len: usize,
    fields: *mut amos_link_heartbeat_fields,
) -> i32 {
    if check_null(fields).is_none() {
        return -2;
    }
    // SAFETY: `frame` points to `frame_len` readable bytes — the caller's contract (this is the inverse of `amos_link_heartbeat_encode`, which produced such a frame); `fields` was checked non-null above.
    let frame_slice = unsafe { slice::from_raw_parts(frame, frame_len) };
    match Envelope::decode(frame_slice) {
        Ok(env) => match Heartbeat::decode(&env.payload) {
            Ok(beat) => {
                let max_peer = 64usize;
                let pid_s = beat.peer.as_str();
                let copy_pid = pid_s.len().min(max_peer - 1);
                // SAFETY: `fields` was checked non-null above and the header fixes its array sizes (`peer_id` is `AMLK_MAX_PEER_ID_LEN`); the copy is bounded by `min(len, max - 1)` and followed by a NUL.
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
        },
        Err(e) => set_error(&e),
    }
}

// ---------------------------------------------------------------------------
// Federation
// ---------------------------------------------------------------------------

/// # Safety
///
/// `node` must be a live handle (see `amos_link_node_drop`). The returned task must be stopped with
/// `amos_link_federation_stop`.
#[no_mangle]
pub unsafe extern "C" fn amos_link_node_spawn_federation(
    node: *const amos_link_node,
    period_ms: u64,
) -> *mut amos_link_federation_task {
    if let Some(node) = check_null(node) {
        // SAFETY: `node` passed the null check above and is a live handle from `amos_link_node_new`/`_clone` — a `Box<Arc<LinkNode>>` that stays allocated until `amos_link_node_drop`; a shared reference for the duration of the call is sound, and the `Arc` is what lets several threads read the same node.
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        let node_clone = Arc::clone(n);
        let period = Duration::from_millis(period_ms);

        // Use the global runtime to provide context for tokio::spawn
        let rt = match global_runtime() {
            Ok(rt) => rt,
            Err(e) => {
                set_error(&e);
                return ptr::null_mut();
            }
        };
        let _guard = rt.enter();

        match node_clone.spawn_federation(period) {
            Ok(t) => Box::into_raw(Box::new(t)) as *mut amos_link_federation_task,
            Err(e) => {
                set_error(&e);
                ptr::null_mut()
            }
        }
    } else {
        ptr::null_mut()
    }
}

/// # Safety
///
/// `node` must be a live handle (see `amos_link_node_drop`); `endpoint` must be a NUL-terminated
/// UTF-8 C string (a null pointer is answered with an error code, never undefined behaviour). The
/// returned task must be stopped with `amos_link_federation_stop`.
#[no_mangle]
pub unsafe extern "C" fn amos_link_node_spawn_federation_advertising(
    node: *const amos_link_node,
    period_ms: u64,
    endpoint: *const c_char,
) -> *mut amos_link_federation_task {
    if let Some(node) = check_null(node) {
        // SAFETY: `node` passed the null check above and is a live handle from `amos_link_node_new`/`_clone` — a `Box<Arc<LinkNode>>` that stays allocated until `amos_link_node_drop`; a shared reference for the duration of the call is sound, and the `Arc` is what lets several threads read the same node.
        let n = unsafe { &*(node as *const Arc<LinkNode>) };
        let endpoints: Vec<String> = if !endpoint.is_null() {
            match cstr_to_str(endpoint) {
                Ok(s) => vec![s.to_string()],
                Err(e) => {
                    set_error(&e);
                    return ptr::null_mut();
                }
            }
        } else {
            vec![]
        };
        let node_clone = Arc::clone(n);
        let period = Duration::from_millis(period_ms);

        // Use the global runtime to provide context for tokio::spawn
        let rt = match global_runtime() {
            Ok(rt) => rt,
            Err(e) => {
                set_error(&e);
                return ptr::null_mut();
            }
        };
        let _guard = rt.enter();

        match node_clone.spawn_federation_advertising(period, endpoints) {
            Ok(t) => Box::into_raw(Box::new(t)) as *mut amos_link_federation_task,
            Err(e) => {
                set_error(&e);
                ptr::null_mut()
            }
        }
    } else {
        ptr::null_mut()
    }
}

/// # Safety
///
/// `task` must be a task handle from `amos_link_node_spawn_federation*` that has not been stopped;
/// any use afterwards is undefined behaviour. A null pointer is ignored.
#[no_mangle]
pub unsafe extern "C" fn amos_link_federation_stop(task: *mut amos_link_federation_task) {
    if task.is_null() {
        return;
    }
    // SAFETY: takes back the `Box<FederationTask>` created by `amos_link_node_spawn_federation*`; the handle must be stopped exactly once, and the null case is excluded above.
    let t = unsafe { Box::from_raw(task as *mut FederationTask) };
    // The task is stopped either way; if the runtime itself could not be built, the caller
    // still learns why through the thread-local error (`amos_link_last_error`).
    if let Err(e) = block_on_sync(async move { t.stop().await }) {
        set_error(&e);
    }
}

// ---------------------------------------------------------------------------
// Error reporting
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn amos_link_last_error() -> *const c_char {
    LAST_ERROR_C.with(|slot| {
        let mut slot = slot.borrow_mut();
        let text = LAST_ERROR.with(|buf| buf.borrow().clone());
        // A `LinkError` message cannot contain NUL, but `unwrap_or_default` keeps this
        // panic-free if that ever changes.
        *slot = Some(std::ffi::CString::new(text).unwrap_or_default());
        slot.as_ref()
            .map_or(std::ptr::null(), |s| s.as_ptr() as *const c_char)
    })
}

#[no_mangle]
pub extern "C" fn amos_link_error_clear() {
    LAST_ERROR.with(|buf| buf.borrow_mut().clear());
}
