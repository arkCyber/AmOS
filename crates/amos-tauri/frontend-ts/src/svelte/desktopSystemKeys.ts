/**
 * desktopSystemKeys.ts — the "acts on the focused window" desktop keys, **once**.
 *
 * REQ-A419. The mapping lived inline in `DesktopShell.svelte` (`switch (id)` over the
 * merged system bindings). That was fine while the desktop shell was mounted in *every*
 * window — but REQ-A416 made an app window render its own app (`DesktopAppWindow`) instead
 * of the desktop chrome, so after that change an app window had **no key handler at all**:
 * ⌘W / ⌘M / ⌘H / ⌘, did nothing in the very window they are supposed to act on (measured on
 * this machine: with the Settings window key, ⌘W closed nothing and F4 opened no Launchpad;
 * ⌘, still worked, because it is a **native menu** accelerator owned by the OS).
 *
 * The fix is not a second switch in a second component — that is how two
 * implementations of one rule start (F-SH-005). It is this module: the intent table, the
 * label resolution and the command dispatch live here, and both the launcher's
 * `DesktopShell` and an app window's `DesktopWindowKeys` call into it.
 *
 * Pure + framework-agnostic except for the final `lib/wm` calls (which are the bridge).
 */
import { wmCloseWithDiag, wmHideWithDiag, wmOpenWithDiag } from "../lib/wm";

/** What a bound system key asks the host to do to the **focused** window. */
export type DesktopSystemIntent = "close-window" | "hide-window" | "open-preferences";

/**
 * The intent for a binding id, or `null` when this id is not one of the focused-window
 * keys (the keyboard settings page may carry other domains' ids).
 *
 * `minimizeWindow` and `hideApp` both map to *hide*: `crates/amos-tauri/src/wm.rs` models a
 * window as Shown/Hidden with no third "minimized" state, so a menu that promises
 * "minimize" must not invent one (macOS itself treats ⌘H as "hide the app").
 */
export function systemIntentFor(id: string): DesktopSystemIntent | null {
  switch (id) {
    case "closeWindow":
      return "close-window";
    case "minimizeWindow":
    case "hideApp":
      return "hide-window";
    case "preferences":
      return "open-preferences";
    default:
      return null;
  }
}

/**
 * The window label a focused-window key should act on, or `null` when it must do nothing.
 *
 * `null` covers both "nothing is focused" and "the launcher is focused": `main` **is** the
 * desktop, and closing or hiding it would take the whole shell (and every app window's
 * parent screen) with it — the F-SH-008 defect this guard exists for.
 *
 * Takes an already-resolved label because that is what both callers have: the launcher reads
 * `wm_windows`' `focused` flag into a label on its own poll, and an app window *is* the
 * window (`DesktopWindowKeys` passes its own id). A snapshot-shaped overload existed for a
 * caller that never appeared, so it is not here.
 */
export function actionableLabelOf(label: string | null | undefined): string | null {
  if (!label || label === "main") return null;
  return label;
}

/**
 * What one bound chord resolved to, and — when nothing happened — **why** (REQ-A424).
 *
 * A chord that fires and closes nothing is indistinguishable, from the user's chair, from
 * a chord the OS never delivered; on this machine the launcher's ⌘W was exactly that
 * (measured 2026-09-18: the host's own `close_key_window` closed the key window when the
 * File ▸ Close Window *item* was invoked, while pressing ⌘W closed nothing). The `reason`
 * is what lets a caller report the difference instead of leaving a dead chord silent.
 */
export interface SystemIntentOutcome {
  /** The command handed to the host (`wm_close` / `wm_hide` / `wm_open`), or `null`. */
  command: string | null;
  /** Why nothing was sent — non-`null` exactly when `command` is `null`. */
  reason: DeadChordReason | null;
}

/** The only ways a bound system chord can end up doing nothing. */
export type DeadChordReason = "no-actionable-window" | "host-refused";

/**
 * Run an intent. Returns what was sent (for logs/tests) **and the reason when nothing
 * was** — a caller can then report "the key did nothing *and why*" instead of leaving the
 * user with a dead chord (REQ-A424; before this it returned a bare `string | null` and
 * both call sites ignored the `null`).
 *
 * REQ-A430: the diag variants are used, so a command the host **refuses** is no longer
 * indistinguishable from one that worked. That is not hypothetical — a `wm_close` that
 * reported success while closing nothing (the window stayed on screen) is exactly how ⌘W
 * looked dead on this machine; a caller now hears `host-refused` and can say so.
 */
export async function runSystemIntent(
  intent: DesktopSystemIntent,
  label: string | null,
): Promise<SystemIntentOutcome> {
  switch (intent) {
    case "close-window": {
      if (!label) return { command: null, reason: "no-actionable-window" };
      const r = await wmCloseWithDiag(label);
      return { command: "wm_close", reason: r.ok ? null : "host-refused" };
    }
    case "hide-window": {
      if (!label) return { command: null, reason: "no-actionable-window" };
      const r = await wmHideWithDiag(label);
      return { command: "wm_hide", reason: r.ok ? null : "host-refused" };
    }
    case "open-preferences": {
      // No window needed: Preferences opens the Settings window.
      const r = await wmOpenWithDiag("settings");
      return { command: "wm_open", reason: r.ok ? null : "host-refused" };
    }
  }
}

/**
 * The sentence a caller reports when a chord had no target — the *reason* is a code, and a
 * code shown to a person is not an explanation. Kept here (not at each call site) so the
 * launcher and an app window cannot describe the same non-event two different ways.
 */
export function deadChordMessage(intent: DesktopSystemIntent): string {
  switch (intent) {
    case "close-window":
      return "⌘W did nothing: the host named no focused app window (the launcher itself is never a target — F-SH-008)";
    case "hide-window":
      return "⌘M/⌘H did nothing: the host named no focused app window (the launcher itself is never a target — F-SH-008)";
    case "open-preferences":
      return "⌘, did nothing: the shell could not open the Settings window";
  }
}

/**
 * The sentence for the **other** way a chord dies: the command was sent and the host refused
 * it (no bridge, or it declined). Kept separate from [`deadChordMessage`] because "there was
 * nothing to act on" and "the host said no" are different facts — the second one is a defect
 * report (REQ-A430: a `wm_close` that reported success while closing nothing is exactly how
 * ⌘W looked dead on a real launch).
 */
export function refusedChordMessage(intent: DesktopSystemIntent, label: string | null): string {
  const what =
    intent === "close-window"
      ? "close"
      : intent === "hide-window"
        ? "hide"
        : "open Preferences for";
  return `the host refused to ${what}${label ? ` \`${label}\`` : ""}: no bridge, or the command failed (see the diagnostic log)`;
}
