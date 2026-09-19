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

  test("setLocale tells the HOST to draw the native menu bar in that language (REQ-A437)", async () => {
    // The menu bar is AppKit's, not ours: a UI language the host never hears about leaves a
    // Chinese shell with an English File / Edit / View (measured on this machine).
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return args?.locale ?? null; // the host echoes the locale it applied
      },
      listen: async () => () => {},
    };
    setLocale("en");
    await Promise.resolve();
    await Promise.resolve();
    const menu = calls.find((c) => c.cmd === "menu_set_locale");
    expect(menu, "setLocale must ask the host to re-draw the menu bar").toBeTruthy();
    expect(menu?.args).toEqual({ locale: "en" });

    // …and it survives a host that draws something else (the caller reports the difference
    // instead of believing its own request landed).
    calls.length = 0;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return "zh";
      },
      listen: async () => () => {},
    };
    expect(() => setLocale("en")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.some((c) => c.cmd === "menu_set_locale")).toBe(true);
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});
