/**
 * shortcuts-triggers.svelte.test.ts — the trigger editor's DOM contract (REQ-A702).
 *
 * The runtime for automation triggers was fully built (the Rust wall-clock ledger
 * plus the shell heartbeat, with signal sources for time/app/wifi/battery) but
 * `ShortcutsApp.svelte` contained **zero** occurrences of "trigger": there was no
 * way for a user to create one, so a time trigger — which really does wake the
 * device under Doze — could not be authored at all. This file pins the missing half:
 *   1. every type is offered, but the 7 with no host signal source are **disabled**
 *      and carry the reason (no switch that can never fire);
 *   2. adding a type writes a trigger with a sensible default to `amos.shortcuts`;
 *   3. editing the time / weekday / enable switch really persists.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ShortcutsApp from "../src/svelte/ShortcutsApp.svelte";
import { loadShortcuts, saveShortcuts, type Shortcut } from "../src/lib/shortcuts";
import { TRIGGER_KINDS } from "../src/lib/shortcutTriggerCatalog";
import { zh } from "../src/i18n/locales/zh";

const seedShortcut = (): Shortcut => ({
  id: "sc-seed",
  name: "每天早上",
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

/** 打开种子指令的编辑器（列表行的 ✏️ 按钮）。 */
async function openEditor(host: { container: HTMLElement }) {
  const edit = [...host.container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === zh["shortcuts.edit"],
  ) as HTMLButtonElement | undefined;
  expect(edit).toBeTruthy();
  await fireEvent.click(edit!);
  await settle();
}

const stored = () => loadShortcuts()[0]!;

describe("REQ-A702: 快捷指令编辑器能创建/编辑触发器", () => {
  test("添加菜单列出全部类型，但没有信号源的 7 种被禁用并给出原因", async () => {
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);

    await fireEvent.click(
      host.container.querySelector('[data-testid="trigger-add"]') as HTMLButtonElement,
    );
    await settle();

    for (const kind of TRIGGER_KINDS) {
      const option = host.container.querySelector(
        `[data-testid="trigger-option-${kind.type}"]`,
      ) as HTMLButtonElement | null;
      expect(option, kind.type).not.toBeNull();
      if (kind.unavailableReasonKey === null) {
        expect(option!.disabled, `${kind.type} 应有信号源`).toBe(false);
      } else {
        expect(option!.disabled, `${kind.type} 不可用应禁用`).toBe(true);
        expect(option!.textContent).toContain(zh["shortcuts.triggerNoSignal"]);
      }
    }
  });

  // REQ-A968: 添加按钮的标签是常量（「添加触发器」），选择器的开合只画在下方 DOM 里 ——
  // 没有 `aria-expanded` 时 AT 用户读到的名字两个状态完全相同，重按「打开」其实是在关闭。
  test("添加触发器按钮把展开态说给 AT（aria-expanded 随选择器开合）", async () => {
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);
    const add = () =>
      host.container.querySelector('[data-testid="trigger-add"]') as HTMLButtonElement;
    expect(add().getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(add());
    await settle();
    expect(add().getAttribute("aria-expanded")).toBe("true");
    await fireEvent.click(add());
    await settle();
    expect(add().getAttribute("aria-expanded")).toBe("false");
  });

  test("添加时间触发器 → 默认（每天 08:00）落盘；改时间/星期/开关都持久化", async () => {
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);

    await fireEvent.click(
      host.container.querySelector('[data-testid="trigger-add"]') as HTMLButtonElement,
    );
    await settle();
    await fireEvent.click(
      host.container.querySelector('[data-testid="trigger-option-time"]') as HTMLButtonElement,
    );
    await settle();

    const made = stored();
    expect(made.triggers.length).toBe(1);
    const trg = made.triggers[0]!;
    expect(trg.type).toBe("time");
    expect(trg.enabled).toBe(true);
    expect(trg.config).toEqual({ time: "08:00", days: [] });

    // 改时间
    await fireEvent.input(host.container.querySelector(`[data-testid="trigger-time-${trg.id}"]`)!, {
      target: { value: "09:30" },
    });
    await settle();
    expect((stored().triggers[0]!.config as { time: string }).time).toBe("09:30");

    // 选周一（ISO 1）
    await fireEvent.click(
      host.container.querySelector(`[data-testid="trigger-day-${trg.id}-1"]`) as HTMLButtonElement,
    );
    await settle();
    expect((stored().triggers[0]!.config as { days: number[] }).days).toEqual([1]);

    // 停用
    await fireEvent.click(
      host.container.querySelector(`[data-testid="trigger-toggle-${trg.id}"]`) as HTMLButtonElement,
    );
    await settle();
    expect(stored().triggers[0]!.enabled).toBe(false);
  });

  test("删除触发器把它从存储里移除", async () => {
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);

    await fireEvent.click(
      host.container.querySelector('[data-testid="trigger-add"]') as HTMLButtonElement,
    );
    await settle();
    await fireEvent.click(
      host.container.querySelector('[data-testid="trigger-option-app"]') as HTMLButtonElement,
    );
    await settle();

    const trg = stored().triggers[0]!;
    expect(trg.type).toBe("app");
    expect(trg.config).toEqual({ appId: "" });

    await fireEvent.click(
      host.container.querySelector(`[data-testid="trigger-remove-${trg.id}"]`) as HTMLButtonElement,
    );
    await settle();
    expect(stored().triggers).toEqual([]);
    expect(
      host.container.querySelector(`[data-testid="trigger-row-${trg.id}"]`),
    ).toBeNull();
  });

  test("Wi-Fi 触发器的时机选择落盘（连接/断开/任意）", async () => {
    const host = render(ShortcutsApp);
    await settle();
    await openEditor(host);

    await fireEvent.click(
      host.container.querySelector('[data-testid="trigger-add"]') as HTMLButtonElement,
    );
    await settle();
    await fireEvent.click(
      host.container.querySelector('[data-testid="trigger-option-wifi"]') as HTMLButtonElement,
    );
    await settle();

    const trg = stored().triggers[0]!;
    expect(trg.config).toEqual({ ssid: "", event: "connect" });

    await fireEvent.change(
      host.container.querySelector(`[data-testid="trigger-wifi-event-${trg.id}"]`)!,
      { target: { value: "disconnect" } },
    );
    await settle();
    expect((stored().triggers[0]!.config as { event: string }).event).toBe("disconnect");
  });
});
