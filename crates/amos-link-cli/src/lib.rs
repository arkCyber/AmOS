//! `amos-link-cli` — drive and inspect the AmOS-Link robot middleware from a terminal.
//!
//! The same crate the daemon mounts, driven by hand: the CLI builds one in-process
//! [`LinkNode`](amos_link::LinkNode) (broker transport, host clock) and exercises the
//! path an operator cares about — publish, subscribe, the topic inventory, a latency
//! benchmark, discovery, and the JSON→motor-frame translation.
//!
//! ```text
//! amos-link-cli status                 # identity, counters, peers, clock freshness (JSON)
//! amos-link-cli topics                 # the topic inventory of a live node
//! amos-link-cli pub --topic amos/dog1/control/joints --action '{"action":"trot"}'
//! amos-link-cli sub --pattern 'amos/**' --count 3
//! amos-link-cli bench --count 2000 --size 4096     # publish + measure real latency
//! amos-link-cli discover --peer dog1 --peer mini-brain
//! amos-link-cli motor --action '{"action":"trot","speed":0.5}'   # frames + hex log
//! ```
//!
//! Two honest notes about scope: `--transport zenoh` and `discover --lan` are the real
//! network paths and need the matching build feature (`zenoh` / `lan`); without it the
//! command says so instead of silently using a different transport. And `pub`/`sub`
//! carry [`AgentAction`](amos_link::robot_hal::AgentAction) payloads — text or JSON —
//! because a `String`-carrying `Message` is the one shape both a human and an agent can
//! produce without a schema.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use amos_link::codec::Message;
use amos_link::discovery::{NodeKind, PeerId, PeerInfo, PeerRegistry, PeerView};
use amos_link::health::LinkHealth;
use amos_link::keyexpr::Topic;
use amos_link::node::LinkNode;
use amos_link::pubsub::Received;
use amos_link::qos::Qos;
use amos_link::robot_hal::{parse_command, plan, AgentAction, MockRobotHal, MotorFrame, RobotHal};
use amos_link::sequence::{SeqEvent, SeqTracker};
use amos_link::telemetry::{heartbeat_pattern, Heartbeat, DEFAULT_HEARTBEAT_PERIOD};
use amos_proto::amos_link::robot_link_client::RobotLinkClient;
use amos_proto::amos_link::{Empty, HealthState, PublishRequest};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// CLI help text (kept next to the parser so they cannot drift).
pub const USAGE: &str = "\
amos-link-cli — drive and inspect the AmOS-Link robot middleware

USAGE:
    amos-link-cli status                      Node identity, counters, peers (JSON)
    amos-link-cli topics                      Topics the node has seen traffic on
    amos-link-cli pub   --topic <T> <payload> Publish on one concrete topic
    amos-link-cli sub   --pattern <P>         Subscribe to a pattern (wildcards allowed)
    amos-link-cli bench [--count N] [--size B] Loopback latency + throughput
    amos-link-cli discover [--peer <ID>]...   Show the peer table (mock or --lan)
    amos-link-cli watch [--seconds N]         Heartbeat + federation: live link liveness
    amos-link-cli motor --action <JSON>       Translate an agent action into motor frames

OPTIONS:
        --peer <ID>        This node's id (default: amos-node; $AMOS_LINK_PEER)
        --static <ID>      `discover`: seed a known peer (repeatable)
        --kind <KIND>      robot | brain | sensor | actuator | tool (default: tool)
        --transport <T>    broker (default) | zenoh (needs the `zenoh` feature)
        --topic <T>        Concrete topic for `pub`/`bench`
        --pattern <P>      Subscription pattern for `sub`
        --action <JSON>    The agent's JSON action (`pub`, `motor`)
        --text <S>         Plain-text payload for `pub` (a JSON action shortcut)
        --count <N>        Frames to publish/subscribe/bench (default 1 / 1 / 1000)
        --hz <R>           Publish rate for `pub`/`bench` (default: as fast as possible)
        --size <B>         `bench` payload size in bytes (default: 1024)
        --qos <Q>          sensor | state | control (default: the pattern's channel, else sensor)
        --lan              `discover`: use real UDP beacons (needs the `lan` feature)
        --bus              `discover`: federate over the link transport (beacons on the
                           link itself; with --transport zenoh this is the real LAN table)
        --seconds <N>      `discover`/`watch`: how long to listen (default: 3)
        --timeout-ms <N>   `sub`: give up after N ms (default 0 = wait forever)
        --socket <PATH>    Address the daemon's LIVE control plane on this Unix socket
                           instead of a local node: status / topics / pub / watch read the
                           running robot (`sub`/`bench`/`discover` need a local node and
                           are refused by name)
        --json             `sub`/`watch`/`status --socket`: print each line as JSON
    -h, --help             Print this help and exit
    -V, --version          Print version and exit
";

/// Which operation to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cmd {
    /// Print the node's self-description.
    Status,
    /// Print the topic inventory.
    Topics,
    /// Publish frames on one topic.
    Pub,
    /// Receive frames matching a pattern.
    Sub,
    /// Publish and receive on one link to measure latency and throughput.
    Bench,
    /// Show the peer table (mock beacons, or real LAN beacons with `--lan`).
    Discover,
    /// Publish heartbeats, join the federation, and print live link liveness.
    Watch,
    /// Translate an agent action into motor frames.
    Motor,
}

impl Cmd {
    /// The word the operator typed — used so a refusal names the command it refused.
    fn key(self) -> &'static str {
        match self {
            Cmd::Status => "status",
            Cmd::Topics => "topics",
            Cmd::Pub => "pub",
            Cmd::Sub => "sub",
            Cmd::Bench => "bench",
            Cmd::Discover => "discover",
            Cmd::Watch => "watch",
            Cmd::Motor => "motor",
        }
    }
}

/// The transport to build the node on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    /// The in-process broker (default; no sockets).
    Broker,
    /// The Zenoh session (needs the `zenoh` feature).
    Zenoh,
}

/// Resolved CLI options.
#[derive(Debug, Clone, PartialEq)]
pub struct Opts {
    /// Which operation to run.
    pub cmd: Cmd,
    /// This node's peer id.
    pub peer: String,
    /// This node's role.
    pub kind: NodeKind,
    /// The transport to build.
    pub transport: TransportKind,
    /// `pub`/`bench`: the concrete topic.
    pub topic: Option<String>,
    /// `sub`: the pattern.
    pub pattern: Option<String>,
    /// The agent's JSON action (`pub`, `motor`).
    pub action: Option<String>,
    /// Plain-text payload (`pub`).
    pub text: Option<String>,
    /// Frame count (meaning depends on the command).
    pub count: Option<u64>,
    /// Publish rate in Hz (`pub`, `bench`).
    pub hz: Option<f64>,
    /// `bench` payload size in bytes.
    pub size: usize,
    /// The QoS profile (parsed from `--qos`).
    pub qos: Option<Qos>,
    /// `discover`: use real UDP beacons.
    pub lan: bool,
    /// `discover`: federate over the link's own transport and show the peer table.
    pub bus: bool,
    /// `discover --lan`: how long to listen.
    pub seconds: u64,
    /// `discover`: static peers to seed the table with.
    pub peers: Vec<String>,
    /// `sub`: give up after this long (0 = wait forever).
    pub timeout_ms: u64,
    /// `sub`: print each frame as JSON.
    pub json: bool,
    /// Address a *running* node's control plane on this Unix socket instead of building a
    /// local one (`None` = local node).
    pub socket: Option<PathBuf>,
    /// `-h`.
    pub help: bool,
    /// `-V`.
    pub version: bool,
}

