/**
 * keyboardConfigHook.ts — 快捷键配置 Hook（Phase 3）。
 *
 * 负责：
 *   1. 监听配置变化（同窗口 / 兄弟窗口 / 宿主推送三条通路，见 `createKeyboardBindings`）
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
import { createStoreValue } from "../svelte/store";
import { modulesFor, formatShortcut, shortcutMatches, type ShellShortcut } from "./shellModule";
import {
  readKeyboardConfig,
  mergeOverlayBindings,
  mergeTouchBindings,
  TOUCH_DEFAULTS,
  type KeyboardConfig,
} from "./keyboardConfig";

// Re-exported so the Settings page and the boundary tests keep naming the *engine* module as
// the home of the defaults, while the pure table lives where `lib/systemKeys.ts` can reach it
// without importing `svelte/` (REQ-A1200). One definition, two importers.
export { TOUCH_DEFAULTS };

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
  // REQ-A473: the two per-app window chords. They only became meaningful once an app could
  // own more than one window (`lib/windowRoute.ts` resolves the instance suffix); before
  // that `⌘N` could not duplicate anything and `⌘\`` had no ring to walk.
  newWindow: { key: "N", meta: true },
  cycleWindows: { key: "`", meta: true },
};

export const SPACES_DEFAULTS: Record<string, ShellShortcut> = {
  spacesPrev: { key: "ArrowLeft", ctrl: true },
  spacesNext: { key: "ArrowRight", ctrl: true },
  spacesPanel: { key: "ArrowUp", ctrl: true },
  spacesDirect: { key: "1", ctrl: true },
  // REQ-A476: `⌃↓` is macOS's **Application Windows** (App Exposé) — the fourth member of
  // the same Control-arrow family as the three above (⌃←/→ move between desktops, ⌃↑ opens
  // Mission Control, ⌃↓ shows *this app's* windows). It is configured here rather than in
  // the overlay registry on purpose: the registry's overlay-shortcut set
  // (`F3 / F4 / ⌘Space / ⌘Tab`) is a documented, test-pinned invariant, and the fifth
  // overlay (`spaces-panel`) took the same route for the same reason.
  appExpose: { key: "ArrowDown", ctrl: true },
};

/**
 * 触屏默认值现在住在 `keyboardConfig.ts`（纯逻辑模块），因为触摸壳的键盘准入
 * （`lib/systemKeys.ts`）必须读**同一张表**，而它不能 import 本文件（本文件 import 了
 * `svelte/shellModules`）。这里只是把它转发出来，让设置页与边界测试仍从"引擎"模块取名。
 */


