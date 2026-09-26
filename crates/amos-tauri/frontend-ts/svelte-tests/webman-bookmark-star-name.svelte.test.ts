/**
 * webman-bookmark-star-name.svelte.test.ts — 收藏星要有名字，而且删的是同一颗星说它删的那一条（REQ-A1347 / FMEA F-SH-612）。
 *
 * 两件事，都在工具条上那颗 ★ 上：
 *
 * 1. **名字**。★ 是那一行里唯一没有可访问名的控件（左边的地址栏、右边的 ⎋ 与 ⋮ 都有），
 *    字形 `★` / `☆` 不是一个名字 —— 读屏软件念出来只是一个符号，用户无从知道按下去会发生
 *    什么。按它**当下会做什么**取名：实心 ⇒ 移除书签，空心 ⇒ 收藏此页。空标签页（`url === ""`）
 *    没有可收藏的东西，与邻居 `⎋` 同一处理：`disabled` + 变暗，而不是按下去什么都不发生。
 *
 * 2. **同一个谓词**。`isBookmarked` 判的是 `sanitizeUrl` **规范化后**的 URL（`new URL(x)
 *    .toString()` 会把主机名折小写、给无路径的地址补上结尾 `/`），而存储里的 `b.url` 是
 *    `addBookmark` 写下的那一份规范化形态；移除分支原先却用**原始串** `b.url === activeTab.url`
 *    去 `find`。于是两个判据可以给出两个答案：★ 是实心的、点下去找不到那一条、`if (bookmark)`
 *    落空 —— 一个「看得见、点得动、没反应」的控件，连一句提示都没有。
 *
 * 三条都走**真存储**（只种 localStorage，不 mock `lib/webman`）：第 1、2 条是名字与禁用，
 * 第 3 条是本文件的核心 —— 页签里是原始形态、盘上是规范化形态，点一下 ★ 必须真的删掉它。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { BOOKMARKS_KEY, TABS_KEY, loadBookmarks } from "../src/lib/webman";
import { zh } from "../src/i18n/locales/zh";

/** 页签里那一份 URL 的形态（大小写 + 无路径）——`sanitizeUrl` 会把它折成下面那个。 */
const RAW = "https://Example.COM";
/** `addBookmark(RAW)` 落盘的那一份（`new URL(RAW).toString()`）。 */
const STORED = "https://example.com/";

const seedTabs = (url: string, title = "A") =>
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [{ id: "tab-1", url, title, favicon: "", loading: false, scrollY: 0, pinned: false }],
    }),
  );

/** 盘上一条书签 —— 用 `addBookmark` 真正写过的形态（规范化后的 URL）。 */
const seedBookmark = () =>
  window.localStorage.setItem(
    BOOKMARKS_KEY,
    JSON.stringify({
      version: 1,
      data: [{ id: "bm-1", url: STORED, title: "A", favicon: "", createdAt: 1 }],
    }),
  );

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")] as HTMLButtonElement[];
/** 工具条上的收藏星：按**字形**认，它现在也有 aria-label 了（分类不能再靠"没标签"）。 */
const star = (h: { container: HTMLElement }) =>
  buttons(h).find((b) => ["★", "☆"].includes((b.textContent ?? "").trim()));

describe("WebManApp — 收藏星的名字与禁用", () => {
  test("空标签页 ⇒ 星变灰不可按，且名字说得出它不能做什么", async () => {
    seedTabs("");
    const h = render(WebManApp);
    await settle();

    const b = star(h);
    expect(b, "工具条应有收藏星").toBeTruthy();
    expect(b!.textContent?.trim()).toBe("☆");
    expect(b!.disabled, "空标签页没有可收藏的 URL").toBe(true);
    expect(b!.getAttribute("aria-label"), "字形不是名字").toBe(zh["webman.addBookmark"]);
  });

  test("已收藏的页面 ⇒ 名字改成它这一按**会做**的事（移除），且可按下", async () => {
    seedTabs(STORED);
    seedBookmark();
    const h = render(WebManApp);
    await settle();

    const b = star(h);
    expect(b!.textContent?.trim()).toBe("★");
    expect(b!.disabled).toBe(false);
    expect(b!.getAttribute("aria-label")).toBe(zh["webman.removeBookmark"]);
  });

  test("未收藏的页面 ⇒ 名字是「收藏此页」", async () => {
    seedTabs(STORED);
    const h = render(WebManApp);
    await settle();

    const b = star(h);
    expect(b!.textContent?.trim()).toBe("☆");
    expect(b!.getAttribute("aria-label")).toBe(zh["webman.addBookmark"]);
  });
});

describe("WebManApp — ★ 说它删的那一条，就是它实际删掉的那一条", () => {
  test("页签是原始形态、盘上是规范化形态 ⇒ 一按真的删掉（不是空点）", async () => {
    seedTabs(RAW);
    seedBookmark();
    const h = render(WebManApp);
    await settle();

    // 前置：星是实心的（`isBookmarked` 认这个 URL），所以用户有理由期待它能被取消。
    expect(star(h)!.textContent?.trim(), "★ 是实心的 ⇒ 用户会去点它").toBe("★");

    await fireEvent.click(star(h)!);
    await settle();

    expect(txt(h)).toContain(zh["webman.toast.bookmarkRemoved"]);
    // 旧写法用原始串 `find` ⇒ 找不到那一行 ⇒ 既没有提示、盘上也没动，星还亮着。
    expect(loadBookmarks(), "盘上真的删掉了").toEqual([]);
  });
});
