/**
 * Typed client for the robot **command console** — the write side of the daemon's
 * AmOS-Link control plane (Rust bridge `crates/amos-tauri/src/link.rs`, commands
 * `link_publish` / `link_topics` / `link_watch_heartbeats`). The read side the console
 * also shows lives in `lib/link.ts` (`linkStatus`).
 *
 * Offline contract (mirrors `lib/link.ts` / `lib/backend.ts`): outside Tauri — or when the
 * daemon command fails — every call here returns `null` / a no-op unsubscribe, so the console
 * shows a localized "daemon not connected" state rather than pretending a command was sent.
 *
 * The one rule this module exists to keep straight: **a publish receipt is not proof the
 * command took effect**. It is the transport's account of handing the frame to the bus
 * (`seq`/`matched`/`delivered`/`dropped`), and a `0` in `matched`/`delivered` means 「the transport
 * could not count the subscribers」 (a network transport can never count them), not 「nobody
 * received it」. The exception is `dropped`: it is a **local** count (a QoS policy), so a
 * `dropped > 0` with `delivered === 0` is a *counted* outcome — 「the transport dropped it」 —
 * and must not be read as that same blindness (REQ-A1541, see {@link receiptLevel}).
 * Whether torque actually moved is read back through the return path — `linkStatus().actuations`.
 */
import { bridgeDiag, bridged, invoke, subscribe } from "./backend";
import type { LinkStatus } from "./link";

/** The receipt of one `link_publish` (`PublishReply` on the wire). */
export interface LinkPublishOut {
  /** The sequence number the daemon stamped on the frame. */
  seq: number;
  /** Subscribers whose pattern matched (`0` = the transport cannot count them). */
  matched: number;
  /** Frames accepted by a subscriber queue. */
  delivered: number;
  /** Frames dropped by a QoS policy (should be `0` on the reliable `control` channel). */
  dropped: number;
}

/** The daemon's live topic inventory (`ListTopics`). */
export interface LinkTopicsOut {
  topics: string[];
  /** False when `topics` is **not** the whole truth — never read a partial list as complete. */
  complete: boolean;
}

/** One peer heartbeat, forwarded from the daemon's `StreamHeartbeats`. */
export interface LinkHeartbeat {
  peer: string;
  seq: number;
  uptime_ms: number;
  /** Wall-clock ms since the epoch (a bound, not a measurement, until the clock is synced). */
  stamp_ms: number;
}

/**
 * A beat this console actually **heard**: the peer's counter, and when *we* heard it.
 *
 * The `at` is the arrival on this console's clock, deliberately not the beat's `stamp_ms`: the
 * reporter's clock is not ours (two clocks that disagree can stamp the future — the hazard
 * `actuationAgeMs` refuses), and "when did I last hear from it" is the fact a liveness readout is
 * actually made of.
 */
export interface BeatSeen {
  seq: number;
  /** When this console received the beat, ms since the epoch on this console's clock. */
  at: number;
}

/**
 * How long ago this console last heard from a peer — or `null` when that cannot be said.
 *
 * A heartbeat is a claim of liveness **at the moment it was sent**. Without an age, a robot that
 * powered off mid-session keeps a row that looks exactly like a live one — the same defect the
 * return path fixed for `armed`/`estopped` (REQ-A266). The age is computed from `now`, so the
 * caller must re-render (the console re-reads every 2 s) for it to stay true.
 */
export function beatAgeMs(seen: BeatSeen | undefined, now: number): number | null {
  if (!seen || !Number.isFinite(seen.at) || seen.at <= 0) return null;
  if (seen.at > now) return null;
  return now - seen.at;
}

/** The i18n key for a beat's age (`null` = it could not be stated). */
export function beatAgeKey(ageMs: number | null): string {
  if (ageMs === null) return "robot.beatUnknown";
  // Below a second the peer is *beating*, not *silent*: one sentence, two figures.
  return ageMs < 1_000 ? "robot.beatNow" : "robot.beatAgo";
}

