/**
 * share-sheet.svelte.test.ts — the system share sheet's DOM contract (REQ-A703).
 *
 * The consuming half of the share contract. `Shortcut.quickActions` declared
 * `"shareSheet"` while nothing read it; this island is what finally reads it, so
 * these tests pin that it (1) renders only when a *valid* payload is open, (2)
 * lists exactly the shortcuts that opted in, (3) forwards the payload as the
 * handler's `input`, and (4) closes on choose / scrim / Escape.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ShareSheet from "../src/svelte/ShareSheet.svelte";
import { closeShareSheet, openShareSheet, sharePayload } from "../src/svelte/shareSheetState.svelte";
import { saveShortcuts, type Shortcut } from "../src/lib/shortcuts";
import { zh } from "../src/i18n/locales/zh";

const executeShortcut = vi.fn(async () => ({
  success: true,
  duration: 1,
  actionsCompleted: 0,
  actionsTotal: 0,
}));

vi.mock("../src/lib/shortcuts", async (orig) => {
  const actual = await orig<typeof import("../src/lib/shortcuts")>();
  return { ...actual, executeShortcut: (...args: unknown[]) => executeShortcut(...args) };
});

const shortcut = (id: string, name: string, share: boolean): Shortcut => ({
  id,
  name,
  icon: "⚡",
  color: "#007AFF",
  description: "",
  actions: [],
  quickActions: share ? ["shareSheet"] : [],
  triggers: [],
  createdAt: 0,
  updatedAt: 0,
  runCount: 0,
  runOnLockScreen: false,
  requiresConfirmation: false,
  tags: [],
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

beforeEach(() => {
  window.localStorage.clear();
  executeShortcut.mockClear();
  closeShareSheet();
  saveShortcuts([shortcut("s-share", "发到备忘录", true), shortcut("s-quiet", "不分享", false)]);
});
afterEach(() => {
  cleanup();
  closeShareSheet();
  window.localStorage.clear();
});

describe("ShareSheet.svelte (REQ-A703)", () => {
  test("没有 payload 时不渲染", async () => {
    const host = render(ShareSheet);
    await settle();
    expect(host.container.querySelector('[data-testid="share-sheet"]')).toBeNull();
    expect(sharePayload()).toBeNull();
  });

  test("空内容被拒：不开面板、状态仍为空", async () => {
    const host = render(ShareSheet);
    await settle();
    expect(openShareSheet({ kind: "text", value: "   ", title: "空" })).toBe(false);
    await settle();
    expect(host.container.querySelector('[data-testid="share-sheet"]')).toBeNull();
    expect(sharePayload()).toBeNull();
  });

  test("列出声明了 shareSheet 的指令（且只有它）+ 内置拷贝", async () => {
    const host = render(ShareSheet);
    await settle();
    expect(openShareSheet({ kind: "file", value: "文件正文", title: "说明.txt" })).toBe(true);
    await settle();

    expect(host.container.querySelector('[data-testid="share-sheet"]')).toBeTruthy();
    expect(host.container.querySelector('[data-testid="share-target-s-share"]')).toBeTruthy();
    expect(host.container.querySelector('[data-testid="share-target-s-quiet"]')).toBeNull();
    expect(host.container.querySelector('[data-testid="share-target-copy"]')).toBeTruthy();
    // 标题与内容首行都在头部。
    expect(host.container.textContent ?? "").toContain("说明.txt");
    expect(host.container.textContent ?? "").toContain("文件正文");
  });

  test("点选一条指令：把内容作为 input 交给它，并关掉面板", async () => {
    const host = render(ShareSheet);
    await settle();
    openShareSheet({ kind: "text", value: "要分享的文字", title: "备注" });
    await settle();

    await fireEvent.click(
      host.container.querySelector('[data-testid="share-target-s-share"]') as HTMLButtonElement,
    );
    await settle();

    expect(executeShortcut).toHaveBeenCalledTimes(1);
    expect(executeShortcut.mock.calls[0]![0]).toBe("s-share");
    expect(executeShortcut.mock.calls[0]![1]).toBe("要分享的文字");
    expect(executeShortcut.mock.calls[0]![2]).toEqual({ confirmed: true });
    expect(host.container.querySelector('[data-testid="share-sheet"]')).toBeNull();
    expect(sharePayload()).toBeNull();
  });

  test("Escape 关闭；关闭按钮也关闭", async () => {
    const host = render(ShareSheet);
    await settle();
    openShareSheet({ kind: "text", value: "x", title: "t" });
    await settle();

    await fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    expect(host.container.querySelector('[data-testid="share-sheet"]')).toBeNull();

    openShareSheet({ kind: "text", value: "x", title: "t" });
    await settle();
    await fireEvent.click(
      host.container.querySelector('[data-testid="share-sheet-close"]') as HTMLButtonElement,
    );
    await settle();
    expect(host.container.querySelector('[data-testid="share-sheet"]')).toBeNull();
  });

  test("关掉之后目标快照被丢弃（不会留着上一条指令的列表）", async () => {
    const host = render(ShareSheet);
    await settle();
    openShareSheet({ kind: "text", value: "x", title: "t" });
    await settle();
    expect(host.container.querySelector('[data-testid="share-target-s-share"]')).toBeTruthy();

    await fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    expect(host.container.querySelector('[data-testid="share-target-s-share"]')).toBeNull();
  });

  test("没有可分享指令时，面板仍列内置目标与拷贝，且不说「没有目标」（REQ-A1917）", async () => {
    saveShortcuts([shortcut("s-quiet", "不分享", false)]);
    const host = render(ShareSheet);
    await settle();
    openShareSheet({ kind: "text", value: "x", title: "t" });
    await settle();

    // A library with nothing opted in is **not** an empty sheet any more: Notes and Mail
    // are always offered for a text payload (REQ-A1458). The old rule keyed the empty
    // state on the shortcut half alone, so this exact configuration drew the
    // 「还没有快捷指令，打开快捷指令开启分享菜单」 hint *underneath* two working rows —
    // a sentence telling the user there is nowhere to hand the content off to, an inch
    // below two places to hand it off to.
    expect(host.container.querySelector('[data-testid="share-target-copy"]')).toBeTruthy();
    expect(host.container.querySelector('[data-testid="share-target-notes"]')).toBeTruthy();
    expect(host.container.querySelector('[data-testid="share-target-mail"]')).toBeTruthy();
    expect(host.container.textContent ?? "").not.toContain(zh["shareSheet.noTargets"]);
  });
});
