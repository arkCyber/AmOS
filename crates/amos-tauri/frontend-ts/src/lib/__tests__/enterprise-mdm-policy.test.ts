/**
 * __tests__/enterprise-mdm-policy.test.ts — `enterprise/mdm.ts` 的策略/限制面（P2-1 覆盖）
 *
 * 为什么单独一个文件：管道修复（REQ-A390 让隔离运行的测试也计入覆盖）之后，`mdm.ts` 是
 * `src/lib` 里**未覆盖最多**的文件（346 行）。它此前只有「配置能存下来」这类烟测覆盖，
 * 而真正决定"企业策略到底管不管用"的是这些**纯判定**：分类/操作禁用、六种权限、强制快捷
 * 指令不可改不可删、执行时间/操作数/每日次数上限、策略增删改（恢复默认值后必须落盘）。
 *
 * 不导入 happy-dom（保持 pure 批次，覆盖计入 P2-1）；`window.localStorage` 与 `navigator`
 * 桩只在本文件生命周期内存在（pure 批次是一个进程跑所有文件，顶层安装会泄漏给同批次的其他
 * 文件 —— 这一点在 REQ-A390 里踩过）。
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mdmManager, MDMManager, type MDMConfig, type MDMRestrictions } from "../enterprise/mdm";
import { readStoreValue } from "../amosStore";

const memory = new Map<string, string>();
const stub = {
  localStorage: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => void memory.set(key, String(value)),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  },
};
const globals = globalThis as Record<string, unknown>;
const previousWindow = globals.window;
const previousNavigator = globals.navigator;

beforeAll(() => {
  globals.window = stub;
  // `enrollDevice` 读 `navigator.platform` / `navigator.userAgent`（无头环境没有 navigator）。
  globals.navigator = { platform: "test-platform", userAgent: "test-agent" };
});

afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
  if (previousNavigator === undefined) delete globals.navigator;
  else globals.navigator = previousNavigator;
});

const realFetch = globalThis.fetch;

/** 每次 fetch 的 (url, init)，供断言头/体；`afterEach` 清空。 */
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];

/**
 * 打桩 `fetch`：`handler` 返回 `{ body }` 当作 JSON 响应，或返回 `Error` 让调用抛。
 * `enterprise-api.test.ts` 用的是同一套路（验的是我们自己的契约，不是真实 HTTP）。
 */
function stubFetch(
  handler: (url: string, init: RequestInit) => { body: unknown } | Error,
): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const opts = init ?? {};
    fetchCalls.push({ url, init: opts });
    const result = handler(url, opts);
    if (result instanceof Error) throw result;
    return { json: async () => result.body, status: 200 } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** 一份最小可用的配置；限制项按用例覆盖。 */
function config(restrictions: Partial<MDMRestrictions> = {}, extra: Partial<MDMConfig> = {}): MDMConfig {
  return {
    enabled: true,
    organizationId: "org-1",
    organizationName: "Acme",
    deviceId: "device-test",
    deviceName: "Test Mac",
    serverUrl: "https://mdm.example.test",
    apiKey: "key-1",
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
      ...restrictions,
    },
    enforcedShortcuts: [],
    enforcedTemplates: [],
    syncInterval: 3600,
    lastSyncAt: 0,
    lastSyncStatus: "success",
    deviceStatus: "active",
    enrolledAt: 0,
    enrolledBy: "admin",
    version: "1.0.0",
    ...extra,
  };
}

beforeEach(() => {
  memory.clear();
  mdmManager.clearConfigForTest();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fetchCalls.length = 0;
  mdmManager.clearConfigForTest();
  mdmManager.stopAutoSync();
  mdmManager.shutdown();
  memory.clear();
});

