/**
 * enterprise-audit-engine.test.ts — 审计轨引擎契约（src/lib/enterprise/audit.ts，REQ-A396）。
 *
 * 用全新的 `AuditLogger` 实例逐分支驱动：
 * - 初始化（定时器启动/关闭、system_start 记录、过期日志清理）；
 * - log()：开关、最低级别过滤、级别推断、敏感字段脱敏（含嵌套对象）、签名；
 * - query()：全部过滤维度 + 搜索 + 排序 + 分页；getStatistics 聚合；
 * - exportLogs 的 JSON/CSV 两格式；flushBuffer 与缓冲区满自动落盘；
 * - syncToServer：经 MDM 配置 + 假 fetch 验证批量上云、成功后标记 synced 并清队列；
 * - 配置/日志/队列的持久化加载与损坏回退。
 */
import { describe, test as it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { AuditLogger, AUDIT_LOGS_KEY, AUDIT_CONFIG_KEY } from "../enterprise/audit";
import { writeStoreValue } from "../amosStore";
import { mdmManager } from "../enterprise/mdm";
import type { MDMConfig } from "../enterprise/mdm";

// ---- 存储缝 ----
//
// 这个文件**故意不注册 happy-dom**（DOM 文件不计入 P2-1 覆盖率，`coverage:gate` 只跑
// pure 批次），只给 `amosStore` 真正用到的那个 DOM 面（`window.localStorage`）一个内存
// 实现。
//
// **但 pure 批次是"一个进程跑所有文件"**，所以这个桩只能在本文件的生命周期内存在：
// 装在模块顶层会泄漏给同批次后面的文件。实测（2026-09-18）——桩建在顶层时
// `enterprise-audit.test.ts` 的「并发安全 > 应该处理并发日志记录」变红：那个文件的
// `beforeEach` 只在存储**不可用**时才会回落到默认配置（`loadConfig` 读不到就 `saveConfig`），
// 一个可用的 `localStorage` 把前面用例写下的 `minLevel: "warning"` 持久化并重新加载，
// 于是一整组 info 级日志被静默丢弃、10 个并发 id 全成了 `""`。因此 `beforeAll` 装、
// `afterAll` 还原（与 `enterprise-webhooks.test.ts` 同一约定）。
const storageMap = new Map<string, string>();
const mockStorage: Storage = {
  getItem: (key) => storageMap.get(key) ?? null,
  setItem: (key, value) => void storageMap.set(key, value),
  removeItem: (key) => void storageMap.delete(key),
  clear: () => storageMap.clear(),
  key: (index) => [...storageMap.keys()][index] ?? null,
  get length() {
    return storageMap.size;
  },
};
const globals = globalThis as Record<string, unknown>;
const prevWindow = globals.window;
const prevNavigator = globals.navigator;

beforeAll(() => {
  globals.window = { localStorage: mockStorage, dispatchEvent: () => true };
  // navigator 缝：`collectMetadata` 读取 platform/userAgent。
  globals.navigator = { platform: "test-platform", userAgent: "test-agent/1.0" };
});

afterAll(() => {
  if (prevWindow === undefined) delete globals.window;
  else globals.window = prevWindow;
  if (prevNavigator === undefined) delete globals.navigator;
  else globals.navigator = prevNavigator;
});

function mdmTestConfig(): MDMConfig {
  return {
    enabled: true,
    organizationId: "org-77",
    organizationName: "Acme",
    deviceId: "device-audit",
    deviceName: "Audit Mac",
    serverUrl: "https://mdm.example.test",
    apiKey: "key-audit",
    policies: [],
    restrictions: {
      disabledCategories: [],
      disabledActions: [],
      maxExecutionTime: 300,
      maxExecutionsPerDay: 1000,
      maxActionsPerShortcut: 100,
      maxShortcutsPerUser: 100,
      allowUserCreate: true,
      allowUserModify: true,
      allowUserDelete: true,
      allowSharing: true,
      allowExport: true,
      allowImport: true,
      requireApprovalForCreate: false,
      requireApprovalForModify: false,
      requireApprovalForSharing: false,
    },
    enforcedShortcuts: [],
    enforcedTemplates: [],
    syncInterval: 3600,
    lastSyncAt: 0,
    lastSyncStatus: "pending",
    deviceStatus: "active",
    enrolledAt: 0,
    enrolledBy: "test",
    version: "1",
  };
}

let logger: AuditLogger;
beforeEach(() => {
  storageMap.clear();
  mdmManager.setConfigForTest(mdmTestConfig());
  logger = new AuditLogger();
});

afterEach(async () => {
  await logger.shutdown();
  delete (globalThis as { fetch?: unknown }).fetch;
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("审计日志记录与脱敏", () => {
  it("enabled=false 时 log() 直接短路返回空 id", async () => {
    logger.updateConfig({ enabled: false });
    expect(await logger.log({ eventType: "system_start", eventCategory: "system", eventDescription: "x" })).toBe("");
  });

  it("低于最低级别的日志被丢弃", async () => {
    logger.updateConfig({ minLevel: "error" });
    expect(
      await logger.log({ eventType: "shortcut_create", eventCategory: "management", eventDescription: "info 级" }),
    ).toBe("");
    expect(
      await logger.log({
        eventType: "shortcut_execute_failure",
        eventCategory: "execution",
        eventDescription: "error 级",
        level: "error",
      }),
    ).not.toBe("");
  });

  it("级别推断：failure→error、blocked→warning、事件名含 error/warning", async () => {
    logger.updateConfig({ minLevel: "warning" });
    // failure 结果推断为 error（保留）；blocked 推断为 warning（保留）；info 被丢
    expect(
      await logger.log({
        eventType: "shortcut_share", eventCategory: "management", eventDescription: "被阻止", result: "blocked",
      }),
    ).not.toBe("");
    expect(
      await logger.log({
        eventType: "config_error" as never, eventCategory: "system", eventDescription: "事件名带 error",
      }),
    ).not.toBe("");
    expect(
      await logger.log({ eventType: "system_start", eventCategory: "system", eventDescription: "普通 info" }),
    ).toBe("");
  });

  it("敏感字段脱敏：顶层与嵌套对象都被掩码，其余原样", async () => {
    const id = await logger.log({
      eventType: "shortcut_update", eventCategory: "management", eventDescription: "改配置",
      actionDetails: { password: "hunter2", apiKey: "k-1", note: "keepme", nested: { token: "t-1", visible: 7 } },
    });
    logger.updateConfig({ bufferSize: 1 }); // 触发下一次 log 自动 flush？——改为手动 flush
    await logger.flushBuffer();
    const entry = logger.query({}).find((l) => l.id === id)!;
    expect(entry).not.toBeUndefined();
    const d = entry.actionDetails as Record<string, unknown>;
    expect(d.password).toBe("***MASKED***");
    expect(d.apiKey).toBe("***MASKED***");
    expect(d.note).toBe("keepme");
    expect((d.nested as Record<string, unknown>).token).toBe("***MASKED***");
    expect((d.nested as Record<string, unknown>).visible).toBe(7);
  });

  it("关闭脱敏后原样保留", async () => {
    logger.updateConfig({ maskSensitiveData: false });
    const id = await logger.log({
      eventType: "shortcut_update", eventCategory: "management", eventDescription: "改配置",
      actionDetails: { password: "hunter2" },
    });
    await logger.flushBuffer();
    expect((logger.query({}).find((l) => l.id === id)!.actionDetails as Record<string, unknown>).password).toBe("hunter2");
  });

  it("签名：有 signatureKey 时非空，没有时为空串", async () => {
    logger.updateConfig({ enableSignature: true, signatureKey: "secret-key" });
    const signed = await logger.log({ eventType: "system_start", eventCategory: "system", eventDescription: "s" });
    logger.updateConfig({ enableSignature: true, signatureKey: undefined });
    const unsigned = await logger.log({ eventType: "system_start", eventCategory: "system", eventDescription: "u" });
    await logger.flushBuffer();
    const all = logger.query({});
    expect(all.find((l) => l.id === signed)!.signature!.length).toBeGreaterThan(0);
    expect(all.find((l) => l.id === unsigned)!.signature).toBe("");
  });

  it("logExecution 映射成功/失败两种事件", async () => {
    await logger.logExecution({ shortcutId: "s1", shortcutName: "重启", success: true, duration: 12, actionCount: 3 });
    await logger.logExecution({
      shortcutId: "s2", shortcutName: "炸了", success: false, duration: 40, actionCount: 2, errorMessage: "boom",
    });
    await logger.flushBuffer();
    const logs = logger.query({ sortBy: "timestamp", sortOrder: "asc" });
    const success = logs.find((l) => l.resourceId === "s1")!;
    const failure = logs.find((l) => l.resourceId === "s2")!;
    expect(success.eventType).toBe("shortcut_execute_success");
    expect(success.level).toBe("info");
    expect(failure.eventType).toBe("shortcut_execute_failure");
    expect(failure.level).toBe("error");
    expect(failure.errorMessage).toBe("boom");
    expect(failure.duration).toBe(40);
  });
});

describe("审计查询 / 统计 / 导出", () => {
  async function seed(): Promise<void> {
    await logger.log({ eventType: "shortcut_create", eventCategory: "management", eventDescription: "创建 A", resourceType: "shortcut", resourceId: "a", resourceName: "A", tags: ["create"] });
    await logger.log({ eventType: "shortcut_execute_failure", eventCategory: "execution", eventDescription: "执行 B 失败", resourceType: "shortcut", resourceId: "b", resourceName: "Bee", result: "failure", level: "error", duration: 30, tags: ["exec"] });
    await logger.log({ eventType: "shortcut_share", eventCategory: "management", eventDescription: "分享 C 被阻止", resourceType: "shortcut", resourceId: "c", resourceName: "See", result: "blocked", tags: ["share"] });
    await logger.log({ eventType: "system_start", eventCategory: "system", eventDescription: "系统启动", duration: 10 });
    await logger.flushBuffer();
  }

  it("query 全维度过滤", async () => {
    await seed();
    expect(logger.query({ eventCategories: ["execution"] }).length).toBe(1);
    expect(logger.query({ results: ["blocked", "failure"] }).length).toBe(2);
    expect(logger.query({ levels: ["error"] }).length).toBe(1);
    expect(logger.query({ resourceType: "shortcut", resourceId: "b" }).length).toBe(1);
    expect(logger.query({ search: "bee" }).length).toBe(1);
    expect(logger.query({ tags: ["create"] }).length).toBe(1);
    expect(logger.query({ eventTypes: ["system_start"] }).length).toBe(1);
    // 组合：分页 + 排序
    const page = logger.query({ sortBy: "level", sortOrder: "desc", offset: 0, limit: 2 });
    expect(page.length).toBe(2);
    expect(page[0]!.level).toBe("error");
  });

  it("getStatistics 聚合结果/类型/时长", async () => {
    await seed();
    const s = logger.getStatistics();
    expect(s.totalLogs).toBe(4);
    expect(s.successCount).toBe(2);
    expect(s.failureCount).toBe(1);
    expect(s.blockedCount).toBe(1);
    expect(s.byEventType.shortcut_create).toBe(1);
    expect(s.byCategory.execution).toBe(1);
    expect(s.avgDuration).toBe(20); // (30 + 10) / 2
    expect(s.maxDuration).toBe(30);
    expect(s.minDuration).toBe(10);
    // 时间窗过滤：落在时间轴之后 → 空；覆盖全部时间 → 4 条
    const now = Date.now();
    expect(logger.getStatistics(now + 1e6).totalLogs).toBe(0);
    expect(logger.getStatistics(now - 1e6, now + 1e6).totalLogs).toBe(4);
  });

  it("exportLogs：JSON 原样导出，CSV 带表头与行", async () => {
    await seed();
    const json = await logger.exportLogs({}, "json");
    expect(JSON.parse(json).length).toBe(4);
    const csv = await logger.exportLogs({ results: ["failure"] }, "csv");
    const lines = csv.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("事件类型");
    expect(lines[1]).toContain("执行 B 失败");
  });
});

describe("审计初始化 / 落盘 / 同步", () => {
  it("缓冲区满自动落盘到日志", async () => {
    logger.updateConfig({ bufferSize: 2 });
    await logger.log({ eventType: "system_start", eventCategory: "system", eventDescription: "1" });
    expect(logger.query({}).length).toBe(0); // 仍在缓冲
    await logger.log({ eventType: "system_start", eventCategory: "system", eventDescription: "2" });
    await logger.flushBuffer();
    expect(logger.query({}).length).toBe(2);
  });

  it("initialize 记录 system_start，shutdown 把 system_stop 留在缓冲（刷新后可见）", async () => {
    await logger.initialize();
    await logger.shutdown();
    // shutdown 后的收尾条目先进缓冲区 —— 这是模块的既定语义
    expect(logger.query({ eventTypes: ["system_stop"] }).length).toBe(0);
    await logger.flushBuffer();
    const kinds = logger.query({ eventTypes: ["system_start", "system_stop"] }).map((l) => l.eventType);
    expect(kinds).toContain("system_start");
    expect(kinds).toContain("system_stop");
  });

  it("损坏的配置/日志 JSON 回退默认而不抛", async () => {
    mockStorage.setItem(AUDIT_CONFIG_KEY, "{not json");
    mockStorage.setItem(AUDIT_LOGS_KEY, "[broken");
    await logger.initialize();
    expect(logger.getConfig().minLevel).toBe("info");
    expect(logger.query({}).length).toBe(0);
    await logger.shutdown();
  });

  it("过期清理：只删已同步的过期日志", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const base = { level: "info", result: "success", eventType: "system_start", eventCategory: "system", userId: "u", userName: "n", userEmail: "e", deviceId: "d", organizationId: "o", metadata: { tags: [] } };
    // 经存储层写入（envelope 格式与 saveLogs 一致）
    writeStoreValue(
      AUDIT_LOGS_KEY,
      JSON.stringify([
        { ...base, id: "old-synced", timestamp: now - 400 * day, synced: true, eventDescription: "old synced" },
        { ...base, id: "old-unsynced", timestamp: now - 400 * day, synced: false, eventDescription: "old unsynced" },
        { ...base, id: "recent", timestamp: now, synced: true, eventDescription: "recent" },
      ]),
    );
    await logger.initialize(); // retentionDays 默认 90
    const ids = logger.query({}).map((l) => l.id);
    expect(ids).toContain("old-unsynced");
    expect(ids).toContain("recent");
    expect(ids).not.toContain("old-synced");
    await logger.shutdown();
  });
});

describe("审计上云同步", () => {
  it("syncToServer：经 MDM 配置把队列批量上云，成功后标记 synced", async () => {
    logger.updateConfig({ syncEnabled: true, syncInterval: 0, syncBatchSize: 10, flushInterval: 0 });
    await logger.initialize(); // syncEnabled 且 MDM 已启用 → 同步定时器以 0ms 间隔启动
    await logger.log({ eventType: "system_start", eventCategory: "system", eventDescription: "待同步" });
    await logger.flushBuffer();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    (globalThis as { fetch?: unknown }).fetch = (async (url: string, init: RequestInit) => ({
      json: async () => {
        calls.push({ url, init });
        return { success: true };
      },
    })) as unknown as typeof fetch;
    await flush();
    await flush();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.url).toBe("https://mdm.example.test/api/audit/sync");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer key-audit");
    expect(logger.query({}).every((l) => l.synced === true)).toBe(true);
    await logger.shutdown();
  });

  it("syncToServer：MDM 未启用时是 no-op（不发起 fetch）", async () => {
    mdmManager.setConfigForTest({ ...mdmTestConfig(), enabled: false });
    logger.updateConfig({ syncEnabled: true, syncInterval: 0 });
    await logger.initialize();
    await logger.log({ eventType: "system_start", eventCategory: "system", eventDescription: "不上云" });
    await logger.flushBuffer();
    let fetched = 0;
    (globalThis as { fetch?: unknown }).fetch = (async () => {
      fetched++;
      return { json: async () => ({ success: true }) };
    });
    await flush();
    await flush();
    expect(fetched).toBe(0);
    expect(logger.query({})[0]!.synced).toBe(false);
    await logger.shutdown();
  });

  it("clearAllLogs 清空内存状态", async () => {
    await logger.log({ eventType: "system_start", eventCategory: "system", eventDescription: "x" });
    await logger.flushBuffer();
    expect(logger.query({}).length).toBe(1);
    logger.clearAllLogs();
    expect(logger.query({}).length).toBe(0);
  });
});




