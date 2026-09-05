import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  describeSplit,
  isInSplit,
  isVisibleSurface,
  layoutSurfaces,
  LAYOUT_CHANGED_EVENT,
  normalizeLayout,
  onLayoutChanged,
  paneCss,
  paneFor,
  primaryWindow,
  rectForLabel,
  secondaryWindow,
  splitActive,
  wmLayoutSetScreen,
  wmLayoutSnapshot,
  wmSplit,
  wmSplitResize,
  wmSplitDemo,
  type LayoutSnapshot,
} from "../lib/wm";

type Call = { command: string; args?: Record<string, unknown> };
type Listener = (e: { payload: unknown }) => void;
let realWindow: unknown;
let calls: Call[] = [];
let respond: () => unknown;
let listeners = new Map<string, Listener>();

const splitSnap: LayoutSnapshot = {
  screen_w: 1080,
  screen_h: 1920,
  split: {
    axis: "vertical",
    percent: 40,
    primary: "notes",
    secondary: "maps",
    panes: [
      { label: "notes", x: 0, y: 0, width: 430, height: 1920 },
      { label: "maps", x: 438, y: 0, width: 642, height: 1920 },
    ],
  },
  candidates: ["maps", "notes"],
};

const fullScreenSnap: LayoutSnapshot = {
  screen_w: 1080,
  screen_h: 1920,
  split: null,
  candidates: [],
};

function setWindow(obj: unknown) {
  (globalThis as { window?: unknown }).window = obj;
}

beforeEach(() => {
  realWindow = (globalThis as { window?: unknown }).window;
  calls = [];
  respond = () => splitSnap;
  listeners = new Map();
  setWindow({
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return respond();
      },
      listen: async (channel: string, handler: Listener) => {
        listeners.set(channel, handler);
        return () => {
          listeners.delete(channel);
        };
      },
    },
  });
});

afterEach(() => {
  setWindow(realWindow);
});

describe("wm command wrappers", () => {
  test("wmLayoutSnapshot calls wm_layout_snapshot and returns the payload", async () => {
    const s = await wmLayoutSnapshot();
    expect(s).toEqual(splitSnap);
    expect(calls[0]?.command).toBe("wm_layout_snapshot");
  });

  test("wmSplit passes primary/secondary/axis args", async () => {
    await wmSplit("notes", "maps", "vertical");
    expect(calls[0]).toEqual({
      command: "wm_split",
      args: { primary: "notes", secondary: "maps", axis: "vertical" },
    });
  });

  test("wmSplitResize and wmLayoutSetScreen pass numeric args", async () => {
    await wmSplitResize(40);
    expect(calls[0]).toEqual({ command: "wm_split_resize", args: { percent: 40 } });
    await wmLayoutSetScreen(800, 1000);
    expect(calls[1]).toEqual({
      command: "wm_layout_set_screen",
      args: { width: 800, height: 1000 },
    });
  });

  test("returns null when not running inside Tauri", async () => {
    setWindow(null);
    expect(await wmLayoutSnapshot()).toBeNull();
  });

  test("onLayoutChanged subscribes, normalizes host broadcasts, unsubscribes", async () => {
    const box: { snap: LayoutSnapshot | null } = { snap: null };
    const unlisten = await onLayoutChanged((s) => {
      box.snap = s;
    });
    expect(listeners.has(LAYOUT_CHANGED_EVENT)).toBe(true);

    // A host broadcast (another surface split) arrives and is normalized.
    listeners.get(LAYOUT_CHANGED_EVENT)!({ payload: splitSnap });
    expect(box.snap).toEqual(splitSnap);

    unlisten();
    expect(listeners.has(LAYOUT_CHANGED_EVENT)).toBe(false);
  });

  test("wmSplitDemo calls wm_split_demo; event name matches the host", async () => {
    expect(LAYOUT_CHANGED_EVENT).toBe("layout-changed");
    const snap = await wmSplitDemo();
    expect(calls[0]?.command).toBe("wm_split_demo");
    expect(snap).toEqual(splitSnap);
  });
});