describe("MDM 未启用时一切放行（策略不该拦没有 MDM 的设备）", () => {
  test("无配置：所有判定都允许，且不抛", () => {
    expect(mdmManager.checkActionAllowed("apps", "any")).toEqual({ allowed: true });
    expect(mdmManager.checkPermission("delete")).toEqual({ allowed: true });
    expect(mdmManager.checkCanCreate()).toEqual({ allowed: true });
    expect(mdmManager.checkCanModify("s-1")).toEqual({ allowed: true });
    expect(mdmManager.checkCanDelete("s-1")).toEqual({ allowed: true });
    expect(mdmManager.checkCanExecute("s-1", 999)).toEqual({ allowed: true });
    expect(mdmManager.checkExecutionTime(99999)).toEqual({ allowed: true });
    expect(mdmManager.checkActionCount(99999)).toEqual({ allowed: true });
    expect(mdmManager.checkDailyExecutionLimit("s-1")).toEqual({ allowed: true });
    expect(mdmManager.isActionDisabled("any", "apps")).toBe(false);
    expect(mdmManager.isEnabled()).toBe(false);
    expect(mdmManager.getConfig()).toBeNull();
  });

  test("enabled=false 的配置同样放行", () => {
    mdmManager.setConfigForTest(config({ allowUserDelete: false }, { enabled: false }));
    expect(mdmManager.checkPermission("delete")).toEqual({ allowed: true });
    expect(mdmManager.isActionDisabled("x", "apps")).toBe(false);
    mdmManager.recordExecution("s-1"); // 不记录、不抛
  });
});

describe("MDM 分类 / 操作禁用", () => {
  test("禁用分类：拒绝并说明是哪一类", () => {
    mdmManager.setConfigForTest(config({ disabledCategories: ["scripting"] }));
    const denied = mdmManager.checkActionAllowed("scripting", "run-script");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("scripting");
    expect(mdmManager.checkActionAllowed("apps", "open-app")).toEqual({ allowed: true });
    expect(mdmManager.isActionDisabled("anything", "scripting")).toBe(true);
    expect(mdmManager.isActionDisabled("anything", "apps")).toBe(false);
  });

  test("禁用单个操作：拒绝并点名那个操作", () => {
    mdmManager.setConfigForTest(config({ disabledActions: ["shell.execute"] }));
    const denied = mdmManager.checkActionAllowed("scripting", "shell.execute");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("shell.execute");
    expect(mdmManager.isActionDisabled("shell.execute", "apps")).toBe(true);
  });
});

describe("MDM 六种权限判定", () => {
  test("create：禁止 / 需审批 / 允许 三种回答", () => {
    mdmManager.setConfigForTest(config({ allowUserCreate: false }));
    expect(mdmManager.checkPermission("create").reason).toContain("禁止创建");
    mdmManager.setConfigForTest(config({ requireApprovalForCreate: true }));
    expect(mdmManager.checkPermission("create").reason).toContain("需要管理员审批");
    mdmManager.setConfigForTest(config());
    expect(mdmManager.checkPermission("create")).toEqual({ allowed: true });
  });

  test("modify / share 的审批分支，以及 delete / export / import 的禁止分支", () => {
    mdmManager.setConfigForTest(config({ requireApprovalForModify: true }));
    expect(mdmManager.checkPermission("modify").reason).toContain("修改快捷指令需要管理员审批");
    mdmManager.setConfigForTest(config({ allowUserModify: false }));
    expect(mdmManager.checkPermission("modify").reason).toContain("禁止修改");

    mdmManager.setConfigForTest(config({ requireApprovalForSharing: true }));
    expect(mdmManager.checkPermission("share").reason).toContain("分享快捷指令需要管理员审批");
    mdmManager.setConfigForTest(config({ allowSharing: false }));
    expect(mdmManager.checkPermission("share").reason).toContain("禁止分享");

    mdmManager.setConfigForTest(config({ allowUserDelete: false }));
    expect(mdmManager.checkPermission("delete").reason).toContain("禁止删除");
    mdmManager.setConfigForTest(config({ allowExport: false }));
    expect(mdmManager.checkPermission("export").reason).toContain("禁止导出");
    mdmManager.setConfigForTest(config({ allowImport: false }));
    expect(mdmManager.checkPermission("import").reason).toContain("禁止导入");
  });

  test("强制安装的快捷指令：不可修改、不可删除（优先于开关）", () => {
    mdmManager.setConfigForTest(config({}, { enforcedShortcuts: ["forced-1"] }));
    expect(mdmManager.checkCanModify("forced-1").reason).toContain("不可修改");
    expect(mdmManager.checkCanDelete("forced-1").reason).toContain("不可删除");
    expect(mdmManager.checkCanModify("other")).toEqual({ allowed: true });
    expect(mdmManager.checkCanDelete("other")).toEqual({ allowed: true });
  });
});

