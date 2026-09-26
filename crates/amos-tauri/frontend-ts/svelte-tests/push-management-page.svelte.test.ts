/**
 * push-management-page.svelte.test.ts — 「推送通知管理」（`push_management`）页的 DOM 契约（REQ-A499）。
 *
 * 这一页此前渲染的是**一句硬编码英文占位**（`Push Notification Settings - Coming Soon`）：
 * `Sub` 成员、`PAGE_KEY` 标题、搜索别名、索引行、渲染分支**五件俱全**，所以
 * `settingsReach.test.ts`（它只比对「页面清单 ↔ 索引行」）和 `svelte-check` 都是绿的 ——
 * 缺陷恰恰在**分支体渲染什么**这一格，而那一格没有任何检查在看。
 *
 * 本文件钉住三件事：
 *   1. **同一份推送面板**（`data-testid="push-settings"` + `push-statistics`）在这里真的渲染 ——
 *      与「通知」页共用 `PushSettings.svelte`，因此不存在第二份实现；
 *   2. **推送历史**只列 `source === "push"` 的行（系统通知是「通知」页的事），空时给空态文案；
 *   3. 「清除推送历史」之后**这一页自己**不再显示那些行（`PushSettings` 回调把剩下的列表交回来）；
 *   4. **页面开着时到达的推送立即出现** —— `osPushWatcher` 每 5 秒轮询设备历史并写回同一个键，
 *      所以这一页必须**订阅** `amos.notifications`，而不是只在挂载那一刻读一次快照（REQ-A1310 /
 *      F-SH-584；「通知」页的同一份缺陷已在 REQ-A1238 修过，这一页是漏掉的孪生）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import PushManagementPage from "../src/svelte/settings/PushManagementPage.svelte";
import { NOTIF_KEY } from "../src/lib/settings";
import { STORE_CHANGED_EVENT } from "../src/lib/amosStore";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

/** See `notifications-page-push.svelte.test.ts` for the shared shape of this fake host. */
function bridgeWithStatus(status: unknown) {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "push_get_status") return status;
      if (cmd === "push_clear_history") return { kind: "ok" };
      return null;
    },
    listen: async () => () => {},
  };
}

const AVAILABLE = {
  available: true,
  // REQ-A865: `permission: "authorized"` is only reachable from a host that can actually
  // ask the OS, so the fixture has to name the API it would ask. Without this the fixture
  // describes a state the Rust side cannot produce — which is how the fabricated grant went
  // unnoticed for so long.
  permission_backend: "UNUserNotificationCenter",
  device_token: { token: "tok-abc", environment: "development", registered_at: "2026-09-19T00:00:00Z" },
  permission: "authorized",
  badge_count: 0,
  statistics: {
    total_received: 7,
    with_badge: 2,
    with_sound: 3,
    silent: 2,
    last_received: "2026-09-19T01:02:03Z",
  },
};

const MIXED = [
  { id: "push_1", source: "push" as const, time: 1_700_000_000_000, icon: "📩", read: false, title: "推送一" },
  { id: "sys_1", time: 1_700_000_100_000, icon: "🔔", read: false, title: "系统一" },
  { id: "push_2", source: "push" as const, time: 1_700_000_200_000, icon: "📩", read: false, title: "推送二" },
];


