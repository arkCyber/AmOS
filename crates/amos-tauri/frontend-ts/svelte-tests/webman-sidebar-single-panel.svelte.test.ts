/**
 * webman-sidebar-single-panel.svelte.test.ts — 侧边栏一次只显示**一**个面板（REQ-A1087 / FMEA F-SH-400）。
 *
 * `WebManApp.svelte` 的侧边栏用一条 `{#if}{:else if}` 链在四个布尔量之间挑选，链序是
 * 书签 → 历史记录 → 下载内容 → 设置：`{#if showBookmarks}` / `{:else if showHistory}` /
 * `{:else if showDownloads}` / `{:else if showSettings}`。而**八个打开入口**（新标签页的四个快捷按钮 +
 * 菜单的四行）每个只置**自己那一个**为 `true`，从不清掉兄弟量。
 *
 * 于是某一个面板已经开着时，再去打开一个**链序靠后**的面板，屏幕上仍是原来那个 —— 因为链先命中靠前的
 * 真值。用户按下的那一行**什么也没发生**：书签开着时点「菜单 ▸ 历史记录」，侧边栏照旧是 ⭐ 书签。
 * 反向（先历史后书签）却成立，所以这不是「侧边栏坏了」而是**选择器坏了**：一次选择被四个位共同表达，
 * 而渲染顺序在替用户否决。
 *
 * 与「设计」的分野：**只有 ✕ 与 Escape 会把四个一起清掉** —— 关闭者知道四个是一个选择器，打开者不知道。
 *
 * 本文件两向都钉：靠后的面板要**替换**靠前的（拒绝向，旧实现在此红），靠前的面板也要替换靠后的
 * （反向半边，防「打开什么都没用」的假绿 —— 一个让所有入口都无效的"修复"会通过只钉一向的用例）。
 *
 * 用回环地址（`127.0.0.1`）：本仓 `net-sentinel.mjs` 禁止测试触网，回环立刻被拒、全程离线。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY } from "../src/lib/webman";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  // A live tab, so the **新标签页** quick-action row is not in the DOM: it carries the same
  // 书签/历史记录 labels as the menu rows, and a first-match search would then find it instead.
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [
        {
          id: "tab-1",
          url: "http://127.0.0.1:1/",
          title: "A",
          favicon: "",
          loading: false,
          scrollY: 0,
          pinned: false,
        },
      ],
    }),
  );
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const buttons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")] as HTMLButtonElement[];

/** 侧边栏标题 —— 只有侧边栏的 `<h2 class="... flex-1 ...">` 在 `div.w-72` 里。 */
const sidebarHeader = (h: { container: HTMLElement }) =>
  (h.container.querySelector("div.w-72 h2")?.textContent ?? "").trim();

/** 历史记录面板**独有**的那枚搜索框；书签面板没有它（同一个 `{:else if}` 分支管着头与身）。 */
const hasHistorySearch = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("input")].some(
    (i) => i.getAttribute("placeholder") === zh["webman.searchHistory"],
  );

/** 打开 ⋮ 菜单 → 点一行 → 该面板出现。 */
async function openPanel(h: { container: HTMLElement }, label: string) {
  const menu = buttons(h).find((b) => b.getAttribute("aria-label") === zh["webman.a11y.menu"]);
  expect(menu, "⋮ 菜单按钮应当存在").toBeTruthy();
  await fireEvent.click(menu as HTMLButtonElement);
  await settle();
  const row = buttons(h).find((b) => (b.textContent ?? "").includes(label));
  expect(row, `菜单里应当有「${label}」这一行`).toBeTruthy();
  await fireEvent.click(row as HTMLButtonElement);
  await settle();
}

describe("WebManApp — 侧边栏一次只显示一个面板", () => {
  test("打开一个链序靠后的面板 ⇒ 它替换掉正在显示的那个，而不是被它压住", async () => {
    const h = render(WebManApp);
    await settle();

    await openPanel(h, zh["webman.bookmarks"]);
    expect(sidebarHeader(h)).toBe(zh["webman.bookmarks"]);
    expect(hasHistorySearch(h)).toBe(false);

    // 旧实现：`showHistory = true` 而 `showBookmarks` 仍为真，链先命中书签 ——
    // 屏幕上还是 ⭐ 书签，用户按下的这一行等于没按。
    await openPanel(h, zh["webman.history"]);
    expect(sidebarHeader(h)).toBe(zh["webman.history"]);
    expect(hasHistorySearch(h)).toBe(true);
  });

  test("反向半边：链序靠前的面板同样替换靠后的（防「打开什么都没用」的假绿）", async () => {
    const h = render(WebManApp);
    await settle();

    await openPanel(h, zh["webman.history"]);
    expect(sidebarHeader(h)).toBe(zh["webman.history"]);

    await openPanel(h, zh["webman.bookmarks"]);
    expect(sidebarHeader(h)).toBe(zh["webman.bookmarks"]);
    expect(hasHistorySearch(h)).toBe(false);
  });
});
