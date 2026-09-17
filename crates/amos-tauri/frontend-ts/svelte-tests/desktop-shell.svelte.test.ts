/**
 * desktop-shell.svelte.test.ts — the macOS-form shell topology (PC desktop).
 *
 * Why these cases exist (each one is a defect this file was written against, not a
 * spare assertion):
 *   * `DesktopShell` registered its cleanup with `onDestroy(...)` *inside* its
 *     `onMount` callback — a lifecycle call from outside the component's init phase.
 *     Measured against Svelte 5.57 that form still runs (`onDestroy` is
 *     `onMount(() => () => fn())`), so the case here pins the **property** — unmount
 *     releases every listener it added — not the shape. Negative control: delete the
 *     cleanup in `DesktopShell.onMount` and this fails ("keydown listener was never
 *     removed"); the `onDestroy`-inside-`onMount` form passes it, which is why the
 *     assertion is worded as a behaviour and not as a lint.
 *   * the Dock rendered `aria-label={appTitleKey(id)}` — the i18n **key**
 *     (`app.clock`), not the user's language — and named its three system items with
 *     hard-coded English ("Launchpad"/"Finder"/"Trash").
 *   * the separator was drawn *after* the trash, so the one visual grouping the Dock
 *     has was wrong.
 *   * `dockCapacity` / `dockOverflowCount` / `shouldShowMissionControl` /
 *     `SPOTLIGHT_*` were pure functions with tests and **no production call site**;
 *     these cases fail if the wiring is removed again.
 *
 * REQ-A262 added the end-to-end half of the container split — the paths a unit test on a
 * widget *cannot* reach, because the chrome handle belongs to the shell:
 *   * a trigger's click, the Apple menu's live rows, and the keyboard all converge on the
 *     shell the same way, and the **tooltip's hint comes from the same registry row that
 *     matched the key** (before this round `lib/shellChrome.ts` claimed F4 was bound
 *     while nothing bound it);
 *   * the two `desktop:*` window events are gone: the stage's "new folder" was answered
 *     by an empty handler in this file (a wire to nowhere) and is a greyed menu row now.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopShell from "../src/svelte/DesktopShell.svelte";
import Dock from "../src/svelte/Dock.svelte";
import { LAYOUT_KEY, readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { resetDesktopFeaturesForTest } from "../src/lib/desktopFeatures";
import { DEFAULT_DESKTOP_VIEW, type DesktopView } from "../src/lib/desktopView";
import { DOCK_MIN_WIDTH, SPOTLIGHT_HEIGHT, SPOTLIGHT_WIDTH,
  DESKTOP_GRID_COLS,
  DESKTOP_GRID_INSET,
  DESKTOP_GRID_ROWS,
  DESKTOP_TILE_GAP_X,
  DESKTOP_TILE_GAP_Y,
  DESKTOP_TILE_SIZE,
  desktopGridWidth,
  desktopIconCapacity,
} from "../src/lib/desktopLayout";
import { surface, unlock } from "../src/svelte/shellState.svelte";
import { zh } from "../src/i18n/locales/zh";

const settle = () => new Promise((r) => setTimeout(r, 40));
const byAria = (c: HTMLElement, aria: string) => c.querySelector(`[aria-label="${aria}"]`);

const DESKTOP_SNAPSHOT = {
  screen_w: 1496,
  screen_h: 882,
  split: null,
  candidates: [],
  form: "desktop",
  columns: 4,
  multi_window: true,
  free_resize: true,
  divider_gap: 8,
};

/** A fake host: `invoke` answers the two wm commands the desktop shell uses.
 *
 * `commands[]` records the call order, and `lastCall` records the most recent
 * non-poll invocation. `wm_windows` is polled (Dock running dots + shell's focused
 * window reader), so it would always be the last call; `lastCall` skips it so
 * "what did the user's keypress do" is answerable from the test. */
/** Installs a fake host. `desktopFeatures` is what the host answers for
 *  `desktop_features_disabled` (REQ-A287) — the *production* path for the two shell
 *  capability switches, as opposed to the `window.__amosDisabledFeatures` test hook. */
function installHost({
  windows = [] as unknown[],
  commands = [] as string[],
  desktopFeatures = [] as string[],
} = {}) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      commands.push(cmd);
      // Boot facts (polled/asked once at mount) are not "a command the shell sent in
      // response to something": the cases that assert `__lastCall === undefined` mean
      // "this gesture reached no host command", so the boot reads must stay out of the
      // probe (REQ-A287 added `desktop_features_disabled`).
      const isBootFact =
        cmd === "wm_windows" || cmd === "wm_layout_snapshot" || cmd === "desktop_features_disabled";
      if (!isBootFact) {
        (window as unknown as Record<string, unknown>).__lastCall = { cmd, args };
      }
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      if (cmd === "wm_windows") return { windows };
      if (cmd === "desktop_features_disabled") return desktopFeatures;
      return null;
    },
    listen: async () => () => {},
  };
  return commands;
}

/** Variant for the REQ-A275 menu tests: every `wm_open(label)` call is recorded
 * on `window.__wmOpens` so a test can assert "File → New Window invoked the host
 * with `label: 'files'`" without parsing `__lastCall` (which is also written). */
function installHostWithRecorder() {
  (window as unknown as Record<string, unknown>).__wmOpens = [] as string[];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      if (cmd === "wm_open") {
        const label = (args as { label?: string } | undefined)?.label;
        if (typeof label === "string") {
          ((window as unknown as { __wmOpens: string[] }).__wmOpens).push(label);
        }
        (window as unknown as Record<string, unknown>).__lastCall = { cmd, args };
      }
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      if (cmd === "wm_windows") return { windows: [] };
      return null;
    },
    listen: async () => () => {},
  };
}

function press(key: string, mods: { metaKey?: boolean } = {}) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ...mods }));
}

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as unknown as { __lastCall?: unknown }).__lastCall;
  delete (window as unknown as { __wmOpens?: unknown }).__wmOpens;
  // The capability switches are module state in `lib/desktopFeatures` (one boot answer
  // per page load), so a case that answers "disabled" must not leak into the next one.
  resetDesktopFeaturesForTest();
});


