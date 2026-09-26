/**
 * __tests__/enterprise-mdm-restrictions.test.ts — 限制的**来源**：它是从哪来的。
 *
 * 与 `enterprise-mdm-policy.test.ts` 的分工：那个文件问「限制判得对不对」（给定一份
 * 配置，`checkCanExecute` 该不该拒）。这个文件问**另一件事**：那份配置是怎么进来的，
 * 进来之后限制还在不在。后者才是这一族的缺陷所在 —— 判据本身写得都对，坏在**同一份
 * 限制有不止一处定义**：
 *
 *   ① `checkCanExecute()` 把 `checkActionCount()` / `checkDailyExecutionLimit()`
 *      手工内联了一遍，而内联的那一份**丢掉了 NaN 折叠** ⇒ `undefined` 上限下
 *      `actionCount > undefined` 与 `currentCount >= undefined` 恒为 false，
 *      也就是**配额静默失效**（同一个文件里的 `policyExecutionSeconds` /
 *      `policyShortcutCap` 都折叠了，REQ-A824 / REQ-A842）。
 *   ② 「默认限制」有**三份**表：`DEFAULT_RESTRICTIONS`（`maxActionsPerShortcut: 100`）、
 *      `configure()` 的初始表、`deletePolicy()` 的恢复表（后两份都写 50）。于是
 *      「恢复默认」恢复出来的不是默认值，而首次配置与重装得到的是两个不同的上限。
 *   ③ `isActionDisabled()` 是 `checkActionAllowed()` 的死副本，且**形参顺序相反**
 *      （`(actionId, category)` vs `(category, actionId)`）—— 今天没被调用所以没错，
 *      接上去的那天会问错问题而不报错。
 *   ④ 配置的三个入口（`loadConfig` / `configure` / `syncWithServer`）都是**整块替换**
 *      `restrictions`：服务端下发一个只含 `maxExecutionTime` 的增量，其余限制全部
 *      变成 `undefined` ⇒ 走 ① 的 fail-open，且 `saveConfig()` 把这个空壳**落盘**。
 *   ⑤ 数组字段被抹掉（`enforcedShortcuts` / `disabledActions`）时
 *      `checkCanModify()` / `isActionDisabled()` 直接 `.includes` ⇒ 从一次**权限检查里
 *      抛出**，而不是给出一个判定。
 *
 * 不导入 happy-dom（保持 pure 批次，覆盖计入 P2-1）；`window.localStorage` / `navigator`
 * 桩只在本文件生命周期内存在 —— pure 批次是一个进程跑所有文件，顶层安装会泄漏给同批次的
 * 其他文件（REQ-A390 里踩过）。
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import {
  mdmManager,
  MDMManager,
  DEFAULT_RESTRICTIONS,
  type MDMConfig,
  type MDMRestrictions,
} from "../enterprise/mdm";
import type { ActionCategory } from "../shortcuts";

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
  globals.navigator = { platform: "test-platform", userAgent: "test-agent" };
});

afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
  if (previousNavigator === undefined) delete globals.navigator;
  else globals.navigator = previousNavigator;
});

const realFetch = globalThis.fetch;

/** 打桩 `fetch`：`handler` 返回 `{ body }` 当 JSON 响应，或返回 `Error` 让调用抛。 */
function stubFetch(handler: (url: string, init: RequestInit) => { body: unknown } | Error): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const result = handler(String(input), init ?? {});
    if (result instanceof Error) throw result;
    return { json: async () => result.body, status: 200 } as unknown as Response;
  }) as unknown as typeof fetch;
}

/**
 * 一份最小可用的配置；限制项按用例覆盖。
 *
 * **刻意不铺满 `restrictions`** —— `...restrictions` 是叠加在完整默认表上的，所以要造
 * 「服务端只下发了一部分」的情形，得显式 `delete`（见 `partialRestrictions()`）。
 */
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
    restrictions: { ...DEFAULT_RESTRICTIONS, ...restrictions },
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

/** 只保留列出的限制项，其余键**整个不存在**（模拟服务端增量下发 / 旧版本存下来的壳）。 */
function partialRestrictions(kept: Partial<MDMRestrictions>): MDMRestrictions {
  return kept as MDMRestrictions;
}

beforeEach(() => {
  memory.clear();
  mdmManager.clearConfigForTest();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mdmManager.clearConfigForTest();
  mdmManager.stopAutoSync();
  mdmManager.shutdown();
  memory.clear();
});

