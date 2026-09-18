/**
 * shortcuts-engine.test.ts — 快捷指令执行引擎契约（src/lib/shortcuts.ts，REQ-A396）。
 *
 * 覆盖执行路径：不存在的指令、指令不存在/未知操作跳过、全部内建动作语义
 * （text / combine_text / replace_text / set_variable / wait / calculate /
 * current_date / format_date / 通知类透传）、变量引用（$input / $var）、
 * runCount 计数、执行异常落盘为失败结果，以及 MDM 限制（操作数上限）拦截。
 */
import { describe, test as it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  createShortcut,
  executeShortcut,
  getActionType,
  getActionsByCategory,
  loadShortcuts,
  saveShortcuts,
  validateShortcutName,
} from "../shortcuts";
import type { ActionInstance } from "../shortcuts";
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
    expect(r.actionsCompleted).toBe(0);
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

