import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  describeSplit,
  isInSplit,
  isVisibleSurface,
  layoutSurfaces,
  LAYOUT_CHANGED_EVENT,
  normalizeLayout,
  normalizeWindows,
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
import { clearDiag, recentDiag } from "../lib/debugLog";

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
  form: "desktop",
  columns: 3,
  multi_window: true,
  free_resize: true,
  divider_gap: 8,
};

const fullScreenSnap: LayoutSnapshot = {
  screen_w: 1080,
  screen_h: 1920,
  split: null,
  candidates: [],
  form: "phone",
  columns: 1,
  multi_window: false,
  free_resize: false,
  divider_gap: 8,
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

  test("a command that fails resolves to null and reaches the diagnostics ledger", async () => {
    // REQ-A220: the bridge used to await `__TAURI_INTERNALS__.invoke` itself, so a
    // Rust `Err` **rejected** the promise — an unhandled rejection in every
    // consumer that did not hand-roll a `.catch`, and a failure the UI's ledger
    // never saw. It now delegates to `lib/backend.ts`'s `invoke`.
    clearDiag();
    setWindow({
      __TAURI_INTERNALS__: {
        invoke: async () => {
          throw new Error("split geometry is not available");
        },
        listen: async () => () => {},
      },
    });
    await expect(wmLayoutSnapshot()).resolves.toBeNull();
    const logged = recentDiag(20).find((e) => `${e.msg}`.includes("wm_layout_snapshot"));
    expect(logged, "the failure is retrievable, not swallowed").toBeTruthy();
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

  test("subscribes through the event plugin when the host injects no listen helper", async () => {
    // Tauri v2's `__TAURI_INTERNALS__` has no `listen`; a local `b.listen` call
    // used to be a silent no-op, so layout changes never reached the UI.
    const box: { snap: LayoutSnapshot | null } = { snap: null };
    const calls: string[] = [];
    const callbacks = new Map<number, (payload: unknown) => void>();
    let nextId = 1;
    setWindow({
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string) => {
          calls.push(cmd);
          return cmd === "plugin:event|listen" ? 7 : null;
        },
        transformCallback: (cb: (payload: unknown) => void) => {
          const id = nextId++;
          callbacks.set(id, cb);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
      },
    });
    const un = await onLayoutChanged((s) => {
      box.snap = s;
    });
    expect(calls).toContain("plugin:event|listen");
    // Dispatch through the registered transformCallback id.
    callbacks.forEach((cb) => cb({ event: LAYOUT_CHANGED_EVENT, id: 7, payload: splitSnap }));
    expect(box.snap).toEqual(splitSnap);
    un();
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

  test("the mirrored key set is exactly the Rust wire shape", () => {
    // Pinned on the Rust side by `the_layout_snapshot_wire_shape_is_pinned`
    // (crates/amos-tauri/src/wm.rs): a renamed Rust field must fail there, and a
    // field forgotten here must fail here. Both lists are the contract documented
    // in docs/multi-window.md §1.5 — `tauri-reply-scan.mjs` cannot see this pair
    // (the wrapper passes a *variable* command to `invoke`), so these two tests are
    // what keeps the mirror honest.
    expect(Object.keys(normalizeLayout({})).sort()).toEqual([
      "candidates",
      "columns",
      "divider_gap",
      "form",
      "free_resize",
      "multi_window",
      "screen_h",
      "screen_w",
      "split",
    ]);
  });

  test("an unreadable snapshot degrades to the most restrictive class", () => {
    // A capability must never be *gained* from a malformed payload: an absent or
    // bogus class/column count reads as phone / one column / no extra windows.
    const s = normalizeLayout({
      form: "wat",
      columns: 99,
      multi_window: "yes",
      free_resize: 1,
      divider_gap: -3,
    });
    expect(s.form).toBe("phone");
    expect(s.columns).toBe(1);
    expect(s.multi_window).toBe(false);
    expect(s.free_resize).toBe(false);
    expect(s.divider_gap).toBe(8);
  });

  test("carries a well-formed class and its capabilities through", () => {
    const s = normalizeLayout({
      form: "tablet",
      columns: 2,
      multi_window: true,
      free_resize: false,
      divider_gap: 12,
    });
    expect(s.form).toBe("tablet");
    expect(s.columns).toBe(2);
    expect(s.multi_window).toBe(true);
    expect(s.free_resize).toBe(false);
    expect(s.divider_gap).toBe(12);
    // Every class the host can send is accepted verbatim.
    for (const form of ["phone", "tablet", "desktop", "robot"] as const) {
      expect(normalizeLayout({ form }).form).toBe(form);
    }
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

describe("normalizeWindows (the wm_windows payload)", () => {
  test("keeps the host's own words verbatim", () => {
    const view = normalizeWindows({
      focused: 7,
      windows: [
        { id: 7, label: "main", kind: "Launcher", state: "Shown", focused: false, external: false },
        {
          id: 9,
          label: "legacy:waydroid_0",
          kind: "System",
          state: "Focused",
          focused: true,
          external: true,
        },
      ],
    });
    expect(view.focused).toBe(7);
    expect(view.windows.map((w) => w.label)).toEqual(["main", "legacy:waydroid_0"]);
    expect(view.windows[1]).toEqual({
      id: 9,
      label: "legacy:waydroid_0",
      kind: "System",
      state: "Focused",
      focused: true,
      external: true,
    });
  });

  test("drops a window without a usable label instead of inventing one", () => {
    // An unnamed record cannot be addressed by any command, so showing it would
    // only advertise something the shell can never act on.
    const view = normalizeWindows({
      windows: [{ label: "" }, { label: 42 }, null, {}, { label: "notes" }],
    });
    expect(view.windows.map((w) => w.label)).toEqual(["notes"]);
  });

  test("a malformed payload degrades to the conservative view, never a throw", () => {
    for (const raw of [null, undefined, 7, "windows", [], { windows: "nope" }, { windows: {} }]) {
      const view = normalizeWindows(raw);
      expect(view.focused, `${JSON.stringify(raw)} has no focused window`).toBeNull();
      expect(view.windows, `${JSON.stringify(raw)} has no windows`).toEqual([]);
    }
    // Present-but-garbage fields fall back per field (kind/state/focused/external).
    expect(
      normalizeWindows({ focused: Number.NaN, windows: [{ label: "app-1", kind: "", focused: 1 }] }),
    ).toEqual({
      focused: null,
      windows: [
        { id: 0, label: "app-1", kind: "Unknown", state: "", focused: false, external: false },
      ],
    });
  });
});
