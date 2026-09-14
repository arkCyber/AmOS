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

use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use amos_proto::amos_link::{
    robot_link_server::{RobotLink, RobotLinkServer},
    Empty, HealthState, Heartbeat as ProtoHeartbeat, LinkStatus, Metrics, Peer, PublishReply,
    PublishRequest, TopicList,
};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};

use crate::codec::Envelope;
use crate::discovery::NodeKind;
use crate::error::LinkError;
use crate::health::LinkHealth;
use crate::keyexpr::Topic;
use crate::node::LinkNode;
use crate::telemetry::{Heartbeat, HeartbeatTask, DEFAULT_HEARTBEAT_PERIOD};

/// How many heartbeats the control plane may buffer before it drops the oldest.
///
/// A streaming client that stops reading must not be able to grow the daemon's memory:
/// beats are a liveness signal, so the newest ones are the only ones worth keeping.
const HEARTBEAT_CHANNEL: usize = 32;

/// The gRPC service wiring a [`LinkNode`] to the wire contract.
pub struct LinkService {
    node: Arc<LinkNode>,
    /// Sequence numbers for frames injected through `Publish`.
    publish_seq: AtomicU64,
    // The node's own heartbeat, when this service owns it (see
    // [`LinkService::with_heartbeat`]). Held (never read) because dropping it would
    // detach the task: the field *is* the lifetime, and the underscore says so.
    _heartbeat: Option<HeartbeatTask>,
}

impl LinkService {
    /// Wrap a node. The caller owns liveness: if the node should beat, either spawn
    /// [`LinkNode::spawn_heartbeat`] itself or use [`LinkService::with_heartbeat`].
    pub fn new(node: Arc<LinkNode>) -> Self {
        Self {
            node,
            publish_seq: AtomicU64::new(0),
            _heartbeat: None,
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
        Self {
            node,
            publish_seq: AtomicU64::new(0),
            _heartbeat,
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
            matched: report.matched.unwrap_or(0) as u32,
            delivered: report.delivered as u32,
            dropped: report.dropped as u32,
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
