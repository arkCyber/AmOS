import { describe, expect, test } from "bun:test";
import {
  bgMode,
  DEFAULT_BG_MODE,
  isBgMode,
  isCustomWallpaper,
  resolveWallpaper,
} from "../lib/wallpaper";

describe("wallpaper", () => {
  test("defaults follow the theme, explicit presets win", () => {
    expect(resolveWallpaper(true, undefined)).toBe("wallpaper-dark.png");
    expect(resolveWallpaper(false, undefined)).toBe("wallpaper-light.png");
    expect(resolveWallpaper(false, "landscape")).toBe("wallpaper-landscape.png");
    expect(resolveWallpaper(true, "light")).toBe("wallpaper-light.png");
  });

  test("custom URLs pass through", () => {
    const url = "https://x/img.jpg";
    expect(isCustomWallpaper(url)).toBe(true);
    expect(isCustomWallpaper("data:image/png;base64,AAAA")).toBe(true);
    expect(isCustomWallpaper("dark")).toBe(false);
    expect(resolveWallpaper(true, url)).toBe(url);
  });

  test("background display modes default to ghost and resolve styles", () => {
    expect(DEFAULT_BG_MODE).toBe("ghost");
    expect(isBgMode("vivid")).toBe(true);
    expect(isBgMode("none")).toBe(false);
    expect(bgMode(undefined).blur).toBe(9); // ghost
    expect(bgMode("vivid").blur).toBe(0);
    expect(bgMode("vivid").alpha).toBe(0.95);
  });
});
