/**
 * webman-history-dup-time.svelte.test.ts — 历史列表的 keyed each 键必须唯一（REQ-A1169）。
 *
 * 缺陷：历史列表曾用 `(entry.visitedAt)` 作 keyed-each 键。而 `visitedAt = Date.now()`，
 * 快速程序化导航（同一毫秒内落两条）会让两条不同 URL 拿到**同一个** `visitedAt` ⇒ 键不唯一。
 * 去重发生在别处：`addToHistory` 用 Map 按 **url** 去重（`lib/webman.ts`），所以 **url 才是唯一的**，
 * `visitedAt` 不是。Svelte 的 keyed each 在键重复时行为未定义 —— 本文件用同一毫秒的两条记录钉住
 * 「两行都在、不抛」。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { HISTORY_KEY } from "../src/lib/webman";
import { zh } from "../src/i18n/locales/zh";

const SAME_MS = 1_700_000_000_000;

/** 两条**不同 URL**、`visitedAt` 完全相同的记录（快速程序化导航的真实形态）。 */
function seedDupTimeHistory() {
  window.localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify({
      version: 1,
      data: [
        { url: "https://example.com/alpha", title: "alpha", favicon: "", visitedAt: SAME_MS },
        { url: "https://example.com/beta", title: "beta", favicon: "", visitedAt: SAME_MS },
      ],
    }),
  );
}

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

/** `filteredHistory` 由 `debounce(…, 300)` 填充 —— 面板行要等防抖窗口过去才出现。 */
const settleDebounced = async () => {
  await new Promise<void>((r) => setTimeout(r, 350));
  await tick();
};

describe("REQ-A1169: 历史列表在同一毫秒的两条记录下仍画两行", () => {
  test("两条不同 URL、`visitedAt` 完全相同 ⇒ 两行都在，不抛", async () => {
    seedDupTimeHistory();
    const host = render(WebManApp);
    await settle();

    // 新标签页上的「历史」入口（与 webman-history-time 同一路径）。
    const btn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(zh["webman.history"]),
    );
    expect(btn, "新标签页应有「历史」入口").toBeTruthy();
    await fireEvent.click(btn!);
    await settleDebounced();

    const text = host.container.textContent ?? "";
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
  });
});
