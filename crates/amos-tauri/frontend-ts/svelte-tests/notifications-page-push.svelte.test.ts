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
 * The page's contract (REQ-A383, and REQ-A1335 for the third read outcome):
 *   • no bridge at all is "unavailable", with a Retry button — never invented as
 *     "no push yet";
 *   • a backend that answered `available: false` is also "unavailable" (it is a
 *     claim the **host** made about the platform), but with no controls under it —
 *     the two are told apart by the retry, not by the sentence;
 *   • a **reachable host that did not answer** is neither of those: it gets its own
 *     sentence ("the host did not answer") plus a Retry. Drawing the device sentence
 *     there would be a capability claim about the platform that nobody made
 *     (REQ-A1335 / F-SH-601);
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
import { writeStoreValue } from "../src/lib/amosStore";
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
function bridgeWithStatus(
  status: unknown,
  opts: {
    refuseClear?: boolean;
    /**
     * How the host answers `push_request_permission`:
     *   • `"throw"` — the call never reaches the device (Tauri 2 `Err` ⇒ the promise rejects ⇒
     *     `invoke` records `command-failed` and answers `null`). This is the REQ-A1352 case.
     *   • any object — the host's own `PushResult`, passed through verbatim.
     * Defaults to `{ kind: "ok" }`.
     */
    permissionReply?: "throw" | unknown;
  } = {},
) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "push_get_status") return status;
      if (cmd === "push_request_permission") {
        if (opts.permissionReply === "throw") throw new Error("permission channel closed");
        return opts.permissionReply ?? { kind: "ok" };
      }
      // `push_clear_history` answers unit, which the bridge cannot tell from a refusal — so the
      // refusing host *throws*, and the verdict reaches the page only through the ledger
      // (REQ-A845 / F-SH-270).
      if (cmd === "push_clear_history") {
        if (opts.refuseClear) throw new Error("device store is locked");
        return { kind: "ok" };
      }
      if (cmd === "push_simulate_receive") return { id: "test-push-1" };
      return null;
    },
    listen: async () => () => {},
  };
  return calls;
}

