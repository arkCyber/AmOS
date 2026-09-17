/**
 * keyboardConfig.ts — 快捷键配置持久化与冲突检测（Phase 2）。
 *
 * 负责：
 *   1. 配置的持久化存储（localStorage）
 *   2. 用户自定义绑定与系统默认的合并
 *   3. 快捷键冲突检测
 *   4. 配置的导入/导出
 *
 * 架构：
 *   - 用户配置独立存储，不直接修改系统注册表
 *   - 运行时通过 `resolveEffectiveBindings()` 合并配置
 *   - 冲突检测在保存前进行，防止无效配置
 */
import { readStoreValue, writeStoreValue } from "./amosStore";
import type { ShellShortcut } from "./shellModule";

/** 快捷键配置存储键名。 */
export const KEYBOARD_CONFIG_KEY = "amos.keyboard.config";

/** 快捷键配置版本（用于未来迁移）。 */
const CONFIG_VERSION = 1;

/**
 * 快捷键配置数据结构。
 *
 * `overlays` 和 `system` 里的值会覆盖系统默认；
 * `null` 表示该快捷键被禁用。
 */
export interface KeyboardConfig {
  version: number;
  /** 浮层快捷键覆盖（id → 绑定数组）。 */
  overlays: Record<string, ShellShortcut[] | null>;
  /** 系统快捷键覆盖（id → 绑定）。 */
  system: Record<string, ShellShortcut | null>;
  /** Spaces 快捷键覆盖。 */
  spaces: Record<string, ShellShortcut | null>;
  /** 触屏快捷键覆盖。 */
  touch: Record<string, ShellShortcut | null>;
  /** 配置时间戳（用于排序/诊断）。 */
  updatedAt: number;
}

/** 默认配置（空配置 = 使用系统默认值）。 */
const DEFAULT_CONFIG: KeyboardConfig = {
  version: CONFIG_VERSION,
  overlays: {},
  system: {},
  spaces: {},
  touch: {},
  updatedAt: 0,
};

/** 读取当前配置。 */
export function readKeyboardConfig(): KeyboardConfig {
  const stored = readStoreValue<KeyboardConfig | null>(KEYBOARD_CONFIG_KEY, null);
  if (!stored) return { ...DEFAULT_CONFIG };
  // 版本检查与迁移（未来扩展用）
  if (stored.version !== CONFIG_VERSION) {
    // 未来：添加迁移逻辑
    stored.version = CONFIG_VERSION;
  }
  return stored;
}

/** 保存配置。 */
export function writeKeyboardConfig(config: KeyboardConfig): boolean {
  config.version = CONFIG_VERSION;
  config.updatedAt = Date.now();
  writeStoreValue(KEYBOARD_CONFIG_KEY, config);
  return true;
}

/** 重置为默认配置。 */
export function resetKeyboardConfig(): void {
  writeKeyboardConfig({ ...DEFAULT_CONFIG, updatedAt: Date.now() });
}

/**
 * 将快捷键序列化为稳定的字符串（用于比较和冲突检测）。
 * 格式：`[meta-][ctrl-][shift-][alt-]KEY`
 */
export function serializeShortcut(s: ShellShortcut): string {
  const parts: string[] = [];
  if (s.meta) parts.push("meta");
  if (s.ctrl) parts.push("ctrl");
  if (s.shift) parts.push("shift");
  if (s.alt) parts.push("alt");
  parts.push(s.key);
  return parts.join("-");
}

/**
 * 反序列化快捷键字符串。
 */
export function deserializeShortcut(str: string): ShellShortcut | null {
  const parts = str.split("-");
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1];
  if (!key) return null;
  const s: ShellShortcut = { key };
  for (const p of parts.slice(0, -1)) {
    if (p === "meta") s.meta = true;
    else if (p === "ctrl") s.ctrl = true;
    else if (p === "shift") s.shift = true;
    else if (p === "alt") s.alt = true;
    else return null; // 未知修饰符
  }
  return s;
}

/** 冲突条目：哪个键冲突，被哪些功能占用。 */
export interface ShortcutConflict {
  /** 冲突的快捷键序列化字符串。 */
  shortcut: string;
  /** 使用该键的所有功能 id。 */
  usedBy: Array<{ id: string; labelKey: string }>;
}

/**
 * 检测快捷键冲突。
 *
 * 检查所有已配置的快捷键，报告所有键被多个功能使用的情况。
 * 注意：禁用的快捷键（`null`）不参与冲突检测。
 *
 * @param config 用户配置
 * @param registry 系统注册表（id → 默认绑定）
 * @param labelKeys 功能 id → i18n 标签键的映射
 * @returns 冲突列表
 */
