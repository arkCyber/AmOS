//! ROS-like **quality of service** for every subscription.
//!
//! The reason a robot middleware cannot have one queue policy is physical: a stereo
//! depth stream at 30–60 Hz must *drop* older frames when the consumer lags (stale
//! depth is worse than no depth, and the latest frame is the only one that matters),
//! while a gait/stop command must *never* be dropped. DDS exposes this as QoS; ROS 2
//! calls it reliability + history depth. AmOS-Link expresses the same two knobs in a
//! 3-field struct that fits in a `Copy`:
//!
//! ```text
//!                    ┌──────────── Reliability::BestEffort ────────────┐
//!   publish ───────► │ queue full? drop per DropPolicy, never block    │
//!                    └─────────────────────────────────────────────────┘
//!                    ┌──────────── Reliability::Reliable ──────────────┐
//!   publish ───────► │ queue full? await capacity (back-pressure)      │
//!                    └─────────────────────────────────────────────────┘
//! ```
//!
//! [`Qos::sensor`] is the "latest sample wins" profile (`DropOldest` + depth 1): **every
//! transport** keeps exactly one slot per subscriber and overwrites it, so a consumer that
//! was busy for 10 frames wakes up holding frame 10 — never a backlog of 10 stale
//! ones. [`Qos::control`] is the opposite: reliable, 64 deep, and a slow actuator
//! back-pressures the publisher instead of silently losing a set point.
//!
//! **QoS is a property of the subscription, not of one transport** (`docs/amos-link.md`
//! §3.18, round 17). That sentence used to say "the broker keeps exactly one slot", and the
//! qualifier was hiding a real difference: `ZenohTransport` built *every* remote subscription
//! as a bounded queue fed by a blocking relay, so a `Qos::sensor()` consumer on a network link
//! woke up holding the **oldest** frame of its stall and the overwritten ones were counted
//! nowhere. The sink is now chosen by the profile on both transports (`Broker::subscribe`,
//! `Subscription::remote_latest`), and the drop counting follows it.
//!
//! `DropOldest` with a depth > 1 is refused by [`Qos::validate`] rather than silently
//! behaving like `DropNewest` — the honest option, since overwriting only makes sense
//! for a one-slot "latest" queue.

use serde::{Deserialize, Serialize};

use crate::error::{LinkError, Result};
use crate::keyexpr::Channel;

/// How a subscription reacts when its queue is full.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Reliability {
    /// Never block the publisher: a full queue drops (the ROS "sensor data" mode).
    BestEffort,
    /// Back-pressure the publisher until the subscriber has room (control mode).
    Reliable,
}

impl Reliability {
    /// Stable wire/CLI key.
    pub fn key(self) -> &'static str {
        match self {
            Reliability::BestEffort => "best-effort",
            Reliability::Reliable => "reliable",
        }
    }

    /// Parse a key; `None` for an unknown string.
    pub fn from_key(s: &str) -> Option<Reliability> {
        match s {
            "best-effort" | "best_effort" | "besteffort" => Some(Reliability::BestEffort),
            "reliable" => Some(Reliability::Reliable),
            _ => None,
        }
    }
}

/// Which frame a *best-effort* subscriber sacrifices when its queue is full.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DropPolicy {
    /// Keep the queue as-is and drop the newly published frame (history mode).
    DropNewest,
    /// Overwrite the queued frame with the new one (only legal at depth 1 — the
    /// "latest sample wins" mode every sensor stream wants).
    DropOldest,
}

impl DropPolicy {
    /// Stable wire/CLI key.
    pub fn key(self) -> &'static str {
        match self {
            DropPolicy::DropNewest => "drop-newest",
            DropPolicy::DropOldest => "drop-oldest",
        }
    }

    /// Parse a key; `None` for an unknown string.
    pub fn from_key(s: &str) -> Option<DropPolicy> {
        match s {
            "drop-newest" | "drop_newest" => Some(DropPolicy::DropNewest),
            "drop-oldest" | "drop_oldest" | "latest" => Some(DropPolicy::DropOldest),
            _ => None,
        }
    }
}

/// The delivery contract of one subscription.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Qos {
    /// Whether the publisher may be blocked by this subscriber.
    pub reliability: Reliability,
    /// Queue capacity: `1` = only the newest frame is ever pending.
    pub depth: usize,
    /// Which frame is sacrificed when a best-effort queue is full.
    pub drop_policy: DropPolicy,
}

impl Qos {
    /// Largest accepted depth (a bigger queue is a leak, not a buffer).
    pub const MAX_DEPTH: usize = 4096;

    /// Build a profile.
    pub const fn new(reliability: Reliability, depth: usize, drop_policy: DropPolicy) -> Self {
        Self {
            reliability,
            depth,
            drop_policy,
        }
    }

    /// High-rate sensor data: best-effort, one slot, newest frame wins.
    ///
    /// This is the stereo-depth / IMU profile: a consumer that falls behind discards
    /// its own backlog instead of making the camera wait.
    pub const fn sensor() -> Self {
        Self::new(Reliability::BestEffort, 1, DropPolicy::DropOldest)
    }

    /// Discrete state with a little history (mode changes, calibration events).
    pub const fn state() -> Self {
        Self::new(Reliability::BestEffort, 8, DropPolicy::DropNewest)
    }

    /// Actuator / gait commands: reliable, 64 deep, back-pressures the publisher.
    pub const fn control() -> Self {
        Self::new(Reliability::Reliable, 64, DropPolicy::DropNewest)
    }

