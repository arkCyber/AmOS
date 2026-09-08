import { afterEach, describe, expect, test } from "vitest";
import {
  applyLocaleToDom,
  applyThemeToDom,
  bootOsChrome,
} from "../src/svelte/osBoot";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.lang = "";
  delete (window as unknown as Record<string, unknown>).matchMedia;
});

describe("pure-Svelte host boot (osBoot)", () => {
  test("applies persisted dark theme + en locale to <html>", () => {
    window.localStorage.setItem("amos-ui.theme", "dark");
    window.localStorage.setItem("amos-ui.locale", "en");
    bootOsChrome();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.lang).toBe("en");
  });

  test("applies light theme + zh locale", () => {
    window.localStorage.setItem("amos-ui.theme", "light");
    window.localStorage.setItem("amos-ui.locale", "zh");
    applyThemeToDom();
    applyLocaleToDom();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  test("'auto' theme follows the OS prefers-color-scheme", () => {
    (window as unknown as Record<string, unknown>).matchMedia = (query: string) => ({
      matches: query.includes("dark"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    });
    window.localStorage.setItem("amos-ui.theme", "auto");
    bootOsChrome();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
