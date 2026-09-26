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
 *  - a recorded failure carries its **reason**, not just its name: an exception used to
 *    render as `{}` (`JSON.stringify` drops a non-enumerable `message`), so `safeDetail`
 *    renders exceptions — top-level or nested — as `name: message · first frame`
 *    (REQ-A839).
 *  - every field of an entry is *read by the surface that renders it*: `detail` (the
 *    reason) and `ts` (when) were both stored and dropped at the render point, which is
 *    what `scripts/diag-render-scan.mjs` now asks.
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

/**
 * Is this an exception (this realm's, or another one's)?
 *
 * `instanceof Error` alone is not enough: a rejection that crossed a realm boundary (the
 * Tauri host's `invoke` plumbing, an iframe) is an Error whose prototype is in a different
 * realm, and `instanceof` answers `false` for it. The shape check is the fallback, so
 * `name` + `message` + `stack` must all be strings to qualify — that keeps an ordinary
 * data object (`BridgeDiag`'s `{ ok, kind, command }`) out.
 */
function isErrorLike(v: unknown): v is { name: string; message: string; stack?: string } {
  if (typeof v !== "object" || v === null) return false;
  if (v instanceof Error) return true;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === "string" && typeof o.message === "string" && typeof o.stack === "string"
  );
}

/**
 * Render an exception as text the ledger can keep.
 *
 * `JSON.stringify(new Error("boom"))` is **`"{}"`** — `message` and `stack` are
 * non-enumerable — so before this, an exception handed to a logger reached the ledger (and
 * the device's logcat, which this module's header calls "the primary instrument for 'why is
 * X not rendering on the device' questions") as `{}`: the failure was recorded, its **reason
 * was not** (REQ-A839). The same hole swallowed a whole `BridgeDiag` whose nested `detail`
 * was an Error — `{"ok":false,"kind":"command-failed","detail":{}}`.
 *
 * `name: message` plus the first stack frame is what a reader can act on; the rest of the
 * stack stays in logcat, where it is unbounded.
 */
function errorText(e: { name?: unknown; message?: unknown; stack?: unknown }): string {
  const name = typeof e.name === "string" && e.name !== "" ? e.name : "Error";
  const message = typeof e.message === "string" ? e.message : "";
  const head = message === "" ? name : `${name}: ${message}`;
  const frame =
    typeof e.stack === "string"
      ? e.stack.split("\n").find((l) => /^\s+at\s/.test(l))?.trim()
      : undefined;
  return frame ? `${head} · ${frame}` : head;
}

/** `JSON.stringify` replacer: an exception nested anywhere in the value becomes its text. */
function errReplacer(_key: string, value: unknown): unknown {
  return isErrorLike(value) ? errorText(value) : value;
}

/** Render any value for the ledger without ever throwing or blowing up in size. */
function safeDetail(v: unknown): string {
  if (v === undefined) return "";
  let s: string;
  try {
    if (typeof v === "string") s = v;
    else if (isErrorLike(v)) s = errorText(v);
    // The replacer catches exceptions nested inside a plain object (`{detail: err}`).
    else s = JSON.stringify(v, errReplacer) ?? String(v);
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
 * `HH:MM:SS` for one ledger row, on this device's clock (pure, unit-tested).
 *
 * A row without a time cannot answer "when did that happen", which is half of what a
 * failures panel is asked. Not localizable on purpose: a diagnostic timestamp is read by
 * whoever is diagnosing, and `toLocaleTimeString` would make two devices' logs disagree
 * about the same moment's rendering.
 */
export function clockOf(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "--:--:--";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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

/**
 * The recorded ledger, **newest first**, at most `n` entries (default: all).
 *
 * Asking "what has been recorded since I last looked" is a **mark** question, not a length
 * question (REQ-A853): the ring is bounded by [`RING_CAP`], so `recentDiag(-1).length` stops
 * growing the moment it fills, and a `length - before` window becomes **empty exactly when
 * the ledger is busiest** — an assertion built on it reports "never recorded" about an entry
 * that is sitting in the ring. Take the mark from the newest entry's monotonic `seq`
 * (`recentDiag(1)[0]?.seq ?? 0` — the counter survives eviction and `clearDiag`, so a mark taken
 * before a clear still windows correctly afterwards) and select with
 * `recentDiag(-1).find((e) => e.seq > mark)`.
 */
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