impl Opts {
    /// The defaults a bare command line resolves to.
    fn defaults(cmd: Cmd) -> Self {
        Self {
            cmd,
            peer: "amos-node".to_string(),
            kind: NodeKind::Tool,
            transport: TransportKind::Broker,
            topic: None,
            pattern: None,
            action: None,
            text: None,
            count: None,
            hz: None,
            size: 1024,
            qos: None,
            lan: false,
            bus: false,
            seconds: 3,
            peers: Vec::new(),
            timeout_ms: 0,
            json: false,
            socket: None,
            help: false,
            version: false,
        }
    }
}

/// Parse CLI args (manual, mirroring the other `*-cli` crates: no clap, no surprises).
pub fn parse_from<I, S>(args: I) -> Result<Opts, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut args = args.into_iter().map(Into::into);
    let mut cmd: Option<Cmd> = None;
    let mut opts = Opts::defaults(Cmd::Status);

    while let Some(arg) = args.next() {
        let mut value = |name: &str| -> Result<String, String> {
            args.next()
                .ok_or_else(|| format!("{name} requires a value"))
        };
        match arg.as_str() {
            "-h" | "--help" => opts.help = true,
            "-V" | "--version" => opts.version = true,
            "status" | "topics" | "pub" | "sub" | "bench" | "discover" | "watch" | "motor"
                if cmd.is_none() =>
            {
                cmd = Some(match arg.as_str() {
                    "status" => Cmd::Status,
                    "topics" => Cmd::Topics,
                    "pub" => Cmd::Pub,
                    "sub" => Cmd::Sub,
                    "bench" => Cmd::Bench,
                    "discover" => Cmd::Discover,
                    "watch" => Cmd::Watch,
                    _ => Cmd::Motor,
                });
            }
            "--peer" => opts.peer = value("--peer")?,
            "--static" => opts.peers.push(value("--static")?),
            "--kind" => {
                let raw = value("--kind")?;
                opts.kind =
                    NodeKind::from_key(&raw).ok_or_else(|| format!("unknown node kind `{raw}`"))?;
            }
            "--transport" => {
                let raw = value("--transport")?;
                opts.transport = match raw.as_str() {
                    "broker" => TransportKind::Broker,
                    "zenoh" => TransportKind::Zenoh,
                    other => return Err(format!("unknown transport `{other}`")),
                };
            }
            "--topic" => opts.topic = Some(value("--topic")?),
            "--pattern" => opts.pattern = Some(value("--pattern")?),
            "--action" => opts.action = Some(value("--action")?),
            "--text" => opts.text = Some(value("--text")?),
            "--count" => {
                let raw = value("--count")?;
                opts.count = Some(
                    raw.parse::<u64>()
                        .map_err(|e| format!("--count `{raw}` is not a number: {e}"))?,
                );
            }
            "--hz" => {
                let raw = value("--hz")?;
                let hz = raw
                    .parse::<f64>()
                    .map_err(|e| format!("--hz `{raw}` is not a number: {e}"))?;
                if hz <= 0.0 || !hz.is_finite() {
                    return Err(format!("--hz {hz} must be a positive, finite rate"));
                }
                opts.hz = Some(hz);
            }
            "--size" => {
                let raw = value("--size")?;
                opts.size = raw
                    .parse::<usize>()
                    .map_err(|e| format!("--size `{raw}` is not a number: {e}"))?;
            }
            "--qos" => {
                let raw = value("--qos")?;
                opts.qos = Some(match raw.as_str() {
                    "sensor" => Qos::sensor(),
                    "state" => Qos::state(),
                    "control" => Qos::control(),
                    other => return Err(format!("unknown qos profile `{other}`")),
                });
            }
            "--lan" => opts.lan = true,
            "--bus" => opts.bus = true,
            "--seconds" => {
                let raw = value("--seconds")?;
                opts.seconds = raw
                    .parse::<u64>()
                    .map_err(|e| format!("--seconds `{raw}` is not a number: {e}"))?;
            }
            "--timeout-ms" => {
                let raw = value("--timeout-ms")?;
                opts.timeout_ms = raw
                    .parse::<u64>()
                    .map_err(|e| format!("--timeout-ms `{raw}` is not a number: {e}"))?;
            }
            "--json" => opts.json = true,
            "--socket" => opts.socket = Some(PathBuf::from(value("--socket")?)),
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    let cmd = cmd.unwrap_or(Cmd::Status);
    // A second positional command is a typo, not a request to run two things.
    opts.cmd = cmd;
    opts.peer = resolve_peer(opts.peer, cmd);
    Ok(opts)
}

/// Resolve the node id: the `--peer` value, else `$AMOS_LINK_PEER`, else the default the
/// command implies (a `bench` node is not a robot).
fn resolve_peer(cli: String, cmd: Cmd) -> String {
    if cli != "amos-node" {
        return cli;
    }
    if let Ok(env) = std::env::var("AMOS_LINK_PEER") {
        if !env.trim().is_empty() {
            return env.trim().to_string();
        }
    }
    match cmd {
        Cmd::Bench => "link-bench".to_string(),
        Cmd::Watch => "link-watch".to_string(),
        Cmd::Motor => "motor-tool".to_string(),
        _ => "amos-node".to_string(),
    }
}

/// Resolve [`parse_from`] against the process environment.
pub fn parse_args() -> Result<Opts, String> {
    parse_from(std::env::args().skip(1))
}

/// Run the requested command.
pub async fn run(opts: Opts) -> Result<()> {
    // `--socket` means "read the *running* node", so it is decided first: a control-plane
    // command must never silently fall back to a local node (that would answer about this
    // process instead of the robot).
    if let Some(socket) = opts.socket.clone() {
        return run_remote(&opts, socket).await;
    }
    // `motor` needs no link at all: it is the pure intent→frames translation.
    if opts.cmd == Cmd::Motor {
        return run_motor(&opts).await;
    }
    if opts.cmd == Cmd::Discover {
        return run_discover(&opts).await;
    }

    let node = build_node(&opts).await?;
    match opts.cmd {
        Cmd::Status => {
            let status = node.status().await;
            println!("{}", status.to_json()?);
        }
        Cmd::Topics => {
            let topics = node.topics().await;
            let complete = node.topics_complete().await;
            if topics.is_empty() {
                println!("(no traffic yet — publish or subscribe first)");
            }
            for topic in &topics {
                println!("{topic}");
            }
            // The inventory carries its own limits: an empty list from a network bus is not
            // an empty link, and a capped broker list is not the whole story.
            if !complete {
                println!(
                    "(inventory incomplete: {} tracked — a network bus cannot enumerate \
                     what others publish, and a full broker inventory stops growing)",
                    topics.len()
                );
            }
        }
        Cmd::Pub => {
            let count = opts.count.unwrap_or(1);
            let action = payload_of(&opts)?;
            let topic = concrete_topic(&opts)?;
            let publisher = node.publisher::<AgentAction>(topic.clone());
            let period = period_of(&opts)?;
            for _ in 0..count {
                let report = publisher
                    .publish(&action)
                    .await
                    .with_context(|| format!("publishing on {topic}"))?;
                println!(
                    "published seq={} topic={} matched={:?} delivered={} dropped={} blocked={}",
                    publisher.seq(),
                    topic,
                    report.matched,
                    report.delivered,
                    report.dropped,
                    report.blocked
                );
                if let Some(period) = period {
                    tokio::time::sleep(period).await;
                }
            }
        }
        Cmd::Sub => {
            let pattern = pattern_of(&opts)?;
            // `--qos` wins; otherwise the pattern's own channel decides (a control pattern
            // must not default to the best-effort sensor profile, which would drop the
            // commands the subscription exists to deliver). A pattern that names no
            // channel falls back to the sensor profile — printed, never assumed.
            let (qos, source) = match opts.qos {
                Some(qos) => (qos, "--qos".to_string()),
                None => match pattern.channel() {
                    Some(channel) => (
                        Qos::for_channel(channel),
                        format!("channel {}", channel.key()),
                    ),
                    None => (
                        Qos::sensor(),
                        "default (no channel in the pattern)".to_string(),
                    ),
                },
            };
            let mut subscriber = node
                .subscriber::<AgentAction>(pattern.clone(), qos)
                .await
                .with_context(|| format!("subscribing to {pattern}"))?;
            let count = opts.count.unwrap_or(1);
            println!(
                "subscribed peer={} pattern={} qos={}/{} from {} (waiting for {count} frame(s))",
                node.peer(),
                pattern,
                qos.reliability.key(),
                qos.drop_policy.key(),
                source
            );
            // One tracker for the whole run: per-publisher gaps are reported at the end.
            let mut seq = SeqTracker::new();
            for _ in 0..count {
                let received = match recv_with_timeout(&mut subscriber, opts.timeout_ms).await? {
                    Some(frame) => frame,
                    None => {
                        println!(
                            "timeout after {}ms with no frame (received {})",
                            opts.timeout_ms,
                            subscriber.stats().received
                        );
                        break;
                    }
                };
                // Per-publisher sequence accounting: a gap in the publisher's own counter
                // is a frame that never arrived — a fact the receive counters cannot see.
                seq.observe_received(&received);
                print_frame(&received, opts.json)?;
            }
            let stats = subscriber.stats();
            let gaps = seq.summary();
            println!(
                "stats received={} dropped={} decode_errors={} blocked={} streams={} gaps={} \
                 missing={} stale={} loss={:.2}%",
                stats.received,
                stats.dropped,
                stats.decode_errors,
                node.metrics().snapshot().blocked,
                gaps.streams,
                gaps.gaps,
                gaps.missing,
                gaps.stale,
                f64::from(gaps.loss_ratio()) * 100.0
            );
        }
        Cmd::Bench => run_bench(&node, &opts).await?,
        Cmd::Watch => run_watch(&node, &opts).await?,
        // Already handled above (they never build a node); kept exhaustive so adding a
        // command to `Cmd` forces a decision here.
        Cmd::Motor | Cmd::Discover => {}
    }
    Ok(())
}

/// Remote mode: read the control plane of a **running** node instead of building one.
///
/// This is the difference between "smoke the middleware" and "look at the robot": the
/// daemon mounts `proto/robot_link.proto` on the OS's Unix socket, and an operator on the
/// box (or behind an ssh tunnel) asks *that* node for its status, its inventory, an
/// injection and its heartbeats. Commands that need a local data-plane node (`sub`,
/// `bench`, `discover`) are refused by name rather than silently downgraded into something
/// else, and every line names the socket it read — so there is never a guess about which
/// node answered.
async fn run_remote(opts: &Opts, socket: PathBuf) -> Result<()> {
    let mut link = connect_control_plane(&socket).await?;
    let remote = socket.display().to_string();
    match opts.cmd {
        Cmd::Status => {
            let status = link
                .get_status(Empty {})
                .await
                .with_context(|| format!("GetStatus on {remote}"))?
                .into_inner();
            let metrics = status.metrics.unwrap_or_default();
            let health = health_label(status.health);
            if opts.json {
                // The same shape as a local `status`: a document (pretty JSON), not a
                // line-oriented `--json` stream — an operator greps the same keys either
                // way, plus `remote` naming which node answered.
                let document = serde_json::json!({
                    "remote": remote,
                    "peer": status.peer,
                    "kind": status.kind,
                    "version": status.version,
                    "uptime_ms": status.uptime_ms,
                    "clock_synced": status.clock_synced,
                    "health": health,
                    "health_reasons": status.health_reasons,
                    "published": metrics.published,
                    "delivered": metrics.delivered,
                    "dropped": metrics.dropped,
                    "blocked": metrics.blocked,
                    "decode_errors": metrics.decode_errors,
                    "encode_errors": metrics.encode_errors,
                    "peers": metrics.peers,
                });
                println!("{}", serde_json::to_string_pretty(&document)?);
            } else {
                println!(
                    "remote={remote} link peer={} kind={} version={} uptime={}ms \
                     clock_synced={} peers={} published={} delivered={} dropped={} blocked={} \
                     decode_errors={} health={}",
                    status.peer,
                    status.kind,
                    status.version,
                    status.uptime_ms,
                    status.clock_synced,
                    metrics.peers,
                    metrics.published,
                    metrics.delivered,
                    metrics.dropped,
                    metrics.blocked,
                    metrics.decode_errors,
                    health
                );
                if !status.health_reasons.is_empty() {
                    println!("health reasons: {}", status.health_reasons.join(", "));
                }
            }
        }
        Cmd::Topics => {
            let list = link
                .list_topics(Empty {})
                .await
                .with_context(|| format!("ListTopics on {remote}"))?
                .into_inner();
            if list.topics.is_empty() {
                println!("remote={remote}: (no traffic on the daemon's own transport yet)");
            }
            for topic in &list.topics {
                println!("{topic}");
            }
            // Who this inventory is *of*: the daemon's own transport can only enumerate
            // what it saw on that transport (docs/amos-link.md §5) — a board link has no
            // way to list what a remote peer published.
            println!(
                "remote={remote}: {} topic(s) seen by the daemon's transport",
                list.topics.len()
            );
        }
        Cmd::Pub => run_remote_pub(opts, &mut link, &remote).await?,
        Cmd::Watch => run_remote_watch(opts, &mut link, &remote).await?,
        Cmd::Sub | Cmd::Bench | Cmd::Discover => bail!(
            "`{}` needs a local data-plane node, not a control plane: --socket exposes \
             status / topics / pub / watch (drop --socket to run it locally)",
            opts.cmd.key()
        ),
        Cmd::Motor => {
            bail!("`motor` translates JSON into frames offline and needs no link: drop --socket")
        }
    }
    Ok(())
}

/// `pub --socket`: inject a frame through the daemon's node.
///
/// The payload is the same bytes a local publish would put on the wire (the `Message`
/// trait's own encoding, i.e. bincode), so a typed subscriber on the link decodes an
/// injected frame exactly like a native one — the contract `proto/robot_link.proto`
/// states for `Publish`.
async fn run_remote_pub(
    opts: &Opts,
    link: &mut RobotLinkClient<tonic::transport::Channel>,
    remote: &str,
) -> Result<()> {
    let topic = concrete_topic(opts)?;
    let action = payload_of(opts)?;
    let payload = action
        .encode()
        .map_err(|e| anyhow::anyhow!("encoding the payload: {e}"))?;
    let count = opts.count.unwrap_or(1);
    let period = period_of(opts)?;
    for _ in 0..count {
        let reply = link
            .publish(PublishRequest {
                topic: topic.as_str().to_string(),
                payload: payload.clone(),
            })
            .await
            .with_context(|| format!("Publish on {remote}"))?
            .into_inner();
        println!(
            "published via={remote} seq={} topic={} matched={} delivered={} dropped={}",
            reply.seq, topic, reply.matched, reply.delivered, reply.dropped
        );
        if let Some(period) = period {
            tokio::time::sleep(period).await;
        }
    }
    Ok(())
}

/// `watch --socket`: stream the link's heartbeats for `--seconds`.
///
/// The stream is the daemon's `StreamHeartbeats` — what the peers (and the daemon itself)
/// *actually published* on `amos/*/telemetry/beat`, not a synthetic counter. Beats are
/// counted per peer, so "who is beating" is answered by the same run that proves the link
/// is alive.
async fn run_remote_watch(
    opts: &Opts,
    link: &mut RobotLinkClient<tonic::transport::Channel>,
    remote: &str,
) -> Result<()> {
    use std::collections::BTreeMap;

    let seconds = opts.seconds.max(1);
    let mut beats = link
        .stream_heartbeats(Empty {})
        .await
        .with_context(|| format!("StreamHeartbeats on {remote}"))?
        .into_inner();
    println!("remote={remote} watching the link's heartbeats for {seconds}s (StreamHeartbeats)");
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut seen = 0u64;
    let mut per_peer: BTreeMap<String, u64> = BTreeMap::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, beats.message()).await {
            Ok(Ok(Some(beat))) => {
                seen += 1;
                *per_peer.entry(beat.peer.clone()).or_default() += 1;
                if opts.json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "event": "beat",
                            "peer": beat.peer,
                            "seq": beat.seq,
                            "stamp_secs": beat.stamp_secs,
                            "stamp_nanos": beat.stamp_nanos,
                            "uptime_ms": beat.uptime_ms,
                        })
                    );
                } else {
                    println!(
                        "beat peer={} seq={} stamp={}.{} uptime_ms={}",
                        beat.peer, beat.seq, beat.stamp_secs, beat.stamp_nanos, beat.uptime_ms
                    );
                }
            }
            // The server closed the stream (the daemon is shutting down).
            Ok(Ok(None)) => break,
            Ok(Err(e)) => bail!("heartbeat stream failed: {e}"),
            Err(_) => break,
        }
    }
    println!(
        "watched {seconds}s: beats={seen} peers={} ({remote})",
        per_peer.len()
    );
    for (peer, count) in per_peer {
        println!("  {peer}: {count}");
    }
    Ok(())
}

