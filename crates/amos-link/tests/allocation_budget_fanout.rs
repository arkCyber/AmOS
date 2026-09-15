//! A fan-out copies a pointer, not the payload.
//!
//! The crate's headline claim is that one stereo frame reaches *n* subscribers without *n*
//! copies — "the difference between a middleware that scales to a stereo pair at 60 Hz and one
//! that does not" (`broker.rs`). Nothing measured it: a subscriber queue is a `Vec` of
//! `Arc<[u8]>`, and a change from `Arc` to `Vec<u8>` (or a `frame.to_vec()` at any hop, which
//! is what the Zenoh path deliberately does on *its* side) would keep every existing test
//! green while turning a 4 MiB depth frame into 32 MiB of copying per publish.
//!
//! So this measures the publish path: one 4 MiB frame, eight subscribers, and the allocator's
//! answer. Delivery is asserted first — a publish that delivered nothing would also allocate
//! nothing, which is exactly the vacuous pass this ordering prevents.
//!
//! This binary holds exactly one test: the counter is process-wide.

#[path = "support/counting_alloc.rs"]
mod counting_alloc;

use std::sync::Arc;

use amos_link::broker::Broker;
use amos_link::keyexpr::Topic;
use amos_link::qos::Qos;
use counting_alloc::requested;

#[tokio::test]
async fn a_fan_out_copies_a_pointer_not_the_payload() {
    const SUBSCRIBERS: usize = 8;
    let payload_len = 4 * 1024 * 1024;

    let transport = Broker::new().shared();
    let pattern = Topic::pattern("amos/*/sensor/stereo_left").expect("pattern");
    let mut queues = Vec::with_capacity(SUBSCRIBERS);
    for _ in 0..SUBSCRIBERS {
        queues.push(
            transport
                .subscribe(&pattern, Qos::sensor())
                .await
                .expect("subscribe"),
        );
    }

    let topic = Topic::new("amos/dog1/sensor/stereo_left").expect("topic");
    let frame: Arc<[u8]> = Arc::from(vec![0x5A; payload_len].into_boxed_slice());

    let before = requested();
    let report = transport
        .publish(&topic, Arc::clone(&frame))
        .await
        .expect("publish");
    let copied = requested() - before;

    // The positive control: the fan-out really happened. Without this, "asked for nothing"
    // could just as well mean "delivered nothing".
    assert_eq!(report.matched, Some(SUBSCRIBERS));
    assert_eq!(report.delivered, SUBSCRIBERS);
    assert_eq!(report.dropped, 0);

    // The measurement: less than a quarter of one payload for eight deliveries of it.
    assert!(
        copied < payload_len / 4,
        "publishing a {payload_len}-byte frame to {SUBSCRIBERS} subscribers asked for {copied} \
         bytes: the queues must share one buffer (a per-subscriber copy would be ~{} bytes)",
        payload_len * SUBSCRIBERS
    );

    // …and the proof that it is *the same* buffer: our own handle still accounts for every
    // queue's reference, so no subscriber is holding a copy.
    assert!(
        Arc::strong_count(&frame) > SUBSCRIBERS,
        "the frame is shared, not copied: strong_count={} for {SUBSCRIBERS} subscriber(s)",
        Arc::strong_count(&frame)
    );
}
