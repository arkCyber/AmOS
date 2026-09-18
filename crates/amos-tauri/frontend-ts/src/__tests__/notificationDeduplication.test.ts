/**
 * notificationDeduplication.test.ts - 真实测试版
 *
 * 测试推送通知的去重和合并逻辑
 * 真正调用 pushNotifBridge 中的函数，而不是 mock
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  mergePushHistory,
  pushRecordToNotif,
  dropPushNotifs,
  PUSH_NOTIF_ICON,
} from "../lib/pushNotifBridge";
import type { RustNotificationRecord, PushPayload } from "../lib/pushNotifications";
import type { Notif } from "../lib/settings";

// ============================================================================
// 测试辅助
// ============================================================================

const NOW = 1700000000000;

function makeRecord(overrides: Partial<RustNotificationRecord> = {}): RustNotificationRecord {
  return {
    id: `push_${Math.random().toString(36).slice(2)}`,
    received_at: new Date(NOW).toISOString(),
    read: false,
    payload: {
      aps: {
        alert: { title: "Test", body: "Body" },
      },
    } as PushPayload,
    ...overrides,
  };
}

function makeNotif(overrides: Partial<Notif> = {}): Notif {
  return {
    id: `notif_${Math.random().toString(36).slice(2)}`,
    time: NOW,
    icon: PUSH_NOTIF_ICON,
    source: "push",
    read: false,
    ...overrides,
  };
}

// ============================================================================
// 1. ID 去重测试（真实测试 mergePushHistory）
// ============================================================================

describe("mergePushHistory - ID 去重", () => {
  test("相同 ID 的记录不应重复添加", () => {
    const record = makeRecord({ id: "push_001" });
    const existing: Notif[] = [];

    // 第一次合并
    const after1 = mergePushHistory(existing, [record], NOW, 100);
    expect(after1.length).toBe(1);

    // 第二次合并相同 ID（不应该添加）
    const record2 = makeRecord({
      id: "push_001",
      payload: { aps: { alert: { title: "Updated", body: "New" } } } as PushPayload,
    });
    const after2 = mergePushHistory(after1, [record2], NOW, 100);

    // 应该保持原有记录（不应被覆盖）
    expect(after2.length).toBe(1);
    expect(after2[0]?.id).toBe("push_001");
  });

  test("不同 ID 的记录应该全部添加", () => {
    const records = [
      makeRecord({ id: "push_001" }),
      makeRecord({ id: "push_002" }),
      makeRecord({ id: "push_003" }),
    ];

    const result = mergePushHistory([], records, NOW, 100);

    expect(result.length).toBe(3);
    expect(new Set(result.map((n) => n.id)).size).toBe(3);
  });

  test("已存在的 ID 不会被覆盖（保持本地已读状态）", () => {
    const record = makeRecord({ id: "push_001", read: false });
    const existing: Notif[] = [makeNotif({ id: "push_001", read: true })];

    // 后端说未读，但本地已读
    const result = mergePushHistory(existing, [record], NOW, 100);

    // 应该保持本地已读状态
    expect(result.length).toBe(1);
    expect(result[0]?.read).toBe(true);
  });
});

// ============================================================================
// 2. 跨通知类型去重
// ============================================================================

describe("mergePushHistory - 跨类型", () => {
  test("系统通知不会被推送通知覆盖", () => {
    const sysNotif: Notif = makeNotif({
      id: "system_001",
      source: undefined,
      title: "System Alert",
    });

    const pushRecord = makeRecord({ id: "push_001" });

    const result = mergePushHistory([sysNotif], [pushRecord], NOW, 100);

    expect(result.length).toBe(2);
    expect(result.find((n) => n.id === "system_001")).toBeDefined();
    expect(result.find((n) => n.id === "push_001")).toBeDefined();
  });

  test("系统通知和推送通知使用相同的 ID 空间（现实行为）", () => {
    // 实际上 bridge 函数使用相同的 ID 空间（通过 held set）
    // 这是当前的行为 - 测试要反映真实实现
    const sysNotif: Notif = makeNotif({
      id: "abc123",
      source: undefined,
    });

    const record = makeRecord({ id: "abc123" });

    const result = mergePushHistory([sysNotif], [record], NOW, 100);

    // 由于 ID 重复，推送通知不会被添加
    // （系统通知保留原始状态）
    expect(result.length).toBe(1);
    expect(result[0]?.id).toBe("abc123");
  });
});

// ============================================================================
// 3. 时间排序
// ============================================================================

describe("mergePushHistory - 时间排序", () => {
  test("新记录应该按时间倒序添加到列表前面", () => {
    const oldNotif: Notif = makeNotif({ id: "old", time: NOW - 5000 });

    const newRecord = makeRecord({
      id: "new",
      received_at: new Date(NOW).toISOString(),
    });

    const result = mergePushHistory([oldNotif], [newRecord], NOW, 100);

    expect(result[0]?.id).toBe("new");   // 新的在前
    expect(result[1]?.id).toBe("old");   // 旧的在后
  });

  test("多个新记录按时间倒序排列", () => {
    const records = [
      makeRecord({ id: "n1", received_at: new Date(NOW - 3000).toISOString() }),
      makeRecord({ id: "n2", received_at: new Date(NOW - 1000).toISOString() }),
      makeRecord({ id: "n3", received_at: new Date(NOW - 2000).toISOString() }),
    ];

    const result = mergePushHistory([], records, NOW, 100);

    expect(result[0]?.id).toBe("n2");  // 最新
    expect(result[1]?.id).toBe("n3");  // 中间
    expect(result[2]?.id).toBe("n1");  // 最旧
  });
});

// ============================================================================
// 4. 容量限制
// ============================================================================

describe("mergePushHistory - 容量限制", () => {
  test("不应超过容量上限", () => {
    const records = Array.from({ length: 50 }, (_, i) =>
      makeRecord({ id: `push_${i}`, received_at: new Date(NOW - i * 1000).toISOString() })
    );

    const result = mergePushHistory([], records, NOW, 10);  // cap = 10

    expect(result.length).toBe(10);
    expect(result[0]?.id).toBe("push_0");  // 最新
  });

  test("容量为 0 时应返回空列表", () => {
    const records = [makeRecord({ id: "push_1" })];
    const result = mergePushHistory([], records, NOW, 0);

    expect(result.length).toBe(0);
  });

  test("原有数据 + 新数据 共同受 cap 限制", () => {
    const existing = Array.from({ length: 80 }, (_, i) =>
      makeNotif({ id: `existing_${i}`, time: NOW - i * 1000 })
    );

    const records = Array.from({ length: 50 }, (_, i) =>
      makeRecord({ id: `new_${i}`, received_at: new Date(NOW + i * 1000).toISOString() })
    );

    const result = mergePushHistory(existing, records, NOW, 100);

    expect(result.length).toBe(100);
  });
});

// ============================================================================
// 5. 边界情况
// ============================================================================

describe("pushRecordToNotif - 边界情况", () => {
  test("无 alert 文本的推送应返回 null（不显示）", () => {
    const silentPush = makeRecord({
      payload: { aps: { "content-available": 1 } } as PushPayload,
    });

    const result = pushRecordToNotif(silentPush, NOW);

    expect(result).toBeNull();
  });

  test("字符串 alert 应该映射到 body", () => {
    const record = makeRecord({
      payload: { aps: { alert: "Simple message" } } as PushPayload,
    });

    const result = pushRecordToNotif(record, NOW);

    expect(result).not.toBeNull();
    expect(result?.body).toBe("Simple message");
    expect(result?.title).toBeUndefined();
  });

  test("无效的时间戳应该使用 fallbackNow", () => {
    const record = makeRecord({
      received_at: "invalid-date",
    });

    const result = pushRecordToNotif(record, NOW);

    expect(result?.time).toBe(NOW);  // 使用 fallback
  });

  test("app 字段应该被正确提取", () => {
    const record = makeRecord({
      payload: {
        aps: { alert: { title: "Test" } },
        app: "MyApp",
      } as PushPayload & { app: string },
    });

    const result = pushRecordToNotif(record, NOW);

    expect(result?.app).toBe("MyApp");
  });

  test("app 字段为空字符串应该被忽略", () => {
    const record = makeRecord({
      payload: {
        aps: { alert: { title: "Test" } },
        app: "   ",
      } as PushPayload & { app: string },
    });

    const result = pushRecordToNotif(record, NOW);

    expect(result?.app).toBeUndefined();
  });

  test("badge 字段应该被提取", () => {
    const record = makeRecord({
      payload: { aps: { alert: { title: "Test" }, badge: 5 } } as PushPayload,
    });

    const result = pushRecordToNotif(record, NOW);

    expect(result?.badge).toBe(5);
  });
});

// ============================================================================
// 6. dropPushNotifs - 清除推送通知
// ============================================================================

describe("dropPushNotifs - 清除推送通知", () => {
  test("应该清除所有推送通知", () => {
    const notifs: Notif[] = [
      makeNotif({ id: "push_1", source: "push" }),
      makeNotif({ id: "system_1", source: undefined }),
      makeNotif({ id: "push_2", source: "push" }),
      makeNotif({ id: "system_2", source: undefined }),
    ];

    const result = dropPushNotifs(notifs);

    expect(result.length).toBe(2);
    expect(result.every((n) => n.source !== "push")).toBe(true);
  });

  test("空列表应该返回空列表", () => {
    expect(dropPushNotifs([])).toEqual([]);
  });

  test("应该保持系统通知的顺序", () => {
    const sys1: Notif = makeNotif({ id: "sys_1", source: undefined, time: NOW });
    const sys2: Notif = makeNotif({ id: "sys_2", source: undefined, time: NOW + 1 });

    const notifs = [
      makeNotif({ id: "push_1", source: "push", time: NOW + 2 }),
      sys1,
      makeNotif({ id: "push_2", source: "push", time: NOW + 3 }),
      sys2,
    ];

    const result = dropPushNotifs(notifs);

    expect(result.length).toBe(2);
    expect(result[0]?.id).toBe("sys_1");
    expect(result[1]?.id).toBe("sys_2");
  });
});

// ============================================================================
// 7. 集成测试
// ============================================================================

describe("mergePushHistory + dropPushNotifs 集成", () => {
  test("完整流程：接收 → 清除", () => {
    // 1. 初始为空
    let list: Notif[] = [];

    // 2. 接收 3 条推送
    const records = [
      makeRecord({ id: "push_1" }),
      makeRecord({ id: "push_2" }),
      makeRecord({ id: "push_3" }),
    ];
    list = mergePushHistory(list, records, NOW, 100);
    expect(list.length).toBe(3);

    // 3. 再接收 1 条新的（不重复）
    list = mergePushHistory(list, [makeRecord({ id: "push_4" })], NOW, 100);
    expect(list.length).toBe(4);

    // 4. 再接收已存在的 ID（不增加）
    list = mergePushHistory(list, [makeRecord({ id: "push_1" })], NOW, 100);
    expect(list.length).toBe(4);

    // 5. 清除推送历史
    list = dropPushNotifs(list);
    expect(list.length).toBe(0);
  });

  test("混合系统通知和推送通知的完整流程", () => {
    // 1. 初始有一个系统通知
    const sysNotif: Notif = makeNotif({ id: "alarm", source: undefined });
    let list: Notif[] = [sysNotif];

    // 2. 接收推送通知
    const records = [
      makeRecord({ id: "push_1" }),
      makeRecord({ id: "push_2" }),
    ];
    list = mergePushHistory(list, records, NOW, 100);

    expect(list.length).toBe(3);  // 1 系统 + 2 推送
    expect(list.find((n) => n.id === "alarm")).toBeDefined();

    // 3. 清除推送历史
    list = dropPushNotifs(list);

    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe("alarm");
  });
});

// ============================================================================
// 8. 性能测试
// ============================================================================

describe("mergePushHistory - 性能", () => {
  test("1000 条记录合并应在 100ms 内完成", () => {
    const existing = Array.from({ length: 500 }, (_, i) =>
      makeNotif({ id: `existing_${i}`, time: NOW - i * 1000 })
    );

    const records = Array.from({ length: 500 }, (_, i) =>
      makeRecord({ id: `new_${i}`, received_at: new Date(NOW + i * 1000).toISOString() })
    );

    const start = performance.now();
    const result = mergePushHistory(existing, records, NOW, 1000);
    const duration = performance.now() - start;

    expect(result.length).toBe(1000);
    expect(duration).toBeLessThan(100);
  });

  test("10000 条记录排序应在合理时间内完成", () => {
    const records = Array.from({ length: 10000 }, (_, i) =>
      makeRecord({
        id: `push_${i}`,
        received_at: new Date(NOW - Math.random() * 1000000).toISOString(),
      })
    );

    const start = performance.now();
    const result = mergePushHistory([], records, NOW, 20000);
    const duration = performance.now() - start;

    expect(result.length).toBe(10000);
    expect(duration).toBeLessThan(500);
  });
});
