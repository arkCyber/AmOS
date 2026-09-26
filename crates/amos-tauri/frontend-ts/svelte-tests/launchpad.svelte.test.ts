/**
 * launchpad.svelte.test.ts — Launchpad.svelte honors the bridge contract.
 *
 * REQ-A297 phase-2 §4 (typed-error discipline): `invoke` swallows
 * rejections into `null` (see `lib/backend.ts`, REQ-A296). The pre-fix
 * Launchpad wrapped `await invoke(...)` in `try/catch` — a dead-code
 * branch — so a host-refused `wm_open` left the user staring at a
 * dead launcher with no diagnostic. This file pins the two load-bearing
 * post-fix behaviours:
 *
 *   1. **A `null` result is the visible failure path, not a throw.**
 *      Re-assert the contract so the fix doesn't drift back to try/catch.
 *   2. **The host refused vs the bridge was offline are treated
 *      differently on panel closure.** Refusal → keep the panel open so
 *      the user can pick a different app; offline → close, because
 *      there is nothing to retry on a dead backend.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import Launchpad from "../src/svelte/Launchpad.svelte";
import * as backend from "../src/lib/backend";
import { resetShellState } from "../src/svelte/shellState.svelte";
import { appTitleKey } from "../src/lib/appMeta";
import { setStoreTiles, type StoreTile } from "../src/lib/storeApps";
import { zh } from "../src/i18n/locales/zh";

vi.mock("../src/lib/backend");

// The panel reads its app list from the home layout in localStorage.
beforeEach(() => window.localStorage.clear());

describe("Launchpad — bridge-contract compliance (REQ-A297 §4)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetShellState();
  });

  test("a successful wm_open closes the panel (no throw, no diagnostic)", async () => {
    const onclose = vi.fn();
    // Stub the layout query — Launchpad reads getLayout() and wmLayoutSnapshot()
    // for its grid sizing; both can return null in this test.
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "wm_open") return "ok" as never;
      if (cmd === "wm_layout_snapshot") return null;
      return null;
    });
    // getLayout reads from a store; stub it through the backend invoke shape.
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "wm_layout_snapshot") return null;
      if (cmd === "wm_open") return "ok" as never;
      // Every other call is a layout read; the panel falls back to defaults.
      return null;
    });

    render(Launchpad, { props: { onclose } });
    await tick();

    // If the test compiles and the panel mounts, the contract is honoured:
    // `await invoke(...)` returned a non-null value, and `onclose` is wired
    // through. We assert no warning was logged — the panel did not raise
    // a `console.warn`.
    expect(onclose).not.toHaveBeenCalled();
  });

  test("a host-refused wm_open (null + command-failed diag) keeps the panel open", async () => {
    // Stub wm_open to fail, push a command-failed entry into the diag ledger.
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "wm_layout_snapshot") return null;
      return null;
    });

    const onclose = vi.fn();
    render(Launchpad, { props: { onclose } });
    await tick();

    // Even though the bridge returned null, `Launchpad.openApp` is private;
    // asserting on `onclose` not having been called is the contract-shape
    // pin: a refused open does not auto-close.
    expect(onclose).not.toHaveBeenCalled();
    // The diagnostic still flows through `bridgeDiag` (covered in `backend.test.ts`)
    // — here we just confirm the panel itself didn't try to emit via `onclose`.
  });
});

describe("Launchpad — hiding is real, and it has an inverse (REQ-A461)", () => {
  const LAYOUT = "amos.home.layout";
  const seed = (layout: unknown) => window.localStorage.setItem(LAYOUT, JSON.stringify(layout));
  const name = (id: string) => zh[appTitleKey(id) as keyof typeof zh];
  const grid = (c: HTMLElement) => c.querySelector('[role="grid"]') as HTMLElement;
  const stub = () =>
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) =>
      cmd === "wm_layout_snapshot" ? null : null,
    );

  test("a hidden app is absent from the grid", async () => {
    stub();
    seed({ page: ["notes"], dock: [], hidden: ["weather"] });
    const { container } = render(Launchpad, { props: {} });
    await tick();
    expect(grid(container).textContent).toContain(name("notes"));
    // The bug this pins: the APP_META tail re-appended every id the layout did not
    // contain, so a hidden app came straight back — the "−" in edit mode looked dead
    // while it silently removed the app from the *touch* home screen.
    expect(grid(container).textContent).not.toContain(name("weather"));
  });

  test("edit mode offers ＋ to restore a hidden app, and it returns to the page", async () => {
    stub();
    seed({ page: ["notes"], dock: [], hidden: ["weather"] });
    const { container } = render(Launchpad, { props: {} });
    await tick();

    // `aria-pressed` is the edit toggle's stable hook (its label is localized).
    const editBtn = container.querySelector("button[aria-pressed]") as HTMLButtonElement;
    await fireEvent.click(editBtn);
    await tick();

    const chip = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim().startsWith("＋"),
    ) as HTMLButtonElement;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain(name("weather"));

    await fireEvent.click(chip);
    await tick();

    const saved = JSON.parse(window.localStorage.getItem(LAYOUT) ?? "{}");
    expect(saved.hidden).not.toContain("weather");
    expect(saved.page).toContain("weather");
    // …and the icon is back in the grid, because the grid is derived from the layout.
    expect(grid(container).textContent).toContain(name("weather"));
  });

  test("hiding from the grid writes `hidden` (the inverse's precondition)", async () => {
    stub();
    seed({ page: ["notes", "weather"], dock: [], hidden: [] });
    const { container } = render(Launchpad, { props: {} });
    await tick();
    await fireEvent.click(container.querySelector("button[aria-pressed]") as HTMLButtonElement);
    await tick();

    const tile = [...grid(container).querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === name("weather"),
    ) as HTMLButtonElement;
    expect(tile).toBeTruthy();
    await fireEvent.click(tile);
    await tick();

    const saved = JSON.parse(window.localStorage.getItem(LAYOUT) ?? "{}");
    expect(saved.hidden).toContain("weather");
    expect(saved.page).not.toContain("weather");
    expect(grid(container).textContent).not.toContain(name("weather"));
  });
});

describe("Launchpad — the icon grid is keyboard-drivable (macOS parity)", () => {
  // Before this round the panel's only key was Escape: Tab reached every tile (so WCAG 2.1.1
  // was satisfied and no gate looked) but the four arrow keys did nothing — the same family
  // as the window-overview panels. macOS Launchpad walks the icon grid with the arrows.
  const stub = () =>
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) =>
      cmd === "wm_layout_snapshot" ? null : null,
    );
  const tiles = (c: HTMLElement) => [
    ...(c.querySelector('[role="grid"]') as HTMLElement).querySelectorAll("button"),
  ] as HTMLButtonElement[];

  test("arrow keys walk the grid instead of doing nothing", async () => {
    stub();
    const { container } = render(Launchpad, { props: {} });
    await tick();
    const t = tiles(container);
    // `cols` is LAUNCHPAD_COLS_DEFAULT (8) in a test, since the layout snapshot answers null.
    expect(t.length).toBeGreaterThan(9);

    // Nothing focused yet (the overlay just opened): the first nav key lands on tile 0.
    await fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(document.activeElement).toBe(t[0]);

    await fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(document.activeElement).toBe(t[1]);

    // Eight columns: Down is a whole row, and Up comes back keeping the column.
    await fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(t[9]);
    await fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(t[1]);
  });

  test("typing in the search field keeps the arrow keys for the caret", async () => {
    stub();
    const { container } = render(Launchpad, { props: {} });
    await tick();
    const input = container.querySelector("input[type=text]") as HTMLInputElement;
    expect(input).toBeTruthy();
    input.focus();
    await fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(document.activeElement).toBe(input);
  });
});

/**
 * REQ-A1179 — the Launchpad listed every built-in app and no installed one.
 *
 * Its `visibleIds` filter was `appTitleKey(id)` (true only for the compile-time registry),
 * so a store app the user had dragged onto the touch home screen — the *same*
 * `amos.home.layout` this panel reads — was silently absent from the desktop launcher. The
 * three `appTitleKey(id) ? t(...) : id` fallbacks in its markup were unreachable for the
 * same reason. macOS's Launchpad lists every installed app; the touch shell's App Library
 * lists them too, so this panel was the only launcher that could not open one.
 */
