/**
 * shell-state.svelte.test.ts — Svelte top-level shell navigation state (Phase-3).
 *
 * Pure state-machine transitions: open/goHome/lock/unlock/enterEdit/softLaunch
 * and mutually-exclusive overlay toggles. This is the store a future Shell.svelte
 * consumes (React-free). No rendering — just assert the runes transitions.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  applyLayout,
  canSplit,
  enterEdit,
  enterLibrary,
  enterSplit,
  exitEdit,
  exitSplit,
  goHome,
  layout,
  layoutRefused,
  lock,
  ncOpen,
  open,
  pulseId,
  pulseSeq,
  recentsOpen,
  resetShellState,
  restoreSplit,
  setLayoutSnapshot,
  setNc,
  setRecents,
  setSplitPercent,
  setSpot,
  softLaunch,
  spotOpen,
  surface,
  unlock,
} from "../src/svelte/shellState.svelte";
import { getRecents, readStoreValue, writeStoreValue, LAYOUT_KEY, type HomeLayout } from "../src/lib/amosStore";
import { SPLIT_KEY } from "../src/lib/splitPersist";
import { setStoreTiles } from "../src/lib/storeApps";
import type { LayoutSnapshot } from "../src/lib/wm";

/** A minimal snapshot; `columns` is the only field `enterSplit` gates on. */
function snap(columns: number, form: LayoutSnapshot["form"] = "tablet"): LayoutSnapshot {
  return {
    screen_w: 1024,
    screen_h: 768,
    split: null,
    candidates: [],
    form,
    columns,
    multi_window: false,
    free_resize: false,
    divider_gap: 8,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resetShellState();
  setStoreTiles([]); // the tile cache is module-global — never leak it between cases
});

