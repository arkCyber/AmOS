/**
 * DOM tests for the Svelte 5 wallpaper panels (WallpaperCard / LockWallpaperCard),
 * the round-2 groups added to SettingsApp.svelte. They persist wallpaper choices
 * to the shared amos.settings store through pure lib/wallpaper, mirroring React.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import WallpaperCard from "../src/svelte/WallpaperCard.svelte";
import LockWallpaperCard from "../src/svelte/LockWallpaperCard.svelte";
import { readStoreValue } from "../src/lib/amosStore";

afterEach(cleanup);

const buttonContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;
const inputByPlaceholder = (h: { container: HTMLElement }, ph: string) =>
  [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("placeholder") === ph) as
    HTMLInputElement | undefined;

describe("WallpaperCard.svelte", () => {
  test("picking a built-in preset persists amos.settings.wallpaper", async () => {
    const host = render(WallpaperCard);
    expect(buttonContaining(host, "极光夜")).toBeTruthy();
    await fireEvent.click(buttonContaining(host, "极光夜") as HTMLButtonElement);
    const prefs = readStoreValue<{ wallpaper?: string }>("amos.settings", {});
    expect(prefs.wallpaper).toBe("dark");
  });

  test("setting a custom URL persists it", async () => {
    const host = render(WallpaperCard);
    const input = inputByPlaceholder(host, "自设图片 URL（http / data:…）");
    await fireEvent.input(input as HTMLInputElement, { target: { value: "https://a.io/bg.jpg" } });
    await fireEvent.click(buttonContaining(host, "自设图片 URL") as HTMLButtonElement);
    const prefs = readStoreValue<{ wallpaper?: string }>("amos.settings", {});
    expect(prefs.wallpaper).toBe("https://a.io/bg.jpg");
  });
});

describe("LockWallpaperCard.svelte", () => {
  test("a custom URL sets amos.settings.lockWallpaper and Clear resets it", async () => {
    const host = render(LockWallpaperCard);
    const input = inputByPlaceholder(host, "自设图片 URL（http / data:…）");
    await fireEvent.input(input as HTMLInputElement, { target: { value: "https://a.io/lock.jpg" } });
    await fireEvent.click(buttonContaining(host, "自设图片 URL") as HTMLButtonElement);
    const prefs = readStoreValue<{ lockWallpaper?: string }>("amos.settings", {});
    expect(prefs.lockWallpaper).toBe("https://a.io/lock.jpg");

    const clear = buttonContaining(host, "清除");
    expect(clear).toBeTruthy();
    await fireEvent.click(clear as HTMLButtonElement);
    expect(readStoreValue<{ lockWallpaper?: string }>("amos.settings", {}).lockWallpaper).toBe("");
  });
});
