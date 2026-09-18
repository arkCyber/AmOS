/**
 * keyboardConfigHook.ts — 快捷键配置 Hook（Phase 3）。
 *
 * 负责：
 *   1. 监听配置变化（storage 事件）
 *   2. 合并用户配置与系统默认
 *   3. 提供 reactive 绑定给 Shell 使用
 *
 * 使用方式：
 *   const bindings = useKeyboardBindings();
 *   // bindings.overlays - 合并后的浮层快捷键
 *   // bindings.system - 合并后的系统快捷键
 *   // bindings.spaces - 合并后的 Spaces 快捷键
 */
import { SHELL_MODULES } from "../svelte/shellModules";
import { modulesFor, formatShortcut, shortcutMatches, type ShellShortcut } from "./shellModule";
import {
  readKeyboardConfig,
  mergeOverlayBindings,
  type KeyboardConfig,
} from "./keyboardConfig";

/** 配置存储键名（用于监听）。 */
export const KEYBOARD_CONFIG_KEY = "amos.keyboard.config";

/** 合并后的快捷键绑定。 */
export interface ResolvedBindings {
  /** 浮层快捷键（合并后）。 */
  overlays: Map<string, ShellShortcut[]>;
  /** 系统快捷键（合并后）。 */
  system: Map<string, ShellShortcut>;
  /** Spaces 快捷键（合并后）。 */
  spaces: Map<string, ShellShortcut>;
  /** 触屏快捷键（合并后）。 */
  touch: Map<string, ShellShortcut>;
}

/** 系统默认快捷键定义（与 KeyboardPage.svelte 保持同步）。 */
export const SYSTEM_DEFAULTS: Record<string, ShellShortcut> = {
  closeWindow: { key: "W", meta: true },
  minimizeWindow: { key: "M", meta: true },
  hideApp: { key: "H", meta: true },
  preferences: { key: ",", meta: true },
};

export const SPACES_DEFAULTS: Record<string, ShellShortcut> = {
  spacesPrev: { key: "ArrowLeft", ctrl: true },
  spacesNext: { key: "ArrowRight", ctrl: true },
  spacesPanel: { key: "ArrowUp", ctrl: true },
  spacesDirect: { key: "1", ctrl: true },
};

export const TOUCH_DEFAULTS: Record<string, ShellShortcut> = {
  back: { key: "[", meta: true },
  dismiss: { key: "Escape" },
};

/** 全局单例（供整个应用使用）。 */
let globalBindings: ResolvedBindings | null = null;
let globalRefresh: (() => void) | null = null;

/**
 * 创建并返回合并后的快捷键绑定。
 * 当 localStorage 中的配置变化时自动更新。
 */
export function createKeyboardBindings() {
  let bindings = $state<ResolvedBindings>(resolveBindings(readKeyboardConfig()));

  // 这里曾经**再抄一份** `resolveBindings`（与下面的模块级同名函数逐字重复，
  // 只有 if/else 的写法略有不同）。两份合并在同一个文件里漂移是必然的 ——
  // 浮层那一份就没跟上 `keyboardConfig.mergeOverlayBindings` 这条共用规则书，
  // 而 `systemKeys.ts` 的注释却写着"两个调用方共用一本规则书"。现在只有一份：
  // 模块级 `resolveBindings`（浮层域直接调 `mergeOverlayBindings`）。

  function refreshBindings() {
    bindings = resolveBindings(readKeyboardConfig());
    // 更新全局单例
    globalBindings = bindings;
    // 通知所有监听者
    if (globalRefresh) globalRefresh();
  }

  // 监听 storage 变化（其他标签页或设置页面修改配置时）
  function handleStorageChange(e: StorageEvent) {
    if (e.key === KEYBOARD_CONFIG_KEY) {
      refreshBindings();
    }
  }

  // 启动监听
  function startListening() {
    if (typeof window !== "undefined") {
      window.addEventListener("storage", handleStorageChange);
    }
  }

  // 停止监听
  function stopListening() {
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorageChange);
    }
  }

  return {
    /** 当前绑定的快照（reactive）。 */
    get bindings() { return bindings; },

    /** 手动刷新绑定（当配置被同标签页修改时）。 */
    refresh: refreshBindings,

    /** 启动监听。 */
    startListening,

    /** 停止监听。 */
    stopListening,

    /** 获取特定浮层的快捷键（用于工具提示）。 */
    getOverlayShortcut(id: string): string | null {
      const shortcuts = bindings.overlays.get(id);
      if (!shortcuts || shortcuts.length === 0) return null;
      return shortcuts.map((s) => formatShortcut(s)).join(" / ");
    },

    /** 获取系统快捷键（用于工具提示）。 */
    getSystemShortcut(id: string): string | null {
      const shortcut = bindings.system.get(id);
      if (!shortcut) return null;
      return formatShortcut(shortcut);
    },

    /** 获取 Spaces 快捷键（用于工具提示）。 */
    getSpacesShortcut(id: string): string | null {
      const shortcut = bindings.spaces.get(id);
      if (!shortcut) return null;
      return formatShortcut(shortcut);
    },

    /** 获取触屏快捷键（用于工具提示）。 */
    getTouchShortcut(id: string): string | null {
      const shortcut = bindings.touch.get(id);
      if (!shortcut) return null;
      return formatShortcut(shortcut);
    },
  };
}

