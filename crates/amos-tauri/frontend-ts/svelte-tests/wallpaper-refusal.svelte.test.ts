/**
 * wallpaper-refusal.svelte.test.ts — 壁纸选择器把写盘裁决整个丢掉（REQ-A1359 ∕ F-SH-623）。
 *
 * 两张卡片（`WallpaperCard` ∕ `LockWallpaperCard`）都用**同一枚** `writePref()`：
 *
 *     writeStoreValue("amos.settings", { ...readPrefs(), ...patch });   // 无返回值
 *     wall = id;                                                        // 紧接着照亮自己
 *
 * `writeStoreValue` 把配额 ∕ 不可用的异常吞在肚子里（它只返回 void），于是「盘上收下了」
 * 与「盘上拒绝了」在这张卡片看来**字节相同**：存储拒写时那颗药丸照旧点亮，而真正读这枚键的
 * 读者（`Backdrop.svelte` 订阅 `amos.settings` 画桌面壁纸）纹丝不动 —— 用户选了壁纸、药丸
 * 亮了、桌面没变、屏幕上一个字都不解释，刷新之后选择又消失。锁屏那张更重：拒写的上传把
 * `active` 设成 data URL，于是**预览图**画了出来，而那串字节从未落盘。
 *
 * 同族的先例已经写好了答案：`SettingsApp` 的另一页 `DockPage.svelte:52` 用
 * `writeStoreValueChecked`，拒写时既挂横幅（`common.storeWriteFailed`）又把控件回滚到存储
 * 真正持有的值；`PhotosApp.svelte:608` 写同一枚键的同一个字段时也是这么做的。这张卡片没有。
 *
 * 为什么现有用例看不见：`wallpaper.svelte.test.ts` 的每一条都只在**写成功**的世界里断言
 * （点了极光夜 ⇒ 存储里有 `"dark"`），而「点了之后存储里有」这句话在两种世界里都成立不了
 * 区别 —— 必须让存储**拒写**，裁决才会与成功分叉。
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import WallpaperCard from "../src/svelte/WallpaperCard.svelte";
import LockWallpaperCard from "../src/svelte/LockWallpaperCard.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { setLocale } from "../src/svelte/locale.svelte";

const SETTINGS_KEY = "amos.settings";

/** 只让 `key` 的 setItem 抛异常（配额满 ∕ 不可用），其余键照常。 */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}

const buttonContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;
const inputByPlaceholder = (h: { container: HTMLElement }, ph: string) =>
  [...h.container.querySelectorAll("input")].find(
    (i) => i.getAttribute("placeholder") === ph,
  ) as HTMLInputElement | undefined;
const pillActive = (h: { container: HTMLElement }, s: string) =>
  (buttonContaining(h, s)?.className ?? "").includes("bg-accent");
const storeErr = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="store-write-error"]')?.textContent ?? "";
const prefs = () => readStoreValue<{ wallpaper?: string; lockWallpaper?: string }>(SETTINGS_KEY, {});

afterEach(() => {
  cleanup();
  setLocale("zh");
});

