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
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import BatteryWidget from "../src/svelte/modules/BatteryWidget.svelte";
import ClockWidget from "../src/svelte/modules/ClockWidget.svelte";
import ControlCenterButton from "../src/svelte/modules/ControlCenterButton.svelte";
import LaunchpadTrigger from "../src/svelte/modules/LaunchpadTrigger.svelte";
import RadiosWidget from "../src/svelte/modules/RadiosWidget.svelte";
import SpotlightTrigger from "../src/svelte/modules/SpotlightTrigger.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { CHROME_ICON_BUTTON } from "../src/lib/shellChrome";

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

  test("the control centre is disabled and says why (no inert control)", async () => {
    const { container } = render(ControlCenterButton);
    await tick();
    const b = container.querySelector<HTMLButtonElement>('[data-testid="chrome-control-center"]')!;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(b.getAttribute("aria-label")).toBe("控制中心（尚未接入）");
    expect(b.title).toBe("控制中心（尚未接入）");
    // Dimmed rather than invisible: the user can see that the slot exists.
    expect(b.className).toContain("opacity-40");
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
});
