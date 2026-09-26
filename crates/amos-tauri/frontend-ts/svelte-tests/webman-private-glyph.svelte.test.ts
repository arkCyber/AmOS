/**
 * webman-private-glyph.svelte.test.ts — 地址栏左端那个字形宣称的是**当前是不是隐私模式**
 * （REQ-A1209 / FMEA F-SH-496）。
 *
 * 修前它是一段**两支一模一样**的分支：
 *
 *   {#if activeTab?.loading}  ⟳ 加载圈
 *   {:else if settings.privateMode}  🔒
 *   {:else}                          🔒      ← 与上一支逐字节相同
 *   {/if}
 *
 * 于是 `settings.privateMode` 对这个字形**没有任何作用**：关着隐私模式时，地址栏照样画着隐私
 * 模式那把锁。而**同一个组件**在设置面板里用 `settings.privateMode ? "🔒" : "🔓"` 回答**同一个
 * 问题**（`webman.privateMode` 那一行）—— 同一块屏幕上的两个面，对「现在是不是隐私模式」给出
 * 两个互相矛盾的答案，而地址栏那一个还是**冻住的**（两个分支同一份文本，切来切去也不变）。
 *
 * 同一份事实的第三个面是地址栏自己的 placeholder（`settings.privateMode ? 隐私模式 : 搜索或输入网址`），
 * 它**是**活的 —— 说明这个字形本来就该跟着开关走，只是被写死成了同一支。
 *
 * 修法：把死支折成一个三元式，与设置里那一行**共用同一份措辞**（🔒 开 / 🔓 关）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY, saveSettings } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  setFormFactor(null);
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const buttons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")] as HTMLButtonElement[];

function seedTab(url: string) {
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [{ id: "tab-1", url, title: url, favicon: "", loading: false, scrollY: 0, pinned: false }],
    }),
  );
}

/**
 * 地址栏左端那个字形 —— 它是**地址栏输入框的前一个兄弟**（`pl-10` 只为输入框留出它的位置，
 * 全组件只此一处），所以这里读的是屏幕上真正画出来的那个字符。
 */
const addressGlyph = (h: { container: HTMLElement }) => {
  const input = h.container.querySelector("input.pl-10") as HTMLInputElement | null;
  if (!input) throw new Error("地址栏输入框不在（pl-10 是它的唯一样式标记）");
  return input.previousElementSibling?.textContent?.trim() ?? "";
};

/** 设置面板里 `webman.privateMode` 那一行的字形 —— 同一份事实的**另一个面**。 */
const settingsRowGlyph = (h: { container: HTMLElement }) => {
  const row = buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.privateMode"]));
  if (!row) throw new Error("设置面板里没有「隐私模式」那一行");
  return row.querySelector("span")?.textContent?.trim() ?? "";
};

/** 菜单 ▸ 设置（打开侧边栏的设置面板）。 */
async function openSettings(h: { container: HTMLElement }) {
  const menuBtn = buttons(h).find((b) => b.getAttribute("aria-label") === zh["webman.a11y.menu"]);
  await fireEvent.click(menuBtn!);
  await settle();
  const entry = buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.settings"]));
  await fireEvent.click(entry!);
  await settle();
}

describe("REQ-A1209: 地址栏那个字形说的是「现在是不是隐私模式」，不是一句写死的装饰", () => {
  test("非隐私模式下地址栏画的是「没上锁」，不是隐私模式那把锁", async () => {
    seedTab("http://127.0.0.1:1/");
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    expect(addressGlyph(host)).toBe("🔓");
  });

  test("地址栏与设置里那一行对同一个问题说同一件事（关 ⇒ 都说关，开 ⇒ 都说开）", async () => {
    seedTab("http://127.0.0.1:1/");
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();
    await openSettings(host);

    const row = buttons(host).find((b) => (b.textContent ?? "").includes(zh["webman.privateMode"]))!;

    // 关着的时候两面一致（修前：设置说 🔓、地址栏说 🔒 —— 一块屏幕上两个答案）。
    expect(addressGlyph(host)).toBe(settingsRowGlyph(host));
    expect(addressGlyph(host)).toBe("🔓");

    // 打开，两面一起变。
    await fireEvent.click(row);
    await settle();
    expect(addressGlyph(host)).toBe("🔒");
    expect(settingsRowGlyph(host)).toBe("🔒");

    // 关回去，两面一起变回来 —— 这一半才说明地址栏是**跟着开关走**的，不是碰巧停在 🔒 上。
    await fireEvent.click(row);
    await settle();
    expect(addressGlyph(host)).toBe("🔓");
    expect(settingsRowGlyph(host)).toBe("🔓");
  });

  test("字形来自**落盘的**隐私模式状态（不是某一次点击留下的痕迹）", async () => {
    saveSettings({ privateMode: true });
    seedTab("http://127.0.0.1:1/");
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    expect(addressGlyph(host)).toBe("🔒");
  });
});
