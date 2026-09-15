//! One frame's worth of memory: the codec must not build a second copy of a frame.
//!
//! The streamed CRC32 and the `[…].concat()` version it replaced produce **identical bytes**,
//! so no assertion on the wire format — not even a pinned CRC — can tell them apart. What
//! differs is the *allocation*, so this file measures it: one `encode` and one `decode` of a
//! multi-megabyte frame, under the counting allocator in `support/counting_alloc.rs`.
//!
//! Both calls used to ask for a full extra copy of the frame (the checksum was computed over
//! `header ‖ payload` concatenated into a fresh `Vec`) — at the 16 MiB ceiling that doubles a
//! frame's peak memory, and on the receive path the copy happened *before* the checksum had
//! been verified, so a peer's 16 MiB frame made the receiver hold 32 MiB.
//!
//! Encode and decode share one test on purpose: they are one property ("a frame costs about a
//! frame"), and this binary holds exactly one test so the process-wide counter has no
//! concurrent user.

#[path = "support/counting_alloc.rs"]
mod counting_alloc;

use amos_link::codec::{Envelope, Timestamp};
use amos_link::discovery::PeerId;
use amos_link::keyexpr::Topic;
use counting_alloc::{measure, SLACK};

fn topic() -> Topic {
    Topic::new("amos/dog1/sensor/stereo_left").expect("topic")
}

#[test]
fn the_codec_never_builds_a_second_copy_of_a_frame() {
    let payload_len = 4 * 1024 * 1024;
    let envelope = Envelope::new(
        &topic(),
        &PeerId::new("dog1").expect("peer"),
        1,
        Timestamp::new(1_700_000_000, 0).expect("stamp"),
        vec![0xA5; payload_len],
    );

    // Encoding: the frame itself, not a second copy of it for the checksum.
    let (wire, encoded) = measure(|| envelope.encode().expect("encode"));
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

    // Decoding: the payload's own buffer, and never a copy taken *before* the checksum has
    // been verified (that copy was the receiver-side amplification).
    let (decoded, decoded_bytes) = measure(|| Envelope::decode(&wire).expect("decode"));
    assert_eq!(decoded.payload.len(), payload_len);
    assert!(
        decoded_bytes < payload_len + SLACK,
        "decoding a {}-byte frame asked for {decoded_bytes} bytes: on the receive path a copy \
         is not only wasteful, it happens before the checksum has been verified",
        wire.len()
    );
}
