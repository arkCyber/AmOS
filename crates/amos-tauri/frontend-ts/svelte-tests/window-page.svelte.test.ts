/**
 * window-page.svelte.test.ts — 「窗口与形态」 honesty.
 *
 * The page shows only what the window host reports: the resolved form factor, the
 * content-column count, whether multiple windows / free resize are allowed, the
 * divider width and whether a split is live. No host ⇒ every value is the honest
 * “—” (never a guess from the WebView's width, which cannot tell a phone from a
 * tablet). Updates arrive by host push (`layout-changed`) **plus a bounded
 * re-probe**, so the page must follow pushes live, must not keep a stale reading
 * after the host goes away, and must survive a command that fails.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WindowPage from "../src/svelte/settings/WindowPage.svelte";
import { LAYOUT_CHANGED_EVENT, type LayoutSnapshot } from "../src/lib/wm";
import { clearDiag, recentDiag } from "../src/lib/debugLog";
import { zh } from "../src/i18n/locales/zh";

type Listener = (e: { payload: unknown }) => void;
let listeners: Map<string, Listener>;
/** Every bridge call the page made, in order (command + args). */
let calls: Array<{ cmd: string; args?: Record<string, unknown> }>;

const snap = (over: Partial<LayoutSnapshot> = {}): LayoutSnapshot => ({
  screen_w: 1280,
  screen_h: 800,
  split: null,
  candidates: [],
  form: "tablet",
  columns: 2,
  multi_window: true,
  free_resize: false,
  divider_gap: 12,
  ...over,
});

/** A snapshot with a live split (the host's own two panes). */
const splitSnap = (over: Partial<LayoutSnapshot> = {}): LayoutSnapshot =>
  snap({
    split: {
      axis: "vertical",
      percent: 50,
      primary: "notes",
      secondary: "maps",
      panes: [
        { label: "notes", x: 0, y: 0, width: 500, height: 800 },
        { label: "maps", x: 512, y: 0, width: 768, height: 800 },
      ],
    },
    ...over,
  });

/** Install a fake host whose answer the test can change while the page is open.
 *
 * `commands` answers the split commands by name; a command with no handler answers
 * `null`, exactly like a host that does not know it. Every call is recorded in
 * `calls` so a test can assert *what the page asked for* (never just that it
 * asked).
 */
function installHost(
  answer: () => unknown,
  commands: Record<string, (args?: Record<string, unknown>) => unknown> = {},
) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "wm_layout_snapshot") return answer();
      const handler = commands[cmd];
      return handler ? handler(args) : null;
    },
    listen: async (channel: string, handler: Listener) => {
      listeners.set(channel, handler);
      return () => listeners.delete(channel);
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 40));
const byTest = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);
const textOf = (c: HTMLElement, id: string) => byTest(c, id)?.textContent?.trim() ?? "";

/** Flip the (read-only) visibility state and announce it, as a browser would. */
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

const VALUE_ROWS = [
  "wm-form",
  "wm-columns",
  "wm-multi-window",
  "wm-free-resize",
  "wm-divider-gap",
  "wm-split",
];

