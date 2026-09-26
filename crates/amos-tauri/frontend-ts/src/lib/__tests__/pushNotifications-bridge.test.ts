/**
 * pushNotifications-bridge.test.ts — 推送通知桥接包装契约（src/lib/pushNotifications.ts，REQ-A396）。
 *
 * 两条规则：
 * - **可被宿主拒绝的读**（权限 / 角标 / 历史 / 统计 / 状态）答 `null`，绝不合成一个值。
 *   合成值会让"我没问到"与"宿主说 X"在线上同值 —— `?? "notdetermined"` 把拒答画成
 *   「你还没申请过」，`?? { available: false }` 把拒答画成「此设备没有推送后端」
 *   （REQ-A1335 / F-SH-601）。`null` 无歧义：这些命令返回结构体 / 标量，绝不返回 JSON `null`。
 * - **写类与显式失败**（注册 / 申请权限 / 模拟投递）答 `PushResult` / `false` / `null`，绝不抛错。
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
  deleteNotification,
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
  it("无 window：可拒绝的读答 null；写类答显式失败/否，绝不抛错", async () => {
    delete (globalThis as { window?: unknown }).window;
    // REQ-A1352：这两条曾经合成 `{ kind: "failed", reason: "push backend unreachable (no
    // host bridge)" }` —— 一个**本侧编出来的英文成因**，而 `PushSettings.askPermission`
    // 逐字渲染它（「无法申请通知权限：push backend unreachable (no host bridge)」）。宿主
    // 没作答与宿主说"失败"从此是两个值：`null` 与一个真的 `PushResult`。
    expect(await registerDeviceToken("tok")).toBeNull();
    expect(await getDeviceToken()).toBeNull();
    expect(await requestPushPermission()).toBeNull();
    // 可被拒绝的读：答 `null`，不合成。`"notdetermined"` / `0` / `[]` / 全零统计 /
    // 一份 `available: false` 的状态都曾是"我没问到"被画成"宿主说 X"的载体（REQ-A1335）。
    expect(await getPushPermission()).toBeNull();
    expect(await simulateReceivePush({ title: "t" } as never)).toBeNull();
    expect(await getBadgeCount()).toBeNull();
    expect(await getNotificationHistory()).toBeNull();
    // REQ-A1352：这两个布尔命令的 `?? false` 让「本机没能发出命令」与「宿主答：设备里没有
    // 这一条」同值 —— 而 `false` 在删除路径上是一个**成功**（本地移除是对的），所以这个
    // 折叠会把"从未送达的命令"画成一个可以往下走的结论。
    expect(await markNotificationRead("n1")).toBeNull();
    expect(await deleteNotification("n1")).toBeNull();
    expect(await getPushStatistics()).toBeNull();
    expect(await getPushStatus()).toBeNull();
    // 写类命令同样不抛。`push_clear_history` 答 unit，所以它的裁决只能从台账读
    // （REQ-A845 / F-SH-270）：无桥 = 没做成 = `false`，而不是"干脆不返回值"。
    await expect(setBadgeCount(3)).resolves.toBeUndefined();
    expect(await clearNotificationHistory()).toBe(false);
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
      // REQ-A865: the bridge's job here is verbatim passthrough, so the fixture only has to
      // be *self-consistent* — and `authorized` is a state only a host with a real
      // permission backend can be in.
      permission_backend: "UNUserNotificationCenter",
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
    const cmds = calls.map((c) => c.command);
    expect(cmds).toContain("push_set_badge");
    expect(calls.find((c) => c.command === "push_set_badge")!.args).toEqual({ count: 0 });
    // 同一段里 `clear` 的两种答案必须是**两个值**（REQ-A845 / F-SH-270）。宿主答 unit
    // 时桥把它变成 `null`，而失败也是 `null` —— 所以只有台账分得开：
    await clearNotificationHistory();
    const refusals = calls.length;
    expect(calls.some((c) => c.command === "push_clear_history")).toBe(true);
    // 同一条命令第二次被**拒绝**（宿主抛错）时不能再答 `true`。
    respond = () => {
      throw new Error("device store is locked");
    };
    await expect(clearNotificationHistory()).resolves.toBe(false);
    expect(calls.length).toBe(refusals + 1);
  });

  it("宿主答 `false` 就是 `false` —— 它与「没作答」不是同一个值", async () => {
    // REQ-A1352 的对照面：`?? false` 遮住的是「宿主答了 `false`」这一支。设备答
    // "我这儿没有这一条" 是一次**回答**（删除路径上它是成功），必须原样落地。
    respond = (cmd) =>
      cmd === "push_mark_read" || cmd === "push_delete_notification" ? false : null;
    expect(await markNotificationRead("n1")).toBe(false);
    expect(await deleteNotification("n1")).toBe(false);
    // 而宿主真的答了一份 PushResult 时，它一个字都不改。
    const refused = { kind: "failed" as const, reason: "device store is locked" };
    respond = () => refused;
    expect(await registerDeviceToken("tok")).toEqual(refused);
    expect(await requestPushPermission()).toEqual(refused);
    expect(calls.map((c) => c.command)).toEqual([
      "push_mark_read",
      "push_delete_notification",
      "push_register_token",
      "push_request_permission",
    ]);
  });
});
