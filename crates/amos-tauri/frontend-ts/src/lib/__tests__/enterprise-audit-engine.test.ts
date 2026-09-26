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
import { readStoreValue, writeStoreValue } from "../amosStore";
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
const prevWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

/**
 * 装一个全局**属性**，而不是赋值。
 *
 * 为什么（2026-09-22）：`enterprise.test.ts` 在同一个 pure 批次里先跑，它注册
 * happy-dom，于是 `globalThis.navigator` 变成**只读访问器**；这里原来写的是
 * `globals.navigator = {...}`，在那种顺序下**抛 TypeError**（赋值给只读属性），
 * 而 `beforeAll` 抛错会让 bun 把本文件最前面的 7 条测成失败 —— 桩根本没人装，
 * 文件的存储缝也没生效。`Object.defineProperty` 不受只读访问器影响，
 * 所以桩在任何文件顺序下都真的装得上；`afterAll` 按描述符原样还原。
 */
const installGlobal = (key: string, value: unknown): void => {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
};

beforeAll(() => {
  installGlobal("window", { localStorage: mockStorage, dispatchEvent: () => true });
  // navigator 缝：`collectMetadata` 读取 platform/userAgent。
  installGlobal("navigator", { platform: "test-platform", userAgent: "test-agent/1.0" });
});