/**
 * What a heartbeat's peer **is**, as far as this console can say (pure, unit-tested).
 *
 * A beat names its sender and nothing else — no role, no endpoint. The daemon says so itself:
 * `stream_heartbeats` watches every peer *and this node* because the stream answers 「is the bus
 * alive」, and 「`GetStatus` is the place to ask *who exactly*」. So the identity of a beat row is a
 * **join against the status this console already holds**, and skipping it is not neutral:
 *
 * * `self` — the daemon's own beat. It is always in the stream (`LinkService::with_heartbeat`
 *   starts the mounted node's heartbeat and the pattern `amos/{peer}/telemetry/beat` matches its own
 *   publish) and it is in **no** other list on this screen: `LinkNode::observe` refuses a node as
 *   its own peer, so it never reaches `status.peers`, and `robotTargets` drops it because its kind
 *   is not `robot`. A robot console that prints its bare id is showing the operator a row that
 *   *looks* like the one robot it can never command.
 * * `peer` — a peer the table resolved, carrying that peer's own role token (the same token the
 *   peer table prints, un-translated by design — see `LinkPeer.kind`). A role this build does not
 *   know arrives as the token the bridge folded it to, never as a guess.
 * * `unknown` — the table cannot place this peer (its beacon aged out of the registry while its
 *   beats kept flowing, or `status` is not in hand). A role must not be invented for it: 「we could
 *   not find it」 and 「we found it, its role is one we do not know」 are different facts.
 */
export type BeatOrigin = { role: "self" } | { role: "peer"; token: string } | { role: "unknown" };

export function beatOrigin(peer: string, s: LinkStatus | null): BeatOrigin {
  if (!s) return { role: "unknown" };
  if (peer === s.peer) return { role: "self" };
  const known = s.peers.find((p) => p.id === peer);
  return known ? { role: "peer", token: known.kind } : { role: "unknown" };
}

// ---------------------------------------------------------------------------
// The reference quadruped's action vocabulary.
//
// These are the `action` keys `Platform::quadruped()` accepts (docs/robot-domains.md §1):
// `arm` / `estop` are the safety pair and ignore speed; the rest are motion gaits.
// ---------------------------------------------------------------------------

/** A control action the reference quadruped understands. */
export type QuadrupedActionKey = "arm" | "estop" | "stand" | "trot" | "walk" | "sit";

/** One entry in the console's command palette. */
export interface QuadrupedAction {
  key: QuadrupedActionKey;
  /** i18n key for the button label. */
  labelKey: string;
  /** Whether the speed slider applies (motion gaits; `arm`/`estop` ignore speed by design). */
  motion: boolean;
  /** Safety actions (`arm`/`estop`) render in their own group, apart from the gaits. */
  safety: boolean;
}

/** The reference quadruped's actions, safety pair first. */
export const QUADRUPED_ACTIONS: QuadrupedAction[] = [
  { key: "estop", labelKey: "robot.actionEstop", motion: false, safety: true },
  { key: "arm", labelKey: "robot.actionArm", motion: false, safety: true },
  { key: "stand", labelKey: "robot.actionStand", motion: true, safety: false },
  { key: "trot", labelKey: "robot.actionTrot", motion: true, safety: false },
  { key: "walk", labelKey: "robot.actionWalk", motion: true, safety: false },
  { key: "sit", labelKey: "robot.actionSit", motion: true, safety: false },
];

/**
 * Build the JSON a robot expects for one action (pure, unit-tested).
 *
 * Motion gaits carry a speed (`{"action":"trot","speed":0.6}`); the safety pair is sent bare
 * (`{"action":"estop"}`) because the robot ignores speed on them anyway — sending it would
 * imply it matters. Speed is rounded to two decimals so a slider cannot emit binary-float
 * noise (`0.30000000000000004`).
 */
export function actionJson(key: QuadrupedActionKey, speed = 0.5): string {
  const action = QUADRUPED_ACTIONS.find((a) => a.key === key);
  if (!action || !action.motion) return JSON.stringify({ action: key });
  const rounded = Math.round(speed * 100) / 100;
  return JSON.stringify({ action: key, speed: rounded });
}

/** Send one action to a robot's control topic. `null` offline / on a failed command. */
export async function robotCommand(
  robot: string,
  action: string,
): Promise<LinkPublishOut | null> {
  if (!bridged()) return null;
  return invoke<LinkPublishOut>("link_publish", { robot, action });
}

/**
 * The outcome of one **fleet** command: which robots this console handed a frame to, and which it
 * could not.
 *
 * A fleet action is N publishes and they need not agree. A robot lands in `sent` when its own
 * `link_publish` answered — the frame reached the bus *for that robot* — and in `failed` when the
 * command answered `null`: not bridged, daemon unreachable, an action this build cannot encode, or
 * a robot id the key-expression grammar refuses. Neither list is an **effect**: a robot in `sent`
 * still has not proven it acted (see {@link robotCommand}), and one in `failed` may still be
 * commanded by hand. The fleet's state is read back per robot through the return path, never here.
 *
 * Both lists are kept rather than a count, because the operator's next move is *per robot*: the
 * point of the receipt is to name the robots a stop did not reach.
 */
export interface FleetReceipt {
  sent: string[];
  failed: string[];
}