    /// The default profile: best-effort with a short history.
    pub const fn default_qos() -> Self {
        Self::state()
    }

    /// The profile a [`Channel`](crate::keyexpr::Channel) implies.
    ///
    /// This is the policy table the topic grammar was designed around, in one place, so a
    /// caller subscribing to `amos/*/control/**` cannot silently pick the sensor profile
    /// (best-effort + latest-wins) and then wonder why a gait command went missing:
    ///
    /// | channel | profile | why |
    /// |---|---|---|
    /// | `sensor` | [`Qos::sensor`] | stale depth is worse than no depth; newest wins |
    /// | `control` | [`Qos::control`] | a set point must never be dropped |
    /// | `state` | [`Qos::state`] | discrete updates want a short history |
    /// | `telemetry` | [`Qos::state`] | a beat is best-effort; a lost one is a slower view |
    /// | `brain` | [`Qos::state`] | an inference result is a state update, not a frame stream |
    pub const fn for_channel(channel: Channel) -> Self {
        match channel {
            Channel::Sensor => Self::sensor(),
            Channel::Control => Self::control(),
            Channel::State | Channel::Telemetry | Channel::Brain => Self::state(),
        }
    }

    /// Queue capacity.
    pub const fn depth(self) -> usize {
        self.depth
    }

    /// True for the one-slot "latest sample wins" profile.
    pub const fn is_latest_only(self) -> bool {
        self.depth == 1 && matches!(self.drop_policy, DropPolicy::DropOldest)
    }

    /// Refuse a profile the transport cannot honour.
    pub fn validate(self) -> Result<()> {
        if self.depth == 0 {
            return Err(LinkError::Unsupported(
                "qos depth 0 would drop every frame".to_string(),
            ));
        }
        if self.depth > Self::MAX_DEPTH {
            return Err(LinkError::Unsupported(format!(
                "qos depth {} exceeds the maximum of {}",
                self.depth,
                Self::MAX_DEPTH
            )));
        }
        if self.depth > 1 && matches!(self.drop_policy, DropPolicy::DropOldest) {
            return Err(LinkError::Unsupported(
                "drop-oldest requires depth 1 (the latest-sample queue); use depth 1 or drop-newest"
                    .to_string(),
            ));
        }
        Ok(())
    }
}

impl Default for Qos {
    fn default() -> Self {
        Self::default_qos()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_express_the_documented_intent() {
        let s = Qos::sensor();
        assert_eq!(s.reliability, Reliability::BestEffort);
        assert_eq!(s.depth(), 1);
        assert!(s.is_latest_only());
        assert!(s.validate().is_ok());

        let c = Qos::control();
        assert_eq!(c.reliability, Reliability::Reliable);
        assert_eq!(c.depth(), 64);
        assert!(!c.is_latest_only());

        assert_eq!(Qos::default(), Qos::state());
    }

    #[test]
    fn a_channel_implies_its_profile() {
        // The mapping the topic grammar was designed around, pinned so a subscription to a
        // control pattern can never silently get the sensor profile (which drops the
        // commands it is supposed to deliver).
        assert_eq!(Qos::for_channel(Channel::Sensor), Qos::sensor());
        assert_eq!(Qos::for_channel(Channel::Control), Qos::control());
        assert_eq!(Qos::for_channel(Channel::State), Qos::state());
        assert_eq!(Qos::for_channel(Channel::Telemetry), Qos::state());
        assert_eq!(Qos::for_channel(Channel::Brain), Qos::state());

        // Every channel maps to a valid profile (no preset may be unusable).
        for channel in Channel::ALL {
            let qos = Qos::for_channel(channel);
            assert!(qos.validate().is_ok(), "{channel:?} produced {qos:?}");
        }
        // The safety-relevant one: control traffic is never best-effort.
        assert_eq!(
            Qos::for_channel(Channel::Control).reliability,
            Reliability::Reliable
        );
    }

    #[test]
    fn unsupported_profiles_are_refused_not_silently_downgraded() {
        // Overwriting only exists for the one-slot queue.
        let bad = Qos::new(Reliability::BestEffort, 4, DropPolicy::DropOldest);
        let err = bad
            .validate()
            .expect_err("drop-oldest depth 4 must be refused");
        assert!(matches!(err, LinkError::Unsupported(_)));

        assert!(Qos::new(Reliability::BestEffort, 0, DropPolicy::DropNewest)
            .validate()
            .is_err());
        assert!(Qos::new(
            Reliability::Reliable,
            Qos::MAX_DEPTH + 1,
            DropPolicy::DropNewest
        )
        .validate()
        .is_err());
        // Reliable + depth 1 is legal (a "coalescing but never-dropping" queue).
        assert!(Qos::new(Reliability::Reliable, 1, DropPolicy::DropNewest)
            .validate()
            .is_ok());
    }

    #[test]
    fn keys_round_trip_for_the_cli() {
        for r in [Reliability::BestEffort, Reliability::Reliable] {
            assert_eq!(Reliability::from_key(r.key()), Some(r));
        }
        for p in [DropPolicy::DropNewest, DropPolicy::DropOldest] {
            assert_eq!(DropPolicy::from_key(p.key()), Some(p));
        }
        assert_eq!(Reliability::from_key("nope"), None);
        assert_eq!(DropPolicy::from_key("nope"), None);
        // Forgiving aliases the CLI accepts.
        assert_eq!(
            Reliability::from_key("best_effort"),
            Some(Reliability::BestEffort)
        );
        assert_eq!(DropPolicy::from_key("latest"), Some(DropPolicy::DropOldest));
    }
}
