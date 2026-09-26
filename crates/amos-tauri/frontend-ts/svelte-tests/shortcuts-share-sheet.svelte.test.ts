/**
 * shortcuts-share-sheet.svelte.test.ts — the share-target *producer* (REQ-A703).
 *
 * `Shortcut.quickActions` was a declaration with no producer: a user could not mark
 * a shortcut to appear in the system share sheet, so even with the sheet built the
 * target list would always be empty. This pins the editor switch that writes it —
 * including the round trip back through storage, which is what the sheet reads.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ShortcutsApp from "../src/svelte/ShortcutsApp.svelte";
import { loadShortcuts, saveShortcuts, type Shortcut } from "../src/lib/shortcuts";
import { shareSheetTargets } from "../src/lib/shareSheet";
import { webhookManager } from "../src/lib/enterprise/webhooks";
import { zh } from "../src/i18n/locales/zh";

const seedShortcut = (): Shortcut => ({
  id: "sc-seed",
  name: "收藏文章",
  icon: "⚡",
  color: "#007AFF",
  description: "",
  actions: [],
  quickActions: [],
  triggers: [],
  createdAt: 0,
  updatedAt: 0,
  runCount: 0,
  runOnLockScreen: false,
  requiresConfirmation: false,
  tags: [],
});

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  saveShortcuts([seedShortcut()]);
});
afterEach(() => {
  cleanup();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const stored = () => loadShortcuts()[0]!;

async function openEditor(host: { container: HTMLElement }) {
  const edit = [...host.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === zh["shortcuts.edit"],
  ) as HTMLButtonElement | undefined;
  expect(edit).toBeTruthy();
  await fireEvent.click(edit!);
  await settle();
}

const toggle = (host: { container: HTMLElement }) =>
  host.container.querySelector('[data-testid="shortcut-share-sheet-toggle"]') as HTMLButtonElement;

describe("REQ-A703: 编辑器能把指令设为分享面板目标", () => {
  test("开关写存储，且分享面板真的会列出来；再关掉则移除", async () => {
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);

    expect(toggle(host).getAttribute("aria-checked")).toBe("false");
    await fireEvent.click(toggle(host));
    await settle();

    expect(stored().quickActions).toEqual(["shareSheet"]);
    expect(toggle(host).getAttribute("aria-checked")).toBe("true");
    // 生产者与消费者对上：面板的目标列表会包含它。
    expect(shareSheetTargets(loadShortcuts()).map((s) => s.id)).toContain("sc-seed");

    await fireEvent.click(toggle(host));
    await settle();
    expect(stored().quickActions).toEqual([]);
    expect(shareSheetTargets(loadShortcuts())).toHaveLength(0);
  });
});

/**
 * REQ-A980: 这个开关是面板上那个 `shortcut_share` 事件的**唯一**发射点。
 *
 * 为什么这条在 `.svelte.test.ts` 里而不是 `src/lib/__tests__/enterprise-webhooks.test.ts`：
 * 发射写在组件里（`handleToggleShareSheet`），它的缝只有渲染这个组件才够得着 —— 与
 * `shortcuts-mdm-refusal.svelte.test.ts` 同理（那条钉的也是"按钮按下去之后发生了什么"）。
 *
 * 断言的落点是入队口：把单例的 `trigger` 换成一个记录器，于是这条用例既**同步**、
 * 又不会往共享队列里留下一两条要等 1 秒才被排空的残留。
 */
describe("REQ-A980: 分享开关发出 shortcut_share", () => {
  test("开启时发一条（带 id 与名字），关闭时**不**发 —— 这个事件说的是「它现在是分享目标了」", async () => {
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    const real = webhookManager.trigger;
    webhookManager.trigger = (async (event: string, data: unknown) => {
      seen.push({ event, data: data as Record<string, unknown> });
    }) as typeof webhookManager.trigger;

    try {
      const host = render(ShortcutsApp);
      await settle();
      await openEditor(host);

      await fireEvent.click(toggle(host));
      await settle();
      // 两次事件，各说一件事：这次开关**就是**一次 `updateShortcut`（`quickActions` 变了，
      // 与直接改名字走的是同一条写路径，所以它也发自身的 `shortcut_update`），而
      // `shortcut_share` 是"它现在是分享目标了"这句面板上的话。
      expect(seen.map((s) => s.event)).toEqual(["shortcut_update", "shortcut_share"]);
      expect(seen[0]!.data).toMatchObject({ shortcutId: "sc-seed", changed: ["quickActions"] });
      expect(seen[1]!.data).toMatchObject({ shortcutId: "sc-seed", name: "收藏文章" });

      await fireEvent.click(toggle(host));
      await settle();
      // 关掉时**不再**发 `shortcut_share`：这个事件只宣告"成为目标"，取消共享由那条
      // `shortcut_update`（`changed:["quickActions"]`）如实说清。
      expect(seen.map((s) => s.event)).toEqual([
        "shortcut_update",
        "shortcut_share",
        "shortcut_update",
      ]);
    } finally {
      delete (webhookManager as { trigger?: unknown }).trigger;
      expect(webhookManager.trigger).toBe(real);
    }
  });
});