/**
 * Send one action to **every** robot in `robots` — the fleet E-Stop's transport.
 *
 * Sequenced, and stopping nowhere: a fleet command that abandons the remaining robots at the first
 * refusal is the one shape this must not have. `robotCommand` answers `null` instead of rejecting
 * (`backend.invoke` folds every failure into `null`), so a partial failure becomes a datum in the
 * receipt rather than an exception, and one call returns the whole verdict.
 *
 * Deliberately **not** in parallel: these go out over a single UDS socket to a single daemon, so
 * overlapping them buys no wall-clock an operator can use, and a burst of N simultaneous calls is
 * work the daemon did not ask for. What a stop needs is that every robot is *reached* — not that
 * they are reached at the same instant.
 */
export async function robotCommandMany(robots: string[], action: string): Promise<FleetReceipt> {
  const sent: string[] = [];
  const failed: string[] = [];
  for (const robot of robots) {
    const r = await robotCommand(robot, action);
    (r === null ? failed : sent).push(robot);
  }
  return { sent, failed };
}

/** Read the daemon's topic inventory. `null` offline / on a failed command. */
export async function linkTopics(): Promise<LinkTopicsOut | null> {
  if (!bridged()) return null;
  return invoke<LinkTopicsOut>("link_topics");
}

/** Narrow an untrusted event payload to a heartbeat, or `null`. */
function asHeartbeat(p: unknown): LinkHeartbeat | null {
  if (typeof p !== "object" || p === null) return null;
  const b = p as Record<string, unknown>;
  if (typeof b.peer !== "string" || typeof b.seq !== "number") return null;
  return {
    peer: b.peer,
    seq: b.seq,
    uptime_ms: typeof b.uptime_ms === "number" ? b.uptime_ms : 0,
    stamp_ms: typeof b.stamp_ms === "number" ? b.stamp_ms : 0,
  };
}

/**
 * Install the heartbeat **listener** and forward each beat to `onBeat`; returns the cleanup.
 *
 * This is the half that has to exist **exactly once per window**: `subscribe` registers a channel
 * on the host, and installing it again on every poll would register the same channel over and
 * over. The returned cleanup unsubscribes **and** releases this window's claim on the stream
 * (`link_stop_heartbeats`, a no-op unless it was the last console reading) — the window stops
 * reading in one moment, so both halves belong to it.
 *
 * REQ-A838: a listener is only half the channel, so a stream is started **only after** one exists
 * ({@link startHeartbeats} is a separate call the caller makes once this resolved). Starting a
 * stream on a refused listen spawns one with no reader: the window waits for beats being emitted
 * past it, and a panel that never updates is indistinguishable from a link that is merely quiet. A
 * failed subscription answers `null` — not a no-op cleanup, which would report a subscription the
 * caller does not have. `invoke` never rejects, so that refusal arrives as `null` too, which is the
 * caller's only way to tell an established channel from a silent one.
 */
export async function listenHeartbeats(
  onBeat: (b: LinkHeartbeat) => void,
): Promise<(() => void) | null> {
  if (!bridged()) return null;
  const unlisten = await subscribe("link-heartbeat", (p) => {
    const b = asHeartbeat(p);
    if (b) onBeat(b);
  });
  if (unlisten === null) return null;
  return () => {
    unlisten();
    void invoke("link_stop_heartbeats");
  };
}

/**
 * Ask the host to (re)start forwarding the heartbeat stream into this WebView. `true` = this
 * console is being fed.
 *
 * Separate from {@link listenHeartbeats} because the two lifetimes are not the same one. The
 * stream is **process-global** (`app.emit` reaches every window) and is not owned by this window's
 * mount: the host ends it when the daemon goes away and clears only its `running` flag, keeping
 * every open window counted precisely so the next ask starts a fresh stream. A console that asked
 * once at mount therefore kept a stream that died under it — its rows aged without bound, and,
 * before a first beat, 「还没有收到心跳。」 claimed a quiet bus while the truth was that this console
 * was not listening — for the rest of the window's life, even as the 2 s status poll showed the
 * daemon back. So the caller re-asks on its poll.
 *
 * That re-ask is free and safe by construction: the host keys the reader accounting by window, so
 * asking again while the stream is live shares it (no second stream, no daemon round trip) and
 * asking again after it died restarts it.
 *
 * REQ-A844 / F-LK-027: `link_watch_heartbeats` is fallible — it has to reach the daemon and open
 * the stream, and `link.rs` deliberately answers `Err` (giving this window's claim back) when it
 * cannot. `invoke` never rejects, so that `Err` arrives as a `null` reply: the verdict is read
 * from the per-command diagnosis (REQ-A296), and discarding it would draw a live-looking channel
 * that is running nothing.
 */
