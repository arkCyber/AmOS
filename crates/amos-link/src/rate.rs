//! Per-stream **arrival rate**: the "is this stream running at its rate?" instrument.
//!
//! A robot link has two questions that look similar and are not:
//!
//! * *did I lose frames?* — answered by [`SeqTracker`](crate::sequence::SeqTracker) from the
//!   frames' own sequence numbers (it needs the payload's metadata), and
//! * *at what rate is the stream arriving?* — answered here, from **arrival times only**.
//!
//! A stream can be lossless and still be wrong: a camera that fell back to 10 fps, a brain that
//! stopped sending set points but keeps its heartbeat, an IMU whose driver throttles under load.
//! None of those show up in a loss count, and before this module the CLI had no rate figure at
//! all — `bench` measures a *synthetic* publisher of its own making, and `watch` counts
//! heartbeats. `ros2 topic hz` has existed for exactly this question, and its absence was the one
//! ⚠️ row left in the ROS 2 comparison (`docs/amos-link.md` §8).
//!
//! Three decisions make the number honest:
//!
//! 1. **Our clock, never the frame's.** The rate is `intervals / (last − first)` over the
//!    **arrival** instants, stamped by the caller from a monotonic clock. A rate computed from
//!    remote `stamp` fields would silently become a different quantity when two boards' clocks
//!    disagree — the lesson of the age folding (§3.15), applied to a second measurement. It also
//!    means a rate needs no clock calibration: `clock_synced=false` does not weaken it.
//! 2. **The span is the evidence, and it travels with the number.** `frames` and `span` are
//!    reported beside `rate_hz`, so a reader can always re-derive it — and [`MIN_RATE_SPAN`]
//!    refuses to state a rate from a window too short to mean anything: three frames inside
//!    20 ms are a statement about the OS scheduler (~150 Hz), not about the stream.
//! 3. **A rate that cannot be stated is `None` with a reason, never `0`.** One frame is not
//!    "0 Hz" — it is *no interval at all* ([`RateEvidence::SingleFrame`]). This crate has paid
//!    for that rule three times already (§3.15's `age=0ms`, §3.16's `published=0`, §3.18's
//!    `dropped=0`); a zero here would read as "the robot stopped publishing".
//!
//! Counters are per **stream** — `(publisher, topic)`, the same key
//! [`SeqTracker`](crate::sequence::SeqTracker) uses — so a node that publishes a camera *and* an
//! IMU reports two rates, and the table is bounded ([`MAX_TRACKED_STREAMS`]) because its keys come
//! off the wire: past the ceiling a new stream is refused and *counted*
//! ([`RateTracker::untracked`]), never silently dropped into a clean-looking figure.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use crate::codec::Message;
use crate::discovery::PeerId;
use crate::keyexpr::Topic;
use crate::pubsub::Received;
use crate::sequence::StreamKey;

/// The largest number of streams one tracker measures (the same ceiling
/// [`SeqTracker`](crate::sequence::SeqTracker) uses, for the same reason: the key is a publisher
/// id *and* a topic taken off the wire, so a hostile or broken peer can mint a fresh one per
/// frame — `amos/p1/…`, `amos/p2/…` — and an unbounded map in a consumer that runs for hours is a
/// leak, not an instrument). Past the ceiling a new stream is refused and counted
/// ([`RateTracker::untracked`]), so "we stopped measuring" never reads as "the stream is calm".
pub const MAX_TRACKED_STREAMS: usize = 4096;

/// The shortest arrival span a rate may be computed from.
///
/// Below this the figure describes the scheduler rather than the stream: three frames that happen
/// to arrive 20 ms apart read as ~150 Hz, and a short `--seconds` window would turn scheduling
/// jitter into a number an operator might act on. Half a second is also long enough to average a
/// 60 Hz sensor stream over ~30 frames — the smallest window in which "is it still at 60?" has an
/// answer rather than a guess. A stream whose span is shorter reports
/// [`RateEvidence::SpanTooShort`] (with the span it *did* measure) instead of a rate.
pub const MIN_RATE_SPAN: Duration = Duration::from_millis(500);

/// What one arriving frame did to the tracker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RateEvent {
    /// Counted into its stream; `frames` is the stream's total so far.
    Counted {
        /// How many arrivals this stream has now been seen with (≥1).
        frames: u64,
    },
    /// A stream this tracker **refuses to add**: the table is full ([`MAX_TRACKED_STREAMS`]).
    /// The frame is counted as untracked ([`RateTracker::untracked`]) — never flattened into an
    /// existing stream's rate.
    Untracked,
}

