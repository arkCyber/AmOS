/**
 * backdrop.svelte.test.ts — Svelte wallpaper backdrop island.
 *
 * Backdrop.svelte reads the reactive theme + shared amos.settings wallpaper
 * prefs and paints a bg-cover layer with the resolved wallpaper + bg-mode
 * filter — the SAME lib/wallpaper helpers the React Backdrop uses.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import Backdrop from "../src/svelte/Backdrop.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { SETTINGS_KEY } from "../src/lib/settings";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

function layer(c: HTMLElement): HTMLElement | null {
  return c.querySelector('div[aria-hidden="true"]');
}

describe("Backdrop.svelte", () => {
  test("paints the theme wallpaper with a bg-mode filter", async () => {
    const { container } = render(Backdrop);
    await tick();
    const el = layer(container);
    expect(el).toBeTruthy();
    const style = (el as HTMLElement).getAttribute("style") ?? "";
    expect(style).toMatch(/wallpapers\/wallpaper-(light|dark)\.png/);
    expect(style).toContain("opacity");
    expect(style).toContain("blur(");
    expect(style).toContain("saturate(");
  });

  test("an explicit preset wins and a custom URL is used as-is", async () => {
    writeStoreValue(SETTINGS_KEY, { wallpaper: "landscape", background: "soft" });
    const { container } = render(Backdrop);
    await tick();
    const style = (layer(container) as HTMLElement).getAttribute("style") ?? "";
    expect(style).toContain("wallpapers/wallpaper-landscape.png");
    expect(style).toContain("saturate("); // bg-mode "soft" filter applied

    window.localStorage.clear();
    writeStoreValue(SETTINGS_KEY, { wallpaper: "blob:https://x/abc123" });
    const second = render(Backdrop);
    await tick();
    const s2 = (layer(second.container) as HTMLElement).getAttribute("style") ?? "";
    expect(s2).toContain("blob:https://x/abc123"); // custom src kept verbatim
  });
});