/// Open a gRPC channel to a control plane listening on a Unix socket (the daemon's shape:
/// h2 over UDS, exactly what `amos-tauri` and the workspace's tests speak).
async fn connect_control_plane(
    socket: &Path,
) -> Result<RobotLinkClient<tonic::transport::Channel>> {
    let owned = socket.to_path_buf();
    let endpoint = tonic::transport::Endpoint::try_from("http://[::1]:50051")
        .context("building the control-plane endpoint")?;
    let channel = endpoint
        .connect_with_connector(tower::service_fn(move |_: tonic::transport::Uri| {
            let path = owned.clone();
            async move {
                let stream = tokio::net::UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .with_context(|| {
            format!(
                "connecting to the link control plane at {} (is the daemon running?)",
                socket.display()
            )
        })?;
    Ok(RobotLinkClient::new(channel))
}

/// The wire health enum as the same word the domain layer prints (`unknown`/`healthy`/
/// `degraded`), so a local `status` and a remote `status --socket` read the same.
fn health_label(state: i32) -> &'static str {
    if state == HealthState::HealthHealthy as i32 {
        "healthy"
    } else if state == HealthState::HealthDegraded as i32 {
        "degraded"
    } else {
        // Anything else — including an enum value a newer daemon added and this client does
        // not know — is reported as the absence of a claim, never as health.
        "unknown"
    }
}

/// Build the node the command runs on (in-process broker, or Zenoh with `--transport`).
async fn build_node(opts: &Opts) -> Result<Arc<LinkNode>> {
    let peer = PeerId::new(opts.peer.clone()).context("invalid peer id")?;
    match opts.transport {
        TransportKind::Broker => Ok(LinkNode::in_process(peer, opts.kind)),
        TransportKind::Zenoh => build_zenoh_node(peer, opts.kind).await,
    }
}

#[cfg(feature = "zenoh")]
async fn build_zenoh_node(peer: PeerId, kind: NodeKind) -> Result<Arc<LinkNode>> {
    use amos_link::codec::Clock;
    use amos_link::metrics::LinkMetrics;

    let transport = amos_link::zenoh::ZenohTransport::open()
        .await
        .context("opening the Zenoh session")?
        .shared();
    let metrics = Arc::new(LinkMetrics::new());
    Ok(Arc::new(LinkNode::with_parts(
        peer,
        kind,
        transport,
        Arc::new(Clock::host()),
        metrics,
    )))
}

#[cfg(not(feature = "zenoh"))]
async fn build_zenoh_node(_peer: PeerId, _kind: NodeKind) -> Result<Arc<LinkNode>> {
    bail!(
        "`--transport zenoh` needs the `zenoh` feature (cargo run -p amos-link-cli --features zenoh)"
    )
}

/// The payload a `pub` sends: `--action` (JSON) wins, else `--text`.
fn payload_of(opts: &Opts) -> Result<AgentAction> {
    match (&opts.action, &opts.text) {
        (Some(action), _) => Ok(AgentAction::new(action.clone())),
        (None, Some(text)) => Ok(AgentAction::new(
            serde_json::json!({ "text": text }).to_string(),
        )),
        (None, None) => bail!("`pub` needs --action '<json>' or --text '<string>'"),
    }
}

/// Resolve `--topic` for `pub`/`bench`, refusing a wildcard (a publisher names one topic).
fn concrete_topic(opts: &Opts) -> Result<Topic> {
    let raw = opts
        .topic
        .as_deref()
        .context("this command needs --topic <key expression>")?;
    Topic::new(raw).map_err(|e| anyhow::anyhow!("{e}"))
}

/// Resolve `--pattern` for `sub`, defaulting to every AmOS-Link topic.
fn pattern_of(opts: &Opts) -> Result<Topic> {
    let raw = opts.pattern.as_deref().unwrap_or("amos/**");
    Topic::pattern(raw).map_err(|e| anyhow::anyhow!("{e}"))
}

/// The inter-frame period implied by `--hz` (`None` = as fast as possible).
///
/// Fallible on purpose: `Duration::from_secs_f64` **panics** on a value that overflows a
/// `Duration`, and `--hz 1e-300` is exactly that (a one-char-over-the-line command line
/// crashing the tool is not an acceptable failure mode). The period is checked to be
/// non-zero too, so a rate too high to schedule is refused with a message rather than
/// turned into a busy loop.
fn period_of(opts: &Opts) -> Result<Option<Duration>> {
    let Some(hz) = opts.hz else {
        return Ok(None);
    };
    let seconds = 1.0 / hz.max(f64::MIN_POSITIVE);
    let period = Duration::try_from_secs_f64(seconds).map_err(|e| {
        anyhow::anyhow!(
            "--hz {hz:e} implies a period of {seconds:e}s, which cannot be scheduled: {e}"
        )
    })?;
    if period.is_zero() {
        bail!("--hz {hz:e} implies a period below the timer resolution, which cannot be scheduled");
    }
    Ok(Some(period))
}

/// Receive one frame, honouring `--timeout-ms` (0 = wait forever).
async fn recv_with_timeout(
    subscriber: &mut amos_link::pubsub::Subscriber<AgentAction>,
    timeout_ms: u64,
) -> Result<Option<Received<AgentAction>>> {
    if timeout_ms == 0 {
        return Ok(Some(
            subscriber.recv().await.context("subscription closed")?,
        ));
    }
    match tokio::time::timeout(Duration::from_millis(timeout_ms), subscriber.recv()).await {
        Ok(result) => Ok(Some(result.context("subscription closed")?)),
        Err(_) => Ok(None),
    }
}

/// Print one received frame (a human line, or JSON when `--json`).
fn print_frame(received: &Received<AgentAction>, json: bool) -> Result<()> {
    if json {
        let value = serde_json::json!({
            "topic": received.topic.as_str(),
            "publisher": received.publisher.as_str(),
            "seq": received.seq,
            "age_ms": received.age().as_millis() as u64,
            "frame_len": received.frame_len,
            "json": received.message.json,
        });
        println!("{value}");
        return Ok(());
    }
    println!(
        "{} <- {} seq={} age={}ms len={}B {}",
        received.topic,
        received.publisher,
        received.seq,
        received.age().as_millis(),
        received.frame_len,
        received.message.json
    );
    Ok(())
}

/// One benchmark frame: a fixed-size payload plus its own sequence number.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct BenchFrame {
    seq: u64,
    payload: Vec<u8>,
}

/// Publish `--count` frames on one topic and consume them, reporting real latency.
///
/// The consumer is a buffered *reliable* subscriber, so the numbers are the true
/// end-to-end cost of one publish→decode step rather than a queue-drain artefact; the
/// `dropped` figure is printed so a saturated run is not mistaken for a fast one.
async fn run_bench(node: &Arc<LinkNode>, opts: &Opts) -> Result<()> {
    let count = opts.count.unwrap_or(1000);
    let topic = opts
        .topic
        .clone()
        .unwrap_or_else(|| format!("amos/{}/telemetry/bench", node.peer()));
    let topic = Topic::new(topic).map_err(|e| anyhow::anyhow!("{e}"))?;
    let period = period_of(opts)?;

    let mut subscriber = node
        .subscriber::<BenchFrame>(
            topic.clone(),
            Qos::new(
                amos_link::qos::Reliability::Reliable,
                256,
                amos_link::qos::DropPolicy::DropNewest,
            ),
        )
        .await
        .context("subscribing to the benchmark topic")?;
    let publisher = node.publisher::<BenchFrame>(topic.clone());

    let payload = vec![0xA5u8; opts.size];
    println!(
        "bench peer={} topic={} frames={count} size={}B{}",
        node.peer(),
        topic,
        opts.size,
        match opts.hz {
            Some(hz) => format!(" rate={hz}Hz"),
            None => " rate=unthrottled".to_string(),
        }
    );

    let mut latencies: Vec<u128> = Vec::with_capacity(count as usize);
    let started = Instant::now();
    let mut sequence = 0u64;
    // Publisher-side sequence accounting: `missing` is the frame loss the *link* caused.
    let mut seq = SeqTracker::new();
    // Bounded by `count`: the loop cannot outlive the requested run.
    while sequence < count {
        sequence += 1;
        if publisher
            .publish(&BenchFrame {
                seq: sequence,
                payload: payload.clone(),
            })
            .await
            .is_err()
        {
            break;
        }
        if let Some(period) = period {
            tokio::time::sleep(period).await;
        }
        // Drain what is already there, without ever blocking the publish loop.
        while let Some(received) = subscriber.try_recv()? {
            seq.observe_received(&received);
            latencies.push(received.age().as_micros());
        }
    }
    // Give the last frames a bounded moment to land, then drain once more.
    let deadline = Instant::now() + Duration::from_millis(200);
    while latencies.len() < count as usize && Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(50), subscriber.recv()).await {
            Ok(Ok(received)) => {
                seq.observe_received(&received);
                latencies.push(received.age().as_micros());
            }
            Ok(Err(e)) => {
                tracing::debug!(error = %e, "bench subscription closed");
                break;
            }
            Err(_) => break,
        }
    }

    let elapsed = started.elapsed();
    let stats = subscriber.stats();
    let gaps = seq.summary();
    let throughput = if elapsed.as_secs_f64() > 0.0 {
        publisher.seq() as f64 / elapsed.as_secs_f64()
    } else {
        0.0
    };
    // `missing` is the publisher's own accounting of frames that never arrived — the
    // number that says whether a high `dropped` figure cost the *consumer* anything —
    // and `blocked` is how often this publisher had to wait for a reliable subscriber.
    println!(
        "sent={} received={} dropped={} decode_errors={} blocked={} gaps={} missing={} stale={} \
         elapsed={}ms throughput={throughput:.0} frame/s",
        publisher.seq(),
        latencies.len(),
        stats.dropped,
        stats.decode_errors,
        node.metrics().snapshot().blocked,
        gaps.gaps,
        gaps.missing,
        gaps.stale,
        elapsed.as_millis()
    );
    if !latencies.is_empty() {
        latencies.sort_unstable();
        let pct = |p: usize| -> u128 {
            let index = (latencies.len().saturating_sub(1) * p) / 100;
            latencies[index]
        };
        println!(
            "latency (publish -> decoded, us): min={} p50={} p99={} max={}",
            latencies[0],
            pct(50),
            pct(99),
            latencies[latencies.len() - 1]
        );
    }
    Ok(())
}

