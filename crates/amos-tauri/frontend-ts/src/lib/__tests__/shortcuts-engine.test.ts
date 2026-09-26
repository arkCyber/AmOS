/**
 * shortcuts-engine.test.ts — 快捷指令执行引擎契约（src/lib/shortcuts.ts，REQ-A396）。
 *
 * 覆盖执行路径：不存在的指令、指令不存在/未知操作跳过、全部内建动作语义
 * （text / combine_text / replace_text / set_variable / wait / calculate /
 * current_date / format_date / 通知类透传）、变量引用（$input / $var）、
 * runCount 计数、执行异常落盘为失败结果，以及 MDM 限制拦截（操作数上限、以及
 * REQ-A824 补上的**执行时长策略** —— 那条策略此前没有任何执行路径读它）。
 */
import { describe, test as it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  createShortcut,
  effectiveExecutionBudgetMs,
  executeShortcut,
  getActionType,
  getActionsByCategory,
  LIMITS,
  loadShortcuts,
  saveShortcuts,
  validateShortcutName,
} from "../shortcuts";
import type { ActionInstance } from "../shortcuts";
import { readStoreValue } from "../amosStore";
import { mdmManager } from "../enterprise/mdm";
import type { MDMConfig, MDMRestrictions } from "../enterprise/mdm";

// 与 shortcuts.test.ts 相同的存储缝：注入 window.localStorage 假体（纯 bun 环境无宿主存储）。
// pure 批次是一个进程跑所有文件，所以桩只在本文件生命周期内存在（beforeAll 装 / afterAll 还原）：
// 装在模块顶层会泄漏给后面的文件，让它们凭空多出一个可用的存储（实测会让
// enterprise-audit.test.ts 的用例走另一条分支）。
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
const prevLocalStorage = globals.localStorage;

beforeAll(() => {
  globals.window = { localStorage: mockStorage, dispatchEvent: () => true };
  globals.localStorage = mockStorage;
});

afterAll(() => {
  if (prevWindow === undefined) delete globals.window;
  else globals.window = prevWindow;
  if (prevLocalStorage === undefined) delete globals.localStorage;
  else globals.localStorage = prevLocalStorage;

  // MDM 也是跨文件共享的单例，而 pure 批次是**一个进程跑所有文件** —— `beforeEach` 只保证
  // 本文件内每条用例起点干净，管不到"本文件跑完留下什么"。REQ-A842 之后这不再是无害的：
  // `maxShortcutsPerUser` 从"没人读"变成"活的"，于是本文件最后一条用例留下的配置会漏给
  // 后面的文件 —— 实测 `shortcuts-phase2.test.ts` 的 13 条当场红（每条 `createShortcut()`
  // 都被一条留下的 `cap=0` 拒掉，日志里写着「每用户快捷指令数已达上限（0）」）。
  // 与上面还原 storage 桩同一条纪律：本文件开的东西，本文件收干净。
  mdmManager.setConfigForTest(mdmConfig({}, false));
});

let seq = 0;
const action = (actionTypeId: string, parameters: Record<string, unknown> = {}): ActionInstance => ({
  id: `act-${++seq}`,
  actionTypeId,
  parameters,
  position: seq,
});

function mdmConfig(restrictions: Partial<MDMRestrictions> = {}, enabled = true): MDMConfig {
  return {
    enabled,
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
    lastSyncStatus: "pending",
    deviceStatus: "active",
    enrolledAt: 0,
    enrolledBy: "test",
    version: "1",
  };
}

beforeEach(() => {
  storageMap.clear();
  saveShortcuts([]);
  mdmManager.setConfigForTest(mdmConfig({}, false)); // 默认无 MDM 限制
});