const AVAILABLE_STATUS = (overrides: Partial<{
  permission: string;
  /**
   * REQ-A865 / F-DEV-116 — the OS API the host would ask. Defaults to a real one because
   * this file's fixture is a *fully capable* host: the request button is drawn from this
   * value, so without it the button cases below would pass vacuously (the button would be
   * absent for the "no backend" reason, not for the branch under test). `null` is what the
   * shipped build answers, and it has its own cases instead of being the silent default.
   */
  backend: string | null;
  token: string | null;
  environment: string;
  total_received: number;
  with_badge: number;
  with_sound: number;
  silent: number;
  last_received: string | null;
}> = {}) => ({
  available: true,
  permission_backend: overrides.backend === undefined ? "UNUserNotificationCenter" : overrides.backend,
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

  // REQ-A1335 / F-SH-601 —— 第三件事：**宿主可达，却没作答**。
  //
  // 上面两条钉的是「没有桥」与「后端自己答 available:false」。这一条钉的是它们的中间态：
  // 桥在（`bridged() === true`），`push_get_status` 的 `invoke` 解析成 `null`（命令报错 /
  // 传输失败 —— `invoke` 对失败resolve `null`，从不 reject）。旧包装器在这一刻**编造**了一个
  // 完整的 `RustPushStatus`（`available:false, permission:"notdetermined", statistics` 全 0），
  // 于是面板画的是**关于这台设备**的那句话（「此设备上没有可用的推送后端」），并且因为编造出来的
  // 对象非空，连「重试」都不再画 —— 一次"没问到"被写成了"这台机器没有推送子系统"，而真相是
  // 宿主被问过、没答。三件事（没有桥 / 设备没有后端 / 宿主没作答）必须三句话。
  test("宿主可达但拒绝作答时：不说「本设备没有推送后端」，说「宿主未作答」并给重试", async () => {
    bridgeWithStatus(null); // 桥在，但什么都不答

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    // 不得把"没问到"说成关于设备能力的断言。
    expect(text).not.toContain(zh["pushSettings.unavailable"]);
    expect(text).toContain(zh["pushSettings.unanswered"]);
    // 重试必须还在（旧代码正是在这一格丢掉它的）。
    const pushSection = host.container.querySelector('[data-testid="push-settings"]');
    expect(pushSection).toBeTruthy();
    expect(pushSection?.querySelectorAll("button").length).toBeGreaterThan(0);
    // 编造出来的状态绝不能把令牌 / 统计这两个区块画出来。
    expect(host.container.querySelector('[data-testid="push-statistics"]')).toBeNull();
  });

  test("「宿主未作答」上点重试会再问一次，答了就照常渲染", async () => {
    let answer: unknown = null;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => (cmd === "push_get_status" ? answer : null),
      listen: async () => () => {},
    };

    const host = render(NotificationsPage);
    await settle();
    expect(host.container.textContent ?? "").toContain(zh["pushSettings.unanswered"]);

    // 第二次问，宿主答了 —— 面板必须从「没问到」走到真实状态，而不是停在那一句。
    answer = AVAILABLE_STATUS({ permission: "authorized" });
    const retry = [...(host.container.querySelector('[data-testid="push-settings"]')?.querySelectorAll("button") ?? [])]
      .find((b) => (b.textContent ?? "").includes(zh["pushSettings.retry"])) as HTMLButtonElement;
    expect(retry).toBeTruthy();
    await fireEvent.click(retry);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).not.toContain(zh["pushSettings.unanswered"]);
    expect(text).toContain(zh["pushPermission.successDescription"]);
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

  // REQ-A865 / F-DEV-116 —— 上面两条测的是**有这个后端时**页面画什么；这一条测的是
  // **实际发布出去的构建**：`permission_backend === null`，宿主的 `push_request_permission`
  // 只会答拒绝。两组必须都在，否则「按钮该不该存在」只被一半的输入验证过。
  test("没有权限接口的宿主不画请求按钮，且绝不说已授权", async () => {
    bridgeWithStatus(AVAILABLE_STATUS({ backend: null }));

    const host = render(NotificationsPage);
    await settle();

    const text = host.container.textContent ?? "";
    // 说清楚为什么没有按钮 —— 这一块其余部分（令牌、统计、历史）都是好的，
    // 只缺一个按钮而不解释，读起来像页面坏了。
    expect(text).toContain(zh["pushPermission.noBackend"]);
    expect(text).not.toContain(zh["pushPermission.request"]);
    // 这是旧代码失败的那一条：成功句曾经是从宿主自己写进去的 `authorized` 渲染出来的。
    expect(text).not.toContain(zh["pushPermission.successDescription"]);
    // 面板的其余部分照常工作，所以"没有按钮"不是"整页不可用"。
    expect(text).toContain(zh["pushSettings.deviceToken"]);
    expect(text).toContain(zh["pushSettings.statistics"]);
  });
});

