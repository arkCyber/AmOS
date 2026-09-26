/**
 * webman-history-time.svelte.test.ts — 历史时间的语言由 **UI 层**决定（REQ-A405）。
 *
 * 背景：`lib/webman.ts` 的 `formatTime` 原来直接返回**中文**（`"昨天"` / `"未知时间"`），
 * 在本仓的双语界面下，English 的历史列表里会混进一行中文 —— 而 `i18n-scan.mjs` 只看
 * `.svelte` 的标记与 `<script>`，**看不见**一个普通函数返回的硬编码文案，所以这条漏了。
 *
 * 修法是把 lib 改成语言无关的描述符（`timeLabel` → `clock` / `weekday` / `date` /
 * `yesterday` / `unknown`），**词**（`yesterday` / `unknown`）交给本屏用 `t()` 渲染。
 * `lib/__tests__` 已经钉住描述符本身；本文件钉住"描述符 → 语言"这一层真的接线了，
 * 而且**没有中文从 lib 漏到 en**。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { HISTORY_KEY } from "../src/lib/webman";
import { setLocale } from "../src/svelte/locale.svelte";

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/**
 * `filteredHistory` 由 `debounce(…, 300)` 填充（`WebManApp` 的搜索防抖），所以面板里的行
 * 要等防抖窗口过去才出现 —— `settle()` 只推进微任务，喂不饱它。
 */
const settleDebounced = async () => {
  await new Promise<void>((r) => setTimeout(r, 350));
  await tick();
};

/** 一条「昨天」的历史：`timeLabel` 对它的判定与语言无关（回 `yesterday` 描述符）。 */
function seedYesterdayHistory() {
  window.localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify({
      version: 1,
      data: [
        {
          url: "https://example.com/",
          title: "Example",
          favicon: "",
          visitedAt: Date.now() - 86_400_000,
        },
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
  setLocale("zh");
});

/** 新标签页上的「历史」入口按钮（点开侧栏历史面板）。 */
function historyButton(host: { container: HTMLElement }, label: string): Element | undefined {
  return [...host.container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );
}

const CJK = /[一-鿿]/;

describe("REQ-A405: 历史时间跟随当前 locale，lib 不再吐中文", () => {
  test("en 下渲染 Yesterday，且**没有任何中日韩字符**漏出来", async () => {
    seedYesterdayHistory();
    setLocale("en");
    const host = render(WebManApp);
    await settle();

    const btn = historyButton(host, "History");
    expect(btn).toBeTruthy();
    await fireEvent.click(btn!);
    await settleDebounced();

    const text = host.container.textContent ?? "";
    expect(text).toContain("Yesterday");
    // 修前这里渲染的是硬编码的「昨天」—— English 界面里混一行中文。
    expect(CJK.test(text)).toBe(false);
  });

  test("zh 下同一时刻渲染「昨天」（同一个描述符，两种语言）", async () => {
    seedYesterdayHistory();
    setLocale("zh");
    const host = render(WebManApp);
    await settle();

    const btn = historyButton(host, "历史记录");
    expect(btn).toBeTruthy();
    await fireEvent.click(btn!);
    await settleDebounced();

    expect(host.container.textContent ?? "").toContain("昨天");
  });
});
