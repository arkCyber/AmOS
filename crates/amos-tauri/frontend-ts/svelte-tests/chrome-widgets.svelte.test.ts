/**
 * DOM tests for the chrome **widgets** — the other half of the container split.
 *
 * Each widget is mounted on its own (no bar, no shell): that is the property the
 * modularisation buys, so these tests are also the proof of it. They pin the parts
 * of the *look* that are a contract rather than taste:
 *
 *  • every interactive widget has an accessible name AND a tooltip, and carries the
 *    shared hit target + focus ring (`lib/shellChrome.ts`) — three widgets that each
 *    roll their own button is exactly what this round removed;
 *  • the control centre says it is not wired yet instead of being an inert button;
 *  • the radios/battery render what the pure libs decided (dim glyph when off, `—`
 *    when no sample exists) and never invent a value.
 *
 * REQ-A262 added the widgets that were still inline in `TopBar`/`DesktopStage` — the
 * Apple menu (a real dropdown now), the app name, the five app-menu titles (greyed with
 * a reason: FMEA F-SH-001) and the stage clock — so their contracts are asserted here
 * too. A widget mounted alone has **no chrome handle** (the shell provides it), which is
 * also why nothing here asserts an intent; those paths belong to `desktop-shell…`.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import BatteryWidget from "../src/svelte/modules/BatteryWidget.svelte";
import ClockWidget from "../src/svelte/modules/ClockWidget.svelte";
import ControlCenterButton from "../src/svelte/modules/ControlCenterButton.svelte";
import LaunchpadTrigger from "../src/svelte/modules/LaunchpadTrigger.svelte";
import RadiosWidget from "../src/svelte/modules/RadiosWidget.svelte";
import SpotlightTrigger from "../src/svelte/modules/SpotlightTrigger.svelte";
import StageClock from "../src/svelte/modules/StageClock.svelte";
import TopbarAppleMenu from "../src/svelte/modules/TopbarAppleMenu.svelte";
import TopbarAppName from "../src/svelte/modules/TopbarAppName.svelte";
import TopbarMainMenu from "../src/svelte/modules/TopbarMainMenu.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { CHROME_ICON_BUTTON } from "../src/lib/shellChrome";
import { zh } from "../src/i18n/locales/zh";

afterEach(cleanup);
afterEach(() => setLocale("zh"));

/** The classes the shared chrome button must carry (hit target + focus ring). */
const REQUIRED_CLASSES = [
  "h-6",
  "min-w-6",
  "hover:bg-white/10",
  "focus-visible:ring-2",
  "rounded-md",
];