describe("push_management 页", () => {
  test("渲染的是真实推送面板，而不是占位文案", async () => {
    bridgeWithStatus(AVAILABLE);
    const host = render(PushManagementPage);
    await settle();

    expect(host.container.querySelector('[data-testid="push-settings"]')).not.toBeNull();
    expect(host.container.querySelector('[data-testid="push-statistics"]')).not.toBeNull();
    // 占位串（以及它的中文说法）不许回来。
    const text = host.container.textContent ?? "";
    expect(text).not.toContain("Coming Soon");
    expect(text).not.toContain("即将推出");
  });

  test("统计块显示四个计数器（与 Rust 形状一致）", async () => {
    bridgeWithStatus(AVAILABLE);
    const host = render(PushManagementPage);
    await settle();

    const text = host.container.querySelector('[data-testid="push-statistics"]')?.textContent ?? "";
    expect(text).toContain(zh["pushSettings.totalReceived"]);
    expect(text).toContain("7");
    expect(text).toContain(zh["pushSettings.withBadge"]);
    expect(text).toContain(zh["pushSettings.withSound"]);
    expect(text).toContain(zh["pushSettings.silent"]);
  });

  test("后端不可用时统计块**不**渲染（与「通知」页同一条诚实规则）", async () => {
    bridgeWithStatus({ ...AVAILABLE, available: false });
    const host = render(PushManagementPage);
    await settle();

    expect(host.container.querySelector('[data-testid="push-statistics"]')).toBeNull();
    expect(host.container.textContent ?? "").toContain(zh["pushSettings.unavailable"]);
  });

  test("推送历史只列出推送来源的行，系统通知不在这里", async () => {
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify(MIXED));
    bridgeWithStatus(AVAILABLE);
    const host = render(PushManagementPage);
    await settle();

    const text = host.container.querySelector('[data-testid="push-history"]')?.textContent ?? "";
    expect(text).toContain("推送一");
    expect(text).toContain("推送二");
    expect(text).not.toContain("系统一");
    expect(text).toContain(zh["pushSettings.historyCount"].replace("{n}", "2"));
  });

  test("没有推送时给出空态文案（不假装有历史）", async () => {
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify([MIXED[1]])); // 只有系统通知
    bridgeWithStatus(AVAILABLE);
    const host = render(PushManagementPage);
    await settle();

    expect(host.container.textContent ?? "").toContain(zh["pushSettings.historyEmpty"]);
  });

  test("清除推送历史后：存储与本页列表都只剩系统通知", async () => {
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify(MIXED));
    bridgeWithStatus(AVAILABLE);
    const host = render(PushManagementPage);
    await settle();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const clearBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(zh["pushSettings.clearAll"]),
    ) as HTMLButtonElement;
    await fireEvent.click(clearBtn);
    await settle();
    confirmSpy.mockRestore();

    const stored = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]");
    expect(stored.map((n: { id: string }) => n.id)).toEqual(["sys_1"]);
    // The page's own list must follow the store through the callback (otherwise it would keep
    // rendering rows the device no longer has).
    const history = host.container.querySelector('[data-testid="push-history"]')?.textContent ?? "";
    expect(history).not.toContain("推送一");
    expect(history).toContain(zh["pushSettings.historyEmpty"]);
  });

  test("历史超过上限时给出「另有 N 条」（复用通知页的同一文案）", async () => {
    const many = Array.from({ length: 23 }, (_, i) => ({
      id: `push_${i}`,
      source: "push" as const,
      time: 1_700_000_000_000 + i,
      icon: "📩",
      read: false,
      title: `推送 ${i}`,
    }));
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify(many));
    bridgeWithStatus(AVAILABLE);
    const host = render(PushManagementPage);
    await settle();

    expect(host.container.textContent ?? "").toContain(
      zh["settings.notifMore"].replace("{n}", "3"),
    );
  });

  test("页面开着的时候到达的推送会立即出现（订阅存储，而不是打开那一刻的快照）", async () => {
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify([MIXED[1]])); // 只有系统通知
    bridgeWithStatus(AVAILABLE);
    const host = render(PushManagementPage);
    await settle();
    expect(host.container.textContent ?? "").toContain(zh["pushSettings.historyEmpty"]);

    // `osPushWatcher` 的一跳：新推送被写进同一个键，并在本窗口广播 store-changed。
    const arrived = {
      id: "push_new",
      source: "push" as const,
      time: 1_700_000_900_000,
      icon: "📩",
      read: false,
      title: "推送新到",
    };
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify([arrived, MIXED[1]]));
    window.dispatchEvent(new CustomEvent(STORE_CHANGED_EVENT, { detail: { key: NOTIF_KEY } }));
    await settle();

    const history = host.container.querySelector('[data-testid="push-history"]')?.textContent ?? "";
    expect(history).toContain("推送新到");
    expect(history).toContain(zh["pushSettings.historyCount"].replace("{n}", "1"));
  });
});
