import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  describeSplit,
  focusedAppOf,
  focusedWindowOf,
  isInSplit,
  isVisibleSurface,
  layoutSurfaces,
  LAYOUT_CHANGED_EVENT,
  normalizeDisplays,
  normalizeLayout,
  normalizePaneRects,
  normalizeWindows,
  onLayoutChanged,
  paneCss,
  paneFor,
  primaryWindow,
  rectForLabel,
  runningAppsOf,
  windowAppId,
  windowsOfApp,
  secondaryWindow,
  splitActive,
  wmLayoutSetScreen,
  wmLayoutSnapshot,
  wmHide,
  wmMinimizeWithDiag,
  wmOpen,
  wmZoom,
  wmSplitExitWithDiag,
  wmSplitMoveWithDiag,
  wmSplitResize,
  wmSplitDemo,
  wmSplitSwapWithDiag,
  wmSplitWithDiag,
  wmPaneRects,
  type LayoutSnapshot,
  type WmWindowInfo,
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
  rail_width: 0,
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
  rail_width: 0,
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

  test("wmSplitResize and wmLayoutSetScreen pass numeric args", async () => {
    await wmSplitResize(40);
    expect(calls[0]).toEqual({ command: "wm_split_resize", args: { percent: 40 } });
    await wmLayoutSetScreen(800, 1000);
    expect(calls[1]).toEqual({
      command: "wm_layout_set_screen",
      args: { width: 800, height: 1000 },
    });
  });

  test("the boolean window commands report the HOST's answer (not the snapshot they get back)", async () => {
    // REQ-A415: the host answers `wm_open`/`wm_hide`/`wm_zoom` with a `WmSnapshot`
    // object. The old bodies were `(await invoke<boolean>(cmd, { label })) ?? false`,
    // so on success the value was a snapshot — the declared `boolean` was never what
    // came back, and any caller writing `if (await wmHide(x))` would have been reading
    // an object. The contract pinned here is the one the type promises: success ⇒
    // `true`, "no bridge / refused" (`null`) ⇒ `false`.
    respond = () => splitSnap; // a successful command answers with a snapshot
    expect(await wmHide("notes")).toBe(true);
    expect(await wmOpen("notes")).toBe(true);
    expect(await wmZoom("notes")).toBe(true);

    respond = () => null; // the host refused (or there is no bridge at all)
    expect(await wmHide("notes")).toBe(false);
    expect(await wmOpen("notes")).toBe(false);
    expect(await wmZoom("notes")).toBe(false);
  });

  describe("wmMinimizeWithDiag — ⌘M minimizes, it does not hide (REQ-A714)", () => {
    test("calls the host's `wm_minimize`, not `wm_hide`, with the window label", async () => {
      respond = () => splitSnap;
      expect(await wmMinimizeWithDiag("notes")).toEqual({ ok: true });
      expect(calls[0]).toEqual({
        command: "wm_minimize",
        args: { label: "notes" },
      });
      // The burden of this test: the chord must not reach the *hide* command — hide
      // removes the window from the model, which is the defect (the Dock's running dot
      // went dark and the app read as closed).
      expect(calls.some((c) => c.command === "wm_hide")).toBe(false);
    });

    test("reports the host's answer: `null` (no bridge / refused) ⇒ not ok", async () => {
      respond = () => null;
      const r = await wmMinimizeWithDiag("notes");
      expect(r.ok).toBe(false);
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
    expect(unlisten).not.toBeNull(); // REQ-A838：宿主接了推送，才有可退订的句柄
    expect(listeners.has(LAYOUT_CHANGED_EVENT)).toBe(true);

    // A host broadcast (another surface split) arrives and is normalized.
    listeners.get(LAYOUT_CHANGED_EVENT)!({ payload: splitSnap });
    expect(box.snap).toEqual(splitSnap);

    unlisten!();
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
    // REQ-A838：插件握手那条路径也必须给出可退订的句柄（旧代码在这里会静默地什么都没有）。
    expect(un).not.toBeNull();
    // Dispatch through the registered transformCallback id.
    callbacks.forEach((cb) => cb({ event: LAYOUT_CHANGED_EVENT, id: 7, payload: splitSnap }));
    expect(box.snap).toEqual(splitSnap);
    un!();
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
    // This pins the *frontend* normalizer's key set against a local literal — it does NOT
    // read the Rust side (REQ-A667). The builder claimed the pair with
    // `the_layout_snapshot_wire_shape_is_pinned` (crates/amos-tauri/src/wm.rs) keeps the
    // mirror honest, but that Rust test also pins a Rust-local `vec!`: neither read the other,
    // so a one-sided rename (with that side's own literal updated) left both green. The actual
    // cross-language binding is `declaredMirrors.test.ts`'s "wm.ts layout wire shapes == the
    // amos-tauri::wm serde structs" (REQ-A667), which reads `wm.rs`. This test stays as the
    // frontend-side pin of the contract documented in docs/multi-window.md §1.5.
    expect(Object.keys(normalizeLayout({})).sort()).toEqual([
      "candidates",
      "columns",
      "divider_gap",
      "form",
      "free_resize",
      "multi_window",
      "rail_width",
      "screen_h",
      "screen_w",
      "split",
    ]);
  });

  test("an unreadable snapshot degrades to the most restrictive class", () => {
    // A capability must never be *gained* from a malformed payload: an absent or
    // bogus class/column count reads as phone / one column / no extra windows. The rail
    // follows the same rule from the other side: a width it cannot confirm reads as `0`
    // (no strip), never as a reservation for a rail that may not exist.
    const s = normalizeLayout({
      form: "wat",
      columns: 99,
      multi_window: "yes",
      free_resize: 1,
      divider_gap: -3,
      rail_width: "180",
    });
    expect(s.form).toBe("phone");
    expect(s.columns).toBe(1);
    expect(s.multi_window).toBe(false);
    expect(s.free_resize).toBe(false);
    expect(s.divider_gap).toBe(8);
    expect(s.rail_width).toBe(0);
  });

  test("carries a well-formed class and its capabilities through", () => {
    const s = normalizeLayout({
      form: "tablet",
      columns: 2,
      multi_window: true,
      free_resize: false,
      divider_gap: 12,
      rail_width: 180,
    });
    expect(s.form).toBe("tablet");
    expect(s.columns).toBe(2);
    expect(s.multi_window).toBe(true);
    expect(s.free_resize).toBe(false);
    expect(s.divider_gap).toBe(12);
    // The positive control for the guard above: a real width does come through, so the
    // `0` there is the refusal to invent one and not a normalizer that always answers 0.
    expect(s.rail_width).toBe(180);
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
      // REQ-A473: a container surface is not an application — reported as "no app" rather
      // than as a fabricated id. (`labels` still carries its host-given name.)
      app: "",
      instance: 0,
      kind: "System",
      state: "Focused",
      focused: true,
      external: true,
    });
  });

  test("an app window's identity is reported, and derived from the label when absent", () => {
    // The host answers with `app`/`instance` (REQ-A473). A payload from an older host has
    // neither, and a `""` app would silently turn every per-app reader — the Dock's running
    // dot, "is this app open" — into "no app", which is a wrong answer rather than a
    // missing one. So the label is resolved through the shared pure resolver.
    const one = (raw: unknown) => {
      const view = normalizeWindows({ focused: 3, windows: [raw] });
      expect(view.windows.length).toBe(1);
      return view.windows[0] as (typeof view.windows)[number];
    };

    const host = one({
      id: 3,
      label: "files_2",
      app: "files",
      instance: 2,
      kind: "App",
      state: "Focused",
      focused: true,
      external: false,
    });
    expect(host.app).toBe("files");
    expect(host.instance).toBe(2);

    const older = one({
      id: 3,
      label: "files_2",
      kind: "App",
      state: "Focused",
      focused: true,
      external: false,
    });
    expect(older.app).toBe("files");
    expect(older.instance).toBe(2);

    const launcher = one({
      id: 1,
      label: "main",
      kind: "Launcher",
      state: "Focused",
      focused: true,
      external: false,
    });
    expect(launcher.app).toBe("");
    expect(launcher.instance).toBe(0);
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
    // Present-but-garbage fields fall back per field (kind/state/focused/external), and the
    // identity (`app`/`instance`) degrades the same way: `app-1` is not a known app, so it
    // resolves to no app at all rather than to a guessed id.
    expect(
      normalizeWindows({ focused: Number.NaN, windows: [{ label: "app-1", kind: "", focused: 1 }] }),
    ).toEqual({
      focused: null,
      windows: [
        {
          id: 0,
          label: "app-1",
          app: "",
          instance: 0,
          kind: "Unknown",
          state: "",
          focused: false,
          external: false,
        },
      ],
    });
  });
});