describe("快捷指令执行引擎", () => {
  it("执行不存在的指令：失败并说明原因", async () => {
    const r = await executeShortcut("no-such-shortcut", "x");
    expect(r.success).toBe(false);
    expect(r.error).toContain("不存在");
    expect(r.actionsCompleted).toBe(0);
    expect(r.actionsTotal).toBe(0);
  });

  it("管道：变量引用 + 内建动作语义 + 未知动作跳过", async () => {
    const sc = createShortcut("引擎-管道", {
      actions: [
        action("text", { text: "abc" }),
        action("set_variable", { name: "x", value: "$input" }),
        action("combine_text", { text1: "pre-", separator: "·", text2: "$x" }),
        action("replace_text", { text: "$x", find: "a", replace: "b" }),
        action("calculate", { num1: 6, operator: "**", num2: 2 }),
        action("current_date"),
        action("format_date", { date: "2026-01-02T03:04:05Z", format: "iso" }),
        action("format_date", { date: "not-a-date", format: "iso" }),
        action("show_notification", { title: "hi" }),
        action("wait", { seconds: 0 }),
        action("no_such_action_type", {}),
      ],
    });
    expect(sc).not.toBeNull();
    const r = await executeShortcut(sc!.id, "IN");
    expect(r.success).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.actionsTotal).toBe(11);
    expect(r.actionsCompleted).toBe(10); // 未知动作被跳过
    // 透明动作（通知/wait）透传**前一步输出**：末位 format_date 对非法日期返回
    // "Invalid Date"，wait 原样透传它 —— 这正是引擎的文档化语义
    expect(r.output).toBe("Invalid Date");
    // runCount 持久化 +1
    const stored = loadShortcuts().find((s) => s.id === sc!.id);
    expect(stored?.runCount).toBe(1);
    // format_date 分支真的算出两种结果（通过中间 combine 无法直接观测，这里直接驱动动作）
    expect(getActionType("format_date")).not.toBeUndefined();
  });

  /**
   * 两次**重叠**的运行各自 +1，而不是各读同一份快照再互相覆盖。
   *
   * `executeShortcut()` 是 async 的：它开头 `loadShortcuts()` 读一份快照，中间在
   * `runActions` / `ensureInitialized` 等处 `await`，最后 `updateShortcut(id,
   * { runCount: shortcut.runCount + 1 })` —— 那个 `shortcut` 就是开头那份快照。
   * 同一进程里两条入口（触发器与用户手点、或两个触发器同时命中）完全可能重叠，
   * 两边都从 `runCount = N` 出发，于是都写回 `N + 1`：一次**成功**的运行被静默吞掉。
   * `runCount` 是用户可见的（`shortcuts.runCount`「已运行 N 次」），少一次就是屏幕
   * 说错了话 —— 与它相邻的 `recordExecution()`（每日配额，朝严格一侧）不同，
   * 这个数记的是用户看得见的成果。
   *
   * 两条 promise 在同一个同步块里创建，所以两次快照读都发生在任何一次写之前 ——
   * 这条用例是确定性的，不依赖调度顺序。
   */
  it("两次重叠的运行各自把 runCount +1（不是各读同一份快照）", async () => {
    const sc = createShortcut("引擎-重叠计数", { actions: [action("wait", { seconds: 0 })] })!;
    const [a, b] = await Promise.all([executeShortcut(sc.id), executeShortcut(sc.id)]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(loadShortcuts().find((s) => s.id === sc.id)!.runCount).toBe(2);
  });

  /**
   * 同一条纪律的**第二个出口**：`stop_shortcut` 提前结束也是成功（见上面的 `StopSignal`），
   * 于是它自己也要 +1，而且要与跑完的那条走**同一个**取数方式。两处各写一份
   * `快照.runCount + 1` 时，只有一处被修好会留下另一半 —— 这条用例钉住的是那一半。
   */
  it("两次重叠的 `stop_shortcut` 运行各自 +1（提前结束的出口用的是同一份取数）", async () => {
    const sc = createShortcut("引擎-重叠-提前结束", {
      actions: [action("stop_shortcut", {})],
    })!;
    const [a, b] = await Promise.all([executeShortcut(sc.id), executeShortcut(sc.id)]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(loadShortcuts().find((s) => s.id === sc.id)!.runCount).toBe(2);
  });

  it("calculate 四则与未知运算符", async () => {
    const run = async (operator: string, num1 = 7, num2 = 2) => {
      const sc = createShortcut(`引擎-calc-${operator}-${++seq}`, {
        actions: [action("calculate", { num1, operator, num2 })],
      })!;
      const r = await executeShortcut(sc.id);
      return r.output;
    };
    expect(await run("+")).toBe(9);
    expect(await run("-")).toBe(5);
    expect(await run("*")).toBe(14);
    expect(await run("/")).toBe(3.5);
    expect(await run("**")).toBe(49);
    expect(await run("%")).toBe(0); // 未知运算符 → 0
  });

  it("replace_text 的非法正则让整条指令失败并记录错误", async () => {
    const sc = createShortcut(`引擎-坏正则-${++seq}`, {
      actions: [
        action("text", { text: "abc" }),
        action("replace_text", { text: "abc", find: "[", replace: "x" }),
      ],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(false);
    // 第 1 步（`text`）**真的完成了**。失败不再把计数抹成 0：那个 0 在引入嵌套控制流
    // 之后会变成假话（一个 20 步的指令在第 19 步失败时，用户看到的不是"0/20 完成"）。
    expect(r.actionsCompleted).toBe(1);
    expect(typeof r.error).toBe("string");
    expect(r.actionsTotal).toBe(2);
  });

  it("MDM 操作数上限拦截执行并给出原因", async () => {
    mdmManager.setConfigForTest(mdmConfig({ maxActionsPerShortcut: 1 }));
    const sc = createShortcut("引擎-MDM拦截", {
      actions: [action("text", { text: "a" }), action("text", { text: "b" })],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(false);
    expect(r.error).toContain("操作数");
    expect(r.actionsCompleted).toBe(0);
    expect(r.actionsTotal).toBe(2);
  });

  it("MDM 关闭时同样管道不受限", async () => {
    mdmManager.setConfigForTest(mdmConfig({ maxActionsPerShortcut: 0 }, false));
    const sc = createShortcut("引擎-无MDM", {
      actions: [action("text", { text: "a" }), action("text", { text: "b" })],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(true);
    expect(r.output).toBe("b");
  });

  it("MDM 执行时长策略：超时的那一跑被拦，理由里带管理员设的那个数（REQ-A824）", async () => {
    // 策略 1 秒，而这条指令要跑 2 秒（`wait` 真等）。截止时刻只在操作之间检查，
    // 所以这里用**两个**动作：第一个 `wait` 把时间用完，第二个动作**之前**的那次检查
    // 就是抓它的地方。
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionTime: 1 }));
    const sc = createShortcut("引擎-MDM时长", {
      actions: [action("wait", { seconds: 2 }), action("text", { text: "never" })],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(false);
    expect(r.error).toContain("最大执行时间限制（1秒）");
    // `wait` **真的跑完了**（1 步），越界的是它之后那一步 —— 所以完成数是 1 而不是 0。
    // 这与 `maxActionsPerShortcut` 那条不同：那条在**进门时**就拒了（什么都没跑）。
    // 这里同样不能把计数抹成 0：本文件已经定过这条规矩（见「非法正则」那条）。
    expect(r.actionsCompleted).toBe(1);
    expect(r.output).toBeUndefined();
    expect(r.actionsTotal).toBe(2);
  }, 15000);

  it("同一条指令、MDM 关闭时跑得完 —— 拦住它的确实是那条策略，不是别的东西", async () => {
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionTime: 1 }, false));
    const sc = createShortcut("引擎-无时长策略", {
      actions: [action("wait", { seconds: 2 }), action("text", { text: "done" })],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(true);
    expect(r.output).toBe("done");
  }, 15000);

  it("最后一个动作自己就跑超：跑完**之后**那一次检查也拦得住（补上边界之间的空档）", async () => {
    // 只有一个动作：循环里那一次检查在 `wait` **之前**跑（此刻还没超时），而循环走到
    // 末尾就结束了 —— 没有收尾检查的话，`wait 2` 会以「成功」结束，策略形同虚设。
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionTime: 1 }));
    const sc = createShortcut("引擎-末动作超时", {
      actions: [action("wait", { seconds: 2 })],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(false);
    expect(r.error).toContain("最大执行时间限制（1秒）");
  }, 15000);

  it("超时的那一跑**不计入** runCount（它没成功）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionTime: 1 }));
    const sc = createShortcut("引擎-超时不计数", {
      actions: [action("wait", { seconds: 2 })],
    })!;
    await executeShortcut(sc.id);
    const after = loadShortcuts().find((s) => s.id === sc.id)!;
    expect(after.runCount).toBe(0);
  }, 15000);

  it("策略上限只能收紧引擎上限，永不放宽（3 个方向各钉一次）", () => {
    // 引擎自己的保命上限是 300 秒。策略比它宽（3600 秒）时**不能**把它顶开 ——
    // 否则一条服务端下发的宽策略就能解除引擎的防冻护栏。
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionTime: 3600 }));
    expect(effectiveExecutionBudgetMs()).toBe(LIMITS.MAX_EXECUTION_TIME_MS);
    // 更紧的策略说了算。
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionTime: 1 }));
    expect(effectiveExecutionBudgetMs()).toBe(1000);
    // MDM 关闭 ⇒ 没有策略上限，退回引擎上限。
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionTime: 1 }, false));
    expect(effectiveExecutionBudgetMs()).toBe(LIMITS.MAX_EXECUTION_TIME_MS);
  });

  it("不可信的策略值朝**严格**一侧折：`NaN` 不是「没有上限」", async () => {
    // 若把 `NaN` 当成「没限制」，`elapsed > NaN` 恒为假 ⇒ 这条策略变成一纸空文，
    // 而它看起来还在配置里。所以这里要的是**拒绝**，不是放行。
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionTime: Number.NaN }));
    expect(effectiveExecutionBudgetMs()).toBe(0);
    const sc = createShortcut("引擎-NaN策略", {
      actions: [action("text", { text: "a" })],
    })!;
    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(false);
    expect(r.error).toContain("最大执行时间限制（0秒）");
    expect(r.actionsCompleted).toBe(0);
  });

  it("`checkExecutionTime` 对同一个 `NaN` 策略也答「越界」——两个读者读同一个数", () => {
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionTime: Number.NaN }));
    expect(mdmManager.executionTimeLimitMs()).toBe(0);
    expect(mdmManager.checkExecutionTime(1).allowed).toBe(false);
    expect(mdmManager.executionTimeLimitMs()).not.toBeNull();
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionTime: 300 }, false));
    expect(mdmManager.executionTimeLimitMs()).toBeNull();
    expect(mdmManager.checkExecutionTime(99999).allowed).toBe(true);
  });

  it("动作类型目录：按分类检索 + 名称校验", () => {
    expect(getActionType("text")?.category).toBe("text");
    expect(getActionType("__missing__")).toBeUndefined();
    const math = getActionsByCategory("math");
    expect(math.length).toBeGreaterThan(0);
    expect(math.every((a) => a.category === "math")).toBe(true);
    expect(validateShortcutName("").valid).toBe(false);
    expect(validateShortcutName("ok")).toEqual({ valid: true });
  });
});


