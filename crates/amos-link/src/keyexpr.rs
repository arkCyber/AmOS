//! Topics as **key expressions** — the addressing scheme of AmOS-Link.
//!
//! This is the ROS-name replacement: instead of a bespoke `.msg` registry, a topic
//! is a validated `amos/<peer>/<channel>/<name>` path and a *pattern* may use the two
//! wildcards every robot developer already knows from Zenoh/MQTT:
//!
//! | form | matches |
//! |---|---|
//! | `*`  | exactly one segment (`amos/*/sensor/imu`) |
//! | `**` | zero or more segments (`amos/**/imu`, `amos/**`) |
//!
//! Two layers use it: the in-process [`Broker`](crate::broker::Broker) matches a
//! publish topic against each subscription pattern, and the Zenoh transport hands the
//! pattern over unchanged (Zenoh uses the same `*`/`**` grammar, so the mapping is
//! the identity — one less place for the two sides to drift apart).
//!
//! Validation is deliberately strict and *local*: a topic that a human cannot read
//! (`amos//imu`, `amos/imu/`, `amos/IMU!!`) is refused at construction time, not when
//! the first frame is lost. Segment rules: `A-Za-z0-9`, `_`, `-`, `.`, `:`, `%`.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::error::{LinkError, Result};

/// Longest accepted single segment.
const MAX_SEGMENT: usize = 64;
/// Deepest accepted topic (segment count).
const MAX_SEGMENTS: usize = 32;
/// A `*` segment: exactly one segment.
pub const WILDCARD_ONE: &str = "*";
/// A `**` segment: zero or more segments.
pub const WILDCARD_MANY: &str = "**";

/// The AmOS-Link topic root — every topic this middleware owns starts here.
pub const ROOT: &str = "amos";

/// The channel a topic belongs to (the third segment of `amos/<peer>/<channel>/…`).
///
/// The channel is what tells a link node how to treat a topic: sensor frames are
/// best-effort/latest-wins, control commands are reliable, telemetry is best-effort
/// with a short history. See [`crate::qos::Qos`] for the presets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    /// High-rate sensor data (stereo frames, point clouds, IMU).
    Sensor,
    /// Actuator set points and gait commands (the "small brain" side).
    Control,
    /// Discrete state/status (mode changes, battery, health).
    State,
    /// Liveness and metrics (heartbeats).
    Telemetry,
    /// Inference results coming back from the brain server.
    Brain,
}

impl Channel {
    /// Every channel, in documentation order.
    pub const ALL: [Channel; 5] = [
        Channel::Sensor,
        Channel::Control,
        Channel::State,
        Channel::Telemetry,
        Channel::Brain,
    ];

    /// Stable wire/CLI key.
    pub fn key(self) -> &'static str {
        match self {
            Channel::Sensor => "sensor",
            Channel::Control => "control",
            Channel::State => "state",
            Channel::Telemetry => "telemetry",
            Channel::Brain => "brain",
        }
    }

    /// Parse a channel key; `None` for an unknown channel.
    pub fn from_key(s: &str) -> Option<Channel> {
        Channel::ALL.into_iter().find(|c| c.key() == s)
    }
}

/// A validated topic or topic pattern.
///
/// Construct a concrete topic with [`Topic::new`] and a wildcard pattern with
/// [`Topic::pattern`]; `new` refuses wildcards so a publisher can never leave its
/// addressed channel by accident. Both are `Hash`/`Eq`, so a topic works as a map key.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Topic(String);

impl Topic {
    /// Validate a **concrete** topic (no wildcards).
    pub fn new(expr: impl Into<String>) -> Result<Self> {
        let expr = expr.into();
        validate(&expr, false)?;
        Ok(Topic(expr))
    }

    /// Validate a **pattern**: like [`Topic::new`], but `*` / `**` are allowed.
    pub fn pattern(expr: impl Into<String>) -> Result<Self> {
        let expr = expr.into();
        validate(&expr, true)?;
        Ok(Topic(expr))
    }

    /// Build `amos/<peer>/<channel>/<name>`.
    pub fn channel_topic(peer: &str, channel: Channel, name: &str) -> Result<Self> {
        Topic::new(format!("{ROOT}/{peer}/{}/{name}", channel.key()))
    }

    /// The pattern that matches every topic of one peer (`amos/<peer>/**`).
    pub fn peer_pattern(peer: &str) -> Result<Self> {
        Topic::pattern(format!("{ROOT}/{peer}/{WILDCARD_MANY}"))
    }

    /// The raw key expression.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The segments of the key expression.
    pub fn segments(&self) -> impl Iterator<Item = &str> {
        self.0.split('/')
    }

    /// How many segments the key expression has.
    pub fn len(&self) -> usize {
        self.segments().count()
    }

