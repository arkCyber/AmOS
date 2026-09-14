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
 * * counters are cumulative since the node started and are never reset.
 */
import { bridged, invoke } from "./backend";

/** One peer the link has heard from. */
export interface LinkPeer {
  id: string;
  /** `robot` | `brain` | `sensor` | `actuator` | `tool` | `unknown`. */
  kind: string;
  /** Transport endpoint, or `null` when the beacon carried none. */
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
