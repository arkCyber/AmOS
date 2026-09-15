//! Per-publisher sequence accounting: turning “a gap means a dropped frame” into numbers.
//!
//! Every frame carries `(publisher, seq)` — a **1-based, per-publisher monotonic**
//! counter stamped by [`Publisher`](crate::pubsub::Publisher). That is the cheapest loss
//! detector a robot link can have: no acknowledgements, no round trip, just arithmetic
//! on metadata that already travels with the payload. This module does that arithmetic
//! and nothing else — it is a pure state machine (no I/O, no clock, one map entry per
//! peer), so it is deterministic under test.
//!
//! What an operator learns from it, and why each number is separate:
//!
//! * `in_order` — frames that arrived exactly where the stream said they would;
//! * `gaps` / `missing` — *events* vs *frames*: one lost burst is one gap, so counting
//!   only events would understate the loss by its size;
//! * `stale` — a frame at or below the high-water mark: a duplicate, a reordered arrival
//!   (a UDP carry path can reorder, a reliable one effectively cannot), or a publisher
//!   that restarted its counter. It is **not** folded into “lost”, because “the same
//!   frame twice” and “a frame never arrived” are different facts.
//!
//! Honest boundary: counters are per publisher (their sequences are independent), so two
//! publishers on one topic are tracked separately, and a publisher that reboots to
//! sequence 1 looks like a run of `stale` frames until [`SeqTracker::reset`] is called.
//! And the table is **bounded** ([`MAX_TRACKED_STREAMS`]) because its keys come off the
//! wire: past the ceiling a new publisher is refused and *counted*
//! (`SeqEvent::Untracked`, [`SeqSummary::is_complete`]) — the alternative shapes are an
//! unbounded map (a peer could mint a publisher per frame) or a silent stop (a loss figure
//! that looks clean because nothing was accounted for).

use std::collections::BTreeMap;

use crate::codec::Message;
use crate::discovery::PeerId;
use crate::pubsub::Received;

/// What one arriving frame says about its publisher's stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeqEvent {
    /// The first frame this tracker has seen from that publisher.
    First {
        /// The frame's sequence number.
        seq: u64,
    },
    /// Exactly the frame the stream owed next: nothing was lost in between.
    InOrder {
        /// The frame's sequence number.
        seq: u64,
    },
    /// A jump forward: `missing` frames of this publisher never arrived.
    Gap {
        /// The sequence the stream owed next.
        expected: u64,
        /// The sequence that actually arrived.
        seq: u64,
        /// How many frames were skipped (`seq - expected`).
        missing: u64,
    },
    /// A frame at or below the publisher's high-water mark (duplicate / reordered /
    /// a restarted counter), or any frame after `u64::MAX` — never an overflow.
    Stale {
        /// The frame's sequence number.
        seq: u64,
        /// The highest sequence seen from this publisher so far.
        last: u64,
    },
    /// A frame from a publisher this tracker **refuses to add**: the table is full
    /// ([`MAX_TRACKED_STREAMS`]). The frame is counted (`SeqSummary::untracked`) and the
    /// summary reports itself as incomplete (`SeqSummary::is_complete`) — never silently
    /// flattened into a stream that looks clean.
    Untracked {
        /// The frame's sequence number.
        seq: u64,
    },
}

impl SeqEvent {
    /// True for the event that means “frames were lost”.
    pub fn is_loss(&self) -> bool {
        matches!(self, SeqEvent::Gap { .. })
    }

    /// True when this frame could not be accounted for at all (the tracker is full).
    pub fn is_untracked(&self) -> bool {
        matches!(self, SeqEvent::Untracked { .. })
    }
}