describe("MDM 执行限制", () => {
  test("执行时间：超过 maxExecutionTime 才拒绝，边界值通过", () => {
    mdmManager.setConfigForTest(config({ maxExecutionTime: 10 }));
    expect(mdmManager.checkExecutionTime(10)).toEqual({ allowed: true });
    const denied = mdmManager.checkExecutionTime(11);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("10");
  });

  test("操作数：checkActionCount 与 checkCanExecute 用同一上限但措辞不同", () => {
    mdmManager.setConfigForTest(config({ maxActionsPerShortcut: 3 }));
    expect(mdmManager.checkActionCount(3)).toEqual({ allowed: true });
    expect(mdmManager.checkActionCount(4).reason).toContain("操作数超过");
    expect(mdmManager.checkCanExecute("s-1", 4).reason).toContain("快捷指令操作数超过限制");
    expect(mdmManager.checkCanExecute("s-1", 3)).toEqual({ allowed: true });
  });

  test("每日次数：recordExecution 累计到上限后拒绝，且计数按「日期-指令」落盘", () => {
    mdmManager.setConfigForTest(config({ maxExecutionsPerDay: 2 }));
    expect(mdmManager.checkDailyExecutionLimit("s-1")).toEqual({ allowed: true });

    mdmManager.recordExecution("s-1");
    mdmManager.recordExecution("s-1");
    const denied = mdmManager.checkDailyExecutionLimit("s-1");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("每日执行次数限制");
    expect(mdmManager.checkCanExecute("s-1", 1).reason).toContain("已达到每日最大执行次数");

    expect(mdmManager.checkDailyExecutionLimit("s-2")).toEqual({ allowed: true });

    const stored = memory.get("amos.shortcuts.mdm.execution_count") ?? "";
    const today = new Date().toISOString().split("T")[0];
    expect(stored).toContain(`${today}-s-1`);
  });
});

describe("MDM 策略增删改", () => {
  test("addPolicy 写入并落盘，新值立刻影响判定", async () => {
    mdmManager.setConfigForTest(config());
    await mdmManager.addPolicy("maxExecutionsPerDay", 5);
    expect(mdmManager.getPolicy("maxExecutionsPerDay")).toBe(5);
    expect(mdmManager.getRestrictionPolicies()?.maxExecutionsPerDay).toBe(5);
    // 落盘的是**密文信封**：`mdmCrypto` 加密后写入，所以断言"存下来了"要用信封形状，
    // 顺带钉住"明文不出现在存储里"（这条比"能读到键"更值得钉）。
    const stored = memory.get("amos.shortcuts.mdm.config") ?? "";
    expect(stored).toContain("ciphertext");
    expect(stored).toContain("iv");
    expect(stored).not.toContain("maxExecutionsPerDay");

    for (let i = 0; i < 5; i++) mdmManager.recordExecution("s-9");
    expect(mdmManager.checkDailyExecutionLimit("s-9").allowed).toBe(false);
  });

  test("deletePolicy 恢复默认值并落盘；没有配置时回 false", async () => {
    mdmManager.setConfigForTest(config({ allowUserCreate: false }));
    expect(await mdmManager.deletePolicy("allowUserCreate")).toBe(true);
    expect(mdmManager.getPolicy("allowUserCreate")).toBe(true);
    expect(mdmManager.checkPermission("create")).toEqual({ allowed: true });

    mdmManager.clearConfigForTest();
    expect(await mdmManager.deletePolicy("allowUserCreate")).toBe(false);
  });

  test("getPolicies 按 priority 从高到低排序，且不改动原数组", () => {
    const policies = [
      { id: "p-low", name: "low", description: "low priority", type: "execution_limit" as const, config: {}, enabled: true, priority: 1, createdAt: 0, updatedAt: 0 },
      { id: "p-high", name: "high", description: "high priority", type: "execution_limit" as const, config: {}, enabled: true, priority: 9, createdAt: 0, updatedAt: 0 },
    ];
    const cfg = config({}, { policies });
    mdmManager.setConfigForTest(cfg);
    expect(mdmManager.getPolicies().map((p) => p.id)).toEqual(["p-high", "p-low"]);
    expect(cfg.policies.map((p) => p.id)).toEqual(["p-low", "p-high"]);
    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(1000);
  });
});