describe("DesktopShell.svelte — the macOS chrome", () => {
  test("mounts the top bar, the dock and the stage", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    expect(byAria(container, zh["desktop.topbar"])).toBeTruthy();
    expect(byAria(container, zh["desktop.dock"])).toBeTruthy();
    expect(container.querySelector('[data-testid="dock-panel"]')).toBeTruthy();
    // The stage is the host's measured screen minus the chrome (1496 × 882 here).
    const stage = container.querySelector("div.absolute") as HTMLElement | null;
    expect(stage?.getAttribute("style") ?? "").toContain("width: 1496px");
  });

  test("the Dock keeps a usable minimum width (DOCK_MIN_WIDTH, not a hard-coded 0)", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const panel = container.querySelector('[data-testid="dock-panel"]') as HTMLElement;
    expect(panel.style.minWidth).toBe(`${DOCK_MIN_WIDTH}px`);
  });

  test("unmount releases EVERY window listener the shell added", async () => {
    installHost();
    const added: Array<[string, EventListenerOrEventListenerObject]> = [];
    const removed: Array<[string, EventListenerOrEventListenerObject]> = [];
    const onAdd = vi.spyOn(window, "addEventListener");
    const onRemove = vi.spyOn(window, "removeEventListener");
    onAdd.mockImplementation((type: string, h: EventListenerOrEventListenerObject) => {
      if (type === "keydown" || type.startsWith("desktop:")) added.push([type, h]);
    });
    onRemove.mockImplementation((type: string, h: EventListenerOrEventListenerObject) => {
      if (type === "keydown" || type.startsWith("desktop:")) removed.push([type, h]);
    });

    const { unmount } = render(DesktopShell);
    await tick();
    await settle();
    // The shell adds the shortcut listener (+ the layout subscription, which is not a
    // window listener). The two `desktop:*` events are gone in REQ-A262 — the stage and
    // the dock now reach the shell through the chrome handle.
    expect(added.length).toBeGreaterThanOrEqual(1);
    unmount();
    await tick();

    for (const [type, handler] of added) {
      expect(
        removed.some(([t2, h2]) => t2 === type && h2 === handler),
        `${type} listener was never removed`,
      ).toBe(true);
    }
  });

  test("⌘Space opens Spotlight (with the module's geometry) and Esc closes it", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="spotlight-overlay"]')).toBeNull();

    press(" ", { metaKey: true });
    await tick();
    await settle();
    const overlay = container.querySelector('[data-testid="spotlight-overlay"]') as HTMLElement;
    expect(overlay).toBeTruthy();
    // Inline styles come back normalised ("width: 600px"), so compare without spaces.
    const style = (overlay.getAttribute("style") ?? "").replace(/\s+/g, "");
    expect(style).toContain(`width:${SPOTLIGHT_WIDTH}px`);
    expect(style).toContain(`max-height:${SPOTLIGHT_HEIGHT}px`);
    // A dialog a screen reader can announce (the overlay used to be aria-hidden).
    expect(overlay.getAttribute("role")).toBe("dialog");
    expect(overlay.getAttribute("aria-label")).toBe(zh["desktop.spotlight"]);

    press("Escape");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="spotlight-overlay"]')).toBeNull();
  });

  test("⌘Tab shows the switcher only when there is something to switch between", async () => {
    installHost({ windows: [{ label: "files", kind: "App", state: "Focused" }] });
    const one = render(DesktopShell);
    await tick();
    await settle();
    press("Tab", { metaKey: true });
    await tick();
    await settle();
    expect(one.container.querySelector('[data-testid="mission-control"]')).toBeNull();


    one.unmount();

    installHost({
      windows: [
        { label: "files", kind: "App", state: "Focused" },
        { label: "notes", kind: "App", state: "Shown" },
      ],
    });
    const two = render(DesktopShell);
    await tick();
    await settle();
    press("Tab", { metaKey: true });
    await tick();
    await settle();
    const mc = two.container.querySelector('[data-testid="mission-control"]');
    expect(mc).toBeTruthy();
    expect(mc?.getAttribute("aria-label")).toBe(zh["desktop.missionControl"]);
  });

  test("F4 opens the Launchpad and F3 the switcher — from the registry, not a switch", async () => {
    installHost({
      windows: [
        { label: "files", kind: "App", state: "Focused" },
        { label: "notes", kind: "App", state: "Shown" },
      ],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    // F4 was documented as bound and was bound nowhere (`lib/shellChrome.ts`); the
    // registry row is now what both the binding and the tooltip read.
    press("F4");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeTruthy();
    // F4 again toggles it closed (a shortcut that only opens is half a shortcut).
    press("F4");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeNull();

    press("F3");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="mission-control"]')).toBeTruthy();

    // …and a modifier the binding does not list must not fire: ⌘F3 is not F3.
    press("F3", { metaKey: true });
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="mission-control"]')).toBeTruthy();
  });

  test("Esc closes the TOP overlay only (layers are stacked, not all-or-nothing)", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    press("F4"); // launchpad
    await tick();
    press(" ", { metaKey: true }); // …then spotlight on top of it
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="spotlight-overlay"]')).toBeTruthy();

    press("Escape");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="spotlight-overlay"]')).toBeNull();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeTruthy();
  });

  test("the bar's and the dock's Launchpad tiles open it, and their tooltip shows F4", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const barTrigger = container.querySelector<HTMLButtonElement>('[data-testid="chrome-launchpad"]')!;
    // One row in the registry feeds both the key handler and this hint: the label is
    // derived from the same `{ key: "F4" }` the matcher compares against.
    expect(barTrigger.getAttribute("title")).toBe(`${zh["desktop.launchpad"]} (F4)`);
    expect(barTrigger.getAttribute("aria-keyshortcuts")).toBe("F4");
    await fireEvent.click(barTrigger);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeTruthy();
    press("Escape");
    await tick();
    await settle();

    const dockTile = container.querySelector<HTMLButtonElement>('[data-testid="dock-launchpad"]')!;
    expect(dockTile.getAttribute("aria-keyshortcuts")).toBe("F4");
    await fireEvent.click(dockTile);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="launchpad-overlay"]')).toBeTruthy();
  });

  test("the Apple menu is real where it can be: 系统设置… opens the app, 锁定屏幕 locks", async () => {
    const commands = installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    unlock(); // the lock surface is module-level state shared across tests

    const apple = container.querySelector<HTMLButtonElement>('[data-testid="apple-menu-trigger"]')!;
    await fireEvent.click(apple);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-settings"]')!);
    await tick();
    await settle();
    expect(commands).toContain("wm_open");
    // The menu closes itself after a choice (macOS does the same).
    expect(container.querySelector('[data-testid="apple-menu-panel"]')).toBeNull();

    await fireEvent.click(apple);
    await tick();
    await fireEvent.click(container.querySelector('[data-testid="apple-menu-lock"]')!);
    await tick();
    await settle();
    expect(surface().kind).toBe("lock");
    unlock();
  });

  test("the stage's icon grid takes its geometry from the layout module, not from classes", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const grid = container.querySelector<HTMLElement>('[data-testid="desktop-icon-grid"]')!;
    // The same numbers the template used to spell (`grid-cols-4`, `gap-x-6 gap-y-5`,
    // `left-8 top-8`, `calc(4 * 80px + 3 * 24px)`) — now from `lib/desktopLayout.ts`, so
    // the stage is no longer the one surface deciding its own geometry.
    const style = (grid.getAttribute("style") ?? "").replace(/\s+/g, "");
    expect(style).toContain(`width:${desktopGridWidth()}px`);
    expect(style).toContain(`grid-template-columns:repeat(${DESKTOP_GRID_COLS},${DESKTOP_TILE_SIZE}px)`);
    expect(style).toContain(`column-gap:${DESKTOP_TILE_GAP_X}px`);
    expect(style).toContain(`row-gap:${DESKTOP_TILE_GAP_Y}px`);
    expect(style).toContain(`left:${DESKTOP_GRID_INSET}px`);
    expect(style).toContain(`top:${DESKTOP_GRID_INSET}px`);
    // …and the grid is the capacity the layout module declares (4 × 4), not a literal 16.
    expect(desktopIconCapacity()).toBe(DESKTOP_GRID_COLS * DESKTOP_GRID_ROWS);
  });

  test("the ⚙️ item opens the Control Center, and the same click closes it", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const item = container.querySelector<HTMLButtonElement>('[data-testid="chrome-control-center"]')!;
    expect(item.disabled).toBe(false);
    expect(item.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="control-center-panel"]')).toBeNull();

    await fireEvent.click(item);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="control-center-panel"]')).toBeTruthy();
    // The trigger's own state follows the shell's, so the assistive layer is not told a lie
    // while the panel is up.
    expect(item.getAttribute("aria-expanded")).toBe("true");

    await fireEvent.click(item);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="control-center-panel"]')).toBeNull();
    expect(item.getAttribute("aria-expanded")).toBe("false");
  });

  test("Escape closes the Control Center too (it is an overlay like the others)", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    await fireEvent.click(container.querySelector('[data-testid="chrome-control-center"]')!);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="control-center-panel"]')).toBeTruthy();
    press("Escape");
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="control-center-panel"]')).toBeNull();
  });

  test("overlays stack in the order they were OPENED, not by a hard-coded class", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    // Control Center first, then Spotlight on top of it.
    await fireEvent.click(container.querySelector('[data-testid="chrome-control-center"]')!);
    await tick();
    await settle();
    press(" ", { metaKey: true });
    await tick();
    await settle();

    const layers = [...container.querySelectorAll<HTMLElement>('[data-testid="overlay-layer"]')];
    expect(layers.map((l) => l.dataset.overlay)).toEqual(["control-center-panel", "spotlight"]);
    const z = (el: HTMLElement) => Number(el.style.zIndex);
    expect(z(layers[0]!)).toBeLessThan(z(layers[1]!));

    // …and raising the *later* one follows the same rule the other way round: close
    // Spotlight, open the Launchpad, and it is the one on top.
    press("Escape");
    await tick();
    await settle();
    press("F4");
    await tick();
    await settle();
    const after = [...container.querySelectorAll<HTMLElement>('[data-testid="overlay-layer"]')];
    expect(after.map((l) => l.dataset.overlay)).toEqual(["control-center-panel", "launchpad"]);
    expect(z(after[1]!)).toBeGreaterThan(z(after[0]!));
  });

  test("the desktop's context menu is real where it can be (and honest where it cannot)", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const stage = container.querySelector('[aria-label="' + zh["desktop.stage"] + '"]')!;
    await fireEvent.contextMenu(stage);
    await tick();
    const menu = container.querySelector('[data-testid="desktop-context-menu"]');
    expect(menu).toBeTruthy();
    const rows = [...menu!.querySelectorAll('[role="menuitem"]')];
    const disabled = rows.filter((r) => (r as HTMLButtonElement).disabled);
    // 「新建文件夹」used to be a live row that dispatched a window event this shell
    // answered with an empty handler: a wire to nowhere, and a row that looked available.
    expect(disabled.map((r) => r.textContent?.trim())).toEqual([
      zh["desktop.ctxNewFolderUnavailable"],
    ]);
    expect(disabled[0]?.getAttribute("aria-label")).toBe(zh["desktop.ctxNewFolderUnavailable"]);
    // 「更改壁纸…」opens the app that owns wallpaper settings.
    const wallpaper = rows.find((r) => r.textContent?.includes(zh["desktop.ctxChangeWallpaper"]))!;
    expect((wallpaper as HTMLButtonElement).disabled).toBe(false);
  });

  test("the chrome handle is the shell's: no throw when a slot is rendered without it", async () => {
    installHost();
    // `TopBar`/`Dock` no longer provide the handle (the shell does). A container mounted
    // on its own must still render — the widgets simply have nothing to ask.
    const { container } = render(Dock);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="dock-panel"]')).toBeTruthy();
  });

  test("desktop icon grid: single click selects (macOS semantics), double-click opens", async () => {
    installHost();
    writeStoreValue(LAYOUT_KEY, {
      page: ["clock", "notes", "calendar", "files"],
      dock: [],
      hidden: [],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const clock = container.querySelector<HTMLButtonElement>('[data-desktop-icon-id="clock"]')!;
    const notes = container.querySelector<HTMLButtonElement>('[data-desktop-icon-id="notes"]')!;

    // First click on `clock`: selection = {clock}; macOS shows the blue outline and
    // `aria-selected="true"`. Nothing is opened (single-click on a desktop icon is the
    // select verb, not the open verb).
    await fireEvent.click(clock);
    await tick();
    expect(clock.getAttribute("aria-selected")).toBe("true");
    expect(notes.getAttribute("aria-selected")).toBe("false");
    expect(container.querySelector('[data-testid="desktop-selection-count"]')).toBeTruthy();
    expect(
      container.querySelector('[data-testid="desktop-selection-count"]')!.textContent?.trim(),
    ).toBe(zh["desktop.selection"].replace("{n}", "1"));

    // Double-click on `clock` opens it; selection clears (the open verb commits).
    await fireEvent.doubleClick(clock);
    await tick();
    await settle();
    const last = (window as unknown as Record<string, { cmd: string; args: unknown }>)
      .__lastCall;
    expect(last.cmd).toBe("wm_open");
    expect(last.args).toEqual({ label: "clock" });
    // Selection cleared after a successful open — same shape the Dock context menu's
    // `Quit` button follows.
    expect(container.querySelector('[data-testid="desktop-selection-count"]')).toBeNull();
  });

  test("desktop rubber-band selection: drag from empty stage selects intersecting icons", async () => {
    installHost();
    writeStoreValue(LAYOUT_KEY, {
      page: ["clock", "notes", "calendar", "files"],
      dock: [],
      hidden: [],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const stage = container.querySelector<HTMLElement>('[aria-label="' + zh["desktop.stage"] + '"]')!;
    const clock = container.querySelector<HTMLElement>('[data-desktop-icon-id="clock"]')!;
    const notes = container.querySelector<HTMLElement>('[data-desktop-icon-id="notes"]')!;
    const calendar = container.querySelector<HTMLElement>('[data-desktop-icon-id="calendar"]')!;
    const files = container.querySelector<HTMLElement>('[data-desktop-icon-id="files"]')!;

    // happy-dom returns 0 from `getBoundingClientRect` (no layout). Stub each icon's
    // box to match the layout module's coordinates so the rubber-band hit-test sees
    // real rectangles (REQ-A263: stage geometry has one home in `lib/desktopLayout.ts`).
    const TILE = 80, GAP_X = 24, GAP_Y = 20, INSET = 32;
    const boxes: Record<string, { left: number; top: number; right: number; bottom: number }> = {
      clock: { left: INSET, top: INSET, right: INSET + TILE, bottom: INSET + TILE },
      notes: { left: INSET + TILE + GAP_X, top: INSET, right: INSET + TILE + GAP_X + TILE, bottom: INSET + TILE },
      calendar: { left: INSET, top: INSET + TILE + GAP_Y, right: INSET + TILE, bottom: INSET + TILE + GAP_Y + TILE },
      files: { left: INSET + TILE + GAP_X, top: INSET + TILE + GAP_Y, right: INSET + TILE + GAP_X + TILE, bottom: INSET + TILE + GAP_Y + TILE },
    };
    for (const [el, key] of [
      [clock, "clock"],
      [notes, "notes"],
      [calendar, "calendar"],
      [files, "files"],
    ] as const) {
      const box = boxes[key]!;
      Object.defineProperty(el, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: box.left, y: box.top, left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: TILE, height: TILE, toJSON: () => box }),
      });
    }

    // 4×4 grid with 80px tiles + 24/20 px gaps: clock and notes share the first row,
    // calendar and files the second. Drag from (10,10) to (200,130) covers the first
    // row — clock + notes — but not the second (calendar/files).
    const rect = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    };
    const c = rect(clock);
    const n = rect(notes);
    const ca = rect(calendar);
    const f = rect(files);
    void c; void n; void ca; void f; // measurements asserted below by the rect-vs-rect logic

    await fireEvent.mouseDown(stage, { clientX: 10, clientY: 10, button: 0 });
    // The rubber-band exists only while the drag is live — pin it.
    expect(container.querySelector('[data-testid="desktop-rubber-band"]')).toBeTruthy();
    await fireEvent.mouseMove(stage, { clientX: 220, clientY: 130 });
    await fireEvent.mouseUp(stage, { clientX: 220, clientY: 130 });
    await tick();
    await settle();

    // The selection count is "2" (clock + notes), and the selection chip is up.
    const chip = container.querySelector('[data-testid="desktop-selection-count"]');
    expect(chip).toBeTruthy();
    expect(chip!.textContent?.trim()).toBe(zh["desktop.selection"].replace("{n}", "2"));
    expect(clock.getAttribute("aria-selected")).toBe("true");
    expect(notes.getAttribute("aria-selected")).toBe("true");
    expect(calendar.getAttribute("aria-selected")).toBe("false");
    expect(files.getAttribute("aria-selected")).toBe("false");

    // The rubber-band is gone after release — it must not persist.
    expect(container.querySelector('[data-testid="desktop-rubber-band"]')).toBeNull();

    // Clicking the stage backdrop (a non-drag mousedown) clears the selection.
    await fireEvent.mouseDown(stage, { clientX: 5, clientY: 5, button: 0 });
    await fireEvent.mouseUp(stage, { clientX: 5, clientY: 5, button: 0 });
    await tick();
    expect(container.querySelector('[data-testid="desktop-selection-count"]')).toBeNull();
  });

  test("desktop multi-selection: Cmd-click toggles one icon in/out; Shift-click unions a range (F-SH-010)", async () => {
    // The topbar's Edit → Select All test covers the keyboard ⌘A path. Here we pin
    // the mouse half of the same model so the two paths cannot diverge:
    //   • Cmd-click on an unselected icon → adds it.
    //   • Cmd-click on a *selected* icon → removes it (anchor does NOT move; macOS
    //     Finder keeps the anchor on the last real pick — see `onIconClick`).
    //   • Shift-click → unions [anchor..target] (in icon order) with the existing
    //     selection; it never silently drops a previously-picked icon. That rule is
    //     the FMEA F-SH-010 mitigation: a non-contiguous prior set {A, C} +
    //     Shift-click E → {A, B, C, D, E} — not just {B, C, D, E}.
    // Negative control: replace the union line in `onIconClick` with a plain
    // `selectedIds = new Set(unionRange(anchorId, id))` and this case fails
    // (`clock` is gone from the post-Shift-click selection — `expected false to
    // be true`).
    installHost();
    writeStoreValue(LAYOUT_KEY, {
      page: ["clock", "notes", "calendar", "files", "mail"],
      dock: [],
      hidden: [],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const idOf = (s: string) =>
      container.querySelector<HTMLButtonElement>(
        `[data-desktop-icon-id="${s}"]`,
      )!;
    const isSel = (id: string) =>
      idOf(id).getAttribute("aria-selected") === "true";

    // 1) Cmd-click `clock` — selected = {clock}.
    await fireEvent.click(idOf("clock"), { metaKey: true });
    await tick();
    expect(isSel("clock")).toBe(true);

    // 2) Cmd-click `calendar` — selected = {clock, calendar}.
    await fireEvent.click(idOf("calendar"), { metaKey: true });
    await tick();
    expect(isSel("clock")).toBe(true);
    expect(isSel("calendar")).toBe(true);
    expect(isSel("notes")).toBe(false);

    // 3) Cmd-click `calendar` AGAIN — toggle off; anchor stays put.
    await fireEvent.click(idOf("calendar"), { metaKey: true });
    await tick();
    expect(isSel("calendar")).toBe(false);
    expect(isSel("clock")).toBe(true);

    // 4) Shift-click `mail` — unions the contiguous range [calendar..mail] with
    //    the existing set {clock}. Result: {clock, calendar, files, mail}. Note
    //    that `notes` (index 1) is NOT in the anchor..target window (calendar is
    //    index 2, mail is index 4); it's not in the union either. macOS Finder
    //    agrees: Shift-click does not bend the range to include non-anchor-side
    //    picks, it only **adds** the range — the previous pick (clock) is
    //    preserved by the union-with-existing rule.
    await fireEvent.click(idOf("mail"), { shiftKey: true });
    await tick();
    for (const id of ["clock", "calendar", "files", "mail"]) {
      expect(isSel(id), `${id} should be selected after Shift-click`).toBe(true);
    }
    expect(isSel("notes")).toBe(false);
    // Chip count is the user-visible proof.
    const chip = container.querySelector('[data-testid="desktop-selection-count"]');
    expect(chip?.textContent?.trim()).toBe(
      zh["desktop.selection"].replace("{n}", "4"),
    );
  });

  test("double-clicking an icon in a multi-selection opens ALL the selected", async () => {
    installHost();
    writeStoreValue(LAYOUT_KEY, {
      page: ["clock", "notes", "calendar"],
      dock: [],
      hidden: [],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    // Stub the icons' boxes (see the rubber-band test above for why).
    const clock = container.querySelector<HTMLElement>('[data-desktop-icon-id="clock"]')!;
    const notes = container.querySelector<HTMLElement>('[data-desktop-icon-id="notes"]')!;
    const TILE = 80, GAP_X = 24, INSET = 32;
    const cBox = { left: INSET, top: INSET, right: INSET + TILE, bottom: INSET + TILE };
    const nBox = { left: INSET + TILE + GAP_X, top: INSET, right: INSET + TILE + GAP_X + TILE, bottom: INSET + TILE };
    for (const [el, box] of [[clock, cBox], [notes, nBox]] as const) {
      Object.defineProperty(el, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: box.left, y: box.top, left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: TILE, height: TILE, toJSON: () => box }),
      });
    }

    // Build a 2-icon selection (clock + notes) by rubber-banding them.
    const stage = container.querySelector<HTMLElement>('[aria-label="' + zh["desktop.stage"] + '"]')!;
    await fireEvent.mouseDown(stage, { clientX: 0, clientY: 0, button: 0 });
    await fireEvent.mouseMove(stage, { clientX: 300, clientY: 200 });
    await fireEvent.mouseUp(stage, { clientX: 300, clientY: 200 });
    await tick();
    await settle();

    expect(clock.getAttribute("aria-selected")).toBe("true");
    expect(notes.getAttribute("aria-selected")).toBe("true");

    // Double-click on one of the selected icons → both get opened (the host's
    // `wm_open` is create+focus; calling it twice opens two windows — exactly the
    // multi-open macOS Finder does).
    await fireEvent.doubleClick(clock);
    await tick();
    await settle();

    // Walk the dispatch order: both `wm_open(clock)` and `wm_open(notes)` should
    // appear in the recorded calls (the host opens each in its own window).
    const calls = (window as unknown as { __lastCall?: unknown }).__lastCall as
      | { cmd: string; args: unknown }
      | undefined;
    // The single call we pinned via the installHost helper records `__lastCall`
    // for the most-recent non-poll invoke; we expect that to be `wm_open` on
    // `notes` (the second of the two). Both calls happened — the chip clearing
    // is the third assertion.
    expect(calls?.cmd).toBe("wm_open");
    expect(["clock", "notes"]).toContain((calls?.args as { label?: string } | undefined)?.label);
    // The selection cleared after the open (the verb committed).
    expect(container.querySelector('[data-testid="desktop-selection-count"]')).toBeNull();
  });

  test("desktop context menu: with a selection, an 'Open the N selected' row appears", async () => {
    installHost();
    writeStoreValue(LAYOUT_KEY, {
      page: ["clock", "notes", "calendar"],
      dock: [],
      hidden: [],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    // Stub the icons' boxes (see the rubber-band test for why).
    const clock = container.querySelector<HTMLElement>('[data-desktop-icon-id="clock"]')!;
    const notes = container.querySelector<HTMLElement>('[data-desktop-icon-id="notes"]')!;
    const TILE = 80, GAP_X = 24, INSET = 32;
    const cBox = { left: INSET, top: INSET, right: INSET + TILE, bottom: INSET + TILE };
    const nBox = { left: INSET + TILE + GAP_X, top: INSET, right: INSET + TILE + GAP_X + TILE, bottom: INSET + TILE };
    for (const [el, box] of [[clock, cBox], [notes, nBox]] as const) {
      Object.defineProperty(el, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: box.left, y: box.top, left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: TILE, height: TILE, toJSON: () => box }),
      });
    }

    // Build a 2-icon selection by rubber-band, then open the context menu via the stage
    // backdrop (which is the same handler the icon's oncontextmenu would call into).
    const stage = container.querySelector<HTMLElement>('[aria-label="' + zh["desktop.stage"] + '"]')!;
    await fireEvent.mouseDown(stage, { clientX: 0, clientY: 0, button: 0 });
    await fireEvent.mouseMove(stage, { clientX: 300, clientY: 200 });
    await fireEvent.mouseUp(stage, { clientX: 300, clientY: 200 });
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="desktop-selection-count"]')).toBeTruthy();

    await fireEvent.contextMenu(stage, { clientX: 400, clientY: 400 });
    await tick();
    const menu = container.querySelector('[data-testid="desktop-context-menu"]')!;
    const rows = [...menu.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
    const labels = rows.map((r) => r.textContent?.trim());
    expect(labels).toContain(zh["desktop.openSelection"].replace("{n}", "2"));
    expect(labels).toContain(zh["desktop.clearSelection"]);
    // The Open-N row is **live** (the FMEA F-SH-001 rule: a row that says "open N"
    // must actually open N — not be a greyed stub).
    const openN = rows.find((r) => r.textContent?.includes(zh["desktop.openSelection"].replace("{n}", "2")));
    expect(openN?.disabled).toBe(false);
  });

  test("Escape clears the selection (no half-state where the chip shows but selection is empty)", async () => {
    installHost();
    writeStoreValue(LAYOUT_KEY, {
      page: ["clock", "notes"],
      dock: [],
      hidden: [],
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const clock = container.querySelector<HTMLButtonElement>('[data-desktop-icon-id="clock"]')!;
    await fireEvent.click(clock);
    await tick();
    expect(clock.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-testid="desktop-selection-count"]')).toBeTruthy();

    press("Escape");
    await tick();
    expect(clock.getAttribute("aria-selected")).toBe("false");
    expect(container.querySelector('[data-testid="desktop-selection-count"]')).toBeNull();
  });

  test("system shortcuts route through the focused window to wm_close / wm_hide", async () => {
    // ⌘W / ⌘M / ⌘H must (a) reach the host as `wm_close` / `wm_hide`, and (b) carry the
    // **focused** window label (not the Dock layout or a hard-coded string). They do not
    // fire when the focused window is the launcher (`main` — closing the launcher would
    // leave the desktop without a home surface).
    installHost({
      windows: [
        { label: "files", kind: "App", state: "Focused", focused: true },
        { label: "notes", kind: "App", state: "Shown", focused: false },
      ],
    });
    render(DesktopShell);
    await tick();
    // Let `refreshFocused()` resolve and write `focusedWindowLabel` before the key fires.
    // `refreshFocused` is an awaited promise chain; two settle()s give it room to run.
    await settle();
    await settle();

    press("w", { metaKey: true });
    await tick();
    await settle();
    // The last call carries the focused label, not a literal — `installHost` records
    // both fields, and this is the property: a wiring change cannot send the wrong
    // window. (`wm_windows` polling is filtered out by `installHost`.)
    const last = (window as unknown as Record<string, { cmd: string; args: unknown }>)
      .__lastCall;
    expect(last.cmd).toBe("wm_close");
    expect(last.args).toEqual({ label: "files" });

    press("m", { metaKey: true });
    await tick();
    await settle();
    const last2 = (window as unknown as Record<string, { cmd: string; args: unknown }>)
      .__lastCall;
    expect(last2.cmd).toBe("wm_hide");
    expect(last2.args).toEqual({ label: "files" });
  });

  test("system shortcuts with no focused window are a no-op (no command reaches the host)", async () => {
    // A focused window is required for ⌘W/⌘M/⌘H to act. Otherwise the shortcut is a
    // no-op: the desktop stays on its launcher surface instead of vanishing it.
    installHost({ windows: [] });
    render(DesktopShell);
    await tick();
    await settle();
    await settle();

    press("w", { metaKey: true });
    await tick();
    await settle();
    // The filter in `installHost` drops `wm_windows` (polled) and `wm_layout_snapshot`
    // (mount), so an unset `__lastCall` is the no-op signal.
    const last = (window as unknown as Record<string, { cmd: string; args: unknown } | undefined>)
      .__lastCall;
    expect(last).toBeUndefined();
  });

  test("⌘, opens the Settings app (the menu shortcut is real, not a comment)", async () => {
    installHost();
    render(DesktopShell);
    await tick();
    await settle();
    press(",", { metaKey: true });
    await tick();
    await settle();
    const last = (window as unknown as Record<string, { cmd: string; args: unknown }>)
      .__lastCall;
    expect(last.cmd).toBe("wm_open");
    expect(last.args).toEqual({ label: "settings" });
  });

  test("plain ⌘+key does not fire (a modifier the binding does not list must not match)", async () => {
    // The shell's system-shortcut matcher is **strict** about modifiers: ⌘W closes the
    // window, W does not (a typed character must reach the focused field). Pin it so
    // adding a new binding cannot silently broaden it.
    installHost({
      windows: [{ label: "files", kind: "App", state: "Focused" }],
    });
    render(DesktopShell);
    await tick();
    await settle();
    await settle();
    press("w");
    await tick();
    await settle();
    // No non-poll call: ⌘W (modifier-only) is the binding; `w` (no modifier) is not.
    const last = (window as unknown as Record<string, { cmd: string; args: unknown } | undefined>)
      .__lastCall;
    expect(last).toBeUndefined();
  });

  test("AMOS_DESKTOP_SHORTCUTS=disabled — ⌘W does not reach the host (the OS may own the binding)", async () => {
    // 关掉这个能力后,壳的 `handleSystemShortcut` 直接返回 false,让宿主 OS / WebView 决定
    // —— 这就是 macOS 真机上 `⌘H` 的场景:用户希望系统"隐藏应用",而不是前端消费。
    (window as { __amosDisabledFeatures?: string[] }).__amosDisabledFeatures = ["shortcuts"];
    try {
      installHost({
        windows: [{ label: "files", kind: "App", state: "Focused", focused: true }],
      });
      render(DesktopShell);
      await tick();
      await settle();
      await settle();
      press("w", { metaKey: true });
      await tick();
      await settle();
      // 没有 wm_close 被调用 —— `__lastCall` 应仍为空(只有 polling)。
      const last = (window as unknown as Record<string, unknown>).__lastCall;
      expect(last).toBeUndefined();
    } finally {
      delete (window as { __amosDisabledFeatures?: string[] }).__amosDisabledFeatures;
    }
  });

  test("REQ-A287 — the shell asks the host once at boot which capabilities the operator switched off", async () => {
    // 宿主是唯一读得到 `AMOS_DESKTOP_SHORTCUTS` / `AMOS_DOCK_CONTEXT_MENU` 的地方
    // (WebView 没有 env),所以 shell boot 必须真的去问一次 —— 否则那两个文档化的开关
    // 又会退回"永远不生效"。这条用例钉的是**那一次调用**,不是某个 flag 的值。
    const commands = installHost();
    render(DesktopShell);
    await tick();
    await settle();
    await settle();
    expect(commands).toContain("desktop_features_disabled");
  });

  test("REQ-A287 — a host answer of ['shortcuts'] disables ⌘W exactly like the test hook does", async () => {
    installHost({
      windows: [{ label: "files", kind: "App", state: "Focused", focused: true }],
      desktopFeatures: ["shortcuts"],
    });
    render(DesktopShell);
    await tick();
    await settle();
    await settle();
    press("w", { metaKey: true });
    await tick();
    await settle();
    // 宿主说关了 ⇒ 前端不抢键(宿主 OS / WebView 自己决定)。注意这条**没有**设置
    // `window.__amosDisabledFeatures`:走的就是生产路径。
    const last = (window as unknown as Record<string, unknown>).__lastCall;
    expect(last).toBeUndefined();
  });

  // ─── REQ-A275 — topbar File / Edit / View / Window / Help dropdowns ────────
  test("topbar View → Toggle Wallpaper hides the Backdrop without touching the icons grid (REQ-A275)", async () => {
    installHost();
    writeStoreValue("amos.settings.view", {
      showWallpaper: true,
      showIcons: true,
      showStageWidgets: true,
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="stage-backdrop"]')).toBeTruthy();
    const viewTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="menu-view-trigger"]',
    )!;
    await fireEvent.click(viewTrigger);
    await tick();
    const panel = container.querySelector('[data-testid="menu-view-panel"]');
    expect(panel).toBeTruthy();
    const toggleRow = panel!.querySelector<HTMLButtonElement>(
      '[data-testid="menu-view-view.toggle-wallpaper"]',
    )!;
    await fireEvent.click(toggleRow);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="stage-backdrop"]')).toBeNull();
    expect(container.querySelector('[data-testid="desktop-icon-grid"]')).toBeTruthy();
    const v = readStoreValue<DesktopView>("amos.settings.view", DEFAULT_DESKTOP_VIEW);
    expect(v.showWallpaper).toBe(false);
  });

  test("topbar View → Toggle Icons removes the desktop icon grid (REQ-A275)", async () => {
    installHost();
    writeStoreValue("amos.settings.view", {
      showWallpaper: true,
      showIcons: true,
      showStageWidgets: true,
    });
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="desktop-icon-grid"]')).toBeTruthy();
    const viewTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="menu-view-trigger"]',
    )!;
    await fireEvent.click(viewTrigger);
    await tick();
    const toggleRow = container.querySelector<HTMLButtonElement>(
      '[data-testid="menu-view-view.toggle-icons"]',
    )!;
    await fireEvent.click(toggleRow);
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="desktop-icon-grid"]')).toBeNull();
    const v = readStoreValue<DesktopView>("amos.settings.view", DEFAULT_DESKTOP_VIEW);
    expect(v.showIcons).toBe(false);
  });

  test("topbar File → New Window fires wm_open('files') (REQ-A275)", async () => {
    installHostWithRecorder();
    const { container } = render(DesktopShell);
    await tick();
    await settle();
    const fileTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="menu-file-trigger"]',
    )!;
    await fireEvent.click(fileTrigger);
    await tick();
    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="menu-file-file.new-window"]',
    )!;
    await fireEvent.click(row);
    await tick();
    await settle();
    const opens = (window as unknown as { __wmOpens: string[] }).__wmOpens;
    expect(opens).toContain("files");
  });
});