    /// Always `false` ([`Topic::new`] refuses the empty string); present so clippy's
    /// `len_without_is_empty` lint stays quiet on a type that models a path.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// True when the key expression contains a wildcard segment.
    pub fn is_pattern(&self) -> bool {
        self.segments()
            .any(|s| s == WILDCARD_ONE || s == WILDCARD_MANY)
    }

    /// The channel this key expression belongs to, when it names one.
    ///
    /// The third segment of `amos/<peer>/<channel>/…` is what tells a node how to treat
    /// the traffic, so this accessor is what lets a caller pick the right
    /// [`Qos`](crate::qos::Qos) for a subscription instead of remembering by hand: a
    /// pattern like `amos/*/control/**` names `Control` and gets a *reliable* profile,
    /// while `amos/*/sensor/**` gets the latest-wins one. `None` when the expression is
    /// too short, is rooted elsewhere, or has a wildcard in the channel position — an
    /// unknown channel is answered as unknown, never guessed.
    pub fn channel(&self) -> Option<Channel> {
        let mut segments = self.segments();
        if segments.next()? != ROOT {
            return None;
        }
        // The peer segment (whoever it is, wildcards included).
        segments.next()?;
        Channel::from_key(segments.next()?)
    }

    /// True when `pattern` (a key expression) matches this topic.
    ///
    /// A concrete pattern matches only itself — the common case where a subscriber
    /// names exactly one topic. A wildcard pattern anywhere (including in the peer
    /// segment) is what makes the middleware "decentralized": a brain server can
    /// subscribe to `amos/**/sensor/stereo_left` and receive every robot's left
    /// camera without knowing a single peer id up front.
    pub fn matches(&self, pattern: &Topic) -> bool {
        let topic: Vec<&str> = self.segments().collect();
        let pat: Vec<&str> = pattern.segments().collect();
        match_segments(&pat, &topic)
    }
}

/// Recursive segment matcher: `*` = one segment, `**` = zero or more.
/// Match a pattern against a concrete topic, segment by segment.
///
/// **Iterative and non-recursive on purpose** (NASA Power of 10 #1 forbids recursion, #2
/// wants every loop statically bounded). The obvious recursive matcher backtracks over
/// every `**` and costs `O(C(n+m, m))`: with the 32-segment ceiling a `**`-heavy pattern
/// explores ~10¹¹ paths — an effective hang, and one that happens **while the broker's
/// registry lock is held** (matching is part of the publish path). This dynamic program
/// answers the same question in `O(n·m) ≤ 32·32` steps using two fixed-size stack arrays:
/// no recursion, no allocation, no unbounded work.
///
/// `dp[j]` = "the topic prefix seen so far matches the first `j` pattern segments";
/// `**` may consume zero segments (same row) or one more (previous row).
fn match_segments(pat: &[&str], topic: &[&str]) -> bool {
    // Both sides come from validated `Topic`s (`≤ MAX_SEGMENTS`), but this function stays
    // total regardless: an over-long input simply does not match.
    if pat.len() > MAX_SEGMENTS || topic.len() > MAX_SEGMENTS {
        return false;
    }
    let mut prev = [false; MAX_SEGMENTS + 1];
    let mut cur = [false; MAX_SEGMENTS + 1];
    prev[0] = true; // an empty topic prefix matches the empty pattern prefix
    for i in 0..=topic.len() {
        cur[0] = i == 0; // a non-empty topic prefix matches no pattern segments
        for j in 1..=pat.len() {
            cur[j] = match pat[j - 1] {
                WILDCARD_MANY => cur[j - 1] || prev[j],
                WILDCARD_ONE => i > 0 && prev[j - 1],
                literal => i > 0 && prev[j - 1] && topic[i - 1] == literal,
            };
        }
        prev.copy_from_slice(&cur);
    }
    prev[pat.len()]
}

/// Validate segment count / length / characters; `patterns` allows the wildcards.
fn validate(expr: &str, patterns: bool) -> Result<()> {
    if expr.is_empty() {
        return Err(LinkError::key_expr(expr, "empty key expression"));
    }
    let segments: Vec<&str> = expr.split('/').collect();
    if segments.len() > MAX_SEGMENTS {
        return Err(LinkError::key_expr(
            expr,
            format!("more than {MAX_SEGMENTS} segments"),
        ));
    }
    for seg in segments {
        if seg.is_empty() {
            return Err(LinkError::key_expr(expr, "empty segment"));
        }
        if seg.len() > MAX_SEGMENT {
            return Err(LinkError::key_expr(
                expr,
                format!("segment longer than {MAX_SEGMENT} bytes"),
            ));
        }
        if seg == WILDCARD_ONE || seg == WILDCARD_MANY {
            if patterns {
                continue;
            }
            return Err(LinkError::key_expr(
                expr,
                "wildcards are not allowed in a concrete topic",
            ));
        }
        if !seg
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':' | b'%'))
        {
            return Err(LinkError::key_expr(
                expr,
                format!("illegal character in segment `{seg}`"),
            ));
        }
    }
    Ok(())
}

