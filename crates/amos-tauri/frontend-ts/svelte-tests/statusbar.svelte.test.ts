/**
 * statusbar.svelte.test.ts — StatusBar island (Svelte shell chrome) tests.
 *
 * StatusBar.svelte reads the SAME shared stores as the React StatusBar
 * (quick settings / flashlight / sound) and live time/online. Here we verify the
 * reactive wiring: the clock/battery render, the flashlight-on glyph reflects the
 * flashlight store, and Do-Not-Disturb flips the alert glyph.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import StatusBar from "../src/svelte/StatusBar.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { SETTINGS_KEY, FLASHLIGHT_KEY } from "../src/lib/settings";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

const byAria = (container: HTMLElement, aria: string) =>
  container.querySelector(`[aria-label="${aria}"]`);

describe("StatusBar.svelte", () => {
  test("renders the clock (digits) and battery", async () => {
    const { container } = render(StatusBar);
    await tick();
    expect(container.textContent ?? "").toMatch(/\d{1,2}:\d{2}/); // fmtClock
    expect(container.textContent ?? "").toContain("▮▮▮");
    expect(container.textContent ?? "").toMatch(/%/);
  });

  test("shows the flashlight glyph when the torch store is on", async () => {
    const { container } = render(StatusBar);
    await tick();
    expect(byAria(container, "flashlight on")).toBeFalsy();

    writeStoreValue(FLASHLIGHT_KEY, { on: true, torch_present: true });
    await tick();
    expect(byAria(container, "flashlight on")).toBeTruthy();
  });

  test("Do-Not-Disturb flips the alert glyph to 🌒", async () => {
    const { container } = render(StatusBar);
    await tick();
    expect(byAria(container, "do not disturb")).toBeFalsy();

    writeStoreValue(SETTINGS_KEY, { dnd: true });
    await tick();
    expect(byAria(container, "do not disturb")).toBeTruthy();
  });
});