// ============================================================================
// 2b. 请求权限的三种答复（REQ-A1352 / F-SH-616）
// ============================================================================
//
// `requestPushPermission()` 原先把「宿主没作答」折成一个自己编造的
// `{ kind: "failed", reason: "push backend unreachable (no host bridge)" }`。而这一块面板
// 是**先**用 `pushStatus.available` 证明"宿主在"才画出按钮的，所以那句英文原因与屏幕上
// 已经渲染的事实直接矛盾；它又被 `pushPermission.requestFailed` 逐字插进中文句子里。
// 三件事必须三句话：宿主答 `ok` / 宿主答拒绝（照它的原话） / 宿主没作答。
describe("NotificationsPage — 请求权限：宿主没作答（REQ-A1352）", () => {
  const requestBtn = (c: HTMLElement): HTMLButtonElement =>
    [...c.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(zh["pushPermission.request"]),
    ) as HTMLButtonElement;

  test("宿主没回话时说的是「没得到回应」，不是编造的原因，也不是设备拒绝", async () => {
    bridgeWithStatus(AVAILABLE_STATUS({ permission: "notdetermined" }), {
      permissionReply: "throw",
    });

    const host = render(NotificationsPage);
    await settle();

    const btn = requestBtn(host.container);
    expect(btn).toBeTruthy();
    await fireEvent.click(btn);
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["pushPermission.requestUnanswered"]);
    // 编造的原因绝不能出现在屏幕上 —— 它是一句关于"为什么"的断言，而没有人给过原因。
    expect(text).not.toContain("push backend unreachable");
    // 也不得把"我没问到"说成"设备拒绝了"。
    expect(text).not.toContain(zh["pushPermission.denied"]);
  });

  test("宿主明确拒绝时，照旧用它自己的原因（负控：这条不能也被改成「没作答」）", async () => {
    bridgeWithStatus(AVAILABLE_STATUS({ permission: "notdetermined" }), {
      permissionReply: { kind: "failed", reason: "device store is locked" },
    });

    const host = render(NotificationsPage);
    await settle();

    await fireEvent.click(requestBtn(host.container));
    await settle();

    const text = host.container.textContent ?? "";
    expect(text).toContain(zh["pushPermission.requestFailed"].split("{reason}")[0] ?? "");
    expect(text).toContain("device store is locked");
    expect(text).not.toContain(zh["pushPermission.requestUnanswered"]);
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

  test("宿主拒绝这次清除时，本地一条也不删，并把原因说出来（REQ-A845）", async () => {
    // REQ-A845 / F-SH-270. `push_clear_history` 答 unit ⇒ 桥把成功和拒绝都变成 `null`。
    // 修前：本地那一半照删不误 —— 设备**还留着**的历史，被外壳从自己的存储里抹掉，
    // 还告诉宿主页面"列表空了"。修后：破坏性的一步等设备确认。
    const mixed = [
      { id: "push_001", source: "push" as const, time: Date.now() - 1000, icon: "📩", read: false, title: "Push" },
      { id: "system_001", time: Date.now() - 2000, icon: "🔔", read: false, title: "System" },
    ];
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify(mixed));

    const calls = bridgeWithStatus(AVAILABLE_STATUS({ permission: "authorized" }), {
      refuseClear: true,
    });

    const host = render(NotificationsPage);
    await settle();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const clearBtn = [...host.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(zh["pushSettings.clearAll"]),
    ) as HTMLButtonElement;

    await fireEvent.click(clearBtn);
    await settle();
    confirmSpy.mockRestore();

    // 命令确实发出去了（拒绝不是"没发"）……
    expect(calls.some((c) => c.cmd === "push_clear_history")).toBe(true);
    // ……但本地列表逐字未动：被拒绝的清除不能表现得像清掉了。
    const stored = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]");
    expect(stored.map((n: { id: string }) => n.id)).toEqual(["push_001", "system_001"]);
    // 而且屏幕上有话说 —— 否则这就是一次静默的"点了没反应"。
    expect(host.container.textContent ?? "").toContain(zh["pushSettings.clearFailed"]);
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

  /**
   * 这个列表里的推送行是设备历史（`push_get_history`）的**投影**：`osPushWatcher` 每几秒
   * 重新拉一次，凡本地不持有的记录都会被写回。所以本页的「清空」也必须让设备忘掉，否则
   * 刚清掉的推送在几秒后复活 —— 上面的用例只查到本地存储为止，把本地那一半钉成绿的，
   * 而轮询那一步从未执行。
   */
  test("clearAll 应同时清掉设备的推送历史（否则下一次轮询会写回）", async () => {
    const notifs = [
      { id: "n1", time: Date.now() - 1000, icon: "🔔", read: false, title: "Test" },
      { id: "n2", time: Date.now(), icon: "📩", source: "push" as const, read: false, title: "Push" },
    ];
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify(notifs));
    const calls = bridgeWithStatus(AVAILABLE_STATUS({ permission: "authorized" }));

    const host = render(NotificationsPage);
    await settle();

    await fireEvent.click(
      [...host.container.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(zh["settings.notifClear"]),
      ) as HTMLButtonElement,
    );
    await settle();

    expect(calls.some((c) => c.cmd === "push_clear_history")).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]")).toEqual([]);
  });

  // 负控：设备历史不是外壳自己的通知该删的 —— 一份没有推送行的列表不该去清设备。
  // （`push_get_status` 是页面自己加载时问的，不在此列。）
  test("列表里没有推送行时，clearAll 不去清设备的历史", async () => {
    window.localStorage.setItem(
      NOTIF_KEY,
      JSON.stringify([{ id: "n1", time: Date.now(), icon: "🔔", read: false, title: "Test" }]),
    );
    const calls = bridgeWithStatus(AVAILABLE_STATUS({ permission: "authorized" }));

    const host = render(NotificationsPage);
    await settle();

    await fireEvent.click(
      [...host.container.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(zh["settings.notifClear"]),
      ) as HTMLButtonElement,
    );
    await settle();

    expect(calls.filter((c) => c.cmd === "push_clear_history")).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]")).toEqual([]);
  });

  /**
   * 拒绝的那一叶：设备没做，本页就不能把列表说成已清空。
   *
   * 这正是同族的 `PushSettings.clearPushHistory` 早就写下并遵守的规则 —— 它的注释逐字
   * 「The local wipe is the destructive step, so it waits for the device to confirm」。
   * 本页的「清空」在 REQ-A1238 接过「连设备历史一起清」这一半时，没有一并接过那条规则：
   * 它先把本地列表与存储清掉，再 `void clearNotificationHistory()` 把判决丢掉。于是设备
   * 拒绝时，屏幕先把列表说成空的，而 `osPushWatcher` 下一次轮询（5 秒）会把设备仍然持有的
   * 记录原样写回 —— 用户点的那一下既没被拒绝说出口，也没有真的发生。上面那条「应同时清掉
   * 设备的推送历史」的用例只走成功那一叶，把这条纪律钉成了绿。
   */
  test("设备拒绝清历史时，本页不得把列表说成已清空（本地那一半也要留住，并说出来）", async () => {
    const notifs = [
      { id: "n1", time: Date.now() - 1000, icon: "🔔", read: false, title: "Test" },
      { id: "n2", time: Date.now(), icon: "📩", source: "push" as const, read: false, title: "Push" },
    ];
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify(notifs));
    bridgeWithStatus(AVAILABLE_STATUS({ permission: "authorized" }), { refuseClear: true });

    const host = render(NotificationsPage);
    await settle();

    await fireEvent.click(
      [...host.container.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(zh["settings.notifClear"]),
      ) as HTMLButtonElement,
    );
    await settle();

    // 本地那一半必须留下 —— 下一次轮询写回时，屏幕才不会先清空又复活。
    expect(JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]")).toHaveLength(2);
    expect(host.container.textContent ?? "").toContain(zh["pushSettings.clearFailed"]);
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

// ============================================================================
// 通知列表必须跟随存储（REQ-A1238 / F-SH-491 的姊妹面）
// ============================================================================
//
// `amos.notifications` 是一个**投影**：`osPushWatcher` 每 5 秒把设备的推送历史合并进来，
// 而「通知」子页和其它两个通知面（触屏抽屉 `NotificationCenter`、桌面面板
// `DesktopNotificationCenter`）渲染的是**同一个键**。那两个面都 `createStoreValue` 订阅了它，
// 只有这一页在 `init` 时把键读进 `$state` 快照，之后再没订阅 —— 于是页面开着的时候到达的
// 推送，屏幕上永远看不见，`notifs.length === 0` 还会让「清空」按钮保持禁用。
describe("NotificationsPage — 列表跟随存储（REQ-A1238）", () => {
  test("页面打开后到达的推送必须出现在列表里", async () => {
    window.localStorage.setItem(NOTIF_KEY, JSON.stringify([]));
    bridgeWithStatus(AVAILABLE_STATUS({ permission: "authorized" }));

    const host = render(NotificationsPage);
    await settle();

    // 开局确实是空的 —— 这条不是断言的重点，只是把「空」钉成起点。
    expect(host.container.textContent ?? "").toContain(zh["settings.notifEmpty"]);

    // 观察者把一条推送合并进同一个键（它和这一页读的是同一个键）。
    writeStoreValue(NOTIF_KEY, [
      { id: "push_live", source: "push" as const, time: Date.now(), icon: "📩", read: false, title: "直播推送" },
    ]);
    await settle();

    expect(host.container.textContent ?? "").toContain("直播推送");
    expect(host.container.textContent ?? "").not.toContain(zh["settings.notifEmpty"]);
  });
});
