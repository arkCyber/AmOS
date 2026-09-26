/**
 * webman-clear-history-refusal.svelte.test.ts — 「清空历史」的判定必须被读到（REQ-A1330 / FMEA F-SH-596）。
 *
 * `clearHistory()` 原先签成 `void`：它经 `writeStoreValue`（**吞掉拒绝**）落盘，调用方于是
 * 无从知道清没清掉。面板那颗「清空历史」更极端 —— 两个方向都沉默：清了不说，没清也不说。
 * 存储拒写时，屏幕上一行未少、也没有任何提示，一次**没发生**的清除看起来像按了个空的按钮。
 *
 * 同一族里已经有做对的：`clearCompletedDownloads(): boolean` 问过存储才作答（REQ-A1068），
 * `onClearCompleted` 成功说「清除已完成」、失败说「清除失败」。本文件把历史侧钉成同一形状。
 *
 * 两条用例**两向都钉**（拒绝 ⇒ 说失败；成功 ⇒ 说成功），因为只钉拒绝向会被「一律报失败」的
 * 假绿通过。用的是回环地址：`net-sentinel.mjs` 禁止测试触网。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { HISTORY_KEY, TABS_KEY } from "../src/lib/webman";
import { zh } from "../src/i18n/locales/zh";

const clearHistory = vi.hoisted(() => vi.fn(() => true));

// 只换掉「清除判定」这一处；`searchHistory` / `loadTabs` / `sanitizeUrl` 走真实现。
vi.mock("../src/lib/webman", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, clearHistory };
});

const ROW = {
  url: "http://127.0.0.1:1/",
  title: "A",
  favicon: "",
  visitedAt: 1,
};

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [
        { id: "tab-1", url: ROW.url, title: "A", favicon: "", loading: false, scrollY: 0, pinned: false },
      ],
    }),
  );
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify({ version: 1, data: [ROW] }));
  clearHistory.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  clearHistory.mockReset();
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

/** 打开 ⋮ 菜单 → 点「历史」→ 历史面板出现。 */
async function openHistoryPanel(h: { container: HTMLElement }) {
  await fireEvent.click(btnByAria(h, zh["webman.a11y.menu"])!);
  await settle();
  const item = buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.history"]));
  await fireEvent.click(item!);
  await settle();
  // 列表由 `debounce(…, 300)` 填 —— 这是它的节奏，不是被测的行为。
  await new Promise<void>((r) => setTimeout(r, 400));
  await settle();
}

const clearBtn = (h: { container: HTMLElement }) =>
  buttons(h).find((b) => (b.textContent ?? "").trim() === zh["webman.clearHistory"]);

describe("WebManApp — 「清空历史」的判定被读到（拒绝说失败、成功说成功）", () => {
  test("存储拒了这次清除 ⇒ 说「清空历史失败」，而不是「已清空历史」", async () => {
    clearHistory.mockReturnValue(false);
    const h = render(WebManApp);
    await settle();
    await openHistoryPanel(h);

    await fireEvent.click(clearBtn(h)!);
    await settle();

    expect(txt(h)).toContain(zh["webman.toast.historyClearFailed"]);
    // 旧的形状：两个方向都不说 —— 一行不少地留着，屏幕上一句提示都没有。
    expect(txt(h)).not.toContain(zh["webman.toast.historyCleared"]);
  });

  test("存储收下了 ⇒ 说「已清空历史」（反向半边，防「一律报失败」假绿）", async () => {
    const h = render(WebManApp);
    await settle();
    await openHistoryPanel(h);

    await fireEvent.click(clearBtn(h)!);
    await settle();

    expect(txt(h)).toContain(zh["webman.toast.historyCleared"]);
    expect(txt(h)).not.toContain(zh["webman.toast.historyClearFailed"]);
  });
});
