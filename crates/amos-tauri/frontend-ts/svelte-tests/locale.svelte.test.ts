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
import { SVELTE_LOCALE_EVENT } from "../src/svelte/locale-events";

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

  test("the host locale event applies a valid value and ignores garbage (setLocaleSafe)", () => {
    // The window listener is how a host switches the locale of already-mounted
    // screens; it must go through the SAME guarded setter (so a raw string is
    // validated once, not re-implemented at the listener).
    window.dispatchEvent(new CustomEvent(SVELTE_LOCALE_EVENT, { detail: "en" }));
    expect(locale()).toBe("en");

    window.dispatchEvent(new CustomEvent(SVELTE_LOCALE_EVENT, { detail: "fr" }));
    expect(locale()).toBe("en"); // unknown → ignored, never a broken locale

    window.dispatchEvent(new CustomEvent(SVELTE_LOCALE_EVENT, { detail: null }));
    expect(locale()).toBe("en");
  });
});
