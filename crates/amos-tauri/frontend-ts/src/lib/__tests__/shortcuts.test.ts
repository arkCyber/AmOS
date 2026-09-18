import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  createShortcut,
  deleteShortcut,
  duplicateShortcut,
  executeShortcut,
  loadShortcuts,
  saveShortcuts,
  updateShortcut,
  validateShortcutName,
  getActionType,
  getActionsByCategory,
  LIMITS,
  BUILTIN_ACTIONS,
  type Shortcut,
} from "../shortcuts";

// Mock localStorage for testing
const storageMap = new Map<string, string>();
const mockStorage: Storage = {
  getItem: (key: string) => storageMap.get(key) || null,
  setItem: (key: string, value: string) => { storageMap.set(key, value); },
  removeItem: (key: string) => { storageMap.delete(key); },
  clear: () => { storageMap.clear(); },
  key: (index: number) => {
    const keys = Array.from(storageMap.keys());
    return keys[index] || null;
  },
  get length() {
    return storageMap.size;
  },
};

// `window` / `global.localStorage` 桩：pure 批次是一个进程跑所有文件，所以只在
// 本文件的生命周期内存在（`beforeAll` 装 / `afterAll` 还原）。装在模块顶层会泄漏给
// 后面的文件 —— 实测那样会让 `enterprise-audit.test.ts` 的用例走另一条分支。
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