export async function startHeartbeats(): Promise<boolean> {
  if (!bridged()) return false;
  await invoke("link_watch_heartbeats");
  return bridgeDiag("link_watch_heartbeats").ok;
}

/**
 * The peer kind that names a robot on the wire.
 *
 * The wire string is `NodeKind::Robot.key()` (`crates/amos-link/src/discovery.rs`), carried
 * verbatim through the daemon (`service.rs`) and the bridge (`link.rs::peer_out`). The console
 * cannot import it, so `robotVocab.test.ts` reads the Rust arm and pins this constant to it —
 * a re-spelled literal here would silently drop every beacon-only robot from the target list.
 */
export const ROBOT_PEER_KIND = "robot";

/**
 * The candidate target robots for the console (pure, unit-tested): everyone the daemon knows
 * about as a `robot` peer, merged with everyone who has reported on the return path, sorted.
 *
 * Read from *both* because either can be the only one to know a robot: a robot that has not
 * reported yet still appears as a beacon-derived peer, and a robot whose report arrived is
 * named even when its beacon has aged out of the peer table.
 */
export function robotTargets(s: LinkStatus): string[] {
  const ids = new Set<string>();
  for (const a of s.actuations ?? []) ids.add(a.robot);
  for (const p of s.peers) {
    if (p.kind === ROBOT_PEER_KIND) ids.add(p.id);
  }
  return [...ids].sort();
}

/**
 * The robots a **fleet** command addresses: everyone {@link robotTargets} knows, plus the one the
 * operator aimed at by hand when the registry does not know it (pure, unit-tested).
 *
 * `robotTargets` is the registry's answer, and the console invites an operator to type an id it does
 * not have yet (`robot.targetNone` — 「可以手动填一个 id」), because a robot that has not announced
 * itself can still be commanded by name. A fleet stop scoped to the registry would skip the very
 * robot the operator was aiming at — while its button read 「全部」 — and would be disabled outright
 * when the registry is empty, though the single e-stop beside it is pressable for that same robot.
 * Including the aimed id is what makes the count on the button true of what the press covers.
 *
 * A blank `chosen` is the console's **no selection** (an empty input, not a robot named `""`), so it
 * is not added; a `chosen` already in `known` is not duplicated.
 */
export function fleetTargets(known: string[], chosen: string): string[] {
  const id = chosen.trim();
  if (!id || known.includes(id)) return [...known];
  return [...known, id].sort();
}

/** How a publish receipt should read. */
export type ReceiptLevel = "reached" | "dropped" | "unknown";

/**
 * Classify a receipt (pure).
 *
 * `delivered > 0` is the only thing that proves a subscriber queue accepted the frame. With
 * `delivered === 0` the two remaining cases are **not** the same fact, and this function used to
 * fold them together (REQ-A1541): a `dropped > 0` is the transport **counting** that a QoS policy
 * threw the frame away — a measured outcome, not a blind spot — while `dropped === 0` is genuinely
 * 「could not count」 (a network transport never counts subscribers, so `matched`/`delivered` stay
 * `0`). Reading the first as the second told the operator the transport 「could not count」 on the
 * very panel whose raw line printed `dropped=1`.
 */
export function receiptLevel(r: LinkPublishOut): ReceiptLevel {
  if (r.delivered > 0) return "reached";
  if (r.dropped > 0) return "dropped";
  return "unknown";
}

/** The i18n key for a receipt level (pure). */
export function receiptKey(level: ReceiptLevel): string {
  switch (level) {
    case "reached":
      return "robot.receiptReached";
    case "dropped":
      return "robot.receiptDropped";
    default:
      return "robot.receiptUnknown";
  }
}

/** The receipt readout, as an operator greps it: `seq=12 matched=1 …` (pure). */
export function receiptSummary(r: LinkPublishOut): string {
  return `seq=${r.seq} matched=${r.matched} delivered=${r.delivered} dropped=${r.dropped}`;
}

/**
 * The fleet receipt as an operator greps it: `sent=2 not-sent=1` (pure).
 *
 * Both halves are always printed, zeros included: `sent=3 not-sent=0` and `sent=0 not-sent=3` are
 * opposite outcomes, and a summary that dropped its zero would let the second read like a command
 * that was never attempted. `sent=0 not-sent=0` is a third thing again — a fleet with no robots in
 * it — so it must not print as either of the above.
 */
export function fleetSummary(r: FleetReceipt): string {
  return `sent=${r.sent.length} not-sent=${r.failed.length}`;
}