// ============================================================================
// 每日执行配额：`saveExecutionCounts` / `loadExecutionCounts` 的**形状一致性**
// ============================================================================

const EXEC_COUNT_KEY = "amos.shortcuts.mdm.execution_count";
const MDM_CONFIG_KEY = "amos.shortcuts.mdm.config";

/** 按模块自己的读法取回落盘的那份计数（`writeJson` 只编码一层）。 */
function storedCounts(): { date: string; counts: Record<string, number> } | null {
  const raw = readStoreValue<string>(EXEC_COUNT_KEY, "");
  return raw ? (JSON.parse(raw) as { date: string; counts: Record<string, number> }) : null;
}

const today = () => new Date().toISOString().split("T")[0]!;

describe("MDM 每日执行配额跨重载（读写的形状必须是一份契约）", () => {
  test("落盘形状是 {date, counts}，键是「日期-指令」", () => {
    const m = new MDMManager();
    m.setConfigForTest(config({ maxExecutionsPerDay: 5 }));
    m.recordExecution("s-shape");

    const stored = storedCounts();
    expect(stored?.date).toBe(today());
    expect(stored?.counts[`${today()}-s-shape`]).toBe(1);
  });

  /**
   * 回归：`loadExecutionCounts` 曾经把 `{date, counts}` 整个当成"键 → 次数"的扁平表
   * （`new Map(Object.entries(data))`）⇒ 新实例读回来的键只有 `"date"` / `"counts"`，
   * 真实计数全丢 ⇒ `checkDailyExecutionLimit` 按 0 处理 ⇒ **每天重启一次配额就重置一次**。
   */
  test("重载后配额仍然生效（旧实现下这条必红）", async () => {
    const first = new MDMManager();
    first.setConfigForTest(config({ maxExecutionsPerDay: 2 }));
    first.recordExecution("s-1");
    first.recordExecution("s-1");
    expect(first.checkDailyExecutionLimit("s-1").allowed).toBe(false);

    // "重启"：新实例从同一个存储加载（配置仍由测试注入，只验计数那半边）
    const restarted = new MDMManager();
    await restarted.initialize();
    restarted.setConfigForTest(config({ maxExecutionsPerDay: 2 }));

    expect(restarted.checkDailyExecutionLimit("s-1").allowed).toBe(false);
    expect(restarted.checkDailyExecutionLimit("s-1").reason).toContain("每日执行次数限制");
    // 没到上限的另一条指令不受影响
    expect(restarted.checkDailyExecutionLimit("s-2").allowed).toBe(true);
  });

  test("昨天的计数今天不算（日期不同即清空，而不是把 date/counts 当指令 id）", async () => {
    const yesterday = "2000-01-01";
    memory.set(
      EXEC_COUNT_KEY,
      JSON.stringify(JSON.stringify({ date: yesterday, counts: { [`${yesterday}-s-1`]: 99 } })),
    );

    const m = new MDMManager();
    await m.initialize();
    m.setConfigForTest(config({ maxExecutionsPerDay: 1 }));

    expect(m.checkDailyExecutionLimit("s-1").allowed).toBe(true);
  });

  test("形状不认识（扁平表 / counts 非对象 / 坏 JSON）⇒ 清空，不崩", async () => {
    for (const payload of [
      { [`${today()}-s-1`]: 42 }, // 扁平表：不是本模块写的形状
      { date: today(), counts: [1, 2, 3] }, // counts 是数组
      { date: today(), counts: null },
      { date: today() }, // 缺 counts
    ]) {
      memory.set(EXEC_COUNT_KEY, JSON.stringify(JSON.stringify(payload)));
      const m = new MDMManager();
      await m.initialize();
      m.setConfigForTest(config({ maxExecutionsPerDay: 1 }));
      expect(m.checkDailyExecutionLimit("s-1").allowed).toBe(true);
    }

    memory.set(EXEC_COUNT_KEY, JSON.stringify("{ not json"));
    const m = new MDMManager();
    await m.initialize();
    m.setConfigForTest(config({ maxExecutionsPerDay: 1 }));
    expect(m.checkDailyExecutionLimit("s-1").allowed).toBe(true);
  });

  test("只有能解释的条目被读回：非数字/非有限值被丢弃，其余保留", async () => {
    memory.set(
      EXEC_COUNT_KEY,
      JSON.stringify(
        JSON.stringify({
          date: today(),
          counts: { [`${today()}-good`]: 3, [`${today()}-string`]: "9", [`${today()}-nan`]: Number.NaN },
        }),
      ),
    );

    const m = new MDMManager();
    await m.initialize();
    m.setConfigForTest(config({ maxExecutionsPerDay: 3 }));

    expect(m.checkDailyExecutionLimit("good").allowed).toBe(false); // 3 >= 3
    expect(m.checkDailyExecutionLimit("string").allowed).toBe(true); // 被丢弃 ⇒ 0
    expect(m.checkDailyExecutionLimit("nan").allowed).toBe(true);
  });
});

