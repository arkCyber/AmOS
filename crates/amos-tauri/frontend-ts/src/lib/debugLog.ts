/**
 * Lightweight namespaced diagnostic outlet for on-device diagnosis (audit P1-3).
 *
 * On the Android WebView (Tauri), `console.*` output surfaces in adb logcat, so
 * these helpers remain the primary instrument for "why is X not rendering on the
 * device" questions. But console output is *invisible to the user and gone after a
 * reload*, so this module is also the shell's single, **bounded** diagnostic ledger:
 * a UI can show recent failures (and the Settings → AI card does), instead of every
 * failure path inventing its own `console.warn` that nobody can retrieve later.
 *
 * Honesty rules:
 *  - the ring holds at most [`RING_CAP`] entries and **counts what it dropped**:
 *    `evicted` (ring full) and `suppressed` (below the level threshold). A short list
 *    must never imply "nothing else happened".
 *  - logging can never break the app: a hostile `detail` (circular, `BigInt`, a
 *    throwing getter) is rendered defensively and truncated; nothing here throws.
 *  - the level threshold defaults to `info`. Setting `amos.debug.log = "0"` (the
 *    pre-existing "quiet console" switch) silences the console AND raises the
 *    threshold to `warn`, so "off" cannot silently fill the ledger with info noise.
 *
 * Usage:
 *   import { amosLog, amosWarn, amosError } from "../lib/debugLog";
 *   amosLog("shell", "show home", { locked, active, layout });
 *   amosWarn("backend", "info_fetch failed", bridgeDiag());
 */

const PREFIX = "[amos]";

export type DiagLevel = "debug" | "info" | "warn" | "error";

/** One recorded diagnostic. `detail` is a safe, truncated string ("" when none). */
export interface DiagEntry {
  /** Monotonic id (stable across the session; survives `clear()`). */
  seq: number;
  /** Wall-clock ms. */
  ts: number;
  level: DiagLevel;
  /** Subsystem tag, e.g. "backend" / "store" / "monitor". */
  area: string;
  msg: string;
  detail: string;
}

/** Bounded ledger size — a long session must not grow memory (P1-4). */
export const RING_CAP = 200;
/** Per-entry detail cap, in characters. */
const DETAIL_CAP = 500;

const ORDER: Record<DiagLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Opt out of noisy *console* logs (kept on by default for device debugging). */
const CONSOLE_ENABLED =
  typeof window === "undefined" ||
  !window.localStorage ||
  window.localStorage.getItem("amos.debug.log") !== "0";

function readMinLevel(): DiagLevel {
  // Quiet console ⇒ nothing below `warn` is worth recording either.
  if (!CONSOLE_ENABLED) return "warn";
  try {
    const raw = window.localStorage?.getItem("amos.debug.level");
    if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return "info";
}

let minLevel: DiagLevel = readMinLevel();
let ring: DiagEntry[] = [];
let seq = 0;
let evicted = 0;
let suppressed = 0;
const listeners = new Set<(e: DiagEntry) => void>();

function tag(area: string): string {
  return `${PREFIX}[${area}]`;
}

/** Render any value for the ledger without ever throwing or blowing up in size. */
function safeDetail(v: unknown): string {
  if (v === undefined) return "";
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  } catch {
    // Circular / BigInt / a throwing getter: fall back to a plain coercion.
    try {
      s = String(v);
    } catch {
      s = "<unprintable>";
    }
  }
  return s.length > DETAIL_CAP ? `${s.slice(0, DETAIL_CAP)}…(+${s.length - DETAIL_CAP})` : s;
}

/**
 * Record one diagnostic at `level`. Below the threshold it is **not** recorded and
 * `suppressed` is counted (so a caller can never mistake "not shown" for "did not
 * happen"); when the ring is full the oldest entry is dropped and `evicted` counted.
 */
export function diag(level: DiagLevel, area: string, msg: string, data?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) {
    suppressed += 1;
    return;
  }
  const entry: DiagEntry = {
    seq: ++seq,
    ts: Date.now(),
    level,
    area,
    msg,
    detail: safeDetail(data),
  };
  ring.push(entry);
  if (ring.length > RING_CAP) {
    ring.splice(0, ring.length - RING_CAP);
    evicted += 1;
  }
  for (const fn of listeners) {
    // A broken subscriber must not break the logging path.
    try {
      fn(entry);
    } catch {
      /* ignore */
    }
  }
  if (!CONSOLE_ENABLED) return;
  const line = `${tag(area)} ${msg}`;
  const payload = entry.detail === "" ? [] : [entry.detail];
  if (level === "error") console.error(line, ...payload);
  else if (level === "warn") console.warn(line, ...payload);
  else if (level === "debug") console.debug(line, ...payload);
  else console.info(line, ...payload);
}

/** Tagged info log: amosLog("dock", "mounted", { page: 8, dock: 5 }). */
export function amosLog(area: string, msg: string, data?: unknown): void {
  diag("info", area, msg, data);
}

/** Tagged warning log (dock-empty, hidden-state surprises, failed bridge calls). */
export function amosWarn(area: string, msg: string, data?: unknown): void {
  diag("warn", area, msg, data);
}

/** Tagged error log (a failure the user *should* be able to see). */
export function amosError(area: string, msg: string, data?: unknown): void {
  diag("error", area, msg, data);
}

/** The recorded ledger, **newest first**, at most `n` entries (default: all). */
export function recentDiag(n = RING_CAP): DiagEntry[] {
  const out = ring.slice();
  out.reverse();
  return n >= 0 ? out.slice(0, n) : out;
}

/**
 * Honest bookkeeping for the ledger: what it holds, what it dropped, and the policy
 * in force. `evicted`/`suppressed` are monotonic and survive [`clearDiag`], so the
 * UI can say "3 shown, 12 dropped" instead of implying completeness.
 */
export function diagStats(): {
  recorded: number;
  evicted: number;
  suppressed: number;
  cap: number;
  minLevel: DiagLevel;
  consoleEnabled: boolean;
} {
  return {
    recorded: ring.length,
    evicted,
    suppressed,
    cap: RING_CAP,
    minLevel,
    consoleEnabled: CONSOLE_ENABLED,
  };
}

/** Subscribe to new entries (for a live UI). Returns the unsubscribe function. */
export function subscribeDiag(fn: (e: DiagEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Empty the ledger (a UI "clear"), keeping the drop counters and the future policy:
 * clearing the *list* must not erase the fact that entries were dropped.
 */
export function clearDiag(): void {
  ring = [];
}

/** Runtime level change, **persisted** so the choice survives a reload. */
export function setDiagMinLevel(level: DiagLevel): void {
  minLevel = level;
  try {
    window.localStorage?.setItem("amos.debug.level", level);
  } catch {
    /* storage unavailable — the in-memory choice still applies */
  }
}

