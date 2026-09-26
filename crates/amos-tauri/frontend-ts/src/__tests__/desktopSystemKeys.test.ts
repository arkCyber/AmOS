/**
 * desktopSystemKeys.test.ts — the shared "acts on the focused window" layer (REQ-A419).
 *
 * Why this file exists: the intent table moved out of `DesktopShell.svelte` so an **app
 * window** could use it too (measured on this machine: after REQ-A416 took the desktop
 * chrome out of app windows, ⌘W stopped closing the window it was pressed in). A table
 * shared by two mount points is exactly the thing that must be pinned in one place.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  actionableLabelOf,
  deadChordMessage,
  newWindowTarget,
  refusedChordMessage,
  runSystemIntent,
  systemIntentFor,
} from "../svelte/desktopSystemKeys";

type Call = { cmd: string; args?: Record<string, unknown> };
let calls: Call[] = [];
let realWindow: unknown;

/**
 * The bridge's `invoke` shape: a resolved (non-null) value means "the host did it", and
 * `null` means "no bridge / the command failed" (`lib/backend`). `refuse` drives the second
 * answer — the one the close bug hid behind (REQ-A430).
 */
function installHost(opts: { refuse?: boolean } = {}): void {
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return opts.refuse ? null : { windows: [] };
      },
    },
  };
}

beforeEach(() => {
  realWindow = (globalThis as { window?: unknown }).window;
  calls = [];
  installHost();
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});


describe("systemIntentFor", () => {
  test("maps the focused-window ids and only those", () => {
    expect(systemIntentFor("closeWindow")).toBe("close-window");
    // REQ-A724: ⌘M minimizes and ⌘H hides — two chords, two intents (they used to collapse
    // into `hide-window`, so the row labelled "Minimize" hid the window).
    expect(systemIntentFor("minimizeWindow")).toBe("minimize-window");
    expect(systemIntentFor("hideApp")).toBe("hide-window");
    expect(systemIntentFor("preferences")).toBe("open-preferences");
    // REQ-A473: the two per-app window chords.
    expect(systemIntentFor("newWindow")).toBe("new-window");
    expect(systemIntentFor("cycleWindows")).toBe("cycle-window");
    // Other domains' bindings (spaces / overlays / touch) are not ours.
    expect(systemIntentFor("spacesPanel")).toBeNull();
    expect(systemIntentFor("launchpad")).toBeNull();
    expect(systemIntentFor("")).toBeNull();
  });
});

// ─── REQ-A473: the per-app window chords ──────────────────────────────────────────────

describe("newWindowTarget — which app a per-app chord acts on", () => {
  test("the focused window's app wins (macOS: File ▸ New Window duplicates this app)", () => {
    expect(newWindowTarget("notes")).toBe("notes");
    expect(newWindowTarget("store:org.amos.pomodoro")).toBe("store:org.amos.pomodoro");
  });

  test("an instance window names its **app**, not the window", () => {
    // The defect this prevents: the host refuses an instance label as an app id on purpose,
    // so forwarding `files_2` would turn ⌘N on the second Files window into an error.
    expect(newWindowTarget("files_2")).toBe("files");
  });

  test("nothing app-shaped focused ⇒ the shell's own file manager", () => {
    // The launcher (`main`) is not an app, and neither is a container surface: the rule is
    // stated here once, for the menu row, ⌘N and the native menu item alike.
    for (const none of [null, undefined, "", "main", "legacy:waydroid_0", "app-3"]) {
      expect(newWindowTarget(none)).toBe("files");
    }
  });
});

describe("runSystemIntent — the per-app chords send the app, never the label", () => {
  test("new-window asks the host for one more window of the focused app", async () => {
    const outcome = await runSystemIntent("new-window", "notes");
    expect(outcome).toEqual({ command: "wm_new_window", reason: null });
    expect(calls).toEqual([{ cmd: "wm_new_window", args: { appId: "notes" } }]);
  });

  test("new-window from an instance window resolves to its app first", async () => {
    await runSystemIntent("new-window", "files_2");
    expect(calls).toEqual([{ cmd: "wm_new_window", args: { appId: "files" } }]);
  });

  test("new-window with nothing focused still acts (Files), and a refusal is reported", async () => {
    const ok = await runSystemIntent("new-window", null);
    expect(ok).toEqual({ command: "wm_new_window", reason: null });
    expect(calls).toEqual([{ cmd: "wm_new_window", args: { appId: "files" } }]);

    calls = [];
    installHost({ refuse: true });
    const refused = await runSystemIntent("new-window", "notes");
    expect(refused).toEqual({ command: "wm_new_window", reason: "host-refused" });
  });

  test("cycle-window walks the focused app's ring, forward or backward", async () => {
    await runSystemIntent("cycle-window", "files_2");
    expect(calls).toEqual([{ cmd: "wm_cycle_app", args: { appId: "files", forward: true } }]);

    calls = [];
    await runSystemIntent("cycle-window", "files_2", { forward: false });
    expect(calls).toEqual([{ cmd: "wm_cycle_app", args: { appId: "files", forward: false } }]);
  });

  test("cycle-window with no app window is a dead chord, not a command", async () => {
    // ⌘` next to the desktop has nothing to cycle within — the same honest non-event ⌘W
    // reports rather than a command that silently does nothing (F-SH-001 family).
    const outcome = await runSystemIntent("cycle-window", "main");
    expect(outcome).toEqual({ command: null, reason: "no-actionable-window" });
    expect(calls).toEqual([]);
  });

  test("every intent has a sentence for the dead-chord case", () => {
    for (const intent of [
      "close-window",
      "hide-window",
      "minimize-window",
      "open-preferences",
      "new-window",
      "cycle-window",
    ] as const) {
      expect(deadChordMessage(intent).length).toBeGreaterThan(10);
    }
  });
});