// ============================================================================
// ① 缺席 / 坏数字不得变成「没有上限」
// ============================================================================

describe("限制值不可解释时朝严格的一侧失败（REQ-A899 族的第二条判据）", () => {
  /**
   * `checkDailyExecutionLimit` 与 `checkCanExecute` 是**同一条判据的两份实现**，
   * 所以这条对两者同时断言：一份折不折，另一份也得不折。今天 `checkCanExecute`
   * 的那一份恒放行 —— 断言在它身上失败，正是本轮的入口。
   */
  const BAD_NUMBERS: Array<[string, unknown]> = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["负数", -1],
    ["字符串", "10"],
    ["null", null],
    ["布尔", true],
  ];

  test("maxExecutionsPerDay 不可解释 ⇒ 折成 0（而不是恒放行）", () => {
    for (const [label, bad] of BAD_NUMBERS) {
      mdmManager.setConfigForTest(
        config({ maxExecutionsPerDay: bad as number }),
      );
      expect({ label, ...mdmManager.checkDailyExecutionLimit("s-1") }).toEqual({
        label,
        allowed: false,
        reason: expect.stringContaining("每日"),
      });
      // 同一条判据的另一份实现必须给同一个答案（今天这里恒 `true`）
      expect({ label, ...mdmManager.checkCanExecute("s-1", 0) }).toEqual({
        label,
        allowed: false,
        reason: expect.stringContaining("每日"),
      });
    }
  });

  test("maxActionsPerShortcut 不可解释 ⇒ 折成 0（而不是恒放行）", () => {
    for (const [label, bad] of BAD_NUMBERS) {
      mdmManager.setConfigForTest(config({ maxActionsPerShortcut: bad as number }));
      expect({ label, ...mdmManager.checkActionCount(1) }).toEqual({
        label,
        allowed: false,
        reason: expect.stringContaining("操作数"),
      });
      // 0 个操作的指令：`0 > 0` 为假 ⇒ 这一条仍放行（折叠的是上限，不是一切）
      expect(mdmManager.checkCanExecute("s-1", 0).allowed).toBe(true);
      expect(mdmManager.checkCanExecute("s-1", 1).allowed).toBe(false);
    }
  });

  /** 反向控制：**可解释**的值照常放行 —— 否则上面两条只是在断言「什么都拒」。 */
  test("可解释的合法值不受折叠影响（反向控制）", () => {
    mdmManager.setConfigForTest(config({ maxExecutionsPerDay: 3, maxActionsPerShortcut: 3 }));
    expect(mdmManager.checkDailyExecutionLimit("s-1")).toEqual({ allowed: true });
    expect(mdmManager.checkCanExecute("s-1", 3)).toEqual({ allowed: true });
    expect(mdmManager.checkCanExecute("s-1", 4).allowed).toBe(false);
  });
});

// ============================================================================
// ② 一份定义、一句话：活的判据与命名的判据必须同口径
// ============================================================================

describe("checkCanExecute 与两条命名判据是同一份实现", () => {
  /**
   * 这条是 ① 的**结构性**版本：只要 `checkCanExecute` 里还留着内联副本，两者就迟早
   * 分叉（今天已经分叉了 —— 措辞不同、折叠不同）。断言「同一输入 ⇒ 同一个结果对象」
   * 把分叉钉死：措辞也必须一样，因为 `reason` 会进 `shortcuts.ts` 的
   * `error` 字段给用户看。
   */
  test("操作数：同一上限、同一句话", () => {
    mdmManager.setConfigForTest(config({ maxActionsPerShortcut: 3 }));
    expect(mdmManager.checkActionCount(3)).toEqual({ allowed: true });
    expect(mdmManager.checkCanExecute("s-1", 3)).toEqual({ allowed: true });

    const named = mdmManager.checkActionCount(4);
    const live = mdmManager.checkCanExecute("s-1", 4);
    expect(live).toEqual(named);
    expect(live.reason).toContain("3");
  });

  test("每日次数：同一上限、同一句话", () => {
    mdmManager.setConfigForTest(config({ maxExecutionsPerDay: 2 }));
    expect(mdmManager.checkDailyExecutionLimit("s-1")).toEqual({ allowed: true });

    mdmManager.recordExecution("s-1");
    mdmManager.recordExecution("s-1");

    const named = mdmManager.checkDailyExecutionLimit("s-1");
    const live = mdmManager.checkCanExecute("s-1", 0);
    expect(named.allowed).toBe(false);
    expect(live).toEqual(named);
    expect(live.reason).toContain("2");

    // 没到上限的另一条指令不受影响（上限是按「日期-指令」计的）
    expect(mdmManager.checkCanExecute("s-2", 0)).toEqual({ allowed: true });
  });

  /** 顺序：内容（被禁的操作）先于配额 —— `shortcuts.ts` 的调用点也按这个顺序。 */
  test("两条判据同时越界时，先报操作数（内容在配额之前）", () => {
    mdmManager.setConfigForTest(config({ maxActionsPerShortcut: 1, maxExecutionsPerDay: 0 }));
    const verdict = mdmManager.checkCanExecute("s-1", 5);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("操作数");
  });
});

