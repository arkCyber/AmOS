/**
 * keyboardConfig.test.ts — 快捷键配置单元测试（Phase 2）。
 */
import { describe, expect, test } from "vitest";
import {
  serializeShortcut,
  deserializeShortcut,
  detectConflicts,
  importConfig,
  exportConfig,
  readKeyboardConfig,
  writeKeyboardConfig,
  resetKeyboardConfig,
  isValidShortcut,
  mergeOverlayBindings,
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
    expect(conflicts[0].shortcut).toBe("F4");
    expect(conflicts[0].usedBy).toHaveLength(2);
    expect(conflicts[0].usedBy.map((x) => x.id).sort()).toEqual(["launchpad", "spotlight"]);
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
    expect(conflicts[0].usedBy).toHaveLength(2);
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
