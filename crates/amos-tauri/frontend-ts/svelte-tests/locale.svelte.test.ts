/**
 * Tests for the reactive i18n singleton's PERSISTENCE side-effects
 * (src/svelte/locale.svelte.ts) — distinct from the component-reactivity tests
 * already covered by weather/calculator. Reading a module $state outside a
 * component returns the current value, so we can assert state + persistence
 * without rendering.
 */
import { afterEach, describe, expect, test } from "vitest";
import { setLocale, locale, t, setLocaleSafe } from "../src/svelte/locale.svelte";
import { LOCALE_KEY } from "../src/svelte/i18n";

afterEach(() => {
  setLocale("zh");
});

describe("locale.svelte — reactive i18n persistence", () => {
  test("setLocale updates state + persists the shared amos-ui.locale key", () => {
    expect(locale()).toBe("zh");
    expect(t("weather.today")).toBe("今天");

    setLocale("en");
    expect(locale()).toBe("en");
    expect(t("weather.today")).toBe("Today");
    expect(window.localStorage.getItem(LOCALE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  test("currentLocale() (the pure reader) reflects the persisted value", async () => {
    const { currentLocale } = await import("../src/svelte/i18n");
    expect(currentLocale()).toBe("zh");
    setLocale("en");
    expect(currentLocale()).toBe("en");
  });

  test("setLocaleSafe ignores null/unknown strings", () => {
    setLocaleSafe(null);
    expect(locale()).toBe("zh");
    setLocaleSafe("xx");
    expect(locale()).toBe("zh");
    setLocaleSafe("en");
    expect(locale()).toBe("en");
  });
});
