//! Tauri ⇄ daemon AmOS-Link control-plane bridge (robot-middleware status **and** commands).
//!
//! The daemon mounts `RobotLink` (`proto/robot_link.proto`) on the shared UDS beside
//! AiAgent / Sensor / Telephony. This module is the System UI's whole connection to that
//! control plane, in **two halves**:
//!
//! * **read** — `link_status` answers the operator's question *is the robot on the link, who
//!   else is, and can the latency numbers be trusted?* without a terminal, and folds in the
//!   return path (`ListActuations`) so each robot's self-reported mode travels with it. Before
//!   this existed the control plane's only callers were the CLI (`--socket`) and external
//!   tooling, and `docs/amos-link.md` §6 recorded the missing GUI consumer as a boundary;
//! * **write** — `link_publish` sends one agent action to `amos/<robot>/control/action`,
//!   `link_topics` reads the topic inventory, and `link_watch_heartbeats` /
//!   `link_stop_heartbeats` run the live heartbeat stream for the console's liveness rows.
//!   These are the robot **command console**'s command surface
//!   (`frontend-ts/src/svelte/RobotApp.svelte`, i18n `robot.*`) — the reason §6 no longer says
//!   publishing belongs to the CLI alone. A publish receipt is *not* proof of effect: only the
//!   return path read back through `link_status` says whether torque moved.
//!
//! Honest boundaries (mirrored by the page, `link.boundary`):
//! * the verdict is the **daemon's own** `health` fold; `unknown` means *no evidence
//!   yet* (`HEALTH_UNKNOWN`), which is deliberately not the same as healthy, and the
//!   reasons travel with it so the UI never shows a bare "OK";
//! * `clock_synced: false` means the link's latency numbers are **bounds**, not
//!   measurements (`amos-timesync` has not calibrated the clock);
//! * the counters are cumulative and never reset — the page says so rather than
//!   pretending they are a rate;
//! * a reading has **no expiry of its own**: `last_seen_ms` is the age *at the moment the
//!   daemon answered*. Dating and re-reading is therefore the reader's job, and both consumers
//!   do it — `LinkPage.svelte` prints the read time (`link.probe`) and `RobotApp.svelte` re-reads
//!   every 2 s; either drops the numbers when a re-read gets no answer instead of leaving a
//!   frozen table on screen.
//!
//! This is the control plane only: the data plane (stereo frames, joint set points)
//! never travels through gRPC, and this bridge does not pretend to read it.

use amos_link::discovery::NodeKind;
use amos_link::robot_hal::EstopReason;
use amos_link::{AgentAction, Channel, Message, Topic};
use amos_proto::amos_link::{
    robot_link_client::RobotLinkClient, Actuation as ProtoActuation, Empty, HealthState,
    LinkStatus, Metrics, Peer, PublishRequest,
};
use serde::Serialize;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::daemon;

/// One peer in the link's table, serializable for the WebView.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LinkPeerOut {
    /// Stable peer id (`amos/<id>/…`).
    pub id: String,
    /// One of `robot` | `brain` | `sensor` | `actuator` | `tool`, or `unknown` for a role this
    /// build does not know (a newer daemon's). The fold is `NodeKind::wire_token` — the same
    /// rule the CLI's peer row applies — so an unfamiliar role reads `unknown` here instead of
    /// echoing a word this panel has no vocabulary (or i18n) for.
    pub kind: String,
    /// Transport endpoint when the beacon carried one (`None`, never `""`).
    pub endpoint: Option<String>,
    /// Age of the last evidence in ms.
    pub last_seen_ms: u64,
    /// Beacons observed; `0` means the peer was declared by hand (static, never expires).
    pub beacons: u64,
}

/// Cumulative link counters, as the daemon reports them (never reset, never faked).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct LinkMetricsOut {
    pub published: u64,
    pub delivered: u64,
    pub dropped: u64,
    pub blocked: u64,
    pub decode_errors: u64,
    pub encode_errors: u64,
}

/// A command that was refused before it reached the bus, as the robot reported it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LinkRefusalOut {
    /// The link sequence of the refused action.
    pub seq: u64,
    /// Why it was refused (the robot's own words).
    pub reason: String,
}

/// What one robot says about its own actuation (the control loop's **return path**).
///
/// The reports travel the data plane (`amos/<robot>/state/actuation`); the daemon folds them
/// and hands them back over the control plane, which is how an app that is not on the link —
/// this UI — can show what a robot is *doing*, not just that it exists.
///
/// The proto has no `Option`, so "absent" arrives as `0` / `""` and is turned back into `None`
/// here: a UI must be able to tell "never armed" from "armed with value 0", and an e-stop
/// reason this build does not know stays `None` while `estopped` still says torque was cut.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LinkActuationOut {
    /// The reporting peer (also the frame's publisher).
    pub robot: String,
    /// The last action it acted on (`None` before any).
    pub seq: Option<u64>,
    /// The last accepted gait (`None` before one was accepted).
    pub gait: Option<String>,
    /// Frames written to the bus for that action.
    pub frames: u64,
    /// Drivers energized (read from the bus by the robot, never inferred here).
    pub armed: bool,
    /// Torque is cut and latched until an explicit arm.
    pub estopped: bool,
    /// `"commanded"` | `"watchdog"` | `"bus-fault"` | `None` (none, or a reason this build does not know).
    pub estop_reason: Option<String>,
    /// The deadman period the robot runs under (`None` = no watchdog configured).
    pub watchdog_ms: Option<u64>,
    /// The most recent refusal, if any.
    pub last_refusal: Option<LinkRefusalOut>,
    /// When the robot published the report (ms since the epoch, from its own clock).
    pub stamp_ms: u64,
}

/// Map one folded report. Nothing here invents a value the robot did not report.
pub fn actuation_out(a: &ProtoActuation) -> LinkActuationOut {
    LinkActuationOut {
        robot: a.robot.clone(),
        seq: (a.seq != 0).then_some(a.seq),
        gait: Some(a.gait.clone()).filter(|g| !g.is_empty()),
        frames: u64::from(a.frames),
        armed: a.armed,
        estopped: a.estopped,
        // Only the tokens this build knows: an unknown reason from a newer robot is not
        // guessed at *or* passed through as if it were a verdict of ours — `estopped` still
        // tells the UI that torque was cut, which is the safety fact. The vocabulary is the
        // robot's own (`EstopReason::from_key`, the same authority the producer spells with),
        // resolved here rather than re-spelled as a literal copy that could silently drift.
        estop_reason: EstopReason::from_key(&a.estop_reason).map(|r| r.key().to_string()),
        watchdog_ms: (a.watchdog_ms != 0).then_some(a.watchdog_ms),
        last_refusal: (!a.last_refusal.is_empty()).then(|| LinkRefusalOut {
            seq: a.last_refusal_seq,
            reason: a.last_refusal.clone(),
        }),
        stamp_ms: a
            .stamp_secs
            .saturating_mul(1000)
            .saturating_add(u64::from(a.stamp_nanos) / 1_000_000),
    }
}

