/**
 * keyboardConfig.test.ts — 快捷键配置单元测试（Phase 2）。
 */
import { beforeAll, afterAll, beforeEach, describe, expect, test } from "vitest";
import {
  KEYBOARD_CONFIG_KEY,
  resetKeyboardConfig,
  serializeShortcut,
  deserializeShortcut,
  detectConflicts,
  importConfig,
  exportConfig,
  readKeyboardConfig,
  writeKeyboardConfig,
  eventToShortcut,
  isValidShortcut,
  mergeOverlayBindings,
  type KeyboardConfig,
} from "../keyboardConfig";
import type { ShellShortcut } from "../shellModule";

describe("serializeShortcut", () => {
  test("basic shortcut", () => {
    const s: ShellShortcut = { key: "W", meta: true };
    expect(serializeShortcut(s)).toBe("meta-W");
  });

  test("all modifiers", () => {
    const s: ShellShortcut = { key: "X", meta: true, ctrl: true, shift: true, alt: true };
    expect(serializeShortcut(s)).toBe("meta-ctrl-shift-alt-X");
  });

  test("no modifiers", () => {
    const s: ShellShortcut = { key: "Escape" };
    expect(serializeShortcut(s)).toBe("Escape");
  });

  test("ctrl only", () => {
    const s: ShellShortcut = { key: "ArrowUp", ctrl: true };
    expect(serializeShortcut(s)).toBe("ctrl-ArrowUp");
  });
});

describe("deserializeShortcut", () => {
  test("basic shortcut", () => {
    const result = deserializeShortcut("meta-W");
    expect(result).toEqual({ key: "W", meta: true });
  });

  test("all modifiers", () => {
    const result = deserializeShortcut("meta-ctrl-shift-alt-X");
    expect(result).toEqual({ key: "X", meta: true, ctrl: true, shift: true, alt: true });
  });

  test("no modifiers", () => {
    const result = deserializeShortcut("Escape");
    expect(result).toEqual({ key: "Escape" });
  });

  test("ctrl only", () => {
    const result = deserializeShortcut("ctrl-ArrowUp");
    expect(result).toEqual({ key: "ArrowUp", ctrl: true });
  });

  test("invalid string", () => {
    expect(deserializeShortcut("")).toBeNull();
    expect(deserializeShortcut("invalid-")).toBeNull();
  });
});

describe("detectConflicts", () => {
  const registry = new Map<string, ShellShortcut[]>([
    ["launchpad", [{ key: "F4" }]],
    ["spotlight", [{ key: "Space", meta: true }]],
    ["mission-control", [{ key: "F3" }, { key: "Tab", meta: true }]],
  ]);

  const labelKeys = new Map<string, string>([
    ["launchpad", "desktop.launchpad"],
    ["spotlight", "desktop.spotlight"],
    ["mission-control", "desktop.missionControl"],
  ]);

  test("no conflicts with defaults", () => {
    const config = {
      version: 1,
      overlays: {},
      system: {},
      spaces: {},
      touch: {},
      updatedAt: 0,
    };
    const conflicts = detectConflicts(config, registry, labelKeys);
    expect(conflicts).toHaveLength(0);
  });

  test("no conflicts with valid custom bindings", () => {
    const config = {
      version: 1,
      overlays: {
        "launchpad": [{ key: "F5" }],
      },
      system: {},
      spaces: {},
      touch: {},
      updatedAt: 0,
    };
    const conflicts = detectConflicts(config, registry, labelKeys);
    expect(conflicts).toHaveLength(0);
  });

  test("detects duplicate bindings", () => {
    const config = {
      version: 1,
      overlays: {
        "spotlight": [{ key: "F4" }], // 冲突：launchpad 也用 F4
      },
      system: {},
      spaces: {},
      touch: {},
      updatedAt: 0,
    };
    const conflicts = detectConflicts(config, registry, labelKeys);
    expect(conflicts).toHaveLength(1);
    const conflict = conflicts[0];
    expect(conflict).toBeDefined();
    expect(conflict!.shortcut).toBe("F4");
    expect(conflict!.usedBy).toHaveLength(2);
    expect(conflict!.usedBy.map((x) => x.id).sort()).toEqual(["launchpad", "spotlight"]);
  });

  test("detects conflicts in system defaults", () => {
    const registryWithConflict = new Map<string, ShellShortcut[]>([
      ["launchpad", [{ key: "Space", meta: true }]], // 与 spotlight 冲突
      ["spotlight", [{ key: "Space", meta: true }]],
    ]);
    const conflicts = detectConflicts(
      { version: 1, overlays: {}, system: {}, spaces: {}, touch: {}, updatedAt: 0 },
      registryWithConflict,
      labelKeys,
    );
    expect(conflicts).toHaveLength(1);
    const conflict = conflicts[0];
    expect(conflict).toBeDefined();
    expect(conflict!.usedBy).toHaveLength(2);
  });
});

