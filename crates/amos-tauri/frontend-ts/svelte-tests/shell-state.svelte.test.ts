/**
 * shell-state.svelte.test.ts — Svelte top-level shell navigation state (Phase-3).
 *
 * Pure state-machine transitions: open/goHome/lock/unlock/enterEdit/softLaunch
 * and mutually-exclusive overlay toggles. This is the store a future Shell.svelte
 * consumes (React-free). No rendering — just assert the runes transitions.
 */
import { beforeEach, describe, expect, test } from "vitest";
import {
  applyLayout,
  enterEdit,
  exitEdit,
  goHome,
  layout,
  lock,
  ncOpen,
  open,
  pulseId,
  recentsOpen,
  resetShellState,
  setNc,
  setRecents,
  setSpot,
  softLaunch,
  spotOpen,
  surface,
  unlock,
} from "../src/svelte/shellState.svelte";

beforeEach(() => {
  window.localStorage.clear();
  resetShellState();
});

describe("shellState.svelte (Svelte shell navigation)", () => {
  test("starts on the home surface with overlays closed", () => {
    expect(surface()).toEqual({ kind: "home" });
    expect(ncOpen()).toBe(false);
    expect(recentsOpen()).toBe(false);
    expect(spotOpen()).toBe(false);
  });

  test("open() enters the app surface and clears overlays", () => {
    setNc(true);
    open("phone");
    expect(surface()).toEqual({ kind: "app", id: "phone" });
    expect(ncOpen()).toBe(false);
  });

  test("goHome() returns home and clears pulse", () => {
    softLaunch("clock");
    expect(surface()).toEqual({ kind: "home" });
    expect(pulseId()).toBe("clock");
    goHome();
    expect(pulseId()).toBeNull();
    expect(surface()).toEqual({ kind: "home" });
  });

  test("lock/unlock/enterEdit/exitEdit transition the surface", () => {
    lock();
    expect(surface()).toEqual({ kind: "lock" });
    unlock();
    expect(surface()).toEqual({ kind: "home" });
    enterEdit();
    expect(surface()).toEqual({ kind: "edit" });
    exitEdit();
    expect(surface()).toEqual({ kind: "home" });
  });

  test("overlay toggles are mutually exclusive", () => {
    setSpot(true);
    expect(spotOpen()).toBe(true);
    expect(recentsOpen()).toBe(false);
    expect(ncOpen()).toBe(false);
    setRecents(true);
    expect(recentsOpen()).toBe(true);
    expect(spotOpen()).toBe(false);
    expect(ncOpen()).toBe(false);
  });

  test("applyLayout() updates and persists the shared home layout", () => {
    const next = { page: ["notes"], dock: ["phone"], hidden: [] };
    applyLayout(next);
    expect(layout()).toEqual(next);
  });
});