/// The largest number of publishers one tracker keeps a high-water mark for.
///
/// A **static bound** (NASA Power of 10 #2), for the same reason
/// [`MAX_TRACKED_TOPICS`](crate::broker::MAX_TRACKED_TOPICS) is one: the key is a
/// **publisher id taken off the wire** (`envelope.header.publisher`), so a hostile or broken
/// peer can invent a fresh one every frame (`amos/p1/…`, `amos/p2/…`, … — ids are arbitrary
/// 1..=63-byte tokens). Without a ceiling that map is a permanent, unbounded allocation in a
/// consumer that runs for hours. Past the ceiling a new publisher is simply not tracked, and
/// that fact is *reported* rather than hidden: "we stopped accounting" must never read as
/// "the stream is clean".
///
/// The number matches the broker's topic ceiling: one link, one order of magnitude for
/// diagnostic bookkeeping.
pub const MAX_TRACKED_STREAMS: usize = 4096;

/// The running totals of a [`SeqTracker`] (a snapshot an operator or a UI reads).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SeqSummary {
    /// How many distinct publishers have been observed.
    pub streams: usize,
    /// Frames that arrived exactly in order.
    pub in_order: u64,
    /// How many *jumps* were seen (one per lost burst, not per lost frame).
    pub gaps: u64,
    /// Frames the jumps accounted for (`sum of Gap::missing`).
    pub missing: u64,
    /// Frames at or below the high-water mark.
    pub stale: u64,
    /// Frames from publishers the tracker refused to add (its table was full). These are
    /// **outside** the accounting above — `is_complete()` is how a reader learns that.
    pub untracked: u64,
}

impl SeqSummary {
    /// Frames classified so far (`in_order + missing + stale` as frame counts).
    ///
    /// Untracked frames are deliberately **not** included: they were not classified. A reader
    /// that presents this number must present [`SeqSummary::is_complete`] with it.
    pub fn observed(&self) -> u64 {
        self.in_order + self.missing + self.stale
    }

    /// True when every frame this trackter saw was accounted for (no publisher was refused).
    pub fn is_complete(&self) -> bool {
        self.untracked == 0
    }

    /// The share of the observed stream that never arrived, in `[0, 1]`.
    ///
    /// `missing / (missing + observed)` — defined as `0.0` before any frame arrives, so
    /// “nothing observed yet” is reported as neither healthy nor unhealthy.
    pub fn loss_ratio(&self) -> f32 {
        let total = self.observed().saturating_add(self.missing);
        if total == 0 {
            return 0.0;
        }
        (self.missing as f64 / total as f64) as f32
    }

    /// True when no frame has been observed at all (classified or refused).
    pub fn is_empty(&self) -> bool {
        self.observed() == 0 && self.untracked == 0
    }

    /// True when a frame was lost (a non-zero `missing` count).
    pub fn has_loss(&self) -> bool {
        self.missing > 0
    }
}

/// Per-publisher sequence accounting: one high-water mark per publisher, four counters.
#[derive(Debug, Default)]
pub struct SeqTracker {
    highest: BTreeMap<PeerId, u64>,
    summary: SeqSummary,
}

impl SeqTracker {
    /// An empty tracker.
    pub fn new() -> Self {
        Self::default()
    }