/// Why a rate cannot be stated for a stream that *was* observed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RateEvidence {
    /// Only one arrival: there is no interval to divide by, so there is no rate — and `0` would
    /// read as "this stream stopped".
    SingleFrame,
    /// Two or more arrivals, but they fit inside [`MIN_RATE_SPAN`]: the measured span is real,
    /// the rate would not be. Carries the span so a renderer can say how short it was.
    SpanTooShort {
        /// The arrival span that was measured.
        span: Duration,
    },
}

impl RateEvidence {
    /// A short, stable token for a line of output — the same discipline as the age caveat's
    /// reason string: the *reason* is rendered, never a zero standing in for it.
    pub fn detail(&self) -> String {
        match self {
            RateEvidence::SingleFrame => "one frame so far (no interval to divide by)".to_string(),
            RateEvidence::SpanTooShort { span } => format!(
                "only {}ms of span (a rate needs at least {}ms to mean anything)",
                span.as_millis(),
                MIN_RATE_SPAN.as_millis()
            ),
        }
    }

    /// The stable machine token (`--json`), so a script never has to parse prose.
    pub fn key(&self) -> &'static str {
        match self {
            RateEvidence::SingleFrame => "single-frame",
            RateEvidence::SpanTooShort { .. } => "span-too-short",
        }
    }
}

/// One stream's arrival rate, with the evidence it was derived from.
#[derive(Clone, Debug, PartialEq)]
pub struct StreamRate {
    /// Who publishes the stream.
    pub publisher: PeerId,
    /// The concrete topic the frames arrived on.
    pub topic: Topic,
    /// How many frames of this stream have arrived.
    pub frames: u64,
    /// `last − first` arrival instant; `None` while only one frame was seen.
    pub span: Option<Duration>,
    /// Arrival rate in Hz — `intervals / span`, i.e. `(frames − 1) / span`. `None` when it cannot
    /// be stated (see [`StreamRate::evidence`]); **never** a placeholder zero.
    pub rate_hz: Option<f64>,
}

impl StreamRate {
    /// Why this rate cannot be stated (`None` when it can).
    ///
    /// Derived from the same two facts the rate is: a reader that prints the reason and a reader
    /// that prints the number can never disagree about which case they are in.
    pub fn evidence(&self) -> Option<RateEvidence> {
        if self.rate_hz.is_some() {
            return None;
        }
        match self.span {
            None => Some(RateEvidence::SingleFrame),
            Some(span) => Some(RateEvidence::SpanTooShort { span }),
        }
    }

    /// The mean interval between arrivals (`None` when there is no rate).
    pub fn interval(&self) -> Option<Duration> {
        self.rate_hz
            .filter(|hz| *hz > 0.0)
            .map(|hz| Duration::from_secs_f64(1.0 / hz))
    }
}

/// How many arrivals one stream has been seen with, and when they were.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Arrivals {
    frames: u64,
    first: Instant,
    last: Instant,
}

impl Arrivals {
    fn span(&self) -> Duration {
        // `saturating_duration_since` rather than `-`: a caller may hand instants out of order
        // (two tasks feeding one tracker, a test injecting a stale instant), and a *rate* is not
        // the place to discover that — the span floors at zero, and `MIN_RATE_SPAN` then refuses
        // the rate instead of inventing one from a wrapped subtraction.
        self.last.saturating_duration_since(self.first)
    }
}

/// Per-stream arrival-rate accounting: one arrival window per `(publisher, topic)`.
#[derive(Debug, Default)]
pub struct RateTracker {
    streams: BTreeMap<StreamKey, Arrivals>,
    untracked: u64,
}

impl RateTracker {
    /// An empty tracker.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one arrival of `topic` from `publisher`, seen at `at` (a **monotonic** instant —
    /// taken while receiving the frame, never from the frame's own `stamp`, so a rate cannot
    /// inherit another board's clock error).
    pub fn observe(&mut self, publisher: &PeerId, topic: &Topic, at: Instant) -> RateEvent {
        let key = StreamKey::new(publisher.clone(), topic.clone());
        match self.streams.get_mut(&key) {
            Some(arrivals) => {
                arrivals.frames += 1;
                // Keep the *last* arrival, and never let the window run backwards.
                arrivals.last = arrivals.last.max(at);
                RateEvent::Counted {
                    frames: arrivals.frames,
                }
            }
            None => {
                if self.streams.len() >= MAX_TRACKED_STREAMS {
                    self.untracked += 1;
                    return RateEvent::Untracked;
                }
                self.streams.insert(
                    key,
                    Arrivals {
                        frames: 1,
                        first: at,
                        last: at,
                    },
                );
                RateEvent::Counted { frames: 1 }
            }
        }
    }

