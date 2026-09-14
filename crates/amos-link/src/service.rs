//! The AmOS-Link **control plane**: `proto/robot_link.proto` over the daemon UDS.
//!
//! The data plane is the pub/sub path (`broker`/`pubsub`, and Zenoh across boards).
//! This module is the *management* plane beside it, and it exists for three callers
//! that are not Rust link nodes:
//!
//! * the **System UI** (`amos-tauri`'s `link::link_status`, read by the Settings
//!   「机器人链路 / Robot Link」 page — §6 of docs/amos-link.md recorded this panel as
//!   missing until it was built),
//! * the `amos-link-cli`,
//! * an external tool that wants to inject a frame or read the topic inventory.
//!
//! It is mounted on the same Unix Domain Socket as `AiAgent`/`Sensor`/`Telephony`
//! (`amos-ai`'s `serve()`), mirroring `amos-sensor::service`: a struct holding the
//! domain object ([`LinkNode`]) with each RPC mapping onto it and domain errors mapped
//! to `tonic::Status`. [`mock_server`] is the ready-to-mount default (a demo node with
//! the in-process broker, the host clock, and a running heartbeat); a caller that owns a
//! calibrated clock or a Zenoh transport mounts [`server`] instead.

use std::collections::BTreeMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use amos_proto::amos_link::{
    robot_link_server::{RobotLink, RobotLinkServer},
    Actuation as ProtoActuation, ActuationList, Empty, HealthState, Heartbeat as ProtoHeartbeat,
    LinkStatus, Metrics, Peer, PublishReply, PublishRequest, TopicList,
};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};

use crate::codec::{Envelope, Timestamp};
use crate::discovery::NodeKind;
use crate::error::LinkError;
use crate::health::LinkHealth;
use crate::keyexpr::{Channel, Topic};
use crate::node::LinkNode;
use crate::robot_hal::{actuation_pattern, ActuationState};
use crate::telemetry::{Heartbeat, HeartbeatTask, DEFAULT_HEARTBEAT_PERIOD};

/// How many heartbeats the control plane may buffer before it drops the oldest.
///
/// A streaming client that stops reading must not be able to grow the daemon's memory:
/// beats are a liveness signal, so the newest ones are the only ones worth keeping.
const HEARTBEAT_CHANNEL: usize = 32;

/// The control plane's copy of the **return path**: the latest actuation report per robot.
///
/// The reports themselves travel the data plane (`amos/<robot>/state/actuation`); this table
/// is the control plane's fold of them, so a caller that is not a link node — the System UI —
/// can read what the robots say about themselves. A robot that never reported is **absent**
/// (never a fabricated zero), and the stamp is the robot's own publish time, not ours.
#[derive(Debug, Default)]
pub struct ActuationTable {
    /// `robot id -> (its latest report, when it published it)`.
    robots: BTreeMap<String, (ActuationState, Timestamp)>,
}

impl ActuationTable {
    /// Fold one received report in, keyed by the frame's **publisher** (the robot that owns
    /// the topic) — not by anything the payload claims.
    pub fn record(&mut self, robot: &str, state: ActuationState, stamp: Timestamp) {
        self.robots.insert(robot.to_string(), (state, stamp));
    }

    /// Every robot that has reported, sorted by id.
    pub fn robots(&self) -> impl Iterator<Item = (&String, &ActuationState, Timestamp)> {
        self.robots
            .iter()
            .map(|(id, (state, stamp))| (id, state, *stamp))
    }

    /// How many robots are currently known.
    pub fn len(&self) -> usize {
        self.robots.len()
    }

    /// True when no robot has reported (yet).
    pub fn is_empty(&self) -> bool {
        self.robots.is_empty()
    }
}

/// The task that keeps [`ActuationTable`] current; held by the service, so the field *is* the
/// lifetime (dropping the service stops the watcher — the same rule as `_heartbeat`).
pub struct ActuationWatch {
    task: Option<tokio::task::JoinHandle<()>>,
}