    /// Observe one incoming frame's `(publisher, seq)` pair.
    ///
    /// Total and panic-free for **any** input, including `seq == u64::MAX` (after which
    /// no “next” exists, so every later frame is `Stale` rather than an overflow).
    ///
    /// A publisher the tracker has never seen is added **unless** the table is full
    /// ([`MAX_TRACKED_STREAMS`]): the ceiling exists because the key comes off the wire, so it
    /// is the one place a peer can make this map grow without bound. Past it the frame is
    /// returned as [`SeqEvent::Untracked`] and counted — a bounded tracker that *says it
    /// stopped*, rather than one that either grows forever or silently drops the evidence.
    pub fn observe(&mut self, publisher: &PeerId, seq: u64) -> SeqEvent {
        let Some(highest) = self.highest.get_mut(publisher) else {
            if self.highest.len() >= MAX_TRACKED_STREAMS {
                self.summary.untracked += 1;
                return SeqEvent::Untracked { seq };
            }
            self.highest.insert(publisher.clone(), seq);
            self.summary.streams = self.highest.len();
            self.summary.in_order += 1;
            return SeqEvent::First { seq };
        };
        let last = *highest;
        let event = match last.checked_add(1) {
            Some(expected) if seq == expected => SeqEvent::InOrder { seq },
            Some(expected) if seq > expected => SeqEvent::Gap {
                expected,
                seq,
                // Safe: the guard proved `seq > expected`.
                missing: seq - expected,
            },
            // Below the expected next (duplicate/reorder), or the stream is already at
            // `u64::MAX` (nothing can follow it): `Stale`, never arithmetic.
            _ => SeqEvent::Stale { seq, last },
        };
        match event {
            SeqEvent::Gap { missing, .. } => {
                self.summary.gaps += 1;
                self.summary.missing += missing;
            }
            SeqEvent::Stale { .. } => self.summary.stale += 1,
            SeqEvent::InOrder { .. } => self.summary.in_order += 1,
            // The stream exists (it was found in the map), so neither `First` nor
            // `Untracked` can occur here.
            SeqEvent::First { .. } | SeqEvent::Untracked { .. } => {}
        }
        if seq > last {
            *highest = seq;
        }
        event
    }

    /// Observe a decoded frame (the convenience form of [`SeqTracker::observe`]).
    pub fn observe_received<T: Message>(&mut self, received: &Received<T>) -> SeqEvent {
        self.observe(&received.publisher, received.seq)
    }

    /// The counters so far.
    pub fn summary(&self) -> SeqSummary {
        self.summary
    }

    /// The highest sequence seen from one publisher (`None` = never seen).
    pub fn highest(&self, publisher: &PeerId) -> Option<u64> {
        self.highest.get(publisher).copied()
    }

    /// How many publishers are tracked.
    pub fn streams(&self) -> usize {
        self.highest.len()
    }

    /// True when no frame has been refused for want of table space
    /// ([`MAX_TRACKED_STREAMS`]) — the honesty flag every *summary* reader needs, because
    /// `missing`/`loss_ratio` describe only the streams that were tracked.
    pub fn is_complete(&self) -> bool {
        self.summary.is_complete()
    }

    /// Frames from publishers that were refused (see [`MAX_TRACKED_STREAMS`]).
    pub fn untracked(&self) -> u64 {
        self.summary.untracked
    }

