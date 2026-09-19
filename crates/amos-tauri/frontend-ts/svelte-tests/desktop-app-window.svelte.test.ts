/**
 * desktop-app-window.svelte.test.ts — an **app window** keeps its own system keys (REQ-A419).
 *
 * The regression this pins was found by running the app on a real Mac: after REQ-A416 made an
 * app window render its own app instead of the desktop chrome, the window had **no key
 * handler at all** — with the Settings window key, ⌘W closed nothing (⌘, kept working only
 * because it is a native-menu accelerator the OS owns). macOS closes *the window you are in*
 * on ⌘W, so the window itself must own that chord.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopAppWindow from "../src/svelte/DesktopAppWindow.svelte";
import { resetDesktopFeaturesForTest } from "../src/lib/desktopFeatures";

type Call = { cmd: string; args?: Record<string, unknown> };
let calls: Call[] = [];

/**
 * Which capabilities the host says are switched off. `null` = the host does not answer
 * (the default fake host below answers `null` for everything) — that is the *unset
 * environment* case, and it keeps every capability at its documented default.
 */
let hostDisabled: string[] = [];

function installHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "desktop_features_disabled") return hostDisabled;
      return null;
    },
    listen: async () => () => {},
  };
}

/** A keydown the shell's capture listener sees (it must be cancelable to be consumable). */
function press(key: string, mods: Record<string, boolean> = {}): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, cancelable: true, ...mods });
  window.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  window.localStorage.clear();
  calls = [];
  installHost();
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as unknown as { __amosDisabledFeatures?: unknown }).__amosDisabledFeatures;
});

describe("DesktopAppWindow — the window owns its own system keys", () => {
  test("⌘W closes THIS window (no focus poll, no neighbour)", async () => {
    render(DesktopAppWindow, { props: { id: "settings" } });
    await tick();
    const ev = press("w", { metaKey: true });
    await tick();
    expect(calls.filter((c) => c.cmd === "wm_close")).toEqual([
      { cmd: "wm_close", args: { label: "settings" } },
    ]);
    // Consumed: the chord must not reach the app's own controls as a plain `w`.
    expect(ev.defaultPrevented).toBe(true);
  });

  test("⌘H hides THIS window; ⌘, opens Settings (no window needed)", async () => {
    render(DesktopAppWindow, { props: { id: "notes" } });
    await tick();
    press("h", { metaKey: true });
    press(",", { metaKey: true });
    await tick();
    expect(calls.filter((c) => c.cmd === "wm_hide")).toEqual([
      { cmd: "wm_hide", args: { label: "notes" } },
    ]);
    expect(calls.filter((c) => c.cmd === "wm_open")).toEqual([
      { cmd: "wm_open", args: { label: "settings" } },
    ]);
  });

  test("a plain key is NOT swallowed (typing `w` in the app stays typing)", async () => {
    render(DesktopAppWindow, { props: { id: "notes" } });
    await tick();
    const ev = press("w");
    await tick();
    expect(ev.defaultPrevented).toBe(false);
    expect(calls.filter((c) => c.cmd === "wm_close")).toEqual([]);
  });

  test("AMOS_DESKTOP_SHORTCUTS=disabled ⇒ the window leaves the chords alone", async () => {
    (window as unknown as { __amosDisabledFeatures?: string[] }).__amosDisabledFeatures = [
      "shortcuts",
    ];
    render(DesktopAppWindow, { props: { id: "settings" } });
    await tick();
    const ev = press("w", { metaKey: true });
    await tick();
    expect(ev.defaultPrevented).toBe(false);
    expect(calls.filter((c) => c.cmd === "wm_close")).toEqual([]);
  });

  /**
   * REQ-A439 — ⌘A. The platform never delivers `selectAll:` to us: measured on a live app
   * (2026-09-19) ⌘A / ⇧⌘A / ⌥⇧⌘A did nothing in this window's search field, ⌘A+⌘C left the
   * pasteboard empty, and the *same keystrokes* in TextEdit selected and copied. So the window
   * performs the gesture itself — and, just as important, it must **not** claim ⌘A when no
   * editable element has the focus (that would be a fresh dead chord, F-SH-001).
   */
  test("⌘A selects the focused field and is consumed", async () => {
    render(DesktopAppWindow, { props: { id: "files" } });
    await tick();
    const field = document.createElement("input");
    field.value = "select-me";
    document.body.append(field);
    field.focus();
    const before = calls.length;

    const ev = press("a", { metaKey: true });
    await tick();

    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe("select-me".length);
    // Consumed as an editing gesture, not routed anywhere as a desktop action.
    expect(ev.defaultPrevented).toBe(true);
    expect(calls.length).toBe(before);
    field.remove();
  });

  test("⌘A is left alone when nothing editable has the focus (no new dead key)", async () => {
    render(DesktopAppWindow, { props: { id: "files" } });
    await tick();
    (document.activeElement as HTMLElement | null)?.blur();

    const ev = press("a", { metaKey: true });
    await tick();
    expect(ev.defaultPrevented).toBe(false);
  });

  test("⌘A still works with AMOS_DESKTOP_SHORTCUTS=disabled (it is editing, not a shortcut)", async () => {
    (window as unknown as { __amosDisabledFeatures?: string[] }).__amosDisabledFeatures = [
      "shortcuts",
    ];
    render(DesktopAppWindow, { props: { id: "files" } });
    await tick();
    const field = document.createElement("input");
    field.value = "still-selectable";
    document.body.append(field);
    field.focus();

    press("a", { metaKey: true });
    await tick();
    expect(field.selectionEnd).toBe("still-selectable".length);
    field.remove();
  });
});