describe("chrome widgets (mounted alone)", () => {
  test("the shared chrome button is the one implementation the widgets use", () => {
    for (const cls of REQUIRED_CLASSES) {
      expect(CHROME_ICON_BUTTON, `the token must carry ${cls}`).toContain(cls);
    }
  });

  test("the launchpad trigger has a name, a tooltip and the shared look", async () => {
    const { container } = render(LaunchpadTrigger);
    await tick();
    const b = container.querySelector<HTMLButtonElement>('[data-testid="chrome-launchpad"]')!;
    expect(b.tagName).toBe("BUTTON");
    expect(b.getAttribute("aria-label")).toBe("启动台");
    expect(b.getAttribute("title")).toBe("启动台");
    expect(b.textContent).toContain("🚀");
    for (const cls of REQUIRED_CLASSES) expect(b.className).toContain(cls);
    // The bar's text shadow is part of the look (white glyph over glass).
    expect(b.getAttribute("style")).toContain("text-shadow");
  });

  test("the spotlight trigger is the same shape as the launchpad one", async () => {
    const { container } = render(SpotlightTrigger);
    await tick();
    const b = container.querySelector<HTMLButtonElement>('[data-testid="chrome-spotlight"]')!;
    expect(b.getAttribute("aria-label")).toBe("Spotlight 搜索");
    expect(b.className).toBe(container.querySelector("button")!.className);
    for (const cls of REQUIRED_CLASSES) expect(b.className).toContain(cls);
  });

  test("the control centre item is a real disclosure control now (no inert button)", async () => {
    const { container } = render(ControlCenterButton);
    await tick();
    const b = container.querySelector<HTMLButtonElement>('[data-testid="chrome-control-center"]')!;
    // REQ-A262 shipped this as a *disabled* control whose name said the panel did not exist.
    // REQ-A263 landed the panel, so the same widget is a live toggle again — and the whole
    // change is this file plus its registry row, which is what the module boundary promised.
    expect(b.disabled).toBe(false);
    expect(b.getAttribute("aria-disabled")).toBeNull();
    expect(b.getAttribute("aria-label")).toBe("控制中心");
    expect(b.getAttribute("title")).toBe("控制中心");
    // Mounted outside a shell there is no handle: the state it reports is "closed", not a
    // guess, and clicking does nothing rather than throwing.
    expect(b.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(b);
    expect(b.getAttribute("aria-expanded")).toBe("false");
  });

  test("the clock renders a formatted time and reserves its width", async () => {
    const { container } = render(ClockWidget);
    await tick();
    const span = container.querySelector<HTMLElement>('[data-testid="chrome-clock"]')!;
    expect(span.textContent).toMatch(/^\d{1,2}:\d{2}/);
    expect(span.className).toContain("tabular-nums");
    expect(span.getAttribute("style")).toContain("min-width");
  });

  test("the radios render the glyphs the pure lib decided, dimmed when off", async () => {
    const { container } = render(RadiosWidget);
    await tick();
    const root = container.querySelector<HTMLElement>('[data-testid="chrome-radios"]')!;
    // No quick settings ⇒ every radio is off ⇒ dimmed, never lit.
    const glyphs = [...root.querySelectorAll("span")];
    expect(glyphs.length).toBeGreaterThan(0);
    for (const g of glyphs) expect(g.className).toContain("text-white/30");
  });

  test("the battery shows — while no sample exists (never an invented level)", async () => {
    const { container } = render(BatteryWidget);
    await tick();
    const root = container.querySelector<HTMLElement>('[data-testid="chrome-battery"]')!;
    expect(root.textContent).toContain("—");
    expect(root.getAttribute("aria-label")).toBe("电量");
    // No tooltip with a percentage: there is no reading to report.
    expect(root.getAttribute("title")).toBeNull();
  });

  test("the Apple menu opens a real menu, and its impossible rows are greyed + named", async () => {
    const { container } = render(TopbarAppleMenu);
    await tick();
    // Closed by default: a menu panel that is always mounted is how a bar grows a
    // permanent overlay.
    expect(container.querySelector('[data-testid="apple-menu-panel"]')).toBeNull();

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="apple-menu-trigger"]')!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(trigger);
    await tick();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const rows = [...container.querySelectorAll('[data-testid="apple-menu-panel"] [role="menuitem"]')];
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "apple-menu-about",
      "apple-menu-settings",
      "apple-menu-lock",
      "apple-menu-restart",
      "apple-menu-shutdown",
    ]);
    // The two the shell can do are live; the three it cannot are greyed **and** say why
    // (never a row that looks available and does nothing — FMEA F-SH-001).
    const live = rows.filter((r) => !(r as HTMLButtonElement).disabled).map((r) => r.getAttribute("data-testid"));
    expect(live).toEqual(["apple-menu-settings", "apple-menu-lock"]);
    for (const id of ["apple-menu-about", "apple-menu-restart", "apple-menu-shutdown"]) {
      const row = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
      expect(row.disabled).toBe(true);
      expect(row.getAttribute("aria-disabled")).toBe("true");
      // …and the name carries the reason, not just the label a Mac user would expect.
      expect(row.getAttribute("aria-label")).toContain("尚未接入");
    }

    // Escape dismisses it (macOS), and so does a click outside the widget.
    await fireEvent.keyDown(window, { key: "Escape" });
    await tick();
    expect(container.querySelector('[data-testid="apple-menu-panel"]')).toBeNull();
  });

  test("the app name is the product name until the host names a focused app", async () => {
    const { container } = render(TopbarAppName);
    await tick();
    const name = container.querySelector<HTMLElement>('[data-testid="menu-app-name"]')!;
    expect(name.textContent?.trim()).toBeTruthy();
  });

  test("the five app menus are disabled, and their names carry the reason", async () => {
    const { container } = render(TopbarMainMenu);
    await tick();
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.length).toBe(5);
    for (const b of buttons) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
      expect(b.getAttribute("aria-label")).toContain(zh["desktop.menuUnavailable"]);
    }
  });

  test("the stage clock renders a formatted time over a formatted date", async () => {
    const { container } = render(StageClock);
    await tick();
    const root = container.querySelector<HTMLElement>('[data-testid="stage-clock"]')!;
    expect(root.textContent).toMatch(/\d{2}:\d{2}/);
    expect(root.textContent?.trim().length).toBeGreaterThan(5); // the date line is there too
  });
});
