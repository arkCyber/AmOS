/**
 * Minimal tests for the reactive theme singleton (src/svelte/theme.svelte.ts).
 */
import { describe, expect, test } from "vitest";
import { setThemeMode, themeDark, themeMode, toggleTheme } from "../src/svelte/theme.svelte";

describe("theme.svelte (reactive theme)", () => {
  test("defaults to auto", () => {
    expect(themeMode()).toBe("auto");
  });

  test("setThemeMode('dark') flips the effective dark + <html> class", () => {
    setThemeMode("dark");
    expect(themeMode()).toBe("dark");
    expect(themeDark()).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  test("setThemeMode('light') and toggle back", () => {
    setThemeMode("light");
    expect(themeDark()).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    toggleTheme(); // light -> dark
    expect(themeDark()).toBe(true);
    setThemeMode("auto"); // leave clean for other suites
    document.documentElement.classList.remove("dark");
  });
});