describe("shellState.svelte (Svelte shell navigation)", () => {
  test("starts on the home surface with overlays closed", () => {
    expect(surface()).toEqual({ kind: "home" });
    expect(ncOpen()).toBe(false);
    expect(recentsOpen()).toBe(false);
    expect(spotOpen()).toBe(false);
  });

  test("open() enters the app surface and clears overlays", async () => {
    setNc(true);
    await open("phone");
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

  test("softLaunch() bumps the launch counter even when the id is unchanged (REQ-A1361)", () => {
    // `pulseId` is the value to highlight; a consumer that must *reveal* the tile keys
    // on this counter instead — a second launch of the same app writes the id it
    // already holds, which notifies nobody (Svelte compares primitives).
    const before = pulseSeq();
    softLaunch("clock");
    expect(pulseSeq()).toBe(before + 1);
    softLaunch("clock");
    expect(pulseId()).toBe("clock");
    expect(pulseSeq()).toBe(before + 2);
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

  test("applyLayout() keeps the memory where it was when the store refuses (REQ-A1378)", () => {
    const before = { page: ["notes"], dock: ["phone"], hidden: [] };
    applyLayout(before);
    expect(layoutRefused()).toBe(false);

    // The home grid is drawn from `_layout`, so adopting a placement the store did not
    // take would show it until the next launch, then silently revert.
    // A throwing `setItem` must not outlive this test even when an assertion fails,
    // or every later write in this file reads a store that refuses.
    const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    let refused: boolean;
    try {
      refused = applyLayout({ page: ["clock"], dock: [], hidden: ["notes"] });
    } finally {
      spy.mockRestore();
    }

    expect(refused!).toBe(false);
    expect(layout()).toEqual(before); // memory did not move
    expect(layoutRefused()).toBe(true); // …and the screen is told
    // The durable key still holds exactly the previous layout — nothing was half-written.
    expect(readStoreValue<HomeLayout>(LAYOUT_KEY, null)).toEqual(before);
  });

  test("a later accepted write clears the refusal flag and lands (REQ-A1378)", () => {
    const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    let refused: boolean;
    try {
      refused = applyLayout({ page: ["clock"], dock: [], hidden: [] });
    } finally {
      spy.mockRestore();
    }
    expect(refused!).toBe(false);
    expect(layoutRefused()).toBe(true);

    const next = { page: ["notes"], dock: ["phone"], hidden: [] };
    expect(applyLayout(next)).toBe(true);
    expect(layout()).toEqual(next);
    expect(layoutRefused()).toBe(false);
  });

  test("enterLibrary() opens the App Library surface and clears overlays + pulse", () => {
    softLaunch("clock");
    setNc(true);
    enterLibrary();
    expect(surface()).toEqual({ kind: "library" });
    expect(pulseId()).toBeNull();
    expect(ncOpen()).toBe(false);
    goHome();
    expect(surface()).toEqual({ kind: "home" });
  });

  test("open() records a recent for built-ins (drives the App Library Frequently Used)", async () => {
    await open("phone");
    expect(getRecents()[0]).toBe("phone");
    await open("phone");
    expect(getRecents()).toEqual(["phone"]); // dedup: revisit doesn't double it
  });
});

describe("softLaunch() lands where the icon can actually be revealed (REQ-A1362)", () => {
  test("an app home draws is soft-launched: stay home, pulse it, bump the counter", () => {
    applyLayout({ page: ["notes"], dock: ["phone"], hidden: [] });
    const before = pulseSeq();
    softLaunch("notes");
    expect(surface()).toEqual({ kind: "home" });
    expect(pulseId()).toBe("notes");
    expect(pulseSeq()).toBe(before + 1);
  });

  test("an app hidden from home is opened instead — there is no icon to pulse", () => {
    // Spotlight searches the whole registry, so it still offers an app the user hid
    // from EditHome. Home draws only `layout.page` + `layout.dock`, so the pulse had
    // no target: the sheet closed, the shell stayed home and the screen did not
    // change. With nothing to reveal, the pick's own request (open this app) is the
    // honest answer — and nothing is pulsed that nobody can see.
    applyLayout({ page: ["notes"], dock: ["phone"], hidden: ["clock"] });
    const before = pulseSeq();
    softLaunch("clock");
    expect(surface()).toEqual({ kind: "app", id: "clock" });
    expect(pulseId()).toBeNull();
    expect(pulseSeq()).toBe(before);
  });

  test("a store tile never placed on a page is opened too", () => {
    // The same "drawn nowhere" fact from the other source: an installed app the user
    // never dragged onto a page is in neither `page` nor `dock`.
    applyLayout({ page: ["notes"], dock: [], hidden: [] });
    softLaunch("store:org.amos.demo");
    expect(surface()).toEqual({ kind: "app", id: "store:org.amos.demo" });
  });

  test("a dock icon still soft-launches (the guard is page ∪ dock, not page alone)", () => {
    // Polarity pin: an app that lives only in the dock IS drawn (the dock bar is always
    // on screen), so it must still pulse rather than be routed to the app surface.
    applyLayout({ page: ["notes"], dock: ["phone"], hidden: [] });
    softLaunch("phone");
    expect(surface()).toEqual({ kind: "home" });
    expect(pulseId()).toBe("phone");
  });
});

describe("shellState split surface (REQ-A512)", () => {
  test("a phone (columns < 2) refuses the split and leaves the surface alone", () => {
    setLayoutSnapshot(snap(1, "phone"));
    expect(canSplit()).toBe(false);
    expect(enterSplit("notes", "photos", "vertical")).toBe(false);
    // No partial state: the gate is checked before any surface write.
    expect(surface()).toEqual({ kind: "home" });
  });

  test("a snapshot-less shell refuses the split (no measurement yet)", () => {
    setLayoutSnapshot(null);
    expect(enterSplit("a", "b", "vertical")).toBe(false);
    expect(surface()).toEqual({ kind: "home" });
  });

  test("a tablet (columns >= 2) enters the split surface with a clamped percent", () => {
    setLayoutSnapshot(snap(2));
    expect(canSplit()).toBe(true);
    expect(enterSplit("notes", "photos", "horizontal")).toBe(true);
    expect(surface()).toEqual({
      kind: "split",
      primary: "notes",
      secondary: "photos",
      axis: "horizontal",
      percent: 50,
    });
    setSplitPercent(0);
    expect(surface()).toEqual({
      kind: "split",
      primary: "notes",
      secondary: "photos",
      axis: "horizontal",
      percent: 1,
    });
    setSplitPercent(100);
    expect(surface()).toEqual({
      kind: "split",
      primary: "notes",
      secondary: "photos",
      axis: "horizontal",
      percent: 99,
    });
    setSplitPercent(Number.NaN);
    expect(surface()).toEqual({
      kind: "split",
      primary: "notes",
      secondary: "photos",
      axis: "horizontal",
      percent: 50,
    });
  });

  test("exitSplit() collapses to the primary app; a stray exit elsewhere is a no-op", () => {
    setLayoutSnapshot(snap(2));
    enterSplit("notes", "photos", "vertical");
    exitSplit();
    expect(surface()).toEqual({ kind: "app", id: "notes" });

    // Back on a non-split surface, exitSplit must not fabricate an app screen.
    goHome();
    exitSplit();
    expect(surface()).toEqual({ kind: "home" });
  });

  test("open() while split retargets the secondary pane, keeping primary + geometry", async () => {
    setLayoutSnapshot(snap(2));
    enterSplit("notes", "photos", "vertical", 40);
    await open("calendar");
    expect(surface()).toEqual({
      kind: "split",
      primary: "notes",
      secondary: "calendar",
      axis: "vertical",
      percent: 40,
    });
  });

  test("open() the app already in the primary pane does not make both panes the same app", async () => {
    // `parseSplit` refuses a same-app pair, so committing one live would produce a split
    // the next launch silently drops. `open` refuses it exactly as `pickSecond` does.
    setLayoutSnapshot(snap(2));
    enterSplit("notes", "photos", "vertical", 40);
    await open("notes");
    expect(surface()).toEqual({
      kind: "split",
      primary: "notes",
      secondary: "photos",
      axis: "vertical",
      percent: 40,
    });
  });

  test("enterSplit() refuses a same-app pair — a split its own decoder would drop", () => {
    setLayoutSnapshot(snap(2));
    expect(enterSplit("notes", "notes", "vertical")).toBe(false);
    expect(surface()).toEqual({ kind: "home" });
  });

  test("setSplitPercent() on a non-split surface is inert", () => {
    goHome();
    setSplitPercent(70);
    expect(surface()).toEqual({ kind: "home" });
  });
});

describe("shellState split persistence across restart (REQ-A512 boundary ③)", () => {
  afterEach(() => vi.useRealTimers());

  const stored = () => readStoreValue<Record<string, unknown> | null>(SPLIT_KEY, null);

  test("enterSplit() persists the intent at once; exitSplit() removes it", () => {
    setLayoutSnapshot(snap(2));
    enterSplit("notes", "photos", "horizontal", 40);
    expect(stored()).toEqual({
      primary: "notes",
      secondary: "photos",
      axis: "horizontal",
      percent: 40,
    });
    exitSplit();
    // Absent, not `null`-valued: the store's own "no split".
    expect(stored()).toBeNull();
  });

  test("a pane swap while split overwrites the stored secondary at once", async () => {
    setLayoutSnapshot(snap(2));
    enterSplit("notes", "photos", "vertical", 45);
    await open("calendar");
    expect(stored()).toEqual({
      primary: "notes",
      secondary: "calendar",
      axis: "vertical",
      percent: 45,
    });
  });

  test("the mid-drag ratio is coalesced, then lands once the drag settles", () => {
    vi.useFakeTimers();
    setLayoutSnapshot(snap(2));
    enterSplit("notes", "photos", "vertical", 50);
    setSplitPercent(60);
    setSplitPercent(70);
    // Nothing written yet — a drag is not sixty writes a second.
    expect(stored()).toEqual({
      primary: "notes",
      secondary: "photos",
      axis: "vertical",
      percent: 50,
    });
    vi.advanceTimersByTime(300);
    expect(stored()).toEqual({
      primary: "notes",
      secondary: "photos",
      axis: "vertical",
      percent: 70,
    });
  });

  test("exitSplit() cancels a pending ratio write, so a closed split cannot return", () => {
    vi.useFakeTimers();
    setLayoutSnapshot(snap(2));
    enterSplit("notes", "photos", "vertical", 50);
    setSplitPercent(80);
    exitSplit();
    vi.advanceTimersByTime(300);
    expect(stored()).toBeNull();
  });

  test("goHome() abandons the split's stored intent (so it cannot resurrect on restart)", () => {
    setLayoutSnapshot(snap(2));
    enterSplit("notes", "photos", "vertical", 50);
    // `enterSplit` writes the intent at once, with no pending ratio write behind it —
    // the case where a surviving key would sit on disk and `restoreSplit` would bring
    // back the split the user just dismissed by going home.
    expect(stored()).toEqual({ primary: "notes", secondary: "photos", axis: "vertical", percent: 50 });
    goHome();
    expect(stored()).toBeNull();
    expect(surface()).toEqual({ kind: "home" });
  });

  test("lock() abandons the split's stored intent (unlock returns home, not the split)", () => {
    setLayoutSnapshot(snap(2));
    enterSplit("notes", "photos", "vertical", 50);
    expect(stored()).not.toBeNull();
    lock();
    expect(stored()).toBeNull();
    expect(surface()).toEqual({ kind: "lock" });
  });

  test("restoreSplit() brings the stored pair back on a measured tablet", () => {
    writeStoreValue(SPLIT_KEY, {
      primary: "notes",
      secondary: "photos",
      axis: "horizontal",
      percent: 35,
    });
    setLayoutSnapshot(snap(2));
    expect(restoreSplit()).toBe(true);
    expect(surface()).toEqual({
      kind: "split",
      primary: "notes",
      secondary: "photos",
      axis: "horizontal",
      percent: 35,
    });
  });

  test("restoreSplit() refuses — honestly — when a pane app is no longer installed", () => {
    writeStoreValue(SPLIT_KEY, { primary: "ghost", secondary: "photos", axis: "auto", percent: 50 });
    setLayoutSnapshot(snap(2));
    expect(restoreSplit()).toBe(false);
    expect(surface()).toEqual({ kind: "home" });
  });

  test("restoreSplit() keeps a pane that is an installed store app, and drops one that is not", () => {
    // A store app renders as a real pane (`AppPane` → `ExtAppHost`), so "still exists"
    // is not "is a built-in": validating against `appIds()` alone read an installed store
    // pane as a ghost and silently dropped the whole split — the tablet case, where a
    // split on a store app never came back after a restart.
    const tile = { id: "store:org.amos.demo", mid: "org.amos.demo", name: "Demo", icon: "D" };
    writeStoreValue(SPLIT_KEY, {
      primary: "notes",
      secondary: "store:org.amos.demo",
      axis: "vertical",
      percent: 40,
    });
    setLayoutSnapshot(snap(2));

    setStoreTiles([tile]); // installed
    expect(restoreSplit()).toBe(true);
    expect(surface()).toEqual({
      kind: "split",
      primary: "notes",
      secondary: "store:org.amos.demo",
      axis: "vertical",
      percent: 40,
    });

    // Uninstalled: the same stored intent must now be refused, exactly as an unknown id
    // is — the tile is gone, so there is no screen to put in that pane. Both the
    // snapshot and the stored key are re-armed after the reset: `resetShellState` clears
    // both, so without these lines the refusal would come from the `canSplit()` gate or
    // from an absent key, and the assertion would pass having never reached the rule
    // under test (measured: with the prune rule disabled this case stayed green).
    resetShellState();
    setLayoutSnapshot(snap(2));
    writeStoreValue(SPLIT_KEY, {
      primary: "notes",
      secondary: "store:org.amos.demo",
      axis: "vertical",
      percent: 40,
    });
    setStoreTiles([]); // the app was uninstalled between runs
    expect(restoreSplit()).toBe(false);
    expect(surface()).toEqual({ kind: "home" });
  });

  test("restoreSplit() refuses a phone (columns < 2) and a desktop class", () => {
    writeStoreValue(SPLIT_KEY, { primary: "notes", secondary: "photos", axis: "auto", percent: 50 });
    setLayoutSnapshot(snap(1, "phone"));
    expect(restoreSplit()).toBe(false);
    // Desktop can have `columns >= 2` yet never shows the in-shell split surface:
    // its apps are real OS windows, so a stored split must not fabricate one here.
    setLayoutSnapshot(snap(2, "desktop"));
    expect(restoreSplit()).toBe(false);
    expect(surface()).toEqual({ kind: "home" });
  });

  test("restoreSplit() refuses once the surface already routed somewhere", () => {
    writeStoreValue(SPLIT_KEY, { primary: "notes", secondary: "photos", axis: "auto", percent: 50 });
    setLayoutSnapshot(snap(2));
    lock();
    expect(restoreSplit()).toBe(false);
    expect(surface()).toEqual({ kind: "lock" });
  });

  test("a malformed stored value is ignored, never half-restored", () => {
    setLayoutSnapshot(snap(2));
    for (const bad of [
      null,
      "notes",
      { primary: "notes" },
      { primary: 7, secondary: "photos" },
      { primary: "notes", secondary: "notes" },
      { primary: "", secondary: "photos" },
    ]) {
      writeStoreValue(SPLIT_KEY, bad);
      expect(restoreSplit()).toBe(false);
      expect(surface()).toEqual({ kind: "home" });
    }
  });

  test("a stored split missing its axis/percent still restores with conservative defaults", () => {
    // Those two are recoverable nuances (unlike an unavailable pane): the axis
    // defers to the host's class rule, the ratio to the fresh-split 50 %.
    writeStoreValue(SPLIT_KEY, { primary: "notes", secondary: "photos" });
    setLayoutSnapshot(snap(2));
    expect(restoreSplit()).toBe(true);
    expect(surface()).toEqual({
      kind: "split",
      primary: "notes",
      secondary: "photos",
      axis: "auto",
      percent: 50,
    });
  });

  test("resetShellState() drops both the pending write and the stored intent", () => {
    vi.useFakeTimers();
    setLayoutSnapshot(snap(2));
    enterSplit("notes", "photos", "vertical", 50);
    setSplitPercent(90);
    resetShellState();
    vi.advanceTimersByTime(300);
    expect(stored()).toBeNull();
    expect(surface()).toEqual({ kind: "home" });
  });
});