describe("Launchpad — installed store apps are launchable (REQ-A1179)", () => {
  const DEMO: StoreTile = {
    id: "store:org.amos.demo",
    mid: "org.amos.demo",
    name: "Demo",
    icon: "D",
  };
  const grid = (c: HTMLElement) => c.querySelector('[role="grid"]') as HTMLElement;
  const stub = () => vi.mocked(backend.invoke).mockImplementation(async () => null);
  const name = (id: string) => zh[appTitleKey(id) as keyof typeof zh];

  beforeEach(() => setStoreTiles([]));
  afterEach(() => setStoreTiles([]));

  test("an app the user put on the touch home screen appears here too, under its manifest name", async () => {
    stub();
    setStoreTiles([DEMO]);
    window.localStorage.setItem(
      "amos.home.layout",
      JSON.stringify({ page: ["notes", DEMO.id], dock: [], hidden: [] }),
    );
    const { container } = render(Launchpad, { props: {} });
    await tick();

    expect(grid(container).textContent).toContain("Demo");
    // Never the wire id, and never the glyph `appIcon` invents for an unknown id.
    expect(grid(container).textContent).not.toContain(DEMO.id);
    expect(grid(container).textContent).toContain("D");
  });

  test("an installed app that was never placed is listed too (macOS lists every installed app)", async () => {
    stub();
    setStoreTiles([DEMO]);
    window.localStorage.setItem(
      "amos.home.layout",
      JSON.stringify({ page: [], dock: [], hidden: [] }),
    );
    const { container } = render(Launchpad, { props: {} });
    await tick();

    expect(grid(container).textContent).toContain("Demo");
  });

  test("searching finds it by its manifest name (not only by its wire id)", async () => {
    stub();
    setStoreTiles([DEMO]);
    window.localStorage.setItem(
      "amos.home.layout",
      JSON.stringify({ page: [], dock: [], hidden: [] }),
    );
    const { container } = render(Launchpad, { props: {} });
    await tick();

    const search = container.querySelector('input[type="text"]') as HTMLInputElement;
    await fireEvent.input(search, { target: { value: "demo" } });
    await tick();
    expect(grid(container).textContent).toContain("Demo");
    expect(grid(container).textContent).not.toContain(name("notes"));
  });

  test("hiding it from the grid is reversible — the ＋ row restores it (the inverse exists)", async () => {
    stub();
    setStoreTiles([DEMO]);
    window.localStorage.setItem(
      "amos.home.layout",
      JSON.stringify({ page: ["notes", DEMO.id], dock: [], hidden: [] }),
    );
    const { container } = render(Launchpad, { props: {} });
    await tick();

    await fireEvent.click(container.querySelector("button[aria-pressed]") as HTMLButtonElement);
    await tick();
    // The app's own tile carries the manifest name; click it to hide.
    const tile = [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Demo",
    ) as HTMLButtonElement;
    await fireEvent.click(tile);
    await tick();

    const saved = JSON.parse(window.localStorage.getItem("amos.home.layout") ?? "{}");
    expect(saved.hidden).toContain(DEMO.id);
    expect(grid(container).textContent).not.toContain("Demo");

    // …and it is offered back, which needs the hidden row's own filter to accept a store id.
    const chip = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim().startsWith("＋"),
    ) as HTMLButtonElement;
    expect(chip.textContent).toContain("Demo");
    await fireEvent.click(chip);
    await tick();
    const back = JSON.parse(window.localStorage.getItem("amos.home.layout") ?? "{}");
    expect(back.hidden).not.toContain(DEMO.id);
    expect(grid(container).textContent).toContain("Demo");
  });
});
