/**
 * Typed client for the daemon's **AmOS-Link** control plane (`RobotLink`,
 * wire contract `proto/robot_link.proto`, Rust bridge
 * `crates/amos-tauri/src/link.rs`). The Settings "Robot Link" page calls
 * `linkStatus()` here.
 *
 * Offline contract (mirrors `lib/backend.ts`): outside Tauri — or when the daemon
 * command fails — `linkStatus()` returns `null`, so the page shows a localized
 * "daemon not connected" state rather than pretending the robot is on the link.
 *
 * Honest semantics, straight from the daemon:
 * * `health` is the daemon's own fold of its counters — `"unknown"` means *no
 *   evidence yet*, which is **not** the same as healthy, and `health_reasons`
 *   explains a non-healthy verdict instead of showing a bare "OK";
 * * `clock_synced: false` means every latency number on the link is a **bound**,
 *   not a measurement (`amos-timesync` has not calibrated the clock);
 * * counters are cumulative since the node started and are never reset;
 * * a status is a **snapshot**, not a live view: `peers[].last_seen_ms` is an age measured at
 *   the moment the daemon answered, and nothing here expires. The panel therefore dates it and
 *   re-reads (`link.probe`, every 10 s while visible) instead of leaving a frozen table on
 *   screen, and a read that gets no answer is treated as **no reading** — this module never
 *   caches one to keep the page looking populated.
 */
import { bridged, invoke } from "./backend";

/** One peer the link has heard from. */
export interface LinkPeer {
  id: string;
  /** `robot` | `brain` | `sensor` | `actuator` | `tool` | `unknown`. */
  kind: string;
  /** Transport endpoint, or `null` when the beacon carried none (the panel prints it when
   * present, and prints nothing — never an empty string or `"null"` — when it is absent). */
  endpoint: string | null;
  last_seen_ms: number;
  /** Beacons observed; `0` = declared by hand (static, never TTL-expired). */
  beacons: number;
}

/** Cumulative link counters (never reset, never faked). */
export interface LinkMetrics {
  published: number;
  delivered: number;
  dropped: number;
  blocked: number;
  decode_errors: number;
  encode_errors: number;
}

/** A command a robot refused before it reached its bus, as the robot itself reported it. */
export interface LinkRefusal {
  seq: number;
  reason: string;
}

/**
 * What one robot says about its own actuation — the control loop's **return path**.
 *
 * It travels the data plane (`amos/<robot>/state/actuation`); the daemon folds it and hands
 * it over the control plane, which is how this panel can show what a robot is *doing*.
 * `null` means "the robot did not report it" — never "zero": `seq: null` is "no action yet",
 * not "action number zero".
 */
export interface LinkActuation {
  robot: string;
  seq: number | null;
  gait: string | null;
  frames: number;
  armed: boolean;
  estopped: boolean;
  /** `"commanded"` | `"watchdog"` | `null` (none, or a reason this build does not know). */
  estop_reason: string | null;
  /** The deadman period the robot runs under; `null` = no watchdog configured. */
  watchdog_ms: number | null;
  last_refusal: LinkRefusal | null;
  /** When the robot published it (ms since the epoch, from the robot's own clock). */
  stamp_ms: number;
}

/** Serializable mirror of the daemon `LinkStatus` (matches the Rust serde keys). */
export interface LinkStatus {
  peer: string;
  kind: string;
  version: string;
  uptime_ms: number;
  clock_synced: boolean;
  /** `"unknown"` | `"healthy"` | `"degraded"` | `"unrecognized"`. */
  health: string;
  health_reasons: string[];
  metrics: LinkMetrics;
  peers: LinkPeer[];
  /**
   * What each robot reports about itself, sorted by id — the control loop's **return path**.
   *
   * **Three states, three facts** (the panel's doctrine is 「absent, not idle」):
   *
   * * `null` — the daemon **did not answer** this question (a build older than the
   *   `ListActuations` RPC, or a bridge that predates the field). The panel must say so, never
   *   render it as 「nobody reported」: it knows nothing about the fleet;
   * * `[]` — the daemon answered and **nobody has reported yet**;
   * * `[…]` — those robots have reported.
   *
   * `null` is the wire's shape for 「not answered」 (`Option::None` on the Rust side, `null` in
   * JSON); `undefined` is accepted too, because an *older bridge* talking to a newer panel is
   * the same version skew in the other direction.
   */
  actuations: LinkActuation[] | null;
}

/** Read the running daemon's link status. Null offline / on a failed command. */
export async function linkStatus(): Promise<LinkStatus | null> {
  if (!bridged()) return null;
  return invoke<LinkStatus>("link_status");
}

/**
 * A display level for the link. `offline` is "no answer from the daemon",
 * `unknown` is "the daemon answered, but with no evidence yet" — keeping them
 * apart is the whole point (a quiet link is not a healthy link).
 */
export type LinkLevel = "unknown" | "healthy" | "degraded" | "offline";

/** Classify a status (or its absence) into a display level (pure, unit-tested). */
export function linkLevel(s: LinkStatus | null): LinkLevel {
  if (!s) return "offline";
  if (s.health === "healthy") return "healthy";
  if (s.health === "degraded") return "degraded";
  // "unknown" *and* any verdict this build does not recognize stay un-asserted:
  // neither may render as a green "healthy".
  return "unknown";
}

