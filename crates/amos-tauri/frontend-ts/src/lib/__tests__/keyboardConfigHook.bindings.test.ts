/**
 * __tests__/keyboardConfigHook.bindings.test.ts — `keyboardConfigHook.svelte.ts` 的绑定解析（P2-1 覆盖）
 *
 * 为什么单独一个文件：这个模块有 203 行未覆盖（14.7%，全 `src/lib` 里最低）。原有的
 * `keyboardConfigHook.test.ts` 只测了 `matchesShortcut` 一条纯函数，而真正决定"用户改了快捷键
 * 到底生不生效"的是 `resolveBindings`：默认值 / 自定义 / **显式禁用（null）**三种合并，
 * 四个域（overlays/system/spaces/touch），以及 storage 变化时重组。
 *
 * 两个必须说清的边界：
 *
 * 1. **`$state` 是编译器宏**。`createKeyboardBindings()` 里 `let bindings = $state(...)` 在
 *    bun（没有 Svelte 编译器）里是一个裸标识符 ⇒ 会 `ReferenceError`。这里给它一个恒等桩，
 *    于是能跑通解析、刷新与监听逻辑 —— 验的是**逻辑**，不是 Svelte 的响应式（响应式由
 *    `svelte-tests/` 的编译期套件负责）。桩在 `afterAll` 还原。
 * 2. **不注册 happy-dom**（同 `enterprise-webhooks.test.ts`）：导入 happy-dom 会被判为 DOM
 *    文件、**不计入 P2-1**。`window` 只需要 `localStorage` + 一个事件总线，自己写得起。
 *    `pure` 批次是一个进程跑所有文件 ⇒ 桩只在**本文件**生命周期内存在。
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import {
  createKeyboardBindings,
  getGlobalBindings,
  getMergedOverlayBindings,
  findMatchingBinding,
  matchesShortcut,
  KEYBOARD_CONFIG_KEY,
  SYSTEM_DEFAULTS,
  SPACES_DEFAULTS,
  TOUCH_DEFAULTS,
} from "../keyboardConfigHook.svelte";
import { formatShortcut, modulesFor, type ShellShortcut } from "../shellModule";
import { mergeOverlayBindings, readKeyboardConfig } from "../keyboardConfig";
import { SHELL_MODULES } from "../../svelte/shellModules";

type Listener = (e: { type: string; key?: string }) => void;

const memory = new Map<string, string>();
const listeners = new Map<string, Set<Listener>>();

const windowStub = {
  localStorage: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => void memory.set(key, String(value)),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  },
  addEventListener: (type: string, l: Listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(l);
  },
  removeEventListener: (type: string, l: Listener) => {
    listeners.get(type)?.delete(l);
  },
  /** `amosStore.writeJson` 会 `new CustomEvent(...)`；bun 里没有那个构造器，异常被它自己吞掉。 */
  dispatchEvent: (e: { type: string; key?: string }) => {
    for (const l of listeners.get(e.type) ?? []) l(e);
    return true;
  },
};

const globals = globalThis as Record<string, unknown>;
const previousWindow = globals.window;
const previousState = globals.$state;

beforeAll(() => {
  globals.window = windowStub;
  // 见文件头第 1 点：恒等桩，替代编译器注入的 rune。
  globals.$state = (value: unknown) => value;
});

afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
  if (previousState === undefined) delete globals.$state;
  else globals.$state = previousState;
});

beforeEach(() => {
  memory.clear();
  listeners.clear();
});

afterEach(() => {
  memory.clear();
  listeners.clear();
});

/** 按模块自己的读法播种配置：`writeStoreValue` 只编码一层。 */
function writeConfig(cfg: {
  overlays?: Record<string, ShellShortcut[] | null>;
  system?: Record<string, ShellShortcut | null>;
  spaces?: Record<string, ShellShortcut | null>;
  touch?: Record<string, ShellShortcut | null>;
}): void {
  memory.set(
    KEYBOARD_CONFIG_KEY,
    JSON.stringify({
      version: 1,
      overlays: cfg.overlays ?? {},
      system: cfg.system ?? {},
      spaces: cfg.spaces ?? {},
      touch: cfg.touch ?? {},
      updatedAt: 0,
    }),
  );
}

/** `matchesShortcut` / `shortcutMatches` 只读这五个字段。 */
function key(
  k: string,
  mods: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">> = {},
): KeyboardEvent {
  return { key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods } as KeyboardEvent;
}