describe("actionableLabelOf", () => {
  test("the launcher is never a target, and neither is an absent window", () => {
    // `main` IS the desktop: closing or hiding it takes the whole shell with it (F-SH-008).
    expect(actionableLabelOf("main")).toBeNull();
    expect(actionableLabelOf(null)).toBeNull();
    expect(actionableLabelOf(undefined)).toBeNull();
    expect(actionableLabelOf("")).toBeNull();
    expect(actionableLabelOf("notes")).toBe("notes");
  });
});

describe("runSystemIntent", () => {
  test("close / hide / minimize go to the window; preferences needs no window at all", async () => {
    expect(await runSystemIntent("close-window", "notes")).toEqual({
      command: "wm_close",
      reason: null,
    });
    expect(await runSystemIntent("hide-window", "notes")).toEqual({
      command: "wm_hide",
      reason: null,
    });
    // REQ-A724: ⌘M must reach `wm_minimize` (the platform's minimize), NOT `wm_hide` — the
    // one behaviour this file exists to pin, because hiding takes the window out of the
    // model and the Dock stops showing the app as running.
    expect(await runSystemIntent("minimize-window", "notes")).toEqual({
      command: "wm_minimize",
      reason: null,
    });
    expect(await runSystemIntent("open-preferences", null)).toEqual({
      command: "wm_open",
      reason: null,
    });
    expect(calls.map((c) => c.cmd)).toEqual(["wm_close", "wm_hide", "wm_minimize", "wm_open"]);
    expect(calls[0]?.args).toEqual({ label: "notes" });
    expect(calls[2]?.args).toEqual({ label: "notes" });
    expect(calls[3]?.args).toEqual({ label: "settings" });
  });

  test("with nothing to act on it sends NO command and says WHY", async () => {
    // A key that silently does nothing is the defect; the caller gets a reason code it can
    // report (REQ-A424 — before this the call returned a bare `null` that both call sites
    // dropped on the floor, which is how "⌘W closed nothing" stayed unexplained).
    expect(await runSystemIntent("close-window", null)).toEqual({
      command: null,
      reason: "no-actionable-window",
    });
    expect(await runSystemIntent("hide-window", null)).toEqual({
      command: null,
      reason: "no-actionable-window",
    });
    expect(await runSystemIntent("minimize-window", null)).toEqual({
      command: null,
      reason: "no-actionable-window",
    });
    expect(calls).toEqual([]);
  });

  test("a command the host REFUSES is reported as such, not as success (REQ-A430)", async () => {
    // The live defect this pins: `wm_close` answered "ok" while the window stayed on screen,
    // so from the user's chair ⌘W was dead and nothing anywhere said otherwise. The outcome
    // now distinguishes "sent and accepted" from "sent and refused".
    installHost({ refuse: true });
    expect(await runSystemIntent("close-window", "notes")).toEqual({
      command: "wm_close",
      reason: "host-refused",
    });
    expect(await runSystemIntent("open-preferences", null)).toEqual({
      command: "wm_open",
      reason: "host-refused",
    });
    // The command really was attempted (the refusal is the host's answer, not a skip).
    expect(calls.map((c) => c.cmd)).toEqual(["wm_close", "wm_open"]);
  });
});

describe("the two dead-chord sentences", () => {
  test("every no-target outcome has a sentence that names the chord", () => {
    // The message is what a person reads in the diagnostic ledger: it must name the chord
    // and the rule, not repeat the machine code.
    expect(deadChordMessage("close-window")).toContain("⌘W");
    expect(deadChordMessage("close-window")).toContain("F-SH-008");
    // REQ-A724: the two chords name themselves — ⌘H hides, ⌘M minimizes. The sentence used
    // to say "⌘M/⌘H" for the single collapsed intent, which read as one action.
    expect(deadChordMessage("hide-window")).toContain("⌘H");
    expect(deadChordMessage("minimize-window")).toContain("⌘M");
    expect(deadChordMessage("open-preferences")).toContain("⌘,");
    for (const intent of [
      "close-window",
      "hide-window",
      "minimize-window",
      "open-preferences",
    ] as const) {
      expect(deadChordMessage(intent).length).toBeGreaterThan(20);
    }
  });

  test("a refusal names the target and the fact that the host said no", () => {
    // "Nothing to act on" and "the host refused" are different facts; conflating them is how
    // the close bug hid (REQ-A430).
    const refused = refusedChordMessage("close-window", "notes");
    expect(refused).toContain("refused");
    expect(refused).toContain("notes");
    expect(refused).not.toContain("F-SH-008"); // not the no-target sentence
    expect(refusedChordMessage("open-preferences", null)).toContain("Preferences");
  });
});
