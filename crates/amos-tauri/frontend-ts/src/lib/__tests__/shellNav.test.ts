/**
 * shellNav.test.ts — the "who may navigate a window" rule (REQ-A429).
 *
 * Why it is a rule and not an `if` inside each watcher: `Shell.svelte` mounts the shell's
 * navigation watchers (wake-home, idle auto-off, hardware nav) in **every** window, which is
 * correct on a phone (one window, surfaces are its modes) and wrong on a desktop app window
 * (REQ-A416: that window *is* one app). Measured live: a focus change sent the Settings
 * window home, rendering the desktop shell inside an app window.
 */
import { describe, expect, test } from "bun:test";
import { windowOwnsShellNav } from "../shellNav";

describe("windowOwnsShellNav", () => {
  test("a desktop app window does not own shell navigation", () => {
    expect(windowOwnsShellNav("desktop", true)).toBe(false);
  });

  test("the desktop shell window itself does", () => {
    // Launcher / lock / library / spotlight surfaces are the shell, so a wake still moves them.
    expect(windowOwnsShellNav("desktop", false)).toBe(true);
  });

  test("a touch class keeps navigating its single window (surfaces are its modes)", () => {
    for (const form of ["phone", "tablet", "robot"] as const) {
      expect(windowOwnsShellNav(form, true)).toBe(true);
      expect(windowOwnsShellNav(form, false)).toBe(true);
    }
  });

  test("an unknown class behaves like touch (the conservative default)", () => {
    // The host's snapshot arrives a beat after mount; answering "desktop" before it lands
    // would silently disable wake-home on a phone.
    expect(windowOwnsShellNav(null, true)).toBe(true);
    expect(windowOwnsShellNav(undefined, true)).toBe(true);
  });
});