    /// Record one arriving frame (the stream it belongs to is what its own header says).
    pub fn observe_received<T: Message>(
        &mut self,
        received: &Received<T>,
        at: Instant,
    ) -> RateEvent {
        self.observe(&received.publisher, &received.topic, at)
    }

    /// The rate of one stream (`None` = never observed).
    pub fn rate(&self, publisher: &PeerId, topic: &Topic) -> Option<StreamRate> {
        let key = StreamKey::new(publisher.clone(), topic.clone());
        self.streams
            .get(&key)
            .map(|arrivals| stream_rate(&key, arrivals))
    }

    /// Every stream's rate, sorted by `(publisher, topic)` — so two runs over the same link print
    /// the same lines in the same order, and a reader can diff them.
    pub fn rates(&self) -> Vec<StreamRate> {
        self.streams
            .iter()
            .map(|(key, arrivals)| stream_rate(key, arrivals))
            .collect()
    }

    /// How many streams are being measured.
    pub fn streams(&self) -> usize {
        self.streams.len()
    }

    /// Frames from streams this tracker refused to add (its table was full). These are **outside**
    /// every rate above, so a reader must state this number next to them.
    pub fn untracked(&self) -> u64 {
        self.untracked
    }

    /// True when every arrival was accounted for by a stream (no refusal).
    pub fn is_complete(&self) -> bool {
        self.untracked == 0
    }

    /// Total arrivals across all measured streams (untracked ones are **not** included — they were
    /// not measured, which is exactly what [`RateTracker::is_complete`] reports).
    pub fn frames(&self) -> u64 {
        self.streams.values().map(|a| a.frames).sum()
    }

    /// Forget every stream (what a consumer does after a deliberate reconnect). Untracked frames
    /// stay counted: they are a fact about what this tracker *could not* measure, and a reset that
    /// hid them would erase evidence.
    pub fn reset(&mut self) {
        self.streams.clear();
    }
}

