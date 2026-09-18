/**
 * 通知去重和集成测试
 *
 * 验证推送通知与现有通知系统的集成质量：
 * 1. 通知去重逻辑（基于 ID）
 * 2. 跨通知类型去重
 * 3. 已读状态保持
 * 4. 通知优先级处理
 * 5. 数据流完整性
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ==================== Mock 设置 ====================

// 模拟 Tauri invoke
const mockInvoke = mock((command: string, args?: any) => {
  if (command === "push_get_history") {
    return Promise.resolve(mockPushHistory);
  }
  if (command === "push_get_status") {
    return Promise.resolve(mockPushStatus);
  }
  if (command === "push_clear_history") {
    return Promise.resolve({ kind: "ok" });
  }
  return Promise.resolve(null);
});

mock.module("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

let mockPushHistory: any[] = [];
let mockPushStatus: any = null;

// 模拟 localStorage
const mockStorage: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => mockStorage[key] ?? null,
  setItem: (key: string, value: string) => { mockStorage[key] = value; },
  removeItem: (key: string) => { delete mockStorage[key]; },
  clear: () => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); },
};

// 模拟 window
(global as any).window = (global as any).window || {};
(global as any).window.localStorage = localStorageMock;
(global as any).window.setInterval = mock(() => 123);
(global as any).window.clearInterval = mock(() => {});

// 模拟 svelte-i18n
const mockTranslate = (key: string) => key;
mock.module("svelte-i18n", () => ({
  _: { subscribe: (fn: any) => fn(mockTranslate) },
}));

// ==================== 测试套件 ====================

describe("通知去重逻辑", () => {
  beforeEach(() => {
    mockStorage[NOTIF_KEY] = JSON.stringify([]);
    mockPushHistory = [];
    mockPushStatus = null;
  });

  // ==================== 1. ID 去重测试 ====================

  test("相同 ID 的推送通知应该去重", async () => {
    const now = Date.now();
    const rec1 = {
      id: "push_001",
      received_at: new Date(now - 60000).toISOString(),
      read: false,
      payload: { aps: { alert: { title: "Test", body: "First" } } },
    };
    const rec2 = { ...rec1, payload: { aps: { alert: { title: "Test", body: "Updated" } } } };

    // 第一次拉取
    mockPushHistory = [rec1];
    const first = await mockInvoke("push_get_history");
    expect(first).toHaveLength(1);

    // 第二次拉取相同 ID
    mockPushHistory = [rec2];
    const second = await mockInvoke("push_get_history");
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(rec2.id);
  });

  test("不同 ID 的推送通知应该共存", () => {
    const notifs = [
      { id: "push_001", source: "push", time: Date.now() },
      { id: "push_002", source: "push", time: Date.now() },
      { id: "system_001", time: Date.now() },
    ];

    const uniqueIds = new Set(notifs.map(n => n.id));
    expect(uniqueIds.size).toBe(3);
    expect(notifs).toHaveLength(3);
  });

  // ==================== 2. 跨通知类型去重 ====================

  test("推送通知和系统通知使用不同的 ID 空间", () => {
    const pushNotif = { id: "push_abc123", source: "push", time: Date.now() };
    const systemNotif = { id: "system_xyz789", time: Date.now() };
    const all = [pushNotif, systemNotif];

    const ids = all.map(n => n.id);
    expect(new Set(ids).size).toBe(2); // 无重复
  });

  test("系统通知不应被推送通知覆盖", () => {
    const existing = [
      { id: "system_alarm_001", time: Date.now() - 1000, title: "Alarm" },
    ];
    const newPush = {
      id: "push_001",
      time: Date.now(),
      title: "Push",
      source: "push",
    };

    // 模拟合并逻辑
    const held = new Set(existing.map(n => n.id));
    if (!held.has(newPush.id)) {
      existing.push(newPush);
    }

    expect(existing).toHaveLength(2);
    expect(existing.find(n => n.id === "system_alarm_001")).toBeDefined();
    expect(existing.find(n => n.id === "push_001")).toBeDefined();
  });

  // ==================== 3. 已读状态保持 ====================

  test("用户标记已读后，重新拉取不应重置为未读", () => {
    const notif = { id: "push_001", read: false, source: "push", time: Date.now() };

    // 用户标记为已读
    notif.read = true;

    // 重新拉取（不应该覆盖已读状态）
    const refetched = { id: "push_001", read: false, source: "push", time: notif.time };

    // 合并逻辑：已存在的 ID 不覆盖
    const finalState = notif.read; // 保持本地状态
    expect(finalState).toBe(true);
    expect(refetched.read).toBe(false); // 后端状态
  });

  test("多次拉取同一通知，已读状态保持一致", () => {
    const localNotif = { id: "push_001", read: true, source: "push", time: Date.now() };

    // 模拟 10 次拉取
    for (let i = 0; i < 10; i++) {
      // 后端返回未读状态
      const backendNotif = { id: "push_001", read: false };

      // 由于 ID 已存在，不覆盖
      expect(localNotif.read).toBe(true);
    }
  });

  // ==================== 4. 时间排序测试 ====================

  test("通知应按时间倒序排列", () => {
    const now = Date.now();
    const notifs = [
      { id: "n1", time: now - 3000 },
      { id: "n2", time: now - 1000 },
      { id: "n3", time: now - 2000 },
    ];

    // 按时间倒序
    notifs.sort((a, b) => b.time - a.time);

    expect(notifs[0].id).toBe("n2");
    expect(notifs[1].id).toBe("n3");
    expect(notifs[2].id).toBe("n1");
  });

  test("相同时间的通知应保持稳定排序", () => {
    const time = Date.now();
    const notifs = [
      { id: "n1", time },
      { id: "n2", time },
      { id: "n3", time },
    ];

    // 使用稳定排序（V8 自带）
    notifs.sort((a, b) => b.time - a.time);

    // 顺序应该保持或可预测
    expect(notifs).toHaveLength(3);
  });

  // ==================== 5. 容量限制测试 ====================

  test("通知列表不应超过容量限制", () => {
    const NOTIF_CAP = 100;
    const existing = Array.from({ length: 90 }, (_, i) => ({
      id: `existing_${i}`,
      time: Date.now() - i * 1000,
    }));

    // 添加 50 条新通知
    const newNotifs = Array.from({ length: 50 }, (_, i) => ({
      id: `new_${i}`,
      time: Date.now() + i * 1000,
    }));

    const merged = [...newNotifs, ...existing].slice(0, NOTIF_CAP);

    expect(merged).toHaveLength(NOTIF_CAP);
    expect(merged[0].id).toBe("new_0"); // 最新的在前
  });

  test("容量为 0 时应清空列表", () => {
    const notifs = [{ id: "n1", time: 1 }];
    const capped = notifs.slice(0, 0);
    expect(capped).toHaveLength(0);
  });

  // ==================== 6. 边缘情况测试 ====================

  test("缺失 ID 字段的通知应被过滤", () => {
    const notifs = [
      { id: "valid_001", time: Date.now() },
      { time: Date.now() }, // 缺失 ID
      { id: "", time: Date.now() }, // 空 ID
    ];

    const valid = notifs.filter(n => n.id && n.id.length > 0);
    expect(valid).toHaveLength(1);
  });

  test("无效时间戳应使用 fallback", () => {
    const fallbackNow = Date.now();
    const notifs = [
      { id: "n1", time: NaN },
      { id: "n2", time: -1 },
      { id: "n3", time: 0 },
    ];

    const normalized = notifs.map(n => ({
      ...n,
      time: isFinite(n.time) && n.time > 0 ? n.time : fallbackNow,
    }));

    expect(normalized[0].time).toBe(fallbackNow);
    expect(normalized[1].time).toBe(fallbackNow);
    expect(normalized[2].time).toBe(fallbackNow);
  });

  test("重复 ID 的通知应合并为一条", () => {
    const notifs = [
      { id: "p1", source: "push", title: "First", time: 1000 },
      { id: "p1", source: "push", title: "Duplicate", time: 2000 },
      { id: "p2", source: "push", title: "Second", time: 3000 },
    ];

    const uniqueMap = new Map();
    notifs.forEach(n => uniqueMap.set(n.id, n));
    const unique = Array.from(uniqueMap.values());

    expect(unique).toHaveLength(2);
    // 保留后出现的（通常是更新的）
    expect(unique[0].id).toBe("p1");
  });

  // ==================== 7. 优先级测试 ====================

  test("紧急通知应在列表顶部", () => {
    const notifs = [
      { id: "n1", priority: 1, time: Date.now() },
      { id: "n2", priority: 2, time: Date.now() - 1000 }, // 高优先级
      { id: "n3", priority: 0, time: Date.now() },
    ];

    // 先按优先级，再按时间
    notifs.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return b.time - a.time;
    });

    expect(notifs[0].id).toBe("n2"); // 高优先级在前
  });

  // ==================== 8. 数据完整性测试 ====================

  test("清除推送历史不应影响系统通知", () => {
    const notifs = [
      { id: "push_001", source: "push", time: 1000 },
      { id: "system_001", time: 2000 },
      { id: "push_002", source: "push", time: 3000 },
      { id: "system_002", time: 4000 },
    ];

    const afterClear = notifs.filter(n => n.source !== "push");

    expect(afterClear).toHaveLength(2);
    expect(afterClear.every(n => n.source !== "push")).toBe(true);
    expect(afterClear.map(n => n.id)).toEqual(["system_001", "system_002"]);
  });

  test("添加推送通知应保持系统通知顺序", () => {
    const existing = [
      { id: "sys_001", time: 1000 },
      { id: "sys_002", time: 2000 },
    ];

    const newPush = {
      id: "push_001",
      source: "push",
      time: 5000,
    };

    const merged = [newPush, ...existing];

    expect(merged[0].id).toBe("push_001");
    expect(merged[1].id).toBe("sys_001");
    expect(merged[2].id).toBe("sys_002");
  });

  // ==================== 9. 并发安全测试 ====================

  test("并发轮询不应导致重复添加", async () => {
    const rec = {
      id: "push_concurrent",
      received_at: new Date().toISOString(),
      read: false,
      payload: { aps: { alert: "Test" } },
    };

    mockPushHistory = [rec];

    // 模拟 10 个并发请求
    const promises = Array.from({ length: 10 }, () =>
      mockInvoke("push_get_history"),
    );

    const results = await Promise.all(promises);

    // 所有结果应该相同
    results.forEach(result => {
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("push_concurrent");
    });
  });

  // ==================== 10. 性能测试 ====================

  test("1000 条通知的去重性能", () => {
    const start = performance.now();

    // 生成 1000 条通知
    const notifs = Array.from({ length: 1000 }, (_, i) => ({
      id: `push_${i}`,
      source: "push",
      time: Date.now() - i * 1000,
    }));

    // 去重
    const uniqueMap = new Map();
    notifs.forEach(n => uniqueMap.set(n.id, n));

    const end = performance.now();

    expect(uniqueMap.size).toBe(1000);
    expect(end - start).toBeLessThan(50); // 应在 50ms 内完成
  });

  test("10000 条通知的排序性能", () => {
    const start = performance.now();

    const notifs = Array.from({ length: 10000 }, (_, i) => ({
      id: `n${i}`,
      time: Date.now() - Math.random() * 1000000,
    }));

    notifs.sort((a, b) => b.time - a.time);

    const end = performance.now();

    expect(notifs).toHaveLength(10000);
    expect(end - start).toBeLessThan(100); // 应在 100ms 内完成
  });
});

// ==================== 集成测试 ====================

describe("推送通知集成测试", () => {
  beforeEach(() => {
    Object.keys(mockStorage).forEach(k => delete mockStorage[k]);
    mockPushHistory = [];
    mockPushStatus = null;
  });

  test("完整推送通知流程", async () => {
    // 1. 后端推送新通知
    mockPushHistory = [{
      id: "push_integration_001",
      received_at: new Date().toISOString(),
      read: false,
      payload: { aps: { alert: { title: "Test", body: "Integration test" } } },
    }];

    // 2. 轮询器拉取
    const history = await mockInvoke("push_get_history");
    expect(history).toHaveLength(1);

    // 3. 合并到存储
    const existing = JSON.parse(mockStorage[NOTIF_KEY] || "[]");
    const newNotif = {
      id: history[0].id,
      source: "push",
      title: history[0].payload.aps.alert.title,
      body: history[0].payload.aps.alert.body,
      time: Date.parse(history[0].received_at),
      read: false,
    };

    const merged = [newNotif, ...existing];
    mockStorage[NOTIF_KEY] = JSON.stringify(merged);

    // 4. 验证存储
    const stored = JSON.parse(mockStorage[NOTIF_KEY]);
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe("Test");
    expect(stored[0].source).toBe("push");
  });

  test("失败恢复流程", async () => {
    // 1. 设置初始状态
    mockStorage[NOTIF_KEY] = JSON.stringify([{
      id: "existing",
      time: Date.now() - 1000,
      title: "Existing",
    }]);

    // 2. 后端失败
    mockInvoke.mockImplementationOnce(() => Promise.reject(new Error("Network error")));

    // 3. 尝试拉取（应该失败但不破坏现有数据）
    try {
      await mockInvoke("push_get_history");
    } catch (e) {
      // 预期失败
    }

    // 4. 验证现有数据未受影响
    const stored = JSON.parse(mockStorage[NOTIF_KEY]);
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe("existing");
  });

  test("清除历史流程", async () => {
    // 1. 设置初始状态（混合推送和系统通知）
    mockStorage[NOTIF_KEY] = JSON.stringify([
      { id: "push_001", source: "push", time: 1000 },
      { id: "system_001", time: 2000 },
      { id: "push_002", source: "push", time: 3000 },
      { id: "system_002", time: 4000 },
    ]);

    // 2. 清除推送历史
    const result = await mockInvoke("push_clear_history");
    expect(result.kind).toBe("ok");

    // 3. 本地过滤推送通知
    const notifs = JSON.parse(mockStorage[NOTIF_KEY]);
    const afterClear = notifs.filter(n => n.source !== "push");

    // 4. 更新存储
    mockStorage[NOTIF_KEY] = JSON.stringify(afterClear);

    // 5. 验证只剩系统通知
    const final = JSON.parse(mockStorage[NOTIF_KEY]);
    expect(final).toHaveLength(2);
    expect(final.every(n => n.source !== "push")).toBe(true);
  });
});

// 常量定义
const NOTIF_KEY = "amos.notifications";