/** 浮层里**声明了** `shortcuts` 的行（注册表即清单）。 */
const OVERLAY_IDS_WITH_SHORTCUTS = ["launchpad", "spotlight", "mission-control"];

describe("createKeyboardBindings：默认值 / 自定义 / 显式禁用 三态合并", () => {
  test("无配置：四个域取系统默认，浮层只含声明了 shortcuts 的行", () => {
    const hook = createKeyboardBindings();
    const b = hook.bindings;

    expect([...b.system.keys()]).toEqual(Object.keys(SYSTEM_DEFAULTS));
    expect(b.system.get("closeWindow")).toEqual({ key: "W", meta: true });
    expect([...b.spaces.keys()]).toEqual(Object.keys(SPACES_DEFAULTS));
    expect([...b.touch.keys()]).toEqual(Object.keys(TOUCH_DEFAULTS));

    // 注册表里 launchpad / spotlight / mission-control 有绑定；control-center-panel 与
    // spaces-panel 没有（`if (!m.shortcuts) continue` 这一支）
    expect([...b.overlays.keys()]).toEqual(OVERLAY_IDS_WITH_SHORTCUTS);
    expect(b.overlays.get("launchpad")).toEqual([{ key: "F4" }]);
    expect(b.overlays.get("mission-control")).toEqual([{ key: "F3" }, { key: "Tab", meta: true }]);
  });

  test("自定义覆盖生效、null 表示禁用、未提及的项仍是默认", () => {
    writeConfig({
      overlays: { launchpad: [{ key: "F9" }], spotlight: null },
      system: { closeWindow: null, minimizeWindow: { key: "M", meta: true, shift: true } },
      spaces: { spacesPrev: null, spacesNext: { key: "ArrowRight", ctrl: true, alt: true } },
      touch: { back: null, dismiss: { key: "Escape", ctrl: true } },
    });
    const b = createKeyboardBindings().bindings;

    // overlays：launchpad 换成自定义、spotlight 被禁、mission-control 仍默认
    expect(b.overlays.get("launchpad")).toEqual([{ key: "F9" }]);
    expect(b.overlays.has("spotlight")).toBe(false);
    expect(b.overlays.get("mission-control")).toEqual([{ key: "F3" }, { key: "Tab", meta: true }]);

    // system：closeWindow 被禁，minimizeWindow 换成自定义，hideApp/preferences 默认
    expect(b.system.has("closeWindow")).toBe(false);
    expect(b.system.get("minimizeWindow")).toEqual({ key: "M", meta: true, shift: true });
    expect(b.system.get("hideApp")).toEqual(SYSTEM_DEFAULTS.hideApp);

    // spaces / touch 同理
    expect(b.spaces.has("spacesPrev")).toBe(false);
    expect(b.spaces.get("spacesNext")).toEqual({ key: "ArrowRight", ctrl: true, alt: true });
    expect(b.spaces.get("spacesPanel")).toEqual(SPACES_DEFAULTS.spacesPanel);
    expect(b.touch.has("back")).toBe(false);
    expect(b.touch.get("dismiss")).toEqual({ key: "Escape", ctrl: true });
  });

  test("浮层自定义为**空数组**：算作已绑定但没有提示（不是禁用）", () => {
    writeConfig({ overlays: { launchpad: [] } });
    const hook = createKeyboardBindings();

    expect(hook.bindings.overlays.get("launchpad")).toEqual([]);
    expect(hook.getOverlayShortcut("launchpad")).toBeNull();
  });
});

