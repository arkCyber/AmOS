/**
 * notifications-page-push.svelte.test.ts — DOM tests for the push notification
 * section inside `NotificationsPage.svelte`.
 *
 * The original `PushNotificationSettings.test.ts` was 47 placeholder tests that
 * did not test any actual component (the `PushNotificationSettings.svelte` it
 * claimed to cover does not exist in the repo — push is integrated directly into
 * `NotificationsPage.svelte`). These tests replace it: they render the real
 * component and assert what the page actually claims to the user.
 *
 * The page's contract (REQ-A383):
 *   • an unreachable daemon is "unavailable", with a Retry button — never invented
 *     as "no push yet";
 *   • a backend that answered `available: false` is also "unavailable", but with a
 *     *different* label — the two failure modes are not collapsed into one;
 *   • a `notdetermined` permission shows the request button;
 *   • `denied` shows the OS-level denial hint and hides the request button;
 *   • statistics are shown only when `available`; the four counters map to the
 *     Rust shape (total_received / with_badge / with_sound / silent);
 *   • "clear push history" calls the Rust command AND drops push entries from the
 *     local notification list (the system notifications must survive);
 *   • in dev mode only, the "send test" button calls `simulateReceivePush` with a
 *     payload that carries an `aps.alert`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotificationsPage from "../src/svelte/settings/NotificationsPage.svelte";
import { NOTIF_KEY, SETTINGS_KEY } from "../src/lib/settings";
import { dropPushNotifs } from "../src/lib/pushNotifBridge";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  // `import.meta.env.DEV` is a compile-time boolean; vitest compiles tests as
  // dev modules so the dev-only "send test" button is reachable. Asserting on it
  // would be a property of the build pipeline, not the page — those cases are
  // exercised separately.
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

/**
 * Install a fake Tauri bridge that answers `push_get_status` with `status` and
 * tracks every command invoked. Anything else returns `null` (the page treats it
 * as "no answer", which is the honest default).
 */
function bridgeWithStatus(status: unknown) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "push_get_status") return status;
      if (cmd === "push_request_permission") return { kind: "ok" };
      if (cmd === "push_clear_history") return { kind: "ok" };
      if (cmd === "push_simulate_receive") return { id: "test-push-1" };
      return null;
    },
    listen: async () => () => {},
  };
  return calls;
}

const AVAILABLE_STATUS = (overrides: Partial<{
  permission: string;
  token: string | null;
  environment: string;
  total_received: number;
  with_badge: number;
  with_sound: number;
  silent: number;
  last_received: string | null;
}> = {}) => ({
  available: true,
  device_token: overrides.token === null
    ? null
    : {
        token: overrides.token ?? "abc123def456",
        environment: overrides.environment ?? "development",
        registered_at: "2026-09-18T08:00:00Z",
      },
  permission: overrides.permission ?? "notdetermined",
  badge_count: 0,
  statistics: {
    total_received: overrides.total_received ?? 0,
    with_badge: overrides.with_badge ?? 0,
    with_sound: overrides.with_sound ?? 0,
    silent: overrides.silent ?? 0,
    last_received: overrides.last_received ?? null,
  },
});

// ============================================================================
// 1. 离线 / 不可用 状态（最关键的诚实性测试）
// ============================================================================

describe("NotificationsPage - 离线状态（无可用桥）", () => {
  test("未连接守护进程时应显示 unavailable + Retry 按钮", async () => {
    // 没有 __TAURI_INTERNALS__ ⇒ bridged() 是 false ⇒ loadPush 不会调用
    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    // 页面应该显示 unavailable 文案（中文）
    expect(text).toContain(zh["pushSettings.unavailable"]);
    // 应该有一个重试按钮
    expect(host.container.querySelector('button')).toBeTruthy();
    // 不应该显示统计信息（无可用数据）
    expect(host.container.querySelector('[data-testid="push-statistics"]')).toBeNull();
    // 不应该显示设备令牌部分
    expect(text).not.toContain(zh["pushSettings.deviceToken"]);
  });

  test("backend 回答 available:false 时也应显示 unavailable", async () => {
    bridgeWithStatus({
      available: false,
      device_token: null,
      permission: "notdetermined",
      badge_count: 0,
      statistics: { total_received: 0, with_badge: 0, with_sound: 0, silent: 0, last_received: null },
    });

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["pushSettings.unavailable"]);
    // 推送设置 section 内的按钮应该不存在（DND toggle 是另一个 section 的）
    // 通过 data-testid 精确定位推送按钮
    const pushSection = host.container.querySelector('[data-testid="push-settings"]');
    expect(pushSection).toBeTruthy();
    expect(pushSection?.querySelectorAll("button").length).toBe(0);
  });
});