/** 全局单例（供整个应用使用）。 */
let globalBindings: ResolvedBindings | null = null;

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

  // 这枚键的**三条**变更通路（同窗口写者派发的 `amos-store-changed`、兄弟 webview 的
  // `storage`、宿主 `SharedStore::set` 推给每个窗口的 `store-updated`）由 `createStoreValue`
  // 一处接上 —— 与 `Dock.svelte`、`PushManagementPage` 等每一个共享 store 消费者同一枚原语。
  //
  // 这里原先是**手写的 storage 一条**：只有在"别的文档"改了这枚键时才重组。于是**写下配置
  // 的那扇窗看不见自己的改动** —— 设置 ▸ 键盘（`KeyboardPage.svelte` 的 `writeKeyboardConfig`）
  // 与 `DesktopWindowKeys` 同在一扇 `WebviewWindow` 里，而同一次 `localStorage` 写入
  // **不会在自己的文档里触发 `storage` 事件**（浏览器只在别的文档里派发它）。用户在设置窗把
  // `closeWindow` 从 ⌘W 改到 ⌥⌘W 或直接禁用，设置窗自己那一份绑定还是旧的：⌘W 当场照旧关窗。
  // `refresh` 的文档注释写着"当配置被同标签页修改时"要手动调 —— 那正是这条缺失通路的自白。
  const configStore = createStoreValue<KeyboardConfig | null>(KEYBOARD_CONFIG_KEY, null);

  function refreshBindings() {
    bindings = resolveBindings(readKeyboardConfig());
    // 更新全局单例（`getGlobalBindings` 供非 Svelte 上下文读）
    globalBindings = bindings;
  }

  /**
   * 订阅这枚键（首次调用生效，重复调用是空操作）。订阅本身就把三条通路接上；`svelte/store`
   * 的引用计数在最后一个订阅者离开时拆除监听，所以 `stopListening` 不会留下监听者。
   *
   * `primed` 跳过 `subscribe` 的**首次同步投递**：`svelte/store` 的 `subscribe` 会立刻用当前值
   * 调一次回调，而初始值在构造时已经算过 —— 若在这里同步写 `bindings`，`TopbarMainMenu` 那种
   * 在 `$effect` 里调 `startListening()` 的调用方就变成"一个 effect 读并写同一份 state"，
   * Svelte 直接抛 `effect_update_depth_exceeded`（实测：`topbar-main-menu-live-bindings` 与
   * `spaces-panel-follows-shell-switch` 当场死循环）。真正的变更都由后续投递带来。
   */
  let unsubscribeConfig: (() => void) | null = null;
  let primed = false;

  function startListening() {
    if (unsubscribeConfig) return;
    unsubscribeConfig = configStore.subscribe(() => {
      if (!primed) {
        primed = true;
        return;
      }
      refreshBindings();
    });
  }

  function stopListening() {
    if (!unsubscribeConfig) return;
    unsubscribeConfig();
    unsubscribeConfig = null;
  }

  return {
    /** 当前绑定的快照（reactive）。 */
    get bindings() { return bindings; },

    /**
     * 手动重新合并绑定。三条变更通路（startListening 之后）已经自动重组，这里留给
     * "配置可能被本窗口直接改过、但没走 store 写入"的非典型调用方。
     */
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
  // 三态合并交给 `mergeTouchBindings`：触摸壳的键盘准入（`systemKeys.ts`）读同一个函数，
  // 所以"设置页改了却没人读"这条老路（REQ-A1200）不可能再出现。
  const touch = mergeTouchBindings(TOUCH_DEFAULTS, config);

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
 *
 * 修饰键语义**与注册表同一本规则书**（`lib/shellModule.ts::shortcutMatches`），不是第二套：
 * 绑定写了 `meta` 即 ⌘，且除非同时写了 `ctrl`（显式的"我要物理 Ctrl 键"，此时 ⌃⌘ 两键皆需），
 * 一次 Ctrl 按下按 ⌘ 处理 —— 非 Apple 键盘因此够得到 ⌘W/⌘M/⌘H/⌘N。
 *
 * 这里原先是**自相矛盾**的：`meta` 那一行把 ctrlKey 折算进 meta，下一行的严格 `s.ctrl`
 * 比较又把它拒掉，于是每一条默认 Apple 绑定在用户按 Ctrl 时都不匹配 —— 壳里失效、
 * 浮层里（走 `shortcutMatches`）却认。`desktopKeys.ts` 声称两条路径同一套规则，这才是兑现。
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
  if (s.meta && s.ctrl) {
    // ⌃⌘ — **both** physical modifiers (REQ-A1568; the same row of
    // `shellModule.shortcutMatches`, which this copy must track: the whole point of writing
    // `ctrl` beside `meta` is to leave the ⌘ family, so accepting ⌘ alone would both miss
    // the user's ⌃ and steal the app's ⌘ chord).
    if (!e.metaKey || !e.ctrlKey) return false;
  } else if (s.meta) {
    // ⌘ required; a Ctrl press counts as ⌘ (non-Apple keyboards).
    if (!(e.metaKey || e.ctrlKey)) return false;
  } else if (s.ctrl) {
    // Pure Ctrl binding: the physical Ctrl key, and ⌘ must not be down.
    if (!e.ctrlKey || e.metaKey) return false;
  } else {
    // No modifier declared: a Meta or Ctrl press belongs to a more specific binding.
    if (e.metaKey || e.ctrlKey) return false;
  }
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
