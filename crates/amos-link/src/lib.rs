//! `amos-link` — **AmOS-Link**, the robot middleware of AmOS.
//!
//! ROS is not an operating system: it is a distributed pub/sub middleware around a
//! message registry and a discovery service. AmOS-Link is that middleware, built from
//! the crates the workspace already trusts (tokio, serde/bincode, tonic, and — behind a
//! feature — Zenoh) and sized for a robot: a stereo pair at 60 Hz on one board, a model
//! server on a Mac mini, over Wi-Fi/5G, with a laptop joining as a tool.
//!
//! Four pieces, in the order data flows:
//!
//! ```text
//!   1. keys      amos/<peer>/<channel>/<name>  + * / **        (keyexpr)
//!   2. framing   AMLK │ ver │ hdr │ crc32 │ bincode payload    (codec, qos, metrics)
//!   3. transport Broker (in-process) · Zenoh (across boards)   (broker, zenoh)
//!   4. discovery UDP beacons → PeerRegistry                    (discovery, lan)
//!        ▲                                                          │
//!        └────────── node · telemetry · robot_hal · service ◄────────┘
//! ```
//!
//! * [`keyexpr`] — [`Topic`]/[`Channel`]: a validated `amos/<peer>/<channel>/<name>`
//!   path, wildcard matching, and the `*`/`**` grammar Zenoh shares, so one pattern
//!   works on both transports.
//! * [`codec`] — [`Message`] (any `serde` type), the [`Envelope`] frame (magic +
//!   version + bincode header + CRC32), [`Timestamp`] and the [`Clock`] that stamps
//!   every frame from `amos-timesync` so latency is measurable once the clock is
//!   calibrated.
//! * [`qos`] — the ROS reliability/history knobs, reduced to three fields:
//!   `Reliability::{BestEffort, Reliable}` x `depth` x `DropPolicy::{DropNewest,
//!   DropOldest}`. Sensor streams want `Qos::sensor()` (one slot, newest wins);
//!   control wants `Qos::control()` (reliable, back-pressuring).
//! * [`broker`] — the [`Transport`] seam and the in-process [`Broker`]: per-subscriber
//!   queues, fan-out by pointer (`Arc<[u8]>`), counters that never lie.
//! * [`discovery`] — [`Beacon`]/[`PeerRegistry`]: peers appear and expire by TTL with
//!   no IP list; a beacon frame carries a length + CRC32 and is bounds-checked on both
//!   sides, and `lan` (feature) is the real UDP channel.
//! * [`telemetry`] — [`Heartbeat`] + [`NodeStatus`]: liveness on the link and one JSON
//!   document for an operator.
//! * [`sequence`] — [`SeqTracker`]: per-**stream** sequence accounting, so “a gap means a
//!   dropped frame” is a number (`gaps` / `missing` / `stale`) instead of a comment.
//! * [`robot_hal`] — the agent→motors boundary: JSON intent is validated, expanded into
//!   a gait pose, and encoded as CRC-checked motor frames over a [`RobotHal`] seam.
//! * [`node`] — [`LinkNode`]: identity + transport + clock + counters + peer table, the
//!   object publishers/subscribers/the control plane are minted from.
//! * [`service`] — the tonic control plane (`proto/robot_link.proto`): status, topic
//!   inventory, raw publish, heartbeat stream — mounted by `amos-ai` on the daemon UDS.
//! * `lan` / `zenoh` (features) — the real network channels behind the two seams.
//!
//! Why inside the AmOS workspace rather than a separate repository: the payload types
//! are the workspace's own (`amos-sensor` frames, `amos-power` telemetry) and the clock
//! is `amos-timesync`'s, so the middleware ships with the contracts it carries instead
//! of duplicating them. `docs/amos-link.md` records the reasoning and the honest
//! boundaries (what this crate does *not* claim to be: a scheduler, a ROS compatibility
//! layer, or a replacement for the daemon's UDS service bus).

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod broker;
pub mod codec;
pub mod discovery;
pub mod error;
pub mod health;
pub mod keyexpr;
pub mod metrics;
pub mod node;
pub mod pubsub;
pub mod rate;
pub mod qos;
pub mod robot_hal;
pub mod sequence;
pub mod telemetry;

#[cfg(feature = "lan")]
pub mod lan;

#[cfg(feature = "zenoh")]
pub mod zenoh;

pub mod service;

pub use broker::{Broker, Ingress, PublishReport, Subscription, SubscriptionStats, Transport};
pub use codec::{Clock, Envelope, Header, Message, Timestamp};
pub use discovery::{
    beacon_pattern, spawn_federation, Beacon, BusDiscovery, Discovery, FederationTask,
    MockDiscovery, NodeKind, PeerId, PeerInfo, PeerRegistry, PeerView, BEACON_TOPIC,
};
pub use error::{LinkError, Result};
pub use health::{HealthReason, LinkHealth};
pub use keyexpr::{Channel, Topic};
pub use metrics::{LinkMetrics, MetricsSnapshot};
pub use node::{LinkNode, VERSION};
pub use pubsub::{Publisher, Received, Subscriber};
pub use qos::{DropPolicy, Qos, Reliability};
pub use robot_hal::{
    actuation_pattern, actuation_topic, ActuationState, AgentAction, Gait, JointId, JointTarget,
    MockRobotHal, MotorFrame, MotorOp, Refusal, RobotBridge, RobotCommand, RobotHal,
    StreamRobotHal, ACTUATION_NAME, DEFAULT_REPORT_REFRESH, MAX_ACTUATION_FRAMES,
    MAX_REFUSAL_REASON_BYTES, MAX_WATCHDOG_MS,
};
pub use sequence::{SeqEvent, SeqSummary, SeqTracker, StreamKey, MAX_TRACKED_STREAMS};
pub use telemetry::{
    heartbeat_pattern, Heartbeat, HeartbeatTask, NodeStatus, DEFAULT_HEARTBEAT_PERIOD,
};