/// Run the discovery command: a seeded mock table, real LAN beacons, or the link bus.
async fn run_discover(opts: &Opts) -> Result<()> {
    if opts.lan && opts.bus {
        bail!("`--lan` and `--bus` are two different channels: pick one");
    }
    if opts.lan {
        return run_discover_lan(opts).await;
    }
    if opts.bus {
        return run_discover_bus(opts).await;
    }
    // Offline mode: seed a registry with the operator-specified peers plus this node, so
    // the *table* logic (freshness, TTL, ordering) is visible without a network.
    let mut registry = PeerRegistry::new(Duration::from_secs(3));
    let now = amos_link::codec::Timestamp::now();
    let me = PeerInfo::new(PeerId::new(opts.peer.clone())?, opts.kind);
    registry.learn(me, now);
    for peer in &opts.peers {
        let info = PeerInfo::new(PeerId::new(peer.clone())?, NodeKind::Robot);
        registry.learn(info, now);
    }
    println!(
        "discovery=mock ttl={}ms peers={} (use --lan for real UDP beacons)",
        registry.ttl().as_millis(),
        registry.len()
    );
    print_peers(&registry.peers(now));
    Ok(())
}

/// The announce cadence every CLI command uses when it joins the federation.
///
/// **One rule, one place** (`docs/amos-link.md` §3): a beacon every `TTL/3`, with a
/// 100 ms floor so a tiny TTL cannot turn the announcer into a spin.
///
/// `spawn_federation` enforces the *upper* bound (a period longer than a third of the
/// peer TTL makes every other table see this node appear and expire forever — a
/// flapping link). Announcing **faster** than that is legal but it is wire noise, and
/// it makes this node's own `published` counter read mostly its own beacons: a
/// hard-coded 200 ms used to make `watch` report 6 publishes/s for a 1 Hz heartbeat
/// (1 beat + 5 beacons), which is not what the design record says the CLI does.
fn federation_period(ttl: Duration) -> Duration {
    (ttl / 3).max(Duration::from_millis(100))
}

