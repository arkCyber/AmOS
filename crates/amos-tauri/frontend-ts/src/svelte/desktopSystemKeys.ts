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
import {
  wmCloseWithDiag,
  wmCycleAppWithDiag,
  wmHideWithDiag,
  wmMinimizeWithDiag,
  wmNewWindowWithDiag,
  wmOpenWithDiag,
} from "../lib/wm";
import { appOfWindowLabel } from "../lib/windowRoute";

/** What a bound system key asks the host to do to the **focused** window. */
export type DesktopSystemIntent =
  | "close-window"
  | "hide-window"
  | "minimize-window"
  | "open-preferences"
  | "new-window"
  | "cycle-window";

/**
 * The intent for a binding id, or `null` when this id is not one of the focused-window
 * keys (the keyboard settings page may carry other domains' ids).
 *
 * `minimizeWindow` (⌘M) and `hideApp` (⌘H) are **different** chords and stay different
 * here (REQ-A724). They used to collapse into one `hide-window`: the note that justified it
 * ("wm.rs models a window as Shown/Hidden with no third 'minimized' state") stopped being
 * true at REQ-A714, which added `wm_minimize` — the platform's own minimize, which leaves
 * the model alone so the Dock keeps its running dot and Mission Control still lists the
 * window. The native Window ▸ Minimize item already calls it; this layer did not, so ⌘M
 * hid while the *same* menu item minimized (and the in-app topbar row, which asked through
 * here, hid too). macOS keeps them distinct for the same reason: ⌘H hides the app, ⌘M drops
 * the window into the Dock as a *running* window.
 *
 * `newWindow` (⌘N) and `cycleWindows` (⌘`) are **per-app** chords (REQ-A473): they act on
 * the application the focused window belongs to, which is what macOS does — File ▸ New
 * Window duplicates *this* app, and ⌘` cycles *this* app's windows.
 */
export function systemIntentFor(id: string): DesktopSystemIntent | null {
  switch (id) {
    case "closeWindow":
      return "close-window";
    case "minimizeWindow":
      return "minimize-window";
    case "hideApp":
      return "hide-window";
    case "preferences":
      return "open-preferences";
    case "newWindow":
      return "new-window";
    case "cycleWindows":
      return "cycle-window";
    default:
      return null;
  }
}

/**
 * Which app a per-app chord should act on, given the **focused window's label**.
 *
 * REQ-A473. Two rules, in this order:
 *
 * 1. A focused window that belongs to an app ⇒ that app. This is macOS's own answer (⌘N
 *    duplicates what you are looking at), and it is why the identity model had to come
 *    first: with one window per app there was no app to duplicate, so the File menu item
 *    had to be renamed to "New Files Window" instead (`menu.rs`, REQ-A434).
 * 2. Nothing focused (or a window that shows no app — the launcher itself) ⇒ **Files**,
 *    which is what Finder's own File ▸ New Window does for the shell. Stated as a rule
 *    rather than a hard-coded command, so the menu row, the ⌘N handler and the native menu
 *    item cannot describe the same chord three different ways.
 */
export function newWindowTarget(focusedLabel: string | null | undefined): string {
  return appOfWindowLabel(focusedLabel) ?? "files";
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
  /** The command handed to the host (`wm_close` / `wm_hide` / `wm_minimize` / `wm_open`), or `null`. */
  command: string | null;
  /** Why nothing was sent — non-`null` exactly when `command` is `null`. */
  reason: DeadChordReason | null;
}

/** The only ways a bound system chord can end up doing nothing. */
export type DeadChordReason = "no-actionable-window" | "host-refused";

/** Options for an intent whose behaviour is not fully determined by its name. */
export interface SystemIntentOptions {
  /**
   * `cycle-window` only: `true` = ⌘` (next), `false` = ⌘⇧` (previous). Ignored by the
   * other intents — they have no direction.
   */
  forward?: boolean;
}

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
 *
 * REQ-A473 adds the two per-app chords. They take the **app** resolved from the focused
 * label (`newWindowTarget` / [`appOfWindowLabel`]) rather than the label itself: the host
 * refuses an instance label as an app id on purpose, so a frontend that forwarded the
 * label would turn ⌘N on the second Files window into an error.
 */
