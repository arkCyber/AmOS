//! What a behaviour test cannot see: the codec must not build a second copy of a frame.
//!
//! The streamed CRC32 and the `[…].concat()` version it replaced produce **identical
//! bytes**, so no assertion on the wire format — not even a pinned CRC — can tell them
//! apart. What differs is the *allocation*, so this file measures it: a counting global
//! allocator around one `encode` and one `decode` of a multi-megabyte frame. Both calls
//! used to ask for a full extra copy of the frame (the checksum was computed over
//! `header ‖ payload` concatenated into a fresh `Vec`) — at the 16 MiB ceiling that doubles
//! a frame's peak memory, and on the receive path the copy happened *before* the checksum
//! had been verified, so a peer's 16 MiB frame made the receiver hold 32 MiB.
//!
//! The bound is deliberately generous: a `Vec`'s growth strategy may over-allocate and the
//! header has to be serialized, so the assertion is "the memory of **one** frame" plus a
//! 64 KiB allowance — which a second 4 MiB copy cannot hide inside.
//!
//! This file holds the only test in its binary, so the process-wide counter has no
//! concurrent user (the measurement is exact, not sampled).

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use amos_link::codec::{Envelope, Timestamp};
use amos_link::discovery::PeerId;
use amos_link::keyexpr::Topic;

/// Cumulative bytes every allocation has asked the system allocator for.
static REQUESTED: AtomicUsize = AtomicUsize::new(0);

/// A pass-through allocator that only counts what is asked of it.
struct Counting;

// SAFETY: every method delegates to `System` with the caller's own `Layout` (forwarded
// unchanged, as `GlobalAlloc` requires) and returns its result untouched; the counter is an
// atomic add that cannot panic. No memory is moved, borrowed or freed differently from the
// system allocator, so the counting is observation only.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        REQUESTED.fetch_add(layout.size(), Ordering::Relaxed);
        // SAFETY: `layout` is the caller's own, forwarded unchanged.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr`/`layout` come from the matching allocation above.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        REQUESTED.fetch_add(new_size, Ordering::Relaxed);
        // SAFETY: the caller's own pointer/layout/size, forwarded unchanged.
        unsafe { System.realloc(ptr, layout, new_size) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        REQUESTED.fetch_add(layout.size(), Ordering::Relaxed);
        // SAFETY: `layout` is the caller's own, forwarded unchanged.
        unsafe { System.alloc_zeroed(layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Bytes a frame's own bookkeeping may cost on top of its payload: header serialization,
/// a `Vec`'s growth strategy, the decoded payload. A second copy of the payload — the
/// defect — needs far more than this.
const SLACK: usize = 64 * 1024;

fn topic() -> Topic {
    Topic::new("amos/dog1/sensor/stereo_left").expect("topic")
}

#[test]
fn one_large_frame_costs_one_frame_of_memory_to_encode_and_one_to_decode() {
    let payload_len = 4 * 1024 * 1024;
    let envelope = Envelope::new(
        &topic(),
        &PeerId::new("dog1").expect("peer"),
        1,
        Timestamp::new(1_700_000_000, 0).expect("stamp"),
        vec![0xA5; payload_len],
    );

    let before = REQUESTED.load(Ordering::Relaxed);
    let wire = envelope.encode().expect("encode");
    let encoded = REQUESTED.load(Ordering::Relaxed) - before;
    assert!(
        wire.len() > payload_len,
        "the frame really carries the payload: {} bytes",
        wire.len()
    );
    assert!(
        encoded < wire.len() + SLACK,
        "encoding a {}-byte frame asked for {encoded} bytes: the checksum must not copy it \
         (a second copy would be ~{payload_len} more)",
        wire.len()
    );

    let before = REQUESTED.load(Ordering::Relaxed);
    let decoded = Envelope::decode(&wire).expect("decode");
    let decoded_bytes = REQUESTED.load(Ordering::Relaxed) - before;
    assert_eq!(decoded.payload.len(), payload_len);
    assert!(
        decoded_bytes < payload_len + SLACK,
        "decoding a {}-byte frame asked for {decoded_bytes} bytes: on the receive path a copy \
         is not only wasteful, it happens before the checksum has been verified",
        wire.len()
    );
}
