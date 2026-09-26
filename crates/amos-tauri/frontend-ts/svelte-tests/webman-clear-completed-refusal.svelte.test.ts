/**
 * webman-clear-completed-refusal.svelte.test.ts — 「清除已完成」的判定必须被读到，且按钮只在它真能清的东西上点亮（REQ-A1068 / FMEA F-SH-383）。
 *
 * `clearCompletedDownloads()` 原先签成 `void`：它经 `saveDownloadStore` → `writeStoreValueChecked`
 * 问过存储才动手（版本冲突 / 存储拒写 / 抛错都耗完 3 次重试），却**无从作答**。调用方于是无条件
 * 播报「清除已完成」—— 存储拒了、屏幕上一行未少，toast 却说清完了。
 *
 * 同一颗 🧹 的 `disabled` 又比它做的事宽：`completed || failed` 就点亮，而函数只丢 `completed`。
 * 于是一个**只有失败行**的列表：按钮可点、点下去什么都没清、还播报「清除已完成」。失败 / 已取消
 * 的行各自带着「重试」，是**可恢复**的状态而不是垃圾，不该被 🧹 扫走。
 *
 * 三条用例把两半都钉住：拒写 ⇒ 说失败（不说成功）；收下 ⇒ 说成功（不说失败）；只有可恢复行 ⇒
 * 🧹 不可点。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { zh } from "../src/i18n/locales/zh";

type Row = {
  id: string;
  url: string;
  filename: string;
  progress: number;
  status: string;
  createdAt: number;
};

const clearCompletedDownloads = vi.hoisted(() => vi.fn(() => true));
const loadDownloads = vi.hoisted(() => vi.fn(() => [] as Row[]));

const COMPLETED: Row = {
  id: "d-done",
  url: "http://127.0.0.1:1/a.bin",
  filename: "a.bin",
  progress: 100,
  status: "completed",
  createdAt: 1,
};
const FAILED: Row = {
  id: "d-failed",
  url: "http://127.0.0.1:1/b.bin",
  filename: "b.bin",
  progress: 0,
  status: "failed",
  createdAt: 1,
};

// 只换掉「下载列表的读取」与「清除判定」这两处；其余（`loadTabs`/`sanitizeUrl`/…）走真实现。
vi.mock("../src/lib/webman", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, clearCompletedDownloads, loadDownloads };
});

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  loadDownloads.mockReturnValue([COMPLETED]);
  clearCompletedDownloads.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  clearCompletedDownloads.mockReset();
  loadDownloads.mockReset();
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

/** 打开 ⋮ 菜单 → 点「下载」→ 下载面板出现。 */
async function openDownloadsPanel(h: { container: HTMLElement }) {
  await fireEvent.click(btnByAria(h, zh["webman.a11y.menu"])!);
  await settle();
  const item = buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.downloads"]));
  await fireEvent.click(item!);
  await settle();
}

describe("WebManApp — 清除已完成的判定被读到 + 按钮只对可清的项点亮", () => {
  test("存储拒了这次清除 ⇒ 说「清除失败」，而不是「清除已完成」", async () => {
    clearCompletedDownloads.mockReturnValue(false);
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    await fireEvent.click(btnByAria(h, zh["webman.download.clearCompleted"])!);
    await settle();

    expect(txt(h)).toContain(zh["webman.download.clearFailed"]);
    // 旧的谎：无论存储是否接受都播报「清除已完成」。
    expect(txt(h)).not.toContain(zh["webman.download.clearCompleted"]);
  });

  test("存储收下了 ⇒ 说「清除已完成」（反向半边，防「一律报失败」假绿）", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    await fireEvent.click(btnByAria(h, zh["webman.download.clearCompleted"])!);
    await settle();

    expect(txt(h)).toContain(zh["webman.download.clearCompleted"]);
    expect(txt(h)).not.toContain(zh["webman.download.clearFailed"]);
  });

  test("列表只剩失败行（可重试、不该被扫走）⇒ 🧹 不可点", async () => {
    loadDownloads.mockReturnValue([FAILED]);
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    const broom = btnByAria(h, zh["webman.download.clearCompleted"]);
    expect(broom, "🧹 按钮应存在").toBeTruthy();
    expect(broom!.disabled).toBe(true);
    // 失败行自己的「重试」入口仍在（它是可恢复状态，不是垃圾）。
    expect(btnByAria(h, zh["webman.download.retry"])).toBeTruthy();
  });
});