impl ActuationWatch {
    /// Stop watching and wait for the task to finish. Whatever was folded in stays in the
    /// table (it is a snapshot, not a subscription view) — a fresh watcher can be started
    /// over it.
    pub async fn stop(mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            // An aborted task joins with `Cancelled`; that is the expected path, so it is
            // logged rather than discarded (a silent `let _ =` would hide a real panic in
            // the watcher — the same rule the heartbeat/federation tasks follow).
            if let Err(e) = task.await {
                tracing::debug!(error = %e, "actuation watch task ended");
            }
        }
    }
}

impl Drop for ActuationWatch {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// The gRPC service wiring a [`LinkNode`] to the wire contract.
pub struct LinkService {
    node: Arc<LinkNode>,
    /// Sequence numbers for frames injected through `Publish`.
    publish_seq: AtomicU64,
    // The node's own heartbeat, when this service owns it (see
    // [`LinkService::with_heartbeat`]). Held (never read) because dropping it would
    // detach the task: the field *is* the lifetime, and the underscore says so.
    _heartbeat: Option<HeartbeatTask>,
    /// The latest actuation report per robot (the return path, folded — see
    /// [`ActuationTable`]).
    actuations: Arc<Mutex<ActuationTable>>,
    // The watcher that fills `actuations`; held for the same reason as `_heartbeat`.
    _actuation_watch: Option<ActuationWatch>,
}

impl LinkService {
    /// Wrap a node. The caller owns liveness: if the node should beat, either spawn
    /// [`LinkNode::spawn_heartbeat`] itself or use [`LinkService::with_heartbeat`].
    pub fn new(node: Arc<LinkNode>) -> Self {
        Self {
            node,
            publish_seq: AtomicU64::new(0),
            _heartbeat: None,
            actuations: Arc::new(Mutex::new(ActuationTable::default())),
            _actuation_watch: None,
        }
    }

    /// Wrap a node **and start its heartbeat**, so this service owns the node's liveness.
    ///
    /// Why this exists: `StreamHeartbeats` and docs/amos-link.md §5 both promise every
    /// peer's beat *including this node's*. A mounted node with no heartbeat task makes
    /// that stream one that can never yield a single message — the "is the bus alive?"
    /// question answered with a silence indistinguishable from a healthy quiet link — and
    /// leaves the health fold's "no evidence yet" permanent. The daemon mounts this shape,
    /// so the beat belongs to the service rather than to a caller that does not exist.
    pub fn with_heartbeat(node: Arc<LinkNode>) -> Self {
        let _heartbeat = start_heartbeat(&node);
        let actuations = Arc::new(Mutex::new(ActuationTable::default()));
        let _actuation_watch = start_actuation_watch(&node, Arc::clone(&actuations));
        Self {
            node,
            publish_seq: AtomicU64::new(0),
            _heartbeat,
            actuations,
            _actuation_watch,
        }
    }