// ============================================================================
// ③ 默认值只有一处
// ============================================================================

describe("「默认限制」只有一份定义", () => {
  /**
   * `DEFAULT_RESTRICTIONS` 是那份声明，但 `configure()` 的初始表与 `deletePolicy()` 的
   * 恢复表各写了一份内联副本，且后两份把 `maxActionsPerShortcut` 写成 `50`（声明是 `100`）。
   * 可观测的后果有两个，都在下面钉着。
   */
  test("首次 configure() 造出来的限制 = 声明的那份默认", async () => {
    await mdmManager.configure({});
    const restrictions = mdmManager.getRestrictions();
    for (const key of Object.keys(DEFAULT_RESTRICTIONS) as Array<keyof MDMRestrictions>) {
      expect({ key, value: restrictions[key] }).toEqual({ key, value: DEFAULT_RESTRICTIONS[key] });
    }
  });

  test("deletePolicy 恢复出来的就是 DEFAULT_RESTRICTIONS 的同名项（不是第二份表）", async () => {
    for (const key of Object.keys(DEFAULT_RESTRICTIONS) as Array<keyof MDMRestrictions>) {
      mdmManager.setConfigForTest(config());
      // 先把这一项改成一个**不等于**默认的值，再"恢复默认"，才问得出恢复到了哪里
      (mdmManager.getConfig()!.restrictions as unknown as Record<string, unknown>)[key] =
        typeof DEFAULT_RESTRICTIONS[key] === "number" ? 7 : DEFAULT_RESTRICTIONS[key];
      expect(await mdmManager.deletePolicy(key)).toBe(true);
      expect({ key, value: mdmManager.getPolicy(key) }).toEqual({
        key,
        value: DEFAULT_RESTRICTIONS[key],
      });
    }
  });

  test("enrollDevice 造出来的限制 = 同一份默认（第三条路的交叉验证）", async () => {
    // `callMDMApi` 要的是 `{ success, data }` **信封**。这里原来只返回 `data` 本体，
    // 于是 `response.success` 是 `undefined` ⇒ `enrollDevice` 在 `if (!response.success)`
    // 上**早退**，`this.config` 从来没被建起来 —— 而 `getRestrictions()` 在一棵空配置上
    // 回落到 `DEFAULT_RESTRICTIONS`，所以下面那句断言在"注册根本没成功"的世界里也恒真。
    // 一条只想说"三条路给出同一份默认"的用例，实测什么都没说（REQ-A945 补了前提断言）。
    stubFetch(() => ({
      body: { success: true, data: { organizationId: "org-1", organizationName: "Acme", apiKey: "k" } },
    }));
    const enrolled = await mdmManager.enrollDevice("https://mdm.example.test", "token", "Test Mac");
    expect(enrolled.success).toBe(true); // 前提：这条路真的走通了
    expect(mdmManager.isEnabled()).toBe(true);
    expect(mdmManager.getRestrictions().maxActionsPerShortcut).toBe(
      DEFAULT_RESTRICTIONS.maxActionsPerShortcut,
    );
  });
});

// ============================================================================
// ④ 配置入口不得整块替换 restrictions
// ============================================================================