describe("createKeyboardBindings：提示字符串（formatShortcut 的入口）", () => {
  test("system / spaces / touch 的提示取当前绑定；未知 id 回 null", () => {
    const hook = createKeyboardBindings();

    expect(hook.getSystemShortcut("closeWindow")).toBe(formatShortcut(SYSTEM_DEFAULTS.closeWindow!));
    expect(hook.getSystemShortcut("nope")).toBeNull();
    expect(hook.getSpacesShortcut("spacesPrev")).toBe(formatShortcut(SPACES_DEFAULTS.spacesPrev!));
    expect(hook.getSpacesShortcut("nope")).toBeNull();
    expect(hook.getTouchShortcut("dismiss")).toBe(formatShortcut(TOUCH_DEFAULTS.dismiss!));
    expect(hook.getTouchShortcut("nope")).toBeNull();
  });

  test("浮层提示：多个绑定用 ' / ' 连接；无绑定/未知 id 回 null", () => {
    const hook = createKeyboardBindings();

    const expected = [{ key: "F3" }, { key: "Tab", meta: true }]
      .map((s) => formatShortcut(s))
      .join(" / ");
    expect(hook.getOverlayShortcut("mission-control")).toBe(expected);
    // 有行、无 shortcuts
    expect(hook.getOverlayShortcut("control-center-panel")).toBeNull();
    // 不存在的行
    expect(hook.getOverlayShortcut("nope")).toBeNull();
  });

  test("refresh() 之后提示与绑定一起更新（配置被同标签页改过）", () => {
    const hook = createKeyboardBindings();
    expect(hook.getSystemShortcut("closeWindow")).not.toBeNull();

    writeConfig({ system: { closeWindow: null } });
    hook.refresh();

    expect(hook.getSystemShortcut("closeWindow")).toBeNull();
    // 全局单例同步更新（供非 Svelte 上下文读）
    expect(getGlobalBindings().system.has("closeWindow")).toBe(false);
  });
});

describe("createKeyboardBindings：storage 监听是「改了就生效」的唯一通路", () => {
  test("startListening 后：本键的 storage 事件触发重组", () => {
    const hook = createKeyboardBindings();
    hook.startListening();
    expect(hook.getSystemShortcut("closeWindow")).not.toBeNull();

    writeConfig({ system: { closeWindow: null } });
    windowStub.dispatchEvent({ type: "storage", key: KEYBOARD_CONFIG_KEY });

    expect(hook.getSystemShortcut("closeWindow")).toBeNull();
  });

  test("其他键的 storage 事件不触发重组", () => {
    const hook = createKeyboardBindings();
    hook.startListening();

    writeConfig({ system: { closeWindow: null } });
    windowStub.dispatchEvent({ type: "storage", key: "amos.something.else" });

    expect(hook.getSystemShortcut("closeWindow")).not.toBeNull();
  });

  test("stopListening 之后事件不再生效（监听真的摘掉了）", () => {
    const hook = createKeyboardBindings();
    hook.startListening();
    hook.stopListening();

    writeConfig({ system: { closeWindow: null } });
    windowStub.dispatchEvent({ type: "storage", key: KEYBOARD_CONFIG_KEY });

    expect(hook.getSystemShortcut("closeWindow")).not.toBeNull();
  });
});

describe("全局单例", () => {
  test("getGlobalBindings 第一次计算后缓存同一对象；getMergedOverlayBindings 就是它的 overlays", () => {
    const first = getGlobalBindings();
    const second = getGlobalBindings();
    expect(second).toBe(first);
    expect(getMergedOverlayBindings()).toBe(first.overlays);
    expect([...getMergedOverlayBindings().keys()]).toEqual(OVERLAY_IDS_WITH_SHORTCUTS);
  });
});