export async function runSystemIntent(
  intent: DesktopSystemIntent,
  label: string | null,
  options: SystemIntentOptions = {},
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
    case "minimize-window": {
      if (!label) return { command: null, reason: "no-actionable-window" };
      const r = await wmMinimizeWithDiag(label);
      return { command: "wm_minimize", reason: r.ok ? null : "host-refused" };
    }
    case "open-preferences": {
      // No window needed: Preferences opens the Settings window.
      const r = await wmOpenWithDiag("settings");
      return { command: "wm_open", reason: r.ok ? null : "host-refused" };
    }
    case "new-window": {
      // `null` is *not* a dead chord here: with nothing focused the target is the shell's
      // own file manager (`newWindowTarget`), which is what Finder's File ▸ New Window
      // does. Only a host refusal is a failure.
      const appId = newWindowTarget(label);
      const r = await wmNewWindowWithDiag(appId);
      return { command: "wm_new_window", reason: r.ok ? null : "host-refused" };
    }
    case "cycle-window": {
      const appId = appOfWindowLabel(label);
      // No focused *app* window ⇒ nothing to cycle within: macOS's ⌘` also has no meaning
      // when the frontmost thing is the desktop.
      if (!appId) return { command: null, reason: "no-actionable-window" };
      const r = await wmCycleAppWithDiag(appId, options.forward ?? true);
      return { command: "wm_cycle_app", reason: r.ok ? null : "host-refused" };
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
      return "⌘H did nothing: the host named no focused app window (the launcher itself is never a target — F-SH-008)";
    case "minimize-window":
      return "⌘M did nothing: the host named no focused app window (the launcher itself is never a target — F-SH-008)";
    case "open-preferences":
      return "⌘, did nothing: the shell could not open the Settings window";
    case "new-window":
      return "⌘N did nothing: the shell could not open a new window";
    case "cycle-window":
      return "⌘` did nothing: no focused app window, so there is no application whose windows could be cycled";
  }
}

/**
 * The sentence for a chord that did nothing because there was **nothing to show** — App
 * Exposé on an application with fewer than two windows (REQ-A476).
 *
 * It lives here, next to [`deadChordMessage`] and [`refusedChordMessage`], because this
 * module already owns the vocabulary of "a chord did nothing, and why": macOS itself shows
 * nothing in this case, and a chord that silently does nothing is indistinguishable from a
 * broken one — which is exactly what those two functions exist to prevent.
 */
export function appExposeRefusal(appWindowCount: number): string {
  return `⌃↓ did nothing: the focused application has ${appWindowCount} window(s) — App Exposé needs at least two (macOS shows nothing here too, and this says so)`;
}

/**
 * The same sentence for the **other** member of the window-list family: Mission Control
 * (`F3` / `⌘Tab`) with fewer than two application windows (F-SH-361).
 *
 * It is the same fact as [`appExposeRefusal`] — "there was nothing to switch between" — but it
 * names its own count, because Mission Control counts *every* application window while App
 * Exposé counts the focused app's. Both chords are one family, so a reader of the ledger must
 * not have to guess which one was pressed.
 */
export function missionControlRefusal(openWindowCount: number): string {
  return `F3 / ⌘Tab did nothing: ${openWindowCount} application window(s) are open — Mission Control needs at least two (macOS shows nothing here too, and this says so)`;
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
        : intent === "minimize-window"
          ? "minimize"
          : intent === "new-window"
          ? "open another window of"
          : intent === "cycle-window"
            ? "cycle the windows of"
            : "open Preferences for";
  return `the host refused to ${what}${label ? ` \`${label}\`` : ""}: no bridge, or the command failed (see the diagnostic log)`;
}