beforeEach(() => {
  listeners = new Map();
  calls = [];
  clearDiag();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("WindowPage.svelte", () => {
  test("without a window host every value is the honest dash", async () => {
    const { container } = render(WindowPage);
    await tick();
    await settle();

    expect(textOf(container, "wm-no-host")).toBe(zh["wm.noHost"]);
    for (const id of VALUE_ROWS) {
      expect(textOf(container, id)).toBe(zh["wm.unavailable"]);
    }
  });

  test("shows the class and capabilities the host reports", async () => {
    installHost(() => snap());
    const { container } = render(WindowPage);
    await tick();
    await settle();

    expect(byTest(container, "wm-no-host")).toBeNull();
    expect(textOf(container, "wm-form")).toBe(zh["wm.form.tablet"]);
    expect(textOf(container, "wm-columns")).toBe("2");
    expect(textOf(container, "wm-multi-window")).toBe(zh["wm.yes"]);
    expect(textOf(container, "wm-free-resize")).toBe(zh["wm.no"]);
    expect(textOf(container, "wm-divider-gap")).toBe("12px");
    expect(textOf(container, "wm-split")).toBe(zh["wm.none"]);
  });

  test("follows host pushes live, including the split description", async () => {
    installHost(() => snap());
    const { container } = render(WindowPage);
    await tick();
    await settle();

    // Baseline: how many candidate reads the mount probe already made.
    const candidateCalls = calls.filter((c) => c.cmd === "wm_split_candidates").length;

    // The host reports a split (its own geometry, its own percent).
    const push = listeners.get(LAYOUT_CHANGED_EVENT);
    expect(push, "the page subscribed to the host's layout channel").toBeTruthy();
    push?.({
      payload: snap({
        split: {
          axis: "vertical",
          percent: 40,
          primary: "notes",
          secondary: "maps",
          panes: [
            { label: "notes", x: 0, y: 0, width: 500, height: 800 },
            { label: "maps", x: 512, y: 0, width: 768, height: 800 },
          ],
        },
      }),
    });
    await tick();
    expect(textOf(container, "wm-split")).toBe("notes ⇆ maps · vertical @ 40%");

    // …and a push that says this class may not resize freely flips that row.
    push?.({ payload: snap({ form: "desktop", columns: 4, free_resize: true }) });
    await tick();
    expect(textOf(container, "wm-form")).toBe(zh["wm.form.desktop"]);
    expect(textOf(container, "wm-columns")).toBe("4");
    expect(textOf(container, "wm-free-resize")).toBe(zh["wm.yes"]);

    // The push also re-reads the split candidates: a push means the host's window
    // set may have changed, and the controls must not act on a stale list.
    expect(
      calls.filter((c) => c.cmd === "wm_split_candidates").length,
      "a layout push refreshes the candidate list",
    ).toBeGreaterThan(candidateCalls);
  });

  test("a bridged host that answers nothing says so, and keeps saying nothing", async () => {
    installHost(() => null);
    const { container } = render(WindowPage);
    await tick();
    await settle();

    // The bridge exists but the host is silent: a *different* fact from "browser
    // preview", and stated as such.
    expect(byTest(container, "wm-no-host")).toBeNull();
    expect(textOf(container, "wm-no-answer")).toBe(zh["wm.noAnswer"]);
    for (const id of VALUE_ROWS) {
      expect(textOf(container, id)).toBe(zh["wm.unavailable"]);
    }
  });

  test("re-probes, so a host that goes away mid-view cannot leave a stale reading", async () => {
    // The defect this pins (REQ-A220): a subscription alone never fires for a host
    // that stopped existing, so the last reading used to stay on screen forever.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let online = true;
    installHost(() => (online ? snap() : null));

    const { container } = render(WindowPage);
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(textOf(container, "wm-form")).toBe(zh["wm.form.tablet"]);

    // The host drops (no `layout-changed` event — nothing is running to send one).
    online = false;
    await vi.advanceTimersByTimeAsync(10_000);
    await tick();
    expect(textOf(container, "wm-form")).toBe(zh["wm.unavailable"]);
    expect(textOf(container, "wm-columns")).toBe(zh["wm.unavailable"]);
    expect(textOf(container, "wm-no-answer")).toBe(zh["wm.noAnswer"]);

    // …and a host that comes back is picked up again.
    online = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await tick();
    expect(textOf(container, "wm-form")).toBe(zh["wm.form.tablet"]);
    expect(byTest(container, "wm-no-answer")).toBeNull();
  });

  test("re-probes immediately when the page becomes visible again", async () => {
    // A hidden tab deliberately skips its interval ticks, so without the
    // visibilitychange re-probe the user would come back to a reading up to one
    // whole PROBE_MS old.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let online = true;
    installHost(() => (online ? snap() : null));

    const { container } = render(WindowPage);
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(textOf(container, "wm-form")).toBe(zh["wm.form.tablet"]);

    // The tab goes away and the host changes underneath it (no event reaches a
    // hidden page), then the user comes back.
    online = false;
    setVisibility("hidden");
    setVisibility("visible");
    await tick();
    await vi.advanceTimersByTimeAsync(0); // the re-probe is async: flush it
    // No interval elapsed — being visible again is enough to re-read.
    expect(textOf(container, "wm-form")).toBe(zh["wm.unavailable"]);
  });

  test("a failing command is an honest dash and reaches the diagnostics ledger", async () => {
    // `wm_layout_snapshot` can fail in Rust (e.g. "split geometry is not
    // available"). Before REQ-A220 the bridge re-implemented `invoke` without a
    // catch, so that failure became an *unhandled rejection* here and never
    // reached the ledger the UI reads.
    installHost(() => Promise.reject(new Error("split geometry is not available")));
    const { container } = render(WindowPage);
    await tick();
    await settle();

    for (const id of VALUE_ROWS) {
      expect(textOf(container, id)).toBe(zh["wm.unavailable"]);
    }
    const warned = recentDiag(20).find((e) => `${e.msg}`.includes("wm_layout_snapshot"));
    expect(warned, "the failed probe is retrievable from the diagnostics ledger").toBeTruthy();
    expect(`${warned?.msg}`).toContain("wm_layout_snapshot failed");
  });

  test("the split controls exist only where the host allows multiple windows", async () => {
    // The host's own capability answer gates the controls: on a phone class
    // `multi_window` is false, so the page must not even offer the request (the
    // host would refuse it, and an offered-then-refused control is a lie).
    installHost(() => snap({ form: "phone", columns: 1, multi_window: false }));
    const phone = render(WindowPage);
    await tick();
    await settle();
    expect(byTest(phone.container, "wm-enter-split")).toBeNull();
    expect(byTest(phone.container, "wm-candidates")).toBeNull();
    cleanup();

    installHost(() => snap(), { wm_split_candidates: () => ["notes", "maps"] });
    const { container } = render(WindowPage);
    await tick();
    await settle();

    expect(textOf(container, "wm-candidates")).toBe(
      zh["wm.candidates"].replace("{list}", "notes · maps"),
    );
    const enter = byTest(container, "wm-enter-split") as HTMLButtonElement;
    expect(enter, "a multi-window class offers entering a split").toBeTruthy();
    expect(enter.disabled, "two candidates are the host's own minimum").toBe(false);
  });

  test("entering a split asks with the host's own candidates and the auto axis", async () => {
    installHost(
      () => snap(),
      {
        wm_split_candidates: () => ["notes", "maps"],
        wm_split: () => splitSnap(),
      },
    );
    const { container } = render(WindowPage);
    await tick();
    await settle();

    await fireEvent.click(byTest(container, "wm-enter-split") as HTMLButtonElement);
    await tick();
    await settle();

    // The page never invents labels or an orientation: the candidates come from
    // the host and `auto` lets *it* pick the axis from the real screen.
    expect(calls.find((c) => c.cmd === "wm_split")?.args).toEqual({
      primary: "notes",
      secondary: "maps",
      axis: "auto",
    });
    // …and the host's answer is adopted as the new truth.
    expect(textOf(container, "wm-split")).toBe("notes ⇆ maps · vertical @ 50%");
    expect(byTest(container, "wm-exit-split")).toBeTruthy();
    expect(byTest(container, "wm-enter-split")).toBeNull();
  });

  test("a refused action never fakes success and says so in the ledger", async () => {
    // A split the host considers unfeasible (`resize_by` refuses) must leave the
    // readout on the last authoritative value — a failed action that *looks* like
    // it worked is exactly the class of lie this page exists to avoid.
    installHost(
      () => splitSnap(),
      {
        wm_split_candidates: () => ["notes", "maps"],
        wm_split_move: () => {
          throw new Error("that divider move is not feasible at the current minimum size");
        },
      },
    );
    const { container } = render(WindowPage);
    await tick();
    await settle();
    expect(textOf(container, "wm-split")).toBe("notes ⇆ maps · vertical @ 50%");

    await fireEvent.click(byTest(container, "wm-wider") as HTMLButtonElement);
    await tick();
    await settle();

    expect(calls.some((c) => c.cmd === "wm_split_move")).toBe(true);
    expect(textOf(container, "wm-split"), "the reading is unchanged").toBe(
      "notes ⇆ maps · vertical @ 50%",
    );
    // REQ-A513: the diag-aware split variants now distinguish "host refused" from
    // "no bridge", so the copy is the more informative one (the user can tell a
    // transient refusal from "the desktop has gone").
    expect(textOf(container, "wm-note")).toBe(zh["wm.hostRefused"]);
    const warned = recentDiag(20).find((e) => `${e.msg}`.includes("wm_split_move"));
    expect(warned, "the refusal is retrievable from the diagnostics ledger").toBeTruthy();
  });

  test("leaving a split asks the host and re-reads the split candidates", async () => {
    let live = true;
    installHost(
      () => (live ? splitSnap() : snap()),
      {
        wm_split_candidates: () => ["notes", "maps"],
        wm_split_exit: () => {
          live = false;
          return snap();
        },
      },
    );
    const { container } = render(WindowPage);
    await tick();
    await settle();

    const before = calls.filter((c) => c.cmd === "wm_split_candidates").length;
    await fireEvent.click(byTest(container, "wm-exit-split") as HTMLButtonElement);
    await tick();
    await settle();

    expect(textOf(container, "wm-split")).toBe(zh["wm.none"]);
    // The candidate list is only meaningful while no split is live, so leaving one
    // must re-read it: otherwise the "enter split" button would stay inert on a
    // list the page never refreshed.
    const after = calls.filter((c) => c.cmd === "wm_split_candidates").length;
    expect(after, "the candidate list was re-read after leaving the split").toBeGreaterThan(
      before,
    );
    expect(byTest(container, "wm-enter-split")).toBeTruthy();
  });

  // ---- 「窗口管理器 (调试)」card (REQ-A225) ----

  test("the debug card lists the host's own windows, external surfaces marked", async () => {
    // `docs/gui-verify.md` A4 / `docs/android-compat.md` W4 verify exactly this
    // list, so the card must show the host's words verbatim — including the
    // composited container surfaces that have no WebView.
    installHost(() => snap(), {
      wm_windows: () => ({
        focused: 7,
        windows: [
          { id: 7, label: "main", kind: "Launcher", state: "Focused", focused: true, external: false },
          { id: 8, label: "notes", kind: "App", state: "Shown", focused: false, external: false },
          {
            id: 9,
            label: "legacy:waydroid_0",
            kind: "System",
            state: "Shown",
            focused: false,
            external: true,
          },
        ],
      }),
    });
    const { container } = render(WindowPage);
    await tick();
    await settle();

    expect(textOf(container, "wm-debug-title")).toBe(zh["wm.debugTitle"]);
    const rows = container.querySelectorAll('[data-testid="wm-window-row"]');
    expect(rows).toHaveLength(3);
    const text = [...rows].map((r) => r.textContent?.trim() ?? "");
    expect(text[0]).toContain("main [Launcher] Focused");
    expect(text[0], "the focused window is marked").toContain(zh["wm.focused"]);
    expect(text[1]).toBe("notes [App] Shown");
    expect(text[2]).toContain("legacy:waydroid_0 [System] Shown");
    expect(text[2], "a container surface is marked as external").toContain(zh["wm.external"]);
  });

  test("an instance window shows its app and instance next to the label (REQ-A473)", async () => {
    // A debug card is where "which app does this window show, and which instance of it" has
    // to be *readable* — the label alone stopped answering it once an app could own several
    // windows. The identity is printed **only when it is news**: `files` repeated after
    // `files` would be noise on every row.
    installHost(() => snap(), {
      wm_windows: () => ({
        focused: null,
        windows: [
          { id: 1, label: "files", app: "files", instance: 1, kind: "App", state: "Shown", focused: false, external: false },
          { id: 2, label: "files_2", app: "files", instance: 2, kind: "App", state: "Shown", focused: false, external: false },
          {
            id: 3,
            label: "legacy:waydroid_0",
            app: "",
            instance: 0,
            kind: "System",
            state: "Shown",
            focused: false,
            external: true,
          },
        ],
      }),
    });
    const { container } = render(WindowPage);
    await tick();
    await settle();

    const text = [...container.querySelectorAll('[data-testid="wm-window-row"]')].map(
      (r) => r.textContent?.replace(/\s+/g, " ").trim() ?? "",
    );
    expect(text[0]).toBe("files [App] Shown");
    expect(text[1]).toBe("files_2 [App] Shown · files #2");
    // A surface with no app gains nothing from an identity line (`""`/0): no instance
    // marker, and nothing appended after the external flag (the "·" before it belongs to
    // `wm.external`, not to an identity).
    expect(text[2]).toContain("legacy:waydroid_0 [System] Shown");
    expect(text[2]).not.toContain("#");
    expect(text[2].endsWith(zh["wm.external"]), text[2]).toBe(true);
  });

  test("the debug card re-reads on the host's push and on the refresh button", async () => {
    let windows = [{ id: 1, label: "main", kind: "Launcher", state: "Shown" }];
    installHost(() => snap(), {
      wm_windows: () => ({ focused: null, windows }),
    });
    const { container } = render(WindowPage);
    await tick();
    await settle();
    expect(container.querySelectorAll('[data-testid="wm-window-row"]')).toHaveLength(1);

    // A push means the window set may have changed: the card follows it.
    const before = calls.filter((c) => c.cmd === "wm_windows").length;
    windows = [...windows, { id: 2, label: "notes", kind: "App", state: "Shown" }];
    listeners.get(LAYOUT_CHANGED_EVENT)?.({ payload: snap() });
    await tick();
    await settle();
    expect(container.querySelectorAll('[data-testid="wm-window-row"]')).toHaveLength(2);
    expect(calls.filter((c) => c.cmd === "wm_windows").length).toBeGreaterThan(before);

    // …and the 刷新 button asks again on demand (the A4 step).
    windows = [windows[0]];
    await fireEvent.click(byTest(container, "wm-refresh-windows") as HTMLButtonElement);
    await tick();
    await settle();
    expect(container.querySelectorAll('[data-testid="wm-window-row"]')).toHaveLength(1);
  });

  test("a card read that fails keeps nothing: no answer instead of a stale list", async () => {
    // A debug surface that shows a window the host no longer has would be worse
    // than one that admits it does not know.
    let ok = true;
    installHost(() => snap(), {
      wm_windows: () => {
        if (!ok) throw new Error("wm_windows unavailable");
        return { focused: null, windows: [{ id: 1, label: "notes", kind: "App", state: "Shown" }] };
      },
    });
    const { container } = render(WindowPage);
    await tick();
    await settle();
    expect(container.querySelectorAll('[data-testid="wm-window-row"]')).toHaveLength(1);

    ok = false;
    await fireEvent.click(byTest(container, "wm-refresh-windows") as HTMLButtonElement);
    await tick();
    await settle();
    expect(container.querySelectorAll('[data-testid="wm-window-row"]')).toHaveLength(0);
    expect(textOf(container, "wm-windows-no-answer")).toBe(zh["wm.noAnswer"]);
    expect(
      recentDiag(20).find((e) => `${e.msg}`.includes("wm_windows")),
      "the failed read is retrievable from the diagnostics ledger",
    ).toBeTruthy();
  });

  test("the debug card never runs outside a host", async () => {
    const { container } = render(WindowPage);
    await tick();
    await settle();
    expect(textOf(container, "wm-windows-no-host")).toBe(zh["wm.noHost"]);
    expect(byTest(container, "wm-window-list")).toBeNull();
  });

  test("a container surface is explained where the split controls would offer it", async () => {
    // REQ-A226: the host never offers a `legacy:*` container surface as a pane (it has
    // no window to place). The debug card DOES list it, so without a word here the
    // absence would read as a bug.
    const surface = {
      id: 9,
      label: "legacy:waydroid_0",
      kind: "System",
      state: "Shown",
      focused: false,
      external: true,
    };
    installHost(() => snap(), {
      wm_split_candidates: () => ["notes"],
      wm_windows: () => ({ focused: null, windows: [surface] }),
    });
    const { container } = render(WindowPage);
    await tick();
    await settle();

    expect(textOf(container, "wm-candidates")).toBe(
      zh["wm.candidates"].replace("{list}", "notes"),
    );
    expect(textOf(container, "wm-candidates-note")).toBe(zh["wm.candidatesNote"]);
    const enter = byTest(container, "wm-enter-split") as HTMLButtonElement;
    expect(enter.disabled, "one placeable window is not a split").toBe(true);
    // …and the surface itself is still visible in the debug card (never hidden).
    expect(textOf(container, "wm-window-list")).toContain("legacy:waydroid_0");
    cleanup();

    // No container surface ⇒ nothing to explain.
    installHost(() => snap(), {
      wm_split_candidates: () => ["notes", "maps"],
      wm_windows: () => ({
        focused: null,
        windows: [
          { id: 1, label: "notes", kind: "App", state: "Shown", focused: false, external: false },
        ],
      }),
    });
    const second = render(WindowPage);
    await tick();
    await settle();
    expect(byTest(second.container, "wm-candidates-note")).toBeNull();
  });
});

// ============================================================================
// WindowPage-local keyboard shortcuts (REQ-A224 §shortcuts).
//
// The page is its own focusable surface (`tabindex="-1"`), so these keys only
// fire while the user is on it — a typing user in another Settings field cannot
// accidentally exit a split by pressing Escape in the IME picker. The hint
// (`data-testid="wm-split-kbd"`) renders the same `<kbd>` chips for discoverability.
// ============================================================================

// ============================================================================
// The Stage Manager switch (REQ-A1568).
//
// The mode has two other fronts (the Window menu's row and the ⌃⌘S chord); this is where a
// user who never opens the Window menu finds it, so the three facts pinned here are the ones
// that would rot silently: which class is offered the switch, that a flip asks the host for
// the **inverse** and adopts only the host's own answer, and that a refusal says why without
// moving the switch.
// ============================================================================

const stageSnap = (enabled: boolean) => ({ enabled, on_stage: [], parked: [] });

/** The switch's backing button, whatever the row's markup is doing. */
const switchOf = (c: HTMLElement) => c.querySelector('[role="switch"]') as HTMLButtonElement | null;

/** The visible label a Row's switch is named by (WCAG 2.5.3: name = what is on screen). */
const nameOf = (c: HTMLElement) => {
  const sw = switchOf(c);
  const id = sw?.getAttribute("aria-labelledby");
  return id ? (c.querySelector(`#${id}`)?.textContent?.trim() ?? "") : "";
};

describe("WindowPage.svelte — Stage Manager (REQ-A1568)", () => {
  test("only a class the host calls `desktop` is offered the switch", async () => {
    // The gate is the class, **not** `rail_width > 0`: the rail is only reserved while the
    // mode is on, so a rail-width gate would hide the switch in exactly the state it exists
    // to leave (a flag gating the element it must read). The snapshot below is the proof —
    // a desktop whose rail is 0 because the mode is off still gets the switch.
    installHost(() => snap({ form: "desktop", columns: 4, free_resize: true, rail_width: 0 }), {
      stage_snapshot: () => stageSnap(false),
    });
    const desktop = render(WindowPage);
    await tick();
    await settle();
    expect(switchOf(desktop.container), "a desktop is offered Stage Manager").toBeTruthy();
    expect(nameOf(desktop.container)).toBe(zh["wm.stage"]);
    expect(switchOf(desktop.container)?.getAttribute("aria-checked")).toBe("false");
    // The sentence names the same chord the Window menu's row shows, read off the table.
    expect(textOf(desktop.container, "wm-stage-note")).toBe(
      zh["wm.stageNote"].replace("{chord}", "⌃⌘S"),
    );
    cleanup();

    // A tablet has multiple windows and no rail; offering the switch there would offer a
    // request the host refuses by name (`amos.stage.unsupported`).
    installHost(() => snap());
    const tablet = render(WindowPage);
    await tick();
    await settle();
    expect(switchOf(tablet.container)).toBeNull();
  });

  test("flipping the switch asks for the inverse and adopts the host's answer", async () => {
    installHost(() => snap({ form: "desktop", columns: 4, rail_width: 180 }), {
      stage_snapshot: () => stageSnap(false),
      stage_set_enabled: (args) => stageSnap(args?.enabled === true),
    });
    const { container } = render(WindowPage);
    await tick();
    await settle();

    await fireEvent.click(switchOf(container) as HTMLButtonElement);
    await tick();
    await settle();

    // It asked for the **inverse** of what the host last reported, not for a hard-coded true.
    expect(calls.find((c) => c.cmd === "stage_set_enabled")?.args).toEqual({ enabled: true });
    expect(switchOf(container)?.getAttribute("aria-checked")).toBe("true");

    // …and back off again, from the host's own "on".
    await fireEvent.click(switchOf(container) as HTMLButtonElement);
    await tick();
    await settle();
    expect(calls.filter((c) => c.cmd === "stage_set_enabled").at(-1)?.args).toEqual({
      enabled: false,
    });
    expect(switchOf(container)?.getAttribute("aria-checked")).toBe("false");
  });

  test("a refused flip leaves the switch alone and names the host's reason", async () => {
    installHost(() => snap({ form: "desktop", columns: 4, rail_width: 180 }), {
      stage_snapshot: () => stageSnap(false),
      stage_set_enabled: () => {
        // The Rust envelope, thrown the way Tauri throws it.
        throw { code: "amos.stage.unsupported", message: "no rail on this class" };
      },
    });
    const { container } = render(WindowPage);
    await tick();
    await settle();

    await fireEvent.click(switchOf(container) as HTMLButtonElement);
    await tick();
    await settle();

    // A mode the window manager never entered must not be shown as entered.
    expect(switchOf(container)?.getAttribute("aria-checked")).toBe("false");
    expect(textOf(container, "wm-stage-note-result")).toBe(zh["stage.errorUnsupported"]);
    expect(
      recentDiag(20).find((e) => `${e.msg}`.includes("stage_set_enabled")),
      "the refusal is retrievable from the diagnostics ledger",
    ).toBeTruthy();
  });

  test("a mode turned on from the shell's other front is followed by this page", async () => {
    // The Window menu row and the ⌃⌘S chord change the same bit, and `stage_set_enabled`
    // ends in the host's layout push — so the switch must follow a push rather than keep a
    // reading from mount time.
    let enabled = false;
    installHost(() => snap({ form: "desktop", columns: 4, rail_width: enabled ? 180 : 0 }), {
      stage_snapshot: () => stageSnap(enabled),
    });
    const { container } = render(WindowPage);
    await tick();
    await settle();
    expect(switchOf(container)?.getAttribute("aria-checked")).toBe("false");

    enabled = true;
    listeners.get(LAYOUT_CHANGED_EVENT)?.({ payload: snap({ form: "desktop", rail_width: 180 }) });
    await tick();
    await settle();

    expect(switchOf(container)?.getAttribute("aria-checked")).toBe("true");
  });
});

describe("WindowPage.svelte — split keyboard shortcuts", () => {
  test("Enter on the un-split page enters a split (no mouse)", async () => {
    installHost(
      () => snap(),
      {
        wm_split_candidates: () => ["notes", "maps"],
        wm_split: () => splitSnap(),
      },
    );
    const { container } = render(WindowPage);
    await tick();
    await settle();

    // The shortcut hint is visible so the user knows the key exists.
    expect(byTest(container, "wm-split-kbd")).toBeTruthy();

    const page = byTest(container, "wm-page") as HTMLDivElement;
    await fireEvent.keyDown(page, { key: "Enter" });
    await tick();
    await settle();

    expect(calls.find((c) => c.cmd === "wm_split")?.args).toEqual({
      primary: "notes",
      secondary: "maps",
      axis: "auto",
    });
  });

  test("ArrowLeft / ArrowRight on a live split nudge the divider", async () => {
    let live = true;
    installHost(
      () => (live ? splitSnap() : snap()),
      {
        wm_split_candidates: () => ["notes", "maps"],
        wm_split_move: (args) => {
          // The page passes the delta through as-is.
          return splitSnap();
        },
      },
    );
    const { container } = render(WindowPage);
    await tick();
    await settle();
    expect(byTest(container, "wm-exit-split")).toBeTruthy();

    const page = byTest(container, "wm-page") as HTMLDivElement;
    const before = calls.filter((c) => c.cmd === "wm_split_move").length;

    await fireEvent.keyDown(page, { key: "ArrowLeft" });
    await tick();
    await fireEvent.keyDown(page, { key: "ArrowRight" });
    await tick();
    await settle();

    const moves = calls.filter((c) => c.cmd === "wm_split_move");
    expect(moves.length - before, "two nudges = two host calls").toBe(2);
    // The page uses the same step the button uses (-5 / +5), not a fresh magnitude,
    // so the host's own minimum-size guard stays the only authority on the clamp.
    expect(moves.at(-2)?.args).toEqual({ delta: -5 });
    expect(moves.at(-1)?.args).toEqual({ delta: 5 });
  });

  test("Escape on a live split exits the split and re-reads the candidates", async () => {
    let live = true;
    installHost(
      () => (live ? splitSnap() : snap()),
      {
        wm_split_candidates: () => ["notes", "maps"],
        wm_split_exit: () => {
          live = false;
          return snap();
        },
      },
    );
    const { container } = render(WindowPage);
    await tick();
    await settle();

    const before = calls.filter((c) => c.cmd === "wm_split_candidates").length;
    const page = byTest(container, "wm-page") as HTMLDivElement;
    await fireEvent.keyDown(page, { key: "Escape" });
    await tick();
    await settle();

    expect(calls.some((c) => c.cmd === "wm_split_exit")).toBe(true);
    // The candidate list is only meaningful while no split is live: the page must
    // re-read it on exit, just like clicking the button does.
    expect(calls.filter((c) => c.cmd === "wm_split_candidates").length).toBeGreaterThan(before);
    expect(textOf(container, "wm-split")).toBe(zh["wm.none"]);
  });

  test("a refused shortcut action says so (host-refused), not 'no bridge' (not-bridged)", async () => {
    // The split variants distinguish the two failure shapes; a test that only
    // inspected the actionFailed string would have missed the REQ-A513 change.
    installHost(
      () => splitSnap(),
      {
        wm_split_candidates: () => ["notes", "maps"],
        wm_split_swap: () => {
          throw new Error("split geometry is not available");
        },
      },
    );
    const { container } = render(WindowPage);
    await tick();
    await settle();

    const page = byTest(container, "wm-page") as HTMLDivElement;
    await fireEvent.keyDown(page, { key: "Enter" });
    await tick();
    await settle();

    // The page reads the diag record's kind and surfaces the right copy.
    expect(textOf(container, "wm-note")).toBe(zh["wm.hostRefused"]);
    // The reading is unchanged — a refused call must not look like it happened.
    expect(textOf(container, "wm-split")).toBe("notes ⇆ maps · vertical @ 50%");
  });
});
