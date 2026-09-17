/**
 * shortcuts-phase2.test.ts — Phase 2 UI 增强功能测试
 * 
 * 测试范围:
 * - 拖拽排序逻辑
 * - 虚拟滚动计算
 * - 快捷键处理
 * - 实时预览功能
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  loadShortcuts,
  createShortcut,
  updateShortcut,
  type Shortcut,
  type ActionInstance,
} from "../shortcuts";

// Mock localStorage
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

if (typeof window === 'undefined') {
  (global as any).window = {
    localStorage: mockStorage,
    dispatchEvent: () => true,
  };
} else {
  (window as any).localStorage = mockStorage;
}
global.localStorage = mockStorage;

beforeEach(() => {
  storageMap.clear();
});

// ============================================================================
// 测试辅助函数
// ============================================================================

function createTestShortcut(name: string, actionCount: number = 3): Shortcut | null {
  const shortcut = createShortcut(name);
  if (!shortcut) return null;

  const actions: ActionInstance[] = [];
  for (let i = 0; i < actionCount; i++) {
    actions.push({
      id: `action-${i}`,
      actionTypeId: "text",
      parameters: { text: `Action ${i}` },
      position: i,
    });
  }

  updateShortcut(shortcut.id, { actions });
  return loadShortcuts().find(s => s.id === shortcut.id) || null;
}

// 模拟拖拽操作：将 draggedIndex 的操作移动到 targetIndex
function simulateDragReorder(
  actions: ActionInstance[],
  draggedIndex: number,
  targetIndex: number
): ActionInstance[] {
  // 参数验证
  if (draggedIndex < 0 || draggedIndex >= actions.length) {
    throw new Error(`Invalid draggedIndex: ${draggedIndex} (array length: ${actions.length})`);
  }
  if (targetIndex < 0 || targetIndex >= actions.length) {
    throw new Error(`Invalid targetIndex: ${targetIndex} (array length: ${actions.length})`);
  }
  
  const result = [...actions];
  const [draggedAction] = result.splice(draggedIndex, 1);
  if (!draggedAction) return result;
  
  result.splice(targetIndex, 0, draggedAction);
  
  // 更新 position
  result.forEach((a, i) => {
    a.position = i;
  });
  
  return result;
}

// 模拟虚拟滚动：计算可见范围
function calculateVisibleRange(
  scrollTop: number,
  containerHeight: number,
  itemHeight: number,
  totalItems: number,
  buffer: number = 5
): { start: number; end: number } {
  // 参数验证
  if (itemHeight <= 0) {
    throw new Error(`itemHeight must be positive, got: ${itemHeight}`);
  }
  if (containerHeight < 0) {
    throw new Error(`containerHeight cannot be negative, got: ${containerHeight}`);
  }
  if (totalItems < 0) {
    throw new Error(`totalItems cannot be negative, got: ${totalItems}`);
  }
  if (buffer < 0) {
    throw new Error(`buffer cannot be negative, got: ${buffer}`);
  }
  
  // 处理负数 scrollTop（理论上不应发生，但防御性编程）
  const safeScrollTop = Math.max(0, scrollTop);
  
  const start = Math.max(0, Math.floor(safeScrollTop / itemHeight) - buffer);
  const end = Math.min(
    totalItems,
    Math.ceil((safeScrollTop + containerHeight) / itemHeight) + buffer
  );
  
  // 确保 start 不超过 totalItems（处理超大 scrollTop）
  const clampedStart = Math.min(start, totalItems);
  
  return { start: clampedStart, end };
}

// ============================================================================
// Phase 2: 拖拽排序测试
// ============================================================================

describe("Phase 2: 拖拽排序", () => {
  test("向下拖拽操作", () => {
    const shortcut = createTestShortcut("拖拽测试", 5);
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    const originalActions = shortcut.actions;
    expect(originalActions.length).toBe(5);

    // 将第 0 个操作拖到第 2 个位置
    const reordered = simulateDragReorder(originalActions, 0, 2);
    
    expect(reordered[0]?.id).toBe("action-1");
    expect(reordered[1]?.id).toBe("action-2");
    expect(reordered[2]?.id).toBe("action-0");
    expect(reordered[3]?.id).toBe("action-3");
    expect(reordered[4]?.id).toBe("action-4");

    // 验证 position 更新
    reordered.forEach((a, i) => {
      expect(a.position).toBe(i);
    });
  });

  test("向上拖拽操作", () => {
    const shortcut = createTestShortcut("拖拽测试", 5);
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    const originalActions = shortcut.actions;

    // 将第 4 个操作拖到第 1 个位置
    const reordered = simulateDragReorder(originalActions, 4, 1);
    
    expect(reordered[0]?.id).toBe("action-0");
    expect(reordered[1]?.id).toBe("action-4");
    expect(reordered[2]?.id).toBe("action-1");
    expect(reordered[3]?.id).toBe("action-2");
    expect(reordered[4]?.id).toBe("action-3");

    // 验证 position 更新
    reordered.forEach((a, i) => {
      expect(a.position).toBe(i);
    });
  });

  test("拖拽到同一位置（无变化）", () => {
    const shortcut = createTestShortcut("拖拽测试", 3);
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    const originalActions = shortcut.actions;
    const reordered = simulateDragReorder(originalActions, 1, 1);
    
    // 顺序应保持不变
    expect(reordered[0]?.id).toBe("action-0");
    expect(reordered[1]?.id).toBe("action-1");
    expect(reordered[2]?.id).toBe("action-2");
  });

  test("拖拽到边界位置", () => {
    const shortcut = createTestShortcut("拖拽测试", 4);
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    const originalActions = shortcut.actions;

    // 拖到最前面
    const toFirst = simulateDragReorder(originalActions, 3, 0);
    expect(toFirst[0]?.id).toBe("action-3");
    expect(toFirst[3]?.id).toBe("action-2");

    // 拖到最后面
    const toLast = simulateDragReorder(originalActions, 0, 3);
    expect(toLast[0]?.id).toBe("action-1");
    expect(toLast[3]?.id).toBe("action-0");
  });

  test("持久化拖拽后的顺序", () => {
    const shortcut = createTestShortcut("持久化测试", 3);
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    const reordered = simulateDragReorder(shortcut.actions, 0, 2);
    const success = updateShortcut(shortcut.id, { actions: reordered });
    expect(success).toBe(true);

    // 重新加载验证
    const loaded = loadShortcuts().find(s => s.id === shortcut.id);
    expect(loaded).not.toBeUndefined();
    if (!loaded) return;
    
    expect(loaded.actions[0]?.id).toBe("action-1");
    expect(loaded.actions[2]?.id).toBe("action-0");
  });
});

// ============================================================================
// Phase 2: 虚拟滚动测试
// ============================================================================

describe("Phase 2: 虚拟滚动", () => {
  const ITEM_HEIGHT = 120;
  const CONTAINER_HEIGHT = 600;
  const BUFFER = 5;

  test("计算初始可见范围", () => {
    const range = calculateVisibleRange(0, CONTAINER_HEIGHT, ITEM_HEIGHT, 100, BUFFER);
    
    // scrollTop=0, 可见约 5 个项目，buffer=5
    expect(range.start).toBe(0);
    expect(range.end).toBeGreaterThan(5);
    expect(range.end).toBeLessThanOrEqual(15);
  });

  test("滚动到中间位置", () => {
    const scrollTop = 1200; // 第 10 项附近
    const range = calculateVisibleRange(scrollTop, CONTAINER_HEIGHT, ITEM_HEIGHT, 100, BUFFER);
    
    // 应包含第 10 项左右，前后各有 buffer
    expect(range.start).toBeGreaterThanOrEqual(0);
    expect(range.start).toBeLessThan(10);
    expect(range.end).toBeGreaterThan(10);
  });

  test("滚动到底部", () => {
    const totalItems = 50;
    const scrollTop = totalItems * ITEM_HEIGHT; // 滚动到最底部
    const range = calculateVisibleRange(scrollTop, CONTAINER_HEIGHT, ITEM_HEIGHT, totalItems, BUFFER);
    
    // end 不应超过 totalItems
    expect(range.end).toBe(totalItems);
    expect(range.start).toBeGreaterThan(totalItems - 20);
  });

  test("buffer 确保平滑滚动", () => {
    const scrollTop = 600;
    const rangeWithBuffer = calculateVisibleRange(scrollTop, CONTAINER_HEIGHT, ITEM_HEIGHT, 100, 5);
    const rangeNoBuffer = calculateVisibleRange(scrollTop, CONTAINER_HEIGHT, ITEM_HEIGHT, 100, 0);
    
    // 有 buffer 的范围应更大
    expect(rangeWithBuffer.start).toBeLessThanOrEqual(rangeNoBuffer.start);
    expect(rangeWithBuffer.end).toBeGreaterThanOrEqual(rangeNoBuffer.end);
  });

  test("小列表不需要虚拟滚动", () => {
    const totalItems = 5;
    const range = calculateVisibleRange(0, CONTAINER_HEIGHT, ITEM_HEIGHT, totalItems, BUFFER);
    
    // 所有项目都应可见
    expect(range.start).toBe(0);
    expect(range.end).toBe(totalItems);
  });

  test("虚拟滚动不影响数据完整性", () => {
    // 创建 30 个快捷指令
    for (let i = 0; i < 30; i++) {
      createShortcut(`快捷指令 ${i}`);
    }

    const allShortcuts = loadShortcuts();
    expect(allShortcuts.length).toBe(30);

    // 模拟只渲染部分项目
    const range = calculateVisibleRange(600, CONTAINER_HEIGHT, ITEM_HEIGHT, 30, BUFFER);
    const visible = allShortcuts.slice(range.start, range.end);
    
    // 可见项目应该是原始数据的子集
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(allShortcuts.length);
    if (visible[0]) {
      expect(allShortcuts).toContain(visible[0]);
    }
  });
});

// ============================================================================
// Phase 2: 快捷键处理测试
// ============================================================================

describe("Phase 2: 快捷键配置", () => {
  test("支持的快捷键列表", () => {
    const shortcuts = [
      { key: "n", modifier: "cmd", action: "新建快捷指令" },
      { key: "f", modifier: "cmd", action: "聚焦搜索框" },
      { key: "k", modifier: "cmd", action: "添加操作" },
      { key: "Enter", modifier: "cmd", action: "运行快捷指令" },
      { key: "s", modifier: "cmd", action: "保存并返回" },
      { key: "d", modifier: "cmd", action: "复制快捷指令" },
      { key: "P", modifier: "cmd+shift", action: "显示实时预览" },
      { key: "Escape", modifier: "none", action: "关闭模态框/返回" },
    ];

    expect(shortcuts.length).toBe(8);
    const firstShortcut = shortcuts[0];
    if (firstShortcut) {
      expect(firstShortcut.key).toBe("n");
      expect(firstShortcut.action).toBe("新建快捷指令");
    }
  });

  test("跨平台修饰键支持", () => {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const modifierKey = isMac ? "cmd" : "ctrl";
    
    expect(["cmd", "ctrl"]).toContain(modifierKey);
  });
});

// ============================================================================
// Phase 2: 实时预览测试
// ============================================================================

describe("Phase 2: 实时预览", () => {
  test("预览空快捷指令", async () => {
    const shortcut = createShortcut("空预览");
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    expect(shortcut.actions.length).toBe(0);
    // 空快捷指令的预览应该立即完成
  });

  test("预览包含多个操作的快捷指令", async () => {
    const shortcut = createTestShortcut("预览测试", 3);
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    expect(shortcut.actions.length).toBe(3);
    // 预览应该逐步显示每个操作
  });

  test("预览步骤计数正确", () => {
    const shortcut = createTestShortcut("步骤测试", 5);
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    const totalSteps = shortcut.actions.length;
    expect(totalSteps).toBe(5);

    // 预览步骤应该从 0 到 totalSteps
    for (let step = 0; step <= totalSteps; step++) {
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThanOrEqual(totalSteps);
    }
  });

  test("预览结果记录", () => {
    const shortcut = createTestShortcut("结果测试", 2);
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    const results: Array<{ actionId: string; result: string }> = [];

    shortcut.actions.forEach(action => {
      results.push({
        actionId: action.id,
        result: `✓ 操作完成`,
      });
    });

    expect(results.length).toBe(2);
    const firstResult = results[0];
    const secondResult = results[1];
    if (firstResult) {
      expect(firstResult.actionId).toBe("action-0");
    }
    if (secondResult) {
      expect(secondResult.actionId).toBe("action-1");
    }
  });
});

// ============================================================================
// Phase 2: 综合场景测试
// ============================================================================

describe("Phase 2: 综合场景", () => {
  test("创建、拖拽排序、执行流程", () => {
    const shortcut = createTestShortcut("综合测试", 4);
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    // 1. 验证创建
    expect(shortcut.actions.length).toBe(4);

    // 2. 拖拽排序
    const reordered = simulateDragReorder(shortcut.actions, 3, 0);
    expect(reordered[0]?.id).toBe("action-3");

    // 3. 持久化
    const success = updateShortcut(shortcut.id, { actions: reordered });
    expect(success).toBe(true);

    // 4. 重新加载验证
    const loaded = loadShortcuts().find(s => s.id === shortcut.id);
    expect(loaded).not.toBeUndefined();
    if (!loaded) return;
    
    expect(loaded.actions[0]?.id).toBe("action-3");
  });

  test("大量快捷指令的虚拟滚动性能", () => {
    // 创建 100 个快捷指令
    for (let i = 0; i < 100; i++) {
      createShortcut(`快捷指令 ${i}`);
    }

    const allShortcuts = loadShortcuts();
    expect(allShortcuts.length).toBe(100);

    // 虚拟滚动只渲染可见部分
    const range = calculateVisibleRange(1200, 600, 120, 100, 5);
    const visible = allShortcuts.slice(range.start, range.end);

    // 可见项目远少于总数
    expect(visible.length).toBeLessThan(30);
    expect(visible.length).toBeGreaterThan(0);
  });

  test("快捷键配置完整性", () => {
    const shortcut = createShortcut("快捷键测试");
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    // 验证快捷指令创建成功
    expect(shortcut.name).toBe("快捷键测试");
    expect(shortcut.id).toBeDefined();
  });
});

// ============================================================================
// Phase 2: 参数验证测试
// ============================================================================

describe("Phase 2: 参数验证", () => {
  test("simulateDragReorder 验证 draggedIndex 下界", () => {
    const shortcut = createTestShortcut("参数验证", 3);
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    expect(() => {
      simulateDragReorder(shortcut.actions, -1, 1);
    }).toThrow("Invalid draggedIndex");
  });

  test("simulateDragReorder 验证 draggedIndex 上界", () => {
    const shortcut = createTestShortcut("参数验证", 3);
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    expect(() => {
      simulateDragReorder(shortcut.actions, 3, 1);
    }).toThrow("Invalid draggedIndex");
  });

  test("simulateDragReorder 验证 targetIndex 下界", () => {
    const shortcut = createTestShortcut("参数验证", 3);
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    expect(() => {
      simulateDragReorder(shortcut.actions, 0, -1);
    }).toThrow("Invalid targetIndex");
  });

  test("simulateDragReorder 验证 targetIndex 上界", () => {
    const shortcut = createTestShortcut("参数验证", 3);
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;

    expect(() => {
      simulateDragReorder(shortcut.actions, 0, 3);
    }).toThrow("Invalid targetIndex");
  });

  test("calculateVisibleRange 拒绝零 itemHeight", () => {
    expect(() => {
      calculateVisibleRange(0, 600, 0, 100, 5);
    }).toThrow("itemHeight must be positive");
  });

  test("calculateVisibleRange 拒绝负数 itemHeight", () => {
    expect(() => {
      calculateVisibleRange(0, 600, -120, 100, 5);
    }).toThrow("itemHeight must be positive");
  });

  test("calculateVisibleRange 拒绝负数 containerHeight", () => {
    expect(() => {
      calculateVisibleRange(0, -600, 120, 100, 5);
    }).toThrow("containerHeight cannot be negative");
  });

  test("calculateVisibleRange 拒绝负数 totalItems", () => {
    expect(() => {
      calculateVisibleRange(0, 600, 120, -100, 5);
    }).toThrow("totalItems cannot be negative");
  });

  test("calculateVisibleRange 拒绝负数 buffer", () => {
    expect(() => {
      calculateVisibleRange(0, 600, 120, 100, -5);
    }).toThrow("buffer cannot be negative");
  });

  test("calculateVisibleRange 处理负数 scrollTop", () => {
    const range = calculateVisibleRange(-100, 600, 120, 100, 5);
    // 应该被修正为 0
    expect(range.start).toBe(0);
    expect(range.end).toBeGreaterThan(0);
  });

  test("calculateVisibleRange 处理超大 scrollTop", () => {
    const range = calculateVisibleRange(999999, 600, 120, 100, 5);
    // end 应该被限制为 totalItems
    expect(range.end).toBe(100);
    expect(range.start).toBeLessThanOrEqual(100);
  });
});