/** The i18n key for a level's verdict line (pure). */
export function healthKey(level: LinkLevel): string {
  switch (level) {
    case "healthy":
      return "link.valHealthy";
    case "degraded":
      return "link.valDegraded";
    case "offline":
      return "link.valOffline";
    default:
      return "link.valUnknown";
  }
}

/** Human-readable uptime: `45s`, `2m 05s`, `3h 04m`, `2d 03h` (pure). */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600) % 24;
  const d = Math.floor(total / 86400);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** One-line peer summary: `dog1 (robot), mini-brain (brain)` (pure, order-stable). */
export function peerSummary(peers: LinkPeer[]): string {
  return peers.map((p) => `${p.id} (${p.kind})`).join(", ");
}

/**
 * The counter readout, as an operator greps it: `published=12 delivered=12 …` (pure).
 *
 * Kept out of the template on purpose: these are **machine field names** (the same
 * tokens the CLI and the daemon's `NodeStatus` use), not translatable copy — and
 * building the line here makes the exact set of printed counters unit-testable.
 */
export function counterSummary(m: LinkMetrics): string {
  return `published=${m.published} delivered=${m.delivered} dropped=${m.dropped} blocked=${m.blocked} decode_errors=${m.decode_errors} encode_errors=${m.encode_errors}`;
}

/** A robot's actuation mode, as the panel labels it. */
export type RobotLevel = "estopped" | "armed" | "idle";

/**
 * The state of the **return path** in one status document (pure, unit-tested).
 *
 * `unavailable` is the one a version skew produces: the daemon answered the link status but not
 * the robots' reports (an older build, no `ListActuations`). It must never be rendered like
 * `none` — "we were not told" and "nobody reported" are different facts, and the panel's whole
 * doctrine is 「a robot that has not reported is absent, not idle」.
 */
export type ReturnPathLevel = "unavailable" | "none" | "reported";

/** Classify the return path of a status (pure). `undefined` counts as `null` (older bridge). */
export function returnPathLevel(s: LinkStatus): ReturnPathLevel {
  const list = s.actuations ?? null;
  if (list === null) return "unavailable";
  return list.length > 0 ? "reported" : "none";
}

/** The i18n key for a return-path level (pure). */
export function returnPathKey(level: ReturnPathLevel): string {
  switch (level) {
    case "unavailable":
      return "link.returnPathUnavailable";
    case "reported":
      return "link.robotsReported";
    default:
      return "link.noReports";
  }
}

/**
 * Classify one robot's report (pure, unit-tested).
 *
 * `estopped` wins over `armed`: a latched e-stop is the fact a user must see first, and the
 * bridge's `armed` flag is read from the bus, so the two cannot contradict each other for
 * long. A robot that has not reported (absent from the list) is **not** classified here at
 * all — the caller renders "nobody has reported" instead.
 */
export function robotLevel(a: LinkActuation): RobotLevel {
  if (a.estopped) return "estopped";
  return a.armed ? "armed" : "idle";
}

/** The i18n key for a robot's level (pure). */
export function robotLevelKey(level: RobotLevel): string {
  switch (level) {
    case "estopped":
      return "link.robotEstopped";
    case "armed":
      return "link.robotArmed";
    default:
      return "link.robotIdle";
  }
}

/** A one-line description of what a robot is doing, for the panel's row (pure). */
export function robotSummary(a: LinkActuation): string {
  const mode = a.gait ?? "-";
  const seq = a.seq === null ? "-" : String(a.seq);
  return `${a.robot} · ${mode} · #${seq}`;
}

/**
 * How long ago a robot *reported* — or `null` when that cannot be said.
 *
 * The panel dates its own reading (`link.probe`), but that says nothing about when the robot
 * spoke: a robot that reported `armed: true` and then died would keep showing "armed" with a
 * fresh read time next to it. `armed` / `estopped` are claims about *right now*, so the report
 * carries its own age.
 *
 * Two stamps cannot yield an age, and neither is folded into `0` (which would read as "just
 * now"): a missing stamp (`0` is the proto's sentinel), and one **in the future** — the
 * reporter's clock is not this clock, which is exactly when an age would be a guess. The age is
 * computed from `now`, so the caller must re-render (this page re-reads every 10 s) for it to
 * stay true.
 */
export function actuationAgeMs(a: LinkActuation, now: number): number | null {
  if (!Number.isFinite(a.stamp_ms) || a.stamp_ms <= 0) return null;
  if (a.stamp_ms > now) return null;
  return now - a.stamp_ms;
}

/** The i18n key for a report's age (`null` = it could not be stated). */
export function reportAgeKey(ageMs: number | null): string {
  if (ageMs === null) return "link.reportedUnknown";
  // Below a second a robot is *reporting*, not *stale*: same sentence, different figure, so the
  // key stays one and the copy does not have to guess.
  return ageMs < 1_000 ? "link.reportedNow" : "link.reportedAgo";
}

/**
 * A report's age as text: `250ms`, `2s`, `2m 05s`, `3h 04m`, `2d 03h`.
 *
 * The same shapes the CLI's `format_age_ms` prints, so a terminal and this panel describe an age
 * alike (and the same shapes as {@link formatUptime}: an age *is* a duration).
 */
export function reportAgeText(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return formatUptime(0);
  if (ageMs < 1_000) return `${Math.floor(ageMs)}ms`;
  return formatUptime(ageMs);
}
