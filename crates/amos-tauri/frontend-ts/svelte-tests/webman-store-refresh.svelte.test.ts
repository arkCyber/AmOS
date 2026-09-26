/**
 * webman-store-refresh.svelte.test.ts — 能被用户改动的存储**没有失效信号**，画面停在旧值上（REQ-A1230 / FMEA F-SH-512）。
 *
 * `localStorage` 不是响应式的：`loadBookmarks()` / `loadHistory()` 只读存储，Svelte 看不见它们。
 * 组件里**只有一路**补了这个信号 —— `downloadsTick`（`WebManApp.svelte` 里那段注释把原因写得很
 * 清楚：「a plain `$derived(loadDownloads())` would compute once and never notice a row added by a
 * background progress event」）。其余三处没有：
 *
 *   1. **收藏星** `{activeTab && isBookmarked(activeTab.url) ? "★" : "☆"}` —— `isBookmarked` 每次都真读
 *      存储，只是没人告诉它在存储变了之后重读一次（它依赖的只有 `activeTab`）⇒ 点 ☆ 收藏成功、
 *      存储里已经写进去了，星形**还是 ☆**。旁边那句注释（`toggleBookmark` 里「the glyph re-reads
 *      the store」）在后端写入这一步上是对的，在**重读**这一步上是错的 —— 它重读的时机并不存在。
 *   2. **收藏面板** `const bookmarks = $derived(loadBookmarks())` —— 面板打开着的时候再收藏一条，
 *      那一行不会出现（`$derived` 只在依赖变化时重算，而它的依赖是空的）。它此前看起来是好的，
 *      只是因为 `$derived` 惰性求值：第一次读发生在面板第一次渲染时，恰好晚于收藏。
 *   3. **历史面板** `filteredHistory` 只由 `debounce(…, 300)` 写，而那个防抖只挂在 `historyQuery` 上；
 *      空查询那一支又走**在挂载时就被冻住的** `history = $derived(loadHistory())`。于是本次会话
 *      访问过的页面在历史面板里**看不见**（显示「暂无历史记录」），点「清除历史」之后
 *      存储已清空、行却**留在屏幕上**。
 *
 * 这一族与 `project_setting_written_never_read` / `project_long_lived_component_snapshots_store_at_init`
 * 不同源：那里的值是**根本没写**或**冻在挂载**；这里是**写了、也读得到，但没人喊一声「重读」**。
 * 判定它的仪器是**从用户那一侧看**：动作做完之后，画面对不对得上存储。
 *
 * 用回环地址（happy-dom 会真去取 iframe 的 src，指向公网等于让测试触网，`net-sentinel.mjs` 明文禁止）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { HISTORY_KEY, TABS_KEY, loadBookmarks, loadHistory } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

const PAGE = "http://127.0.0.1:1/";
const OTHER = "http://127.0.0.1:2/";

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

/** `filteredHistory` 由 `debounce(…, 300)` 填充 —— 历史面板的行要等防抖窗口过去才出现。 */
const settleDebounced = async () => {
  await new Promise<void>((r) => setTimeout(r, 350));
  await tick();
};

const seedTab = (url: string) =>
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [{ id: "tab-1", url, title: url, favicon: "", loading: false, scrollY: 0, pinned: false }],
    }),
  );

const seedHistory = (rows: Array<{ url: string; title: string; visitedAt: number }>) =>
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify({ version: 1, data: rows }));

type Host = { container: HTMLElement };

const buttons = (h: Host) => [...h.container.querySelectorAll("button")] as HTMLButtonElement[];
const txt = (h: Host) => h.container.textContent ?? "";
const addressBar = (h: Host) => h.container.querySelector("input.pl-10") as HTMLInputElement;

/** 收藏星 —— 没有 aria-label，只能按字形认（它就是被测的那个字形）。 */
const star = (h: Host) => buttons(h).find((b) => (b.textContent ?? "").trim() === "☆" || (b.textContent ?? "").trim() === "★");

/** 走 ⋮ 菜单开一个侧栏（与「主页」那一轮同一条路径）。 */
async function openPanel(h: Host, label: string) {
  await fireEvent.click(buttons(h).find((b) => b.getAttribute("aria-label") === zh["webman.a11y.menu"])!);
  await settle();
  await fireEvent.click(buttons(h).find((b) => (b.textContent ?? "").includes(label))!);
  await settle();
}

async function mountDesktop() {
  setFormFactor("desktop");
  const host = render(WebManApp);
  await settle();
  return host;
}

describe("REQ-A1230: 用户改得动存储，画面就必须跟上", () => {
  test("点 ☆ 收藏成功之后，星形自己变成 ★", async () => {
    seedTab(PAGE);
    const host = await mountDesktop();

    await fireEvent.click(star(host)!);
    await settle();

    // 存储那一半是对的（`addBookmark` 真写了）—— 错的只是画面没被告知重读。
    expect(loadBookmarks().length).toBe(1);
    expect(txt(host)).toContain("★");
  });

  test("收藏面板开着的时候再收藏一条，那一行要出现在列表里", async () => {
    seedTab(PAGE);
    const host = await mountDesktop();

    await openPanel(host, zh["webman.bookmarks"]);
    expect(txt(host)).toContain(zh["webman.noBookmarks"]);

    await fireEvent.click(star(host)!);
    await settle();

    expect(loadBookmarks().length).toBe(1);
    expect(txt(host)).not.toContain(zh["webman.noBookmarks"]);
  });

  test("本次会话访问过的页面出现在历史面板里", async () => {
    seedTab(PAGE);
    const host = await mountDesktop();
    // 先把挂载时那一次防抖窗口放过去 —— `history` 的**第一次**读就发生在那里（`$derived` 惰性求值，
    // 之后再没人让它重读）。真实形态是「开了浏览器、过一会儿再访问一个页面」；不先等这一下，
    // 挂载时那一次读会晚于下面的导航，把缺陷掩掉。
    await settleDebounced();

    await fireEvent.input(addressBar(host), { target: { value: OTHER } });
    await fireEvent.keyDown(addressBar(host), { key: "Enter" });
    await settle();
    expect(loadHistory().length).toBe(1);

    await openPanel(host, zh["webman.history"]);
    await settleDebounced();

    expect(txt(host)).not.toContain(zh["webman.noHistory"]);
    expect(txt(host)).toContain("127.0.0.1");
  });

  test("点「清除历史」之后，面板如实变空（行不能留在屏幕上）", async () => {
    seedHistory([
      { url: PAGE, title: "one", visitedAt: 1 },
      { url: OTHER, title: "two", visitedAt: 2 },
    ]);
    seedTab(PAGE);
    const host = await mountDesktop();

    await openPanel(host, zh["webman.history"]);
    await settleDebounced();
    expect(txt(host), "清除之前那两行在").toContain("one");

    await fireEvent.click(buttons(host).find((b) => (b.textContent ?? "").includes(zh["webman.clearHistory"]))!);
    await settleDebounced();

    expect(loadHistory().length).toBe(0);
    expect(txt(host)).toContain(zh["webman.noHistory"]);
    expect(txt(host)).not.toContain("one");
  });
});