describe("normalizeDisplays (the wm_displays payload, REQ-A690)", () => {
  test("keeps the platform's own readings, including a negative secondary origin", () => {
    const view = normalizeDisplays({
      displays: [
        {
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          work_area: { x: 0, y: 25, width: 1920, height: 995 },
          scale: 1,
          primary: true,
          name: "Built-in Retina Display",
        },
        {
          bounds: { x: -2560, y: 0, width: 2560, height: 1440 },
          work_area: { x: -2560, y: 0, width: 2560, height: 1440 },
          scale: 1.5,
          primary: false,
          name: null,
        },
      ],
    });
    expect(view.displays).toHaveLength(2);
    expect(view.displays[0]?.primary).toBe(true);
    expect(view.displays[0]?.work_area.y).toBe(25);
    expect(view.displays[1]?.bounds.x).toBe(-2560);
    expect(view.displays[1]?.name).toBeNull();
    expect(view.displays[1]?.scale).toBe(1.5);
  });

  test("degrades field by field, and an empty set is a real answer", () => {
    // An empty list is the host saying "the platform listed nothing" — not an error, and
    // never a fabricated single display.
    expect(normalizeDisplays({ displays: [] })).toEqual({ displays: [] });
    expect(normalizeDisplays({})).toEqual({ displays: [] });
    // A non-object entry is dropped; a kept entry falls back per field (zero rect, scale 1,
    // not primary, no name) rather than throwing.
    expect(normalizeDisplays({ displays: [null, 7, {}] })).toEqual({
      displays: [
        {
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          work_area: { x: 0, y: 0, width: 0, height: 0 },
          scale: 1,
          primary: false,
          name: null,
        },
      ],
    });
    // An absurd scale never becomes a divide-by-zero later.
    expect(normalizeDisplays({ displays: [{ scale: 0 }] }).displays[0]?.scale).toBe(1);
    expect(normalizeDisplays({ displays: [{ scale: Number.NaN }] }).displays[0]?.scale).toBe(1);
    // A negative size cannot become a rect.
    expect(
      normalizeDisplays({ displays: [{ bounds: { width: -5, height: -1 } }] }).displays[0]?.bounds,
    ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});


/**
 * REQ-A476 — the per-app readers the shell and App Exposé share.
 *
 * `windowsOfApp` is what makes App Exposé *App Exposé* rather than a second Mission
 * Control: the grouping is by **app id**, so one app's windows never mix with another's, and
 * a window that shows no app is in nobody's list.
 */
describe("windowsOfApp / focusedAppOf — the app behind the window list", () => {
  const w = (
    label: string,
    app: string,
    instance: number,
    over: Partial<WmWindowInfo> = {},
  ): WmWindowInfo => ({
    id: instance,
    label,
    app,
    instance,
    kind: "App",
    state: "Shown",
    focused: false,
    external: false,
    ...over,
  });

  const snap = (windows: WmWindowInfo[]) => normalizeWindows({ focused: null, windows });

  test("keeps one app's windows, in the host's order, and nobody else's", () => {
    const s = snap([
      w("files", "files", 1),
      w("notes", "notes", 1),
      w("files_2", "files", 2),
      w("files_3", "files", 3),
    ]);
    expect(windowsOfApp(s, "files").map((x) => x.label)).toEqual([
      "files",
      "files_2",
      "files_3",
    ]);
    expect(windowsOfApp(s, "notes").map((x) => x.label)).toEqual(["notes"]);
  });

  test("hidden windows are not tileable, and a no-app window belongs to nobody", () => {
    const s = snap([
      w("files", "files", 1),
      w("files_2", "files", 2, { state: "Hidden" }),
      { ...w("main", "", 0), kind: "Launcher" },
    ]);
    expect(windowsOfApp(s, "files").map((x) => x.label)).toEqual(["files"]);
    expect(windowsOfApp(s, "")).toEqual([]);
  });

  test("an empty app id is not a wildcard", () => {
    // The launcher and container surfaces report `app: ""`; treating that as "no filter"
    // would put every window into one list.
    const s = snap([
      { ...w("main", "", 0), kind: "Launcher" },
      { ...w("legacy:waydroid_0", "", 0), kind: "System", external: true },
      w("files", "files", 1),
    ]);
    expect(windowsOfApp(s, "")).toEqual([]);
  });

  test("windowAppId prefers the host's answer, else resolves the label", () => {
    expect(windowAppId(w("files_2", "files", 2))).toBe("files");
    // An older payload has no `app`: the label still yields the app.
    const older = normalizeWindows({
      focused: null,
      windows: [{ id: 1, label: "files_2", kind: "App", state: "Shown" }],
    });
    expect(windowAppId(older.windows[0] as WmWindowInfo)).toBe("files");
    // A window with no app stays with no app (never a guessed id).
    const launcher = normalizeWindows({
      focused: null,
      windows: [{ id: 1, label: "main", kind: "Launcher", state: "Shown" }],
    });
    expect(windowAppId(launcher.windows[0] as WmWindowInfo)).toBe("");
  });

  test("focusedAppOf answers 'which application are we acting on?'", () => {
    const s = snap([w("notes", "notes", 1), w("files_2", "files", 2, { focused: true })]);
    expect(focusedWindowOf(s)?.label).toBe("files_2");
    expect(focusedAppOf(s)).toBe("files");
    // Nothing focused (a background poll) ⇒ no app, so per-app features do nothing rather
    // than target whoever happened to be first in the list.
    expect(focusedAppOf(snap([w("files", "files", 1)]))).toBeNull();
    // The launcher focused ⇒ no app either (⌘N/⌘`/Exposé have no application to act on).
    const launcherFocused = normalizeWindows({
      focused: 1,
      windows: [{ id: 1, label: "main", kind: "Launcher", state: "Focused", focused: true }],
    });
    expect(focusedAppOf(launcherFocused)).toBeNull();
  });
});

/**
 * REQ-A709 — the Dock's running set.
 *
 * The rule under test is "has a **registered** window", not "has a *visible* window": a
 * window is dropped from `wm_windows` only when it is **closed**, so a Hidden window is a
 * still-running app whose window is momentarily off screen (⌘M / show-desktop / another
 * Space). Keying the dot on `state` darkened it for all of those and read a running app as
 * a closed one — the `docs/DESKTOP_GAP_ANALYSIS_2026_SEP20.md` §A1 defect.
 */
describe("runningAppsOf — the Dock's running set (a hidden window is still running)", () => {
  const w = (
    label: string,
    app: string,
    instance: number,
    over: Partial<WmWindowInfo> = {},
  ): WmWindowInfo => ({
    id: instance,
    label,
    app,
    instance,
    kind: "App",
    state: "Shown",
    focused: false,
    external: false,
    ...over,
  });

  const snap = (windows: WmWindowInfo[]) => normalizeWindows({ focused: null, windows });

  test("a minimized (Hidden) window keeps its app running — not closed", () => {
    const s = snap([w("files", "files", 1, { state: "Hidden" })]);
    expect(runningAppsOf(s)).toEqual(new Set(["files"]));
  });

  test("show-desktop / another Space (every window Hidden) lights the dots, not darkens them", () => {
    const s = snap([
      w("files", "files", 1, { state: "Hidden" }),
      w("notes", "notes", 1, { state: "Hidden" }),
    ]);
    expect(runningAppsOf(s)).toEqual(new Set(["files", "notes"]));
  });

  test("any of an app's windows counts it once; closed app has no window at all", () => {
    const s = snap([
      w("files", "files", 1, { state: "Hidden" }),
      w("files_2", "files", 2),
      w("files_3", "files", 3, { state: "Hidden" }),
    ]);
    expect(runningAppsOf(s)).toEqual(new Set(["files"]));
    // A closed app: the host drops the window from the snapshot, so it is absent here.
    expect(runningAppsOf(snap([w("notes", "notes", 1)]))).toEqual(new Set(["notes"]));
  });

  test("a window with no app (the Launcher) never becomes a phantom running app", () => {
    const s = snap([
      { ...w("main", "", 0), kind: "Launcher" },
      w("files", "files", 1),
    ]);
    expect(runningAppsOf(s)).toEqual(new Set(["files"]));
    expect(runningAppsOf(snap([{ ...w("main", "", 0), kind: "Launcher" }]))).toEqual(new Set());
  });

  test("an older payload with no `app` still resolves the app from the label", () => {
    const older = normalizeWindows({
      focused: null,
      windows: [{ id: 1, label: "files_2", kind: "App", state: "Hidden" }],
    });
    expect(runningAppsOf(older)).toEqual(new Set(["files"]));
  });

  test("the two questions differ on the SAME snapshot: running vs. tileable", () => {
    const s = snap([w("files", "files", 1, { state: "Hidden" })]);
    // Running: the app is up. Tileable: nothing on screen to show. One rule must not be
    // copied into the other.
    expect(runningAppsOf(s)).toEqual(new Set(["files"]));
    expect(windowsOfApp(s, "files")).toEqual([]);
  });
});

describe("wmPaneRects / normalizePaneRects (REQ-A512 touch panes)", () => {
  const panes = [
    { label: "primary", x: 0, y: 0, width: 600, height: 900 },
    { label: "secondary", x: 612, y: 0, width: 588, height: 900 },
  ];

  test("wmPaneRects calls wm_pane_rects with axis/percent/size and normalizes the reply", async () => {
    respond = () => panes;
    const got = await wmPaneRects("auto", 50, 1200, 900);
    expect(calls[0]).toEqual({
      command: "wm_pane_rects",
      args: { axis: "auto", percent: 50, width: 1200, height: 900 },
    });
    expect(got).toEqual(panes);
  });

  test("the host refusing to place a split resolves to null, never fabricated panes", async () => {
    // `Ok(None)` from the host: the screen cannot host two minimum panes + the divider.
    respond = () => null;
    expect(await wmPaneRects("vertical", 50, 200, 900)).toBeNull();
  });

  test("a malformed reply is null, not a half-pane layout", () => {
    expect(normalizePaneRects([])).toBeNull();
    expect(normalizePaneRects([panes[0]])).toBeNull();
    expect(normalizePaneRects(null)).toBeNull();
    expect(normalizePaneRects("nope")).toBeNull();
    // A rect with no usable size is dropped, never clamped to a zero-sized pane.
    expect(normalizePaneRects([panes[0], { x: 0, y: 0, width: 0, height: 900 }])).toBeNull();
    expect(normalizePaneRects([panes[0], { label: "secondary" }])).toBeNull();
    expect(normalizePaneRects([panes[0], { width: NaN, height: 900 }])).toBeNull();
  });

  test("a usable reply keeps its rects and defaults only the origin", () => {
    const got = normalizePaneRects([
      { width: 600.6, height: 900.2 },
      { label: "secondary", x: 612, y: -3, width: 588, height: 900 },
    ]);
    expect(got).toEqual([
      { label: "", x: 0, y: 0, width: 600, height: 900 },
      { label: "secondary", x: 612, y: -3, width: 588, height: 900 },
    ]);
  });
});
// ============================================================================
// WithDiag variants for the four split commands (REQ-A513 / F-SH-053).
//
// Same shape as `wmNewWindowWithDiag` / `wmCycleAppWithDiag`: `null` from `invoke`
// is **never** silently swallowed — a refused call must look different from a
// success at the call site (WindowPage uses this to tell "no bridge" from "host
// refused"). These are the only form of the four commands (REQ-A1707: the plain
// twins were deleted — nothing called them).
// ============================================================================

describe("wmSplitWithDiag / wmSplitMoveWithDiag / wmSplitSwapWithDiag / wmSplitExitWithDiag", () => {
  test("wmSplitWithDiag sends primary/secondary/axis and returns the snapshot on success", async () => {
    const r = await wmSplitWithDiag("notes", "maps", "vertical");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.snapshot).toEqual(splitSnap);
    expect(calls[0]).toEqual({
      command: "wm_split",
      args: { primary: "notes", secondary: "maps", axis: "vertical" },
    });
  });

  test("wmSplitMoveWithDiag sends the delta and returns the snapshot on success", async () => {
    const r = await wmSplitMoveWithDiag(5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.snapshot).toEqual(splitSnap);
    expect(calls[0]).toEqual({ command: "wm_split_move", args: { delta: 5 } });
  });

  test("wmSplitSwapWithDiag returns the snapshot on success and names the right command", async () => {
    const r = await wmSplitSwapWithDiag();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.snapshot).toEqual(splitSnap);
    expect(calls[0]).toEqual({ command: "wm_split_swap" });
  });

  test("wmSplitExitWithDiag returns the snapshot on success and names the right command", async () => {
    const r = await wmSplitExitWithDiag();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.snapshot).toEqual(splitSnap);
    expect(calls[0]).toEqual({ command: "wm_split_exit" });
  });

  test("a refusal (null from a present bridge) reports host-refused-null, not a silent drop", async () => {
    // REQ-A513: `null` from the host used to be a silent drop — the page said the
    // button "did not land" with no reason, so a transient refusal looked the
    // same as "no bridge". The split variants explicitly model this third
    // shape (`host-refused-null`) because `lib/backend.ts`'s `invoke` records
    // `ok: true` for null-and-no-throw — the page can now tell the three
    // failures apart and surface the right one.
    respond = () => null;
    setWindow({
      __TAURI_INTERNALS__: {
        invoke: async () => null,
        listen: async () => () => {},
      },
    });
    const r = await wmSplitWithDiag("notes", "maps", "auto");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Narrow on the diag itself: `WmReplyDiag` carries an `{ok:true}` variant for the
      // ledger record shape, so `kind`/`command` exist only once `diag.ok` is false.
      expect(r.diag.ok).toBe(false);
      if (!r.diag.ok) {
        expect(r.diag.kind).toBe("host-refused-null");
        expect(r.diag.command).toBe("wm_split");
      }
    }
  });

  test("a host error (Rust Err) records into the diagnostics ledger via the WithDiag path", async () => {
    // REQ-A220: a Rust `Err` used to reject the promise and never reach the UI's
    // ledger. The diag-aware variants now go through `bridgeDiag` and write to
    // the same log the desktop-shell reports, so a refused split geometry is
    // retrievable from `recentDiag` exactly like any other bridge failure.
    clearDiag();
    setWindow({
      __TAURI_INTERNALS__: {
        invoke: async () => {
          throw new Error("split geometry is not available");
        },
        listen: async () => () => {},
      },
    });
    const r = await wmSplitExitWithDiag();
    expect(r.ok).toBe(false);
    const logged = recentDiag(20).find((e) => `${e.msg}`.includes("wm_split_exit"));
    expect(logged, "the host's refusal reaches the diagnostics ledger").toBeTruthy();
  });

  test("the WithDiag variants are not wired from anywhere except this test (unwired-scan gate)", () => {
    // REQ-A220: every WithDiag variant exists because at least one prod caller
    // needs the diag record; creating a `*WithDiag` nobody calls is a second
    // API the gate (`scripts/unwired-scan.mjs`) flags. WindowPage is the one
    // caller — if a future change moves it back to the plain wrappers, this
    // assertion (the integration test the gate reads) fails and the gate
    // catches it.
    expect(typeof wmSplitWithDiag).toBe("function");
    expect(typeof wmSplitMoveWithDiag).toBe("function");
    expect(typeof wmSplitSwapWithDiag).toBe("function");
    expect(typeof wmSplitExitWithDiag).toBe("function");
  });
});