/// Build one stream's reading from its raw window.
///
/// The rate is `intervals / span` — **not** `frames / span`: `n` arrivals span `n − 1` intervals,
/// and dividing by `frames` would make every stream read ~1.7% fast at 60 Hz (and 100% fast at
/// two frames, where the answer would be `2 / span`). A reader who wants to check the arithmetic
/// has both numbers on the same line.
fn stream_rate(key: &StreamKey, arrivals: &Arrivals) -> StreamRate {
    let intervals = arrivals.frames.saturating_sub(1);
    let span = arrivals.span();
    let rate_hz = if intervals == 0 || span < MIN_RATE_SPAN {
        None
    } else {
        Some(intervals as f64 / span.as_secs_f64())
    };
    StreamRate {
        publisher: key.publisher().clone(),
        topic: key.topic().clone(),
        frames: arrivals.frames,
        span: (arrivals.frames > 1).then_some(span),
        rate_hz,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(id: &str) -> PeerId {
        PeerId::new(id).expect("peer")
    }

    fn topic(s: &str) -> Topic {
        Topic::new(s).expect("topic")
    }

    /// Inject `frames` arrivals of one stream `gap` apart, starting at `t0`.
    ///
    /// Deterministic by construction: the instants are handed in, so the expected rate is
    /// arithmetic rather than a measurement of this machine's scheduler.
    fn observe_at(
        tracker: &mut RateTracker,
        publisher: &str,
        topic_str: &str,
        frames: u64,
        gap: Duration,
        t0: Instant,
    ) {
        let (p, t) = (peer(publisher), topic(topic_str));
        for n in 0..frames {
            tracker.observe(&p, &t, t0 + gap * n as u32);
        }
    }

    #[test]
    fn a_rate_is_intervals_over_span() {
        // 5 frames 250 ms apart: 4 intervals over 1 s ⇒ 4 Hz. (`frames / span` — the wrong
        // arithmetic — would have said 5 Hz, i.e. 25% fast.)
        let mut tracker = RateTracker::new();
        observe_at(
            &mut tracker,
            "dog1",
            "amos/dog1/sensor/stereo_left",
            5,
            Duration::from_millis(250),
            Instant::now(),
        );
        let rate = tracker
            .rate(&peer("dog1"), &topic("amos/dog1/sensor/stereo_left"))
            .expect("the stream was observed");
        assert_eq!(rate.frames, 5);
        assert_eq!(rate.span, Some(Duration::from_secs(1)));
        let hz = rate.rate_hz.expect("1 s of span is enough evidence");
        assert!((hz - 4.0).abs() < 1e-9, "got {hz}");
        assert!(rate.evidence().is_none(), "a stated rate has no excuse");
        assert_eq!(rate.interval().expect("interval").as_millis(), 250);
    }

    #[test]
    fn one_frame_is_not_a_zero_hertz_stream() {
        // The round's whole point: "no interval yet" must not be reported as "0 Hz" — that reads
        // as "the robot stopped publishing", which is a claim this tracker cannot make.
        let mut tracker = RateTracker::new();
        assert_eq!(
            tracker.observe(
                &peer("dog1"),
                &topic("amos/dog1/sensor/stereo_left"),
                Instant::now()
            ),
            RateEvent::Counted { frames: 1 }
        );
        let rate = tracker
            .rate(&peer("dog1"), &topic("amos/dog1/sensor/stereo_left"))
            .expect("observed");
        assert_eq!(rate.frames, 1);
        assert_eq!(rate.span, None, "no span without a second arrival");
        assert_eq!(rate.rate_hz, None, "never a placeholder zero");
        assert_eq!(rate.evidence(), Some(RateEvidence::SingleFrame));
        assert!(rate.evidence().unwrap().detail().contains("one frame"));
        assert_eq!(rate.evidence().unwrap().key(), "single-frame");
    }

    #[test]
    fn a_span_too_short_to_mean_anything_is_a_named_refusal() {
        // Three frames inside 40 ms would read as ~50 Hz — a statement about the scheduler, not
        // about the stream. The tracker reports the span it measured and refuses the number.
        let mut tracker = RateTracker::new();
        observe_at(
            &mut tracker,
            "dog1",
            "amos/dog1/sensor/imu",
            3,
            Duration::from_millis(20),
            Instant::now(),
        );
        let rate = tracker
            .rate(&peer("dog1"), &topic("amos/dog1/sensor/imu"))
            .expect("observed");
        assert_eq!(rate.span, Some(Duration::from_millis(40)));
        assert_eq!(rate.rate_hz, None);
        assert_eq!(
            rate.evidence(),
            Some(RateEvidence::SpanTooShort {
                span: Duration::from_millis(40)
            })
        );
        assert_eq!(rate.evidence().unwrap().key(), "span-too-short");
        assert!(rate.evidence().unwrap().detail().contains("500ms"));
    }

    #[test]
    fn the_boundary_span_is_stated_not_refused() {
        // The rule is `span >= MIN_RATE_SPAN`: exactly at the boundary a rate *is* stated, so the
        // constant means what its doc says (and a future `>` would be caught here).
        let mut tracker = RateTracker::new();
        observe_at(
            &mut tracker,
            "dog1",
            "amos/dog1/sensor/imu",
            2,
            MIN_RATE_SPAN,
            Instant::now(),
        );
        let rate = tracker
            .rate(&peer("dog1"), &topic("amos/dog1/sensor/imu"))
            .expect("observed");
        assert_eq!(
            rate.rate_hz,
            Some(2.0),
            "2 frames one span apart = 1/span Hz"
        );
    }

    #[test]
    fn two_topics_from_one_peer_are_two_rates() {
        // The §3.13 lesson, in the rate instrument: a peer's camera and its mode reports run at
        // different rates, and one shared window would report neither.
        let mut tracker = RateTracker::new();
        let t0 = Instant::now();
        observe_at(
            &mut tracker,
            "dog1",
            "amos/dog1/sensor/stereo",
            5,
            Duration::from_millis(250),
            t0,
        );
        observe_at(
            &mut tracker,
            "dog1",
            "amos/dog1/state/mode",
            3,
            Duration::from_secs(1),
            t0,
        );
        let rates = tracker.rates();
        assert_eq!(rates.len(), 2, "two streams: {rates:?}");
        // Sorted by (publisher, topic) — a stable order a reader can diff across runs.
        assert_eq!(rates[0].topic.as_str(), "amos/dog1/sensor/stereo");
        assert_eq!(rates[1].topic.as_str(), "amos/dog1/state/mode");
        let sensor = rates[0].rate_hz.expect("sensor rate");
        let state = rates[1].rate_hz.expect("state rate");
        assert!((sensor - 4.0).abs() < 1e-9, "got {sensor}");
        assert!((state - 1.0).abs() < 1e-9, "got {state}");
        assert_eq!(tracker.frames(), 8);
        assert_eq!(tracker.streams(), 2);
    }

    #[test]
    fn an_out_of_order_instant_cannot_wrap_the_span() {
        // Two tasks feeding one tracker (or a consumer that reconnects) can hand instants out of
        // order; a plain subtraction would wrap into an enormous `Duration` and the rate would
        // come out plausible-but-wrong. The window floors instead, and the rate stays unstated.
        let mut tracker = RateTracker::new();
        let now = Instant::now();
        tracker.observe(
            &peer("dog1"),
            &topic("amos/dog1/sensor/imu"),
            now + Duration::from_secs(9),
        );
        tracker.observe(&peer("dog1"), &topic("amos/dog1/sensor/imu"), now);
        let rate = tracker
            .rate(&peer("dog1"), &topic("amos/dog1/sensor/imu"))
            .expect("observed");
        assert_eq!(rate.frames, 2);
        assert_eq!(rate.span, Some(Duration::ZERO), "the span floors at zero");
        assert_eq!(rate.rate_hz, None, "and no rate is invented from it");
    }

    #[test]
    fn the_table_is_bounded_and_says_when_it_stopped_measuring() {
        let mut tracker = RateTracker::new();
        let t0 = Instant::now();
        for n in 0..MAX_TRACKED_STREAMS {
            assert_eq!(
                tracker.observe(&peer("dog1"), &topic(&format!("amos/dog1/sensor/t{n}")), t0),
                RateEvent::Counted { frames: 1 }
            );
        }
        assert!(tracker.is_complete(), "nothing refused yet");
        assert_eq!(
            tracker.observe(&peer("dog1"), &topic("amos/dog1/sensor/one-too-many"), t0),
            RateEvent::Untracked
        );
        assert_eq!(tracker.untracked(), 1);
        assert!(!tracker.is_complete(), "a reader must be able to say so");
        assert_eq!(tracker.streams(), MAX_TRACKED_STREAMS);
        // The refused frame is in no rate: `frames()` counts what was measured.
        assert_eq!(tracker.frames(), MAX_TRACKED_STREAMS as u64);
        assert_eq!(tracker.rates().len(), MAX_TRACKED_STREAMS);
    }

    #[test]
    fn reset_forgets_streams_but_never_the_untracked_evidence() {
        let mut tracker = RateTracker::new();
        let t0 = Instant::now();
        for n in 0..=MAX_TRACKED_STREAMS {
            tracker.observe(&peer("dog1"), &topic(&format!("amos/dog1/sensor/t{n}")), t0);
        }
        assert_eq!(tracker.untracked(), 1);
        tracker.reset();
        assert_eq!(tracker.streams(), 0);
        assert!(tracker.rates().is_empty());
        assert_eq!(
            tracker.untracked(),
            1,
            "what it could not measure is not erased by a reconnect"
        );
    }

    #[test]
    fn a_frame_can_be_observed_straight_off_the_wire() {
        // The CLI's path: the stream a frame belongs to is what its own header says.
        use crate::codec::Timestamp;
        use crate::pubsub::Received;

        let mut tracker = RateTracker::new();
        let received: Received<crate::telemetry::Heartbeat> = Received {
            message: crate::telemetry::Heartbeat::new(peer("dog1"), 1, Timestamp::now(), 5),
            topic: topic("amos/dog1/telemetry/beat"),
            publisher: peer("dog1"),
            seq: 1,
            stamp: Timestamp::now(),
            frame_len: 64,
        };
        let t0 = Instant::now();
        assert_eq!(
            tracker.observe_received(&received, t0),
            RateEvent::Counted { frames: 1 }
        );
        assert_eq!(
            tracker.observe_received(&received, t0 + Duration::from_secs(1)),
            RateEvent::Counted { frames: 2 }
        );
        let rate = tracker
            .rate(&peer("dog1"), &topic("amos/dog1/telemetry/beat"))
            .expect("observed");
        assert_eq!(rate.rate_hz, Some(1.0), "a 1 Hz stream reads 1 Hz");
    }
}