    /// Forget every stream and counter (what a consumer does after a deliberate
    /// reconnect or a publisher restart, so the stale run is not blamed on the link).
    pub fn reset(&mut self) {
        self.highest.clear();
        self.summary = SeqSummary::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::Timestamp;
    use crate::keyexpr::Topic;

    fn peer(id: &str) -> PeerId {
        PeerId::new(id).expect("peer id")
    }

    /// A frame snapshot as a subscriber hands it to a consumer (all fields public, so a
    /// tracker can be tested without a broker).
    fn received(publisher: &str, seq: u64) -> Received<u64> {
        Received {
            message: seq,
            topic: Topic::new("amos/dog1/sensor/imu").expect("topic"),
            publisher: peer(publisher),
            seq,
            stamp: Timestamp::new(100, 0).expect("stamp"),
            frame_len: 42,
        }
    }

    #[test]
    fn a_clean_stream_is_all_in_order() {
        let mut tracker = SeqTracker::new();
        assert_eq!(
            tracker.observe(&peer("dog1"), 1),
            SeqEvent::First { seq: 1 }
        );
        for seq in 2..=5 {
            assert_eq!(
                tracker.observe(&peer("dog1"), seq),
                SeqEvent::InOrder { seq }
            );
        }
        let s = tracker.summary();
        assert_eq!(s.streams, 1);
        assert_eq!(s.observed(), 5);
        assert!(!s.has_loss(), "nothing was lost");
        assert_eq!(s.loss_ratio(), 0.0);
        assert_eq!(tracker.highest(&peer("dog1")), Some(5));
    }

    #[test]
    fn a_jump_is_one_gap_counting_every_missing_frame() {
        let mut tracker = SeqTracker::new();
        tracker.observe(&peer("dog1"), 1);
        // 2 and 3 never arrived.
        assert_eq!(
            tracker.observe(&peer("dog1"), 4),
            SeqEvent::Gap {
                expected: 2,
                seq: 4,
                missing: 2
            }
        );
        tracker.observe(&peer("dog1"), 5);
        let s = tracker.summary();
        assert_eq!(s.gaps, 1, "one burst is one event");
        assert_eq!(s.missing, 2, "but two frames were lost");
        assert_eq!(s.observed(), 4, "frames 1, 4, 5 plus the 2 that never came");
        assert!(s.has_loss());
        // 2 lost out of the 6 frames that stream should have produced.
        assert!((s.loss_ratio() - (2.0 / 6.0)).abs() < 1e-6);
    }

    #[test]
    fn duplicates_and_reorders_are_stale_not_lost() {
        let mut tracker = SeqTracker::new();
        tracker.observe(&peer("dog1"), 7);
        // The same frame twice (a duplicate) ...
        assert_eq!(
            tracker.observe(&peer("dog1"), 7),
            SeqEvent::Stale { seq: 7, last: 7 }
        );
        // ... and an older one arriving late (a reordering carry path).
        assert_eq!(
            tracker.observe(&peer("dog1"), 5),
            SeqEvent::Stale { seq: 5, last: 7 }
        );
        // Neither is loss, and the high-water mark never goes backwards.
        let s = tracker.summary();
        assert_eq!(s.stale, 2);
        assert_eq!(s.missing, 0);
        assert!(!s.has_loss());
        assert_eq!(tracker.highest(&peer("dog1")), Some(7));
        // The stream keeps working after a reorder.
        assert_eq!(
            tracker.observe(&peer("dog1"), 8),
            SeqEvent::InOrder { seq: 8 }
        );
    }

    #[test]
    fn publishers_are_tracked_independently() {
        let mut tracker = SeqTracker::new();
        tracker.observe(&peer("dog1"), 1);
        tracker.observe(&peer("dog2"), 1);
        assert_eq!(tracker.streams(), 2);
        // dog2 is at 1, so 3 is a gap for dog2 alone.
        assert_eq!(
            tracker.observe(&peer("dog2"), 3),
            SeqEvent::Gap {
                expected: 2,
                seq: 3,
                missing: 1
            }
        );
        // dog1 is unaffected: its next frame is 2, in order.
        assert_eq!(
            tracker.observe(&peer("dog1"), 2),
            SeqEvent::InOrder { seq: 2 }
        );
        assert_eq!(tracker.summary().streams, 2);
        assert_eq!(tracker.summary().gaps, 1);
    }

    #[test]
    fn the_end_of_the_sequence_space_is_not_an_overflow() {
        let mut tracker = SeqTracker::new();
        assert_eq!(
            tracker.observe(&peer("dog1"), u64::MAX),
            SeqEvent::First { seq: u64::MAX }
        );
        // There is no frame after `u64::MAX`: every later one is `Stale`, and computing
        // an “expected next” must not wrap (or panic).
        assert_eq!(
            tracker.observe(&peer("dog1"), 0),
            SeqEvent::Stale {
                seq: 0,
                last: u64::MAX
            }
        );
        assert_eq!(
            tracker.observe(&peer("dog1"), u64::MAX),
            SeqEvent::Stale {
                seq: u64::MAX,
                last: u64::MAX
            }
        );
        assert_eq!(tracker.summary().missing, 0);
        assert_eq!(tracker.summary().stale, 2);
        assert!(!tracker.summary().has_loss());
    }

    #[test]
    fn the_empty_summary_claims_neither_health_nor_loss() {
        let s = SeqTracker::new().summary();
        assert!(s.is_empty());
        assert_eq!(s.loss_ratio(), 0.0, "nothing observed, nothing claimed");
        assert_eq!(s, SeqSummary::default());
        assert!(!s.has_loss());
    }

    #[test]
    fn a_frame_snapshot_feeds_the_tracker() {
        let mut tracker = SeqTracker::new();
        assert_eq!(
            tracker.observe_received(&received("dog1", 1)),
            SeqEvent::First { seq: 1 }
        );
        assert_eq!(
            tracker.observe_received(&received("dog1", 2)),
            SeqEvent::InOrder { seq: 2 }
        );
        let gap = tracker.observe_received(&received("dog1", 9));
        assert_eq!(
            gap,
            SeqEvent::Gap {
                expected: 3,
                seq: 9,
                missing: 6
            }
        );
        assert!(gap.is_loss());
        assert!(!SeqEvent::InOrder { seq: 2 }.is_loss());
        assert!(tracker.summary().has_loss());
    }

    #[test]
    fn a_full_tracker_refuses_a_new_publisher_and_says_so() {
        // The defect this pins: the table is keyed by `envelope.header.publisher`, i.e. by a
        // string **off the wire**, and it had no ceiling — a peer that mints a fresh id per
        // frame (`p1`, `p2`, …) grew a long-running consumer's memory without bound. The
        // broker's topic inventory has had a ceiling (and a `topics_complete()` flag) since
        // the first hardening round; this map is the same shape of resource.
        let mut tracker = SeqTracker::new();
        for index in 0..MAX_TRACKED_STREAMS {
            let event = tracker.observe(&peer(&format!("p{index}")), 1);
            assert_eq!(event, SeqEvent::First { seq: 1 }, "filling frame {index}");
        }
        assert_eq!(tracker.streams(), MAX_TRACKED_STREAMS);
        assert!(
            tracker.is_complete(),
            "nothing has been refused yet, so the summary is still the whole truth"
        );

        // One publisher too many: refused, counted, and the map does not grow.
        let refused = tracker.observe(&peer("one-too-many"), 1);
        assert!(
            refused.is_untracked(),
            "the event says what happened, not just that nothing was delivered"
        );
        assert_eq!(refused, SeqEvent::Untracked { seq: 1 });
        assert_eq!(
            tracker.streams(),
            MAX_TRACKED_STREAMS,
            "the ceiling holds: the new publisher was not inserted"
        );
        assert_eq!(tracker.summary().untracked, 1);
        assert!(
            !tracker.is_complete(),
            "the loss figure no longer describes every frame that arrived"
        );
        assert_eq!(tracker.highest(&peer("one-too-many")), None);

        // …and a *known* publisher is still tracked normally at the ceiling: the bound must
        // not break healthy accounting for the streams that are already there.
        assert_eq!(
            tracker.observe(&peer("p0"), 2),
            SeqEvent::InOrder { seq: 2 }
        );
        assert_eq!(tracker.summary().in_order, MAX_TRACKED_STREAMS as u64 + 1);
        assert_eq!(
            tracker.summary().untracked,
            1,
            "a tracked stream is never counted as untracked"
        );

        // `reset` is the way back (a deliberate reconnect), and it clears the flag too.
        tracker.reset();
        assert!(tracker.is_complete());
        assert_eq!(tracker.untracked(), 0);
        assert!(tracker.summary().is_empty());
    }

    #[test]
    fn reset_forgets_streams_and_counters() {
        let mut tracker = SeqTracker::new();
        tracker.observe(&peer("dog1"), 1);
        tracker.observe(&peer("dog1"), 5);
        assert!(tracker.summary().has_loss());
        tracker.reset();
        assert_eq!(tracker.streams(), 0);
        assert_eq!(tracker.summary(), SeqSummary::default());
        assert_eq!(tracker.highest(&peer("dog1")), None);
        // After a reset the next frame opens the stream again (a restarted publisher).
        assert_eq!(
            tracker.observe(&peer("dog1"), 1),
            SeqEvent::First { seq: 1 }
        );
    }
}
