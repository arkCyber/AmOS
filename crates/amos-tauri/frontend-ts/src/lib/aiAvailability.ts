/**
 * Truthful "is AI actually available?" classification for offline-capable apps
 * such as Notes. Notes itself is fully local (never needs AI), but when a
 * feature WOULD use AI (semantic "ask my notes", voice, …) the UI should know
 * whether that is real — and degrade to a clear offline state instead of
 * pretending. Pure + headless so any surface renders the same verdict.
 *
 *   - "offline" : not running inside Tauri at all (no daemon path).
 *   - "unknown" : bridged but the daemon status hasn't been probed yet.
 *   - "mock"    : daemon is serving the deterministic mock (no real model), or a
 *                 real engine was requested but degraded to mock.
 *   - "real"    : a real inference engine is serving.
 */
import { describeEngine, isRealEngine } from "./aiEngine";

export type AiAvailability = "offline" | "unknown" | "mock" | "real";

export interface AiProbe {
  /** Whether the Tauri bridge exists (the daemon path is reachable). */
  bridged: boolean;
  /** The daemon `get_status` reply (null = not probed yet / probe failed). */
  status: { engine?: string; degraded?: boolean } | null;
}

/** True when AI cannot actually serve real inference (offline/mock). */
export function aiIsUnavailable(a: AiAvailability): boolean {
  return a === "offline" || a === "mock";
}

export function classifyAiAvailability(p: AiProbe): AiAvailability {
  // No Tauri shell -> there is no daemon path at all: AI is offline.
  if (!p.bridged) return "offline";
  const s = p.status;
  if (!s) return "unknown"; // bridged but not yet probed
  // A real engine was requested but the daemon is serving mock -> degraded.
  if (s.degraded) return "mock";
  // REQ-A1775 / F-AI-022. The daemon reports its serving **path**, not a bare kind:
  // `engine` is `mock+breaker` / `ollama+cache` (the decorators `crates/amos-ai`
  // appends). So "is a real engine serving?" must be asked of the stripped kind —
  // the one question `isRealEngine`/`describeEngine` already answer, and the rule
  // `lib/netguard.ts::canEnforce` cites. Comparing the raw name against `"mock"`
  // would call a decorated mock (`mock+breaker`, the daemon's own default) a real
  // engine and hide the honest "mock" hint. An absent/empty `engine` means a
  // pre-this-field daemon, which only ever served mock — so "mock", not "unknown".
  return isRealEngine(describeEngine(s)) ? "real" : "mock";
}