impl fmt::Display for Topic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for Topic {
    type Err = LinkError;

    fn from_str(s: &str) -> Result<Self> {
        Topic::new(s)
    }
}

impl AsRef<str> for Topic {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concrete_topics_are_validated() {
        assert!(Topic::new("amos/dog1/sensor/stereo_left").is_ok());
        // A publisher must name one concrete topic.
        assert!(Topic::new("amos/*/sensor").is_err(), "wildcard refused");
        assert!(Topic::new("amos//imu").is_err(), "empty segment refused");
        assert!(Topic::new("amos/imu/").is_err(), "trailing slash refused");
        assert!(Topic::new("").is_err(), "empty refused");
        assert!(Topic::new("amos/IMU!").is_err(), "illegal char refused");
        assert!(
            Topic::new(format!("amos/{}", "x".repeat(65))).is_err(),
            "over-long segment refused"
        );
        assert!(
            Topic::new("amos/".to_string() + &vec!["a"; MAX_SEGMENTS + 1].join("/")).is_err(),
            "too many segments refused"
        );
    }

    #[test]
    fn wildcard_patterns_match_the_expected_topics() {
        let pat = Topic::pattern("amos/*/sensor/*").unwrap();
        assert!(Topic::new("amos/dog1/sensor/imu").unwrap().matches(&pat));
        assert!(Topic::new("amos/dog1/sensor/stereo_left")
            .unwrap()
            .matches(&pat));
        assert!(!Topic::new("amos/dog1/sensor/imu/raw")
            .unwrap()
            .matches(&pat));
        assert!(!Topic::new("amos/dog1/control/imu").unwrap().matches(&pat));

        // `**` crosses any number of segments — the "every peer" subscription.
        let all_imu = Topic::pattern("amos/**/imu").unwrap();
        assert!(Topic::new("amos/dog1/sensor/imu")
            .unwrap()
            .matches(&all_imu));
        assert!(Topic::new("amos/x/y/z/imu").unwrap().matches(&all_imu));
        assert!(!Topic::new("amos/dog1/sensor/imu2")
            .unwrap()
            .matches(&all_imu));

        // A concrete pattern matches only itself.
        let exact = Topic::pattern("amos/dog1/control/joints").unwrap();
        assert!(Topic::new("amos/dog1/control/joints")
            .unwrap()
            .matches(&exact));
        assert!(!Topic::new("amos/dog2/control/joints")
            .unwrap()
            .matches(&exact));
        // `**` may match zero segments too.
        let root = Topic::pattern("amos/**").unwrap();
        assert!(Topic::new("amos").unwrap().matches(&root));
        assert!(Topic::new("amos/dog1/state/mode").unwrap().matches(&root));
    }

    #[test]
    fn helpers_build_the_documented_topology() {
        let t = Topic::channel_topic("dog1", Channel::Sensor, "stereo_left").unwrap();
        assert_eq!(t.as_str(), "amos/dog1/sensor/stereo_left");
        assert!(!t.is_pattern());
        assert_eq!(t.len(), 4);
        assert_eq!(t.segments().next(), Some("amos"));

        let p = Topic::peer_pattern("dog1").unwrap();
        assert!(p.is_pattern());
        assert!(t.matches(&p));

        let c = Topic::channel_topic("dog1", Channel::Control, "joints").unwrap();
        assert!(
            c.matches(&p),
            "another channel of the same peer still matches"
        );
    }

    #[test]
    fn channel_keys_round_trip() {
        for c in Channel::ALL {
            assert_eq!(Channel::from_key(c.key()), Some(c));
        }
        assert_eq!(Channel::from_key("nope"), None);
    }

    /// A deliberately naive reference matcher: recursive backtracking over every `**` —
    /// exactly the shape the production matcher must **not** have. It is only ever called
    /// on tiny inputs (≤ 5 segments), where its exponential cost is irrelevant; it exists
    /// so the dynamic program can be cross-checked against the obvious definition.
    fn reference_match(pat: &[&str], topic: &[&str]) -> bool {
        match pat.split_first() {
            None => topic.is_empty(),
            Some((head, rest)) => match *head {
                WILDCARD_MANY => (0..=topic.len()).any(|k| reference_match(rest, &topic[k..])),
                WILDCARD_ONE => !topic.is_empty() && reference_match(rest, &topic[1..]),
                literal => {
                    !topic.is_empty() && topic[0] == literal && reference_match(rest, &topic[1..])
                }
            },
        }
    }