    /// The node this service reports on.
    pub fn node(&self) -> &Arc<LinkNode> {
        &self.node
    }
}

/// Start the node's heartbeat, or explain why not — never a silent no-beat.
///
/// Two refusals to panic: `spawn_heartbeat` itself refuses a zero period (the only
/// error, unreachable with the 1 s [`DEFAULT_HEARTBEAT_PERIOD`]), and `tokio::spawn`
/// needs a runtime — `mock_server()` is a *sync* constructor that a caller could reach
/// from outside one, and panicking there would be a worse failure than a warned-about
/// silent node.
fn start_heartbeat(node: &Arc<LinkNode>) -> Option<HeartbeatTask> {
    if tokio::runtime::Handle::try_current().is_err() {
        tracing::warn!(
            peer = %node.peer(),
            "no tokio runtime: the link node cannot beat (mount the service inside a runtime)"
        );
        return None;
    }
    match node.spawn_heartbeat(DEFAULT_HEARTBEAT_PERIOD) {
        Ok(task) => {
            tracing::debug!(
                peer = %node.peer(),
                period_ms = DEFAULT_HEARTBEAT_PERIOD.as_millis(),
                "link node heartbeat started"
            );
            Some(task)
        }
        Err(e) => {
            tracing::warn!(peer = %node.peer(), error = %e, "the link node is not beating");
            None
        }
    }
}

/// Start watching the **return path** (`amos/*/state/actuation`), or say why not.
///
/// The watcher subscribes on the node's own transport, so a deployment that mounts a
/// Zenoh-backed node folds in the whole board fleet while the demo node sees whatever its own
/// process published. It is deliberately a *subscription*, not a query: the broker keeps **no
/// retained value and replays nothing**, so a robot that reported before this service started
/// watching stays absent until it reports again — its next mode change, or the periodic
/// refresh a bridge sends for exactly this reason ([`crate::robot_hal::DEFAULT_REPORT_REFRESH`]).
fn start_actuation_watch(
    node: &Arc<LinkNode>,
    table: Arc<Mutex<ActuationTable>>,
) -> Option<ActuationWatch> {
    if tokio::runtime::Handle::try_current().is_err() {
        tracing::warn!(
            peer = %node.peer(),
            "no tokio runtime: the control plane cannot watch robots' actuation reports"
        );
        return None;
    }
    let node = Arc::clone(node);
    let task = tokio::spawn(async move {
        let pattern = match actuation_pattern() {
            Ok(pattern) => pattern,
            Err(e) => {
                tracing::warn!(error = %e, "actuation watch: unusable pattern");
                return;
            }
        };
        let mut reports = match node
            .subscriber::<ActuationState>(
                pattern.clone(),
                crate::qos::Qos::for_channel(Channel::State),
            )
            .await
        {
            Ok(subscriber) => subscriber,
            Err(e) => {
                tracing::warn!(pattern = %pattern, error = %e, "actuation watch not started");
                return;
            }
        };
        tracing::debug!(pattern = %pattern, "control plane is watching robots' actuation");
        // Runs until the link closes; the service owns this task's lifetime.
        loop {
            match reports.recv().await {
                Ok(received) => {
                    // Keyed by the frame's publisher — the robot that owns the topic — never
                    // by anything the payload claims.
                    let robot = received.publisher.as_str().to_string();
                    let state = received.message;
                    let stamp = received.stamp;
                    if let Ok(mut guard) = table.lock() {
                        guard.record(&robot, state, stamp);
                    } else {
                        tracing::warn!("actuation table poisoned; dropping a report");
                    }
                }
                Err(e) => {
                    tracing::debug!(error = %e, "actuation watch stopped: link closed");
                    return;
                }
            }
        }
    });
    Some(ActuationWatch { task: Some(task) })
}

/// A ready-to-mount [`RobotLinkServer`] over a demo node: in-process broker, host clock,
/// and **its own heartbeat running** (see [`LinkService::with_heartbeat`]) — so the
/// mounted control plane really reports a live node. This is what `amos-ai` mounts; an
/// operator/deployment that wants calibrated timestamps or the Zenoh transport builds its
/// own node and calls [`server`] (which leaves liveness to that caller).
pub fn mock_server() -> RobotLinkServer<LinkService> {
    let peer = crate::discovery::PeerId::new("amos-daemon").unwrap_or_default();
    RobotLinkServer::new(LinkService::with_heartbeat(LinkNode::in_process(
        peer,
        NodeKind::Tool,
    )))
}

/// A ready-to-mount [`RobotLinkServer`] around a caller-provided node.
pub fn server(node: Arc<LinkNode>) -> RobotLinkServer<LinkService> {
    RobotLinkServer::new(LinkService::new(node))
}

#[tonic::async_trait]
impl RobotLink for LinkService {
    async fn get_status(&self, _request: Request<Empty>) -> Result<Response<LinkStatus>, Status> {
        let status = self.node.status().await;
        Ok(Response::new(LinkStatus {
            peer: status.peer.as_str().to_string(),
            kind: status.kind.key().to_string(),
            version: status.version,
            uptime_ms: status.uptime_ms,
            clock_synced: status.clock_synced,
            metrics: Some(Metrics {
                published: status.metrics.published,
                delivered: status.metrics.delivered,
                dropped: status.metrics.dropped,
                decode_errors: status.metrics.decode_errors,
                peers: status.peers.len() as u64,
                encode_errors: status.metrics.encode_errors,
                blocked: status.metrics.blocked,
            }),
            health: match status.health {
                LinkHealth::Unknown => HealthState::HealthUnknown as i32,
                LinkHealth::Healthy => HealthState::HealthHealthy as i32,
                LinkHealth::Degraded { .. } => HealthState::HealthDegraded as i32,
            },
            health_reasons: status
                .health
                .reasons()
                .iter()
                .map(crate::health::HealthReason::detail)
                .collect(),
            peers: status
                .peers
                .into_iter()
                .map(|p| Peer {
                    id: p.info.id.as_str().to_string(),
                    kind: p.info.kind.key().to_string(),
                    endpoint: p.info.endpoint().unwrap_or_default().to_string(),
                    last_seen_ms: p.last_seen_ms,
                    beacons: p.beacons,
                })
                .collect(),
        }))
    }