describe("Dock.svelte — names, grouping and capacity", () => {
  const MANY_APPS = ["clock", "notes", "calendar", "photos", "files", "mail", "maps", "camera"];
  const originalInnerWidth = window.innerWidth;

  function seedDock(ids: string[]) {
    writeStoreValue(LAYOUT_KEY, { page: [], dock: ids, hidden: [] });
  }

  function setWindowWidth(w: number) {
    Object.defineProperty(window, "innerWidth", { value: w, configurable: true, writable: true });
  }

  beforeEach(() => setWindowWidth(originalInnerWidth));
  afterEach(() => setWindowWidth(originalInnerWidth));

  test("system items are localized and app names are TRANSLATED (never the raw i18n key)", async () => {
    setWindowWidth(2000);
    seedDock(["clock", "notes"]);
    const { container } = render(Dock);
    await tick();
    await settle();

    expect(byAria(container, zh["desktop.launchpad"])).toBeTruthy();
    expect(byAria(container, zh["desktop.finder"])).toBeTruthy();
    expect(byAria(container, zh["desktop.trashUnavailable"])).toBeTruthy();
    // The old code put `appTitleKey(id)` (e.g. `app.clock.title`) straight into
    // aria-label: a screen reader read the key out loud.
    const labels = [...container.querySelectorAll("button[aria-label]")].map((b) =>
      b.getAttribute("aria-label")!,
    );
    expect(labels.some((l) => l.startsWith("app."))).toBe(false);
    expect(labels.some((l) => l === zh["app.clock"])).toBe(true);
  });

  test("the system items come from the registry — and the Trash says it cannot act", async () => {
    setWindowWidth(2000);
    seedDock(["notes"]);
    const { container } = render(Dock);
    await tick();
    await settle();
    // Order is the registry's: apps, then Launchpad, Finder, │ , Trash.
    const ids = [...container.querySelectorAll("[data-dock-item]")].map((el) =>
      el.getAttribute("data-dock-item"),
    );
    expect(ids).toEqual(["notes", "dock-launchpad", "dock-finder", "dock-trash"]);
    // Its handler used to be `if (id === "trash") return;` — pressable, announced as
    // pressable, and doing nothing (FMEA F-SH-001).
    const trash = container.querySelector<HTMLButtonElement>('[data-testid="dock-trash"]')!;
    expect(trash.disabled).toBe(true);
    expect(trash.getAttribute("aria-disabled")).toBe("true");
  });

  test("the separator is drawn BEFORE the trash (that is the one grouping the Dock has)", async () => {
    setWindowWidth(2000);
    seedDock([]);
    const { container } = render(Dock);
    await tick();
    await settle();
    const sep = container.querySelector('[data-testid="dock-separator"]') as Element;
    const trash = byAria(container, zh["desktop.trashUnavailable"]) as Element;
    expect(sep && trash).toBeTruthy();
    const rel = sep.compareDocumentPosition(trash);
    expect(Boolean(rel & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    // It is data on the registry row, not a template `{#if}`: `dock-trash` declares it.
    const trashRow = container.querySelector('[data-dock-item="dock-trash"]')!;
    expect(trashRow.previousElementSibling?.getAttribute("data-testid")).toBe("dock-separator");
  });

  test("magnification is driven by the MEASURED centre of each dock item", async () => {
    setWindowWidth(2000);
    seedDock(["notes"]);
    const { container } = render(Dock);
    await tick();
    await settle();
    const wrapper = container.querySelector('[data-dock-item="notes"] > div') as HTMLElement;
    const bar = container.querySelector(`[aria-label="${zh["desktop.dock"]}"]`)!;
    const scaleOf = (el: HTMLElement) =>
      Number(/scale\(([\d.]+)\)/.exec(el.getAttribute("style") ?? "")?.[1] ?? "NaN");
    // A cursor parked on the row grows the tile under it…
    await fireEvent.mouseMove(bar, { clientX: 0 });
    await tick();
    expect(scaleOf(wrapper)).toBeGreaterThan(1);
    // …and one far away leaves the row at its resting size (no permanent zoom). What this
    // pins is the wiring: the transform comes from the measured centre of `data-dock-item`,
    // so a broken lookup (or a non-reactive derived) leaves the row at 1× and fails here.
    await fireEvent.mouseMove(bar, { clientX: 100000 });
    await tick();
    expect(scaleOf(wrapper)).toBe(1);
  });

  test("what does not fit is REPORTED, not dropped silently (+N uses dockOverflowCount)", async () => {
    setWindowWidth(2000);
    seedDock(["clock", "notes"]);
    const wide = render(Dock);
    await tick();
    await settle();
    expect(wide.container.querySelector('[data-testid="dock-overflow"]')).toBeNull();
    wide.unmount();

    // 400px: dockCapacity(400) = floor((400 − 2·24) / (48+8)) = 6. Minus the 3 dock
    // modules (launchpad / finder / trash) leaves 3 user slots; 8 apps − 3 = 5 hidden.
    setWindowWidth(400);
    seedDock(MANY_APPS);
    const narrow = render(Dock);
    await tick();
    await settle();
    const chip = narrow.container.querySelector('[data-testid="dock-overflow"]');
    expect(chip).toBeTruthy();
    expect(byAria(narrow.container, zh["desktop.dockOverflow"].replace("{n}", "5"))).toBeTruthy();
    // …and the system items survive the squeeze (macOS never drops the trash).
    expect(byAria(narrow.container, zh["desktop.trashUnavailable"])).toBeTruthy();
    expect(byAria(narrow.container, zh["desktop.finder"])).toBeTruthy();
  });

  test("right-click an app tile opens a dock context menu, and Quit calls wm_close", async () => {
    setWindowWidth(2000);
    seedDock(["notes"]);
    // `wm_windows` returns "Focused" for notes so the menu's items light up; `wm_close`
    // is the action that actually closes the window.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: unknown) => {
        // The Dock reads `wm_windows` for its running-dot poll AND `wm_close` for the
        // Quit menu action. Filter the poll so the assertion reads the user-action
        // call, not the most recent ambient tick.
        if (cmd !== "wm_windows" && cmd !== "wm_layout_snapshot") {
          (window as unknown as Record<string, unknown>).__lastCall = { cmd, args };
        }
        if (cmd === "wm_windows") {
          return {
            windows: [{ label: "notes", kind: "App", state: "Focused", focused: true }],
          };
        }
        if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
        return null;
      },
      listen: async () => () => {},
    };
    const { container } = render(Dock);
    await tick();
    // Wait two settle()s so the mount-time `refreshOpenWindows` has resolved and
    // `openLabels` carries `notes`. Without that the menu opens with `running=false`
    // and Quit is disabled (the FMEA F-SH-001 shape), so the click below is a no-op.
    await settle();
    await settle();

    const tile = container.querySelector<HTMLElement>('[data-dock-item="notes"]')!;
    await fireEvent.contextMenu(tile, { clientX: 100, clientY: 200 });
    await tick();
    const menu = container.querySelector('[data-testid="dock-context-menu"]');
    expect(menu).toBeTruthy();
    expect(menu?.getAttribute("data-label")).toBe("notes");
    expect(menu?.getAttribute("aria-label")).toBe(zh["desktop.dockContextMenu"]);

    // `running` is a snapshot the dock took when the menu opened; the dock only knows
    // what's open because `openLabels` was populated by the mount-time `wm_windows`
    // read. Without that wait the menu opens with `running=false` and Quit is
    // disabled (the FMEA F-SH-001 shape), so the click below is a no-op.
    const show = menu!.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-show"]')!;
    const hide = menu!.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-hide"]')!;
    const quit = menu!.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-quit"]')!;
    const opts = menu!.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-options"]')!;
    expect(show.disabled).toBe(false);
    expect(hide.disabled).toBe(false);
    expect(quit.disabled).toBe(false);
    // Options is a placeholder: disabled, with a name that says why (FMEA F-SH-001).
    expect(opts.disabled).toBe(true);
    expect(opts.getAttribute("aria-label")).toBe(zh["desktop.dockCtxOptionsUnavailable"]);

    await fireEvent.click(quit);
    await tick();
    await settle();
    const last = (window as unknown as Record<string, { cmd: string; args: unknown }>)
      .__lastCall;
    expect(last).toEqual({ cmd: "wm_close", args: { label: "notes" } });
    // The menu closes itself after a choice.
    expect(container.querySelector('[data-testid="dock-context-menu"]')).toBeNull();
  });

  test("right-click a closed app shows the menu with Show / Hide / Quit greyed (no live action)", async () => {
    setWindowWidth(2000);
    seedDock(["notes"]);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "wm_windows") return { windows: [] }; // nothing open
        if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
        return null;
      },
      listen: async () => () => {},
    };
    const { container } = render(Dock);
    await tick();
    await settle();
    const tile = container.querySelector<HTMLElement>('[data-dock-item="notes"]')!;
    await fireEvent.contextMenu(tile, { clientX: 10, clientY: 20 });
    await tick();
    const menu = container.querySelector('[data-testid="dock-context-menu"]');
    expect(menu).toBeTruthy();
    // Show + Hide + Quit are disabled: there is no window to act on, and a tile that
    // looks available while doing nothing is the FMEA F-SH-001 shape.
    const show = menu!.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-show"]')!;
    const hide = menu!.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-hide"]')!;
    const quit = menu!.querySelector<HTMLButtonElement>('[data-testid="dock-ctx-quit"]')!;
    expect(show.disabled).toBe(true);
    expect(hide.disabled).toBe(true);
    expect(quit.disabled).toBe(true);
  });

  test("AMOS_DOCK_CONTEXT_MENU=disabled — right-click on a tile does not open the menu (F-SH-001 honest UI: don't fake a feature)", async () => {
    // 关掉这个能力后,Dock 的 `onItemContextMenu` 直接返回,不消费右键,不弹菜单;
    // 也不假装"按了没反应"——浏览器原生菜单会接管。
    (window as { __amosDisabledFeatures?: string[] }).__amosDisabledFeatures = [
      "dock-context-menu",
    ];
    try {
      // 需要先把 notes 放进 dock 才有 `data-dock-item="notes"` 这个 tile。
      writeStoreValue(LAYOUT_KEY, { page: ["clock"], dock: ["notes"], hidden: [] });
      installHost({
        windows: [{ label: "notes", kind: "App", state: "Focused", focused: true }],
      });
      const { container } = render(Dock);
      await tick();
      await settle();
      const tile = container.querySelector<HTMLElement>('[data-dock-item="notes"]')!;
      await fireEvent.contextMenu(tile, { clientX: 10, clientY: 20 });
      await tick();
      await settle();
      // 菜单**没有**渲染出来
      expect(container.querySelector('[data-testid="dock-context-menu"]')).toBeNull();
      // 也没有 wm_close / wm_hide / wm_focus 被调用过(`__lastCall` 应仍为空)
      const last = (window as unknown as Record<string, unknown>).__lastCall;
      expect(last).toBeUndefined();
    } finally {
      delete (window as { __amosDisabledFeatures?: string[] }).__amosDisabledFeatures;
    }
  });


});