/**
 * 获取全局合并后的绑定（用于非 Svelte 上下文，如 systemKeys.ts）。
 */
export function getGlobalBindings(): ResolvedBindings {
  if (!globalBindings) {
    globalBindings = resolveBindings(readKeyboardConfig());
  }
  return globalBindings;
}

function resolveBindings(config: KeyboardConfig): ResolvedBindings {
  // ─── 浮层快捷键 ─────────────────────────────────────────────────────
  // 三态合并（默认 / 自定义 / `null` 禁用）**只在这里与 `mergeOverlayBindings` 一处**：
  // 触摸壳的键盘准入（`systemKeys.ts`）读的是同一个函数，所以桌面壳、触摸壳与
  // ⌘-hold 面板不可能再各写一份规则。
  const overlays = mergeOverlayBindings(modulesFor("overlay", SHELL_MODULES), config);

  // ─── 系统快捷键 ─────────────────────────────────────────────────────
  const system = new Map<string, ShellShortcut>();
  for (const [id, defaultShortcut] of Object.entries(SYSTEM_DEFAULTS)) {
    const custom = config.system[id];
    if (custom === undefined) {
      system.set(id, defaultShortcut);
    } else if (custom !== null) {
      system.set(id, custom);
    }
  }

  // ─── Spaces 快捷键 ─────────────────────────────────────────────────
  const spaces = new Map<string, ShellShortcut>();
  for (const [id, defaultShortcut] of Object.entries(SPACES_DEFAULTS)) {
    const custom = config.spaces[id];
    if (custom === undefined) {
      spaces.set(id, defaultShortcut);
    } else if (custom !== null) {
      spaces.set(id, custom);
    }
  }

  // ─── 触屏快捷键 ────────────────────────────────────────────────────
  const touch = new Map<string, ShellShortcut>();
  for (const [id, defaultShortcut] of Object.entries(TOUCH_DEFAULTS)) {
    const custom = config.touch[id];
    if (custom === undefined) {
      touch.set(id, defaultShortcut);
    } else if (custom !== null) {
      touch.set(id, custom);
    }
  }

  return { overlays, system, spaces, touch };
}

/** 快捷键匹配结果。 */
export interface ShortcutMatch {
  id: string;
  shortcuts: ShellShortcut[];
}

/**
 * 在绑定中查找匹配当前事件的快捷键。
 */
export function findMatchingBinding(
  bindings: Map<string, ShellShortcut[]>,
  e: KeyboardEvent,
): ShortcutMatch | null {
  // 判据**委托给 `shellModule.shortcutMatches`**（两处匹配逻辑必须是一份真相）。这里原来
  // 自己写了一组比较：
  //
  //     if (s.shift !== e.shiftKey) continue;
  //     if (s.alt !== e.altKey) continue;
  //
  // 而 `ShellShortcut.shift` / `alt` 是**可选**的（`SHELL_MODULES` / `SYSTEM_DEFAULTS` 里
  // 一条都没写）。于是 `undefined !== false` 恒真 ⇒ **每一个默认绑定都会被 `continue` 掉**，
  // 这个函数对当前所有绑定都只会回 `null`。当时它没有生产调用点（浮层键走注册表那条
  // `moduleForShortcut`，REQ-A394 已把后者删掉），所以是**潜伏**缺陷而不是线上故障；
  // 但它正是桌面壳浮层键的入口 —— 委托之后两处判据同源，不会再各自漂移。
  for (const [id, shortcuts] of bindings) {
    if (shortcuts.some((s) => shortcutMatches(e, s))) {
      return { id, shortcuts };
    }
  }
  return null;
}

/**
 * 检查单个快捷键是否匹配事件。
 */
export function matchesShortcut(s: ShellShortcut, e: KeyboardEvent): boolean {
  // `KeyboardEvent.key` is lowercase for letters ("w") while macOS / human-written
  // shortcuts are uppercase ("W"). Normalise both sides before comparing so a
  // ⌘W typed by the user matches a `closeWindow: { key: "W", meta: true }` entry.
  const normalizeKey = (key: string): string => {
    const k = key === " " || key === "Spacebar" ? "Space" : key;
    return k.length === 1 ? k.toUpperCase() : k;
  };

  if (normalizeKey(e.key) !== normalizeKey(s.key)) return false;
  if (Boolean(s.meta) !== Boolean(e.metaKey || e.ctrlKey)) return false;
  if (Boolean(s.ctrl) !== Boolean(e.ctrlKey)) return false;
  if (Boolean(s.shift) !== Boolean(e.shiftKey)) return false;
  if (Boolean(s.alt) !== Boolean(e.altKey)) return false;

  return true;
}

/**
 * 获取合并后的浮层快捷键 Map（用于 systemKeys.ts）。
 */
export function getMergedOverlayBindings(): Map<string, ShellShortcut[]> {
  return getGlobalBindings().overlays;
}
