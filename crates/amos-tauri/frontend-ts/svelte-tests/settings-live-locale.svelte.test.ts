/**
 * settings-live-locale.svelte.test.ts — a localized list must survive a language
 * switch *in place*, not only a remount.
 *
 * `locale.svelte.ts` states the contract: `t()` is reactive **only when it is called
 * during render**, so "components call `t(key)` inside markup and Svelte re-renders
 * them the instant `setLocale()` is called … every mounted Svelte app updates in
 * place — no remount, no state loss". A list of labels translated **once at component
 * init** breaks half of that promise: the heading, hints and dropdowns follow the
 * locale while the names the list was built with stay frozen, leaving one screen
 * showing two languages at once.
 *
 * Two pages did exactly that (RingtonePage's ringtone list, HotCornersPage's four
 * corner labels), and in each case the file contradicted itself: the sibling tables
 * in the very same page (`actions` / `modifiers` on HotCornersPage — key + `t()` in
 * the template) already followed the locale.
 *
 * Both directions are pinned (the old language must be *gone* after the switch), so a
 * test cannot pass by the two locales happening to share a substring.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import RingtonePage from "../src/svelte/settings/RingtonePage.svelte";
import HotCornersPage from "../src/svelte/settings/HotCornersPage.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

const text = (c: HTMLElement) => c.textContent ?? "";

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
});
afterEach(() => setLocale("zh"));

describe("RingtonePage.svelte — the ringtone list follows the locale", () => {
  test("the five tone names relabel when the shell locale changes", async () => {
    const { container } = render(RingtonePage);
    await tick();
    // zh first: the option is named with the label on screen (it is the default pick,
    // so the ✓ marker rides along — the name is the part under test).
    const option = () => container.querySelector<HTMLElement>('[data-testid="ringtone-option-classic"]')!;
    expect(text(option())).toContain(zh["ringtone.classic"]);

    setLocale("en");
    await tick();
    expect(text(option())).toContain(en["ringtone.classic"]);
    expect(text(option())).not.toContain(zh["ringtone.classic"]);
    // Every name in the list moved, not just the first row.
    for (const id of ["classic", "modern", "piano", "guitar", "bell"]) {
      expect(text(container.querySelector<HTMLElement>(`[data-testid="ringtone-option-${id}"]`)!)).not.toMatch(
        /[一-鿿]/,
      );
    }
  });
});

describe("HotCornersPage.svelte — the four corner labels follow the locale", () => {
  test("all four corner labels relabel when the shell locale changes", async () => {
    const { container } = render(HotCornersPage);
    await tick();
    for (const key of [
      "settings.hotCorner.topLeft",
      "settings.hotCorner.topRight",
      "settings.hotCorner.bottomLeft",
      "settings.hotCorner.bottomRight",
    ]) {
      expect(text(container)).toContain(zh[key]);
    }

    setLocale("en");
    await tick();
    for (const key of [
      "settings.hotCorner.topLeft",
      "settings.hotCorner.topRight",
      "settings.hotCorner.bottomLeft",
      "settings.hotCorner.bottomRight",
    ]) {
      expect(text(container)).toContain(en[key]);
      expect(text(container)).not.toContain(zh[key]);
    }
  });
});