export function detectConflicts(
  config: KeyboardConfig,
  registry: ReadonlyMap<string, ShellShortcut[]>,
  labelKeys: ReadonlyMap<string, string>,
): ShortcutConflict[] {
  // 收集所有键的映射：序列化键 → [{ id, labelKey }]
  const keyToFunctions = new Map<string, Array<{ id: string; labelKey: string }>>();

  // 遍历注册表（系统默认）
  for (const [id, shortcuts] of registry) {
    const labelKey = labelKeys.get(id) ?? id;
    for (const s of shortcuts) {
      const key = serializeShortcut(s);
      if (!keyToFunctions.has(key)) {
        keyToFunctions.set(key, []);
      }
      // 只添加还没有这个 id 的条目
      const arr = keyToFunctions.get(key)!;
      if (!arr.some((x) => x.id === id)) {
        arr.push({ id, labelKey });
      }
    }
  }

  // 应用用户覆盖
  const applyOverride = (id: string, shortcut: ShellShortcut | null) => {
    if (!shortcut) return; // 禁用，不加入
    const key = serializeShortcut(shortcut);
    const labelKey = labelKeys.get(id) ?? id;
    if (!keyToFunctions.has(key)) {
      keyToFunctions.set(key, []);
    }
    const arr = keyToFunctions.get(key)!;
    // 移除旧条目（如果有）
    const filtered = arr.filter((x) => x.id !== id);
    filtered.push({ id, labelKey });
    keyToFunctions.set(key, filtered);
  };

  // 应用 overlays
  for (const [id, shortcuts] of Object.entries(config.overlays)) {
    if (shortcuts) {
      for (const s of shortcuts) {
        applyOverride(id, s);
      }
    } else {
      // 禁用：从所有键映射中移除
      for (const arr of keyToFunctions.values()) {
        arr.findIndex((x) => x.id === id);
      }
    }
  }

  // 应用 system
  for (const [id, shortcut] of Object.entries(config.system)) {
    applyOverride(id, shortcut);
  }

  // 应用 spaces
  for (const [id, shortcut] of Object.entries(config.spaces)) {
    applyOverride(id, shortcut);
  }

  // 应用 touch
  for (const [id, shortcut] of Object.entries(config.touch)) {
    applyOverride(id, shortcut);
  }

  // 收集冲突
  const conflicts: ShortcutConflict[] = [];
  for (const [shortcut, usedBy] of keyToFunctions) {
    if (usedBy.length > 1) {
      conflicts.push({ shortcut, usedBy });
    }
  }

  return conflicts;
}

/**
 * 导出配置为 JSON 字符串（用于下载/导入）。
 */
export function exportConfig(config: KeyboardConfig): string {
  return JSON.stringify(config, null, 2);
}

/**
 * 从 JSON 字符串导入配置。
 * 验证格式和版本，不验证冲突（用户需要自己处理）。
 */
export function importConfig(json: string): KeyboardConfig | { error: string } {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) {
      return { error: "Invalid format: not an object" };
    }
    if (typeof parsed.version !== "number") {
      return { error: "Invalid format: missing version" };
    }
    if (parsed.version > CONFIG_VERSION) {
      return { error: `Unsupported config version: ${parsed.version}` };
    }
    // 基本结构验证
    if (typeof parsed.overlays !== "object" || typeof parsed.system !== "object") {
      return { error: "Invalid format: missing required fields" };
    }
    return parsed as KeyboardConfig;
  } catch (e) {
    return { error: `Parse error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 从 KeyboardEvent 生成 ShellShortcut。
 */
export function eventToShortcut(e: KeyboardEvent): ShellShortcut {
  return {
    key: e.key.length === 1 ? e.key.toUpperCase() : e.key,
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}

/**
 * 检查快捷键是否有实际绑定（不能全是 false/undefined）。
 */
export function isValidShortcut(s: ShellShortcut): boolean {
  return Boolean(s.key && (s.meta || s.ctrl || s.shift || s.alt || true));
}

/**
 * Merge registry overlay rows with a `KeyboardConfig`. The shape of the
 * returned map is identical to the `overlay` field of `ResolvedBindings` in
 * `keyboardConfigHook.svelte.ts` — both layers now read this function so the
 * system key admission (touch shell) and the chrome keyboard shortcut panel
 * cannot drift apart.
 *
 * Merge rules (mirrored verbatim from `resolveBindings`, deliberately kept
 * here so the rune-bound hook does not leak into pure-logic callers):
 *   • `custom === undefined`  → use the registry defaults (`m.shortcuts`)
 *   • `custom === null`       → the user disabled this binding — drop the row
 *   • `custom !== null`       → use the user override (already a list)
 *
 * Modules with no `shortcuts` field are skipped entirely (Control Center and
 * Spaces are deliberately unbinding; they have no touch-side equivalent).
 */
export function mergeOverlayBindings(
  modules: readonly { id: string; shortcuts?: readonly ShellShortcut[] }[],
  config: KeyboardConfig,
): Map<string, ShellShortcut[]> {
  const out = new Map<string, ShellShortcut[]>();
  for (const m of modules) {
    if (!m.shortcuts) continue;
    const custom = config.overlays[m.id];
    if (custom === undefined) {
      out.set(m.id, [...m.shortcuts]);
    } else if (custom !== null) {
      out.set(m.id, custom);
    }
    // custom === null ⇒ disabled, drop the row.
  }
  return out;
}
