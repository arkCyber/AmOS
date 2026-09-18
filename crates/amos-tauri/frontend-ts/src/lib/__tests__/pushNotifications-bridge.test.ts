/**
 * pushNotifications-bridge.test.ts — 推送通知桥接包装契约（src/lib/pushNotifications.ts，REQ-A396）。
 *
 * 每个包装器都是 `invoke(...) ?? 诚实回退` 的形状：
 * - 未桥接：failed 结果 / 0 / [] / false / 空统计 / 默认状态——绝不抛错；
 * - 有桥（假 __TAURI_INTERNALS__）：命令正确路由、应答原样落地。
 */
import { describe, test as it, expect, beforeEach, afterEach } from "bun:test";
import {
  registerDeviceToken,
  getDeviceToken,
  requestPushPermission,
  getPushPermission,
  simulateReceivePush,
  getBadgeCount,
  setBadgeCount,
  getNotificationHistory,
  markNotificationRead,
  clearNotificationHistory,
  getPushStatistics,
  getPushStatus,
} from "../pushNotifications";

let respond: (command: string, args?: Record<string, unknown>) => unknown = () => null;
const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];

function installBridge(): void {
  calls.length = 0;
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return respond(command, args);
      },
    },
  };
}

beforeEach(() => {
  installBridge();
  respond = () => null;
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("推送包装器：未桥接时的诚实回退", () => {
  it("无 window：全部落到回退值", async () => {
    delete (globalThis as { window?: unknown }).window;
    expect(await registerDeviceToken("tok")).toEqual({
      kind: "failed",
      reason: "push backend unreachable (no host bridge)",
    });
    expect(await getDeviceToken()).toBeNull();
    expect(await requestPushPermission()).toEqual({
      kind: "failed",
      reason: "push backend unreachable (no host bridge)",
    });
    expect(await getPushPermission()).toBe("notdetermined");
    expect(await simulateReceivePush({ title: "t" } as never)).toBeNull();
    expect(await getBadgeCount()).toBe(0);
    expect(await getNotificationHistory()).toEqual([]);
    expect(await markNotificationRead("n1")).toBe(false);
    const stats = await getPushStatistics();
    expect(stats).toEqual({
      total_received: 0,
      with_badge: 0,
      with_sound: 0,
      silent: 0,
      last_received: null,
    });
    const status = await getPushStatus();
    expect(status).toEqual({
      available: false,
      device_token: null,
      permission: "notdetermined",
      badge_count: 0,
      statistics: { total_received: 0, with_badge: 0, with_sound: 0, silent: 0, last_received: null },
    });
    // 写类命令同样不抛
    await expect(setBadgeCount(3)).resolves.toBeUndefined();
    await expect(clearNotificationHistory()).resolves.toBeUndefined();
  });
});

describe("推送包装器：有桥时命令路由与透传", () => {
  it("注册 token / 请求权限：应答原样返回", async () => {
    const okResult = { kind: "ok" as const };
    respond = (cmd) => (cmd === "push_register_token" ? okResult : null);
    expect(await registerDeviceToken("tok", "sandbox")).toEqual(okResult);
    expect(calls[0]).toEqual({
      command: "push_register_token",
      args: { token: "tok", environment: "sandbox" },
    });
    respond = () => ({ kind: "ok" as const });
    expect(await requestPushPermission()).toEqual({ kind: "ok" });
    expect(calls[calls.length - 1]!.command).toBe("push_request_permission");
  });

  it("读取类命令：token/权限/角标/历史/已读/统计/状态全部透传", async () => {
    // 假应答必须满足模块**真实的** Rust 形状（`RustDeviceToken` / `RustNotificationRecord`
    // / `RustPushStatistics` / `RustPushStatus`），否则它测的是本测试自己想象出来的契约。
    const token = { token: "t", environment: "production", registered_at: "2026-09-18T00:00:00.000Z" };
    const stats = {
      total_received: 7,
      with_badge: 2,
      with_sound: 1,
      silent: 4,
      last_received: "2026-09-18T00:00:00.000Z",
    };
    const record = {
      id: "n1",
      payload: { aps: { alert: "hi" } },
      received_at: "2026-09-18T00:00:00.000Z",
      read: false,
    };
    const status = {
      available: true,
      device_token: token,
      permission: "authorized" as const,
      badge_count: 2,
      statistics: stats,
    };
    respond = (cmd) => {
      switch (cmd) {
        case "push_get_token": return token;
        case "push_get_permission": return "authorized";
        case "push_simulate_receive": return "record-9";
        case "push_get_badge": return 2;
        case "push_get_history": return [record];
        case "push_mark_read": return true;
        case "push_get_statistics": return stats;
        case "push_get_status": return status;
        default: return null;
      }
    };
    expect(await getDeviceToken()).toEqual(token);
    expect(await getPushPermission()).toBe("authorized");
    expect(await simulateReceivePush({ title: "x" } as never)).toBe("record-9");
    expect(calls.find((c) => c.command === "push_simulate_receive")).toBeDefined();
    expect(await getBadgeCount()).toBe(2);
    expect(await getNotificationHistory(5)).toEqual([record]);
    expect(calls.find((c) => c.command === "push_get_history")!.args).toEqual({ limit: 5 });
    expect(await markNotificationRead("n1")).toBe(true);
    expect(await getPushStatistics()).toEqual(stats);
    expect(await getPushStatus()).toEqual(status);
    // 写类：set/clear 走桥
    respond = () => null;
    await setBadgeCount(0);
    await clearNotificationHistory();
    const cmds = calls.map((c) => c.command);
    expect(cmds).toContain("push_set_badge");
    expect(cmds).toContain("push_clear_history");
    expect(calls.find((c) => c.command === "push_set_badge")!.args).toEqual({ count: 0 });
  });
});