describe("normalizeLayout", () => {
  test("passes a complete payload through", () => {
    expect(normalizeLayout(splitSnap)).toEqual(splitSnap);
  });

  test("tolerates a partial/absent payload (offline)", () => {
    const s = normalizeLayout(null);
    expect(s.screen_w).toBe(0);
    expect(s.screen_h).toBe(0);
    expect(s.split).toBeNull();
    expect(s.candidates).toEqual([]);
  });

  test("coerces out-of-range numbers without throwing", () => {
    const s = normalizeLayout({ screen_w: NaN, screen_h: "x", split: { percent: -5 } });
    expect(s.screen_w).toBe(0);
    expect(s.split?.percent).toBe(50);
  });
});

describe("pure split helpers (render the split)", () => {
  test("splitActive and isInSplit reflect the snapshot", () => {
    expect(splitActive(splitSnap)).toBe(true);
    expect(splitActive(fullScreenSnap)).toBe(false);
    expect(isInSplit(splitSnap, "notes")).toBe(true);
    expect(isInSplit(splitSnap, "photos")).toBe(false);
  });

  test("primary/secondary window hints follow the snapshot (swap-aware)", () => {
    expect(primaryWindow(splitSnap)).toBe("notes");
    expect(secondaryWindow(splitSnap)).toBe("maps");
    // A snapshot that already had primary/secondary swapped reflects it directly.
    const swapped: LayoutSnapshot = {
      ...splitSnap,
      split: { ...splitSnap.split!, primary: "maps", secondary: "notes" },
    };
    expect(primaryWindow(swapped)).toBe("maps");
    expect(secondaryWindow(swapped)).toBe("notes");
    expect(primaryWindow(fullScreenSnap)).toBeNull();
    expect(secondaryWindow(fullScreenSnap)).toBeNull();
  });

  test("paneFor / rectForLabel map a label to its pane rect", () => {
    expect(paneFor(splitSnap, "maps")).toEqual({
      label: "maps",
      x: 438,
      y: 0,
      width: 642,
      height: 1920,
    });
    expect(rectForLabel(fullScreenSnap, "notes")).toEqual({
      label: "notes",
      x: 0,
      y: 0,
      width: 1080,
      height: 1920,
    });
    expect(paneCss(paneFor(splitSnap, "notes")!)).toEqual({
      left: 0,
      top: 0,
      width: 430,
      height: 1920,
    });
  });

  test("a window not in the split is hidden, not fullscreen", () => {
    // Split active: only the two split windows are visible.
    expect(rectForLabel(splitSnap, "photos")).toBeNull();
    expect(isVisibleSurface(splitSnap, "notes")).toBe(true);
    expect(isVisibleSurface(splitSnap, "photos")).toBe(false);
    // Fullscreen (no split): every surface shows whole.
    expect(isVisibleSurface(fullScreenSnap, "notes")).toBe(true);
    expect(rectForLabel(fullScreenSnap, "photos")).not.toBeNull();
  });

  test("layoutSurfaces orders split panes and drops hidden windows", () => {
    const laid = layoutSurfaces(splitSnap, ["photos", "notes", "maps"]);
    expect(laid.map((p) => p.label)).toEqual(["notes", "maps"]);
    const [primary, secondary] = laid;
    // primary = notes in the left pane (x=0, 430 wide); secondary = maps at x=438.
    expect(primary!.rect.x).toBe(0);
    expect(primary!.rect.width).toBe(430);
    expect(secondary!.rect.x).toBe(438);
    expect(secondary!.rect.width).toBe(642);

    // Fullscreen: the supplied surface shows whole.
    const [fsFirst] = layoutSurfaces(fullScreenSnap, ["photos"]);
    expect(fsFirst?.label).toBe("photos");
    expect(fsFirst?.rect.width).toBe(1080);
  });

  test("describeSplit reads axis/percent/primary", () => {
    expect(describeSplit(splitSnap.split)).toContain("notes ⇆ maps");
    expect(describeSplit(splitSnap.split)).toContain("vertical @ 40%");
    expect(describeSplit(null)).toBe("fullscreen");
  });
});