// ============================================================================
// 生命周期：锁定的设备 / 被远程擦除的设备
// ============================================================================

describe("MDM initialize 的设备状态门", () => {
  test("locked：抛错并带上管理员的说明", async () => {
    const saver = new MDMManager();
    saver.setConfigForTest(config({}, { deviceStatus: "locked", lockMessage: "维护中，请联系 IT" }));
    await saver.configure({}); // 写进（加密的）存储

    const booted = new MDMManager();
    await expect(booted.initialize()).rejects.toThrow("设备已锁定: 维护中，请联系 IT");
    booted.stopAutoSync(); // initialize() 在 enabled 配置下会起自动同步定时器
  });

  test("locked 且没有 lockMessage：回落到通用措辞", async () => {
    const saver = new MDMManager();
    saver.setConfigForTest(config({}, { deviceStatus: "locked", lockMessage: undefined }));
    await saver.configure({});

    const booted = new MDMManager();
    await expect(booted.initialize()).rejects.toThrow("设备已锁定: 请联系管理员");
  });

  test("wiped：抛错，且**存储里的配置真的没了**（旧实现只是把内存字段置空）", async () => {
    const saver = new MDMManager();
    saver.setConfigForTest(config({ maxExecutionsPerDay: 2 }, { deviceStatus: "wiped" }));
    saver.recordExecution("s-1");
    await saver.configure({});
    expect(memory.get(MDM_CONFIG_KEY)).toBeTruthy();

    const booted = new MDMManager();
    await expect(booted.initialize()).rejects.toThrow("设备数据已被远程擦除");
    booted.stopAutoSync();

    // 关键断言：擦除后再起一次不会"又读到配置、又报一次已擦除"
    expect(readStoreValue<string>(MDM_CONFIG_KEY, "")).toBe("");
    expect(readStoreValue<string>(EXEC_COUNT_KEY, "")).toBe("");

    const again = new MDMManager();
    await again.initialize(); // 不再抛：这台设备已经不是 MDM 管理的了
    expect(again.getConfig()).toBeNull();
    expect(again.isEnabled()).toBe(false);
  });
});


