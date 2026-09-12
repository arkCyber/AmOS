/**
 * Passive telemetry-spy egress audit bridge (System UI side).
 *
 * Consumes the daemon's `telemetry-spy-hit` feed (forwarded by
 * `crates/amos-tauri/src/telemetry_spy.rs` from the `Watch` gRPC stream) and
 * surfaces each high-severity hit as a durable notification under `NOTIF_KEY`
 * (the Notification Center + the Svelte `NotificationBanner` render these).
 *
 * Privacy guard: the forwarded payload carries only *metadata* (which
 * identifier kind leaked, transport, confidence) — never the actual serial /
 * IMEI / cell-id value — so the notification we build here is equally safe.
 * Honest semantics: a hit is a **low-confidence heuristic** (a plaintext
 * device-bound identifier substring), not a claimed confirmed leak; we label
 * evidence via `confidence` rather than shouting "compromised".
 *
 * Pure helpers are unit-tested; `startTelemetrySpyWatcher` is wired once at the
 * app level (outside Tauri it degrades to a no-op unsubscribe).
 */

import { subscribe } from "./backend";
import { readStoreValue, writeStoreValue } from "./amosStore";
import { NOTIF_KEY, addNotif, type Notif } from "./settings";

/** Tauri event name for one daemon telemetry-spy hit (Rust bridge emits this). */
export const SPY_HIT_EVENT = "telemetry-spy-hit";

/** One graded identifier hit, forwarded from the Rust `SpyIdentifierHit`. */
export interface SpyIdentifierHit {
  /** `"serial"` | `"imei"` | `"cell_id"` | `"unknown"`. */
  kind: string;
  /** How many (non-overlapping) occurrences were seen. */
  occurrences: number;
  /** `"low"` | `"medium"` | `"high"` | `"unknown"`. */
  confidence: string;
}