describe("配置的三个入口：没提到的限制保持原值", () => {
  test("syncWithServer 只下发一部分 restrictions ⇒ 其余保持原值，且限额仍然生效", async () => {
    mdmManager.setConfigForTest(config({ maxActionsPerShortcut: 3, maxExecutionsPerDay: 2 }));
    stubFetch(() => ({
      body: { success: true, data: { restrictions: partialRestrictions({ maxExecutionTime: 60 }) } },
    }));

    const result = await mdmManager.syncWithServer();
    expect(result.success).toBe(true);

    // 下发的那一项生效
    expect(mdmManager.getRestrictions().maxExecutionTime).toBe(60);
    // 没提到的两项保持原值（今天会被整块替换成 `undefined`）
    expect(mdmManager.getRestrictions().maxActionsPerShortcut).toBe(3);
    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(2);
    // 且限额仍然挡得住 —— 这才是那个 fail-open 的可观测后果
    expect(mdmManager.checkCanExecute("s-1", 4).allowed).toBe(false);
  });

  test("落盘的也是合并后的限制：下一次读回来仍然挡得住", async () => {
    mdmManager.setConfigForTest(config({ maxExecutionsPerDay: 2 }));
    stubFetch(() => ({
      body: { success: true, data: { restrictions: partialRestrictions({ maxExecutionTime: 60 }) } },
    }));
    const synced = await mdmManager.syncWithServer();
    // 这条断言是**这个用例的前提**：同步没成，下面读回来的就只是 setConfigForTest 的值，
    // 整个用例会变成一句空话（第一版就是这样：桩少了 `success` 字段，绿的但什么也没测）。
    expect(synced.success).toBe(true);

    const reloaded = new MDMManager();
    await reloaded.initialize();
    expect(reloaded.getRestrictions().maxExecutionTime).toBe(60);
    expect(reloaded.getRestrictions().maxExecutionsPerDay).toBe(2);
    reloaded.recordExecution("s-1");
    reloaded.recordExecution("s-1");
    expect(reloaded.checkDailyExecutionLimit("s-1").allowed).toBe(false);
  });

  test("configure 只给一部分 restrictions ⇒ 其余保持原值", async () => {
    await mdmManager.configure({ restrictions: partialRestrictions({ maxExecutionsPerDay: 2 }) });
    expect(mdmManager.getRestrictions().maxExecutionsPerDay).toBe(2);
    expect(mdmManager.getRestrictions().maxActionsPerShortcut).toBe(
      DEFAULT_RESTRICTIONS.maxActionsPerShortcut,
    );
    expect(mdmManager.getRestrictions().allowUserCreate).toBe(DEFAULT_RESTRICTIONS.allowUserCreate);
  });

  test("存量配置里 restrictions 缺项 ⇒ loadConfig 补齐成默认，而不是留一个空壳", async () => {
    // 一份「旧版本写下来的」配置：restrictions 只有两个键
    memory.set(
      "amos.shortcuts.mdm.config",
      JSON.stringify(
        JSON.stringify({
          ...config(),
          restrictions: partialRestrictions({ maxExecutionsPerDay: 2 }),
        }),
      ),
    );

    const reloaded = new MDMManager();
    await reloaded.initialize();
    expect(reloaded.getRestrictions().maxExecutionsPerDay).toBe(2);
    expect(reloaded.getRestrictions().maxActionsPerShortcut).toBe(
      DEFAULT_RESTRICTIONS.maxActionsPerShortcut,
    );
    expect(reloaded.getRestrictions().disabledActions).toEqual([]);
  });
});

// ============================================================================
// ⑤ 数组被抹掉时不得从权限检查里抛出
// ============================================================================