    #[test]
    fn the_matcher_agrees_with_a_brute_force_reference() {
        // Differential testing (fixed seed, so the evidence is reproducible forever):
        // 4 000 random pattern/topic pairs over a tiny alphabet, checked against the naive
        // recursive definition. The hand-written cases above pin the shapes we *thought*
        // of; this sweep pins the ones we did not.
        let mut seed: u64 = 0xC0FF_EE00_1234_5678;
        let mut next = move || {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            (seed >> 33) as u32
        };
        let pattern_segment = |n: u32| -> &'static str {
            match n % 4 {
                0 => "a",
                1 => "b",
                2 => WILDCARD_ONE,
                _ => WILDCARD_MANY,
            }
        };
        let topic_segment = |n: u32| -> &'static str {
            if n.is_multiple_of(2) {
                "a"
            } else {
                "b"
            }
        };
        for _ in 0..4_000 {
            let pat_len = (next() % 5) as usize;
            let topic_len = (next() % 5) as usize;
            let pat: Vec<&str> = (0..pat_len).map(|_| pattern_segment(next())).collect();
            let topic: Vec<&str> = (0..topic_len).map(|_| topic_segment(next())).collect();
            assert_eq!(
                match_segments(&pat, &topic),
                reference_match(&pat, &topic),
                "pattern {pat:?} vs topic {topic:?}"
            );
        }
    }

    #[test]
    fn a_wildcard_heavy_pattern_is_matched_in_bounded_time() {
        // The worst case the recursive matcher could not survive: 15 `**` segments against
        // the 32-segment maximum topic — on the order of 10^11 backtracking paths, i.e. a
        // hang (and matching happens while the broker's registry lock is held). The
        // dynamic program answers in ≤ 32·32 steps; the generous bound below is a
        // regression guard, not a benchmark.
        let topic = Topic::new(format!("amos/{}", vec!["x"; 31].join("/"))).expect("topic");
        let pattern = Topic::pattern(format!("amos/{}/x", vec![WILDCARD_MANY; 15].join("/")))
            .expect("pattern");

        let started = std::time::Instant::now();
        assert!(
            topic.matches(&pattern),
            "15 `**` must be able to cover the middle segments"
        );
        let hit = started.elapsed();
        assert!(
            hit < std::time::Duration::from_secs(1),
            "a hit must take bounded work, took {hit:?}"
        );

        // The negative case is the expensive one for a backtracker (it explores every
        // combination before giving up) — it must be just as quick.
        let miss = Topic::new(format!("amos/{}", vec!["y"; 31].join("/"))).expect("topic");
        let started = std::time::Instant::now();
        assert!(!miss.matches(&pattern), "the last segment is not `x`");
        let miss_time = started.elapsed();
        assert!(
            miss_time < std::time::Duration::from_secs(1),
            "a miss must take bounded work, took {miss_time:?}"
        );
    }

    #[test]
    fn a_key_expression_reports_the_channel_it_names() {
        // Concrete topics and patterns alike — the channel is what tells a caller which
        // QoS profile to use, so it has to be readable from the pattern itself.
        assert_eq!(
            Topic::new("amos/dog1/control/joints")
                .expect("topic")
                .channel(),
            Some(Channel::Control)
        );
        assert_eq!(
            Topic::pattern("amos/*/sensor/**")
                .expect("pattern")
                .channel(),
            Some(Channel::Sensor)
        );
        assert_eq!(
            Topic::channel_topic("cam-front", Channel::Telemetry, "beat")
                .expect("topic")
                .channel(),
            Some(Channel::Telemetry)
        );

        // Unknown is answered as unknown: a wildcard in the channel position, a path that
        // is too short, a foreign root, and a segment that is not a channel at all.
        assert_eq!(
            Topic::pattern("amos/*/*/imu").expect("pattern").channel(),
            None
        );
        assert_eq!(Topic::pattern("amos/**").expect("pattern").channel(), None);
        assert_eq!(Topic::new("amos/dog1").expect("topic").channel(), None);
        assert_eq!(Topic::new("amos").expect("topic").channel(), None);
        assert_eq!(
            Topic::new("other/dog1/sensor/imu")
                .expect("topic")
                .channel(),
            None,
            "the middleware owns `amos/…`; another root has no channel here"
        );
        assert_eq!(
            Topic::new("amos/dog1/nonsense/imu")
                .expect("topic")
                .channel(),
            None
        );
    }

    #[test]
    fn display_and_from_str_agree() {
        let t: Topic = "amos/dog1/state/mode".parse().unwrap();
        assert_eq!(t.to_string(), "amos/dog1/state/mode");
        assert_eq!(t.as_ref(), "amos/dog1/state/mode");
        assert!("not a topic".parse::<Topic>().is_err());
        assert!(!t.is_empty());
    }
}