describe("WallpaperCard.svelte — 拒写时不能照亮一颗并未落盘的药丸（REQ-A1359）", () => {
  test("拒写的预设：药丸不亮、存储不变、横幅说清这次没保存", async () => {
    const restore = failWritesFor(SETTINGS_KEY);
    try {
      const host = render(WallpaperCard);
      expect(pillActive(host, "极光夜")).toBe(false);

      await fireEvent.click(buttonContaining(host, "极光夜") as HTMLButtonElement);

      expect(prefs().wallpaper, "存储拒了这一次写入，wallpaper 就不该在盘上").toBeUndefined();
      expect(pillActive(host, "极光夜"), "盘上没有这一项，药丸就不能亮").toBe(false);
      expect(storeErr(host)).not.toBe("");
    } finally {
      restore();
    }
  });

  test("拒写的自设 URL：不把「自动」挤下去，横幅照挂", async () => {
    const restore = failWritesFor(SETTINGS_KEY);
    try {
      const host = render(WallpaperCard);
      const input = inputByPlaceholder(host, "自设图片 URL（http / data:…）");
      await fireEvent.input(input as HTMLInputElement, { target: { value: "https://a.io/bg.jpg" } });
      await fireEvent.click(buttonContaining(host, "自设图片 URL") as HTMLButtonElement);

      expect(prefs().wallpaper).toBeUndefined();
      // `wall` 若被就地改成 URL，「自动」这颗（`presetActive` 里的 `!wall && id === "auto"`）
      // 就会失去高亮 —— 那是把一次没发生的改动画在了屏幕上。
      expect(pillActive(host, "自动"), "未落盘的自设值不该把「自动」挤下去").toBe(true);
      expect(storeErr(host)).not.toBe("");
    } finally {
      restore();
    }
  });

  test("拒写的背景模式：那颗模式药丸不亮，横幅照挂", async () => {
    const restore = failWritesFor(SETTINGS_KEY);
    try {
      const host = render(WallpaperCard);
      expect(pillActive(host, "若隐若现")).toBe(true); // 默认值

      await fireEvent.click(buttonContaining(host, "明快 · 清晰") as HTMLButtonElement);

      expect(readStoreValue<{ background?: string }>(SETTINGS_KEY, {}).background).toBeUndefined();
      expect(pillActive(host, "明快 · 清晰")).toBe(false);
      expect(pillActive(host, "若隐若现"), "拒写后要回到存储真正持有的模式").toBe(true);
      expect(storeErr(host)).not.toBe("");
    } finally {
      restore();
    }
  });

  test("补集：写成功时药丸亮、存储有值、没有横幅", async () => {
    const host = render(WallpaperCard);
    await fireEvent.click(buttonContaining(host, "极光夜") as HTMLButtonElement);

    expect(prefs().wallpaper).toBe("dark");
    expect(pillActive(host, "极光夜")).toBe(true);
    expect(storeErr(host)).toBe("");
  });
});

describe("LockWallpaperCard.svelte — 拒写的锁屏壁纸不该画出预览（REQ-A1359）", () => {
  test("拒写的预设：没有预览、药丸不亮、存储不变", async () => {
    const restore = failWritesFor(SETTINGS_KEY);
    try {
      const host = render(LockWallpaperCard);
      await fireEvent.click(buttonContaining(host, "极光夜") as HTMLButtonElement);

      expect(prefs().lockWallpaper).toBeUndefined();
      expect(pillActive(host, "极光夜")).toBe(false);
      // 预览（`previewSrc`）只有 `active` 有值时才画 —— 未落盘的选择不该有图。
      expect(host.container.querySelector("img"), "拒写的选择不该有预览图").toBeNull();
      expect(storeErr(host)).not.toBe("");
    } finally {
      restore();
    }
  });

  test("拒写的清除：仍是原来的那张，横幅照挂", async () => {
    writeStoreValue(SETTINGS_KEY, { lockWallpaper: "dark" });
    const host = render(LockWallpaperCard);
    expect(pillActive(host, "极光夜")).toBe(true);

    const restore = failWritesFor(SETTINGS_KEY);
    try {
      await fireEvent.click(buttonContaining(host, "清除") as HTMLButtonElement);

      expect(prefs().lockWallpaper, "拒写的清除不该把盘上的值也当成清了").toBe("dark");
      expect(pillActive(host, "极光夜"), "盘上还是这一张，药丸就得亮着").toBe(true);
      expect(storeErr(host)).not.toBe("");
    } finally {
      restore();
    }
  });

  test("补集：写成功的锁屏壁纸有预览、无横幅", async () => {
    const host = render(LockWallpaperCard);
    await fireEvent.click(buttonContaining(host, "极光夜") as HTMLButtonElement);

    expect(prefs().lockWallpaper).toBe("dark");
    expect(pillActive(host, "极光夜")).toBe(true);
    expect(storeErr(host)).toBe("");
  });
});