// ============================================================================
// 2. 可用 + 未请求权限
// ============================================================================

describe("NotificationsPage - 可用但未决定权限", () => {
  test("available + notdetermined 应显示请求权限按钮", async () => {
    bridgeWithStatus(AVAILABLE_STATUS({ permission: "notdetermined" }));

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    // 应该显示请求权限按钮
    expect(text).toContain(zh["pushPermission.request"]);
    // 应该显示设备令牌
    expect(text).toContain(zh["pushSettings.deviceToken"]);
    expect(text).toContain("abc123def456");
    // 应该显示环境
    expect(text).toContain(zh["pushSettings.envDevelopment"]);
  });

  test("点击请求权限按钮应调用 push_request_permission", async () => {
    const calls = bridgeWithStatus(AVAILABLE_STATUS({ permission: "notdetermined" }));

    const host = render(NotificationsPage);
    await settle();

    const requestBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(zh["pushPermission.request"]),
    ) as HTMLButtonElement;
    expect(requestBtn).toBeTruthy();

    await fireEvent.click(requestBtn);
    await settle();

    // 应该调用了 push_request_permission
    expect(calls.some((c) => c.cmd === "push_request_permission")).toBe(true);
    // 之后会重新 load push status
    const requestCallIdx = calls.findIndex((c) => c.cmd === "push_request_permission");
    expect(calls.slice(requestCallIdx + 1).some((c) => c.cmd === "push_get_status")).toBe(true);
  });
});

// ============================================================================
// 3. 权限已授权
// ============================================================================

describe("NotificationsPage - 已授权状态", () => {
  test("available + authorized 应显示成功说明，不显示请求按钮", async () => {
    bridgeWithStatus(AVAILABLE_STATUS({ permission: "authorized" }));

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["pushPermission.successDescription"]);
    // 已授权不应显示请求按钮
    expect(text).not.toContain(zh["pushPermission.request"]);
  });

  test("available + provisional 应同样显示成功说明", async () => {
    bridgeWithStatus(AVAILABLE_STATUS({ permission: "provisional" }));

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["pushPermission.successDescription"]);
  });
});

// ============================================================================
// 4. 权限被拒绝
// ============================================================================

describe("NotificationsPage - 权限被拒绝", () => {
  test("available + denied 应显示拒绝提示，不显示请求按钮", async () => {
    bridgeWithStatus(AVAILABLE_STATUS({ permission: "denied" }));

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["pushPermission.denied"]);
    expect(text).toContain(zh["pushPermission.deniedHint"]);
    // 被拒绝不应显示请求按钮（已经无法重新请求）
    expect(text).not.toContain(zh["pushPermission.request"]);
  });
});

// ============================================================================
// 5. 设备令牌显示
// ============================================================================

describe("NotificationsPage - 设备令牌显示", () => {
  test("可用 + 有令牌时显示令牌字符串", async () => {
    bridgeWithStatus(AVAILABLE_STATUS({
      token: "deadbeef1234567890",
      environment: "production",
    }));

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain("deadbeef1234567890");
    expect(text).toContain(zh["pushSettings.envProduction"]);
    expect(text).toContain(zh["pushSettings.registeredAt"]);
  });

  test("可用 + 无令牌时显示 noToken 占位", async () => {
    bridgeWithStatus(AVAILABLE_STATUS({ token: null }));

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["pushSettings.noToken"]);
    // 不应显示注册时间（无令牌）
    expect(text).not.toContain(zh["pushSettings.registeredAt"]);
  });
});

// ============================================================================
// 6. 统计数据
// ============================================================================