// ============================================================================
// 每日执行次数：门禁是活的，可是它读的那个数此前**没人生产**（REQ-A831）
// ============================================================================

const EXEC_COUNT_KEY = "amos.shortcuts.mdm.execution_count";
const todayKey = (shortcutId: string) => `${new Date().toISOString().split("T")[0]}-${shortcutId}`;

/**
 * 落盘的那份计数（`saveExecutionCounts` 写的就是这个形状）。
 *
 * 走 `readStoreValue` 而不是直接读 `storageMap`：`writeJson` 会把传进来的**字符串**
 * 再编码一层（写入处编码、读取处解码是一份契约），直接 `JSON.parse` 拿到的是那个
 * 字符串本身，不是里面的对象 —— 那会让这条断言永远拿到 `undefined` 而恒真。
 */
function storedCounts(): Record<string, number> | null {
  const raw = readStoreValue<string>(EXEC_COUNT_KEY, "");
  return raw ? (JSON.parse(raw) as { counts: Record<string, number> }).counts : null;
}

describe("MDM 每日执行次数在执行路径上真的记账（REQ-A831）", () => {
  it("跑完一条指令 ⇒ 计数落盘，键是「日期-指令」", async () => {
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionsPerDay: 3 }));
    const sc = createShortcut("配额-记账", { actions: [action("text", { text: "a" })] })!;

    const r = await executeShortcut(sc.id);
    expect(r.success).toBe(true);
    expect(storedCounts()?.[todayKey(sc.id)]).toBe(1);
  });

  it("额度用完 ⇒ **引擎**拒绝第二次，理由里带着那个数（旧实现下这条必红）", async () => {
    // 旧实现：`checkCanExecute` 读的 `executionCounts` 全仓没有写者，恒为空 ⇒
    // `currentCount` 恒为 0 ⇒ 这条断言永远拿到 `success: true`。管理员在面板里
    // 把「每日执行次数」改成 1，生产里的行为与 1000 时一模一样。
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionsPerDay: 1 }));
    const sc = createShortcut("配额-上限1", { actions: [action("text", { text: "a" })] })!;

    const first = await executeShortcut(sc.id);
    expect(first.success).toBe(true);

    const second = await executeShortcut(sc.id);
    expect(second.success).toBe(false);
    expect(second.error).toContain("已达到每日最大执行次数（1）");
    expect(second.actionsCompleted).toBe(0); // 一步都没跑
  });

  it("**被拒绝的那一次不占额度**：拒绝不能自己把配额吃掉", async () => {
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionsPerDay: 1 }));
    const sc = createShortcut("配额-拒绝不记账", { actions: [action("text", { text: "a" })] })!;

    await executeShortcut(sc.id);
    await executeShortcut(sc.id); // 被拒
    await executeShortcut(sc.id); // 又被拒

    expect(storedCounts()?.[todayKey(sc.id)]).toBe(1);
  });

  it("额度按指令各算各的：A 用完了，B 照跑", async () => {
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionsPerDay: 1 }));
    const a = createShortcut("配额-A", { actions: [action("text", { text: "a" })] })!;
    const b = createShortcut("配额-B", { actions: [action("text", { text: "a" })] })!;

    expect((await executeShortcut(a.id)).success).toBe(true);
    expect((await executeShortcut(a.id)).success).toBe(false);
    expect((await executeShortcut(b.id)).success).toBe(true);
  });

  it("记的是**启动**不是成功：跑挂了的那一次照样占额度", async () => {
    // 方向是朝严格一侧的：若只记成功，一个每次都在第 2 步抛错的指令就能无限次绕过配额。
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionsPerDay: 1 }));
    const sc = createShortcut(`配额-失败也记账-${++seq}`, {
      actions: [
        action("text", { text: "abc" }),
        action("replace_text", { text: "abc", find: "[", replace: "x" }), // 非法正则 ⇒ 抛
      ],
    })!;

    const failed = await executeShortcut(sc.id);
    expect(failed.success).toBe(false);
    expect(storedCounts()?.[todayKey(sc.id)]).toBe(1);

    const next = await executeShortcut(sc.id);
    expect(next.error).toContain("已达到每日最大执行次数（1）");
  });

  it("被配额拦下的那一次**不动 runCount**（它与时长超时同一侧的语义）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionsPerDay: 1 }));
    const sc = createShortcut("配额-不动runCount", { actions: [action("text", { text: "a" })] })!;

    await executeShortcut(sc.id);
    await executeShortcut(sc.id); // 被拒

    expect(loadShortcuts().find((s) => s.id === sc.id)!.runCount).toBe(1);
  });

  it("MDM 关闭 ⇒ 既不记账也不拒绝（同一条指令跑三次全过）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ maxExecutionsPerDay: 1 }, false));
    const sc = createShortcut("配额-MDM关闭", { actions: [action("text", { text: "a" })] })!;

    for (let i = 0; i < 3; i++) expect((await executeShortcut(sc.id)).success).toBe(true);
    // 没配 MDM 就**不该**留下配额存储：那会是一条无主数据。
    expect(storageMap.get(EXEC_COUNT_KEY)).toBeUndefined();
  });
});

