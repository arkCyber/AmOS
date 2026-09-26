/**
 * Host power / session actions — typed wrappers for the `session_*` commands
 * (`crates/amos-tauri/src/session.rs`, REQ-A515).
 *
 * There are exactly **three** wrappers rather than one taking an action name, and each
 * writes its command name as a **literal**: the Rust side exposes three zero-argument
 * commands precisely so the WebView has nothing to name (`docs/DESKTOP_ECOSYSTEM_GAP_AUDIT.md`
 * §2 D2), and `tauri-command-scan.mjs` finds consumers by static string — a lookup table
 * keyed by a variable would read as "no screen asks for this".
 *
 * Why `WithDiag` and not a plain `Promise<void>`: `invoke` returns `null` **both** when the
 * bridge is absent and when the command was refused, so `void` would make "the host
 * scheduled the restart" and "the command failed" indistinguishable. These wrappers report
 * which happened, and the host answers with an object on success — never `()`, which Tauri
 * serializes to `null` and would therefore read as a failure here (REQ-A513 / F-SH-053).
 *
 * Honest boundary: a resolved `{ ok: true }` means the host **scheduled** the action (it
 * replies before acting, so the reply can be sent at all). It cannot mean the machine
 * actually went down — nothing survives to tell us. The delay is on the host's side; this
 * module never schedules anything itself.
 */
import { bridgeDiag, invoke } from "./backend";
import type { BridgeDiag } from "./backend";

/** Which host session action to perform. Mirrors the three commands. */
export type SessionAction = "restart" | "shutdown" | "sleep";

/** Either the host scheduled the action, or it did not (with the reason). */
export type SessionOutcome = { ok: true } | { ok: false; diag: BridgeDiag };

/**
 * The host's reply to one of the three commands (`session::SessionPlan` on the Rust side).
 *
 * The shape is **named** rather than left as `unknown` on purpose (REQ-A555): a TS type the
 * reply scanner can resolve (`scripts/tauri-reply-scan.mjs`) is the only way the two sides of
 * this wire can be compared at all. It is not exported — nothing outside this module reads it,
 * and an unused export is what `frontend-ts/scripts/unwired-scan.mjs` exists to catch.
 *
 * `delaySecs` is camelCase because the Rust struct serializes with serde's own rules and that
 * struct declares `rename_all = "camelCase"` (the suite's `the_plan_…` test asserts the wire
 * spelling — a rename there would have to be followed here).
 */
interface SessionPlan {
  /** Which action the host accepted. */
  action: SessionAction;
  /** Seconds it waits before acting, so this reply can be written and read first. */
  delaySecs: number;
}

/** Restart the host. Resolves `ok` once the host has scheduled it. */
export async function sessionRestartWithDiag(): Promise<SessionOutcome> {
  const result = await invoke<SessionPlan>("session_restart");
  if (result !== null) return { ok: true };
  return { ok: false, diag: bridgeDiag("session_restart") };
}

/** Shut the host down. Resolves `ok` once the host has scheduled it. */
export async function sessionShutdownWithDiag(): Promise<SessionOutcome> {
  const result = await invoke<SessionPlan>("session_shutdown");
  if (result !== null) return { ok: true };
  return { ok: false, diag: bridgeDiag("session_shutdown") };
}

/** Suspend the host. Resolves `ok` once the host has scheduled it. */
export async function sessionSleepWithDiag(): Promise<SessionOutcome> {
  const result = await invoke<SessionPlan>("session_sleep");
  if (result !== null) return { ok: true };
  return { ok: false, diag: bridgeDiag("session_sleep") };
}

/**
 * The wrapper for one action.
 *
 * A component that renders three rows needs one place to map a row to its call; keeping
 * that map **here** (next to the literals the command scan reads) means the rows cannot
 * drift from the commands they claim to run. Every branch names a literal-`invoke`
 * wrapper above — there is no way to reach `invoke` with a computed name through this map.
 */
export function sessionActionRunner(
  action: SessionAction,
): () => Promise<SessionOutcome> {
  switch (action) {
    case "restart":
      return sessionRestartWithDiag;
    case "shutdown":
      return sessionShutdownWithDiag;
    case "sleep":
      return sessionSleepWithDiag;
  }
}