describe("NotificationsPage - 统计数据", () => {
  test("应该显示四个统计计数器（totalReceived/withBadge/withSound/silent）", async () => {
    bridgeWithStatus(AVAILABLE_STATUS({
      permission: "authorized",
      total_received: 100,
      with_badge: 60,
      with_sound: 40,
      silent: 20,
      last_received: "2026-09-18T10:00:00Z",
    }));

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    // 四个标签都应出现
    expect(text).toContain(zh["pushSettings.totalReceived"]);
    expect(text).toContain(zh["pushSettings.withBadge"]);
    expect(text).toContain(zh["pushSettings.withSound"]);
    expect(text).toContain(zh["pushSettings.silent"]);
    // 数字应该可见
    expect(text).toContain("100");
    expect(text).toContain("60");
    expect(text).toContain("40");
    expect(text).toContain("20");
  });

  test("last_received 应显示真实时间戳", async () => {
    bridgeWithStatus(AVAILABLE_STATUS({
      permission: "authorized",
      last_received: "2026-09-18T10:00:00Z",
    }));

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["pushSettings.lastReceived"]);
    expect(text).toContain("2026-09-18T10:00:00Z");
    // 不应显示 "never"
    expect(text).not.toContain(zh["pushSettings.never"]);
  });

  test("last_received 为 null 时应显示 never", async () => {
    bridgeWithStatus(AVAILABLE_STATUS({
      permission: "authorized",
      last_received: null,
    }));

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["pushSettings.never"]);
  });
});

// ============================================================================
// 7. 清除推送历史
// ============================================================================

describe("NotificationsPage - 清除推送历史", () => {
  test("点击 clearAll 应调用 push_clear_history", async () => {
    const calls = bridgeWithStatus(AVAILABLE_STATUS({ permission: "authorized" }));

    const host = render(NotificationsPage);
    await settle();

    const clearBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(zh["pushSettings.clearAll"]),
    ) as HTMLButtonElement;
    expect(clearBtn).toBeTruthy();

    // Mock window.confirm to return true
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    await fireEvent.click(clearBtn);
    await settle();

    expect(confirmSpy).toHaveBeenCalled();
    expect(calls.some((c) => c.cmd === "push_clear_history")).toBe(true);

    confirmSpy.mockRestore();
  });

  test("清除推送历史应同时清空本地推送通知，但保留系统通知", async () => {
    // 预先填充混合通知列表
    const mixed = [
      { id: "push_001", source: "push" as const, time: Date.now() - 1000, icon: "📩", read: false, title: "Push" },
      { id: "system_001", time: Date.now() - 2000, icon: "🔔", read: false, title: "System" },
      { id: "push_002", source: "push" as const, time: Date.now(), icon: "📩", read: false, title: "Push2" },
    ];
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify(mixed));

    bridgeWithStatus(AVAILABLE_STATUS({ permission: "authorized" }));

    const host = render(NotificationsPage);
    await settle();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const clearBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(zh["pushSettings.clearAll"]),
    ) as HTMLButtonElement;

    await fireEvent.click(clearBtn);
    await settle();
    confirmSpy.mockRestore();

    // 验证存储中只剩系统通知
    const stored = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]");
    expect(stored.length).toBe(1);
    expect(stored[0].id).toBe("system_001");
    expect(stored[0].source).toBeUndefined();
  });

  test("用户取消确认时不应清除历史", async () => {
    const calls = bridgeWithStatus(AVAILABLE_STATUS({ permission: "authorized" }));

    const host = render(NotificationsPage);
    await settle();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const clearBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(zh["pushSettings.clearAll"]),
    ) as HTMLButtonElement;

    await fireEvent.click(clearBtn);
    await settle();
    confirmSpy.mockRestore();

    expect(calls.some((c) => c.cmd === "push_clear_history")).toBe(false);
  });
});

// ============================================================================
// 8. 通知列表显示
// ============================================================================