#[cfg(feature = "lan")]
async fn run_discover_lan(opts: &Opts) -> Result<()> {
    use amos_link::discovery::Discovery;

    let channel = Arc::new(
        amos_link::lan::LanDiscovery::with_defaults()
            .await
            .context("binding the beacon socket")?,
    );
    // Held as the trait object the node would hold: the CLI therefore exercises the same
    // `Discovery` surface a board uses, not just the inherent methods.
    let discovery: &dyn Discovery = channel.as_ref();
    let me = PeerInfo::new(PeerId::new(opts.peer.clone())?, opts.kind);
    let mut registry = PeerRegistry::new(Duration::from_secs(3));
    registry.learn(me.clone(), amos_link::codec::Timestamp::now());
    // Announce for as long as we listen instead of once at startup: a single beacon is
    // found only by a peer that was already listening, which inverts the question this
    // command exists to answer ("who is on this LAN?"). The cadence follows the rule
    // `spawn_federation` enforces — at most a third of the TTL — so the peers we appear
    // to don't see us flap.
    let period = federation_period(registry.ttl());
    let announcer = amos_link::lan::spawn_announcer(Arc::clone(&channel), me, period)
        .context("starting the beacon announcer")?;
    println!(
        "discovery=lan target={} bound={} announce={}ms listening {}s",
        channel.target_addr(),
        channel.bind_addr(),
        period.as_millis(),
        opts.seconds
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(opts.seconds.max(1));
    // Bounded by `--seconds`: it always ends (a discovery sweep, not a daemon).
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline - tokio::time::Instant::now();
        match tokio::time::timeout(remaining, discovery.next_beacon()).await {
            Ok(Ok(beacon)) => {
                let now = amos_link::codec::Timestamp::now();
                if registry.observe(&beacon, now) {
                    println!("+ peer {} ({})", beacon.peer.id, beacon.peer.kind.key());
                }
            }
            Ok(Err(e)) => {
                tracing::debug!(error = %e, "beacon channel ended");
                break;
            }
            Err(_) => break,
        }
    }
    announcer.stop().await;
    print_peers(&registry.peers(amos_link::codec::Timestamp::now()));
    Ok(())
}