describe("findMatchingBinding：未列出修饰符的绑定必须能被匹配", () => {
  /**
   * 这组用例的**负控价值**：这函数原来自己写 `if (s.shift !== e.shiftKey) continue`
   * （`shift`/`alt` 可选、默认绑定一个都没写）⇒ `undefined !== false` 恒真 ⇒ 对下面
   * 每一个默认形状都回 `null`。判据委托给 `shellModule.shortcutMatches` 之后才成立。
   */
  function bindings() {
    return new Map<string, ShellShortcut[]>([
      ["launchpad", [{ key: "F4" }]],
      ["spotlight", [{ key: "Space", meta: true }]],
      ["mission-control", [{ key: "F3" }, { key: "Tab", meta: true }]],
    ]);
  }

  test("无修饰的 F4 命中 launchpad（旧实现恒 null 的那条）", () => {
    expect(findMatchingBinding(bindings(), key("F4"))?.id).toBe("launchpad");
  });

  test("单字符字母大小写归一；功能键按原样比较（真实事件给的就是 \"F4\"）", () => {
    const single = new Map<string, ShellShortcut[]>([["close", [{ key: "w", meta: true }]]]);
    expect(findMatchingBinding(single, key("W", { metaKey: true }))?.id).toBe("close");
    expect(findMatchingBinding(single, key("w", { metaKey: true }))?.id).toBe("close");
    // 功能键长度 >1，`normalizeKey` 不动它 —— 而浏览器给的就是大写 "F4"，所以这是对的。
    // 把 "f4" 也归一成 "F4" 反而会与"命名键原样比较"（ArrowLeft ≠ arrowleft）自相矛盾。
    expect(findMatchingBinding(bindings(), key("F4"))?.id).toBe("launchpad");
    expect(findMatchingBinding(bindings(), key("f4"))).toBeNull();
  });

  test("⌘Space：metaKey 与 ctrlKey（外部键盘）都算 ⌘", () => {
    expect(findMatchingBinding(bindings(), key(" ", { metaKey: true }))?.id).toBe("spotlight");
    expect(findMatchingBinding(bindings(), key(" ", { ctrlKey: true }))?.id).toBe("spotlight");
  });

  test("严格：未修改的 F4 不被 ⇧F4 触发；⌘M 不命中任何绑定", () => {
    expect(findMatchingBinding(bindings(), key("F4", { shiftKey: true }))).toBeNull();
    expect(findMatchingBinding(bindings(), key("m", { metaKey: true }))).toBeNull();
  });

  test("同一 id 的第二个绑定也能命中（mission-control 有两个入口）", () => {
    expect(findMatchingBinding(bindings(), key("Tab", { metaKey: true }))?.id).toBe("mission-control");
    expect(findMatchingBinding(bindings(), key("F3"))?.id).toBe("mission-control");
  });

  test("返回的是那一行的完整 binding 列表（不是单个）", () => {
    const hit = findMatchingBinding(bindings(), key("F3"));
    expect(hit?.shortcuts).toEqual([{ key: "F3" }, { key: "Tab", meta: true }]);
  });

  test("先声明的先命中（Map 顺序即声明顺序）", () => {
    const two = new Map<string, ShellShortcut[]>([
      ["first", [{ key: "F5" }]],
      ["second", [{ key: "F5" }]],
    ]);
    expect(findMatchingBinding(two, key("F5"))?.id).toBe("first");
  });

  test("空表回 null", () => {
    expect(findMatchingBinding(new Map(), key("F4"))).toBeNull();
  });
});

describe("matchesShortcut：空格归一与修饰符严格性", () => {
  test('"Spacebar" 事件命中声明为 " " 的绑定（两个方向都归一）', () => {
    expect(matchesShortcut({ key: " " }, key("Spacebar"))).toBe(true);
    expect(matchesShortcut({ key: "Spacebar" }, key(" "))).toBe(true);
  });

  test("单字符大小写不敏感；命名键保持原样", () => {
    expect(matchesShortcut({ key: "w" }, key("W"))).toBe(true);
    expect(matchesShortcut({ key: "ArrowLeft" }, key("ArrowLeft"))).toBe(true);
    expect(matchesShortcut({ key: "ArrowLeft" }, key("arrowleft"))).toBe(false);
  });

  test("shift / alt 是严格的：绑定没写就要求事件也没有", () => {
    expect(matchesShortcut({ key: "a" }, key("a", { shiftKey: true }))).toBe(false);
    expect(matchesShortcut({ key: "a", shift: true }, key("a", { shiftKey: true }))).toBe(true);
    expect(matchesShortcut({ key: "a", alt: true }, key("a"))).toBe(false);
    expect(matchesShortcut({ key: "a", alt: true }, key("a", { altKey: true }))).toBe(true);
  });
});


describe("浮层合并只有一本规则书（hook 与 keyboardConfig.mergeOverlayBindings 同源）", () => {
  test("hook 的 bindings.overlays 与共用函数的输出逐条一致（覆盖 + 禁用都在内）", () => {
    writeConfig({ overlays: { launchpad: [{ key: "F9" }], spotlight: null } });
    const hook = createKeyboardBindings();
    const shared = mergeOverlayBindings(modulesFor("overlay", SHELL_MODULES), readKeyboardConfig());

    // 逐条相等：一旦有人在本文件里再抄一份三态合并，这条会红。
    expect([...hook.bindings.overlays.entries()]).toEqual([...shared.entries()]);
    expect([...shared.keys()]).toEqual(OVERLAY_IDS_WITH_SHORTCUTS.filter((id) => id !== "spotlight"));
    // 覆盖与禁用各就各位
    expect(shared.get("launchpad")).toEqual([{ key: "F9" }]);
    expect(shared.has("spotlight")).toBe(false);
    expect(shared.get("mission-control")).toEqual([{ key: "F3" }, { key: "Tab", meta: true }]);
  });
});