describe("数组成员缺席时给判定，不抛异常", () => {
  test("enforcedShortcuts 缺席 ⇒ checkCanModify / checkCanDelete 返回判定", () => {
    const broken = config();
    delete (broken as unknown as Record<string, unknown>).enforcedShortcuts;
    mdmManager.setConfigForTest(broken);

    expect(() => mdmManager.checkCanModify("s-1")).not.toThrow();
    expect(() => mdmManager.checkCanDelete("s-1")).not.toThrow();
    // 缺席的「强制指令表」不是「所有指令都被强制」—— 这一条仍放行
    expect(mdmManager.checkCanModify("s-1")).toEqual({ allowed: true });
  });

  /**
   * **两个数组必须真的不存在**，不能只是「类型上说它不存在」：`config()` 会在
   * `DEFAULT_RESTRICTIONS` 上展开，所以 `config(partialRestrictions({...}))` 运行时
   * 仍然带着那两个数组 —— 第一版就是这么写的，结果 `.includes` 的守卫被绕过去，
   * 负控制（把守卫拿掉）照样 17 绿。删键，才是「存量配置 / 服务端增量里没这一项」。
   */
  test("restrictions 里的两个数组缺席 ⇒ checkActionAllowed / isActionDisabled 给判定", () => {
    const broken = config();
    delete (broken.restrictions as unknown as Record<string, unknown>).disabledCategories;
    delete (broken.restrictions as unknown as Record<string, unknown>).disabledActions;
    mdmManager.setConfigForTest(broken);

    expect(() => mdmManager.checkActionAllowed("apps" as ActionCategory, "a-1")).not.toThrow();
    expect(() => mdmManager.isActionDisabled("a-1", "apps" as ActionCategory)).not.toThrow();
    expect(mdmManager.checkActionAllowed("apps" as ActionCategory, "a-1")).toEqual({ allowed: true });
    expect(mdmManager.isActionDisabled("a-1", "apps" as ActionCategory)).toBe(false);
  });

  /**
   * `isActionDisabled(actionId, category)` 与 `checkActionAllowed(category, actionId)`
   * 问的是同一件事，而**形参顺序相反** —— 两个参数都是字符串，接错顺序能编译、能跑，
   * 只是问了另一个问题（`isActionDisabled("scripting", "apps")` 恒返回 `false`）。
   *
   * 这条**测得出什么、测不出什么**要说清楚：它测的是「两个方法的答案必须互为反面」，
   * 也就是把「一个是另一个的适配器」这个关系钉成断言 —— 但形参顺序本身是**签名层面**的
   * 性质，运行时断言无法证明某个调用点传对了顺序（旧实现内部自洽，同一对实参也得到
   * 同一个答案）。所以顺序这个地雷靠的是：只留一处实现 + 那条实现按正确顺序转发
   * （转发点写错，这条断言就红 —— 这是它的负控制），以及给调用方一个 `@deprecated`
   * 的指路牌指向无歧义的那一个。
   */
  test("isActionDisabled 与 checkActionAllowed 对同一对参数给同一个答案", () => {
    const cases: Array<[ActionCategory, string]> = [
      ["apps", "a-1"],
      ["scripting", "a-1"],
      ["apps", "system.shutdown"],
    ];
    for (const [category, actionId] of cases) {
      mdmManager.setConfigForTest(config({ disabledCategories: ["scripting"], disabledActions: ["system.shutdown"] }));
      const named = mdmManager.checkActionAllowed(category, actionId).allowed;
      const live = mdmManager.isActionDisabled(actionId, category);
      // `isActionDisabled` 反过来问：`true` = 被禁，`checkActionAllowed.allowed=false` = 被禁
      expect({ category, actionId, live }).toEqual({ category, actionId, live: !named });
    }
  });
});

// ============================================================================
// ⑥ configure() 的字段表 ≡ MDMConfig 的字段（少一个就是静默丢一个）
// ============================================================================

describe("configure() 接住 MDMConfig 的每一个字段", () => {
  /**
   * `configure()` 里那张逐字段表是**手写的**，源码注释自己写着「新增字段必须一起列进来」
   * —— 一句只在有人记得时才成立的约束。`Required<MDMConfig>` 让这份表由**类型**核对：
   * 类型新增一个字段而这里没补，这个对象字面量就编译不过。
   */
  const EVERY_FIELD: Required<MDMConfig> = {
    enabled: true,
    organizationId: "org-2",
    organizationName: "Bravo",
    deviceId: "device-2",
    deviceName: "Device Two",
    serverUrl: "https://mdm2.example.test",
    apiKey: "key-2",
    policies: [],
    restrictions: { ...DEFAULT_RESTRICTIONS, maxExecutionsPerDay: 42 },
    enforcedShortcuts: ["forced-1"],
    enforcedTemplates: ["tpl-1"],
    syncInterval: 60,
    lastSyncAt: 111,
    lastSyncStatus: "pending",
    lastSyncError: "上次同步失败的原因",
    deviceStatus: "locked",
    lockMessage: "设备已被管理员锁定",
    enrolledAt: 222,
    enrolledBy: "enroller",
    version: "9.9.9",
  };

  test("逐字段往返：每一个键都能配置进去、读得回来", async () => {
    await mdmManager.configure({});
    await mdmManager.configure(EVERY_FIELD);
    const got = mdmManager.getConfig() as unknown as Record<string, unknown>;
    for (const key of Object.keys(EVERY_FIELD) as Array<keyof MDMConfig>) {
      expect({ key, value: got[key] }).toEqual({ key, value: EVERY_FIELD[key] });
    }
  });
});