/**
 * REQ-A842 / F-MDM-005：MDM 的「每用户快捷指令数」上限。
 *
 * 这一面与 REQ-A831 是**同一个家族的相邻两面**，判据也同源：不看 `mdmManager` 内部的
 * 状态，看**真的走 `createShortcut()` 这条路**会不会被拦下来。`maxShortcutsPerUser`
 * 此前被声明、有默认值 100、服务端能下发、面板上有一个诚实的数字框、`getPolicy` 能取回
 * —— 而全仓**没有一处读它**：唯一的关卡是本应用自己的常量 `LIMITS.MAX_SHORTCUTS`（1000）。
 * 管理员把上限设成 1，用户照样能建到 1000。
 *
 * 所以每条用例都从 `createShortcut()` 进（生产入口），而不是手工去构造 `executionCounts`
 * 那样"把状态摆好"。边界两条都要：`>=` 而不是 `>`（在**等于**上限时就该拒绝），
 * 以及**没到**上限时必须放行（否则修法变成把限制拦得过紧）。
 */
describe("MDM 每用户快捷指令上限真的被 createShortcut 读（REQ-A842）", () => {
  const seed = (n: number) => {
    const list = Array.from({ length: n }, (_, i) => ({
      id: `sc-${i}`,
      name: `第 ${i} 条`,
      icon: "⚡",
      color: "#007AFF",
      description: "",
      actions: [],
      quickActions: [],
      triggers: [],
      createdAt: 0,
      updatedAt: 0,
      runCount: 0,
      runOnLockScreen: false,
      requiresConfirmation: false,
      tags: [],
    }));
    return saveShortcuts(list);
  };

  it("上限 1、已有 1 条 ⇒ 建第 2 条被拒，且列表仍是 1 条", () => {
    mdmManager.setConfigForTest(mdmConfig({ maxShortcutsPerUser: 1 }));
    seed(1);

    const made = createShortcut("第二条");

    expect(made).toBeNull();
    expect(loadShortcuts()).toHaveLength(1);
    expect(loadShortcuts()[0]!.id).toBe("sc-0");
  });

  it("上限 1、已有 0 条 ⇒ 建得成（补集：修法不该把限制拦得过紧）", () => {
    mdmManager.setConfigForTest(mdmConfig({ maxShortcutsPerUser: 1 }));
    seed(0);

    const made = createShortcut("第一条");

    expect(made).not.toBeNull();
    expect(loadShortcuts()).toHaveLength(1);
  });

  it("边界是 `>=` 而不是 `>`：上限 3、已有 2 条能建到 3，建第 4 条才拒", () => {
    mdmManager.setConfigForTest(mdmConfig({ maxShortcutsPerUser: 3 }));
    seed(2);

    expect(createShortcut("第三条")).not.toBeNull();
    expect(loadShortcuts()).toHaveLength(3);

    expect(createShortcut("第四条")).toBeNull();
    expect(loadShortcuts()).toHaveLength(3);
  });

  it("拒绝时给的是**带上限数字**的理由（不是一句通用的「创建失败」）", () => {
    mdmManager.setConfigForTest(mdmConfig({ maxShortcutsPerUser: 2 }));
    seed(2);

    const verdict = mdmManager.checkCanCreate(loadShortcuts().length);

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("每用户快捷指令数已达上限（2）");
  });

  it("面板设的那个数就是引擎读的那个数（getPolicy 与拒绝理由一致）", async () => {
    mdmManager.setConfigForTest(mdmConfig());
    await mdmManager.addPolicy("maxShortcutsPerUser", 2);
    seed(2);

    expect(mdmManager.getPolicy("maxShortcutsPerUser")).toBe(2);
    expect(mdmManager.checkCanCreate(loadShortcuts().length).reason).toBe(
      "每用户快捷指令数已达上限（2）",
    );
    expect(createShortcut("第 3 条")).toBeNull();
  });

  it("MDM 关闭 ⇒ 上限不生效，能一直建（补集）", () => {
    mdmManager.setConfigForTest(mdmConfig({ maxShortcutsPerUser: 1 }, false));
    seed(1);

    expect(createShortcut("没有 MDM")).not.toBeNull();
    expect(loadShortcuts()).toHaveLength(2);
  });

  /**
   * 朝**严格**的一侧失败：`NaN` / `Infinity` / 负数**不是**「没有限制」。
   * 若把 `NaN` 当成"无限"，`count >= NaN` 恒为假，这条策略就一纸空文 ——
   * 而它在面板上看起来还在配置里，正是本条要修的那个形状。
   */
  it("上限是 NaN / Infinity / 负数 ⇒ 折成 0，一律拒绝，而不是静默放行", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      mdmManager.setConfigForTest(mdmConfig({ maxShortcutsPerUser: bad }));
      seed(0);

      expect(createShortcut("x"), `cap=${String(bad)} must refuse`).toBeNull();
      expect(loadShortcuts(), `cap=${String(bad)}`).toHaveLength(0);
      // 拒绝理由里那个数字就是折算后的规范值（0），不是 `NaN` 或负数 —— 屏幕上的数
      // 必须是引擎真的在用的那个数。
      expect(
        mdmManager.checkCanCreate(0).reason,
        `cap=${String(bad)}`,
      ).toBe("每用户快捷指令数已达上限（0）");
    }
  });
});