afterAll(() => {
  for (const [key, prev] of [
    ["window", prevWindow],
    ["navigator", prevNavigator],
  ] as const) {
    if (prev) Object.defineProperty(globalThis, key, prev);
    else delete globals[key];
  }
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

  it('sortBy: "result" 是声明的第三个维度，不能静默空转（REQ-A1542 ∕ F-SH-782）', async () => {
    await seed();
    // `seed` 的插入顺序（也是时间戳顺序）是 success, failure, blocked, success；按结果
    // **升序严重度**期望 success, success, failure, blocked。两者不同，所以「比较器里没有
    // result 分支、每一对都返回 0」的旧形状下，`sort` 会稳定地原样返回输入序 —— 这一行必红。
    const asc = logger.query({ sortBy: "result", sortOrder: "asc" });
    expect(asc.map((l) => l.result)).toEqual(["success", "success", "failure", "blocked"]);
    // 反面控：换方向必须是精确倒序，挡开「只把 error/failure 挪到前面」这类半吊子实现。
    expect(logger.query({ sortBy: "result", sortOrder: "desc" }).map((l) => l.result)).toEqual([
      "blocked",
      "failure",
      "success",
      "success",
    ]);
    // 负控：结果序必须与时间序**不同** —— 旧形状下 asc 恰好就是时间序，这条把「其实没排」
    // 和「其实按了时间」一并挡在外面（与上面第一条互为独立判据）。
    expect(asc.map((l) => l.result)).not.toEqual(
      logger.query({ sortBy: "timestamp", sortOrder: "asc" }).map((l) => l.result),
    );
    // 正控：兄弟维度 `level` 没被这次改动碰坏。
    expect(logger.query({ sortBy: "level", sortOrder: "desc" })[0]!.level).toBe("error");
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
    // 时间窗过滤：落在时间轴之后 → 空；覆盖全部时间 → 4 条。
    // （REQ-A1495 起 `getStatistics` 收整份 `AuditLogQuery`，与 `query` ∕ `exportLogs` 同一契约。）
    const now = Date.now();
    expect(logger.getStatistics({ startTime: now + 1e6 }).totalLogs).toBe(0);
    expect(logger.getStatistics({ startTime: now - 1e6, endTime: now + 1e6 }).totalLogs).toBe(4);
  });

  it("getStatistics 与 query 读同一份查询，不只是同一个时间窗（REQ-A1495 / F-SH-736）", async () => {
    await seed();
    // 统计卡必须描述**列表正在显示的那个集合**：列表 ∕ 导出 ∕ 统计三者共用同一条 `filterLogs`。
    // 修前 `getStatistics(startTime?, endTime?)` 收不到 `results` 这类维度，于是筛「失败」时
    // 列表只剩 1 行，统计卡照旧印整窗的 4 条 —— 两个和，同一屏。
    const rows = logger.query({ results: ["failure"] });
    const s = logger.getStatistics({ results: ["failure"] });
    expect(rows.length).toBe(1);
    expect(s.totalLogs).toBe(rows.length);
    expect(s.failureCount).toBe(1);
    expect(s.successCount).toBe(0);
    // 同一个判据的另一面：空集查询下统计卡的四格全 0，而不是时间窗的分布。
    expect(logger.getStatistics({ results: ["failure"], levels: ["debug"] }).totalLogs).toBe(0);
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
  /**
   * 缓冲区是私有字段：`flushBuffer()` 的语义是**移动**（buffer → logs），而公开的
   * `query()` 读的是两者的**并集**（REQ-A897），所以公开面看不见「搬没搬」。
   * 这两条测的恰恰是搬运，才需要直接读它。
   */
  const buffered = () => (logger as unknown as { buffer: unknown[] }).buffer.length;

  it("缓冲区满自动落盘到日志（而写下来的行一路都看得见）", async () => {
    logger.updateConfig({ bufferSize: 2 });
    await logger.log({ eventType: "system_start", eventCategory: "system", eventDescription: "1" });
    // REQ-A897：写下来的就看得见，不必先刷新 —— 从前这里断言的是 0（「仍在缓冲」），
    // 也就是把缺陷本身写成了契约。
    expect(logger.query({}).length).toBe(1);
    expect(buffered()).toBe(1); // 还没满，没搬

    await logger.log({ eventType: "system_start", eventCategory: "system", eventDescription: "2" });
    // 满 2 条 ⇒ 自动落盘：行从缓冲搬进主数组，一条不少、也不重复。
    expect(buffered()).toBe(0);
    expect(logger.query({}).length).toBe(2);
  });

  it("shutdown 把收尾条目留在缓冲里 —— 但它已经可读（REQ-A897）", async () => {
    await logger.initialize();
    await logger.shutdown();
    // shutdown 后的收尾条目先进缓冲区 —— 这是模块的既定语义（不额外落盘）。
    expect(buffered()).toBeGreaterThan(0);
    // 而「留在缓冲」不等于「看不见」：审计查看器读的是并集。
    const stops = logger.query({ eventTypes: ["system_stop"] });
    expect(stops.length).toBe(1);

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
    // 坏掉的日志不该漏进结果里：`initialize()` 自己会记一条 system_start，
    // 除此之外必须什么都没有。
    const kinds = new Set(logger.query({}).map((l) => l.eventType));
    expect([...kinds]).toEqual(["system_start"]);
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

/**
 * 保留期的**生产入口**（REQ-A982 / F-SH-309）。
 *
 * 上面那条「过期清理」用例经 `initialize()` 驱动保留期，而 `initialize()` 的唯一调用者
 * 是 `enterprise/index.ts` 的 `initializeEnterprise()` —— 那个函数在生产里**零调用者**
 * （它自己也在 `scripts/unwired-baseline.json` 里）。设备上真正会跑到的引导是
 * `ensureInitialized()`，它由 `log()` / `query()` / `getStatistics()` 自己叫起来。
 * 所以这里的用例**不碰** `initialize()`：驱动它的正是审计查看器读日志时用的那个调用。
 *
 * 形状即 `project_test_on_helper_not_the_seam`：把 `bootstrap()` 里那行
 * `this.cleanupExpiredLogs()` 删掉（其余一字不动），上面那条用例**仍然全绿**，本组才红。
 */
describe("审计保留期由生产入口执行", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const base = {
    level: "info",
    result: "success",
    eventType: "system_start",
    eventCategory: "system",
    userId: "u",
    userName: "n",
    userEmail: "e",
    deviceId: "d",
    organizationId: "o",
    metadata: { tags: [] },
  };
  const rows = (now: number) => [
    { ...base, id: "old-synced", timestamp: now - 400 * DAY, synced: true, eventDescription: "old synced" },
    { ...base, id: "old-unsynced", timestamp: now - 400 * DAY, synced: false, eventDescription: "old unsynced" },
    { ...base, id: "recent", timestamp: now, synced: true, eventDescription: "recent" },
  ];
  /** 与 `saveLogs` 的写法不同（缩进过），所以「有没有被重写」是可观测的。 */
  const seedPretty = (value: unknown) => writeStoreValue(AUDIT_LOGS_KEY, JSON.stringify(value, null, 2));

  it("query() 引导时就执行保留期：过期且已同步的行被删掉", () => {
    const now = Date.now();
    seedPretty(rows(now));
    // 审计查看器读日志走的就是这一句 —— 没有任何 `initialize()`。
    const ids = logger.query({}).map((l) => l.id);
    expect(ids).not.toContain("old-synced");
    // 两侧都钉住：未同步的过期行必须留下（删了就是永久丢失），新鲜的一行必须留下。
    expect(ids).toContain("old-unsynced");
    expect(ids).toContain("recent");
  });

  it("getStatistics() 引导时同样执行保留期（保留期不挂在某一个入口上）", () => {
    const now = Date.now();
    seedPretty(rows(now));
    // `getStatistics` 是审计查看器开页面时的第二个调用，且它**不**经过 `query()`。
    expect(logger.getStatistics().totalLogs).toBe(2);
  });

  it("没有过期行时不重写日志存储", () => {
    const pretty = JSON.stringify([{ ...base, id: "fresh", timestamp: Date.now(), synced: true, eventDescription: "fresh" }], null, 2);
    writeStoreValue(AUDIT_LOGS_KEY, pretty);
    logger.query({});
    // 存储里还是那份缩进过的文本 ⇒ `saveLogs()` 没被调用过。缩进只是探针：
    // 真正要钉的是「引导不产生一次空写」（配额紧张时，空写挤掉的是别的键）。
    const raw = readStoreValue<string>(AUDIT_LOGS_KEY, "");
    expect(raw).toBe(pretty);
  });

  it("保留期用的是存储里那份配置，不是编译期默认值", () => {
    const now = Date.now();
    // retentionDays=1：只留一天。存储里那份配置没被读到时，默认 90 天会留下全部三行。
    writeStoreValue(AUDIT_CONFIG_KEY, JSON.stringify({ retentionDays: 1 }));
    seedPretty([
      { ...base, id: "two-days", timestamp: now - 2 * DAY, synced: true, eventDescription: "two days" },
      { ...base, id: "today", timestamp: now, synced: true, eventDescription: "today" },
    ]);
    const ids = logger.query({}).map((l) => l.id);
    expect(ids).toEqual(["today"]);
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