/// Serializable mirror of the daemon's `LinkStatus` (prost structs are not `Serialize`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LinkStatusOut {
    /// This node's peer id.
    pub peer: String,
    /// This node's kind.
    pub kind: String,
    /// `amos-link` crate version the daemon runs.
    pub version: String,
    pub uptime_ms: u64,
    /// True only when a calibrated clock is in use (else latencies are bounds).
    pub clock_synced: bool,
    /// `"unknown"` | `"healthy"` | `"degraded"` | `"unrecognized"`.
    pub health: String,
    /// Why that verdict, one token per reason (empty for a healthy link).
    pub health_reasons: Vec<String>,
    pub metrics: LinkMetricsOut,
    pub peers: Vec<LinkPeerOut>,
    /// What each robot says about itself (the return path, folded by the daemon) — sorted by
    /// robot id.
    ///
    /// **Three states, and they are not the same fact** (the panel's whole doctrine is
    /// 「absent, not idle」):
    ///
    /// * `Some(vec![])` — the daemon answered and nobody has reported yet;
    /// * `Some([…])` — those robots have reported;
    /// * `None` — the daemon **did not answer this question** (a build that predates
    ///   `ListActuations`), which is why the panel must show 「this daemon does not report the
    ///   return path」 rather than 「no robots reported」. `null` in the JSON, never `[]`.
    pub actuations: Option<Vec<LinkActuationOut>>,
}

/// Map the wire enum to a stable display token.
///
/// An enum value this build does not know (a newer daemon) is reported as
/// `"unrecognized"` rather than being folded into one of the three it does know —
/// guessing a verdict is exactly what this bridge must not do.
///
/// The three words are not this bridge's invention: they are the `state` strings the
/// middleware's own status document carries (`LinkHealth`'s derived `Serialize`, the
/// document the CLI's `status` prints), and
/// `the_verdict_tokens_this_bridge_spells_are_the_middlewares_own` binds the two, so one
/// verdict cannot be spelled twice across the terminal and the panel.
pub fn health_str(raw: i32) -> String {
    match raw {
        raw if raw == HealthState::HealthUnknown as i32 => "unknown",
        raw if raw == HealthState::HealthHealthy as i32 => "healthy",
        raw if raw == HealthState::HealthDegraded as i32 => "degraded",
        _ => "unrecognized",
    }
    .to_string()
}

/// Map one wire peer, turning an absent endpoint into `None` (not an empty string) and a role
/// this build does not know into `unknown` (never the raw word — see [`LinkPeerOut::kind`]).
pub fn peer_out(peer: &Peer) -> LinkPeerOut {
    LinkPeerOut {
        id: peer.id.clone(),
        kind: NodeKind::wire_token(&peer.kind).to_string(),
        endpoint: Some(peer.endpoint.clone()).filter(|e| !e.is_empty()),
        last_seen_ms: peer.last_seen_ms,
        beacons: peer.beacons,
    }
}

/// Map the wire metrics block; an absent block is all-zero (the daemon always sends
/// one, but a missing field must not become an invented reading).
pub fn metrics_out(metrics: Option<&Metrics>) -> LinkMetricsOut {
    match metrics {
        Some(m) => LinkMetricsOut {
            published: m.published,
            delivered: m.delivered,
            dropped: m.dropped,
            blocked: m.blocked,
            decode_errors: m.decode_errors,
            encode_errors: m.encode_errors,
        },
        None => LinkMetricsOut::default(),
    }
}

/// Map a full wire status, with the robots' reports the daemon folded in beside it.
///
/// `actuations` is `Option` on purpose: `None` = this daemon did not answer the return-path
/// question (see [`LinkStatusOut::actuations`]), `Some(vec![])` = it answered and nobody has
/// reported. Collapsing the two would make the panel claim things about a fleet it never heard
/// about.
pub fn status_out(status: &LinkStatus, actuations: Option<Vec<LinkActuationOut>>) -> LinkStatusOut {
    LinkStatusOut {
        peer: status.peer.clone(),
        kind: status.kind.clone(),
        version: status.version.clone(),
        uptime_ms: status.uptime_ms,
        clock_synced: status.clock_synced,
        health: health_str(status.health),
        health_reasons: status.health_reasons.clone(),
        metrics: metrics_out(status.metrics.as_ref()),
        peers: status.peers.iter().map(peer_out).collect(),
        actuations,
    }
}

/// Read the running daemon's AmOS-Link status (identity, counters, peers, verdict) **and** the
/// robots' own actuation reports (the return path, folded by the daemon).
///
/// A daemon that is not running is an `Err` the UI renders as "not connected" — this command
/// never fabricates a link status, and it never claims the data plane.
///
/// **One RPC that a daemon may not have is not a reason to take the page down.** `ListActuations`
/// arrived with the return path; a daemon built before it answers `Unimplemented`, and
/// `docs/amos-link.md` §6.5 promises the panel then shows 「one fewer section」 rather than an
/// error. Until this round the `?` below did the opposite: the page became 「守护进程未连接」 and
/// the status, peer table and verdict — all of which *were* available — vanished with it. So:
///
/// * `Unimplemented` ⇒ the return path is **absent** (`actuations: None`, a warn in the log) —
///   "this daemon does not answer that question";
/// * any other failure ⇒ an `Err`, because a daemon that *has* the RPC and cannot serve it is a
///   real fault and must not be folded into 「older daemon」.
#[tauri::command]
pub async fn link_status() -> Result<LinkStatusOut, String> {
    let mut client = RobotLinkClient::new(daemon::channel().await?);
    let reply = client
        .get_status(Empty {})
        .await
        .map_err(|e| format!("robot-link status failed: {e}"))?
        .into_inner();
    let actuations = match client.list_actuations(Empty {}).await {
        Ok(list) => Some(
            list.into_inner()
                .robots
                .iter()
                .map(actuation_out)
                .collect::<Vec<_>>(),
        ),
        Err(status) if status.code() == tonic::Code::Unimplemented => {
            tracing::warn!(
                "this daemon has no ListActuations (an older build): the return path is \
                 reported as absent, not as an empty fleet"
            );
            None
        }
        Err(e) => return Err(format!("robot-link ListActuations failed: {e}")),
    };
    Ok(status_out(&reply, actuations))
}

// ---------------------------------------------------------------------------
// Write side: the operator console's command surface.
//
// The read side above observes; this side commands. Both go through the same control plane
// (`RobotLink`), and both keep the same discipline: nothing this bridge returns is allowed to
// claim more than the daemon answered.
// ---------------------------------------------------------------------------

/// The control-channel name a robot listens for agent actions on (the topic a
/// `Subscriber<AgentAction>` matches — see `amos_link::actuation_topic`'s control sibling).
const CONTROL_ACTION_NAME: &str = "action";

/// Build `amos/<robot>/control/action` — the concrete topic a robot's action subscriber matches.
///
/// Built by `Topic::channel_topic`, not `format!`, so the key-expression grammar and the
/// `control` channel (which selects the *reliable* QoS a command needs) are the middleware's
/// rule rather than a copy of it in the UI. An unusable robot id is refused **here**, naming
/// the id, instead of surfacing as the daemon's less specific "invalid topic".
fn control_action_topic(robot: &str) -> Result<String, String> {
    Topic::channel_topic(robot, Channel::Control, CONTROL_ACTION_NAME)
        .map(|t| t.as_str().to_string())
        .map_err(|e| format!("invalid robot id {robot:?}: {e}"))
}