#[cfg(not(feature = "lan"))]
async fn run_discover_lan(_opts: &Opts) -> Result<()> {
    bail!("`discover --lan` needs the `lan` feature (cargo run -p amos-link-cli --features lan)")
}

/// `discover --bus`: join the peer federation over the link's own transport and print
/// the table it converges on.
///
/// This is the mode that works on **every** transport: an in-process broker (where a
/// second node in the same process would appear) and, importantly, `--transport zenoh`,
/// where the beacon exchange travels the same path as the robot's data — so a board's
/// peer table is populated without a single extra service or port.
async fn run_discover_bus(opts: &Opts) -> Result<()> {
    let node = build_node(opts).await?;
    let task = node
        .spawn_federation(federation_period(node.peer_ttl()))
        .context("joining the federation")?;
    println!(
        "discovery=bus transport={} peer={} topic=amos/{}/telemetry/beacon listening {}s",
        node.transport_name(),
        node.peer(),
        node.peer(),
        opts.seconds.max(1)
    );
    let deadline = Instant::now() + Duration::from_secs(opts.seconds.max(1));
    // Bounded by `--seconds`: a discovery sweep, not a daemon. It also prints the table
    // *while* it is listening, so an operator sees peers appear instead of a frozen run.
    while Instant::now() < deadline {
        let peers = node.peers().await;
        if !peers.is_empty() {
            println!("peers={}", peers.len());
            print_peers(&peers);
            task.stop().await;
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    task.stop().await;
    println!(
        "no peers announced on this link in {}s (federation still ran: this node \
         published its beacon and filtered its own echo)",
        opts.seconds.max(1)
    );
    print_peers(&node.peers().await);
    Ok(())
}

/// Print a peer table the way an operator reads it.
fn print_peers(peers: &[PeerView]) {
    if peers.is_empty() {
        println!("(no peers)");
        return;
    }
    println!(
        "{:<20} {:<10} {:>10} {:>8}  endpoint",
        "peer", "kind", "seen(ms)", "beacons"
    );
    for peer in peers {
        println!(
            "{:<20} {:<10} {:>10} {:>8}  {}",
            peer.info.id.as_str(),
            peer.info.kind.key(),
            peer.last_seen_ms,
            peer.beacons,
            peer.info.endpoint().unwrap_or("-")
        );
    }
}

/// `watch`: publish this node's heartbeat, join the peer federation, and print the
/// link's liveness once a second for `--seconds`.
///
/// The terminal form of the control plane's `StreamHeartbeats` (with `--socket`, the very
/// same stream — see `run_remote_watch`), with the same honesty rule: the beat count is
/// frames the node **actually received** on `amos/*/telemetry/beat` (never a synthetic
/// tick counter, and the node's own beat is a real frame on the link like any other), and
/// the run is bounded by `--seconds` — a watch that never returns is not debuggable. A
/// clean exit reports “no peers yet” as a fact rather than failing: a lone tool on a quiet
/// link is a normal state, not an error.
///
/// With `--socket` this is also the terminal twin of the System UI's Settings
/// 「机器人链路 / Robot Link」 page (`amos-tauri`'s `link_status` reads the same
/// `GetStatus`): both answer "is the robot on the link" from the *daemon's* node,
/// never from a local demo node.
async fn run_watch(node: &Arc<LinkNode>, opts: &Opts) -> Result<()> {
    let period = DEFAULT_HEARTBEAT_PERIOD;
    let mut beats = node
        .subscriber::<Heartbeat>(heartbeat_pattern()?, Qos::sensor())
        .await
        .context("subscribing to the heartbeat channel")?;
    let heartbeat = node
        .spawn_heartbeat(period)
        .context("starting the heartbeat task")?;
    let federation = node
        .spawn_federation(federation_period(node.peer_ttl()))
        .context("joining the peer federation")?;

    let seconds = opts.seconds.max(1);
    println!(
        "watching transport={} peer={} kind={} beat=amos/{}/telemetry/beat {}s",
        node.transport_name(),
        node.peer(),
        node.kind().key(),
        node.peer(),
        seconds
    );

    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut ticker = tokio::time::interval(period);
    let mut seen = 0u64;
    // Per-publisher beat accounting: a jump in a peer's own heartbeat counter means this
    // node **missed** beats — the liveness view would otherwise show only "some beats".
    let mut beats_seq = SeqTracker::new();
    // Bounded by `--seconds`: an inspection window, not a daemon.
    while Instant::now() < deadline {
        tokio::select! {
            received = beats.recv() => {
                let received = received.context("the heartbeat subscription closed")?;
                seen += 1;
                // Measured before the payload is moved out of the frame.
                let age_ms = received.age().as_millis();
                let missed = match beats_seq.observe_received(&received) {
                    SeqEvent::Gap { missing, .. } => missing,
                    _ => 0,
                };
                let beat: Heartbeat = received.message;
                if opts.json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "event": "heartbeat",
                            "peer": beat.peer.as_str(),
                            "seq": beat.seq,
                            "uptime_ms": beat.uptime_ms,
                            "age_ms": age_ms,
                            "missed": missed,
                        })
                    );
                } else {
                    println!(
                        "beat  peer={} seq={} uptime={}ms age={}ms missed={}",
                        beat.peer, beat.seq, beat.uptime_ms, age_ms, missed
                    );
                }
            }
            _ = ticker.tick() => {
                let status = node.status().await;
                let metrics = status.metrics;
                let beats_missing = beats_seq.summary().missing;
                // The node's verdict, enriched with what only this subscriber can see: the
                // gaps in the beats it actually received. Frame loss is consumer-side
                // evidence, so a bare `status` cannot include it (see `health` docs).
                let health = LinkHealth::evaluate(
                    &metrics,
                    &status.peers,
                    status.clock_synced,
                    Some(&beats_seq.summary()),
                );
                if opts.json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "event": "status",
                            "peer": status.peer.as_str(),
                            "uptime_ms": status.uptime_ms,
                            "clock_synced": status.clock_synced,
                            "published": metrics.published,
                            "delivered": metrics.delivered,
                            "dropped": metrics.dropped,
                            "blocked": metrics.blocked,
                            "decode_errors": metrics.decode_errors,
                            "encode_errors": metrics.encode_errors,
                            "peers": status.peers.len(),
                            "beats_seen": seen,
                            "beats_missing": beats_missing,
                            "health": health.label(),
                            "health_reasons": health
                                .reasons()
                                .iter()
                                .map(amos_link::health::HealthReason::detail)
                                .collect::<Vec<String>>(),
                        })
                    );
                } else {
                    println!(
                        "link  peer={} uptime={}ms clock_synced={} peers={} published={} \
                         delivered={} dropped={} blocked={} decode_errors={} beats_seen={} \
                         beats_missing={} health={}",
                        status.peer,
                        status.uptime_ms,
                        status.clock_synced,
                        status.peers.len(),
                        metrics.published,
                        metrics.delivered,
                        metrics.dropped,
                        metrics.blocked,
                        metrics.decode_errors,
                        seen,
                        beats_missing,
                        health.summary()
                    );
                }
            }
        }
    }

    heartbeat.stop().await;
    federation.stop().await;
    let status = node.status().await;
    println!(
        "watched {}s: beats_published={} beats_seen={} beats_missing={} peers={} dropped={} \
         decode_errors={}",
        seconds,
        node.heartbeat_seq(),
        seen,
        beats_seq.summary().missing,
        status.peers.len(),
        status.metrics.dropped,
        status.metrics.decode_errors
    );
    Ok(())
}

