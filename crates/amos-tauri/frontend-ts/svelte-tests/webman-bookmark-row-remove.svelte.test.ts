/**
 * webman-bookmark-row-remove.svelte.test.ts — 书签行里那颗 ✕ **删除成功之后行不消失**（REQ-A1258 / FMEA **F-SH-535**；与 F-SH-512 同族的第二个落地口）。
 *
 * 书签列表每一行右端有一颗 ✕，它的处理器是唯一一处**不**叫面板重读存储的书签写入：
 *
 * ```js
 * onclick={(e) => {
 *   e.stopPropagation();
 *   if (!removeBookmark(bookmark.id)) showToast(t("webman.toast.bookmarkRemoveFailed"));
 * }}
 * ```
 *
 * 旁白逐字写着「the row stays in the list **either way**, so silence reads as "the ✕ did nothing"」——
 * 这句前提本身就是缺陷的产物：行之所以两种结果都留在原地，是因为**没人喊重读**（面板读的是
 * `loadBookmarks()`，`localStorage` 不响应式）。于是成功与失败在屏幕上**完全一样**：
 *
 *   • 存储收下了这次删除 ⇒ 没声、行还在；
 *   • 存储拒了这次删除 ⇒ 有声（「书签仍在」）、行还在。
 *
 * 用户只能从「有没有 toast」反推结果，而反推出来的规律是**反的**：再点一次（同一个 id 已被删，
 * `removeBookmark` 回 false）才会看到「取消收藏失败——书签仍在」——第一次**成功**的点击，第二次
 * 被报成失败。姊妹路径（★ 开关）在同一轮里已经补上了失效信号（REQ-A1230 的 `bookmarksTick`），
 * 这颗 ✕ 是漏掉的第二个 `removeBookmark` 调用点。
 *
 * 拒绝那一向已由 `webman-bookmark-refusal.svelte.test.ts:113` 钉住（它把 `loadBookmarks` 换成常量
 * 列表，因此天然测不到「行该消失」）；本文件钉住**成功**那一向，用真实现 + 真存储。
 *
 * 用回环地址（happy-dom 会真去取 iframe 的 src，指向公网等于让测试触网，`net-sentinel.mjs` 明文禁止）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { BOOKMARKS_KEY, TABS_KEY, addBookmark, loadBookmarks } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

const PAGE = "http://127.0.0.1:1/";
/** 打开的页签**不是**那条书签 —— 免得 ★ 与列表混在一起读。 */
const OTHER = "http://127.0.0.1:2/";
const TITLE = "Alpha";

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [{ id: "tab-1", url: OTHER, title: OTHER, favicon: "", loading: false, scrollY: 0, pinned: false }],
    }),
  );
  addBookmark(PAGE, TITLE);
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

type Host = { container: HTMLElement };

const buttons = (h: Host) => [...h.container.querySelectorAll("button")] as HTMLButtonElement[];
const txt = (h: Host) => h.container.textContent ?? "";

/** 打开 ⋮ 菜单 → 点「书签」。 */
async function openBookmarksPanel(h: Host) {
  await fireEvent.click(buttons(h).find((b) => b.getAttribute("aria-label") === zh["webman.a11y.menu"])!);
  await settle();
  await fireEvent.click(buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.bookmarks"]))!);
  await settle();
}

/**
 * 书签行里那颗 ✕。
 *
 * 认它原先只能靠**没有** `aria-label`（同屏的标签页 ✕ / 下载 ✕ 都带名字）—— 而那正是
 * REQ-A1332 修的缺陷：一个没有可访问名的按钮。现在它自己带名字，按名字认。
 */
const rowX = (h: Host) =>
  buttons(h).find((b) => b.getAttribute("aria-label") === zh["webman.removeBookmark"]);

describe("REQ-A1258: 书签行的 ✕ 删成功之后，那一行必须真的离开列表", () => {
  test("存储收下了这次删除 ⇒ 行消失、空态出现（不能两种结果都留在原地）", async () => {
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();
    await openBookmarksPanel(host);
    expect(txt(host), "面板里应有那一行").toContain(TITLE);

    await fireEvent.click(rowX(host)!);
    await settle();

    // 存储那一半一直是对的 —— 错的只是面板没被告知重读。
    expect(loadBookmarks().length).toBe(0);
    expect(txt(host), "删掉的那一行不该还在列表里").not.toContain(TITLE);
    expect(txt(host)).toContain(zh["webman.noBookmarks"]);
  });

  test("拒绝那一向仍有话说（防「只让行消失、把判定吞掉」的假修）", async () => {
    // 删除一个**已经不在**存储里的 id：`removeBookmark` 回 false（旧实现与真实现都会）。
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();
    await openBookmarksPanel(host);

    // 先把存储清空，但让面板仍列着那一行（面板读的是渲染时的那份列表）。
    window.localStorage.removeItem(BOOKMARKS_KEY);
    await fireEvent.click(rowX(host)!);
    await settle();

    expect(txt(host)).toContain(zh["webman.toast.bookmarkRemoveFailed"]);
  });

  test("这颗 ✕ 有可访问名 —— 不再是同屏唯一一颗匿名的 ✕（REQ-A1332）", async () => {
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();
    await openBookmarksPanel(host);

    const x = rowX(host);
    expect(x, "书签行应有一颗移除按钮").toBeTruthy();
    // 同屏的另外两颗 ✕（标签页 / 下载行）都有名字；这一颗此前一个都没有，读屏器只会念「按钮」。
    expect(x!.getAttribute("aria-label")).toBe(zh["webman.removeBookmark"]);
  });
});