/// One publish's receipt, serializable for the WebView.
///
/// **This is not proof the command took effect.** It is the transport's account of handing the
/// frame to the bus: `matched`/`delivered` count subscribers *this node* could see — an
/// in-process broker knows this for real, a network transport answers `0`, which is 「unknown」,
/// not 「none」. Whether torque actually moved is read back through the return path
/// (`link_status` → `actuations`), never from here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LinkPublishOut {
    /// The sequence number the daemon stamped on the frame.
    pub seq: u64,
    /// Subscribers whose pattern matched (`0` = unknown on a network transport).
    pub matched: u32,
    /// Frames accepted by a subscriber queue.
    pub delivered: u32,
    /// Frames dropped by a QoS policy (should be `0` on the reliable `control` channel).
    pub dropped: u32,
}

/// Publish one agent action to a robot's control topic (`Publish`, control plane).
///
/// `action` is the model's JSON verbatim — e.g. `{"action":"trot","speed":0.6}`,
/// `{"action":"arm"}`, `{"action":"estop"}`. The payload is encoded with `AgentAction`'s own
/// `Message` impl (**bincode**, not the raw JSON string) so the robot's typed subscriber decodes
/// an injected frame exactly like a native one — byte-for-byte what the CLI's `pub --socket`
/// sends. The daemon wraps it in an `Envelope` with its own peer id, sequence and clock; this
/// bridge never pre-frames.
///
/// No validation of the action is attempted here beyond encoding: `estop` must never be gated,
/// and every real check (gait vocabulary, speed range, arm-before-motion) lives robot-side, which
/// reports refusals on the return path.
#[tauri::command]
pub async fn link_publish(robot: String, action: String) -> Result<LinkPublishOut, String> {
    let topic = control_action_topic(&robot)?;
    let payload = AgentAction::new(action)
        .encode()
        .map_err(|e| format!("cannot encode the action: {e}"))?;
    let mut client = RobotLinkClient::new(daemon::channel().await?);
    let reply = client
        .publish(PublishRequest { topic, payload })
        .await
        .map_err(|e| format!("robot-link publish failed: {e}"))?
        .into_inner();
    Ok(LinkPublishOut {
        seq: reply.seq,
        matched: reply.matched,
        delivered: reply.delivered,
        dropped: reply.dropped,
    })
}

/// The node's live topic inventory (`ListTopics`), serializable for the WebView.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LinkTopicsOut {
    /// Concrete key expressions the node has seen published traffic on, sorted.
    pub topics: Vec<String>,
    /// False when `topics` is **not** the whole truth, so a reader can never mistake a partial
    /// list for a complete one: the broker stops growing at its bound, and a network transport
    /// cannot enumerate remote topics at all (it answers empty).
    pub complete: bool,
}

/// Read the daemon's topic inventory (`ListTopics`).
#[tauri::command]
pub async fn link_topics() -> Result<LinkTopicsOut, String> {
    let mut client = RobotLinkClient::new(daemon::channel().await?);
    let reply = client
        .list_topics(Empty {})
        .await
        .map_err(|e| format!("robot-link topics failed: {e}"))?
        .into_inner();
    Ok(LinkTopicsOut {
        topics: reply.topics,
        complete: reply.complete,
    })
}

/// One peer heartbeat, serializable for the WebView.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LinkHeartbeatOut {
    /// Emitting peer id.
    pub peer: String,
    /// Per-peer monotonic heartbeat counter.
    pub seq: u64,
    /// Ms since the emitting node started.
    pub uptime_ms: u64,
    /// Wall-clock ms since the epoch (a **bound**, not a measurement, until the clock is synced).
    pub stamp_ms: u64,
}

/// The live heartbeat forwarder, shared by **every** console window.
///
/// One forwarding task feeds all of them — `AppHandle::emit` reaches every window — so the task's
/// lifetime is a **reader count**, not one window's mount: the first reader starts it, the last
/// stops it. Stopping on any single window's unmount (the shape before this) silently cut the
/// stream for every *other* open console, and their per-peer rows then read as increasingly
/// 「最后收到心跳 N 前」 although the peers were beating — the exact false-liveness `beatAgeMs`
/// exists to refuse, reintroduced through a second window (`wm_open`/⌘N open one app in several).
#[derive(Default, Clone)]
pub struct HeartbeatWatch {
    inner: Arc<Mutex<HeartbeatInner>>,
}

#[derive(Default)]
struct HeartbeatInner {
    /// The reader accounting (pure, unit-tested — see [`ReaderCount`]).
    count: ReaderCount,
    /// The task feeding them, while one is alive.
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// Which windows are reading the one heartbeat stream, and whether it is live.
///
/// Pure so the cross-window rule is testable without a Tauri runtime or a live stream. The stream
/// is process-global (`app.emit` broadcasts), so this is the only thing that decides when it
/// starts and when it may stop.
///
/// Keyed by **window label**, not counted. A count was enough while a window asked exactly once
/// (at mount) and released exactly once (at close), but the console now re-asks on its 2 s poll —
/// that is the only way a stream which ended *under a still-open window* (the daemon restarted)
/// is ever restarted, since the host deliberately keeps every counted reader and clears only
/// `running`. With a bare count, each of those re-asks would add a claim the window never leaves,
/// the count could never reach zero, and the stream would outlive the last console for the process
/// lifetime — the leak this accounting exists to prevent, reintroduced by the retry that fixes the
/// freeze. Keyed, a window's re-ask *replaces its own claim*: asking again is free while the
/// stream is alive and heals it when it is not.
#[derive(Default)]
struct ReaderCount {
    readers: BTreeSet<String>,
    /// True from the moment a reader commits to starting the stream until it dies or the last
    /// reader leaves. A stream that ended on its own (the daemon went away) clears it, so the next
    /// reader starts a fresh one instead of attaching to a corpse.
    running: bool,
}

impl ReaderCount {
    /// Window `win` joins. `true` when **this** caller must start the stream — it is the first
    /// reader, or a window asking again after the stream it was reading ended. A window already
    /// fed by a live stream gets `false` and must not mint a second stream (nor abort the one
    /// feeding the others).
    fn join(&mut self, win: &str) -> bool {
        self.readers.insert(win.to_string());
        if self.running {
            return false;
        }
        self.running = true;
        true
    }

    /// Window `win` leaves. `true` when the stream must now be stopped — only the **last** reader
    /// leaving stops it. Removal is by label, so a window that never joined (a stray stop) cannot
    /// stand in for the reader that is still there.
    fn leave(&mut self, win: &str) -> bool {
        self.readers.remove(win);
        if !self.readers.is_empty() {
            return false;
        }
        self.running = false;
        true
    }

    /// The stream ended on its own (a transport error, or the daemon went away). Every window
    /// still counted stays counted — they are still open and still listening — so the next
    /// `join`, **including one from a window already in the set**, restarts the stream.
    fn stream_ended(&mut self) {
        self.running = false;
    }

    /// Undo a `join` whose stream never came up: the starter is not a reader and nothing is
    /// running, so both halves of `join` are given back — the claim **and** `running`.
    ///
    /// The window must give its claim back rather than merely clear `running`, because on the
    /// failed-start path the console is in no position to become a reader: `startHeartbeats`
    /// answers `false` and the panel says 「本台没有在听」, and the window's close will send one
    /// `link_stop_heartbeats`, not one per attempt. A claim kept here would make that single
    /// close a non-final leave (the set would hold the phantom instead of emptying), so the
    /// stream a later window successfully starts would run on past every console.
    fn join_failed(&mut self, win: &str) {
        self.readers.remove(win);
        self.running = false;
    }
}

impl HeartbeatWatch {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HeartbeatInner>, String> {
        self.inner
            .lock()
            .map_err(|_| "heartbeat watch lock poisoned".to_string())
    }