/// The pure command: agent JSON → validated intent → motor frames → the mock bus.
async fn run_motor(opts: &Opts) -> Result<()> {
    let action = opts
        .action
        .as_deref()
        .context("`motor` needs --action '<json>'")?;
    let command = parse_command(action).map_err(|e| anyhow::anyhow!("{e}"))?;
    let frames = plan(&command);
    println!(
        "action={} gait={} speed={} duration_ms={} frames={}",
        action,
        command.gait.key(),
        command.speed,
        command.duration_ms,
        frames.len()
    );
    for frame in &frames {
        println!("{}", render_frame(frame));
    }
    // Write them to the mock bus, so the reported line comes from a real apply() path.
    let hal = MockRobotHal::new();
    let applied = hal
        .apply(&frames)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!(
        "applied {applied} frame(s) to hal={} armed={}",
        hal.name(),
        hal.armed()
    );
    Ok(())
}

/// One motor frame as a bus log line: `joint op arg hex`.
fn render_frame(frame: &MotorFrame) -> String {
    format!(
        "joint={:>2} leg={} part={} op={:?} arg={:>7} hex={}",
        frame.joint.index(),
        frame.joint.leg(),
        frame.joint.part(),
        frame.op,
        frame.arg,
        frame.encode_hex()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commands_and_options() {
        let o = parse_from([
            "pub",
            "--topic",
            "amos/dog1/control/joints",
            "--action",
            r#"{"action":"trot"}"#,
            "--count",
            "3",
            "--hz",
            "50",
            "--qos",
            "control",
            "--peer",
            "dog1",
            "--kind",
            "robot",
        ])
        .expect("parse");
        assert_eq!(o.cmd, Cmd::Pub);
        assert_eq!(o.peer, "dog1");
        assert_eq!(o.kind, NodeKind::Robot);
        assert_eq!(o.topic.as_deref(), Some("amos/dog1/control/joints"));
        assert_eq!(o.count, Some(3));
        assert_eq!(o.hz, Some(50.0));
        assert_eq!(o.qos, Some(Qos::control()));
        assert!(!o.help);

        assert_eq!(parse_from(["status"]).expect("status").cmd, Cmd::Status);
        assert_eq!(parse_from(["topics"]).expect("topics").cmd, Cmd::Topics);
        assert_eq!(
            parse_from(["sub", "--pattern", "amos/**"])
                .expect("sub")
                .cmd,
            Cmd::Sub
        );
        assert_eq!(parse_from(["bench"]).expect("bench").cmd, Cmd::Bench);
        assert_eq!(parse_from(["watch"]).expect("watch").cmd, Cmd::Watch);
        assert!(
            parse_from(["discover", "--lan", "--seconds", "1"])
                .expect("discover")
                .lan
        );
        // `--socket` switches the same verb onto a *running* node's control plane.
        let remote =
            parse_from(["status", "--socket", "/tmp/amos-ai.sock", "--json"]).expect("remote");
        assert_eq!(
            remote.socket.as_deref(),
            Some(Path::new("/tmp/amos-ai.sock"))
        );
        assert!(remote.json);
        assert!(
            parse_from(["status"]).expect("local").socket.is_none(),
            "no socket means a local node"
        );
    }

    #[test]
    fn one_federation_cadence_governs_every_command() {
        // The documented rule (docs/amos-link.md §3): a beacon every TTL/3.
        // `PeerRegistry::DEFAULT_TTL` is 3 s ⇒ a 1 s cadence.
        assert_eq!(
            federation_period(Duration::from_secs(3)),
            Duration::from_secs(1)
        );
        assert_eq!(
            federation_period(Duration::from_secs(9)),
            Duration::from_secs(3)
        );
        // …and the result is a period `spawn_federation` accepts (it refuses
        // `period * 3 > ttl`, i.e. announcing so rarely that peers flap).
        for ttl in [
            Duration::from_secs(3),
            Duration::from_secs(9),
            Duration::from_secs(1),
        ] {
            let period = federation_period(ttl);
            assert!(
                period.saturating_mul(3) <= ttl,
                "ttl={ttl:?} produced an illegal period {period:?}"
            );
        }
        // A degenerate TTL cannot make the announcer spin: the 100 ms floor wins, and
        // such a TTL is not one any CLI path uses (they all run a 3 s registry) —
        // `spawn_federation` would refuse the result loudly rather than spin.
        assert_eq!(
            federation_period(Duration::from_millis(30)),
            Duration::from_millis(100)
        );
        assert_eq!(
            federation_period(Duration::ZERO),
            Duration::from_millis(100)
        );
    }

    #[test]
    fn defaults_are_command_aware() {
        // A bench/tool node is not a robot: the implied identity says what it is.
        assert_eq!(parse_from(["bench"]).expect("bench").peer, "link-bench");
        assert_eq!(parse_from(["watch"]).expect("watch").peer, "link-watch");
        assert_eq!(parse_from(["motor"]).expect("motor").peer, "motor-tool");
        assert_eq!(parse_from(["status"]).expect("status").peer, "amos-node");
        assert_eq!(parse_from(["bench"]).expect("bench").size, 1024);
        assert_eq!(parse_from(["discover"]).expect("discover").seconds, 3);
        // `--peer` wins over the implied default.
        assert_eq!(
            parse_from(["bench", "--peer", "cam-front"])
                .expect("bench")
                .peer,
            "cam-front"
        );
    }

    #[test]
    fn version_flag_is_global_and_needs_no_command() {
        // A released artifact must say what it is (scripts/release-artifacts.sh checks
        // `--version` on every staged binary), so it must not require a subcommand.
        assert!(parse_from(["--version"]).expect("v").version);
        assert!(parse_from(["-V"]).expect("v").version);
        assert!(parse_from(["status", "-V"]).expect("v").version);
        assert!(!parse_from(["status"]).expect("v").version);
    }

    #[test]
    fn help_and_unknown_arguments_are_rejected_clearly() {
        assert!(parse_from(["-h"]).expect("help").help);
        assert!(parse_from(["frobnicate"]).is_err(), "unknown command");
        assert!(parse_from(["--peer"]).is_err(), "option without a value");
        assert!(parse_from(["--socket"]).is_err(), "option without a value");
        assert!(
            parse_from(["--count", "many"]).is_err(),
            "non-numeric count"
        );
        assert!(parse_from(["--hz", "0"]).is_err(), "zero rate");
        assert!(parse_from(["--size", "x"]).is_err(), "non-numeric size");
        assert!(parse_from(["--kind", "wizard"]).is_err(), "unknown kind");
        assert!(parse_from(["--qos", "turbo"]).is_err(), "unknown qos");
        assert!(
            parse_from(["--transport", "carrier-pigeon"]).is_err(),
            "unknown transport"
        );
        // A second positional command is a typo, not a request to run two things.
        assert!(parse_from(["status", "topics"]).is_err());
    }

    #[test]
    fn help_text_documents_every_flag_the_parser_accepts() {
        for flag in [
            "--peer",
            "--kind",
            "--transport",
            "--topic",
            "--pattern",
            "--action",
            "--text",
            "--count",
            "--hz",
            "--size",
            "--qos",
            "--lan",
            "--seconds",
            "--json",
            "--help",
            "--version",
        ] {
            assert!(
                USAGE.contains(flag),
                "{flag} is accepted by the parser but missing from USAGE"
            );
        }
        for command in [
            "status", "topics", "pub", "sub", "bench", "discover", "watch", "motor",
        ] {
            assert!(USAGE.contains(command), "{command} is missing from USAGE");
        }
    }
}