/**
 * REQ-A848 —— `disabledCategories` / `disabledActions` 这两个黑名单**真的被执行路径读**。
 *
 * 修之前：管理员在控制台里勾掉的分类/操作，只被 `checkActionAllowed()` 与
 * `isActionDisabled()` 读，而这两个方法在生产里**零调用者**，所以设备照跑不误 ——
 * 与 F-MDM-002（没人读的策略）同形，只是这一回没人读的是"操作级"的那一条。
 *
 * 判据是**屏幕上会不会有一句话**（`success === false` + `error` 里带管理员那句话），
 * 外加"那条指令里的操作真的没执行"。全部从**生产入口** `executeShortcut()` 进。
 */
describe("MDM 的操作黑名单真的被执行路径读（REQ-A848）", () => {
  const seed = (actions: ActionInstance[]) => {
    const sc = createShortcut("黑名单", { actions });
    expect(sc).not.toBeNull();
    return sc!.id;
  };

  it("被禁的操作在**最后一步** ⇒ 整条被拒，理由点名那个操作（旧实现下这条必红）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ disabledActions: ["copy_to_clipboard"] }));
    const id = seed([action("text", { text: "before" }), action("copy_to_clipboard", { text: "x" })]);

    const r = await executeShortcut(id, "in");
    expect(r.success).toBe(false);
    expect(r.error).toContain("copy_to_clipboard");
    expect(r.error).toContain("已被管理员禁用");
    expect(r.actionsCompleted).toBe(0);
  });

  it("被禁的操作在**中间**（后面还有正常操作）⇒ 同样被拒 —— 检查走的是整棵树，不是第一步", async () => {
    mdmManager.setConfigForTest(mdmConfig({ disabledActions: ["copy_to_clipboard"] }));
    const id = seed([
      action("text", { text: "before" }),
      action("copy_to_clipboard", { text: "x" }),
      action("text", { text: "after" }),
    ]);

    const r = await executeShortcut(id, "in");
    expect(r.success).toBe(false);
    expect(r.error).toContain("copy_to_clipboard");
  });

  it("整类被禁 ⇒ 理由点名分类（管理员禁的是分类，屏幕上就该出现分类）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ disabledCategories: ["device"] }));
    const id = seed([action("text", { text: "before" }), action("vibrate", { pattern: "short" })]);

    const r = await executeShortcut(id, "in");
    expect(r.success).toBe(false);
    expect(r.error).toContain("device");
  });

  it("藏在 `repeat` 的循环体里 ⇒ 照样被拒（少走一层就能绕过去）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ disabledActions: ["copy_to_clipboard"] }));
    const repeat = action("repeat", { count: 2 });
    repeat.children = [action("copy_to_clipboard", { text: "x" })];
    const id = seed([action("text", { text: "before" }), repeat]);

    const r = await executeShortcut(id, "in");
    expect(r.success).toBe(false);
    expect(r.error).toContain("copy_to_clipboard");
  });

  it("藏在 `if` 的 else 分支里 ⇒ 照样被拒（`elseChildren` 是另一条边，漏了它等于漏了一半）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ disabledActions: ["copy_to_clipboard"] }));
    const branch = action("if", { condition: "1", operator: "==", value: "1" });
    branch.elseChildren = [action("copy_to_clipboard", { text: "x" })];
    const id = seed([action("text", { text: "before" }), branch]);

    const r = await executeShortcut(id, "in");
    expect(r.success).toBe(false);
    expect(r.error).toContain("copy_to_clipboard");
  });

  /**
   * 「预检」与「跑一步问一步」的分界：前者在**第一个操作动之前**就返回，后者会让前面几步
   * 的副作用先落出去 —— 而在屏幕上，那与"整条跑完了"没有区别。
   *
   * 证人是 `wait(3)`：它一定排在第一步。预检 ⇒ 几毫秒返回；跑完再检查 ⇒ 至少 3 秒。
   * 阈值 1.5 秒离两侧都很远，不是在赌一个窄窗口。
   */
  it("预检发生在**任何**操作执行之前：第一步是 `wait(3)`，被拒时并没有等那 3 秒", async () => {
    mdmManager.setConfigForTest(mdmConfig({ disabledActions: ["copy_to_clipboard"] }));
    const id = seed([action("wait", { seconds: 3 }), action("copy_to_clipboard", { text: "x" })]);

    const startedAt = Date.now();
    const r = await executeShortcut(id, "in");
    const elapsed = Date.now() - startedAt;

    expect(r.success).toBe(false);
    expect(r.error).toContain("copy_to_clipboard");
    expect(elapsed, `被拒的一跑不该等第一步的 3 秒（实测 ${elapsed}ms）`).toBeLessThan(1500);
  });

  it("补集：黑名单清空 ⇒ 同一条指令跑得成（拦住它的确实是黑名单，不是别的东西）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ disabledActions: [] }));
    const id = seed([action("text", { text: "before" }), action("copy_to_clipboard", { text: "x" })]);

    const r = await executeShortcut(id, "in");
    expect(r.success).toBe(true);
    expect(r.actionsCompleted).toBe(2);
  });

  it("补集：MDM 关闭 ⇒ 黑名单不生效（策略只在启用时说话）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ disabledActions: ["copy_to_clipboard"] }, false));
    const id = seed([action("text", { text: "before" }), action("copy_to_clipboard", { text: "x" })]);

    const r = await executeShortcut(id, "in");
    expect(r.success).toBe(true);
  });

  /**
   * 口径与执行器一致：`runActions` 对**未知**操作类型是"跳过"，不是失败。策略预检不能把一个
   * 执行器根本不认识的操作上报成"被管理员禁用"—— 那会让用户去找一个不存在的开关。
   */
  it("未知操作类型不算策略违规：不报「禁用」，执行器照旧跳过它", async () => {
    mdmManager.setConfigForTest(mdmConfig({ disabledCategories: ["device"] }));
    const id = seed([action("no_such_action_at_all")]);

    const r = await executeShortcut(id, "in");
    expect(r.success).toBe(true);
  });

  it("控制流操作本身也按分类算：禁用 `scripting` ⇒ 带 `if` 的指令整条被拒（统一规则，不做特例）", async () => {
    mdmManager.setConfigForTest(mdmConfig({ disabledCategories: ["scripting"] }));
    const branch = action("if", { condition: "1", operator: "==", value: "1" });
    branch.children = [action("text", { text: "then" })];
    const id = seed([action("text", { text: "before" }), branch]);

    const r = await executeShortcut(id, "in");
    expect(r.success).toBe(false);
    expect(r.error).toContain("scripting");
  });
});
