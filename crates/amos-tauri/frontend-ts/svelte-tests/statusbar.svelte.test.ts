/**
 * statusbar.svelte.test.ts — StatusBar island (Svelte shell chrome) tests.
 *
 * StatusBar.svelte reads the SAME shared stores as the React StatusBar (quick
 * settings / flashlight / sound / wifi) plus live time/online. Since this port
 * drives the battery from REAL sources (daemon `system_health`, else the host OS
 * Battery API), the battery here is honest: with no daemon and no host battery it
 * renders an empty glyph + "—", never a fabricated countdown. These tests cover
 * that wiring, the flashlight glyph, and Do-Not-Disturb.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import StatusBar from "../src/svelte/StatusBar.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { SETTINGS_KEY, FLASHLIGHT_KEY } from "../src/lib/settings";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const byAria = (container: HTMLElement, aria: string) =>
  container.querySelector(`[aria-label="${aria}"]`);
const settle = () => new Promise((r) => setTimeout(r, 40));

/** Install a Tauri bridge whose `system_health` returns the given payload. */
function installBridge(systemHealth: unknown) {
  const invoke = async (cmd: string) => {
    if (cmd === "system_health") return systemHealth;
    return null;
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}

describe("StatusBar.svelte", () => {
  test("renders the clock (digits) and an honest battery glyph + — when no real source", async () => {
    // No daemon bridge and (in happy-dom) no host Battery API → honest unknown.
    const { container } = render(StatusBar);
    await tick();
    await settle();
    expect(container.textContent ?? "").toMatch(/\d{1,2}:\d{2}/); // fmtClock
    const batt = container.querySelector(`[aria-label="${zh["a11y.batteryLevel"]}"]`);
    expect(batt?.querySelector("svg")).toBeTruthy(); // vector battery outline
    expect(batt?.textContent ?? "").toContain("—"); // never a fabricated %
  });

  test("shows a REAL battery % when the daemon reports a level", async () => {
    installBridge({
      battery_level_pct: 80,
      battery_charging: false,
      running: 0,
      cached: 0,
      stopped: 0,
    });
    const { container } = render(StatusBar);
    await tick();
    await settle();
    const batt = byAria(container, zh["a11y.batteryLevel"]);
    expect(batt?.textContent ?? "").toContain("80%");
  });

  test("marks a charging battery (green tone + charging title)", async () => {
    installBridge({
      battery_level_pct: 64,
      battery_charging: true,
      running: 0,
      cached: 0,
      stopped: 0,
    });
    const { container } = render(StatusBar);
    await tick();
    await settle();
    const batt = byAria(container, zh["a11y.batteryLevel"]);
    expect(batt?.textContent ?? "").toContain("64%");
    // The title is localised copy (it used to be a hard-coded English sentence).
    expect(batt?.getAttribute("title")).toBe(zh["a11y.batteryCharging"].replace("{pct}", "64%"));
  });

  test("shows the flashlight glyph when the torch store is on", async () => {
    const { container } = render(StatusBar);
    await tick();
    await settle();
    expect(byAria(container, zh["a11y.flashlightOn"])).toBeFalsy();

    writeStoreValue(FLASHLIGHT_KEY, { on: true, torch_present: true });
    await tick();
    await settle();
    expect(byAria(container, zh["a11y.flashlightOn"])).toBeTruthy();
  });

  test("Do-Not-Disturb flips the alert glyph to 🌒", async () => {
    const { container } = render(StatusBar);
    await tick();
    await settle();
    expect(byAria(container, "do not disturb")).toBeFalsy();

    writeStoreValue(SETTINGS_KEY, { dnd: true });
    await tick();
    await settle();
    expect(byAria(container, "do not disturb")).toBeTruthy();
  });
});

describe("StatusBar.svelte — the Dynamic Island is iPhone hardware (REQ-A249)", () => {
  const island = (c: HTMLElement) => c.querySelector('[data-testid="dynamic-island"]');

  test("the phone (and an absent host) still draws it — today's chrome is unchanged", async () => {
    // No `form` prop = the shell had no host answer ⇒ the conservative phone default.
    const { container } = render(StatusBar);
    await tick();
    await settle();
    expect(island(container)).toBeTruthy();

    const explicit = render(StatusBar, { form: "phone" });
    await tick();
    expect(island(explicit.container)).toBeTruthy();
  });

  test("an iPad and a Mac do not: neither has that screen cutout", async () => {
    const tablet = render(StatusBar, { form: "tablet" });
    await tick();
    await settle();
    expect(island(tablet.container)).toBeNull();
    // …and the row's real content is still there (only the pill is gone).
    expect(tablet.container.textContent ?? "").toMatch(/\d{1,2}:\d{2}/);

    const mac = render(StatusBar, { form: "desktop" });
    await tick();
    await settle();
    expect(island(mac.container)).toBeNull();
    // The honest battery reading survives the change (no fabricated %).
    const batt = mac.container.querySelector(`[aria-label="${zh["a11y.batteryLevel"]}"]`);
    expect(batt?.textContent ?? "").toContain("—");
  });
});
