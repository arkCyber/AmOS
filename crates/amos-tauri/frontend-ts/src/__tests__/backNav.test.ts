/**
 * backNav.test.ts — the pure half of the system-back contract (REQ-A321).
 *
 * The phone form factor's host turns the platform back gesture into
 * `if (canGoBack()) goBack() else exit()`, so the shell must (a) push exactly one history
 * entry per level it descends, and (b) say what a back press means at each position. Both
 * decisions are pure and are pinned exhaustively here; the DOM test in
 * `svelte-tests/shell.svelte.test.ts` proves the wiring.
 */
import { describe, expect, test } from "bun:test";
import {
  backActionAt,
  levelOf,
  pushDecision,
  rewindCount,
  topOverlay,
  type BackOverlays,
  type BackPosition,
  type BackSurface,
} from "../lib/backNav";

const none: BackOverlays = { nc: false, recents: false, spot: false };
const pos = (surface: BackSurface, overlays: Partial<BackOverlays> = {}): BackPosition => ({
  surface,
  overlays: { ...none, ...overlays },
});

describe("backNav — where the shell is (levelOf)", () => {
  test("home and lock are the root: nothing inside the shell to go back to", () => {
    expect(levelOf(pos("home"))).toBe(0);
    expect(levelOf(pos("lock"))).toBe(0);
  });

  test("an app, the App Library and edit mode are one level in", () => {
    expect(levelOf(pos("app"))).toBe(1);
    expect(levelOf(pos("library"))).toBe(1);
    expect(levelOf(pos("edit"))).toBe(1);
  });

  test("an overlay adds exactly one level — above home *and* above an app", () => {
    expect(levelOf(pos("home", { nc: true }))).toBe(1);
    expect(levelOf(pos("app", { spot: true }))).toBe(2);
    expect(levelOf(pos("edit", { recents: true }))).toBe(2);
  });
});

describe("backNav — what a back press does (backActionAt)", () => {
  test("an overlay is closed first, whatever is underneath", () => {
    expect(backActionAt(pos("home", { nc: true }))).toBe("close-overlay");
    expect(backActionAt(pos("app", { spot: true }))).toBe("close-overlay");
  });

  test("then the app / library / edit surface returns home", () => {
    expect(backActionAt(pos("app"))).toBe("home");
    expect(backActionAt(pos("library"))).toBe("home");
    expect(backActionAt(pos("edit"))).toBe("home");
  });

  test("at the root the shell does nothing — the platform's own exit behaviour stands", () => {
    // Swallowing this would make back appear broken at home; the host's `canGoBack()`
    // is false there precisely so the app can be left.
    expect(backActionAt(pos("home"))).toBe("none");
    expect(backActionAt(pos("lock"))).toBe("none");
  });

  test("two back presses from an overlay over an app take exactly two levels", () => {
    const start = pos("app", { recents: true });
    // 1st: overlay closes (still in the app) …
    expect(backActionAt(start)).toBe("close-overlay");
    // … 2nd: the app returns home, and then there is nothing left inside the shell.
    expect(backActionAt(pos("app"))).toBe("home");
    expect(backActionAt(pos("home"))).toBe("none");
  });
});

describe("backNav — history entries (pushDecision / rewindCount)", () => {
  test("going deeper pushes exactly one entry per level", () => {
    expect(pushDecision(pos("home"), pos("app"))).toBe("push");
    expect(pushDecision(pos("home"), pos("library"))).toBe("push");
    expect(pushDecision(pos("app"), pos("app", { spot: true }))).toBe("push");
  });

  test("a shallower move is a pop, never a push (the entry already exists)", () => {
    expect(pushDecision(pos("app"), pos("home"))).toBe("none");
    expect(pushDecision(pos("app", { nc: true }), pos("app"))).toBe("none");
  });

  test("a sideways move at the same level needs nothing", () => {
    expect(pushDecision(pos("app"), pos("library"))).toBe("none");
    expect(pushDecision(pos("library"), pos("edit"))).toBe("none");
  });

  test("rewindCount is what the shell has to pop when *it* navigates back", () => {
    expect(rewindCount(pos("app", { nc: true }), pos("home"))).toBe(2);
    expect(rewindCount(pos("app"), pos("home"))).toBe(1);
    expect(rewindCount(pos("home"), pos("app"))).toBe(0); // never negative
  });

  test("topOverlay follows the paint order for a state that should not exist", () => {
    expect(topOverlay(none)).toBeNull();
    expect(topOverlay({ nc: true, recents: false, spot: false })).toBe("nc");
    expect(topOverlay({ nc: true, recents: true, spot: true })).toBe("nc");
    expect(topOverlay({ nc: false, recents: false, spot: true })).toBe("spot");
    expect(topOverlay({ nc: false, recents: true, spot: false })).toBe("recents");
  });
});
