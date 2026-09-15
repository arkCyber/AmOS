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
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopShell from "../src/svelte/DesktopShell.svelte";
import Dock from "../src/svelte/Dock.svelte";
import { LAYOUT_KEY, writeStoreValue } from "../src/lib/amosStore";
import { DOCK_MIN_WIDTH, SPOTLIGHT_HEIGHT, SPOTLIGHT_WIDTH } from "../src/lib/desktopLayout";
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

/** A fake host: `invoke` answers the two wm commands the desktop shell uses. */
function installHost({ windows = [] as unknown[], commands = [] as string[] } = {}) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      commands.push(cmd);
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      if (cmd === "wm_windows") return { windows };
      return null;
    },
    listen: async () => () => {},
  };
  return commands;
}

function press(key: string, mods: { metaKey?: boolean } = {}) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ...mods }));
}

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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
    expect(added.length).toBeGreaterThanOrEqual(3); // keydown + the two shell events
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
    expect(byAria(container, zh["desktop.trash"])).toBeTruthy();
    // The old code put `appTitleKey(id)` (e.g. `app.clock.title`) straight into
    // aria-label: a screen reader read the key out loud.
    const labels = [...container.querySelectorAll("button[aria-label]")].map((b) =>
      b.getAttribute("aria-label")!,
    );
    expect(labels.some((l) => l.startsWith("app."))).toBe(false);
    expect(labels.some((l) => l === zh["app.clock"])).toBe(true);
  });

  test("the separator is drawn BEFORE the trash (that is the one grouping the Dock has)", async () => {
    setWindowWidth(2000);
    seedDock([]);
    const { container } = render(Dock);
    await tick();
    await settle();
    const sep = container.querySelector('[data-testid="dock-separator"]') as Element;
    const trash = byAria(container, zh["desktop.trash"]) as Element;
    expect(sep && trash).toBeTruthy();
    const rel = sep.compareDocumentPosition(trash);
    expect(Boolean(rel & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  test("what does not fit is REPORTED, not dropped silently (+N uses dockOverflowCount)", async () => {
    setWindowWidth(2000);
    seedDock(["clock", "notes"]);
    const wide = render(Dock);
    await tick();
    await settle();
    expect(wide.container.querySelector('[data-testid="dock-overflow"]')).toBeNull();
    wide.unmount();

    // 400px: capacity 5 (4 user slots after the 3 system items) → 8 - 2 = 6 hidden.
    setWindowWidth(400);
    seedDock(MANY_APPS);
    const narrow = render(Dock);
    await tick();
    await settle();
    const chip = narrow.container.querySelector('[data-testid="dock-overflow"]');
    expect(chip).toBeTruthy();
    expect(byAria(narrow.container, zh["desktop.dockOverflow"].replace("{n}", "6"))).toBeTruthy();
    // …and the system items survive the squeeze (macOS never drops the trash).
    expect(byAria(narrow.container, zh["desktop.trash"])).toBeTruthy();
    expect(byAria(narrow.container, zh["desktop.finder"])).toBeTruthy();
  });
});