// ============================================================================
// 注册 / 取消注册 / 与服务器同步（fetch 打桩）
// ============================================================================

/** 注册接口的成功响应（`MDMEnrollResponse` 的形状）。 */
const ENROLL_OK = {
  body: {
    success: true,
    data: {
      organizationId: "org-e",
      organizationName: "Acme 企业",
      apiKey: "key-enrolled",
      enrolledBy: "it-admin",
    },
  },
};

describe("MDM enrollDevice", () => {
  test("成功：带令牌/设备信息调用注册接口，建配置并立刻首次同步（带 Bearer）", async () => {
    stubFetch((url) =>
      url.endsWith("/api/mdm/enroll") ? ENROLL_OK : { body: { success: true, data: {} } },
    );

    const m = new MDMManager();
    const result = await m.enrollDevice("https://mdm.test", "tok-123", "My Mac");

    expect(result).toEqual({ success: true, message: "设备注册成功" });
    expect(m.isEnabled()).toBe(true);
    const cfg = m.getConfig();
    expect(cfg?.organizationId).toBe("org-e");
    expect(cfg?.apiKey).toBe("key-enrolled");
    expect(cfg?.deviceName).toBe("My Mac");
    expect(cfg?.enrolledBy).toBe("it-admin");
    expect(cfg?.deviceStatus).toBe("active");
    expect(cfg?.deviceId.startsWith("device-")).toBe(true);

    // 两次调用：先 enroll（此时还没有 apiKey ⇒ 不带 Authorization），后 sync（带上）
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "https://mdm.test/api/mdm/enroll",
      "https://mdm.test/api/mdm/sync",
    ]);
    const enrollHeaders = fetchCalls[0]?.init.headers as Record<string, string>;
    expect(enrollHeaders.Authorization).toBeUndefined();
    const enrollBody = JSON.parse(String(fetchCalls[0]?.init.body)) as Record<string, unknown>;
    expect(enrollBody.enrollmentToken).toBe("tok-123");
    expect(enrollBody.platform).toBe("test-platform");
    expect(enrollBody.userAgent).toBe("test-agent");

    const syncHeaders = fetchCalls[1]?.init.headers as Record<string, string>;
    expect(syncHeaders.Authorization).toBe("Bearer key-enrolled");
  });

  test("服务器拒绝：把服务器的措辞带回来，且不建配置", async () => {
    stubFetch(() => ({ body: { success: false, message: "注册令牌无效" } }));

    const m = new MDMManager();
    expect(await m.enrollDevice("https://mdm.test", "bad", "My Mac")).toEqual({
      success: false,
      message: "注册令牌无效",
    });
    expect(m.isEnabled()).toBe(false);
    expect(m.getConfig()).toBeNull();
  });

  test("success 但缺 data：回落到通用措辞", async () => {
    stubFetch(() => ({ body: { success: true } }));
    const m = new MDMManager();
    expect(await m.enrollDevice("https://mdm.test", "tok", "My Mac")).toEqual({
      success: false,
      message: "注册失败",
    });
  });

  test("网络抛错：把原因带回来，不抛给调用方", async () => {
    stubFetch(() => new Error("connection refused"));
    const m = new MDMManager();
    expect(await m.enrollDevice("https://mdm.test", "tok", "My Mac")).toEqual({
      success: false,
      message: "connection refused",
    });
  });
});