/** Serializable mirror of one daemon `EgressHit` (matches the Rust serde keys). */
export interface SpyHitPayload {
  ts_ms: number;
  iface: string;
  src_ip: string;
  /** `null` when the transport carried no port. */
  src_port: number | null;
  dst_ip: string;
  dst_port: number | null;
  /** `"tcp"` | `"udp"` | `"icmp"` | `"other"` | `"unknown"`. */
  protocol: string;
  hits: SpyIdentifierHit[];
  payload_bytes: number;
  /** Severity (`"high"` for any hit). */
  severity: string;
  confidence: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Defensive normalization of a raw event payload. Returns `null` for anything
 * that is not a well-shaped hit (never trust the wire blindly).
 */
export function toSpyHit(raw: unknown): SpyHitPayload | null {
  if (!isObj(raw)) return null;
  const ts_ms = raw.ts_ms;
  const iface = raw.iface;
  if (typeof ts_ms !== "number" || typeof iface !== "string") return null;
  const src_ip = typeof raw.src_ip === "string" ? raw.src_ip : "";
  const dst_ip = typeof raw.dst_ip === "string" ? raw.dst_ip : "";
  const protocol = typeof raw.protocol === "string" ? raw.protocol : "unknown";
  const severity = typeof raw.severity === "string" ? raw.severity : "high";
  const confidence = typeof raw.confidence === "string" ? raw.confidence : "unknown";
  const src_port = typeof raw.src_port === "number" ? raw.src_port : null;
  const dst_port = typeof raw.dst_port === "number" ? raw.dst_port : null;
  const payload_bytes = typeof raw.payload_bytes === "number" ? raw.payload_bytes : 0;
  if (!Array.isArray(raw.hits)) return null;
  const hits: SpyIdentifierHit[] = [];
  for (const h of raw.hits) {
    if (!isObj(h)) continue;
    const kind = typeof h.kind === "string" ? h.kind : "unknown";
    const conf = typeof h.confidence === "string" ? h.confidence : "unknown";
    const occurrences = typeof h.occurrences === "number" ? h.occurrences : 0;
    hits.push({ kind, occurrences, confidence: conf });
  }
  if (hits.length === 0) return null;
  return { ts_ms, iface, src_ip, src_port, dst_ip, dst_port, protocol, hits, payload_bytes, severity, confidence };
}

/**
 * Shape of the app i18n `t(key, params)` used to localize notification copy at
 * write-time. The shell's `t` (`svelte/locale.svelte.ts`) fixes this `{param}`
 * interpolation contract.
 */
export type SpyTranslate = (key: string, params?: Record<string, string | number>) => string;

/** i18n key for an identifier kind (missing from the default English fallback). */
export function kindKey(kind: string): string {
  switch (kind) {
    case "serial":
      return "spy.kind.serial";
    case "imei":
      return "spy.kind.imei";
    case "cell_id":
      return "spy.kind.cellId";
    default:
      return "spy.kind.unknown";
  }
}

/** i18n key for an evidence-confidence grade. */
export function confidenceKey(level: string): string {
  switch (level) {
    case "high":
      return "spy.conf.high";
    case "medium":
      return "spy.conf.medium";
    case "low":
      return "spy.conf.low";
    default:
      return "spy.conf.unknown";
  }
}

/** Human label for an identifier kind (neutral English; used without a translator). */
export function kindLabel(kind: string): string {
  switch (kind) {
    case "serial":
      return "hardware serial";
    case "imei":
      return "IMEI";
    case "cell_id":
      return "cell ID";
    default:
      return "unknown identifier";
  }
}

/** True for any surfaced telemetry-spy hit (the daemon only emits high hits). */
export function isHigh(hit: SpyHitPayload): boolean {
  return hit.severity === "high";
}

/**
 * Build a durable, **non-sensitive** notification for a hit. Never echoes the
 * actual serial/IMEI/cell-id value — only kind + transport metadata.
 *
 * When a `fmt` translator is supplied the copy is localized through the i18n
 * dictionaries at write-time (matching the shell's current language); without
 * one the helper falls back to neutral English so pure callers/tests stay
 * deterministic.
 */
export function spyNotif(hit: SpyHitPayload, now = Date.now(), fmt?: SpyTranslate): Notif {
  const kinds = hit.hits.map((h) => (fmt ? fmt(kindKey(h.kind)) : kindLabel(h.kind))).join(", ");
  const dst = hit.dst_port != null ? `${hit.dst_ip}:${hit.dst_port}` : hit.dst_ip;
  const id = `spy:${hit.ts_ms}:${hit.iface}:${hit.hits.map((h) => h.kind).join("+")}`;
  if (fmt) {
    return {
      id,
      app: fmt("spy.app"),
      icon: "🛰️",
      title: fmt("spy.notif.title", { kinds }),
      body: fmt("spy.notif.body", {
        protocol: hit.protocol,
        dst,
        iface: hit.iface,
        confidence: fmt(confidenceKey(hit.confidence)),
      }),
      time: now,
    };
  }
  return {
    id,
    app: "Telemetry spy",
    icon: "🛰️",
    title: `Outbound leak risk: ${kinds}`,
    body: `${hit.protocol} to ${dst} on ${hit.iface} — evidence: ${hit.confidence}`,
    time: now,
  };
}

/**
 * Persist a hit into the shared notification store so the Notification Center /
 * banner can show it (newest-first, capped). Best-effort: never throws.
 */
export function recordSpyHit(hit: SpyHitPayload, fmt?: SpyTranslate): void {
  const list = readStoreValue<Notif[]>(NOTIF_KEY, []);
  writeStoreValue(NOTIF_KEY, addNotif(list, spyNotif(hit, Date.now(), fmt)));
}

/**
 * Subscribe to the `telemetry-spy-hit` feed and invoke `onHit` for every
 * well-shaped high hit. Returns an unsubscribe (no-op outside Tauri).
 */
export async function startTelemetrySpyWatcher(
  onHit: (hit: SpyHitPayload) => void,
): Promise<() => void> {
  return subscribe(SPY_HIT_EVENT, (raw) => {
    const hit = toSpyHit(raw);
    if (hit && isHigh(hit)) onHit(hit);
  });
}