    /// Window `win` joins. `true` when **this** caller must start the stream (it is the first
    /// reader, or the stream it was reading has ended); `false` when a live stream already feeds it
    /// — which is also the answer to a re-ask, so re-asking a live stream costs no daemon I/O.
    fn begin_reading(&self, win: &str) -> Result<bool, String> {
        Ok(self.lock()?.count.join(win))
    }

    /// Window `win` leaves. `true` when the stream was stopped — only the **last** reader leaving
    /// aborts it. A window that closes is one reader leaving; the rest keep being fed.
    fn finish_reading(&self, win: &str) -> Result<bool, String> {
        let mut guard = self.lock()?;
        if !guard.count.leave(win) {
            return Ok(false);
        }
        if let Some(handle) = guard.handle.take() {
            handle.abort();
        }
        Ok(true)
    }

    /// Record the stream's own end (a transport error, or the daemon went away) so the next reader
    /// starts a fresh one instead of attaching to a stream that is gone.
    fn stream_ended(&self) {
        if let Ok(mut guard) = self.lock() {
            guard.count.stream_ended();
            guard.handle = None;
        }
    }

    /// Undo a [`begin_reading`](Self::begin_reading) whose stream failed to come up (the daemon was
    /// unreachable, or the RPC errored). See [`ReaderCount::join_failed`] for why giving the claim
    /// back is not the same as clearing `running`: the phantom window would outlive the one that
    /// can never read it, and keep the stream a later window starts alive past the last console.
    ///
    /// The slot is reaped as well: `begin_reading` returns `true` when `running` was false, but
    /// another start can be in flight under the same key and may have been adopted meanwhile (a
    /// window label is reused), so a handle is not necessarily absent here. Aborting whatever is
    /// installed keeps the module's invariant — *a handle is installed only while `running`* —
    /// which is the same rule [`adopt`](Self::adopt) applies when the stream comes up.
    fn start_failed(&self, win: &str) {
        if let Ok(mut guard) = self.lock() {
            guard.count.join_failed(win);
            if let Some(handle) = guard.handle.take() {
                handle.abort();
            }
        }
    }

    /// Settle a start attempt: adopt the forwarding task when it came up, or give this reader's
    /// claim back when it did not.
    ///
    /// The one seam [`link_watch_heartbeats`] resolves its start through, so a test drives the
    /// **shipped branch** (an `Err` from the RPC) rather than a helper standing beside it — a helper
    /// test stays green when the command reverts to `stream_ended`, which is exactly the defect
    /// (`join_failed` gives the count back; `stream_ended` does not).
    fn settle_start(
        &self,
        win: &str,
        started: Result<tauri::async_runtime::JoinHandle<()>, String>,
    ) -> Result<(), String> {
        match started {
            Ok(handle) => self.adopt(handle),
            Err(e) => {
                self.start_failed(win);
                Err(e)
            }
        }
    }

    /// Install the forwarding task — **unless no stream is wanted any more**.
    ///
    /// Opening the stream is a real `await` (a UDS connect plus the `StreamHeartbeats` RPC), and
    /// the reader set can change inside it. `running` is the one flag that says a stream is still
    /// wanted: it is cleared by the last reader leaving ([`finish_reading`](Self::finish_reading)),
    /// by the stream ending ([`stream_ended`](Self::stream_ended)), and by a start failing
    /// ([`start_failed`](Self::start_failed)) — and every one of those reaps this slot. A start
    /// that comes back after all of them must not install its task: `readers={}` beside a live
    /// forwarder and its open daemon stream is the process-lifetime leak [`ReaderCount`] exists to
    /// prevent. The task is aborted instead, exactly as if the start had failed.
    ///
    /// Keyed on `running` and **not** on "is this window still counted": the starter may close
    /// while another window is still reading, and the stream it opened is that other window's only
    /// one. Aborting it would tell the survivor it is fed — `begin_reading` answers `false` while
    /// `running` is true, so its re-ask starts nothing — with nothing feeding it: the false
    /// liveness this accounting exists to refuse.
    ///
    /// A handle already installed is aborted too rather than dropped: two starts can be in flight
    /// under one key (a window label is reused), and the one that loses is not the stream the
    /// readers are on. Dropping a `JoinHandle` detaches the task (it keeps running), so the loser
    /// must be cancelled explicitly.
    fn adopt(&self, handle: tauri::async_runtime::JoinHandle<()>) -> Result<(), String> {
        let mut guard = self.lock()?;
        if !guard.count.running {
            handle.abort();
            return Ok(());
        }
        if let Some(superseded) = guard.handle.replace(handle) {
            superseded.abort();
        }
        Ok(())
    }

    /// Observe the reader accounting, so a test pins the shipped path (not a private helper).
    #[cfg(test)]
    fn peek(&self) -> (usize, bool) {
        let guard = self.inner.lock().expect("heartbeat watch lock poisoned");
        (guard.count.readers.len(), guard.count.running)
    }