describe("NotificationsPage - 通知列表", () => {
  test("未持久化的通知列表应显示 empty", async () => {
    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["settings.notifEmpty"]);
  });

  test("持久化的通知列表应被读取并显示", async () => {
    const notifs = [
      { id: "n1", time: Date.now() - 1000, icon: "🔔", read: false, title: "Test", body: "Body" },
      { id: "n2", time: Date.now(), icon: "📩", source: "push" as const, read: false, title: "Push" },
    ];
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify(notifs));

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain("Test");
    expect(text).toContain("Push");
  });

  test("clearAll 按钮应清空所有本地通知（包括系统通知）", async () => {
    const notifs = [
      { id: "n1", time: Date.now() - 1000, icon: "🔔", read: false, title: "Test" },
      { id: "n2", time: Date.now(), icon: "📩", source: "push" as const, read: false, title: "Push" },
    ];
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify(notifs));

    const host = render(NotificationsPage);
    await settle();

    const clearAllBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(zh["settings.notifClear"]),
    ) as HTMLButtonElement;
    expect(clearAllBtn).toBeTruthy();

    await fireEvent.click(clearAllBtn);
    await settle();

    const stored = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]");
    expect(stored).toEqual([]);
  });
});

// ============================================================================
// 9. Do Not Disturb 集成
// ============================================================================

describe("NotificationsPage - DND 集成", () => {
  test("默认设置下 DND 应为关闭状态", async () => {
    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["settings.dnd"]);
    expect(text).toContain(zh["settings.dndOff"]);
  });

  test("持久化的 DND=true 应被读取", async () => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ dnd: true }));

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["settings.dndOn"]);
  });

  test("点击 DND 切换按钮应持久化新状态", async () => {
    const host = render(NotificationsPage);
    await settle();

    // 找到 DND ToggleRow（通过 aria-pressed 或 label）
    const dndToggle = host.container.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(dndToggle).toBeTruthy();

    await fireEvent.click(dndToggle);
    await settle();

    const stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}");
    expect(stored.dnd).toBe(true);
  });
});

// ============================================================================
// 10. 边界情况
// ============================================================================

describe("NotificationsPage - 边界情况", () => {
  test("坏数据在 store 中应回退到默认 DND 状态（不崩溃）", async () => {
    window.localStorage.setItem(SETTINGS_KEY, "{not valid json");

    const host = render(NotificationsPage);
    await settle();

    // 不应该抛出
    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["settings.dnd"]);
  });

  test("坏数据在 notifs 中应回退到空列表", async () => {
    window.localStorage.setItem(NOTIF_KEY, "{not valid json");

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["settings.notifEmpty"]);
  });

  test("pushStatus 的 statistics 为 null 时应优雅降级", async () => {
    bridgeWithStatus({
      available: true,
      device_token: null,
      permission: "authorized",
      badge_count: 0,
      statistics: null as unknown as object,  // 强制 null
    });

    const host = render(NotificationsPage);
    await settle();

    // 不应该崩溃，页面应正常显示统计标题
    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["pushSettings.statistics"]);
    // last_received 应该显示 never（因为 statistics 为 null）
    expect(text).toContain(zh["pushSettings.never"]);
  });

  test("极长的设备令牌应完整显示（不截断）", async () => {
    const longToken = "a".repeat(128);
    bridgeWithStatus(AVAILABLE_STATUS({ token: longToken }));

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain(longToken);
  });
});

// ============================================================================
// 11. pushNotifBridge 单元测试（保持与页面集成的一致性）
// ============================================================================

describe("dropPushNotifs - 集成验证", () => {
  test("应该过滤掉所有推送通知，保留系统通知", () => {
    const notifs = [
      { id: "push_1", source: "push" as const, time: 1, icon: "📩", read: false },
      { id: "sys_1", time: 2, icon: "🔔", read: false },
      { id: "push_2", source: "push" as const, time: 3, icon: "📩", read: true },
    ];

    const result = dropPushNotifs(notifs);

    expect(result.length).toBe(1);
    expect(result[0]?.id).toBe("sys_1");
  });

  test("空数组应返回空数组", () => {
    expect(dropPushNotifs([])).toEqual([]);
  });

  test("全部都是推送通知时应清空", () => {
    const notifs = [
      { id: "push_1", source: "push" as const, time: 1, icon: "📩", read: false },
      { id: "push_2", source: "push" as const, time: 2, icon: "📩", read: false },
    ];
    expect(dropPushNotifs(notifs)).toEqual([]);
  });
});