describe("importConfig / exportConfig", () => {
  const config = {
    version: 1,
    overlays: {
      launchpad: [{ key: "F12" }],
    },
    system: {
      closeWindow: { key: "W", meta: true, shift: true },
    },
    spaces: {},
    touch: {},
    updatedAt: 1234567890,
  };

  test("exportConfig produces valid JSON", () => {
    const json = exportConfig(config);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test("importConfig parses valid JSON", () => {
    const json = JSON.stringify(config);
    const result = importConfig(json);
    expect!("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.version).toBe(1);
      expect(result.overlays.launchpad).toEqual([{ key: "F12" }]);
    }
  });

  test("importConfig rejects invalid JSON", () => {
    const result = importConfig("not json");
    expect(result).toHaveProperty("error");
  });

  test("importConfig rejects missing version", () => {
    const result = importConfig('{"overlays": {}}');
    expect(result).toHaveProperty("error");
  });

  test("importConfig rejects future version", () => {
    const result = importConfig('{"version": 999, "overlays": {}, "system": {}}');
    expect(result).toHaveProperty("error");
  });
});

describe("isValidShortcut", () => {
  test("valid shortcuts", () => {
    expect(isValidShortcut({ key: "W", meta: true })).toBe(true);
    expect(isValidShortcut({ key: "Escape" })).toBe(true);
    expect(isValidShortcut({ key: "Space", ctrl: true })).toBe(true);
  });

  test("empty key is invalid", () => {
    expect(isValidShortcut({ key: "" })).toBe(false);
  });
});

describe("readKeyboardConfig / writeKeyboardConfig", () => {
  test("readKeyboardConfig returns default on missing", () => {
    // 这个测试依赖 localStorage，在测试环境中可能不可用
    const config = readKeyboardConfig();
    expect(config).toHaveProperty("version", 1);
    expect(config).toHaveProperty("overlays");
    expect(config).toHaveProperty("system");
    expect(config).toHaveProperty("spaces");
    expect(config).toHaveProperty("touch");
  });
});

describe("mergeOverlayBindings", () => {
  // The shared merge function used by both the touch-shell admission
  // (`lib/systemKeys.ts`) and the chrome keyboard shortcut panel
  // (`keyboardConfigHook.svelte.ts`). One rule book, two callers — both
  // pinned here so a future change in either consumer breaks this gate.
  const MODULES = [
    { id: "launchpad", shortcuts: [{ key: "F4" }] },
    { id: "spotlight", shortcuts: [{ key: " ", meta: true }] },
    { id: "control-center-panel" }, // no `shortcuts` — deliberately unbound
  ];

  test("returns the registry defaults when the config has no override", () => {
    const merged = mergeOverlayBindings(MODULES, {
      version: 1,
      overlays: {},
      system: {},
      spaces: {},
      touch: {},
      updatedAt: 0,
    });
    expect(merged.get("launchpad")).toEqual([{ key: "F4" }]);
    expect(merged.get("spotlight")).toEqual([{ key: " ", meta: true }]);
    // The unbound row contributes nothing — same invariant desktop chrome uses.
    expect(merged.has("control-center-panel")).toBe(false);
  });

  test("a user override replaces the registry defaults", () => {
    const merged = mergeOverlayBindings(MODULES, {
      version: 1,
      overlays: { launchpad: [{ key: "F5" }] },
      system: {},
      spaces: {},
      touch: {},
      updatedAt: 0,
    });
    expect(merged.get("launchpad")).toEqual([{ key: "F5" }]);
  });

  test("an explicit null drops the row (the user disabled it)", () => {
    const merged = mergeOverlayBindings(MODULES, {
      version: 1,
      overlays: { spotlight: null },
      system: {},
      spaces: {},
      touch: {},
      updatedAt: 0,
    });
    expect(merged.has("spotlight")).toBe(false);
    expect(merged.has("launchpad")).toBe(true);
  });

  test("a module without `shortcuts` is silently skipped", () => {
    // Control Center and Spaces are deliberately unbound; the merge must not
    // synthesise a binding where the registry declared none.
    const merged = mergeOverlayBindings(MODULES, {
      version: 1,
      overlays: { "control-center-panel": [{ key: "F9" }] }, // user override on an unbound row
      system: {},
      spaces: {},
      touch: {},
      updatedAt: 0,
    });
    expect(merged.has("control-center-panel")).toBe(false);
  });
});

/**
 * REQ-A406 — 冲突检测里两处「注释说要这么做、代码其实没做」。
 *
 * `detectConflicts` 的注释写着禁用是"从所有键映射中移除"，而实现只是
 * `arr.findIndex(...)`（返回值丢掉）—— 一个**没有副作用**的空循环；`applyOverride` 换绑时
 * 也只往新键里加，**不摘旧键**。两个洞都会让设置页报出不存在的冲突（用户禁掉/换掉一个绑定
 * 之后，冲突面板还在说这门键有两个人用），而冲突检测本身是"保存前拦截无效配置"的那道门。
 */
describe("detectConflicts：禁用与换绑都是「替换」，不是「追加」（REQ-A406）", () => {
  const registry = () =>
    new Map<string, ShellShortcut[]>([
      ["launchpad", [{ key: "F4" }]],
      ["spotlight", [{ key: "F4" }]],
      ["mission-control", [{ key: "F9" }]],
    ]);
  const labels = new Map<string, string>([
    ["launchpad", "desktop.launchpad"],
    ["spotlight", "desktop.spotlight"],
    ["mission-control", "desktop.missionControl"],
  ]);
  const base: KeyboardConfig = {
    version: 1,
    overlays: {},
    system: {},
    spaces: {},
    touch: {},
    updatedAt: 0,
  };

  test("对照组：注册表里的重叠会被报出来", () => {
    expect(detectConflicts(base, registry(), labels).map((c) => c.shortcut)).toEqual(["F4"]);
  });

  test("禁用（null）把自己的绑定从所有键里摘掉 ⇒ 冲突随之消失", () => {
    const config: KeyboardConfig = { ...base, overlays: { spotlight: null } };
    expect(detectConflicts(config, registry(), labels)).toEqual([]);
  });

  test("换绑不留旧键的残影：旧键上只剩原来那个功能", () => {
    // spotlight 从 F4 换到 F9 —— F9 与 mission-control 冲突，而 F4 上只剩 launchpad。
    const config: KeyboardConfig = { ...base, overlays: { spotlight: [{ key: "F9" }] } };
    const conflicts = detectConflicts(config, registry(), labels);
    expect(conflicts.map((c) => c.shortcut)).toEqual(["F9"]);
    expect(conflicts[0]!.usedBy.map((x) => x.id).sort()).toEqual(["mission-control", "spotlight"]);
    expect(conflicts.some((c) => c.shortcut === "F4")).toBe(false);
  });

  test("system / spaces / touch 里的 null 同样是禁用", () => {
    const two = new Map<string, ShellShortcut[]>([
      ["closeWindow", [{ key: "W", meta: true }]],
      ["other", [{ key: "W", meta: true }]],
    ]);
    expect(detectConflicts(base, two, new Map())).toHaveLength(1);
    for (const field of ["system", "spaces", "touch"] as const) {
      const config = { ...base, [field]: { closeWindow: null } } as KeyboardConfig;
      expect(detectConflicts(config, two, new Map())).toEqual([]);
    }
  });
});

describe("配置持久化：读/写/重置与版本迁移（REQ-A406）", () => {
  // 内存 window —— 只在本 describe 存活（纯批次是一个进程跑所有文件）。
  const memory = new Map<string, string>();
  let failWrites = false;
  const globals = globalThis as Record<string, unknown>;
  const previousWindow = globals.window;

  beforeAll(() => {
    globals.window = {
      localStorage: {
        getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
        setItem: (k: string, v: string) => {
          if (failWrites) throw new Error("QuotaExceededError");
          memory.set(k, String(v));
        },
        removeItem: (k: string) => void memory.delete(k),
        clear: () => memory.clear(),
        key: (i: number) => [...memory.keys()][i] ?? null,
        get length() {
          return memory.size;
        },
      },
      dispatchEvent: () => true,
    };
  });
  afterAll(() => {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  });
  beforeEach(() => {
    memory.clear();
    failWrites = false;
  });

  const fresh = (): KeyboardConfig => ({
    version: 0,
    overlays: { launchpad: [{ key: "F5" }] },
    system: {},
    spaces: {},
    touch: {},
    updatedAt: 0,
  });

  test("写进去能读回来，并盖上当前版本与时间戳", () => {
    expect(writeKeyboardConfig(fresh())).toBe(true);
    const back = readKeyboardConfig();
    expect(back.version).toBe(1);
    expect(back.updatedAt).toBeGreaterThan(0);
    expect(back.overlays.launchpad).toEqual([{ key: "F5" }]);
  });

  test("旧版本号的配置被迁移到当前版本（不是原样交回）", () => {
    memory.set(KEYBOARD_CONFIG_KEY, JSON.stringify(fresh()));
    expect(readKeyboardConfig().version).toBe(1);
  });

  test("resetKeyboardConfig 落盘默认值（清掉用户覆盖）", () => {
    writeKeyboardConfig(fresh());
    resetKeyboardConfig();
    const back = readKeyboardConfig();
    expect(back.overlays).toEqual({});
    expect(back.updatedAt).toBeGreaterThan(0);
  });

  test("存储拒绝写入 ⇒ 回 false，不谎报成功", () => {
    failWrites = true;
    expect(writeKeyboardConfig(fresh())).toBe(false);
  });
});


/**
 * REQ-A407 — `importConfig` 剩下的两个错误分支，以及 `eventToShortcut`（键盘事件 → 快捷键）。
 * 后者是"用户按下什么键"与"配置里那条绑定"之间唯一的翻译层：可打印键必须大写（否则 `a` 与
 * `A` 会变成两条不同的绑定，冲突检测就漏了），功能键必须原样（`ArrowUp` 没有大小写问题但
 * 单独大写它会让序列化字符串漂移）。
 */
describe("importConfig 的其余错误分支 + eventToShortcut（REQ-A407）", () => {
  test("JSON 合法但不是对象（字符串 / 数字 / null / 布尔）⇒ not an object", () => {
    for (const bad of ['"a string"', "5", "null", "true"]) {
      const result = importConfig(bad);
      expect([bad, "error" in result ? result.error : null]).toEqual([
        bad,
        "Invalid format: not an object",
      ]);
    }
  });

  test("是对象、版本也合法，但缺 overlays / system ⇒ missing required fields", () => {
    for (const bad of ['{"version": 1, "system": {}}', '{"version": 1, "overlays": {}}']) {
      const result = importConfig(bad);
      expect([bad, "error" in result ? result.error : null]).toEqual([
        bad,
        "Invalid format: missing required fields",
      ]);
    }
  });

  const ev = (e: Record<string, unknown>) => e as unknown as KeyboardEvent;

  test("可打印键大写；功能键与空格原样", () => {
    expect(eventToShortcut(ev({ key: "a" }))).toEqual({ key: "A" });
    expect(eventToShortcut(ev({ key: "ArrowUp" }))).toEqual({ key: "ArrowUp" });
    expect(eventToShortcut(ev({ key: "Escape" }))).toEqual({ key: "Escape" });
    expect(eventToShortcut(ev({ key: " " }))).toEqual({ key: " " });
  });

  test("四个修饰键照搬（缺省即 false/undefined，不发明 true）", () => {
    expect(
      eventToShortcut(ev({ key: "k", metaKey: true, ctrlKey: true, shiftKey: true, altKey: true })),
    ).toEqual({ key: "K", meta: true, ctrl: true, shift: true, alt: true });
    expect(eventToShortcut(ev({ key: "k" }))).toEqual({ key: "K" });
  });

  test("翻译出来的键能原样走序列化往返（冲突检测就是按这个字符串比对的）", () => {
    const shortcut = eventToShortcut(ev({ key: "a", metaKey: true, shiftKey: true }));
    expect(serializeShortcut(shortcut)).toBe("meta-shift-A");
    expect(deserializeShortcut(serializeShortcut(shortcut))).toEqual(shortcut);
  });
});

