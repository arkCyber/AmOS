//! The publish hot path must not allocate *anything* to decide who matches.
//!
//! `Topic::matches` runs once per matching subscription per published frame, **inside the
//! broker's registry lock** — 60 Hz × 10 subscribers is 1 200 calls a second. It used to
//! `collect()` two `Vec<&str>` per call while `keyexpr`'s own module documentation claimed the
//! matcher allocates nothing; both halves are now stack-fixed arrays, so the claim is
//! measured here rather than asserted in a comment.
//!
//! This binary holds exactly one test: the counter is process-wide, and a parallel test would
//! allocate inside the measured window.

#[path = "support/counting_alloc.rs"]
mod counting_alloc;

use amos_link::keyexpr::Topic;
use counting_alloc::measure;

#[test]
fn the_topic_matcher_allocates_nothing() {
    let concrete = Topic::new("amos/dog1/sensor/stereo_left").expect("topic");
    let pattern = Topic::pattern("amos/*/sensor/*").expect("pattern");
    assert!(
        concrete.matches(&pattern),
        "the fixture must really match, or the measurement below is of nothing"
    );

    let (_, matching) = measure(|| {
        for _ in 0..1_000 {
            assert!(concrete.matches(&pattern));
        }
    });
    assert_eq!(
        matching, 0,
        "1000 matches asked for {matching} bytes: the matcher must not allocate"
    );
}