describe("MDM unenrollDevice", () => {
  test("没有配置：什么都不做，也不发请求", async () => {
    const m = new MDMManager();
    await m.unenrollDevice();
    expect(fetchCalls).toEqual([]);
  });

  test("通知服务器后**真的清掉本地配置**（旧实现只清内存 ⇒ 下次启动又读回来）", async () => {
    stubFetch(() => ({ body: { success: true } }));

    const m = new MDMManager();
    m.setConfigForTest(config());
    await m.configure({}); // 先把（加密的）配置落盘
    expect(memory.get(MDM_CONFIG_KEY)).toBeTruthy();

    await m.unenrollDevice();

    expect(fetchCalls.map((c) => c.url)).toEqual(["https://mdm.example.test/api/mdm/unenroll"]);
    expect(readStoreValue<string>(MDM_CONFIG_KEY, "")).toBe("");
    expect(readStoreValue<string>(EXEC_COUNT_KEY, "")).toBe("");
    expect(m.getConfig()).toBeNull();
    expect(m.isEnabled()).toBe(false);

    // 重启：不会再读到"已取消注册"的配置
    const booted = new MDMManager();
    await booted.initialize();
    expect(booted.isEnabled()).toBe(false);
  });

  test("服务器不可达时仍然清掉本地（退订是本地权威）", async () => {
    stubFetch(() => new Error("daemon down"));

    const m = new MDMManager();
    m.setConfigForTest(config());
    await m.configure({});

    await m.unenrollDevice(); // 不抛

    expect(readStoreValue<string>(MDM_CONFIG_KEY, "")).toBe("");
    expect(m.getConfig()).toBeNull();
  });
});

describe("MDM syncWithServer", () => {
  test("没有配置：回「MDM 未启用」且不发请求", async () => {
    const m = new MDMManager();
    const res = await m.syncWithServer();
    expect(res.success).toBe(false);
    expect(res.message).toBe("MDM 未启用");
    expect(fetchCalls).toEqual([]);
  });

  test("成功：合并服务器下发的字段（含 lockMessage），清掉上次的错误", async () => {
    stubFetch(() => ({
      body: {
        success: true,
        data: { version: "2.0.0", deviceStatus: "locked", lockMessage: "设备需更新" },
      },
    }));

    const m = new MDMManager();
    m.setConfigForTest(config({}, { version: "1.0.0", lastSyncError: "上一次的错误", apiKey: "key-1" }));

    const res = await m.syncWithServer();

    expect(res.success).toBe(true);
    const cfg = m.getConfig();
    expect(cfg?.version).toBe("2.0.0");
    expect(cfg?.deviceStatus).toBe("locked");
    expect(cfg?.lockMessage).toBe("设备需更新");
    expect(cfg?.lastSyncStatus).toBe("success");
    expect(cfg?.lastSyncError).toBeUndefined();
    expect(cfg?.lastSyncAt).toBeGreaterThan(0);
    expect((fetchCalls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer key-1");
  });

  test("服务器回 success:false：记下失败与原因，并**落盘**（重启后仍能查到）", async () => {
    stubFetch(() => ({ body: { success: false, message: "组织已被暂停" } }));

    const m = new MDMManager();
    m.setConfigForTest(config());
    const res = await m.syncWithServer();

    expect(res.success).toBe(false);
    expect(res.message).toBe("组织已被暂停");
    expect(m.getConfig()?.lastSyncStatus).toBe("failure");
    expect(m.getConfig()?.lastSyncError).toBe("组织已被暂停");

    const booted = new MDMManager();
    await booted.initialize();
    booted.stopAutoSync(); // initialize() 会起自动同步定时器；本例不需要它
    expect(booted.getConfig()?.lastSyncError).toBe("组织已被暂停");
  });

  test("网络抛错：记下失败与原因，返回失败而不是抛", async () => {
    stubFetch(() => new Error("timeout"));

    const m = new MDMManager();
    m.setConfigForTest(config());
    const res = await m.syncWithServer();

    expect(res.success).toBe(false);
    expect(res.message).toBe("timeout");
    expect(m.getConfig()?.lastSyncStatus).toBe("failure");
    expect(m.getConfig()?.lastSyncError).toBe("timeout");
  });
});