/**
 * REQ-A453 — the **host** answer reaches an app window (the production path).
 *
 * The block above proves the window honours the capability when the module knows it. This one
 * pins the half that was missing: `lib/desktopFeatures.ts` holds the host's answer in
 * **module** state, so it is per-WebView — and an app window's WebView renders
 * `DesktopAppWindow`, not `DesktopShell`, which was the only surface that ever asked. The
 * consequence was measured on this machine (2026-09-19) with a freshly built `Amos.app`
 * launched through LaunchServices and `AMOS_DESKTOP_SHORTCUTS=disabled`:
 *
 *   | surface | host log | ⌘W |
 *   |---|---|---|
 *   | Launcher (`DesktopShell`) | `desktop shell capabilities disabled by the environment disabled=["shortcuts"]` | left alone (correct) |
 *   | Files window (`DesktopAppWindow`) | same line, but this WebView never asked | **closed the window** — the switch the operator set did nothing here |
 *
 * Deliberately **no** `window.__amosDisabledFeatures` in these cases: they drive the host
 * round-trip (`desktop_features_disabled`) that production uses, which is exactly what the
 * test-hook case above cannot see.
 */
describe("DesktopAppWindow — the host's capability answer reaches an app window (REQ-A453)", () => {
  beforeEach(() => {
    resetDesktopFeaturesForTest();
  });
  afterEach(() => {
    resetDesktopFeaturesForTest();
    hostDisabled = [];
  });

  test("a host answer of ['shortcuts'] stops this window claiming ⌘W", async () => {
    hostDisabled = ["shortcuts"];
    render(DesktopAppWindow, { props: { id: "settings" } });
    await tick();
    await tick();
    // The window really did ask (otherwise this case would pass for the wrong reason).
    expect(calls.filter((c) => c.cmd === "desktop_features_disabled").length).toBe(1);

    const ev = press("w", { metaKey: true });
    await tick();
    expect(ev.defaultPrevented).toBe(false);
    expect(calls.filter((c) => c.cmd === "wm_close")).toEqual([]);
  });

  test("positive control: an EMPTY host answer keeps ⌘W closing this window", async () => {
    // Without this the case above would also pass on a window that had simply stopped
    // handling ⌘W at all (F-SH-005: a rule is only pinned when both answers are exercised).
    hostDisabled = [];
    render(DesktopAppWindow, { props: { id: "settings" } });
    await tick();
    await tick();

    const ev = press("w", { metaKey: true });
    await tick();
    expect(ev.defaultPrevented).toBe(true);
    expect(calls.filter((c) => c.cmd === "wm_close")).toEqual([
      { cmd: "wm_close", args: { label: "settings" } },
    ]);
  });
});
