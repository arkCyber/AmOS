/**
 * webman-bookmark-refusal.svelte.test.ts — 「取消收藏」的判定必须被读到（REQ-A1064 / FMEA F-SH-379）。
 *
 * `removeBookmark(id): boolean` 问过存储才作答：它经 `saveBookmarkStore` 调
 * `writeStoreValueChecked`，版本冲突 / 存储写不进 / 抛错都回 `false`。同一文件里**添加**分支
 * 读了自己那半的判定（`const result = addBookmark(...); if (result) ... else ...`），而**移除**
 * 分支把它丢掉了：`WebManApp.svelte` 的 ★ 开关无条件播报「已取消收藏」，可星形是重读存储画出来
 * 的，于是屏幕上出现**自相矛盾**的一对（toast 说取消了，★ 还在）；书签列表里的 ✕ 更糟 —— 行还
 * 在、却**什么都没说**，一次没生效的删除看起来像按了个空的按钮。
 *
 * 本文件钉住两处都读判定，且**两向**都钉（拒绝 ⇒ 说失败；成功 ⇒ 说成功），因为只钉拒绝向会用
 * 「一律报失败」的假绿通过。
 *
 * 用的是**回环**地址（`127.0.0.1`）：本仓 `net-sentinel.mjs` 禁止测试触网，回环立刻被拒、全程离线。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY } from "../src/lib/webman";
import { zh } from "../src/i18n/locales/zh";

const removeBookmark = vi.hoisted(() => vi.fn(() => true));
const BOOKMARK = {
  id: "b1",
  url: "http://127.0.0.1:1/",
  title: "A",
  favicon: "",
  createdAt: 1,
};

// 只换掉「书签」这一族：让 `isBookmarked` 恒真（页签已收藏）、`loadBookmarks` 返回一行、
// `removeBookmark` 由用例决定成败。其余（`loadTabs`/`sanitizeUrl`/…）走真实现。
vi.mock("../src/lib/webman", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    removeBookmark,
    loadBookmarks: () => [BOOKMARK],
    isBookmarked: () => true,
  };
});

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [
        { id: "tab-1", url: BOOKMARK.url, title: "A", favicon: "", loading: false, scrollY: 0, pinned: false },
      ],
    }),
  );
  removeBookmark.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  removeBookmark.mockReset();
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")] as HTMLButtonElement[];
const btnByAria = (h: { container: HTMLElement }, label: string) =>
  buttons(h).find((b) => b.getAttribute("aria-label") === label);
const btnByText = (h: { container: HTMLElement }, t: string) =>
  buttons(h).find((b) => (b.textContent ?? "").trim() === t);

/** 打开 ⋮ 菜单 → 点「书签」→ 侧边栏的书签列表出现。 */
async function openBookmarksPanel(h: { container: HTMLElement }) {
  await fireEvent.click(btnByAria(h, zh["webman.a11y.menu"])!);
  await settle();
  const item = buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.bookmarks"]));
  await fireEvent.click(item!);
  await settle();
}

describe("WebManApp — 取消收藏的判定被读到（拒绝说失败、成功说成功）", () => {
  test("★ 开关：存储拒了这次移除 ⇒ 说「取消收藏失败」，而不是「已取消收藏」", async () => {
    removeBookmark.mockReturnValue(false);
    const h = render(WebManApp);
    await settle();

    await fireEvent.click(btnByText(h, "★")!);
    await settle();

    expect(txt(h)).toContain(zh["webman.toast.bookmarkRemoveFailed"]);
    // 旧的谎：无论存储是否接受都播报「已取消收藏」。
    expect(txt(h)).not.toContain(zh["webman.toast.bookmarkRemoved"]);
  });

  test("★ 开关：存储收下了 ⇒ 说「已取消收藏」（反向半边，防「一律报失败」假绿）", async () => {
    const h = render(WebManApp);
    await settle();

    await fireEvent.click(btnByText(h, "★")!);
    await settle();

    expect(txt(h)).toContain(zh["webman.toast.bookmarkRemoved"]);
    expect(txt(h)).not.toContain(zh["webman.toast.bookmarkRemoveFailed"]);
  });

  test("书签列表的 ✕：存储拒了 ⇒ 至少说一句，而不是静默把行留在原地", async () => {
    removeBookmark.mockReturnValue(false);
    const h = render(WebManApp);
    await settle();
    await openBookmarksPanel(h);

    // 列表行里的 ✕ —— 它自己带 aria-label（REQ-A1332）。按**字形**再筛一道：★ 开关在已收藏
    // 时用同一个 `webman.removeBookmark` 命名（REQ-A1347 按它当下会做什么取名），只按
    // aria-label 找会先摸到工具条上那颗星。
    const rowX = buttons(h).find(
      (b) =>
        b.getAttribute("aria-label") === zh["webman.removeBookmark"] &&
        (b.textContent ?? "").trim() === "✕",
    );
    expect(rowX, "书签列表应有一个行内 ✕").toBeTruthy();
    await fireEvent.click(rowX!);
    await settle();

    expect(txt(h)).toContain(zh["webman.toast.bookmarkRemoveFailed"]);
  });
});