    async fn list_topics(&self, _request: Request<Empty>) -> Result<Response<TopicList>, Status> {
        Ok(Response::new(TopicList {
            topics: self.node.topics().await,
        }))
    }

    /// The robots' own actuation reports, folded (the control loop's return path).
    ///
    /// A robot that has not reported since this service started watching is **absent** from
    /// the list: an empty list means "nobody told us", not "everyone is idle" — the
    /// distinction the System UI's panel and the CLI both render explicitly.
    async fn list_actuations(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<ActuationList>, Status> {
        let table = self
            .actuations
            .lock()
            .map_err(|_| Status::internal("the actuation table is poisoned"))?;
        let robots = table
            .robots()
            .map(|(id, state, stamp)| proto_actuation(id, state, stamp))
            .collect();
        Ok(Response::new(ActuationList { robots }))
    }

    /// Publish a raw payload on the node's transport.
    ///
    /// The frame is wrapped in a real [`Envelope`] (this node's peer id, its own
    /// injection sequence, the node's clock), so a caller that is not a Rust AmOS-Link
    /// node still produces frames that decode for typed subscribers. The sequence
    /// counter is separate from any local publisher's — `seq` is per publisher, and an
    /// injected frame *is* a distinct publisher (the daemon's control plane).
    async fn publish(
        &self,
        request: Request<PublishRequest>,
    ) -> Result<Response<PublishReply>, Status> {
        let inner = request.into_inner();
        let topic = Topic::new(inner.topic).map_err(|e| Status::invalid_argument(e.to_string()))?;
        let seq = crate::telemetry::next_seq(&self.publish_seq);
        let envelope = Envelope::new(
            &topic,
            self.node.peer(),
            seq,
            self.node.clock().now(),
            inner.payload,
        );
        let wire = envelope.encode().map_err(err_status)?;
        let report = self
            .node
            .transport()
            .publish(&topic, Arc::from(wire.into_boxed_slice()))
            .await
            .map_err(err_status)?;
        Ok(Response::new(PublishReply {
            seq,
            matched: count_to_u32(report.matched.unwrap_or(0)),
            delivered: count_to_u32(report.delivered),
            dropped: count_to_u32(report.dropped),
        }))
    }

    type StreamHeartbeatsStream = ReceiverStream<Result<ProtoHeartbeat, Status>>;

    /// Stream the link's heartbeats.
    ///
    /// A bidirectional bridge: a `Subscriber<Heartbeat>` on the **link's** beat pattern
    /// (`amos/*/telemetry/beat`) feeds a bounded channel that the RPC drains, so the
    /// stream carries what the peers (and this node) *actually published* rather than a
    /// synthetic counter. Watching every peer — not only this node — is what makes the
    /// stream a "is the bus alive" signal; `GetStatus` is the place to ask "who exactly".
    /// The forwarding task ends with the client (its receiver is dropped) or with the
    /// node's transport closing — no orphaned task.
    async fn stream_heartbeats(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<Self::StreamHeartbeatsStream>, Status> {
        let mut subscriber = self
            .node
            .subscriber::<Heartbeat>(
                crate::telemetry::heartbeat_pattern().map_err(err_status)?,
                crate::qos::Qos::sensor(),
            )
            .await
            .map_err(err_status)?;
        let (tx, rx) = tokio::sync::mpsc::channel(HEARTBEAT_CHANNEL);
        tokio::spawn(async move {
            // Runs while the RPC client reads and the link is up: the loop ends when the
            // client disconnects (`tx.send` fails) or the subscription closes.
            loop {
                match subscriber.recv().await {
                    Ok(received) => {
                        let beat: Heartbeat = received.message;
                        if tx.send(Ok(proto_heartbeat(&beat))).await.is_err() {
                            tracing::debug!("heartbeat stream: client disconnected");
                            return;
                        }
                    }
                    Err(e) => {
                        tracing::debug!(error = %e, "heartbeat stream: link closed");
                        return;
                    }
                }
            }
        });
        Ok(Response::new(ReceiverStream::new(rx)))
    }
}

/// Map a local publish-report count onto the `u32` the wire carries, **saturating**.
///
/// `PublishReply`'s counters are `u32` in `proto/robot_link.proto` while the report is
/// `usize` here, and `as u32` truncates *silently*: a large number would be reported as a
/// small one ("almost nothing was delivered") with no way for the caller to notice. Today
/// the counts are bounded by the subscription table, so saturation is unreachable — which is
/// exactly why it must be expressed rather than assumed (the same rule the frame ceiling and
/// the sequence counter follow).
fn count_to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Map one robot's folded report onto the wire message.
///
/// The proto has no `Option`, so "absent" is encoded the way the field comments say: `0` for
/// `seq` / `last_refusal_seq` / `watchdog_ms`, `""` for `gait` / `estop_reason` /
/// `last_refusal`. Nothing here invents a value the robot did not report.
fn proto_actuation(robot: &str, state: &ActuationState, stamp: Timestamp) -> ProtoActuation {
    ProtoActuation {
        robot: robot.to_string(),
        seq: state.seq.unwrap_or(0),
        gait: state.gait.map(|g| g.key().to_string()).unwrap_or_default(),
        frames: state.frames as u32,
        armed: state.armed,
        estopped: state.estopped,
        estop_reason: state
            .estop_reason
            .map(|r| r.key().to_string())
            .unwrap_or_default(),
        watchdog_ms: state.watchdog_ms.unwrap_or(0),
        last_refusal_seq: state.last_refusal.as_ref().map(|r| r.seq).unwrap_or(0),
        last_refusal: state
            .last_refusal
            .as_ref()
            .map(|r| r.reason.clone())
            .unwrap_or_default(),
        stamp_secs: stamp.secs,
        stamp_nanos: stamp.nanos,
    }
}

/// Map a domain heartbeat onto the wire message.
fn proto_heartbeat(beat: &Heartbeat) -> ProtoHeartbeat {
    ProtoHeartbeat {
        peer: beat.peer.as_str().to_string(),
        seq: beat.seq,
        stamp_secs: beat.stamp.secs,
        stamp_nanos: beat.stamp.nanos,
        uptime_ms: beat.uptime_ms,
    }
}

/// Map a domain error onto a gRPC status: a caller error is `InvalidArgument`, an
/// environment failure is `Unavailable`, anything else is `Internal`.
fn err_status(err: LinkError) -> Status {
    match err {
        LinkError::KeyExpr { .. } | LinkError::Unsupported(_) | LinkError::Robot(_) => {
            Status::invalid_argument(err.to_string())
        }
        LinkError::Closed(_) => Status::unavailable(err.to_string()),
        other => Status::internal(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::robot_hal::{EstopReason, Gait, Refusal};

    #[test]
    fn publish_counts_saturate_instead_of_wrapping_on_the_wire() {
        // `PublishReply` is `u32` on the wire and the report is `usize` locally: the honest
        // rendering of "more than this field can say" is the ceiling, never a wrapped small
        // number that reads as "almost nothing was delivered".
        assert_eq!(count_to_u32(0), 0);
        assert_eq!(count_to_u32(3), 3);
        assert_eq!(count_to_u32(u32::MAX as usize), u32::MAX);
        assert_eq!(count_to_u32(usize::MAX), u32::MAX);
        // The negative control for the truncation this replaced: on a 64-bit host a value
        // whose *low* 32 bits are small (`2³² + 3`) reads as `3` under `as u32` — "almost
        // nothing was delivered" — while saturation says "more than this field can express".
        #[cfg(target_pointer_width = "64")]
        {
            let beyond = (1usize << 32) + 3;
            assert_eq!(count_to_u32(beyond), u32::MAX);
            assert_eq!(beyond as u32, 3, "…not the low 32 bits");
        }
    }

    fn report(gait: Gait, armed: bool) -> ActuationState {
        ActuationState {
            seq: Some(1),
            gait: Some(gait),
            frames: 13,
            armed,
            estopped: false,
            estop_reason: None,
            watchdog_ms: Some(1000),
            last_refusal: None,
        }
    }

    #[test]
    fn the_table_folds_by_robot_and_keeps_the_newest() {
        let mut table = ActuationTable::default();
        assert!(table.is_empty(), "nothing has reported yet");
        table.record("dog1", report(Gait::Trot, true), Timestamp::now());
        table.record("dog2", report(Gait::Sit, true), Timestamp::now());
        assert_eq!(table.len(), 2);

        // A robot reports repeatedly; the newest report replaces the older one — it is not
        // appended.
        table.record("dog1", report(Gait::Stand, true), Timestamp::now());
        assert_eq!(table.len(), 2, "still two robots");
        let ids: Vec<&String> = table.robots().map(|(id, _, _)| id).collect();
        assert_eq!(ids, vec!["dog1", "dog2"], "sorted by id, not by arrival");
        let dog1 = table
            .robots()
            .find(|(id, _, _)| *id == "dog1")
            .expect("dog1 is present")
            .1;
        assert_eq!(dog1.gait, Some(Gait::Stand), "the newest report won");
    }

    #[test]
    fn the_wire_mapping_invents_nothing_the_robot_did_not_report() {
        let stamp = Timestamp { secs: 7, nanos: 8 };
        // Before any action the proto's "no value" encodings are used (the proto has no
        // `Option`), and the field comments say so: 0 / "".
        let idle = ActuationState {
            seq: None,
            gait: None,
            frames: 0,
            armed: false,
            estopped: false,
            estop_reason: None,
            watchdog_ms: None,
            last_refusal: None,
        };
        let wire = proto_actuation("dog1", &idle, stamp);
        assert_eq!(wire.robot, "dog1");
        assert_eq!(wire.seq, 0);
        assert_eq!(wire.gait, "");
        assert_eq!(wire.estop_reason, "");
        assert_eq!(wire.watchdog_ms, 0);
        assert_eq!(wire.last_refusal, "");
        assert_eq!(wire.last_refusal_seq, 0);
        assert_eq!((wire.stamp_secs, wire.stamp_nanos), (7, 8));
        assert!(!wire.armed && !wire.estopped);

        // A real report travels verbatim, refusal and all.
        let mut stopped = report(Gait::Estop, false);
        stopped.estopped = true;
        stopped.estop_reason = Some(EstopReason::Watchdog);
        stopped.last_refusal = Some(Refusal {
            seq: 3,
            reason: "e-stop latched".to_string(),
        });
        let wire = proto_actuation("dog1", &stopped, stamp);
        assert_eq!(wire.gait, "estop");
        assert!(wire.estopped && !wire.armed);
        assert_eq!(wire.estop_reason, "watchdog");
        assert_eq!(wire.watchdog_ms, 1000);
        assert_eq!(wire.frames, 13);
        assert_eq!(wire.last_refusal_seq, 3);
        assert_eq!(wire.last_refusal, "e-stop latched");
    }
}