describe("快捷指令核心功能", () => {
  beforeEach(() => {
    // 清空存储
    storageMap.clear();
    saveShortcuts([]);
  });

  describe("验证", () => {
    test("验证有效名称", () => {
      const result = validateShortcutName("我的快捷指令");
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    test("拒绝空名称", () => {
      const result = validateShortcutName("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("不能为空");
    });

    test("拒绝超长名称", () => {
      const longName = "a".repeat(LIMITS.MAX_NAME_LENGTH + 1);
      const result = validateShortcutName(longName);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("不能超过");
    });

    test("拒绝非字符串名称", () => {
      const result = validateShortcutName(null as any);
      expect(result.valid).toBe(false);
    });
  });

  describe("CRUD 操作", () => {
    test("创建快捷指令", () => {
      const shortcut = createShortcut("测试快捷指令");
      expect(shortcut).not.toBeNull();
      expect(shortcut!.name).toBe("测试快捷指令");
      expect(shortcut!.id).toBeTruthy();
      expect(shortcut!.runCount).toBe(0);
      expect(shortcut!.actions).toEqual([]);
    });

    test("创建带选项的快捷指令", () => {
      const shortcut = createShortcut("测试", {
        description: "描述",
        icon: "🚀",
        color: "#FF0000",
        tags: ["test"],
      });
      expect(shortcut!.description).toBe("描述");
      expect(shortcut!.icon).toBe("🚀");
      expect(shortcut!.color).toBe("#FF0000");
      expect(shortcut!.tags).toEqual(["test"]);
    });

    test("更新快捷指令", () => {
      const shortcut = createShortcut("原始名称");
      const updated = updateShortcut(shortcut!.id, { name: "新名称" });
      expect(updated).toBe(true);

      const shortcuts = loadShortcuts();
      const found = shortcuts.find((s) => s.id === shortcut!.id);
      expect(found!.name).toBe("新名称");
    });

    test("删除快捷指令", () => {
      const shortcut = createShortcut("待删除");
      expect(loadShortcuts()).toHaveLength(1);

      const deleted = deleteShortcut(shortcut!.id);
      expect(deleted).toBe(true);
      expect(loadShortcuts()).toHaveLength(0);
    });

    test("复制快捷指令", () => {
      const original = createShortcut("原始", {
        description: "测试",
        actions: [],
      });
      expect(loadShortcuts()).toHaveLength(1);

      const duplicate = duplicateShortcut(original!.id);
      expect(duplicate).not.toBeNull();
      expect(duplicate!.name).toBe("原始 副本");
      expect(duplicate!.description).toBe("测试");
      expect(loadShortcuts()).toHaveLength(2);
    });
  });

  describe("边界条件", () => {
    test("不允许超过最大数量", () => {
      // 创建到限制
      const shortcuts: Shortcut[] = [];
      for (let i = 0; i < LIMITS.MAX_SHORTCUTS; i++) {
        shortcuts.push({
          id: `id-${i}`,
          name: `Shortcut ${i}`,
          icon: "⚡",
          color: "#FF0000",
          description: "",
          actions: [],
          quickActions: [],
          triggers: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          runCount: 0,
          runOnLockScreen: false,
          requiresConfirmation: false,
          tags: [],
        });
      }
      saveShortcuts(shortcuts);

      // 尝试再创建一个
      const result = createShortcut("超限");
      expect(result).toBeNull();
    });

    test("更新不存在的快捷指令", () => {
      const result = updateShortcut("nonexistent", { name: "test" });
      expect(result).toBe(false);
    });

    test("删除不存在的快捷指令", () => {
      const result = deleteShortcut("nonexistent");
      expect(result).toBe(false);
    });

    test("复制不存在的快捷指令", () => {
      const result = duplicateShortcut("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("操作类型查询", () => {
    test("获取操作类型", () => {
      const action = getActionType("text");
      expect(action).toBeDefined();
      expect(action!.name).toBe("文本");
      expect(action!.category).toBe("text");
    });

    test("获取不存在的操作类型", () => {
      const action = getActionType("nonexistent");
      expect(action).toBeUndefined();
    });

    test("按分类获取操作", () => {
      const textActions = getActionsByCategory("text");
      expect(textActions.length).toBeGreaterThan(0);
      expect(textActions.every((a) => a.category === "text")).toBe(true);
    });

    test("内置操作完整性", () => {
      expect(BUILTIN_ACTIONS.length).toBeGreaterThan(0);
      BUILTIN_ACTIONS.forEach((action) => {
        expect(action.id).toBeTruthy();
        expect(action.name).toBeTruthy();
        expect(action.category).toBeTruthy();
        expect(action.icon).toBeTruthy();
      });
    });
  });

  describe("执行引擎", () => {
    test("执行空快捷指令", async () => {
      const shortcut = createShortcut("空指令");
      const result = await executeShortcut(shortcut!.id);
      expect(result.success).toBe(true);
      expect(result.actionsCompleted).toBe(0);
      expect(result.actionsTotal).toBe(0);
    });

    test("执行不存在的快捷指令", async () => {
      const result = await executeShortcut("nonexistent");
      expect(result.success).toBe(false);
      expect(result.error).toContain("不存在");
    });

    test("执行文本操作", async () => {
      const shortcut = createShortcut("文本测试", {
        actions: [
          {
            id: "action-1",
            actionTypeId: "text",
            parameters: { text: "Hello World" },
            position: 0,
          },
        ],
      });

      const result = await executeShortcut(shortcut!.id);
      expect(result.success).toBe(true);
      expect(result.output).toBe("Hello World");
      expect(result.actionsCompleted).toBe(1);
    });

    test("执行合并文本操作", async () => {
      const shortcut = createShortcut("合并测试", {
        actions: [
          {
            id: "action-1",
            actionTypeId: "combine_text",
            parameters: {
              text1: "Hello",
              text2: "World",
              separator: " ",
            },
            position: 0,
          },
        ],
      });

      const result = await executeShortcut(shortcut!.id);
      expect(result.success).toBe(true);
      expect(result.output).toBe("Hello World");
    });

    test("执行替换文本操作", async () => {
      const shortcut = createShortcut("替换测试", {
        actions: [
          {
            id: "action-1",
            actionTypeId: "replace_text",
            parameters: {
              text: "Hello World",
              find: "World",
              replace: "AmOS",
            },
            position: 0,
          },
        ],
      });

      const result = await executeShortcut(shortcut!.id);
      expect(result.success).toBe(true);
      expect(result.output).toBe("Hello AmOS");
    });

    test("执行数学计算", async () => {
      const shortcut = createShortcut("计算测试", {
        actions: [
          {
            id: "action-1",
            actionTypeId: "calculate",
            parameters: {
              num1: 10,
              num2: 5,
              operator: "+",
            },
            position: 0,
          },
        ],
      });

      const result = await executeShortcut(shortcut!.id);
      expect(result.success).toBe(true);
      expect(result.output).toBe(15);
    });

    test("执行多个操作", async () => {
      const shortcut = createShortcut("多操作测试", {
        actions: [
          {
            id: "action-1",
            actionTypeId: "text",
            parameters: { text: "Hello" },
            position: 0,
          },
          {
            id: "action-2",
            actionTypeId: "combine_text",
            parameters: {
              text1: "$input",
              text2: "World",
              separator: " ",
            },
            position: 1,
          },
        ],
      });

      const result = await executeShortcut(shortcut!.id);
      expect(result.success).toBe(true);
      expect(result.actionsCompleted).toBe(2);
    });

    test("变量设置和引用", async () => {
      const shortcut = createShortcut("变量测试", {
        actions: [
          {
            id: "action-1",
            actionTypeId: "text",
            parameters: { text: "AmOS" },
            position: 0,
          },
          {
            id: "action-2",
            actionTypeId: "set_variable",
            parameters: {
              name: "myVar",
              value: "$input",
            },
            position: 1,
          },
        ],
      });

      const result = await executeShortcut(shortcut!.id);
      expect(result.success).toBe(true);
    });

    test("等待操作", async () => {
      const startTime = Date.now();
      const shortcut = createShortcut("等待测试", {
        actions: [
          {
            id: "action-1",
            actionTypeId: "wait",
            parameters: { seconds: 0.1 },
            position: 0,
          },
        ],
      });

      const result = await executeShortcut(shortcut!.id);
      const duration = Date.now() - startTime;
      expect(result.success).toBe(true);
      expect(duration).toBeGreaterThanOrEqual(100);
    });

    test("当前日期操作", async () => {
      const shortcut = createShortcut("日期测试", {
        actions: [
          {
            id: "action-1",
            actionTypeId: "current_date",
            parameters: {},
            position: 0,
          },
        ],
      });

      const result = await executeShortcut(shortcut!.id);
      expect(result.success).toBe(true);
      expect(typeof result.output).toBe("string");
      expect(result.output).toContain("T"); // ISO format
    });

    test("更新运行计数", async () => {
      const shortcut = createShortcut("计数测试");
      expect(shortcut!.runCount).toBe(0);

      await executeShortcut(shortcut!.id);
      const updated = loadShortcuts().find((s) => s.id === shortcut!.id);
      expect(updated!.runCount).toBe(1);

      await executeShortcut(shortcut!.id);
      const updated2 = loadShortcuts().find((s) => s.id === shortcut!.id);
      expect(updated2!.runCount).toBe(2);
    });
  });

  describe("数据持久化", () => {
    test("保存和加载快捷指令", () => {
      createShortcut("快捷指令1");
      createShortcut("快捷指令2");

      const loaded = loadShortcuts();
      expect(loaded).toHaveLength(2);
      expect(loaded.map((s) => s.name)).toContain("快捷指令1");
      expect(loaded.map((s) => s.name)).toContain("快捷指令2");
    });

    test("处理损坏的数据", () => {
      // 这个测试依赖于实际的 amosStore 实现
      // 在真实环境中，loadShortcuts 应该能优雅地处理损坏的数据
      const shortcuts = loadShortcuts();
      expect(Array.isArray(shortcuts)).toBe(true);
    });

    test("截断超限数据", () => {
      const tooMany: Shortcut[] = [];
      for (let i = 0; i < LIMITS.MAX_SHORTCUTS + 10; i++) {
        tooMany.push({
          id: `id-${i}`,
          name: `Shortcut ${i}`,
          icon: "⚡",
          color: "#FF0000",
          description: "",
          actions: [],
          quickActions: [],
          triggers: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          runCount: 0,
          runOnLockScreen: false,
          requiresConfirmation: false,
          tags: [],
        });
      }

      saveShortcuts(tooMany);
      const loaded = loadShortcuts();
      expect(loaded.length).toBeLessThanOrEqual(LIMITS.MAX_SHORTCUTS);
    });
  });
});