    /// Whether a forwarding task is currently adopted — the half of the state `peek` cannot show,
    /// and the one that leaks when a stream comes up after its last reader left.
    #[cfg(test)]
    fn handle_held(&self) -> bool {
        self.inner
            .lock()
            .expect("heartbeat watch lock poisoned")
            .handle
            .is_some()
    }
}

/// Start forwarding the link's heartbeat stream to the WebView as `link-heartbeat` events.
///
/// `StreamHeartbeats` never ends while the link lives, so the forwarding task is kept in managed
/// state and aborted when the **last** console window closes rather than being left to run for the
/// process lifetime. A second window **shares** the running stream (the events already reach it);
/// it neither starts a second one nor aborts the first — see [`HeartbeatWatch`].
///
/// The window is taken as a parameter because the reader accounting is **per window**: the console
/// re-asks on every poll (the only way a stream that ended under a still-open window is ever
/// restarted), and a window's re-ask must replace its own claim rather than add one.
#[tauri::command]
pub async fn link_watch_heartbeats(
    window: tauri::WebviewWindow,
    app: AppHandle,
    watch: State<'_, HeartbeatWatch>,
) -> Result<(), String> {
    let win = window.label().to_string();
    // This window is already fed by the same broadcast stream: no second stream minted, and above
    // all no abort of the one that is feeding the others. Asking again while the stream is live
    // costs nothing here — which is what makes the console's retry safe to run on every poll.
    if !watch.begin_reading(&win)? {
        return Ok(());
    }
    // This caller is the starter. Start outside the lock — the awaits below are not cheap and the
    // lock is shared with the teardown path.
    let started = async {
        let mut client = RobotLinkClient::new(daemon::channel().await?);
        let mut stream = client
            .stream_heartbeats(Empty {})
            .await
            .map_err(|e| format!("robot-link StreamHeartbeats failed: {e}"))?
            .into_inner();
        let mark = watch.inner.clone();
        let handle = tauri::async_runtime::spawn(async move {
            // The stream ends on a transport error or when the daemon goes away; either way the task
            // simply stops — there is nothing to report on a channel no window is reading. Clearing
            // `running` is what lets the next join start a fresh stream: an open window re-asking on
            // its poll, or a window opened later — both are joins against the same keyed set.
            while let Ok(Some(beat)) = stream.message().await {
                let _ = app.emit(
                    "link-heartbeat",
                    LinkHeartbeatOut {
                        peer: beat.peer,
                        seq: beat.seq,
                        uptime_ms: beat.uptime_ms,
                        stamp_ms: beat
                            .stamp_secs
                            .saturating_mul(1000)
                            .saturating_add(u64::from(beat.stamp_nanos) / 1_000_000),
                    },
                );
            }
            HeartbeatWatch { inner: mark }.stream_ended();
        });
        Ok::<_, String>(handle)
    }
    .await;
    // The stream never started, so no reader is being fed: `settle_start` gives this window's claim
    // back (not `stream_ended`, which keeps the claim) so the next attempt starts a fresh stream
    // instead of attaching to one that does not exist — see the seam for why the claim must go too.
    watch.settle_start(&win, started)
}

/// Stop the heartbeat forwarder started by [`link_watch_heartbeats`] **when the last window
/// leaves**.
///
/// A window that closes is one reader leaving; the stream keeps feeding any other open console.
/// Keyed by the window, so a stop from a window that holds no claim cannot release another
/// console's.
#[tauri::command]
pub fn link_stop_heartbeats(window: tauri::WebviewWindow, watch: State<'_, HeartbeatWatch>) {
    if let Err(e) = watch.finish_reading(window.label()) {
        tracing::warn!(error = %e, "heartbeat stop failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status() -> LinkStatus {
        LinkStatus {
            peer: "amos-daemon".into(),
            kind: "brain".into(),
            version: "0.1.0".into(),
            uptime_ms: 4200,
            clock_synced: false,
            metrics: Some(Metrics {
                published: 12,
                delivered: 12,
                dropped: 0,
                decode_errors: 0,
                peers: 1,
                encode_errors: 0,
                blocked: 0,
            }),
            peers: vec![Peer {
                id: "dog1".into(),
                kind: "robot".into(),
                endpoint: "tcp/10.0.0.7:7447".into(),
                last_seen_ms: 300,
                beacons: 7,
            }],
            health: HealthState::HealthDegraded as i32,
            health_reasons: vec!["no_peers".into(), "clock_unsynced".into()],
        }
    }

    #[test]
    fn maps_a_status_verbatim() {
        let out = status_out(&status(), Some(Vec::new()));
        assert_eq!(out.peer, "amos-daemon");
        assert_eq!(out.kind, "brain");
        assert_eq!(out.uptime_ms, 4200);
        assert!(!out.clock_synced);
        assert_eq!(out.health, "degraded");
        assert_eq!(out.health_reasons, vec!["no_peers", "clock_unsynced"]);
        assert_eq!(out.metrics.published, 12);
        assert_eq!(out.metrics.dropped, 0);
        assert_eq!(out.peers.len(), 1);
        assert_eq!(out.peers[0].id, "dog1");
        assert_eq!(out.peers[0].kind, "robot");
        assert_eq!(out.peers[0].beacons, 7);
    }

    #[test]
    fn an_absent_endpoint_is_none_not_an_empty_string() {
        // "no endpoint" and "an endpoint that is the empty string" must not look alike.
        let mut p = Peer {
            id: "tool".into(),
            kind: "tool".into(),
            endpoint: String::new(),
            last_seen_ms: 0,
            beacons: 0,
        };
        assert_eq!(peer_out(&p).endpoint, None);
        p.endpoint = "tcp/1.2.3.4:7447".into();
        assert_eq!(peer_out(&p).endpoint.as_deref(), Some("tcp/1.2.3.4:7447"));
    }

    /// The peer a WebView receives is the **same five fields** the terminal prints and the proto
    /// carries (`id`, `kind`, `endpoint`, `last_seen_ms`, `beacons`) — one peer table, one spelling
    /// across the CLI, the control plane and this bridge.
    ///
    /// It pins the *serialized* form, not the struct: `LinkPeerOut` is what the frontend parses,
    /// and the CLI's `PeerRow` (`crates/amos-link-cli/src/lib.rs`) is asserted to the same key set
    /// in its own tests. `beacons: 0` is how both sides say "declared by hand, never beaconed"
    /// (the proto's rule) — no `static` key is invented in either.
    #[test]
    fn a_peer_serializes_to_the_same_five_fields_the_cli_prints() {
        let value = serde_json::to_value(peer_out(&Peer {
            id: "dog1".into(),
            kind: "robot".into(),
            endpoint: "udp/10.0.0.9:7446".into(),
            last_seen_ms: 12,
            beacons: 3,
        }))
        .expect("json");
        assert_eq!(
            value,
            serde_json::json!({
                "id": "dog1",
                "kind": "robot",
                "endpoint": "udp/10.0.0.9:7446",
                "last_seen_ms": 12,
                "beacons": 3,
            })
        );
        let mut keys: Vec<&str> = value
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["beacons", "endpoint", "id", "kind", "last_seen_ms"]);
    }

    #[test]
    fn a_peer_role_this_build_does_not_know_reads_unknown_not_the_raw_word() {
        // The panel's `LinkPeer.kind` documents a closed set — five roles plus `unknown` — and
        // the CLI's peer row folds an unfamiliar role to `unknown`. This bridge is the third
        // reader of the same wire string: it must fold too, or the same peer reads two ways
        // (a raw token here, `unknown` in the CLI) and the panel shows a role it has no
        // vocabulary for. The rule is `NodeKind::wire_token`, shared with the CLI.
        let known = peer_out(&Peer {
            id: "dog1".into(),
            kind: NodeKind::Robot.key().into(),
            endpoint: String::new(),
            last_seen_ms: 1,
            beacons: 0,
        });
        assert_eq!(known.kind, "robot", "a known role is normalized to its key");

        let unfamiliar = peer_out(&Peer {
            id: "rover7".into(),
            kind: "quadruped".into(),
            endpoint: String::new(),
            last_seen_ms: 9,
            beacons: 2,
        });
        assert_eq!(
            unfamiliar.kind,
            amos_link::discovery::UNKNOWN_KIND,
            "an unfamiliar role is named `unknown`, never echoed raw"
        );
        assert_eq!(unfamiliar.id, "rover7", "the row still names the peer");
    }

    #[test]
    fn unknown_enum_bits_are_never_guessed_into_a_verdict() {
        // A newer daemon's verdict this build does not know must not be folded into
        // "healthy" (which would be a false all-clear) or "degraded".
        assert_eq!(health_str(99), "unrecognized");
        assert_eq!(health_str(-1), "unrecognized");
        assert_eq!(health_str(HealthState::HealthUnknown as i32), "unknown");
        assert_eq!(health_str(HealthState::HealthHealthy as i32), "healthy");
        assert_eq!(health_str(HealthState::HealthDegraded as i32), "degraded");
    }

    /// The verdict vocabulary this bridge spells is the **middleware's own**
    /// (`amos_link::LinkHealth`), not a second copy of it.
    ///
    /// One verdict has two renderings: `health_str` feeds `LinkStatusOut.health`, which the
    /// System UI's `linkLevel` folds into a sentence, while the *same* verdict reaches the CLI's
    /// `status` document through `LinkHealth`'s derived `Serialize` — the pairing
    /// `health.rs` declares ("the same words the control plane's `health`/`health_reasons` and
    /// the CLI print, so one verdict has one spelling everywhere"). The two spellings are
    /// hand-written in two crates, and the test above pins this bridge's three against
    /// **Rust-local literals** — nothing read across. So a re-spelling on either side, with its
    /// own local copy updated, kept every suite green while a *degraded* link read as
    /// `degraded` in the terminal and 「未知」 in the panel (`linkLevel` folds a token it does
    /// not name to `unknown`, which is why the panel is the one that loses the word).
    ///
    /// The bind is against the **document**, not against `LinkHealth::label()`: the label has no
    /// production caller, and `{"state": …}` is the artifact the CLI actually prints.
    #[test]
    fn the_verdict_tokens_this_bridge_spells_are_the_middlewares_own() {
        use amos_link::health::LinkHealth;

        let verdicts = [
            (HealthState::HealthUnknown, LinkHealth::Unknown),
            (HealthState::HealthHealthy, LinkHealth::Healthy),
            (
                HealthState::HealthDegraded,
                LinkHealth::Degraded {
                    reasons: Vec::new(),
                },
            ),
        ];

        let mut words = Vec::new();
        for (code, verdict) in verdicts {
            let document = serde_json::to_value(&verdict).expect("the verdict renders");
            let word = document["state"]
                .as_str()
                .unwrap_or_else(|| panic!("a verdict is a `state` word: {document}"))
                .to_string();
            assert_eq!(
                health_str(code as i32),
                word,
                "{verdict:?}: this bridge's token and the status document's word are one \
                 vocabulary, not two"
            );
            words.push(word);
        }

        // Non-trivial guard: three codes, three *different* words. An equality per arm is also
        // satisfied by a fold that collapsed `healthy` and `degraded` onto one sentence.
        let mut distinct = words.clone();
        distinct.sort_unstable();
        distinct.dedup();
        assert_eq!(distinct.len(), 3, "three verdicts, three words: {words:?}");
    }

    #[test]
    fn a_missing_metrics_block_reads_as_all_zero_not_a_guess() {
        assert_eq!(metrics_out(None), LinkMetricsOut::default());
        let mut s = status();
        s.metrics = None;
        assert_eq!(
            status_out(&s, Some(Vec::new())).metrics,
            LinkMetricsOut::default()
        );
    }

    #[test]
    fn an_empty_link_is_representable() {
        let s = LinkStatus {
            peer: "amos-daemon".into(),
            kind: "brain".into(),
            version: "0.1.0".into(),
            uptime_ms: 0,
            clock_synced: false,
            metrics: None,
            peers: Vec::new(),
            health: HealthState::HealthUnknown as i32,
            health_reasons: Vec::new(),
        };
        let out = status_out(&s, Some(Vec::new()));
        assert!(out.peers.is_empty());
        assert_eq!(out.health, "unknown");
        assert!(out.health_reasons.is_empty());
    }

    #[test]
    fn a_folded_report_decodes_without_inventing_anything() {
        // Before any action: the proto's sentinels mean "absent", not "zero".
        let idle = ProtoActuation {
            robot: "dog1".into(),
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
        let out = actuation_out(&idle);
        assert_eq!(out.robot, "dog1");
        assert_eq!(out.seq, None);
        assert_eq!(out.gait, None);
        assert_eq!(out.estop_reason, None);
        assert_eq!(out.watchdog_ms, None);
        assert_eq!(out.last_refusal, None);
        assert_eq!(out.stamp_ms, 7_500);

        // A real report travels verbatim, refusal and reason included.
        let stopped = ProtoActuation {
            seq: 12,
            gait: "estop".into(),
            frames: 12,
            estopped: true,
            estop_reason: "watchdog".into(),
            watchdog_ms: 1000,
            last_refusal_seq: 13,
            last_refusal: "e-stop latched".into(),
            ..idle.clone()
        };
        let out = actuation_out(&stopped);
        assert_eq!(out.seq, Some(12));
        assert_eq!(out.gait.as_deref(), Some("estop"));
        assert!(out.estopped && !out.armed);
        assert_eq!(out.estop_reason.as_deref(), Some("watchdog"));
        assert_eq!(out.watchdog_ms, Some(1000));
        assert_eq!(out.frames, 12);
        let refusal = out.last_refusal.expect("the refusal travels");
        assert_eq!(refusal.seq, 13);
        assert_eq!(refusal.reason, "e-stop latched");

        // A reason from a newer robot stays unknown while `estopped` still says torque was
        // cut: the UI shows "cut, reason unknown" rather than a guessed reason or "not cut".
        let newer = ProtoActuation {
            estop_reason: "meltdown".into(),
            ..stopped
        };
        let out = actuation_out(&newer);
        assert!(out.estopped, "the safety fact survives an unknown reason");
        assert_eq!(out.estop_reason, None, "an unknown verdict is not invented");
    }

    /// The e-stop reason vocabulary this bridge accepts is the **robot's own**
    /// (`robot_hal::EstopReason::key()`), not a literal copy that could silently drift from it.
    ///
    /// The producer spells the wire token with `EstopReason::key()`
    /// (`amos_link::service::proto_actuation`), and `actuation_out` resolves it with the same
    /// authority. Feeding the tokens `key()` *actually* returns — rather than a hand-kept
    /// literal list in this file — is what makes a rename on the robot side a red here instead
    /// of a silent `None`: the console would otherwise lose the **why** of an e-stop and be
    /// unable to tell a link-loss deadman stop from a commanded one. It iterates
    /// `EstopReason::ALL`, so a variant added on the robot side is exercised here with no
    /// second edit.
    #[test]
    fn the_estop_reason_tokens_this_bridge_accepts_are_the_robots_own_vocabulary() {
        for reason in EstopReason::ALL {
            let wire = ProtoActuation {
                estop_reason: reason.key().to_string(),
                ..ProtoActuation::default()
            };
            assert_eq!(
                actuation_out(&wire).estop_reason.as_deref(),
                Some(reason.key()),
                "{reason:?}: the bridge must resolve the robot's own token, not a copy of it"
            );
        }
    }

    /// The heartbeat stream is process-global (`app.emit` reaches every window), so its lifetime
    /// is a **reader count**, not one window's mount.
    ///
    /// The defect this pins: `link_stop_heartbeats` aborted whatever task was in the shared slot
    /// regardless of who started it, so closing **one** console window cut the live beat stream for
    /// every other open console — whose per-peer rows then aged without bound and read as
    /// 「最后收到心跳 N 前」 although the peers were beating (the false liveness `beatAgeMs` exists
    /// to refuse, reintroduced across windows; `wm_open`/⌘N open one app in several).
    #[test]
    fn the_heartbeat_stream_is_stopped_only_when_the_last_reader_leaves() {
        let w = HeartbeatWatch::default();
        // First window starts the stream; a second only shares it.
        assert!(
            w.begin_reading("console-1").unwrap(),
            "the first window starts the stream"
        );
        assert!(
            !w.begin_reading("console-2").unwrap(),
            "a second window shares the running stream, it does not restart it"
        );
        // One window closing is one reader leaving — the stream must survive for the other.
        assert!(
            !w.finish_reading("console-1").unwrap(),
            "closing one console must not stop the stream the other is reading"
        );
        assert_eq!(w.peek(), (1, true));
        // The last window closing is what stops it.
        assert!(
            w.finish_reading("console-2").unwrap(),
            "the last reader leaving stops the stream"
        );
        assert_eq!(w.peek(), (0, false));
        // …and a later window starts a fresh one.
        assert!(
            w.begin_reading("console-2").unwrap(),
            "a stream nobody reads is restarted by the next window"
        );
    }

    /// A stream that ended on its own (the daemon went away) must not be mistaken for a live one:
    /// the window **still open and still asking** has to start a fresh stream rather than be told
    /// it already has one — and starting it must replace its own claim, not add a second.
    ///
    /// Both halves are the round this test was rewritten for. The old behaviour cleared `running`
    /// for the *next window* only, and a bare count made the re-ask the console now issues on every
    /// poll add a claim the window never leaves: the count could never reach zero, so the stream a
    /// later window started outlived the last console.
    #[test]
    fn a_stream_that_ended_is_restarted_by_the_window_that_asks_again() {
        let w = HeartbeatWatch::default();
        assert!(
            w.begin_reading("console-1").unwrap(),
            "the window starts the stream"
        );
        w.stream_ended(); // the daemon went away; the window is still open, still counted
        assert!(
            w.begin_reading("console-1").unwrap(),
            "the same window asking again must start a fresh stream, not share a corpse"
        );
        assert_eq!(
            w.peek(),
            (1, true),
            "a re-ask replaces its own claim instead of adding one"
        );
        // …and with no phantom, this window's single close is still the last reader leaving.
        assert!(
            w.finish_reading("console-1").unwrap(),
            "the one window's close stops the stream it restarted"
        );
        assert_eq!(w.peek(), (0, false));
    }

    /// A window that asks again while the stream is **live** shares it (no daemon I/O: the events
    /// already reach it) and holds exactly one claim, so its single close still stops the stream.
    #[test]
    fn a_window_that_asks_again_while_the_stream_is_live_holds_one_claim() {
        let w = HeartbeatWatch::default();
        assert!(
            w.begin_reading("console-1").unwrap(),
            "the first ask starts it"
        );
        assert!(
            !w.begin_reading("console-1").unwrap(),
            "asking again against a live stream shares it"
        );
        assert_eq!(
            w.peek(),
            (1, true),
            "the re-ask must not add a second claim — the window closes once"
        );
        assert!(
            w.finish_reading("console-1").unwrap(),
            "so its single close is the last reader leaving"
        );
        assert_eq!(w.peek(), (0, false));
    }

    /// A stop from a window that holds **no** claim cannot release the one that is still reading.
    /// Keyed removal is what makes that structural: `join_failed` used to exist only because a
    /// bare count could not tell a real reader from a phantom one.
    #[test]
    fn a_window_that_never_joined_cannot_stop_the_stream() {
        let w = HeartbeatWatch::default();
        assert!(
            w.begin_reading("console-1").unwrap(),
            "the reader starts it"
        );
        assert!(
            !w.finish_reading("console-2").unwrap(),
            "a window holding no claim must not release a reader that is still there"
        );
        assert_eq!(w.peek(), (1, true));
    }

    /// The `Err` a start attempt yields when the daemon cannot be reached. The handle type is
    /// uninhabited in the test (nothing was spawned), which is what "the stream never came up" means.
    fn failed_start(why: &str) -> Result<tauri::async_runtime::JoinHandle<()>, String> {
        Err(why.to_string())
    }

    /// A start that **failed** (the daemon was unreachable when this window opened, or on a retry)
    /// must give that window's claim back — not merely clear `running`.
    ///
    /// The defect this pins: the failure path called `stream_ended`, which keeps every claim. That
    /// window never becomes a reader — the console's `startHeartbeats` answers `false` and the
    /// panel says 「本台没有在听」, and the window sends one `link_stop_heartbeats` on close, not one
    /// per attempt — so the phantom claim survives to make the *next* window's close look like a
    /// non-final leave, and the stream that window started is left feeding no console.
    ///
    /// Drives `settle_start` — the same seam `link_watch_heartbeats` resolves its start through —
    /// so a revert of the command's branch to `stream_ended` reddens this test. A test on the
    /// `start_failed` helper alone stayed green under exactly that revert (measured: NC-A).
    #[test]
    fn a_start_that_failed_gives_the_reader_back() {
        let w = HeartbeatWatch::default();
        assert!(
            w.begin_reading("console-1").unwrap(),
            "the first window starts the stream"
        );
        let err = w.settle_start("console-1", failed_start("daemon unreachable"));
        assert_eq!(
            err.expect_err("a failed start must still reach the caller, not be swallowed"),
            "daemon unreachable"
        );
        assert_eq!(
            w.peek(),
            (0, false),
            "a failed start leaves no claim and nothing running, so the next attempt starts fresh"
        );
        // The next window is the *first* reader again, so its close is the last reader leaving:
        // the stream is aborted instead of leaking.
        assert!(
            w.begin_reading("console-2").unwrap(),
            "the next window starts the stream"
        );
        assert!(
            w.finish_reading("console-2").unwrap(),
            "with the phantom gone, the only real reader's close stops the stream"
        );
        assert_eq!(w.peek(), (0, false));
    }

    /// A failed start while another window is still counted (one that opened after the previous
    /// stream died) undoes only the failed starter's claim: the real reader stays counted, and
    /// `running` is cleared so the next join starts a fresh stream rather than attaching to a corpse.
    ///
    /// This is the retry path the console drives on its poll, so the window that failed is the same
    /// one that was already reading.
    #[test]
    fn a_failed_retry_keeps_a_real_reader_and_clears_running() {
        let w = HeartbeatWatch::default();
        assert!(
            w.begin_reading("console-1").unwrap(),
            "the window starts it"
        );
        assert!(
            !w.begin_reading("console-2").unwrap(),
            "a second window shares it"
        );
        w.stream_ended(); // the daemon went away; both windows are still open and counted
        assert!(
            w.begin_reading("console-1").unwrap(),
            "one window's retry starts a fresh stream"
        );
        let _ = w.settle_start("console-1", failed_start("daemon gone")); // …and that retry fails
        assert_eq!(
            w.peek(),
            (1, false),
            "the failed retry's claim is given back, the other window's stays, nothing is running"
        );
    }

    /// A spawned task that never finishes on its own, plus a flag its future sets when dropped —
    /// so a test can tell an **aborted** task from a detached one (dropping a `JoinHandle` detaches).
    fn spawned_task() -> (
        tauri::async_runtime::JoinHandle<()>,
        std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) {
        struct Flag(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Flag {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Flag(dropped.clone());
        let handle = tauri::async_runtime::spawn(async move {
            let _flag = flag;
            std::future::pending::<()>().await;
        });
        (handle, dropped)
    }

    /// Whether `flag` was set within a bounded settle — the runtime drops a cancelled task promptly.
    fn dropped_within(flag: &std::sync::atomic::AtomicBool) -> bool {
        for _ in 0..200 {
            if flag.load(std::sync::atomic::Ordering::SeqCst) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        false
    }

    /// A stream that comes up **after its last reader left** must be aborted, not installed.
    ///
    /// The defect this pins: opening the stream takes a real `await`, and a console can close inside
    /// it — `finish_reading` finds no handle to abort (none is adopted yet) and returns, leaving
    /// `running=false` and no reader. `settle_start`'s `Ok` arm then stored the just-opened task
    /// unconditionally, so the forwarder (and its open daemon stream) outlived the last console for
    /// the process lifetime — the leak `ReaderCount` exists to prevent, on the one arm no test drove
    /// (the sibling rounds `<failed_start>` only ever reached the `Err` arm).
    #[test]
    fn a_start_whose_window_left_while_it_opened_is_aborted_not_installed() {
        let w = HeartbeatWatch::default();
        assert!(
            w.begin_reading("console-1").unwrap(),
            "the window starts the stream"
        );
        // The window closes while the stream is still opening: the last reader leaves with nothing
        // adopted yet, so there is no task for `finish_reading` to abort.
        assert!(
            w.finish_reading("console-1").unwrap(),
            "the only reader's close stops a stream that has not come up yet"
        );
        assert!(
            !w.handle_held(),
            "nothing was adopted before the stream opened"
        );
        // …and now it comes up. Nobody is reading it.
        let (handle, dropped) = spawned_task();
        w.settle_start("console-1", Ok(handle))
            .expect("an abandoned start is not a failure to report");
        assert!(
            !w.handle_held(),
            "a stream whose last reader left must not be installed — that is the process-lifetime leak"
        );
        assert_eq!(
            w.peek(),
            (0, false),
            "and the accounting is unchanged by it"
        );
        assert!(
            dropped_within(&dropped),
            "the orphaned task is aborted, not left detached and running"
        );
        // With the orphan gone, the next window is the first reader again and its close stops its
        // own stream — no handle is left behind from this one.
        assert!(
            w.begin_reading("console-2").unwrap(),
            "the next window starts a fresh stream"
        );
        let (handle, dropped) = spawned_task();
        w.settle_start("console-2", Ok(handle))
            .expect("a start with a live reader is adopted");
        assert!(w.handle_held(), "a stream with a reader is installed");
        assert!(
            w.finish_reading("console-2").unwrap(),
            "its close is the last reader leaving"
        );
        assert!(!w.handle_held(), "and it aborts the stream it installed");
        assert!(
            dropped_within(&dropped),
            "the installed task is the one aborted — adoption and abort agree on the handle"
        );
    }

    /// A window that left and asked again while an earlier start was still opening has **two**
    /// starts in flight under the same key. The first to settle is installed; the second must
    /// abort the one it displaces — dropping a `JoinHandle` detaches, so a plain overwrite would
    /// leave the loser's forwarder and its daemon stream running beside the winner's.
    ///
    /// Reachable because a window label is reused: the console reopens under the same label, and
    /// the old window's `link_watch_heartbeats` can still be awaiting the stream open.
    #[test]
    fn an_earlier_start_the_later_one_supersedes_is_aborted() {
        let w = HeartbeatWatch::default();
        assert!(
            w.begin_reading("robot").unwrap(),
            "the window starts the stream"
        );
        // It closes before that start settles…
        assert!(w.finish_reading("robot").unwrap());
        // …and the label comes back (a reopen) while the first start is still opening.
        assert!(
            w.begin_reading("robot").unwrap(),
            "the reopened window starts its own stream"
        );
        let (first, first_dropped) = spawned_task();
        w.settle_start("robot", Ok(first))
            .expect("the first start to settle is installed");
        assert!(w.handle_held());
        let (second, second_dropped) = spawned_task();
        w.settle_start("robot", Ok(second))
            .expect("the second start supersedes it");
        assert!(w.handle_held(), "one task, not two, feeds the readers");
        assert!(
            dropped_within(&first_dropped),
            "the superseded start is aborted, not detached alongside the winner"
        );
        assert!(
            !second_dropped.load(std::sync::atomic::Ordering::SeqCst),
            "and the winner is the one still held"
        );
        assert!(
            w.finish_reading("robot").unwrap(),
            "the reopened window's close is the last reader leaving"
        );
        assert!(
            dropped_within(&second_dropped),
            "which aborts the winner it installed"
        );
    }

    /// The starter closes while its stream is still opening, **another window is still reading** —
    /// the stream must be installed, because it is that other window's only one.
    ///
    /// The defect this pins (measured in this round's own first attempt): keying the decision on
    /// "is *this* window still counted" aborts the only live stream whenever the starter leaves
    /// first, leaving the survivor with `running=true` and no task — its asks answer `false`
    /// ("you are fed") forever, so it shows 「实时流」 and ages every row without ever receiving a
    /// beat. That is the false liveness the whole accounting exists to refuse, worse than the leak.
    #[test]
    fn a_start_is_installed_while_another_window_is_still_reading() {
        let w = HeartbeatWatch::default();
        assert!(
            w.begin_reading("console-1").unwrap(),
            "the first window starts the stream"
        );
        assert!(
            !w.begin_reading("console-2").unwrap(),
            "the second shares the stream that is opening"
        );
        // The starter closes inside the open; one of two readers leaving does not end the stream.
        assert!(
            !w.finish_reading("console-1").unwrap(),
            "a non-final leave must not stop the stream"
        );
        assert!(
            !w.handle_held(),
            "nothing was adopted before the stream opened"
        );
        let (handle, dropped) = spawned_task();
        w.settle_start("console-1", Ok(handle))
            .expect("the stream a surviving reader waits for is installed");
        assert!(
            w.handle_held(),
            "the second window is still reading: the stream that came up is what feeds it"
        );
        assert!(
            !dropped.load(std::sync::atomic::Ordering::SeqCst),
            "…so it is not aborted — that would be a live-looking channel running nothing"
        );
        // …and the last reader's close is what stops it.
        assert!(
            w.finish_reading("console-2").unwrap(),
            "the last reader leaving stops the stream"
        );
        assert!(!w.handle_held());
        assert!(
            dropped_within(&dropped),
            "which aborts exactly the stream that was adopted"
        );
    }

    /// A start that **fails** reaps the slot too: with two starts in flight under one key, an
    /// earlier one can have been adopted while this one was still opening, and a failed start
    /// leaves `running=false` — so a handle still installed would be a stream nobody wants.
    #[test]
    fn a_failed_start_reaps_a_stream_an_earlier_start_had_adopted() {
        let w = HeartbeatWatch::default();
        assert!(
            w.begin_reading("console-1").unwrap(),
            "the first window starts the stream"
        );
        // It closes before that start settles, and the label comes back while it is still opening.
        assert!(w.finish_reading("console-1").unwrap());
        assert!(
            w.begin_reading("console-1").unwrap(),
            "the reopened window starts its own stream"
        );
        let (first, first_dropped) = spawned_task();
        w.settle_start("console-1", Ok(first))
            .expect("the first start to settle is installed");
        assert!(w.handle_held());
        // …and the second one fails.
        let err = w.settle_start("console-1", failed_start("daemon gone"));
        assert!(
            err.is_err(),
            "the failure still reaches the caller (REQ-A844), not swallowed"
        );
        assert_eq!(
            w.peek(),
            (0, false),
            "a failed start leaves no claim and nothing running"
        );
        assert!(
            !w.handle_held(),
            "…and no stream adopted under a claim that is gone"
        );
        assert!(
            dropped_within(&first_dropped),
            "the adopted task is aborted rather than left feeding nobody"
        );
    }
}
