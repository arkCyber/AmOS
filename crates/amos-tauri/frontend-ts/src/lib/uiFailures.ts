/**
 * uiFailures.ts — the WebView's **last line of defence** (REQ-A151).
 *
 * Why: the bridge (`lib/backend.ts`) never rejects *by design* — every wrapper catches and
 * returns `null`, recording the failure in the diagnostics ledger (`lib/debugLog`, shown by
 * the AI settings page). But a **callback** on a floating promise can still throw: a reply
 * whose shape is not what the type promised, a `[...x]` on a non-array, a property read on a
 * missing field, a `JSON.parse` of a malformed payload. Round 87 measured the corpus: 45
 * production `.then()` chains run fire-and-forget (`void …`), and **nothing** in the app
 * observed `unhandledrejection` or `error` — so such a throw left the screen empty with no
 * trace anywhere. That is the same defect class this audit keeps finding: a failure nobody
 * can see.
 *
 * This module installs one observer that routes both events into the existing ledger, where
 * `invoke` failures already land and which the UI can read back (`recentDiag`). It does
 * **not** call `preventDefault()`: the ledger adds visibility, it does not muzzle the
 * platform.
 *
 * Honest boundaries:
 *   • a rejection carries *what* was thrown but no `file:line` of its own; its **only**
 *     "where" is `Error.stack`. The observer lifts the first stack frame into the message
 *     (the same `(file:line:col)` shape the `error` event already reports) and keeps the
 *     full stack in the entry's bounded `detail` — but in a production build that frame is
 *     **minified** (`a.js:1:20481`), a hint that needs a source map, not a fix;
 *   • a non-`Error` reason (a string, a plain object, `undefined`) has no stack, so it is
 *     still described by value only;
 *   • an engine may report the same failure through both `error` and `unhandledrejection`;
 *     the observer counts both (it does not try to correlate them);
 *   • it cannot make a broken callback *work* — it makes it **visible** (the fix belongs at
 *     the call site, which is why the sites are listed in the audit rather than "handled").
 */
import { amosError } from "./debugLog";

/** Ledger area every recorded UI failure is tagged with (the diagnostics view groups by it). */
const UI_FAILURE_AREA = "ui";

let installedOn: Window | null = null;
let onRejection: ((ev: Event) => void) | null = null;
let onError: ((ev: Event) => void) | null = null;

/** A short, safe description of whatever was thrown (never throws itself). */
function describe(reason: unknown): string {
  try {
    if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
    if (typeof reason === "string") return reason;
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return "<unprintable rejection reason>";
  }
}

/**
 * The throw-site `file:line:col` of an `Error`'s stack ("" when there is none).
 *
 * A rejection has no `filename`/`lineno` of its own — that is why the `error` branch can
 * print a location and this one, before REQ-A152, could not: the information exists, but
 * only inside `Error.stack`, and `debugLog`'s JSON rendering of an `Error` is `{}`.
 * Returns "" for any non-`Error` (string/plain-object/`undefined` reasons) and for a
 * hostile `stack` getter; it never throws.
 */
function frameOf(reason: unknown): string {
  try {
    const stack = reason instanceof Error ? reason.stack : undefined;
    if (typeof stack !== "string") return "";
    for (const line of stack.split("\n")) {
      // Standard frames read "    at fn (file:line:col)" or "    at file:line:col".
      if (!/^\s*at\s/.test(line)) continue;
      const m = line.match(/([^()\s]+:\d+:\d+)\)?\s*$/);
      const frame = m?.[1];
      if (frame) return frame;
    }
    return "";
  } catch {
    return "";
  }
}

/** The full `Error.stack` ("" when the reason is not an `Error`). Never throws. */
function stackOf(reason: unknown): string {
  try {
    return reason instanceof Error && typeof reason.stack === "string" ? reason.stack : "";
  } catch {
    return "";
  }
}

/**
 * Record one UI failure. `where` (an `Error.stack`, when available) becomes the entry's
 * `detail`: an `Error` JSON-stringifies to `{}`, so passing the reason itself would drop
 * the stack — the only "where" an unhandled rejection carries (REQ-A152).
 */
function record(what: string, reason: unknown, where = ""): void {
  try {
    amosError(UI_FAILURE_AREA, what, where || reason);
  } catch {
    /* the observer must never become a new failure source */
  }
}

/**
 * Install the observer on `target` (defaults to the page `window`). Idempotent: calling it
 * twice is a no-op, so every entry point (shell, headless acceptance page) may call it.
 */
export function installUiFailureObserver(target: Window = window): void {
  if (installedOn === target) return;
  try {
    onRejection = (ev: Event) => {
      const reason = (ev as PromiseRejectionEvent).reason;
      // A rejection event carries no filename/lineno, so the throw site is lifted from
      // the reason's own stack — same "(file:line)" shape the `error` branch reports.
      const frame = frameOf(reason);
      record(
        `unhandled rejection: ${describe(reason)}${frame ? ` (${frame})` : ""}`,
        reason,
        stackOf(reason),
      );
    };
    onError = (ev: Event) => {
      const e = ev as ErrorEvent;
      const where = e.filename ? ` (${e.filename}:${e.lineno ?? 0})` : "";
      record(
        `uncaught error: ${e.message ?? "<no message>"}${where}`,
        e.error ?? ev,
        stackOf(e.error),
      );
    };
    target.addEventListener("unhandledrejection", onRejection);
    target.addEventListener("error", onError);
    installedOn = target;
  } catch {
    // No usable event target: leave nothing half-installed.
    installedOn = null;
    onRejection = null;
    onError = null;
  }
}

/**
 * Detach the observer (tests only).
 *
 * Detaching is not optional: leaving the listeners attached would make a later install add a
 * second pair, and every failure would then be recorded twice — a test-only helper that
 * quietly corrupts the thing it resets.
 */
export function resetUiFailuresForTest(): void {
  if (installedOn && onRejection && onError) {
    installedOn.removeEventListener("unhandledrejection", onRejection);
    installedOn.removeEventListener("error", onError);
  }
  installedOn = null;
  onRejection = null;
  onError = null;
}
