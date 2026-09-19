/**
 * earlySystemKeys.test.ts — the system chords before the shell has mounted (REQ-A431).
 *
 * Measured on this machine: a ⌘W pressed in the first seconds of a new app window's life did
 * nothing (3/6 runs) while the same press after 12 s worked every time (4/4) — the window is
 * created and shown at once, but its key handler lives in the Svelte shell, which appears
 * only after the entry script has hydrated the store and mounted `Shell`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  earlyIntentFor,
  handOverSystemKeys,
  installEarlySystemKeys,
  resetSystemKeysHandoverForTest,
  systemKeysOwnedByShell,
} from "../lib/earlySystemKeys";

type Call = { cmd: string; args?: Record<string, unknown> };
let calls: Call[] = [];
/** Every listener this file installed — removed in `afterEach` (a leftover from one test
 * would answer the next test's key: that is what the returned uninstaller is for). */
let uninstallers: Array<() => void> = [];

function install(ownLabel: string | null): void {
  uninstallers.push(installEarlySystemKeys(ownLabel));
}

function installHost(opts: { refuse?: boolean } = {}): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return opts.refuse ? null : { windows: [] };
    },
  };
}

function press(key: string, mods: Record<string, boolean> = {}): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, cancelable: true, ...mods });
  window.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    /* already registered */
  }
  window.localStorage.clear();
  calls = [];
  uninstallers = [];
  resetSystemKeysHandoverForTest();
  installHost();
});
afterEach(() => {
  uninstallers.forEach((off) => off());
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
  delete (window as unknown as { __amosDisabledFeatures?: unknown }).__amosDisabledFeatures;
  resetSystemKeysHandoverForTest();
});

describe("earlyIntentFor — what the pre-shell listener may do in this window", () => {
  test("close / hide act on THIS window's app, and only when it has one", () => {
    expect(earlyIntentFor("closeWindow", "settings")).toEqual({
      intent: "close-window",
      label: "settings",
    });
    expect(earlyIntentFor("minimizeWindow", "notes")).toEqual({
      intent: "hide-window",
      label: "notes",
    });
    // The launcher has no app of its own: the early phase has no focused-window poll, and
    // guessing a neighbour is worse than doing nothing.
    expect(earlyIntentFor("closeWindow", null)).toBeNull();
    expect(earlyIntentFor("minimizeWindow", null)).toBeNull();
  });

  test("Preferences needs no target, so it works in every window from frame one", () => {
    expect(earlyIntentFor("preferences", null)).toEqual({
      intent: "open-preferences",
      label: null,
    });
    expect(earlyIntentFor("preferences", "photos")).toEqual({
      intent: "open-preferences",
      label: null,
    });
  });

  test("other domains' ids are not ours", () => {
    expect(earlyIntentFor("spacesPanel", "notes")).toBeNull();
    expect(earlyIntentFor("", "notes")).toBeNull();
  });
});

describe("installEarlySystemKeys — the chords work before any component mounts", () => {
  test("⌘W in a fresh app window closes THAT window, and the key is consumed", async () => {
    install("settings");
    const ev = press("w", { metaKey: true });
    await Promise.resolve();
    expect(ev.defaultPrevented).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["wm_close"]);
    expect(calls[0]?.args).toEqual({ label: "settings" });
  });

  test("the launcher's early phase does not touch ⌘W (no target to act on)", async () => {
    install(null);
    const ev = press("w", { metaKey: true });
    await Promise.resolve();
    expect(ev.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });

  test("after the shell takes over, the early listener stands down", async () => {
    install("settings");
    expect(systemKeysOwnedByShell()).toBe(false);
    handOverSystemKeys();
    expect(systemKeysOwnedByShell()).toBe(true);
    press("w", { metaKey: true });
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  test("AMOS_DESKTOP_SHORTCUTS=disabled releases the chord immediately", async () => {
    (window as unknown as { __amosDisabledFeatures?: string[] }).__amosDisabledFeatures = [
      "shortcuts",
    ];
    install("settings");
    const ev = press("w", { metaKey: true });
    await Promise.resolve();
    expect(ev.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a plain key is never touched", async () => {
    install("settings");
    const ev = press("w");
    await Promise.resolve();
    expect(ev.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });
});
