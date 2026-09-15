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
//!
//! Every command also takes `--json` (one document per result, or one object per line where
//! the command streams), and **no flag is silently ignored**: a flag a command cannot act on
//! is refused with exit 2 by [`check_flag_scope`], naming both — an operator who typed
//! `bench --pattern 'amos/**'` was told a pattern filtered something that never did.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use amos_link::codec::{Envelope, Message};
use amos_link::discovery::{FederationTask, NodeKind, PeerId, PeerInfo, PeerRegistry, PeerView};
use amos_link::health::LinkHealth;
use amos_link::keyexpr::{Channel, Topic};
use amos_link::node::LinkNode;
use amos_link::pubsub::Received;
use amos_link::qos::Qos;
use amos_link::rate::{RateTracker, StreamRate};
use amos_link::robot_hal::{
    actuation_pattern, parse_command, plan, ActuationState, AgentAction, EstopReason, Gait,
    MockRobotHal, MotorFrame, Refusal, RobotHal, StreamRobotHal,
};
use amos_link::sequence::{SeqEvent, SeqTracker, StreamKey};
use amos_link::telemetry::{heartbeat_pattern, Heartbeat, DEFAULT_HEARTBEAT_PERIOD};
use amos_proto::amos_link::robot_link_client::RobotLinkClient;
use amos_proto::amos_link::{
    Actuation as ProtoActuation, Empty, HealthState, LinkStatus, Peer as ProtoPeer, PublishRequest,
    TopicList,
};
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
    amos-link-cli motor --action <JSON> --device <PATH>
                           …and write those frames to a real motor bus
    amos-link-cli state [--pattern <P>]       What robots report about themselves (default:
                           amos/*/state/actuation): armed / e-stopped / gait / refusals
    amos-link-cli hz    [--pattern <P>]       The arrival rate of every stream matching a pattern
                           (default: amos/**), printed every second — the 'is this stream still
                           running at its rate?' instrument. A stream with too little evidence
                           reports *why* there is no rate, never `0 Hz`

OPTIONS:
        --peer <ID>        This node's id (default: amos-node; $AMOS_LINK_PEER)
        --static <ID>      `discover`: seed a known peer (repeatable)
        --kind <KIND>      robot | brain | sensor | actuator | tool (default: tool)
        --transport <T>    broker (default) | zenoh (needs the `zenoh` feature)
        --topic <T>        Concrete topic for `pub`/`bench`
        --pattern <P>      Subscription pattern for `sub`/`state`/`hz`
        --action <JSON>    The agent's JSON action (`pub`, `motor`)
        --text <S>         Plain-text payload for `pub` (a JSON action shortcut)
        --count <N>        Frames to publish/subscribe/bench (default 1 / 1 / 1000);
                           `--count 0` is refused: a run that neither publishes nor waits
        --hz <R>           Publish rate for `pub`/`bench` (default: as fast as possible)
        --size <B>         `bench` payload size in bytes (default: 1024)
        --qos <Q>          sensor | state | control (default: the pattern's channel, else sensor)
        --lan              `discover`: use real UDP beacons (needs the `lan` feature)
        --bus              `discover`: federate over the link transport (beacons on the
                           link itself; with --transport zenoh this is the real LAN table)
        --seconds <N>      `discover`/`watch`/`hz`: how long to listen/measure (default: 3)
        --timeout-ms <N>   `sub`: give up after N ms (default 0 = wait forever)
        --socket <PATH>    Address the daemon's LIVE control plane on this Unix socket
                           instead of a local node: status / topics / pub / watch read the
                           running robot (`sub`/`bench`/`discover`/`state`/`hz` need a local
                           node and are refused by name)
        --device <PATH>    `motor`: write the frames to a *real* bus instead of the mock —
                           a Unix socket a motor controller listens on, or a character
                           device (a serial/UART port; configure it first, e.g.
                           `stty -F /dev/ttyUSB0 1M raw`). Frames leave as CRC16-checked
                           motor frames, and the count printed is the count written.
        --endpoint <EP>    `watch` / `discover --lan|--bus`: **announce where this node can
                           be reached** (the beacon's endpoint list). Repeatable, and
                           comma-separated within one value:
                           `--endpoint tcp/10.0.0.7:7447,udp/239.0.0.1:7446`.
                           A beacon is a connect hint, so this is what the peer tables of
                           every other node show for this one (their `endpoint` column /
                           `status --socket --json`). Bounded exactly like the beacon: at
                           most 8 endpoints, at most 128 bytes each, and the whole frame
                           must fit in 512 bytes — a value that cannot be emitted is a
                           usage error here, never an invisible node. Omitted/empty ⇒ this
                           node advertises no address (the default, and the only sound
                           choice for a transport that self-discovers).
        --json             Every command: machine-readable output instead of prose — one
                           JSON document per result, or one JSON object per line for the
                           commands that stream (`sub`, `state`, `watch`)
    -h, --help             Print this help and exit
    -V, --version          Print version and exit

FLAGS ARE SCOPED TO THE COMMAND THAT ACTS ON THEM:
    A flag a command cannot act on is a usage error (exit 2) that names both, never a
    silently ignored argument — `bench --pattern 'amos/**'` filtered nothing, and
    `sub --hz 5` throttled nothing, so both are refused instead of quietly doing
    something else. `--json`, `-h/--help` and `-V/--version` are the exceptions: they mean
    the same thing everywhere, so every command honors them.
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
    /// Watch what robots report about themselves on `amos/<robot>/state/actuation`.
    State,
    /// Measure the arrival rate of every stream matching a pattern.
    Hz,
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
            Cmd::State => "state",
            Cmd::Hz => "hz",
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
    /// `motor`: write the frames to this real bus (a Unix socket or a character device)
    /// instead of the mock (`None` = mock).
    pub device: Option<PathBuf>,
    /// The endpoints this node **announces** (`watch`/`discover --lan|--bus`), already parsed
    /// and bounded by [`parse_endpoints`](amos_link::discovery::parse_endpoints). Empty ⇒ this
    /// node advertises no address, which is the default of every node and the only sound
    /// choice for a transport that self-discovers.
    pub endpoints: Vec<String>,
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
            device: None,
            endpoints: Vec::new(),
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
    // The flags this command line actually set. Presence cannot be read back off `Opts`:
    // `--size 1024` / `--seconds 3` / `--timeout-ms 0` are indistinguishable from their
    // defaults, and the scope check below is about what the *operator typed*.
    let mut given: Vec<&'static str> = Vec::new();

    while let Some(arg) = args.next() {
        let mut value = |name: &str| -> Result<String, String> {
            args.next()
                .ok_or_else(|| format!("{name} requires a value"))
        };
        match arg.as_str() {
            "-h" | "--help" => opts.help = true,
            "-V" | "--version" => opts.version = true,
            "status" | "topics" | "pub" | "sub" | "bench" | "discover" | "watch" | "motor"
            | "state" | "hz"
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
                    "state" => Cmd::State,
                    "hz" => Cmd::Hz,
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
            "--device" => opts.device = Some(PathBuf::from(value("--device")?)),
            // Repeatable, and each value may itself be a comma-separated list: the whole
            // combined advertisement is parsed and bounded once, below, so `--endpoint a
            // --endpoint b …` cannot slip past a per-value bound.
            "--endpoint" => opts.endpoints.push(value("--endpoint")?),
            other => return Err(format!("unknown argument: {other}")),
        }
        if let Some(flag) = FLAGS.iter().copied().find(|flag| *flag == arg.as_str()) {
            given.push(flag);
        }
    }

    let cmd = cmd.unwrap_or(Cmd::Status);
    // Two argument checks that must happen *before* a run starts, because both used to end
    // in a panic or an abort instead of a message:
    //
    //  * a window the platform clock cannot represent (`Instant + Duration` panics) — the
    //    run loops build their deadlines through `deadline_after`, so the bound is defined
    //    in exactly one place;
    //  * a `--size` above the wire ceiling, which no run could ever publish.
    deadline_after(Duration::from_secs(opts.seconds)).map_err(|e| e.to_string())?;
    if opts.size > MAX_BENCH_PAYLOAD {
        return Err(format!(
            "--size {} exceeds the {MAX_BENCH_PAYLOAD}-byte ceiling: a bench payload above it \
             builds a frame that every publish would refuse (the wire ceiling is {} bytes)",
            opts.size,
            amos_link::codec::MAX_PAYLOAD_BYTES
        ));
    }
    // A second positional command is a typo, not a request to run two things.
    opts.cmd = cmd;
    opts.peer = resolve_peer(opts.peer, cmd);
    // Every flag this command line set must be one the command actually acts on (`--device`
    // was the first flag with this rule; see `check_flag_scope`).
    check_flag_scope(cmd, &given, opts.socket.is_some(), opts.bus, opts.lan)?;
    // The advertisement is resolved and bounded **here** (exit 2), for the commands that
    // announce this node: `--endpoint` values plus `$AMOS_LINK_ENDPOINT`, as one list, with
    // the beacon's own bounds (`parse_endpoints`). A command that never announces does not
    // read the variable at all — a deployment's `AMOS_LINK_ENDPOINT` must not be able to fail
    // a `status` (the same rule `AMOS_LINK_BEACON_IFACE` follows).
    if honors(cmd, "--endpoint") {
        opts.endpoints = resolve_endpoints(opts.endpoints)?;
    }
    // `--count 0` is not "publish nothing quietly": `pub --count 0` printed *no line at all*
    // and exited 0, which is indistinguishable from a run that published and reported
    // nothing, and `sub --count 0` announced it was "waiting for 0 frame(s)". A run that can
    // neither publish nor wait is a typo, so it is refused here (exit 2) rather than run.
    if opts.count == Some(0) {
        return Err(format!(
            "--count 0 would leave `{}` with nothing to do: give a positive count (a run \
             that neither publishes nor waits cannot report anything either)",
            cmd.key()
        ));
    }
    Ok(opts)
}

/// Every flag the parser accepts. One list, so the parser and [`check_flag_scope`] cannot
/// drift: a flag the parser accepts but this list omits would be *silently ignored* — the
/// exact failure that rule exists to prevent. `-h/--help` and `-V/--version` are not here:
/// they are resolved before a command is.
pub const FLAGS: &[&str] = &[
    "--peer",
    "--static",
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
    "--bus",
    "--seconds",
    "--timeout-ms",
    "--json",
    "--socket",
    "--device",
    "--endpoint",
];

/// Does `cmd` act on `flag`? The single home of the answer.
///
/// The failure this encodes is silent by construction: `bench --pattern 'amos/**'` *runs*,
/// so an operator who typed it believes a pattern filtered something. Refusing it is the
/// only honest outcome — the same rule `--device` has always had (it writes real motor
/// frames, so it belongs to `motor` alone).
fn honors(cmd: Cmd, flag: &str) -> bool {
    match flag {
        // Meaning the same thing everywhere: every command honors these, so they are never
        // refused (and every command therefore has a machine-readable form).
        "--json" => true,
        // `--socket` selects *remote mode*, and run time — not this table — decides what a
        // remote run can do: the four control-plane verbs read the daemon's node, the
        // data-plane ones are refused by name (`run_remote`, exit 1). That refusal is a
        // capability statement, not a misspelling of another command's flag, which is what
        // this table is for — so the parser accepts it and `check_flag_scope` skips it.
        "--socket" => true,
        // The node's own identity — meaningless only for `motor`, which builds no node.
        "--peer" | "--kind" | "--transport" => cmd != Cmd::Motor,
        "--static" => cmd == Cmd::Discover,
        "--topic" => matches!(cmd, Cmd::Pub | Cmd::Bench),
        "--pattern" => matches!(cmd, Cmd::Sub | Cmd::State | Cmd::Hz),
        "--action" => matches!(cmd, Cmd::Pub | Cmd::Motor),
        "--text" => cmd == Cmd::Pub,
        "--count" => matches!(cmd, Cmd::Pub | Cmd::Sub | Cmd::Bench | Cmd::State),
        "--hz" => matches!(cmd, Cmd::Pub | Cmd::Bench),
        "--size" => cmd == Cmd::Bench,
        "--qos" => matches!(cmd, Cmd::Sub | Cmd::State | Cmd::Hz),
        "--lan" | "--bus" => cmd == Cmd::Discover,
        "--seconds" => matches!(cmd, Cmd::Discover | Cmd::Watch | Cmd::Hz),
        "--timeout-ms" => matches!(cmd, Cmd::Sub | Cmd::State),
        // Writes real motor frames, so it belongs to `motor` alone (the rule this whole
        // table generalizes).
        "--device" => cmd == Cmd::Motor,
        // What this node *says about itself* when it announces: only the commands that run a
        // broadcast/federation can act on it. A `status`/`pub` node never announces anything,
        // so an advertisement there would be accepted and dropped — the failure this table
        // exists to refuse.
        "--endpoint" => matches!(cmd, Cmd::Discover | Cmd::Watch),
        _ => false,
    }
}

/// Who a flag belongs to, for the refusal message (an operator needs the fix, not the rule).
fn flag_owners(flag: &str) -> &'static str {
    match flag {
        "--json" => "every command",
        "--peer" | "--kind" | "--transport" => "every command that has a node",
        "--static" => "`discover`",
        "--topic" => "`pub` and `bench`",
        "--pattern" => "`sub`, `state` and `hz`",
        "--action" => "`pub` and `motor`",
        "--text" => "`pub`",
        "--count" => "`pub`, `sub`, `bench` and `state`",
        "--hz" => "`pub` and `bench`",
        "--size" => "`bench`",
        "--qos" => "`sub`, `state` and `hz`",
        "--lan" | "--bus" => "`discover`",
        "--seconds" => "`discover`, `watch` and `hz`",
        "--timeout-ms" => "`sub` and `state`",
        "--device" => "`motor`",
        "--endpoint" => "`discover` and `watch`",
        // Only reached if the parse-time rule ever changes: run time refuses `--socket` on a
        // data-plane command instead of this table.
        "--socket" => "`status`, `topics`, `pub` and `watch`",
        _ => "no command",
    }
}

/// Refuse a flag the command cannot act on — a *usage* error (exit 2), never a silent no-op.
///
/// Three shapes are checked, all of them reachable by hand:
///
///  * the flag belongs to another command (`bench --pattern`, `sub --hz`);
///  * the flag configures *this* process's node, but a `--socket` run reads the **daemon's**
///    — `status --socket X --peer dog1` looks like a filter and filters nothing (the
///    daemon's identity, transport and clock are what answer), so it is refused instead;
///  * `discover --transport` only selects the link `--bus` federates over; a `--lan` or
///    offline sweep travels UDP beacons / a seeded table, not the link transport;
///  * `discover --endpoint` is an **announcement**, so it needs a sweep that announces: the
///    offline mode seeds a table of peers you name and says nothing about this node.
fn check_flag_scope(
    cmd: Cmd,
    given: &[&str],
    remote: bool,
    bus: bool,
    lan: bool,
) -> Result<(), String> {
    for flag in given {
        // `--socket` is resolved by mode at run time (see `honors`), not by command here.
        if *flag == "--socket" {
            continue;
        }
        if !honors(cmd, flag) {
            return Err(format!(
                "{flag} is not a `{}` flag: it belongs to {}",
                cmd.key(),
                flag_owners(flag)
            ));
        }
        if remote && matches!(*flag, "--peer" | "--kind" | "--transport" | "--endpoint") {
            return Err(format!(
                "{flag} configures *this* process's node, but --socket reads the running \
                 daemon's: its identity and transport are what answer and cannot be set \
                 from here (drop {flag}, or drop --socket to run a local `{}`)",
                cmd.key()
            ));
        }
        if *flag == "--transport" && cmd == Cmd::Discover && !bus {
            return Err(
                "--transport selects the link that `discover --bus` federates over; this \
                 sweep is offline/`--lan` (add --bus, or drop --transport)"
                    .to_string(),
            );
        }
        if *flag == "--endpoint" && cmd == Cmd::Discover && !(bus || lan) {
            return Err(
                "--endpoint is announced by a federating sweep: the offline `discover` seeds \
                 a table of peers you name and announces nothing about this node (add --lan \
                 or --bus, or drop --endpoint)"
                    .to_string(),
            );
        }
    }
    Ok(())
}

/// Largest `bench --size` that can actually be published.
///
/// A bench frame is `{seq: u64, payload: Vec<u8>}` — a few bytes of bincode framing around
/// the payload — and the wire ceiling is
/// [`MAX_PAYLOAD_BYTES`](amos_link::codec::MAX_PAYLOAD_BYTES). A larger `--size` would build
/// a message every single publish then refuses, so the *argument* is refused up front (exit
/// 2) instead: the CLI must never spend a run proving that a frame cannot exist. The `- 64`
/// covers the framing of that struct with a margin.
pub const MAX_BENCH_PAYLOAD: usize = amos_link::codec::MAX_PAYLOAD_BYTES - 64;

/// How many latency samples `bench` reserves up front.
///
/// `--count` is a `u64` off a command line, and `Vec::with_capacity(count as usize)` with a
/// huge count **aborts the process** ("capacity overflow"): an operator typo must not kill
/// the tool. The vector still grows to whatever the run actually collects; this is only how
/// much is reserved before the first frame arrives.
pub const LATENCY_RESERVE: usize = 4_096;

/// `Instant::now() + period`, or a refusal — **never** an overflow panic.
///
/// `Instant` addition panics on overflow ("overflow when adding duration to instant"), and
/// `--seconds` is a `u64` straight from the command line: `--seconds 18446744073709551615`
/// used to abort the process. The parser refuses such a window (exit 2) through this same
/// helper, so a caller that builds [`Opts`] programmatically cannot panic the tool either.
fn deadline_after(period: Duration) -> Result<Instant> {
    Instant::now().checked_add(period).ok_or_else(|| {
        anyhow::anyhow!(
            "a window of {}s is beyond what this platform's clock can represent",
            period.as_secs()
        )
    })
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
        Cmd::State => "link-state".to_string(),
        _ => "amos-node".to_string(),
    }
}

/// Resolve the advertisement this node will announce: the `--endpoint` values (each of which
/// may be a comma-separated list) plus `$AMOS_LINK_ENDPOINT` when the flag said nothing.
///
/// One list, one parse, one set of bounds ([`parse_endpoints`](amos_link::discovery::parse_endpoints)):
/// the beacon's own per-field ceilings, reported as a *usage* error (exit 2) — a typo in an
/// address must not become a node that is invisible on the link because its beacons cannot be
/// encoded. The frame-level bound (the beacon must fit in `MAX_BEACON_BYTES`) is asked where
/// the beacon is built (`PeerInfo::advertising` / `spawn_federation_advertising`), because it
/// depends on the id and role travelling with it.
///
/// The environment variable is read only by the commands that announce (see the caller):
/// `watch` and `discover --lan|--bus`. A `status` that reads it would let a deployment
/// variable break a command that has nothing to announce.
fn resolve_endpoints(cli: Vec<String>) -> Result<Vec<String>, String> {
    let mut raw = cli;
    if raw.is_empty() {
        if let Ok(env) = std::env::var("AMOS_LINK_ENDPOINT") {
            raw.push(env);
        }
    }
    let combined = raw.join(",");
    amos_link::discovery::parse_endpoints(&combined).map_err(|e| e.to_string())
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
            if opts.json {
                // The inventory *and* its limit travel together in one document: a script
                // that reads only the array would otherwise read a truncated list as the
                // whole truth (the same rule the human line states in words).
                println!(
                    "{}",
                    serde_json::json!({ "topics": topics, "complete": complete })
                );
            } else {
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
                if opts.json {
                    // One object per frame, so a throttled multi-frame publish stays a line
                    // stream a script can read as it arrives.
                    println!(
                        "{}",
                        serde_json::json!({
                            "event": "published",
                            "seq": publisher.seq(),
                            "topic": topic.as_str(),
                            "matched": report.matched,
                            "delivered": report.delivered,
                            "dropped": report.dropped,
                            "blocked": report.blocked,
                        })
                    );
                } else {
                    println!(
                        "published seq={} topic={} matched={:?} delivered={} dropped={} blocked={}",
                        publisher.seq(),
                        topic,
                        report.matched,
                        report.delivered,
                        report.dropped,
                        report.blocked
                    );
                }
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
            let (qos, source) = subscription_qos(&pattern, opts.qos, None);
            let mut subscriber = node
                .subscriber::<AgentAction>(pattern.clone(), qos)
                .await
                .with_context(|| format!("subscribing to {pattern}"))?;
            let count = opts.count.unwrap_or(1);
            // Every line of a `--json` run is one JSON object *with an event tag*, including
            // the three that used to be prose: the header ("what am I subscribing to"), the
            // timeout and the closing stats. The human form is byte-for-byte what it was.
            if opts.json {
                println!(
                    "{}",
                    serde_json::json!({
                        "event": "subscribed",
                        "peer": node.peer().as_str(),
                        "pattern": pattern.as_str(),
                        "qos": {
                            "reliability": qos.reliability.key(),
                            "drop_policy": qos.drop_policy.key(),
                            "depth": qos.depth(),
                        },
                        "from": source,
                        "waiting_for": count,
                        // The caveat `Received::age()`'s own doc promises "beside it": every
                        // `age_ms` on the lines below is measured against **this** clock, so an
                        // uncalibrated one makes them bounds, not measurements.
                        "clock_synced": node.clock().synced(),
                    })
                );
            } else {
                println!(
                    "subscribed peer={} pattern={} qos={}/{} from {} (waiting for {count} frame(s)){}",
                    node.peer(),
                    pattern,
                    qos.reliability.key(),
                    qos.drop_policy.key(),
                    source,
                    clock_caveat(node.clock().synced())
                );
            }
            // One tracker for the whole run: per-publisher gaps are reported at the end.
            let mut seq = SeqTracker::new();
            for _ in 0..count {
                let received = match recv_with_timeout(&mut subscriber, opts.timeout_ms).await? {
                    Some(frame) => frame,
                    None => {
                        if opts.json {
                            println!(
                                "{}",
                                serde_json::json!({
                                    "event": "timeout",
                                    "timeout_ms": opts.timeout_ms,
                                    "received": subscriber.stats().received,
                                    "waiting_for": count,
                                })
                            );
                        } else {
                            println!(
                                "timeout after {}ms with no frame (received {})",
                                opts.timeout_ms,
                                subscriber.stats().received
                            );
                        }
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
            let blocked = node.metrics().snapshot().blocked;
            let tracking = if seq.is_complete() {
                "complete"
            } else {
                "full"
            };
            let loss = f64::from(gaps.loss_ratio()) * 100.0;
            if opts.json {
                // The closing line carries the totals **and** their attribution: one object,
                // so a script never has to join a stats line with the `lost` lines under it.
                println!(
                    "{}",
                    serde_json::json!({
                        "event": "stats",
                        "received": stats.received,
                        "dropped": stats.dropped,
                        "decode_errors": stats.decode_errors,
                        "blocked": blocked,
                        "streams": gaps.streams,
                        "gaps": gaps.gaps,
                        "missing": gaps.missing,
                        "stale": gaps.stale,
                        "untracked": gaps.untracked,
                        "tracking": tracking,
                        "loss_percent": loss,
                        "lost": loss_streams_json(&seq.streams_with_loss()),
                    })
                );
            } else {
                println!(
                    "stats received={} dropped={} decode_errors={} blocked={} streams={} gaps={} \
                     missing={} stale={} untracked={} tracking={} loss={:.2}%",
                    stats.received,
                    stats.dropped,
                    stats.decode_errors,
                    blocked,
                    gaps.streams,
                    gaps.gaps,
                    gaps.missing,
                    gaps.stale,
                    gaps.untracked,
                    // The loss figure describes only the streams that were tracked
                    // (`MAX_TRACKED_STREAMS`); when the table filled up, this says so instead of
                    // presenting a clean number that stopped accounting.
                    tracking,
                    loss
                );
                // The stats line prints the *totals*; these lines say **which** stream they came from
                // (a wildcard pattern can cover dozens, and "is it the IMU or the camera?" is the
                // question an operator actually has).
                for line in loss_stream_lines(&seq.streams_with_loss()) {
                    println!("{line}");
                }
            }
        }
        Cmd::Bench => run_bench(&node, &opts).await?,
        Cmd::State => run_state(&node, &opts).await?,
        Cmd::Hz => run_hz(&node, &opts).await?,
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
            // The inventory travels with the status document because a local `status` carries it:
            // without this call the remote document would be missing two keys a local one has, and
            // "the same command" would mean two documents again.
            let topics = link
                .list_topics(Empty {})
                .await
                .with_context(|| format!("ListTopics on {remote}"))?
                .into_inner();
            // What the robots say about themselves, folded by the daemon (`ListActuations`):
            // the return path, read from the control plane instead of the data plane.
            //
            // **A daemon that predates this RPC must not take the whole command down.** The
            // status, the peer table and the inventory all *were* answered; `None` here says
            // 「this daemon does not answer the return-path question」, which is a different
            // fact from 「nobody has reported」 (`Some(vec![])`) — the same distinction the
            // System UI's page carries (see `amos-tauri/src/link.rs`). Any *other* failure
            // stays loud: a daemon that has the RPC and cannot serve it is a real fault.
            let robots: Option<Vec<(String, ActuationState, u64)>> =
                match link.list_actuations(Empty {}).await {
                    Ok(list) => Some(
                        list.into_inner()
                            .robots
                            .iter()
                            .map(actuation_from_proto)
                            .collect(),
                    ),
                    Err(status) if status.code() == tonic::Code::Unimplemented => {
                        tracing::warn!(
                            remote = %remote,
                            "this daemon has no ListActuations (an older build): the return path \
                             is reported as not answered, not as an empty fleet"
                        );
                        None
                    }
                    Err(e) => {
                        return Err(anyhow::Error::new(e))
                            .with_context(|| format!("ListActuations on {remote}"))
                    }
                };
            if opts.json {
                // **The local document plus who answered.** Not a second dialect: same keys, same
                // shapes, same vocabulary as `status` (see `remote_status_json`), with `remote`
                // naming the socket and `actuations` the return path the daemon folded — `null`
                // when this daemon does not answer that question, `[]` when nobody has reported.
                let now = amos_link::codec::Timestamp::now().unix_ms();
                let actuations = robots.as_deref().map(|robots| {
                    robots
                        .iter()
                        .map(|(robot, state, stamp)| actuation_json(robot, state, *stamp, now))
                        .collect::<Vec<_>>()
                });
                let document = remote_status_json(&remote, &status, &topics, actuations);
                println!("{}", serde_json::to_string_pretty(&document)?);
            } else {
                let peers: Vec<PeerRow> = status.peers.iter().map(PeerRow::from_proto).collect();
                let metrics = status.metrics.unwrap_or_default();
                println!(
                    "remote={remote} link peer={} kind={} version={} uptime={}ms \
                     clock_synced={} peers={} published={} delivered={} dropped={} blocked={} \
                     decode_errors={} health={}",
                    status.peer,
                    status.kind,
                    status.version,
                    status.uptime_ms,
                    status.clock_synced,
                    peers.len(),
                    metrics.published,
                    metrics.delivered,
                    metrics.dropped,
                    metrics.blocked,
                    metrics.decode_errors,
                    health_label(status.health)
                );
                if !status.health_reasons.is_empty() {
                    println!("health reasons: {}", status.health_reasons.join(", "));
                }
                // The peer table the daemon answered with (it was on the wire and used to be
                // dropped: the terminal printed a count where the answer had names).
                println!(
                    "peers ({}):{}",
                    peers.len(),
                    if peers.is_empty() {
                        " (nobody else is fresh on this link)"
                    } else {
                        ""
                    }
                );
                print_peer_rows(&peers);
                // The inventory and its own completeness flag, as `topics --socket` prints them.
                println!(
                    "topics ({}): inventory {}",
                    topics.topics.len(),
                    if topics.complete {
                        "complete"
                    } else {
                        "incomplete — a network transport cannot enumerate what others publish, \
                         and a full broker inventory stops growing"
                    }
                );
                // The return path: what each robot reports about *itself*. Absent robots are
                // named as absent, never as idle ones — and a daemon that does not answer the
                // question at all says so instead of being read as a fleet that never spoke.
                match &robots {
                    None => println!(
                        "robots reported: not answered by this daemon (no ListActuations — an \
                         older build); the status above was answered"
                    ),
                    Some(robots) if robots.is_empty() => println!(
                        "robots reported (0): nobody has reported its actuation since the daemon \
                         started watching (a report is a subscription, not a query)"
                    ),
                    Some(robots) => {
                        println!("robots reported ({}):", robots.len());
                        let now = amos_link::codec::Timestamp::now().unix_ms();
                        for (robot, state, stamp) in robots {
                            for line in render_actuation(robot, state, *stamp, now, false) {
                                println!("  {line}");
                            }
                        }
                    }
                }
            }
        }
        Cmd::Topics => {
            let list = link
                .list_topics(Empty {})
                .await
                .with_context(|| format!("ListTopics on {remote}"))?
                .into_inner();
            if opts.json {
                // `remote` names which node answered, `complete` whether this list is the
                // whole truth — the same two facts the human form states in prose.
                println!(
                    "{}",
                    serde_json::json!({
                        "remote": remote,
                        "topics": list.topics,
                        "complete": list.complete,
                    })
                );
                return Ok(());
            }
            if list.topics.is_empty() {
                println!("remote={remote}: (no traffic on the daemon's own transport yet)");
            }
            for topic in &list.topics {
                println!("{topic}");
            }
            // Who this inventory is *of*, and — the half that used to be lost over the control
            // plane — whether it is the whole truth: the daemon's own transport can only
            // enumerate what it saw there (docs/amos-link.md §5), and its list stops growing at
            // MAX_TRACKED_TOPICS. `TopicList.complete` is the field that says so; printing only
            // the count would present both cases as a complete list.
            println!(
                "remote={remote}: {} topic(s) seen by the daemon's transport (inventory {})",
                list.topics.len(),
                if list.complete {
                    "complete"
                } else {
                    "incomplete — a network transport cannot enumerate what others publish, \
                     and a full broker inventory stops growing"
                }
            );
        }
        Cmd::Pub => run_remote_pub(opts, &mut link, &remote).await?,
        Cmd::Watch => run_remote_watch(opts, &mut link, &remote).await?,
        Cmd::Sub | Cmd::Bench | Cmd::Discover | Cmd::State | Cmd::Hz => bail!(
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
        if opts.json {
            println!(
                "{}",
                serde_json::json!({
                    "event": "published",
                    "via": remote,
                    "seq": reply.seq,
                    "topic": topic.as_str(),
                    "matched": reply.matched,
                    "delivered": reply.delivered,
                    "dropped": reply.dropped,
                })
            );
        } else {
            println!(
                "published via={remote} seq={} topic={} matched={} delivered={} dropped={}",
                reply.seq, topic, reply.matched, reply.delivered, reply.dropped
            );
        }
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
    if opts.json {
        println!(
            "{}",
            serde_json::json!({
                "event": "watching",
                "remote": remote,
                "seconds": seconds,
            })
        );
    } else {
        println!(
            "remote={remote} watching the link's heartbeats for {seconds}s (StreamHeartbeats)"
        );
    }
    let deadline = deadline_after(Duration::from_secs(seconds))?;
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
    if opts.json {
        println!(
            "{}",
            serde_json::json!({
                "event": "summary",
                "remote": remote,
                "watched_s": seconds,
                "beats": seen,
                "peers": per_peer.len(),
                "per_peer": per_peer,
            })
        );
    } else {
        println!(
            "watched {seconds}s: beats={seen} peers={} ({remote})",
            per_peer.len()
        );
        for (peer, count) in per_peer {
            println!("  {peer}: {count}");
        }
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

/// Start this node's peer federation, announcing **exactly what the operator asked for**.
///
/// The one place the advertisement is wired from `Opts` into the node, so that `watch` and
/// `discover --bus` cannot drift apart about what this node says about itself — and so that
/// the line which could silently pass an empty list is covered by a test that watches the
/// advertisement arrive in *another* node's peer table rather than in this process's own
/// output (`the_cli_announces_the_endpoint_the_operator_gave`). Printing the same list from
/// `opts` is not evidence that the node ever heard it.
fn start_federation(node: &Arc<LinkNode>, period: Duration, opts: &Opts) -> Result<FederationTask> {
    node.spawn_federation_advertising(period, opts.endpoints.clone())
        .context("joining the peer federation")
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

    // **One** counter set for this node and its transport: `published`/`delivered` are recorded
    // by the transport, and every figure an operator reads (`status`, `watch`, the health fold)
    // comes from them. Building the session with a *separate* set is what left every Zenoh node
    // reporting `published=0` while frames crossed the link (round 15) — hence
    // `ZenohTransport::open` + `metrics()` here rather than two independent sets.
    let metrics = Arc::new(LinkMetrics::new());
    let transport = amos_link::zenoh::ZenohTransport::open()
        .await
        .context("opening the Zenoh session")?
        .with_metrics(Arc::clone(&metrics))
        .shared();
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

/// The profile a subscription command will actually use, **and where it came from** (printed by
/// every caller, never assumed).
///
/// One rule for `sub`, `state` and `hz` — round 18 found it written out twice (once per command)
/// and about to be copied a third time, which is exactly how two commands end up disagreeing
/// about the same pattern:
///
/// * an explicit `--qos` wins;
/// * otherwise the **pattern's own channel** decides, so a control pattern can never default to
///   the best-effort sensor profile and drop the commands the subscription exists to deliver
///   (`Qos::for_channel`'s own doc);
/// * a pattern that names no channel falls back to `default_channel` — `None` for a general
///   subscription (the sensor profile, the "latest sample wins" default an inspector wants) and
///   `Some(Channel::State)` for `state`, whose payload *is* a state report.
///
/// The returned source string is part of the human contract: it is what tells an operator why a
/// subscription behaves the way it does (`qos=reliable/drop-newest from channel control`).
fn subscription_qos(
    pattern: &Topic,
    requested: Option<Qos>,
    default_channel: Option<Channel>,
) -> (Qos, String) {
    if let Some(qos) = requested {
        return (qos, "--qos".to_string());
    }
    match pattern.channel().or(default_channel) {
        Some(channel) => (
            Qos::for_channel(channel),
            format!("channel {}", channel.key()),
        ),
        None => (
            Qos::sensor(),
            "default (no channel in the pattern)".to_string(),
        ),
    }
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
async fn recv_with_timeout<T: Message>(
    subscriber: &mut amos_link::pubsub::Subscriber<T>,
    timeout_ms: u64,
) -> Result<Option<Received<T>>> {
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

/// One received frame as a **human line** (pure, so the age rule is unit-testable).
///
/// The age goes through [`frame_age_ms`] — the same rule the return path uses — so a frame whose
/// stamp is **ahead of this clock** reads `age=unknown(stamp is Nms in the future — that clock is
/// not this clock)` instead of `age=0ms`. `0` was the one number that could not be true: it is
/// what `Timestamp::since` *saturates to* for a backwards clock, and it reads as "arrived
/// instantly" (a claim about the link the instrument cannot support).
///
/// The figure is formatted with the shared [`format_age_ms`], the same shapes the report line and
/// the System UI use, so one age has one spelling across the whole tool (this changes the frame
/// line's `age=5000ms` into `age=5s` — the value is unchanged, only its spelling).
fn received_line(received: &Received<AgentAction>, now: &amos_link::codec::Timestamp) -> String {
    let age = match frame_age_ms(&received.stamp, now) {
        Ok(ms) => format_age_ms(ms),
        Err(unknown) => format!("unknown({})", unknown.detail()),
    };
    format!(
        "{} <- {} seq={} age={} len={}B {}",
        received.topic,
        received.publisher,
        received.seq,
        age,
        received.frame_len,
        received.message.json
    )
}

/// The same frame in the machine form: `age_ms` is a number **or `null`**, never `0` for an age
/// that could not be measured (rounds 11/14).
fn received_json(
    received: &Received<AgentAction>,
    now: &amos_link::codec::Timestamp,
) -> serde_json::Value {
    serde_json::json!({
        "event": "frame",
        "topic": received.topic.as_str(),
        "publisher": received.publisher.as_str(),
        "seq": received.seq,
        "age_ms": frame_age_ms(&received.stamp, now).ok(),
        "frame_len": received.frame_len,
        "json": received.message.json,
    })
}

/// Print one received frame (a human line, or JSON when `--json`).
///
/// The JSON line names its **event** (`"event":"frame"`), like every other line of a `--json`
/// stream (`pub` prints `published`, `watch` prints `heartbeat`/`status`). It was the one
/// stream line without a tag, so a reader had to identify a frame by the *absence* of a key
/// it might be missing anyway.
fn print_frame(received: &Received<AgentAction>, json: bool) -> Result<()> {
    let now = amos_link::codec::Timestamp::now();
    if json {
        println!("{}", received_json(received, &now));
        return Ok(());
    }
    println!("{}", received_line(received, &now));
    Ok(())
}

/// One benchmark frame: a fixed-size payload plus its own sequence number.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct BenchFrame {
    seq: u64,
    payload: Vec<u8>,
}

/// Classify one received benchmark frame: a latency sample, or a frame whose age cannot be
/// measured (its stamp is ahead of this clock ⇒ the two clocks differ).
///
/// Pure, so the classification is unit-testable without a run: the defect this replaces was
/// `latencies.push(received.age().as_micros())`, where a backwards/skewed clock contributed a
/// `0 µs` sample — a number that makes the link look faster than it is.
fn sample(
    received: &Received<BenchFrame>,
    now: &amos_link::codec::Timestamp,
    latencies: &mut Vec<u128>,
    skewed: &mut u64,
) {
    match frame_age_us(&received.stamp, now) {
        Ok(us) => latencies.push(us),
        Err(_) => *skewed += 1,
    }
}

/// The latency report of a run: the percentiles of the samples that **were** measurable, plus
/// the count they came from.
///
/// `null` when there is no sample at all — an empty run (or a run where *every* frame's stamp
/// was ahead of this clock) is not a zero-latency one: `min=0` would read as an instant link.
fn latency_json(latencies: &mut [u128]) -> serde_json::Value {
    if latencies.is_empty() {
        return serde_json::Value::Null;
    }
    latencies.sort_unstable();
    let pct = |p: usize| -> u128 { latencies[(latencies.len().saturating_sub(1) * p) / 100] };
    serde_json::json!({
        "min": latencies[0],
        "p50": pct(50),
        "p99": pct(99),
        "max": latencies[latencies.len() - 1],
        // The base the percentiles are computed from: `received - skewed` (they are two
        // different numbers now that a skewed frame is not a sample).
        "samples": latencies.len(),
    })
}

/// The human latency line, or the reason there is none.
fn latency_line(latencies: &[u128], skewed: u64) -> String {
    let note = if skewed > 0 {
        format!(
            " · {skewed} frame(s) excluded: their stamps are ahead of this clock, so their \
             latency is not measurable (not 0)"
        )
    } else {
        String::new()
    };
    if latencies.is_empty() {
        if skewed > 0 {
            return format!("latency: none measurable ({skewed} frame(s) skewed){note}");
        }
        return "latency: none (no frame came back)".to_string();
    }
    let pct = |p: usize| -> u128 { latencies[(latencies.len().saturating_sub(1) * p) / 100] };
    format!(
        "latency (publish -> decoded, us): min={} p50={} p99={} max={} (n={}){note}",
        latencies[0],
        pct(50),
        pct(99),
        latencies[latencies.len() - 1],
        latencies.len()
    )
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
    if !opts.json {
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
    }

    // A bounded reservation (`--count` is a `u64` from a command line): the vector grows to
    // whatever the run really collects, but a huge count can no longer abort the process
    // with a capacity overflow before the first frame is even published.
    let target = usize::try_from(count).unwrap_or(usize::MAX);
    let mut latencies: Vec<u128> = Vec::with_capacity(target.min(LATENCY_RESERVE));
    // Frames whose stamp was **ahead of this clock**: they carry no measurable latency, so they
    // are counted, not sampled. Folding them in as `0 µs` (which is what `Timestamp::since`
    // saturates to) would make the percentiles *better* than the link — the one direction a
    // measurement must never lie in.
    let mut skewed = 0u64;
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
            sample(
                &received,
                &amos_link::codec::Timestamp::now(),
                &mut latencies,
                &mut skewed,
            );
        }
    }
    // Give the last frames a bounded moment to land, then drain once more.
    let deadline = Instant::now() + Duration::from_millis(200);
    while latencies.len() < target && Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(50), subscriber.recv()).await {
            Ok(Ok(received)) => {
                seq.observe_received(&received);
                sample(
                    &received,
                    &amos_link::codec::Timestamp::now(),
                    &mut latencies,
                    &mut skewed,
                );
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
    if opts.json {
        // One document for the run. `latency_us` is `null` when no *measurable* sample landed
        // (an empty run — or a run where every stamp was ahead of this clock — is not a
        // zero-latency one: `min=0` would read as an instant link), and `skewed` is the
        // top-level count of frames whose age could not be measured at all.
        let latency = latency_json(&mut latencies);
        println!(
            "{}",
            serde_json::json!({
                "peer": node.peer().as_str(),
                "topic": topic.as_str(),
                "frames": count,
                "size": opts.size,
                "hz": opts.hz,
                "sent": publisher.seq(),
                "received": latencies.len() + usize::try_from(skewed).unwrap_or(usize::MAX),
                "skewed": skewed,
                "dropped": stats.dropped,
                "decode_errors": stats.decode_errors,
                "blocked": node.metrics().snapshot().blocked,
                "gaps": gaps.gaps,
                "missing": gaps.missing,
                "stale": gaps.stale,
                "elapsed_ms": elapsed.as_millis() as u64,
                "throughput_per_sec": throughput,
                "latency_us": latency,
            })
        );
        return Ok(());
    }
    println!(
        "sent={} received={} dropped={} decode_errors={} blocked={} gaps={} missing={} stale={} \
         elapsed={}ms throughput={throughput:.0} frame/s",
        publisher.seq(),
        latencies.len() + usize::try_from(skewed).unwrap_or(usize::MAX),
        stats.dropped,
        stats.decode_errors,
        node.metrics().snapshot().blocked,
        gaps.gaps,
        gaps.missing,
        gaps.stale,
        elapsed.as_millis()
    );
    // Printed even when there is no usable sample: "none measurable" is a *result* (every stamp
    // was ahead of this clock, or nothing came back), and printing nothing would look like the
    // line was forgotten.
    latencies.sort_unstable();
    println!("{}", latency_line(&latencies, skewed));
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
    // Offline mode: seed a registry with the operator-specified peers so the *table* logic
    // (freshness, TTL, ordering) is visible without a network.
    //
    // This node is **not** seeded: a node is not its own peer, and the table refuses it
    // (`with_local`) — an earlier version put `amos-node` in the table, where it reads as
    // "another machine is on the link".
    let mut registry =
        PeerRegistry::with_local(Duration::from_secs(3), PeerId::new(opts.peer.clone())?);
    let now = amos_link::codec::Timestamp::now();
    for peer in &opts.peers {
        let info = PeerInfo::new(PeerId::new(peer.clone())?, NodeKind::Robot);
        registry.learn(info, now);
    }
    if opts.json {
        println!(
            "{}",
            discovery_json(
                "mock",
                Some(registry.ttl()),
                None,
                &registry.peers(now),
                registry.self_entries_refused(),
                // The offline sweep announces nothing: it seeds a table of peers the operator
                // named. `null` says exactly that (see `discovery_json`).
                None,
            )
        );
        return Ok(());
    }
    println!(
        "discovery=mock ttl={}ms peers={} (use --lan for real UDP beacons)",
        registry.ttl().as_millis(),
        registry.len()
    );
    print_peers(&registry.peers(now));
    note_self_refusals(registry.self_entries_refused());
    Ok(())
}

/// One row of the peer table — the **flat** shape the control plane's `Peer` message carries and
/// the System UI renders: `id`, `kind`, `endpoint`, `last_seen_ms`, `beacons`.
///
/// One type, two sources, one JSON: a *local* node hands out [`PeerView`]s (the kernel's own view)
/// and the control plane hands out `proto.Peer`s, and both become this row before anything prints
/// it. The kernel's `NodeStatus` document was changed to the same spelling, so `discover --json`,
/// `status`, `status --socket` and the UI cannot drift into four vocabularies for one table again.
///
/// Two honest notes: the announced *list* of endpoints collapses to its primary one (exactly what
/// `proto.Peer` and the UI already do), and `beacons == 0` is how a hand-declared (static) peer is
/// told apart from a beaconed one — the proto's own rule, so no `static` key is invented here.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PeerRow {
    id: String,
    kind: &'static str,
    endpoint: Option<String>,
    last_seen_ms: u64,
    beacons: u64,
}

impl PeerRow {
    /// From the kernel's view (a local node's table).
    fn from_view(peer: &PeerView) -> Self {
        Self {
            id: peer.info.id.as_str().to_string(),
            kind: peer.info.kind.key(),
            endpoint: peer.info.endpoint().map(str::to_string),
            last_seen_ms: peer.last_seen_ms,
            beacons: peer.beacons,
        }
    }

    /// From the control plane (`proto.Peer`). An empty endpoint string means "none announced" —
    /// it becomes `null`, never `""` (the proto uses `""` as its sentinel; a document must not).
    fn from_proto(peer: &ProtoPeer) -> Self {
        Self {
            id: peer.id.clone(),
            // A kind this build does not know is reported as `unknown`, never dropped or
            // guessed: the row still names the peer.
            kind: NodeKind::from_key(&peer.kind)
                .map(NodeKind::key)
                .unwrap_or("unknown"),
            endpoint: Some(peer.endpoint.clone()).filter(|endpoint| !endpoint.is_empty()),
            last_seen_ms: peer.last_seen_ms,
            beacons: peer.beacons,
        }
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "kind": self.kind,
            "endpoint": self.endpoint,
            "last_seen_ms": self.last_seen_ms,
            "beacons": self.beacons,
        })
    }
}

/// The peer table as JSON — **one** spelling, the control plane's.
///
/// A peer that announced no endpoint is `null`, **not** the human table's `-` placeholder:
/// a script must be able to tell "no address" from an address that happens to be a dash.
fn peers_json(peers: &[PeerRow]) -> Vec<serde_json::Value> {
    peers.iter().map(PeerRow::to_json).collect()
}

/// One machine-readable document for a discovery sweep: the **result**, never the progress.
///
/// `--lan` prints a `+ peer` line as each beacon arrives — useful to a human watching a
/// sweep, meaningless to a parser — so those are suppressed under `--json` and the document
/// below carries what the sweep converged on (with `--seconds` saying how long it looked,
/// and `ttl_ms` how long an absent peer's entry survives).
fn discovery_json(
    mode: &str,
    ttl: Option<Duration>,
    seconds: Option<u64>,
    peers: &[PeerView],
    self_refused: u64,
    advertised: Option<&[String]>,
) -> serde_json::Value {
    let rows: Vec<PeerRow> = peers.iter().map(PeerRow::from_view).collect();
    let mut doc = serde_json::json!({
        "discovery": mode,
        "peers": peers_json(&rows),
        "self_refused": self_refused,
    });
    if let Some(ttl) = ttl {
        doc["ttl_ms"] = serde_json::json!(ttl.as_millis() as u64);
    }
    if let Some(seconds) = seconds {
        doc["seconds"] = serde_json::json!(seconds);
    }
    // The sweep's **own** announcement, when it made one: `null` means "this mode announces
    // nothing about this node" (the offline mock sweep), and `[]` means "it announced a beacon
    // that carried no address" — two different facts, and a script that read only `peers`
    // would have to guess which one it is looking at.
    if let Some(endpoints) = advertised {
        doc["advertised"] = serde_json::json!(endpoints);
    }
    doc
}

/// The remote `status` document: **the local document plus who answered**.
///
/// `status --socket` used to be a second dialect of the same command — counters flattened to the
/// top level, `peers` a *number* (the count) where a local document has an *array*, and `health` a
/// bare string where a local document has an object. Same key names, different **types**: a script
/// written against one mode silently misread the other, and two keys (`peers`, `health`) meant two
/// different things depending on a flag.
///
/// This builder is the fix and the contract: the shared keys are copied one by one in the local
/// shape (peer table flat, verdict in the control plane's words, counters nested, inventory with
/// its own completeness flag) and only `remote` + `actuations` are added. The unit test
/// `the_remote_status_document_is_the_local_document_plus_who_answered` holds the two documents
/// side by side from the same facts, so the shapes cannot drift apart again.
fn remote_status_json(
    remote: &str,
    status: &LinkStatus,
    topics: &TopicList,
    actuations: Option<Vec<serde_json::Value>>,
) -> serde_json::Value {
    let metrics = status.metrics.unwrap_or_default();
    let peers: Vec<PeerRow> = status.peers.iter().map(PeerRow::from_proto).collect();
    serde_json::json!({
        "remote": remote,
        "peer": status.peer,
        "kind": status.kind,
        "version": status.version,
        "uptime_ms": status.uptime_ms,
        "clock_synced": status.clock_synced,
        "metrics": {
            "published": metrics.published,
            "delivered": metrics.delivered,
            "dropped": metrics.dropped,
            "blocked": metrics.blocked,
            "decode_errors": metrics.decode_errors,
            "encode_errors": metrics.encode_errors,
        },
        "health": health_json(status.health, &status.health_reasons),
        "peers": peers_json(&peers),
        "topics": topics.topics,
        "topics_complete": topics.complete,
        "actuations": actuations,
    })
}

/// A verdict in the shape every document uses:
/// `{"state": "unknown|healthy|degraded", "reasons": ["decode_errors=3", …]}`.
///
/// One rendering for one verdict, whichever side computed it: the control plane carries exactly
/// this vocabulary (an enum plus `detail()` tokens), the kernel's status document emits it, and the
/// CLI's `watch` folds its own verdict — all three go through this pair of helpers.
/// `reasons` is present only when there are some (a healthy/unknown verdict has none, which is what
/// the kernel's document emits too: its `state` tag omits the field for those two states).
fn health_json_labeled(state: &str, reasons: &[String]) -> serde_json::Value {
    let mut value = serde_json::json!({ "state": state });
    if !reasons.is_empty() {
        value["reasons"] = serde_json::json!(reasons);
    }
    value
}

/// The same document from a verdict that arrived as the wire's enum (`i32`), so a caller reading
/// `GetStatus` does not have to translate the vocabulary.
fn health_json(state: i32, reasons: &[String]) -> serde_json::Value {
    health_json_labeled(health_label(state), reasons)
}

/// One line per stream that lost frames — the attribution of the totals [`SeqTracker`] prints.
///
/// `missing=3` says the link dropped frames; it does not say *where*, and `sub --pattern 'amos/**'`
/// (the CLI's default) can cover dozens of streams. One line per stream, in the tracker's key order
/// (publisher, then topic), so the same link prints the same lines twice.
fn loss_stream_lines(streams: &[(StreamKey, u64, u64)]) -> Vec<String> {
    streams
        .iter()
        .map(|(stream, missing, gaps)| {
            format!(
                "lost peer={} topic={} missing={missing} in {gaps} gap(s)",
                stream.publisher(),
                stream.topic()
            )
        })
        .collect()
}

/// The same attribution in the machine form (`sub --json`'s `stats.lost` array).
///
/// Two renderers, one fact: the human form is a sentence an operator reads, the JSON form is
/// the row a script filters on — and both are built from the *same* `(StreamKey, missing,
/// gaps)` tuples `SeqTracker::streams_with_loss` returns, so they cannot disagree about what
/// was lost.
fn loss_streams_json(streams: &[(StreamKey, u64, u64)]) -> Vec<serde_json::Value> {
    streams
        .iter()
        .map(|(stream, missing, gaps)| {
            serde_json::json!({
                "peer": stream.publisher().as_str(),
                "topic": stream.topic().as_str(),
                "missing": missing,
                "gaps": gaps,
            })
        })
        .collect()
}

/// Say so when a table refused this node's own identity.
///
/// The refusal is deliberate (a node is not its own peer) but must not be silent: without
/// this line, "we filtered your own beacons" and "the LAN carried nothing" print the same.
fn note_self_refusals(refused: u64) {
    if refused > 0 {
        println!(
            "filtered {refused} entr{} naming this node itself (a node is not its own peer)",
            if refused == 1 { "y" } else { "ies" }
        );
    }
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
    // The advertisement this sweep puts in every beacon: validated here (per-field bounds *and*
    // the frame they have to fit in), so a typo is a refusal now instead of an announcement
    // nobody can build — a `--lan` sweep would otherwise spend its whole window sending
    // nothing while the operator waits for peers that were never told where to look.
    let me = PeerInfo::advertising(
        PeerId::new(opts.peer.clone())?,
        opts.kind,
        opts.endpoints.clone(),
    )
    .context("this sweep's advertised endpoint(s)")?;
    // The table knows whose node this is: our own announcements come back to this socket
    // (`IP_MULTICAST_LOOP` is on by default), and listing the machine we are running on as
    // a peer of the LAN is exactly the "invented fact" this command exists to avoid —
    // measured before this fix: `+ peer self-test`, four beacons, `peers=1`.
    let mut registry = PeerRegistry::with_local(Duration::from_secs(3), me.id.clone());
    // Announce for as long as we listen instead of once at startup: a single beacon is
    // found only by a peer that was already listening, which inverts the question this
    // command exists to answer ("who is on this LAN?"). The cadence follows the rule
    // `spawn_federation` enforces — at most a third of the TTL — so the peers we appear
    // to don't see us flap.
    let period = federation_period(registry.ttl());
    let announcer = amos_link::lan::spawn_announcer(Arc::clone(&channel), me, period)
        .context("starting the beacon announcer")?;
    if !opts.json {
        println!(
            "discovery=lan target={} bound={} announce={}ms advertising={} listening {}s",
            channel.target_addr(),
            channel.bind_addr(),
            period.as_millis(),
            advertised_summary(&opts.endpoints),
            opts.seconds
        );
    }
    // What the socket was *actually* configured with (a pinned interface, a suppressed
    // loopback): on a multi-NIC board this is the difference between "the LAN carried
    // nothing" and "the beacon left through the wrong NIC", and an operator cannot tell them
    // apart from the peer table alone.
    let applied = channel.options();
    if !opts.json {
        println!(
            "beacon iface={} loop={}",
            applied
                .iface
                .map_or_else(|| "kernel-default".to_string(), |a| a.to_string()),
            match applied.multicast_loop {
                Some(true) => "on".to_string(),
                Some(false) => "off".to_string(),
                None => "platform-default".to_string(),
            }
        );
    }
    // `tokio::time::Instant` is a wrapper over the same `std::time::Instant`, so the one
    // overflow-safe helper covers both clocks.
    let deadline =
        tokio::time::Instant::from_std(deadline_after(Duration::from_secs(opts.seconds.max(1)))?);
    // Bounded by `--seconds`: it always ends (a discovery sweep, not a daemon).
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline - tokio::time::Instant::now();
        match tokio::time::timeout(remaining, discovery.next_beacon()).await {
            Ok(Ok(beacon)) => {
                let now = amos_link::codec::Timestamp::now();
                if registry.observe(&beacon, now) && !opts.json {
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
    if opts.json {
        println!(
            "{}",
            discovery_json(
                "lan",
                None,
                Some(opts.seconds.max(1)),
                &registry.peers(amos_link::codec::Timestamp::now()),
                registry.self_entries_refused(),
                Some(&opts.endpoints),
            )
        );
        return Ok(());
    }
    print_peers(&registry.peers(amos_link::codec::Timestamp::now()));
    note_self_refusals(registry.self_entries_refused());
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
    let task = start_federation(&node, federation_period(node.peer_ttl()), opts)?;
    if !opts.json {
        println!(
            "discovery=bus transport={} peer={} topic=amos/{}/telemetry/beacon \
             advertising={} listening {}s",
            node.transport_name(),
            node.peer(),
            node.peer(),
            advertised_summary(&opts.endpoints),
            opts.seconds.max(1)
        );
    }
    let deadline = deadline_after(Duration::from_secs(opts.seconds.max(1)))?;
    // Bounded by `--seconds`: a discovery sweep, not a daemon. It also prints the table
    // *while* it is listening, so an operator sees peers appear instead of a frozen run.
    while Instant::now() < deadline {
        let peers = node.peers().await;
        if !peers.is_empty() {
            // Read the filtered count *before* stopping the task that owns it.
            let self_echoes = task.self_echoes();
            task.stop().await;
            if opts.json {
                println!(
                    "{}",
                    bus_discovery_json(
                        &node,
                        opts.seconds.max(1),
                        &peers,
                        self_echoes,
                        &opts.endpoints,
                    )
                );
                return Ok(());
            }
            println!("peers={}", peers.len());
            print_peers(&peers);
            note_self_refusals(self_echoes);
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let self_echoes = task.self_echoes();
    task.stop().await;
    let peers = node.peers().await;
    if opts.json {
        // A sweep that found nobody is a *result*, not an error: the document carries the
        // empty table and the same counts the human form reports.
        println!(
            "{}",
            bus_discovery_json(
                &node,
                opts.seconds.max(1),
                &peers,
                self_echoes,
                &opts.endpoints,
            )
        );
        return Ok(());
    }
    println!(
        "no peers announced on this link in {}s (federation still ran: this node \
         published its beacon and filtered its own echo)",
        opts.seconds.max(1)
    );
    print_peers(&peers);
    note_self_refusals(self_echoes);
    Ok(())
}

/// The `discover --bus` document: the sweep's table plus which transport carried it (the
/// one fact that decides whether the table is this process's broker or the real LAN) and
/// **what this node announced about itself** (`advertised`) — the other direction of the same
/// transaction, which a script reading only `peers` would otherwise have to guess.
fn bus_discovery_json(
    node: &Arc<LinkNode>,
    seconds: u64,
    peers: &[PeerView],
    self_echoes: u64,
    advertised: &[String],
) -> serde_json::Value {
    let mut doc = discovery_json(
        "bus",
        Some(node.peer_ttl()),
        Some(seconds),
        peers,
        self_echoes,
        Some(advertised),
    );
    doc["transport"] = serde_json::json!(node.transport_name());
    doc
}

/// Print a peer table the way an operator reads it — the human twin of [`peers_json`], used by
/// the local `discover`/`status` paths and by `status --socket` (which reads the table off the
/// control plane), so a terminal and the System UI never disagree about who is on the link.
fn print_peer_rows(peers: &[PeerRow]) {
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
            peer.id,
            peer.kind,
            peer.last_seen_ms,
            peer.beacons,
            peer.endpoint.as_deref().unwrap_or("-")
        );
    }
}

/// The local registry's table, in the same shape (one conversion, one renderer).
fn print_peers(peers: &[PeerView]) {
    let rows: Vec<PeerRow> = peers.iter().map(PeerRow::from_view).collect();
    print_peer_rows(&rows);
}

/// One report from the **data plane** (`state`) → the shared renderer below.
///
/// The frame's own stamp is when the reporter published it; `now` is this process's clock, which
/// is what turns the two into an **age**.
fn state_lines(received: &Received<ActuationState>, json: bool) -> Vec<String> {
    render_actuation(
        received.publisher.as_str(),
        &received.message,
        received.stamp.unix_ms(),
        amos_link::codec::Timestamp::now().unix_ms(),
        json,
    )
}

/// Why a report's age could not be computed — never folded into `0`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgeUnknown {
    /// The report carried no stamp (`0` is the proto's sentinel for "absent", not 1970).
    NoStamp,
    /// The stamp is **in the future** by this many ms: the reporter's clock is not this clock —
    /// the visible symptom of two unsynchronised clocks, and exactly when an age would be a guess.
    InTheFuture(u64),
}

impl AgeUnknown {
    fn detail(self) -> String {
        match self {
            AgeUnknown::NoStamp => "no stamp".to_string(),
            // "the reporter's clock", not "the robot's": the same rule now answers for a
            // *frame* (round 14), and a frame's publisher is as likely to be a brain or a
            // tool as a robot. One message, true on both paths.
            AgeUnknown::InTheFuture(ms) => {
                format!("stamp is {ms}ms in the future — that clock is not this clock")
            }
        }
    }
}

/// The **one comparison** every age in this CLI is decided by: a stamp ahead of *this* clock has
/// no age to state.
///
/// It is in **nanoseconds** — the wire's own unit — because the decision must not be made on a
/// truncated figure. Deciding in milliseconds would (a) call a 300 µs skew "0 in the future",
/// and (b) force every caller to truncate to ms before asking, which is precisely how the first
/// version of this round's `bench` fix silently degraded the histogram to `min=0 p50=0 p99=0`
/// (the samples were sub-millisecond, so `ms × 1000` was zero). Each *figure* is derived from
/// the nanosecond answer by division instead ([`Timestamp::as_nanos`]).
///
/// [`Timestamp::as_nanos`]: amos_link::codec::Timestamp::as_nanos
fn age_nanos_between(stamp_ns: u128, now_ns: u128) -> std::result::Result<u128, AgeUnknown> {
    if stamp_ns > now_ns {
        // The figure in the message is in milliseconds, rounded **up**: a sub-millisecond skew
        // reads "1ms in the future", never "0ms in the future" (which reads as "now").
        let ms = (stamp_ns - now_ns).div_ceil(1_000_000);
        return Err(AgeUnknown::InTheFuture(
            u64::try_from(ms).unwrap_or(u64::MAX),
        ));
    }
    Ok(now_ns - stamp_ns)
}

/// [`age_nanos_between`] on a millisecond figure (the unit the report path speaks).
fn age_between(stamp_ms: u64, now_ms: u64) -> std::result::Result<u64, AgeUnknown> {
    let nanos = age_nanos_between(
        u128::from(stamp_ms) * 1_000_000,
        u128::from(now_ms) * 1_000_000,
    )?;
    Ok(u64::try_from(nanos / 1_000_000).unwrap_or(u64::MAX))
}

/// The age of a frame in **nanoseconds**, or why it cannot be stated (see [`frame_age_ms`]).
fn frame_age_nanos(
    received_stamp: &amos_link::codec::Timestamp,
    now: &amos_link::codec::Timestamp,
) -> std::result::Result<u128, AgeUnknown> {
    age_nanos_between(received_stamp.as_nanos(), now.as_nanos())
}

/// How long ago a **report** was stamped, or why that cannot be said.
///
/// One rule for both report sources (`state` reads the frame's own stamp; `status --socket` reads
/// the stamp the daemon folded), because the age is the same fact either way: *the reporter said
/// this at that time, and this is how long ago that was on my clock*.
///
/// The sentinel is the report's own: `0` is the proto's "absent", not 1970 (see [`frame_age_ms`]
/// for the other policy on the same rule).
fn report_age_ms(stamp_ms: u64, now_ms: u64) -> std::result::Result<u64, AgeUnknown> {
    if stamp_ms == 0 {
        return Err(AgeUnknown::NoStamp);
    }
    age_between(stamp_ms, now_ms)
}

/// How long ago a **frame** was published, on this node's clock — or why that cannot be said.
///
/// The same comparison as [`report_age_ms`], with the other sentinel policy: a frame header
/// always carries a stamp, so `0` means the epoch (a huge but *real* age — a publisher whose
/// clock was never set), not an absent one. The one thing it still cannot be is an age in the
/// future: that is two clocks disagreeing, and the number would be a claim the instrument cannot
/// support (rounds 11/14 — before this, `sub` printed `age=0ms` and `bench` counted `0 µs`).
fn frame_age_ms(
    received_stamp: &amos_link::codec::Timestamp,
    now: &amos_link::codec::Timestamp,
) -> std::result::Result<u64, AgeUnknown> {
    Ok(u64::try_from(frame_age_nanos(received_stamp, now)? / 1_000_000).unwrap_or(u64::MAX))
}

/// The same age in **microseconds** — the unit `bench` reports, and the reason the decision
/// above is made in nanoseconds: a sub-millisecond sample must not be truncated to `0`.
fn frame_age_us(
    received_stamp: &amos_link::codec::Timestamp,
    now: &amos_link::codec::Timestamp,
) -> std::result::Result<u128, AgeUnknown> {
    Ok(frame_age_nanos(received_stamp, now)? / 1_000)
}

/// `250ms`, `2s`, `2m 05s`, `3h 04m`, `2d 03h`.
///
/// The same shapes the System UI's `formatUptime` uses, so a terminal and the panel describe an
/// age alike; below a second the millisecond figure is the honest one (that is a *live* report —
/// a `state` subscriber sees those all the time — not a stale one).
fn format_age_ms(ms: u64) -> String {
    if ms < 1_000 {
        return format!("{ms}ms");
    }
    let total = ms / 1_000;
    let s = total % 60;
    let m = (total / 60) % 60;
    let h = (total / 3_600) % 24;
    let d = total / 86_400;
    if d > 0 {
        format!("{d}d {h:02}h")
    } else if h > 0 {
        format!("{h}h {m:02}m")
    } else if m > 0 {
        format!("{m}m {s:02}s")
    } else {
        format!("{s}s")
    }
}

/// Render one actuation report: the human line(s), or one JSON document with `--json`.
///
/// Pure (lines out, no printing) and **shared by both sources** — the data plane (`state`,
/// where a frame carries its publisher and stamp) and the control plane
/// (`status --socket`, where the daemon hands back the report it folded in) — so the two
/// renderings can never drift in what they claim.
///
/// `now_ms` is the *reader's* clock and is used for one thing: the **age of the report**
/// (`age=2.4s`). Without it the two forms both said what a robot was doing without saying *when
/// it said so* — and `armed=true` from an hour ago is not "armed now" (§3.12).
fn render_actuation(
    robot: &str,
    state: &ActuationState,
    stamp_ms: u64,
    now_ms: u64,
    json: bool,
) -> Vec<String> {
    if json {
        return vec![actuation_json(robot, state, stamp_ms, now_ms).to_string()];
    }
    let age = match report_age_ms(stamp_ms, now_ms) {
        Ok(age) => format_age_ms(age),
        Err(problem) => format!("unknown({})", problem.detail()),
    };
    let mut lines = vec![format!(
        "robot={} armed={} estopped={}{} gait={} frames={} seq={} watchdog={} age={}",
        robot,
        state.armed,
        state.estopped,
        state
            .estop_reason
            .map(|r| format!("({})", r.key()))
            .unwrap_or_default(),
        state.gait.map(|g| g.key()).unwrap_or("-"),
        state.frames,
        state
            .seq
            .map(|n| n.to_string())
            .unwrap_or_else(|| "-".to_string()),
        state
            .watchdog_ms
            .map(|ms| format!("{ms}ms"))
            .unwrap_or_else(|| "-".to_string()),
        age
    )];
    if let Some(refusal) = state.last_refusal.as_ref() {
        lines.push(format!(
            "  last refusal: seq {} — {}",
            refusal.seq, refusal.reason
        ));
    }
    lines
}

/// The JSON shape of one report — **one** definition, used by both sources.
///
/// Carries the raw `stamp_ms` *and* the derived `age_ms`: the stamp is what the reporter said
/// (and the only thing that survives a clock skew between two machines), the age is what a reader
/// asked for. The age is `null` — never `0` — when it cannot be computed (no stamp, or a stamp in
/// the future): an absent age is not "instant" (§3.12).
fn actuation_json(
    robot: &str,
    state: &ActuationState,
    stamp_ms: u64,
    now_ms: u64,
) -> serde_json::Value {
    serde_json::json!({
        "robot": robot,
        "seq": state.seq,
        "gait": state.gait.map(|g| g.key()),
        "frames": state.frames,
        "armed": state.armed,
        "estopped": state.estopped,
        "estop_reason": state.estop_reason.map(|r| r.key()),
        "watchdog_ms": state.watchdog_ms,
        "last_refusal": state.last_refusal.as_ref().map(|r| serde_json::json!({
            "seq": r.seq,
            "reason": r.reason,
        })),
        "stamp_ms": stamp_ms,
        "age_ms": report_age_ms(stamp_ms, now_ms).ok(),
    })
}

/// The control plane's copy of a report, back in the domain shape — so `status --socket` and
/// `state` render through the *same* function.
///
/// The proto has no `Option`, so its sentinels (`0` / `""`) become the domain's "absent" here.
/// An e-stop reason this build does not know stays `None` instead of being folded into one it
/// does: `estopped` travels separately, so nothing is silently turned into "not cut".
fn actuation_from_proto(a: &ProtoActuation) -> (String, ActuationState, u64) {
    let state = ActuationState {
        seq: (a.seq != 0).then_some(a.seq),
        gait: Gait::from_key(&a.gait),
        frames: a.frames as usize,
        armed: a.armed,
        estopped: a.estopped,
        estop_reason: EstopReason::from_key(&a.estop_reason),
        watchdog_ms: (a.watchdog_ms != 0).then_some(a.watchdog_ms),
        last_refusal: (!a.last_refusal.is_empty()).then(|| Refusal {
            seq: a.last_refusal_seq,
            reason: a.last_refusal.clone(),
        }),
    };
    let stamp_ms = a
        .stamp_secs
        .saturating_mul(1000)
        .saturating_add(u64::from(a.stamp_nanos) / 1_000_000);
    (a.robot.clone(), state, stamp_ms)
}

/// Print one actuation report.
///
/// One line per report in both forms; the JSON form names its event (`"event":"report"`) like
/// every other line of a `--json` stream. The tag is added **here**, not inside
/// [`actuation_json`], because that builder is shared with `status --socket`, where the same
/// object is an *element of an array inside a document* — an element of a document is not a
/// line of a stream, and it must not claim to be an event.
fn print_state(received: &Received<ActuationState>, json: bool) -> Result<()> {
    if !json {
        for line in state_lines(received, false) {
            println!("{line}");
        }
        return Ok(());
    }
    let mut value = actuation_json(
        received.publisher.as_str(),
        &received.message,
        received.stamp.unix_ms(),
        amos_link::codec::Timestamp::now().unix_ms(),
    );
    value["event"] = serde_json::json!("report");
    println!("{value}");
    Ok(())
}

/// `state`: watch what robots report about themselves on `amos/<robot>/state/actuation`.
///
/// This is the **return path** of the control loop
/// ([`ActuationState`](amos_link::robot_hal::ActuationState)): a robot whose bridge has a
/// state publisher reports its *mode* there — armed, e-stopped (and why), the current gait,
/// and the last refusal. An operator (or the brain that commanded it) can therefore tell an
/// applied command from a refused one, and can see a **watchdog torque cut** without asking
/// the robot anything — the peer whose link died is exactly the one that cannot poll.
///
/// Bounded like `sub`: `--count` reports or `--timeout-ms`, and a timeout is reported as a
/// fact rather than hanging (the default `--timeout-ms 0` still waits forever).
async fn run_state(node: &Arc<LinkNode>, opts: &Opts) -> Result<()> {
    let pattern = match opts.pattern.as_deref() {
        Some(raw) => Topic::pattern(raw.to_string())
            .with_context(|| format!("`--pattern {raw}` is not a valid pattern"))?,
        None => actuation_pattern().context("building the default state pattern")?,
    };
    // The channel decides the profile: a state report is latest-wins, so a burst of modes
    // cannot leave a consumer acting on one that already expired. `state`'s payload *is* a state
    // report, so its fallback channel is `state` itself — while a pattern that names another
    // channel still gets that channel's profile (one rule, shared with `sub`/`hz`).
    let (qos, source) = subscription_qos(&pattern, opts.qos, Some(Channel::State));
    let mut reports = node
        .subscriber::<ActuationState>(pattern.clone(), qos)
        .await
        .with_context(|| format!("subscribing to {pattern}"))?;
    let count = opts.count.unwrap_or(1);
    if opts.json {
        println!(
            "{}",
            serde_json::json!({
                "event": "watching",
                "pattern": pattern.as_str(),
                "qos": {
                    "reliability": qos.reliability.key(),
                    "drop_policy": qos.drop_policy.key(),
                    "depth": qos.depth(),
                },
                "from": source,
                "waiting_for": count,
            })
        );
    } else {
        println!(
            "watching {pattern} qos={}/{} from {} (waiting for {count} report(s))",
            qos.reliability.key(),
            qos.drop_policy.key(),
            source
        );
    }
    for _ in 0..count {
        let received = match recv_with_timeout(&mut reports, opts.timeout_ms).await? {
            Some(report) => report,
            None => {
                if opts.json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "event": "timeout",
                            "timeout_ms": opts.timeout_ms,
                            "received": reports.stats().received,
                            "waiting_for": count,
                        })
                    );
                } else {
                    println!(
                        "timeout after {}ms with no report (received {})",
                        opts.timeout_ms,
                        reports.stats().received
                    );
                }
                break;
            }
        };
        print_state(&received, opts.json)?;
    }
    let stats = reports.stats();
    if opts.json {
        println!(
            "{}",
            serde_json::json!({
                "event": "stats",
                "received": stats.received,
                "dropped": stats.dropped,
                "decode_errors": stats.decode_errors,
                "note": "state is latest-wins per robot",
            })
        );
    } else {
        println!(
            "stats received={} dropped={} decode_errors={} (state is latest-wins per robot)",
            stats.received, stats.dropped, stats.decode_errors
        );
    }
    Ok(())
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
/// Beats are read through `Subscriber::recv_beat`, so a beat whose payload names a peer other
/// than the frame's own publisher is refused and counted (never printed): the `peer=` column
/// and the `missed=` column come from the *same* identity, instead of one being printed from
/// the payload and the other accounted for from the framing.
///
/// How often `hz` prints the rates it has measured so far.
///
/// One second, matching `ros2 topic hz`'s own default report interval and this CLI's heartbeat
/// cadence: a *print* cadence, not a measurement window (see [`run_hz`]).
const HZ_PRINT_PERIOD: Duration = Duration::from_secs(1);

/// `hz`: the arrival rate of every stream matching a pattern — the instrument that answers
/// *"is this stream running at the rate it should?"*, which a loss count cannot.
///
/// `ros2 topic hz` has answered that question for a decade; this CLI had no rate figure at all
/// (`bench` measures a synthetic publisher of its own making, `watch` counts heartbeats), which
/// was the last ⚠️ row in the ROS 2 comparison (`docs/amos-link.md` §8). The one thing this
/// command must never do is *invent* a number: a stream with one frame, or with less than
/// [`MIN_RATE_SPAN`] of arrivals, prints **why there is no rate** instead of `0 Hz` (which would
/// read as "the robot stopped publishing").
///
/// Two boundaries stated rather than implied:
///
/// * **The figure is the average since `hz` started** (like `watch`'s `beats_seen`, printed every
///   second): a *windowed* rate from a one-second sample would be a statement about this machine's
///   scheduler, and a stall is visible anyway — `frames` on the line stops growing. The summary
///   repeats the totals for the whole run.
/// * **It measures arrivals, not the frame's own clock**, so an uncalibrated clock does not
///   weaken it (`rate.rs`'s module doc): the number is the same whether `clock_synced` is true.
///
/// It subscribes to the node's **transport** (not a typed subscriber) and reads each frame's
/// header with `Envelope::decode_header`: a rate does not care what the payload means, and this
/// is the one command in the CLI that can measure a stream whose type it does not know — the
/// payload is borrowed, never copied.
async fn run_hz(node: &Arc<LinkNode>, opts: &Opts) -> Result<()> {
    let pattern = pattern_of(opts)?;
    let (qos, source) = subscription_qos(&pattern, opts.qos, None);
    let mut subscription = node
        .transport()
        .subscribe(&pattern, qos)
        .await
        .with_context(|| format!("subscribing to {pattern}"))?;
    let seconds = opts.seconds.max(1);

    if opts.json {
        println!(
            "{}",
            serde_json::json!({
                "event": "measuring",
                "transport": node.transport_name(),
                "peer": node.peer().as_str(),
                "pattern": pattern.as_str(),
                "qos": {
                    "reliability": qos.reliability.key(),
                    "drop_policy": qos.drop_policy.key(),
                    "depth": qos.depth(),
                },
                "from": source,
                "every_ms": HZ_PRINT_PERIOD.as_millis(),
                "seconds": seconds,
            })
        );
    } else {
        println!(
            "measuring transport={} peer={} pattern={} qos={}/{} from {} every={}ms for {}s{}",
            node.transport_name(),
            node.peer(),
            pattern,
            qos.reliability.key(),
            qos.drop_policy.key(),
            source,
            HZ_PRINT_PERIOD.as_millis(),
            seconds,
            // The rate is measured from *arrival* instants, so an uncalibrated clock does not
            // weaken it — but the reader still deserves to know the link's time state.
            clock_caveat(node.clock().synced())
        );
    }

    let deadline = deadline_after(Duration::from_secs(seconds))?;
    let mut ticker = tokio::time::interval(HZ_PRINT_PERIOD);
    let mut rates = RateTracker::new();
    let mut undecodable = 0u64;
    // Bounded by `--seconds`: an inspection window, not a daemon.
    while Instant::now() < deadline {
        tokio::select! {
            frame = subscription.recv() => {
                let Some(ingress) = frame else {
                    // The transport closed (a dropped node): stop measuring rather than spin.
                    break;
                };
                // Only the header: the payload is a borrow, and the *stream* is what its own
                // validated header says (the same `(publisher, topic)` key the loss instrument
                // uses, so the two can be read side by side).
                match Envelope::decode_header(&ingress.frame) {
                    Ok((header, _payload)) => {
                        rates.observe(&header.publisher, &ingress.topic, Instant::now());
                    }
                    // A frame this crate's own decoder refuses is not an arrival of any stream —
                    // counted and named, never silently folded into a rate.
                    Err(_) => undecodable += 1,
                }
            }
            _ = ticker.tick() => {
                // No streams yet? Then there is nothing to print: a `0 Hz` line would be an
                // invented fact, and the summary says how long we listened.
                for rate in rates.rates() {
                    print_rate(&rate, opts.json)?;
                }
            }
        }
    }

    let frames = rates.frames();
    let untracked = rates.untracked();
    if opts.json {
        println!(
            "{}",
            serde_json::json!({
                "event": "hz_summary",
                "streams": rates.streams(),
                "frames": frames,
                "untracked": untracked,
                "undecodable": undecodable,
                "complete": rates.is_complete(),
                "seconds": seconds,
                "rates": rates.rates().iter().map(rate_json).collect::<Vec<_>>(),
            })
        );
    } else {
        if rates.streams() == 0 {
            println!(
                "no frames observed in {seconds}s (an idle link is not a 0 Hz stream; check \
                 --pattern and --transport)"
            );
        }
        println!(
            "summary streams={} frames={} untracked={} undecodable={} complete={} ran={}s",
            rates.streams(),
            frames,
            untracked,
            undecodable,
            if rates.is_complete() { "yes" } else { "no" },
            seconds
        );
    }
    Ok(())
}

/// One stream's rate, as a line a person reads: `frames` and `span` sit beside the figure so the
/// arithmetic can be checked, and a *reason* replaces the number when there is none.
fn print_rate(rate: &StreamRate, json: bool) -> Result<()> {
    if json {
        println!("{}", rate_json(rate));
        return Ok(());
    }
    let span = match rate.span {
        Some(span) => format!("{:.2}s", span.as_secs_f64()),
        None => "-".to_string(),
    };
    let figure = match (rate.rate_hz, rate.evidence()) {
        (Some(hz), _) => format!("{hz:.1}Hz"),
        (None, Some(why)) => format!("unknown({})", why.detail()),
        (None, None) => "unknown".to_string(),
    };
    println!(
        "rate publisher={} topic={} frames={} span={} rate={}",
        rate.publisher, rate.topic, rate.frames, span, figure
    );
    Ok(())
}

/// The same reading as one JSON object — `rate_hz` is `null` (never `0`) when it cannot be stated,
/// and `why` carries the stable reason token so a script never parses prose.
fn rate_json(rate: &StreamRate) -> serde_json::Value {
    serde_json::json!({
        "event": "hz",
        "publisher": rate.publisher.as_str(),
        "topic": rate.topic.as_str(),
        "frames": rate.frames,
        "span_ms": rate.span.map(|span| span.as_millis() as u64),
        "rate_hz": rate.rate_hz,
        "why": rate.evidence().map(|why| why.key()),
    })
}

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
    let federation = start_federation(node, federation_period(node.peer_ttl()), opts)?;

    let seconds = opts.seconds.max(1);
    if opts.json {
        // The header's facts travel as an event, not as a prose line: a `--json` stream is
        // one object per line (the promise USAGE makes for `sub`/`state`/`watch`), and a
        // reader that pipes it into a JSON parser must not have to skip the first line.
        println!(
            "{}",
            serde_json::json!({
                "event": "watching",
                "transport": node.transport_name(),
                "peer": node.peer().as_str(),
                "kind": node.kind().key(),
                "beat": node.heartbeat_topic()?.as_str(),
                "advertised": &opts.endpoints,
                "seconds": seconds,
            })
        );
    } else {
        println!(
            "watching transport={} peer={} kind={} beat=amos/{}/telemetry/beat advertising={} {}s{}",
            node.transport_name(),
            node.peer(),
            node.kind().key(),
            node.peer(),
            advertised_summary(&opts.endpoints),
            seconds,
            clock_caveat(node.clock().synced())
        );
    }

    let deadline = deadline_after(Duration::from_secs(seconds))?;
    let mut ticker = tokio::time::interval(period);
    let mut seen = 0u64;
    // Per-publisher beat accounting: a jump in a peer's own heartbeat counter means this
    // node **missed** beats — the liveness view would otherwise show only "some beats".
    let mut beats_seq = SeqTracker::new();
    // Bounded by `--seconds`: an inspection window, not a daemon.
    while Instant::now() < deadline {
        tokio::select! {
            received = beats.recv_beat() => {
                let received = received.context("the heartbeat subscription closed")?;
                seen += 1;
                // The beat's own age, measured **before** the payload is moved out of the frame,
                // and through the same rule as every other age: a beat stamped ahead of this
                // clock says so instead of reading `age=0ms` (that saturation is what
                // `Timestamp::since` does for a backwards clock; `0` reads as "just now").
                let age_ms = frame_age_ms(&received.stamp, &amos_link::codec::Timestamp::now());
                let age = match age_ms {
                    Ok(ms) => format_age_ms(ms),
                    Err(unknown) => format!("unknown({})", unknown.detail()),
                };
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
                            // A number **or `null`**: an age that cannot be stated is not `0`.
                            "age_ms": age_ms.ok(),
                            "missed": missed,
                        })
                    );
                } else {
                    println!(
                        "beat  peer={} seq={} uptime={}ms age={} missed={}",
                        beat.peer, beat.seq, beat.uptime_ms, age, missed
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
                            "beats_untracked": beats_seq.untracked(),
                            "beat_tracking": if beats_seq.is_complete() { "complete" } else { "full" },
                            // What this node announces about itself, in the same document as
                            // the peers it can see: an operator asking "who is on the link"
                            // needs both directions, and a script that reads only `peers`
                            // would otherwise never learn that this node advertises no
                            // address at all (the default).
                            "advertised": &opts.endpoints,
                            // The verdict in the same shape the status documents use: a `state`
                            // plus the reason tokens (`decode_errors=3`). It used to be a bare
                            // string here and a `{"reasons":[…]}` object in `status`, so one
                            // verdict had two spellings in the same CLI.
                            "health": health_json_labeled(
                                health.label(),
                                &health
                                    .reasons()
                                    .iter()
                                    .map(amos_link::health::HealthReason::detail)
                                    .collect::<Vec<String>>(),
                            ),
                        })
                    );
                } else {
                    println!(
                        "link  peer={} uptime={}ms clock_synced={} peers={} published={} \
                         delivered={} dropped={} blocked={} decode_errors={} beats_seen={} \
                         beats_missing={} beats_untracked={} tracking={} health={}",
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
                        beats_seq.untracked(),
                        if beats_seq.is_complete() {
                            "complete"
                        } else {
                            "full"
                        },
                        health.summary()
                    );
                }
            }
        }
    }

    heartbeat.stop().await;
    federation.stop().await;
    let status = node.status().await;
    // The verdict, folded once more over the **whole** window. A `watch` run prints it on every
    // status tick too, but a tick is a *moment*: the first one can fire before this node's own
    // first beat goes out (the ticker's first tick is immediate), and at that instant there is no
    // evidence yet — so the tick's verdict is `unknown`, which is correct for that moment and
    // misleading as the run's conclusion. The summary carries the numbers the run actually
    // produced, and its verdict is computed from them (`docs/amos-link.md` §3.19).
    let health = LinkHealth::evaluate(
        &status.metrics,
        &status.peers,
        status.clock_synced,
        Some(&beats_seq.summary()),
    );
    if opts.json {
        println!(
            "{}",
            serde_json::json!({
                "event": "summary",
                "watched_s": seconds,
                "beats_published": node.heartbeat_seq(),
                "beats_seen": seen,
                "beats_missing": beats_seq.summary().missing,
                "peers": status.peers.len(),
                "dropped": status.metrics.dropped,
                "decode_errors": status.metrics.decode_errors,
                "advertised": &opts.endpoints,
                // The verdict over the whole window, in the same shape the status documents use
                // (`state` + reason tokens) — the summary is the line an operator greps, and a
                // `watch` run whose last tick fired before its own first beat would otherwise end
                // on `unknown`.
                "health": health_json_labeled(
                    health.label(),
                    &health
                        .reasons()
                        .iter()
                        .map(amos_link::health::HealthReason::detail)
                        .collect::<Vec<String>>(),
                ),
            })
        );
    } else {
        println!(
            "watched {}s: beats_published={} beats_seen={} beats_missing={} peers={} dropped={} \
             decode_errors={} advertising={} health={}",
            seconds,
            node.heartbeat_seq(),
            seen,
            beats_seq.summary().missing,
            status.peers.len(),
            status.metrics.dropped,
            status.metrics.decode_errors,
            advertised_summary(&opts.endpoints),
            health.summary()
        );
    }
    Ok(())
}

/// How this node's own advertisement reads in a terminal.
///
/// A node that announces nothing says so **in words**: a blank column would leave an operator
/// unable to tell "this build advertises no address" from "the line forgot to print it" — the
/// same reason `topics` prints `(no traffic yet …)` instead of nothing, and the reason
/// `peers (0): (nobody else is fresh on this link)` exists at all.
fn advertised_summary(endpoints: &[String]) -> String {
    if endpoints.is_empty() {
        "none (no address announced)".to_string()
    } else {
        endpoints.join(" ")
    }
}

/// The one clause that qualifies every age this CLI prints.
///
/// [`Received::age()`](amos_link::pubsub::Received::age) says the node "reports `clock_synced`
/// beside it" — this is that, on the lines where an age actually appears: an age is measured
/// against **this** clock, so without a calibration it is a *bound*, exactly like the latency
/// figures `status` flags. Empty when the clock is calibrated, so a healthy line is unchanged.
fn clock_caveat(clock_synced: bool) -> String {
    if clock_synced {
        String::new()
    } else {
        " · clock_synced=false: ages are bounds, not measurements (amos-timesync has not calibrated this clock)"
            .to_string()
    }
}

/// The pure command: agent JSON → validated intent → motor frames → a bus.
///
/// The bus is the mock unless the operator names a real one with `--device`: the same frames
/// then go to a Unix socket a controller listens on, or to a character device (a serial/UART
/// port). Either way the last line reports what the *bus* accepted — `apply` returns the count
/// it really wrote, so the number is a measurement in both cases (docs/amos-link.md §3.1).
async fn run_motor(opts: &Opts) -> Result<()> {
    let action = opts
        .action
        .as_deref()
        .context("`motor` needs --action '<json>'")?;
    let command = parse_command(action).map_err(|e| anyhow::anyhow!("{e}"))?;
    let frames = plan(&command);
    if !opts.json {
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
    }

    // One `apply()` for both buses, so the reported count is always what the *bus* accepted
    // (`MockRobotHal` counts what it stored, a real one what it wrote) — never the plan size.
    let (hal_name, armed, applied) = match opts.device.as_deref() {
        // The default: a mock bus, so the reported line still comes from a real `apply()`.
        None => {
            let hal = MockRobotHal::new();
            let applied = hal
                .apply(&frames)
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            (hal.name(), hal.armed(), applied)
        }
        Some(path) => {
            let hal = open_motor_bus(path).await?;
            let applied = hal
                .apply(&frames)
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            (hal.name(), hal.armed(), applied)
        }
    };
    if opts.json {
        println!(
            "{}",
            serde_json::json!({
                "action": action,
                "gait": command.gait.key(),
                "speed": command.speed,
                "duration_ms": command.duration_ms,
                "frames": frames.iter().map(frame_json).collect::<Vec<_>>(),
                "applied": applied,
                "hal": hal_name,
                "armed": armed,
                // `null` = the mock bus. A real bus is named by its path, so a reader can
                // tell "nothing was sent anywhere" from "frames went to a device".
                "device": opts.device.as_deref().map(|path| path.display().to_string()),
            })
        );
        return Ok(());
    }
    match opts.device.as_deref() {
        None => println!("applied {applied} frame(s) to hal={hal_name} armed={armed}"),
        Some(path) => println!(
            "applied {applied} frame(s) to hal={hal_name} armed={armed} at {}",
            path.display()
        ),
    }
    Ok(())
}

/// One motor frame as JSON — the machine form of [`render_frame`]: the joint address
/// decoded, the operation, the raw argument, and the exact bytes that go to the bus.
fn frame_json(frame: &MotorFrame) -> serde_json::Value {
    serde_json::json!({
        "joint": frame.joint.index(),
        "leg": frame.joint.leg(),
        "part": frame.joint.part(),
        "op": frame.op,
        "arg": frame.arg,
        "hex": frame.encode_hex(),
    })
}

/// Open the operator's motor bus as a byte sink the HAL can write frames to.
///
/// Two shapes are real on a robot, and the path says which one it is: a **Unix socket** a
/// controller daemon listens on (`connect`), or a **character device** — a serial/UART port or
/// a PTY — which is opened read-write. Everything else (a regular file, a directory) is refused
/// by the OS with an error that names the path, which is the honest outcome: silently creating
/// a file called `/dev/ttyUSB0` is not a service.
///
/// Port parameters (baud, `raw` mode) are **not** set here — see `StreamRobotHal::open_device`
/// for why: a CLI that reconfigures a bus someone else may own is worse than one that writes
/// what it was given.
#[cfg(unix)]
async fn open_motor_bus(path: &Path) -> Result<Box<dyn RobotHal>> {
    use std::os::unix::fs::FileTypeExt;

    let metadata = tokio::fs::metadata(path)
        .await
        .with_context(|| format!("opening the motor bus {}", path.display()))?;
    if metadata.file_type().is_socket() {
        let hal = StreamRobotHal::connect_unix(path)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        return Ok(Box::new(hal));
    }
    let hal = StreamRobotHal::open_device(path)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(Box::new(hal))
}

/// On a platform with no Unix sockets there is no motor bus this CLI can open: say so rather
/// than pretend the device was written to.
#[cfg(not(unix))]
async fn open_motor_bus(path: &Path) -> Result<Box<dyn RobotHal>> {
    bail!(
        "--device `{}` is only supported on Unix (the motor bus is a socket or a device file)",
        path.display()
    )
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
    fn arguments_that_would_panic_or_abort_are_refused_as_usage_errors() {
        // `--seconds` reaches `Instant + Duration`, which panics on overflow: a window the
        // platform clock cannot represent must be an exit-2 message, never a crash.
        let err = parse_from(["discover", "--bus", "--seconds", "18446744073709551615"])
            .expect_err("an unrepresentable window must be refused");
        assert!(
            err.contains("beyond what this platform's clock can represent"),
            "got: {err}"
        );
        // A window every platform can represent still parses.
        assert_eq!(
            parse_from(["discover", "--bus", "--seconds", "9"])
                .expect("parse")
                .seconds,
            9
        );

        // `--size` above the wire ceiling would make every publish of a `bench` run fail:
        // refuse the argument instead of running a benchmark that cannot publish.
        let over = parse_from(["bench", "--size", &(MAX_BENCH_PAYLOAD + 1).to_string()])
            .expect_err("a payload above the ceiling must be refused");
        assert!(over.contains("exceeds the"), "got: {over}");
        assert!(
            over.contains(&MAX_BENCH_PAYLOAD.to_string()),
            "the refusal names the ceiling it applied, got: {over}"
        );
        // …while the ceiling itself is legal (the bound is inclusive, and the CLI says so
        // by accepting it).
        assert_eq!(
            parse_from(["bench", "--size", &MAX_BENCH_PAYLOAD.to_string()])
                .expect("the ceiling is inside the bound")
                .size,
            MAX_BENCH_PAYLOAD
        );
        assert_eq!(
            parse_from(["bench", "--size", "4096"]).expect("parse").size,
            4096
        );
    }

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
        assert!(!o.help);

        // `--qos` belongs to the two subscription commands: `pub` has no profile to read it
        // into, so it is refused there instead of being ignored (see the scope table).
        let sub = parse_from([
            "sub",
            "--pattern",
            "amos/dog1/control/**",
            "--qos",
            "control",
        ])
        .expect("parse");
        assert_eq!(sub.qos, Some(Qos::control()));

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
            "--endpoint",
            "--help",
            "--version",
        ] {
            assert!(
                USAGE.contains(flag),
                "{flag} is accepted by the parser but missing from USAGE"
            );
        }
        for command in [
            "status", "topics", "pub", "sub", "bench", "discover", "watch", "motor", "state",
        ] {
            assert!(USAGE.contains(command), "{command} is missing from USAGE");
        }
    }

    /// The CLI's own announcement, observed by **another node's peer table**.
    ///
    /// Added because a negative control passed: making `start_federation` pass an empty list
    /// left every process-level "the CLI announces `tcp/…`" assertion green, since those lines
    /// print `opts.endpoints` — what the operator typed, not what the node emits. A process
    /// with one node cannot see its own beacons (a node is never its own peer), so this test
    /// puts two nodes on one shared broker — the same shape `crates/amos-link`'s federation e2e
    /// uses — and asks the **peer** what this node announced.
    #[tokio::test]
    async fn the_cli_announces_the_endpoint_the_operator_gave() {
        use amos_link::broker::Broker;
        use amos_link::codec::Clock;
        use amos_link::metrics::LinkMetrics;

        let opts = parse_from([
            "watch",
            "--peer",
            "dog1",
            "--kind",
            "robot",
            "--endpoint",
            "tcp/10.0.0.7:7447,udp/239.0.0.1:7446",
        ])
        .expect("a watch node that advertises two endpoints");

        let metrics = Arc::new(LinkMetrics::new());
        let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();
        let clock = Arc::new(Clock::host());
        let node = Arc::new(LinkNode::with_parts(
            PeerId::new(opts.peer.clone()).expect("peer"),
            opts.kind,
            Arc::clone(&transport),
            Arc::clone(&clock),
            Arc::clone(&metrics),
        ));
        let peer = Arc::new(LinkNode::with_parts(
            PeerId::new("mini-brain").expect("peer"),
            NodeKind::Brain,
            transport,
            clock,
            metrics,
        ));

        let task = start_federation(&node, Duration::from_millis(20), &opts).expect("announce");
        let peer_task = peer
            .spawn_federation(Duration::from_millis(20))
            .expect("listen");

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(view) = peer
                .peers()
                .await
                .iter()
                .find(|p| p.info.id.as_str() == "dog1")
                .cloned()
            {
                assert_eq!(
                    view.info.endpoints,
                    vec![
                        "tcp/10.0.0.7:7447".to_string(),
                        "udp/239.0.0.1:7446".to_string()
                    ],
                    "the endpoint the operator typed reached the wire"
                );
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "no beacon from the CLI's node arrived"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        task.stop().await;
        peer_task.stop().await;
    }

    /// One received frame as a `Received<AgentAction>` **built by a real publish/receive** on a
    /// shared broker, so a test can hand the renderers a frame stamped by a chosen clock.
    async fn received_with_clock(
        stamp_clock: Arc<amos_link::codec::Clock>,
    ) -> Received<AgentAction> {
        use amos_link::broker::Broker;
        use amos_link::metrics::LinkMetrics;

        let metrics = Arc::new(LinkMetrics::new());
        let transport = Broker::with_metrics(Arc::clone(&metrics)).shared();
        let publisher_node = Arc::new(LinkNode::with_parts(
            PeerId::new("dog1").expect("peer"),
            NodeKind::Robot,
            Arc::clone(&transport),
            stamp_clock,
            Arc::clone(&metrics),
        ));
        let subscriber_node = Arc::new(LinkNode::with_parts(
            PeerId::new("mini-brain").expect("peer"),
            NodeKind::Brain,
            transport,
            Arc::new(amos_link::codec::Clock::host()),
            metrics,
        ));
        let mut sub = subscriber_node
            .subscriber::<AgentAction>(
                Topic::pattern("amos/dog1/control/*").expect("pattern"),
                Qos::control(),
            )
            .await
            .expect("subscribe");
        publisher_node
            .publisher::<AgentAction>(Topic::new("amos/dog1/control/action").expect("topic"))
            .publish(&AgentAction::new(r#"{"action":"stand"}"#))
            .await
            .expect("publish");
        tokio::time::timeout(Duration::from_secs(2), sub.recv())
            .await
            .expect("a frame arrives")
            .expect("recv")
    }

    /// **The defect this round is about**: a frame whose stamp is *ahead* of this clock has no
    /// measurable age, and the renderers must say so instead of printing `0`.
    ///
    /// The primitive stays as it is: `Timestamp::since` saturates to `ZERO` for a backwards
    /// clock (a duration, not a measurement). The defect was that the *renderers* presented
    /// that saturation as an age — `age=0ms` / `age_ms: 0` / a `0 µs` bench sample — while the
    /// very same CLI already refused to do that for a *report* (`state`, `status --socket`,
    /// round 11). One fact, two answers; this pins the one answer.
    #[tokio::test]
    async fn a_frame_stamped_in_the_future_has_no_age_to_print() {
        use amos_link::codec::{Clock, Timestamp};

        // The publisher's clock is 5 s **ahead** of the reader's: what two uncalibrated boards
        // look like, and what a clock stepping backwards mid-run looks like locally.
        let ahead = Arc::new(Clock::host());
        let target = std::time::UNIX_EPOCH
            + Duration::from_secs(Timestamp::now().secs + 5)
            + Duration::from_millis(500);
        ahead
            .apply(target)
            .expect("calibrate the publisher's clock ahead");
        assert!(ahead.synced(), "the injected clock is a calibrated one");
        let received = received_with_clock(ahead).await;

        // The primitive saturates…
        assert_eq!(
            received.age(),
            Duration::ZERO,
            "Timestamp::since folds a future stamp to zero (that part is by design)"
        );
        // …and the rule the renderers use does not.
        assert!(
            matches!(
                frame_age_ms(&received.stamp, &Timestamp::now()),
                Err(AgeUnknown::InTheFuture(_))
            ),
            "a stamp ahead of this clock is not an age"
        );

        let line = received_line(&received, &Timestamp::now());
        assert!(
            line.contains("age=unknown(stamp is ") && line.contains("in the future"),
            "the human line states the unknown instead of `age=0ms`: {line}"
        );
        assert!(
            !line.contains("age=0ms"),
            "`0ms` was the lie (it reads as \"just now\"): {line}"
        );

        let value = received_json(&received, &Timestamp::now());
        assert_eq!(
            value["age_ms"],
            serde_json::Value::Null,
            "the machine form carries null, never 0: {value}"
        );
    }

    /// The **other half** of the same rule: an age that *can* be measured is still a number,
    /// and a frame stamped at the epoch is a huge-but-real age (a publisher whose clock was
    /// never set) — not an "unknown", because that sentinel belongs to the *report* path, where
    /// the proto spells "absent" as `0`.
    #[tokio::test]
    async fn a_measurable_age_is_still_a_number_and_the_epoch_is_not_absent() {
        use amos_link::codec::Timestamp;

        let received = received_with_clock(Arc::new(amos_link::codec::Clock::host())).await;
        let value = received_json(&received, &Timestamp::now());
        assert!(
            value["age_ms"].is_number(),
            "a frame published just now has a real age: {value}"
        );

        // A frame header is never "absent": `stamp = 0` means the epoch, and the age is what it
        // is (a clock that was never set is worth seeing, not hiding).
        let mut epoch = received;
        epoch.stamp = Timestamp::new(0, 0).expect("epoch");
        assert!(matches!(
            frame_age_ms(&epoch.stamp, &Timestamp::now()),
            Ok(ms) if ms > 1_000_000_000
        ));
        let line = received_line(&epoch, &Timestamp::now());
        assert!(
            !line.contains("unknown"),
            "the epoch is an age, not an absence: {line}"
        );

        // …while the report path keeps its own sentinel policy on the same rule.
        assert!(matches!(report_age_ms(0, 1_000), Err(AgeUnknown::NoStamp)));
        assert!(matches!(
            report_age_ms(5_000, 1_000),
            Err(AgeUnknown::InTheFuture(4_000))
        ));
    }

    /// `bench`'s classifier: a skewed frame is **counted, not sampled** — folding it in as
    /// `0 µs` made the percentiles better than the link, which is the one direction a
    /// measurement must never lie in.
    #[test]
    fn a_benchmark_never_counts_an_unmeasurable_frame_as_zero_latency() {
        use amos_link::codec::Timestamp;

        let frame = |secs: u64| Received {
            message: BenchFrame {
                seq: 1,
                payload: vec![0u8; 8],
            },
            topic: Topic::new("amos/dog1/telemetry/bench").expect("topic"),
            publisher: PeerId::new("dog1").expect("peer"),
            seq: 1,
            stamp: Timestamp::new(secs, 0).expect("stamp"),
            frame_len: 32,
        };
        let now = Timestamp::now();

        let mut latencies: Vec<u128> = Vec::new();
        let mut skewed = 0u64;
        // One frame from 2 s ago (measurable) and one from *next year* (not measurable).
        sample(&frame(now.secs - 2), &now, &mut latencies, &mut skewed);
        sample(
            &frame(now.secs + 31_536_000),
            &now,
            &mut latencies,
            &mut skewed,
        );
        assert_eq!(skewed, 1, "the future frame is not a sample");
        assert_eq!(latencies.len(), 1, "…and it did not enter as 0 µs");
        assert!(
            latencies[0] >= 1_500_000,
            "the sample that did land is the real ~2 s: {latencies:?}"
        );

        // The report says both: the percentiles of what was measurable, and the count excluded.
        let json = latency_json(&mut latencies);
        assert_eq!(json["samples"], 1);
        assert!(json["p50"].as_u64().unwrap_or(0) >= 1_500_000, "{json}");
        let line = latency_line(&latencies, skewed);
        assert!(line.contains("(n=1)"), "{line}");
        assert!(line.contains("1 frame(s) excluded"), "{line}");

        // A run where **every** stamp was ahead of this clock has no measurement at all: the
        // histogram is `null` and the line says why (not `min=0`, which would read as instant).
        assert_eq!(latency_json(&mut Vec::new()), serde_json::Value::Null);
        let empty: Vec<u128> = Vec::new();
        let line = latency_line(&empty, 7);
        assert!(line.contains("none measurable"), "{line}");
        assert!(line.contains("7 frame(s) skewed"), "{line}");
        assert!(
            latency_line(&empty, 0).contains("no frame came back"),
            "an empty run says so instead of printing nothing"
        );
    }

    /// `bench` keeps its **microsecond** resolution: the first version of this round's fix
    /// routed it through the millisecond form and the histogram of a local run came out
    /// `min=0 p50=0 p99=0` (sub-millisecond samples truncated to zero — a *different* way of
    /// saying "instant" than the one being fixed). Found by running the binary, not by a test,
    /// so the test now exists.
    #[test]
    fn the_benchmark_histogram_keeps_its_microsecond_resolution() {
        use amos_link::codec::Timestamp;

        // The seam the regression was **in**: `sample()`, not the age helpers. (The first
        // version of this test called `frame_age_us` directly and therefore passed while
        // `sample()` was truncating every sub-millisecond sample to `0` — the name claimed
        // more than the assertions checked, found by a negative control that did not go red.)
        let frame_at = |stamp: Timestamp| Received {
            message: BenchFrame {
                seq: 1,
                payload: vec![0u8; 8],
            },
            topic: Topic::new("amos/dog1/telemetry/bench").expect("topic"),
            publisher: PeerId::new("dog1").expect("peer"),
            seq: 1,
            stamp,
            frame_len: 32,
        };
        let stamp_at = |ns: u128| {
            Timestamp::new(
                u64::try_from(ns / 1_000_000_000).expect("secs"),
                u32::try_from(ns % 1_000_000_000).expect("nanos"),
            )
            .expect("stamp")
        };

        // (1) A stamp 250 µs old is measurable and **not zero** at this resolution. The reader's
        // clock is pinned to a reading **inside** a millisecond (400 µs past the boundary), so
        // the sub-millisecond cases below are decided by the comparison itself rather than by
        // where `Timestamp::now()` happened to land — a first version used the live clock, and
        // the negative control that truncates the comparison to milliseconds was **flaky**
        // because of exactly that (red or green depending on the boundary).
        let base = Timestamp::now();
        let now = Timestamp::new(base.secs, 400_000).expect("a mid-millisecond reading");
        let mut latencies: Vec<u128> = Vec::new();
        let mut skewed = 0u64;
        sample(
            &frame_at(stamp_at(now.as_nanos() - 250_000)),
            &now,
            &mut latencies,
            &mut skewed,
        );
        assert_eq!(skewed, 0, "250 µs in the past is measurable");
        assert_eq!(latencies.len(), 1);
        assert!(
            (200..=400).contains(&latencies[0]),
            "a 250 µs age must survive into the histogram, got {:?}µs",
            latencies[0]
        );
        // …while the millisecond *figure* of the same age is 0 — which is why the sample may
        // not come from that form (`frame_age_ms × 1000` was the self-caught regression).
        assert_eq!(
            frame_age_ms(&frame_at(now).stamp, &now).expect("measurable"),
            0
        );

        // (2) A stamp **in the future**, even by half a millisecond, is not a sample at all:
        // the comparison is made in nanoseconds, so it cannot be truncated into a `0 µs`
        // reading — a millisecond comparison calls this stamp "now" (400 µs + 500 µs is still
        // inside the same millisecond) and subtracts it, i.e. hands the histogram a **wrapped**
        // sample (release) or panics on the subtraction (debug, overflow checks). The reader's
        // clock above is pinned to a mid-millisecond reading exactly so this case is
        // deterministic instead of boundary-dependent.
        let future = stamp_at(now.as_nanos() + 500_000);
        let mut latencies: Vec<u128> = Vec::new();
        let mut skewed = 0u64;
        sample(&frame_at(future), &now, &mut latencies, &mut skewed);
        assert_eq!(skewed, 1, "a future stamp is counted, not sampled");
        assert!(
            latencies.is_empty(),
            "…and never enters as 0: {latencies:?}"
        );
        // The human message for it rounds **up**, so it never says "0ms in the future".
        assert_eq!(
            frame_age_ms(&future, &now).expect_err("future").detail(),
            "stamp is 1ms in the future — that clock is not this clock"
        );
    }

    /// The subscription-profile rule, as data — the three branches `sub`, `state` and `hz` share.
    ///
    /// It lives in one function because it *was* two copies (round 18 found `sub` and `state`
    /// each spelling it out, and `hz` would have been the third): with two copies, a pattern
    /// subscribed to by `sub` and by `hz` could choose different profiles for the same channel.
    #[test]
    fn one_rule_chooses_the_profile_for_every_subscription_command() {
        let pattern = |s: &str| Topic::pattern(s.to_string()).expect("pattern");

        // An explicit `--qos` wins, and says so.
        let (qos, source) =
            subscription_qos(&pattern("amos/*/sensor/**"), Some(Qos::control()), None);
        assert_eq!(qos, Qos::control());
        assert_eq!(source, "--qos");

        // Otherwise the pattern's own channel decides — the safety-relevant case: a control
        // pattern must never default to the droppable sensor profile.
        let (qos, source) = subscription_qos(&pattern("amos/*/control/**"), None, None);
        assert_eq!(qos, Qos::control());
        assert_eq!(source, "channel control");
        let (qos, source) = subscription_qos(&pattern("amos/*/sensor/**"), None, None);
        assert_eq!(qos, Qos::sensor());
        assert_eq!(source, "channel sensor");

        // A pattern that names no channel falls back to the caller's documented default: the
        // sensor (latest-wins) profile for a general subscription…
        let (qos, source) = subscription_qos(&pattern("amos/**"), None, None);
        assert_eq!(qos, Qos::sensor());
        assert_eq!(source, "default (no channel in the pattern)");
        // …and `state`'s own channel for the command whose payload *is* a state report.
        let (qos, source) = subscription_qos(&pattern("amos/**"), None, Some(Channel::State));
        assert_eq!(qos, Qos::for_channel(Channel::State));
        assert_eq!(source, "channel state");
        // A pattern that *does* name a channel still wins over that default (`state` included):
        // one rule, not one rule per command.
        let (qos, source) =
            subscription_qos(&pattern("amos/*/control/**"), None, Some(Channel::State));
        assert_eq!(qos, Qos::control());
        assert_eq!(source, "channel control");
    }

    /// A rate that cannot be stated is `null` **with a reason** in the machine form — never `0`
    /// (which a script would read as "this stream stopped").
    #[test]
    fn a_rate_without_evidence_is_null_and_names_why() {
        let peer = PeerId::new("dog1").expect("peer");
        let topic = Topic::new("amos/dog1/sensor/imu").expect("topic");

        let unknown = rate_json(&StreamRate {
            publisher: peer.clone(),
            topic: topic.clone(),
            frames: 1,
            span: None,
            rate_hz: None,
        });
        assert_eq!(unknown["event"], "hz");
        assert_eq!(unknown["publisher"], "dog1");
        assert_eq!(unknown["frames"], 1);
        assert_eq!(unknown["span_ms"], serde_json::Value::Null);
        assert_eq!(unknown["rate_hz"], serde_json::Value::Null);
        assert_eq!(unknown["why"], "single-frame");

        let measurable = rate_json(&StreamRate {
            publisher: peer,
            topic,
            frames: 121,
            span: Some(Duration::from_secs(2)),
            rate_hz: Some(60.0),
        });
        assert_eq!(measurable["span_ms"], 2000);
        assert_eq!(measurable["rate_hz"], 60.0);
        assert_eq!(measurable["why"], serde_json::Value::Null);
    }

    /// Every command, in documentation order — so the scope tests below cannot silently skip
    /// a command that someone adds to `Cmd`.
    const ALL_COMMANDS: [Cmd; 10] = [
        Cmd::Status,
        Cmd::Topics,
        Cmd::Pub,
        Cmd::Sub,
        Cmd::Bench,
        Cmd::Discover,
        Cmd::Watch,
        Cmd::Motor,
        Cmd::State,
        Cmd::Hz,
    ];

    /// A value each flag accepts, so a refusal in the property test below is about *scope*
    /// and never about a bad value (which would make the test pass for the wrong reason).
    fn sample_value(flag: &str) -> Option<&'static str> {
        Some(match flag {
            "--json" | "--lan" | "--bus" => return None,
            "--peer" | "--static" => "dog1",
            "--kind" => "robot",
            "--transport" => "broker",
            "--topic" => "amos/dog1/control/joints",
            "--pattern" => "amos/**",
            "--action" => r#"{"action":"stand"}"#,
            "--text" => "hi",
            "--count" | "--seconds" | "--timeout-ms" | "--size" | "--hz" => "1",
            "--qos" => "control",
            "--socket" | "--device" => "/tmp/amos-link-cli-scope.sock",
            "--endpoint" => "tcp/10.0.0.7:7447",
            other => panic!("no sample value for {other}"),
        })
    }

    /// The property: **no flag is silently ignored**. For every command and every flag the
    /// parser accepts, parsing either succeeds (the command acts on it) or fails with a
    /// message naming both the flag and the command. There is no third outcome — which is
    /// what "silently ignored" would be, and what this round removed.
    #[test]
    fn no_flag_is_silently_ignored_on_any_command() {
        for cmd in ALL_COMMANDS {
            for flag in FLAGS {
                let mut argv = vec![cmd.key()];
                // `discover` reads `--transport` only for the `--bus` sweep, so name that
                // sweep here (before the flag, which takes the next argument as its value):
                // the offline/`--lan` refusal has its own test below. `--endpoint` is the same
                // shape — it needs a sweep that *announces* (`--lan`/`--bus`).
                if cmd == Cmd::Discover && matches!(*flag, "--transport" | "--endpoint") {
                    argv.push("--bus");
                }
                argv.push(flag);
                if let Some(value) = sample_value(flag) {
                    argv.push(value);
                }
                let parsed = parse_from(argv.clone());
                assert_eq!(
                    parsed.is_ok(),
                    honors(cmd, flag),
                    "{cmd:?} {flag}: parsed {parsed:?}"
                );
                if let Err(err) = parsed {
                    assert!(err.contains(flag), "the refusal names the flag: {err}");
                    assert!(
                        err.contains(cmd.key()),
                        "the refusal names the command: {err}"
                    );
                }
            }
        }
    }

    /// `--json` is the exception the rule needs: it means the same thing everywhere, so
    /// every command accepts it (a script can always ask for the machine form).
    #[test]
    fn every_command_accepts_json() {
        for cmd in ALL_COMMANDS {
            assert!(
                parse_from([cmd.key(), "--json"]).is_ok(),
                "`{}` must accept --json",
                cmd.key()
            );
        }
    }

    /// The scope table itself, written out as literals — because the property test above is
    /// satisfied *by construction*: it compares the parser against the very function the
    /// parser uses, so an `honors` that answered "yes" to everything would pass it (a
    /// negative control proved exactly that: making `--hz` universally honored left the
    /// property test green). These are the answers the docs promise, pinned as data:
    /// `(flag, a command that must refuse it, a command that must accept it)`.
    #[test]
    fn the_scope_table_refuses_what_the_docs_say_it_refuses() {
        let cases: &[(&str, &str, &str)] = &[
            ("--hz", "sub", "pub"),
            ("--pattern", "bench", "sub"),
            ("--topic", "topics", "pub"),
            ("--count", "watch", "bench"),
            ("--size", "status", "bench"),
            ("--qos", "pub", "state"),
            ("--lan", "watch", "discover"),
            ("--bus", "status", "discover"),
            ("--seconds", "status", "watch"),
            ("--timeout-ms", "pub", "sub"),
            ("--static", "status", "discover"),
            ("--device", "status", "motor"),
            // An announcement belongs to the commands that announce.
            ("--endpoint", "status", "watch"),
            ("--action", "sub", "motor"),
            ("--text", "motor", "pub"),
            // `motor` builds no node, so the node's identity flags mean nothing there.
            ("--peer", "motor", "status"),
            ("--kind", "motor", "status"),
            ("--transport", "motor", "status"),
        ];
        for (flag, refuses, accepts) in cases {
            let mut argv = vec![*refuses, flag];
            if let Some(value) = sample_value(flag) {
                argv.push(value);
            }
            let err = match parse_from(argv.clone()) {
                Err(err) => err,
                Ok(_) => panic!("{argv:?} must be refused"),
            };
            assert!(err.contains(flag), "the refusal names the flag: {err}");
            assert!(
                err.contains(refuses),
                "the refusal names the command: {err}"
            );

            let mut argv = vec![*accepts, flag];
            if let Some(value) = sample_value(flag) {
                argv.push(value);
            }
            assert!(
                parse_from(argv.clone()).is_ok(),
                "{argv:?} must be accepted"
            );
        }
    }

    /// `--count 0` used to *run*: `pub --count 0` published nothing, printed nothing and
    /// exited 0 — a silent no-op an operator cannot tell from a successful publish.
    #[test]
    fn a_count_of_zero_is_refused_instead_of_doing_nothing() {
        for cmd in ["pub", "sub", "bench", "state"] {
            let err = parse_from([cmd, "--count", "0"]).expect_err("--count 0 must be refused");
            assert!(err.contains("--count 0"), "got: {err}");
            assert!(err.contains(cmd), "the refusal names the command: {err}");
            // One frame is the smallest run that can report anything, and stays legal.
            assert!(parse_from([cmd, "--count", "1"]).is_ok());
        }
    }

    /// Remote mode answers with the **daemon's** node, so a flag that would configure this
    /// process's own node is refused rather than quietly ignored: `status --socket X --peer
    /// dog1` looks like a filter and filters nothing.
    #[test]
    fn remote_mode_refuses_flags_that_only_configure_a_local_node() {
        for (flag, value) in [
            ("--peer", "dog1"),
            ("--kind", "robot"),
            ("--transport", "broker"),
            // `watch --socket` streams the *daemon's* heartbeats: it announces nothing about
            // this process's node, so an advertisement here would be read by nobody.
            ("--endpoint", "tcp/10.0.0.7:7447"),
        ] {
            let cmd = if flag == "--endpoint" {
                "watch"
            } else {
                "status"
            };
            let err = parse_from([cmd, "--socket", "/tmp/amos-ai.sock", flag, value])
                .expect_err("a local-node flag must be refused in remote mode");
            assert!(err.contains(flag), "the refusal names the flag: {err}");
            assert!(
                err.contains("--socket"),
                "the refusal explains the mode: {err}"
            );
        }
        // What a remote run *does* read stays accepted.
        assert!(parse_from(["status", "--socket", "/tmp/amos-ai.sock", "--json"]).is_ok());
        assert!(parse_from([
            "pub",
            "--socket",
            "/tmp/amos-ai.sock",
            "--topic",
            "amos/dog1/control/joints",
            "--action",
            r#"{"action":"stand"}"#,
        ])
        .is_ok());
    }

    /// `discover --transport` only selects the link `--bus` federates over: a `--lan` sweep
    /// travels UDP beacons and an offline one a seeded table, so neither reads it.
    #[test]
    fn discover_only_reads_transport_for_the_bus_sweep() {
        assert!(parse_from(["discover", "--bus", "--transport", "broker"]).is_ok());
        for argv in [
            vec!["discover", "--transport", "broker"],
            vec!["discover", "--lan", "--transport", "broker"],
        ] {
            let err = parse_from(argv.clone()).expect_err("only --bus reads --transport");
            assert!(
                err.contains("--bus"),
                "the refusal says which sweep reads it: {err}"
            );
        }
    }

    /// `--endpoint` is what this node **says about itself** when it announces, so it needs a
    /// sweep that announces: the offline `discover` seeds a table of peers the operator named
    /// and publishes no beacon of its own.
    #[test]
    fn an_advertisement_needs_a_sweep_that_announces() {
        assert!(parse_from(["discover", "--bus", "--endpoint", "tcp/10.0.0.7:7447"]).is_ok());
        let err = parse_from(["discover", "--endpoint", "tcp/10.0.0.7:7447"])
            .expect_err("an offline sweep announces nothing");
        assert!(err.contains("announces nothing"), "got: {err}");
        assert!(err.contains("--lan"), "the refusal names the fix: {err}");
    }

    /// The advertisement is parsed once, from **every** `--endpoint` value joined with `,`, and
    /// bounded exactly like a beacon — so a repeated flag cannot slip past a per-value bound,
    /// and a value that could never be emitted is a usage error (exit 2) rather than a node
    /// that is invisible on the link.
    #[test]
    fn the_advertisement_is_bounded_where_the_operator_can_fix_it() {
        use amos_link::discovery::{MAX_ENDPOINTS, MAX_ENDPOINT_LEN};

        // Comma-separated in one value, and repeatable across flags: both become one list.
        let opts = parse_from([
            "watch",
            "--endpoint",
            "tcp/10.0.0.7:7447,udp/239.0.0.1:7446",
            "--endpoint",
            "tcp/10.0.0.9:7447",
        ])
        .expect("three endpoints in two flags");
        assert_eq!(
            opts.endpoints,
            vec![
                "tcp/10.0.0.7:7447".to_string(),
                "udp/239.0.0.1:7446".to_string(),
                "tcp/10.0.0.9:7447".to_string()
            ]
        );

        // …and `parse_endpoints`' own bound is applied to the *combined* list: one endpoint per
        // flag, `MAX_ENDPOINTS + 1` times, is refused (a per-value check would have passed
        // every one of them).
        let mut argv = vec!["watch".to_string()];
        for i in 0..=MAX_ENDPOINTS {
            argv.push("--endpoint".to_string());
            argv.push(format!("tcp/10.0.0.{i}:7447"));
        }
        let err = parse_from(argv).expect_err("the combined list is over the ceiling");
        assert!(err.contains(&format!("{MAX_ENDPOINTS}")), "got: {err}");

        // A single endpoint over `MAX_ENDPOINT_LEN` names the field, not the value.
        let long = format!("tcp/{}", "x".repeat(MAX_ENDPOINT_LEN));
        let err = parse_from(["watch", "--endpoint", &long]).expect_err("too long");
        assert!(err.contains("endpoint #1"), "got: {err}");

        // `--endpoint ''` is *no advertisement*, not an error (the same thing an empty
        // `$AMOS_LINK_ENDPOINT` means), and it is what the help text promises.
        let opts = parse_from(["watch", "--endpoint", ""]).expect("empty is legal");
        assert!(opts.endpoints.is_empty());
    }

    /// `status --socket` renders **the local document plus who answered**, not a second dialect.
    ///
    /// This is the anti-drift test the process-level one cannot be: it builds the kernel's own
    /// document (what `status` prints) and the remote builder's side by side, from the *same* facts,
    /// and requires every shared key to be equal. The defect it pins was exactly a shape split —
    /// `peers` as a number vs an array, `health` as a string vs an object, counters flat vs nested.
    #[test]
    fn the_remote_status_document_is_the_local_document_plus_who_answered() {
        use amos_link::discovery::{NodeKind as Kind, PeerId, PeerInfo, PeerView};
        use amos_link::health::{HealthReason, LinkHealth};
        use amos_link::metrics::MetricsSnapshot;
        use amos_link::telemetry::NodeStatus;
        use amos_proto::amos_link::Metrics as ProtoMetrics;

        // The same node, described twice: once as the kernel's document…
        let local = NodeStatus {
            peer: PeerId::new("amos-daemon").expect("peer"),
            kind: Kind::Robot,
            version: "0.1.0".to_string(),
            uptime_ms: 42_000,
            clock_synced: true,
            metrics: MetricsSnapshot {
                published: 9,
                delivered: 9,
                dropped: 1,
                blocked: 2,
                decode_errors: 3,
                encode_errors: 4,
            },
            health: LinkHealth::Degraded {
                reasons: vec![HealthReason::DecodeErrors { count: 3 }],
            },
            peers: vec![PeerView {
                info: PeerInfo::new(PeerId::new("dog1").expect("peer"), Kind::Robot)
                    .with_endpoint("udp/10.0.0.9:7446"),
                last_seen_ms: 12,
                beacons: 3,
            }],
            topics: vec!["amos/dog1/control/joints".to_string()],
            topics_complete: false,
        };
        let local_doc: serde_json::Value =
            serde_json::from_str(&local.to_json().expect("json")).expect("json");

        // …and once as what the daemon puts on the control plane.
        let wire = LinkStatus {
            peer: "amos-daemon".to_string(),
            kind: "robot".to_string(),
            version: "0.1.0".to_string(),
            uptime_ms: 42_000,
            clock_synced: true,
            metrics: Some(ProtoMetrics {
                published: 9,
                delivered: 9,
                dropped: 1,
                blocked: 2,
                decode_errors: 3,
                encode_errors: 4,
                peers: 1,
            }),
            peers: vec![ProtoPeer {
                id: "dog1".to_string(),
                kind: "robot".to_string(),
                endpoint: "udp/10.0.0.9:7446".to_string(),
                last_seen_ms: 12,
                beacons: 3,
            }],
            health: HealthState::HealthDegraded as i32,
            health_reasons: vec!["decode_errors=3".to_string()],
        };
        let topics = TopicList {
            topics: vec!["amos/dog1/control/joints".to_string()],
            complete: false,
        };
        let remote_doc = remote_status_json("/tmp/amos-ai.sock", &wire, &topics, Some(Vec::new()));

        // The remote document adds exactly two keys and subtracts none.
        let keys = |value: &serde_json::Value| -> Vec<String> {
            let mut keys: Vec<String> = value
                .as_object()
                .expect("an object")
                .keys()
                .cloned()
                .collect();
            keys.sort();
            keys
        };
        let mut expected = keys(&local_doc);
        expected.push("actuations".to_string());
        expected.push("remote".to_string());
        expected.sort();
        assert_eq!(keys(&remote_doc), expected);

        // Every shared key is *equal*, which is what makes the two documents one contract:
        // the peer table travels in the flat shape, the verdict in the control plane's words,
        // the counters nested, and the inventory with its own completeness flag.
        for key in [
            "peer",
            "kind",
            "version",
            "uptime_ms",
            "clock_synced",
            "metrics",
            "health",
            "peers",
            "topics",
            "topics_complete",
        ] {
            assert_eq!(
                remote_doc[key], local_doc[key],
                "`{key}` must be the same fact in the same shape"
            );
        }
        assert_eq!(remote_doc["remote"], "/tmp/amos-ai.sock");
    }

    /// The peer table as JSON — **one** spelling, the control plane's (`proto.Peer`).
    ///
    /// The sweep and the status document both go through it, and the kernel's own document was
    /// changed to match, so `discover --json`, `status`, `status --socket` and the System UI all
    /// name a peer the same way: `id`, `kind`, `endpoint`, `last_seen_ms`, `beacons`.
    #[test]
    fn the_peer_table_renders_as_json() {
        let now = amos_link::codec::Timestamp::now();
        let mut registry = PeerRegistry::with_local(
            Duration::from_secs(3),
            PeerId::new("self-node").expect("peer"),
        );
        registry.learn(
            PeerInfo::new(PeerId::new("dog1").expect("peer"), NodeKind::Robot),
            now,
        );
        // A peer that announced an endpoint, and one that did not.
        let mut announced =
            PeerInfo::new(PeerId::new("cam-front").expect("peer"), NodeKind::Sensor);
        announced.endpoints.push("udp/10.0.0.9:7446".to_string());
        registry.learn(announced, now);

        let views = registry.peers(now);
        let rows: Vec<PeerRow> = views.iter().map(PeerRow::from_view).collect();
        let json = peers_json(&rows);
        assert_eq!(json.len(), 2);
        let dog = json
            .iter()
            .find(|row| row["id"] == "dog1")
            .expect("dog1 listed");
        assert_eq!(
            dog,
            &serde_json::json!({
                "id": "dog1",
                "kind": "robot",
                "endpoint": serde_json::Value::Null,
                "last_seen_ms": dog["last_seen_ms"],
                "beacons": 0,
            }),
            "an unannounced endpoint is `null` (never the human `-`), and 0 beacons means static"
        );
        let cam = json
            .iter()
            .find(|row| row["id"] == "cam-front")
            .expect("cam-front listed");
        assert_eq!(cam["endpoint"], "udp/10.0.0.9:7446");

        // The sweep document carries its own limits beside the table.
        let doc = discovery_json(
            "mock",
            Some(Duration::from_secs(3)),
            None,
            &views,
            registry.self_entries_refused(),
            None,
        );
        assert_eq!(doc["discovery"], "mock");
        assert_eq!(doc["ttl_ms"], 3_000);
        assert_eq!(doc["peers"].as_array().map(Vec::len), Some(2));
        assert!(
            doc.get("seconds").is_none(),
            "an offline sweep has no listening window to report"
        );
    }

    /// A row built from the control plane's `Peer` follows the proto's **sentinels**: an empty
    /// endpoint string means "none announced" (JSON `null`, never `""`), and a kind this build does
    /// not know still names the peer (`unknown`) instead of dropping the row or guessing.
    ///
    /// Both are "a newer daemon said something this build has not heard of" cases — the shape the
    /// repo keeps auditing (`an unknown reason is not invented`, `an unknown enum bit is not
    /// guessed`). A peer is *evidence that a machine is out there*: losing the row because its role
    /// is unfamiliar would be a worse lie than the word `unknown`.
    #[test]
    fn a_row_from_the_control_plane_follows_the_protos_sentinels() {
        let newer = ProtoPeer {
            id: "rover7".to_string(),
            kind: "quadruped".to_string(),
            endpoint: String::new(),
            last_seen_ms: 9,
            beacons: 2,
        };
        let row = PeerRow::from_proto(&newer);
        assert_eq!(row.id, "rover7");
        assert_eq!(
            row.kind, "unknown",
            "an unfamiliar role is named, not guessed"
        );
        assert_eq!(
            row.endpoint, None,
            "`\"\"` is the proto's \"none\", not an address"
        );
        assert_eq!(
            row.to_json(),
            serde_json::json!({
                "id": "rover7",
                "kind": "unknown",
                "endpoint": serde_json::Value::Null,
                "last_seen_ms": 9,
                "beacons": 2,
            })
        );

        // …and a kind this build *does* know travels verbatim (the wire's own spelling).
        let known = ProtoPeer {
            kind: "sensor".to_string(),
            endpoint: "udp/10.0.0.9:7446".to_string(),
            ..newer
        };
        let row = PeerRow::from_proto(&known);
        assert_eq!(row.kind, "sensor");
        assert_eq!(row.endpoint.as_deref(), Some("udp/10.0.0.9:7446"));
    }

    /// A report is **dated** in both forms — and an unusable stamp says so instead of producing a
    /// number that looks like a measurement.
    ///
    /// Why this is not cosmetic: the return path's whole point is `armed` / `estopped` / `gait`,
    /// i.e. *safety claims about right now*. The JSON carried `stamp_ms` (a timestamp the reader
    /// must do clock math on, and only if it knows the local clock), the human form carried
    /// nothing at all — so `state` and `status --socket` both printed a robot's mode with no way
    /// to tell a 2-second-old report from a 2-hour-old one. The same shape was fixed for the
    /// System UI panel in REQ-A246 ("a reading has no expiry of its own") and for the peer table
    /// (`last_seen_ms`); the *report* kept its age to itself.
    ///
    /// The two stamp cases that cannot yield an age are named rather than folded into `0ms`:
    /// a missing stamp, and one **in the future** (the robot's clock is not this clock — the
    /// visible symptom of two unsynchronised clocks, which is exactly when an age would be a
    /// guess).
    #[test]
    fn a_report_is_dated_and_an_unusable_stamp_says_so() {
        use amos_link::codec::Timestamp;
        use amos_link::robot_hal::{ActuationState, Gait};

        let trotting = ActuationState {
            seq: Some(2),
            gait: Some(Gait::Trot),
            frames: 13,
            armed: true,
            estopped: false,
            estop_reason: None,
            watchdog_ms: Some(1000),
            last_refusal: None,
        };
        let frame = |stamp_ms: u64| {
            let stamp = Timestamp::new(stamp_ms / 1000, ((stamp_ms % 1000) * 1_000_000) as u32)
                .expect("timestamp");
            let received = Received {
                message: trotting.clone(),
                topic: Topic::new("amos/dog1/state/actuation").expect("topic"),
                publisher: PeerId::new("dog1").expect("peer"),
                seq: 1,
                stamp,
                frame_len: 0,
            };
            state_lines(&received, false)
        };

        // A three-hour-old report is named as three hours old (the format is `h mm`; the test's
        // own runtime is milliseconds, so the minute field cannot roll over here).
        let old = frame(Timestamp::now().unix_ms() - 3 * 3_600_000);
        assert_eq!(old.len(), 1, "no refusal was reported");
        assert!(old[0].contains("age=3h 00m"), "got: {}", old[0]);

        // A just-published report is in the millisecond range.
        let fresh = frame(Timestamp::now().unix_ms() - 250);
        assert!(
            fresh[0].contains("ms"),
            "a fresh report is dated in ms: {}",
            fresh[0]
        );

        // An epoch-zero stamp is not "56 years old": it is *no stamp*, and says so.
        let unstamped = frame(0);
        assert!(
            unstamped[0].contains("age=unknown(no stamp)"),
            "got: {}",
            unstamped[0]
        );

        // A stamp in the future is a clock skew, not a negative age.
        let skewed = frame(Timestamp::now().unix_ms() + 5_000);
        assert!(
            skewed[0].contains("age=unknown(stamp is 5000ms in the future"),
            "got: {}",
            skewed[0]
        );
    }

    /// The machine form gets the same fact as a number — and `null` where a number would be a lie
    /// (an absent age is not "instant").
    #[test]
    fn the_machine_form_carries_the_age_as_a_number_or_null() {
        use amos_link::codec::Timestamp;
        use amos_link::robot_hal::{ActuationState, Gait};

        let report = ActuationState {
            seq: Some(2),
            gait: Some(Gait::Trot),
            frames: 13,
            armed: true,
            estopped: false,
            estop_reason: None,
            watchdog_ms: Some(1000),
            last_refusal: None,
        };
        let frame = |stamp: Timestamp| Received {
            message: report.clone(),
            topic: Topic::new("amos/dog1/state/actuation").expect("topic"),
            publisher: PeerId::new("dog1").expect("peer"),
            seq: 1,
            stamp,
            frame_len: 0,
        };
        let stamp_at =
            |ms: u64| Timestamp::new(ms / 1_000, ((ms % 1_000) * 1_000_000) as u32).expect("stamp");
        let now_ms = Timestamp::now().unix_ms();

        let fresh = state_lines(&frame(stamp_at(now_ms - 250)), true);
        let value: serde_json::Value = serde_json::from_str(&fresh[0]).expect("json");
        let age = value["age_ms"].as_u64().expect("a fresh report has an age");
        assert!(
            (250..60_000).contains(&age),
            "≈a quarter second, got {age}: {}",
            fresh[0]
        );
        assert!(
            value["stamp_ms"].as_u64().is_some(),
            "the raw stamp stays too: {}",
            fresh[0]
        );

        // …and the two unusable cases are `null`, never `0`.
        let unstamped = state_lines(&frame(Timestamp::new(0, 0).expect("stamp")), true);
        let value: serde_json::Value = serde_json::from_str(&unstamped[0]).expect("json");
        assert_eq!(
            value["age_ms"],
            serde_json::Value::Null,
            "no stamp ⇒ no age, and not `0`: {}",
            unstamped[0]
        );
        let future = state_lines(&frame(stamp_at(now_ms + 60_000)), true);
        let value: serde_json::Value = serde_json::from_str(&future[0]).expect("json");
        assert_eq!(
            value["age_ms"],
            serde_json::Value::Null,
            "a future stamp ⇒ no age: {}",
            future[0]
        );
    }

    /// `sub`'s loss figures name the **stream** they came from, not just the total.
    ///
    /// A sequence number belongs to one publisher on one topic (§3.13), and `sub --pattern
    /// 'amos/**'` can cover dozens of streams: `missing=3` alone leaves the operator asking "the
    /// IMU or the camera?". One line per lossy stream, in key order (publisher, then topic), so two
    /// runs of the same link print the same lines.
    #[test]
    fn the_loss_figures_name_the_stream_that_lost_frames() {
        let stream = |publisher: &str, topic: &str| {
            StreamKey::new(
                PeerId::new(publisher).expect("peer"),
                Topic::new(topic).expect("topic"),
            )
        };
        assert!(
            loss_stream_lines(&[]).is_empty(),
            "a clean run prints nothing extra"
        );
        let lines = loss_stream_lines(&[
            (stream("cam-front", "amos/cam-front/sensor/camera"), 5, 2),
            (stream("dog1", "amos/dog1/sensor/imu"), 2, 1),
        ]);
        assert_eq!(
            lines,
            vec![
                "lost peer=cam-front topic=amos/cam-front/sensor/camera missing=5 in 2 gap(s)",
                "lost peer=dog1 topic=amos/dog1/sensor/imu missing=2 in 1 gap(s)",
            ]
        );
    }

    /// The age format, exactly: milliseconds below a second, then the same `s`/`m`/`h`/`d` shape
    /// the System UI's `formatUptime` uses, so a terminal and the panel describe an age alike.
    #[test]
    fn the_age_format_is_shared_with_the_panel() {
        assert_eq!(format_age_ms(0), "0ms");
        assert_eq!(format_age_ms(250), "250ms");
        assert_eq!(format_age_ms(999), "999ms");
        assert_eq!(format_age_ms(1_000), "1s");
        assert_eq!(format_age_ms(45_000), "45s");
        assert_eq!(format_age_ms(125_000), "2m 05s");
        assert_eq!(format_age_ms(3 * 3_600_000), "3h 00m");
        assert_eq!(format_age_ms(3 * 3_600_000 + 4 * 60_000), "3h 04m");
        assert_eq!(format_age_ms(2 * 86_400_000 + 3 * 3_600_000), "2d 03h");
    }

    /// One motor frame as JSON: the same bytes the human line prints, plus the joint address
    /// decoded, so a script never has to parse hex to find out which joint it is.
    #[test]
    fn a_motor_frame_renders_as_json_with_the_same_bytes() {
        let command = parse_command(r#"{"action":"stand"}"#).expect("parse");
        let frames = plan(&command);
        let first = frames.first().expect("at least one frame");
        let value = frame_json(first);
        assert_eq!(value["joint"], first.joint.index() as u64);
        assert_eq!(value["leg"], first.joint.leg() as u64);
        assert_eq!(value["part"], first.joint.part() as u64);
        assert_eq!(value["op"], format!("{:?}", first.op));
        assert_eq!(value["arg"], first.arg);
        assert_eq!(
            value["hex"],
            first.encode_hex(),
            "the JSON hex is the wire bytes, not a second rendering"
        );
    }

    /// The `state` command's rendering: what an operator reads about the return path.
    #[test]
    fn the_state_command_renders_the_return_path() {
        use amos_link::codec::Timestamp;
        use amos_link::robot_hal::{ActuationState, EstopReason, Gait, Refusal};

        let report = |message: ActuationState| Received {
            message,
            topic: Topic::new("amos/dog1/state/actuation").expect("topic"),
            publisher: PeerId::new("dog1").expect("peer"),
            seq: 1,
            stamp: Timestamp::now(),
            frame_len: 0,
        };
        let trotting = ActuationState {
            seq: Some(2),
            gait: Some(Gait::Trot),
            frames: 13,
            armed: true,
            estopped: false,
            estop_reason: None,
            watchdog_ms: Some(1000),
            last_refusal: None,
        };

        // A trotting robot: gait, frames, the deadman period it runs under, and — since this
        // round — the **age of the report**. The line used to be undated, which is the same
        // "a stale reading looks fresh" shape the link panel was fixed for (§3.12): `armed=true`
        // from a robot that reported two hours ago and then died is not "armed now".
        let line = state_lines(&report(trotting.clone()), false);
        assert_eq!(line.len(), 1);
        assert!(
            line[0].starts_with(
                "robot=dog1 armed=true estopped=false gait=trot frames=13 seq=2 watchdog=1000ms"
            ),
            "the mode fields are unchanged: {}",
            line[0]
        );
        assert!(
            line[0].contains("age="),
            "the report is dated in the human form too: {}",
            line[0]
        );

        // A watchdog torque cut — the fact the return path exists for.
        let stopped = state_lines(
            &report(ActuationState {
                armed: false,
                estopped: true,
                estop_reason: Some(EstopReason::Watchdog),
                ..trotting.clone()
            }),
            false,
        );
        assert_eq!(stopped.len(), 1, "nothing was refused, so one line");
        assert!(stopped[0].contains("armed=false"), "got: {}", stopped[0]);
        assert!(
            stopped[0].contains("estopped=true(watchdog)"),
            "the reason is named: {}",
            stopped[0]
        );

        // A refusal adds the *why*: the operator learns how to recover.
        let refused = state_lines(
            &report(ActuationState {
                seq: Some(3),
                estopped: true,
                estop_reason: Some(EstopReason::Commanded),
                watchdog_ms: None,
                last_refusal: Some(Refusal {
                    seq: 3,
                    reason: "e-stop latched".to_string(),
                }),
                ..trotting.clone()
            }),
            false,
        );
        assert_eq!(refused.len(), 2);
        assert!(refused[1].contains("seq 3"), "got: {}", refused[1]);
        assert!(refused[1].contains("e-stop latched"), "got: {}", refused[1]);

        // `--json` is one machine-readable document carrying the same facts.
        let json = state_lines(
            &report(ActuationState {
                armed: false,
                estopped: true,
                estop_reason: Some(EstopReason::Watchdog),
                ..trotting
            }),
            true,
        );
        assert_eq!(json.len(), 1);
        let value: serde_json::Value = serde_json::from_str(&json[0]).expect("json");
        assert_eq!(value["robot"], "dog1");
        assert_eq!(value["gait"], "trot");
        assert_eq!(value["estopped"], true);
        assert_eq!(value["estop_reason"], "watchdog");
        assert_eq!(value["watchdog_ms"].as_u64(), Some(1000));
        assert!(value["stamp_ms"].as_u64().expect("stamp") > 1_000_000_000_000);
    }
}

/// The control-plane copy of a report decodes back into the domain shape: the proto's
/// sentinels mean "absent", and a reason this build does not know is never invented.
#[test]
fn a_folded_report_decodes_back_into_the_domain_shape() {
    let idle = ProtoActuation {
        robot: "dog1".to_string(),
        seq: 0,
        gait: String::new(),
        frames: 0,
        armed: false,
        estopped: false,
        estop_reason: String::new(),
        watchdog_ms: 0,
        last_refusal_seq: 0,
        last_refusal: String::new(),
        stamp_secs: 7,
        stamp_nanos: 500_000_000,
    };
    let (robot, state, stamp_ms) = actuation_from_proto(&idle);
    assert_eq!(robot, "dog1");
    assert_eq!(state.seq, None, "0 means `no action yet`");
    assert_eq!(state.gait, None, "the empty key means no gait accepted");
    assert_eq!(state.estop_reason, None);
    assert_eq!(state.watchdog_ms, None);
    assert_eq!(state.last_refusal, None);
    assert_eq!(stamp_ms, 7_500, "seconds + nanos → ms");

    // A real report travels verbatim.
    let stopped = ProtoActuation {
        seq: 12,
        gait: "estop".to_string(),
        frames: 12,
        armed: false,
        estopped: true,
        estop_reason: "watchdog".to_string(),
        watchdog_ms: 1000,
        last_refusal_seq: 13,
        last_refusal: "e-stop latched: send {\"action\":\"arm\"} to re-arm".to_string(),
        ..idle.clone()
    };
    let (_, state, _) = actuation_from_proto(&stopped);
    assert_eq!(state.seq, Some(12));
    assert_eq!(state.gait, Some(Gait::Estop));
    assert_eq!(state.estop_reason, Some(EstopReason::Watchdog));
    assert!(state.estopped && !state.armed);
    assert_eq!(state.watchdog_ms, Some(1000));
    assert_eq!(state.last_refusal.as_ref().map(|r| r.seq), Some(13));

    // A reason from a newer robot stays unknown — while `estopped` still reports that
    // torque *was* cut. The JSON says `null`, never a guessed reason.
    let newer = ProtoActuation {
        estop_reason: "meltdown".to_string(),
        ..stopped
    };
    let (_, state, _) = actuation_from_proto(&newer);
    assert!(state.estopped, "the flag is independent of the reason");
    assert_eq!(
        state.estop_reason, None,
        "an unknown reason is not invented"
    );
    let value = actuation_json("dog1", &state, 42, 1042);
    assert_eq!(value["robot"], "dog1");
    assert_eq!(value["estopped"], true);
    assert_eq!(value["estop_reason"], serde_json::Value::Null);
    assert_eq!(value["stamp_ms"], 42);
    assert_eq!(
        value["age_ms"], 1_000,
        "the age is derived from the reader's clock and travels beside the stamp"
    );
}
