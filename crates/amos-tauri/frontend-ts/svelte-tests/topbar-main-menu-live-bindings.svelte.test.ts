/**
 * topbar-main-menu-live-bindings.svelte.test.ts — 顶栏主菜单的快捷键提示必须在用户改键**之后**
 * 仍然与壳派发的那条弦一致（REQ-A1309, F-SH-583）。
 *
 * 缺陷（对 HEAD 核实）：REQ-A484 让这个菜单不再读默认表，而读**解析后的**绑定
 * （`keyboardBindings.bindings.system`）—— 但只在挂载那一刻读了一次：
 *
 *   1. 承载键帽的两个行数组（`fileRows` / `windowRows`）与 `GROUPS` 都是普通 `const` ——
 *      `shortcut: desktopShortcutLabel("new-window", keyboardBindings.bindings.system)` 在
 *      组件初始化时求值成字符串后就被冻住了；
 *   2. 该组件从不调 `keyboardBindings.startListening()`，所以底层 `bindings` 也不会变。
 *
 * 于是用户在「设置 ▸ 键盘」里把「新建窗口」从 ⌘N 改到 ⌥⌘N（该页写 `amos.keyboard.config`，
 * 走同源 localStorage 的 `storage` 事件到达启动器窗口 —— 与 `dock-prefs-cross-window` 建模的
 * 那条通路同一条），壳**当场**按 ⌥⌘N 派发，而这个菜单照旧印着 ⌘N：菜单广告了一条壳已经
 * 不再匹配的弦，正是这个文件自己的文档（REQ-A342 / REQ-A484）禁止的事。
 *
 * 为什么既有用例发现不了：`topbar-main-menu.svelte.test.ts` 与 `dock-context-menu-hints`
 * 都在**渲染之前**播种配置 —— 它们钉的是"挂载时读的是哪张表"，不是"挂载之后跟不跟着变"。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopShell from "../src/svelte/DesktopShell.svelte";

const CONFIG_KEY = "amos.keyboard.config";
const settle = () => new Promise((r) => setTimeout(r, 40));

const DESKTOP_SNAPSHOT = {
  screen_w: 1496,
  screen_h: 882,
  split: null,
  candidates: [],
  form: "desktop",
  columns: 4,
  multi_window: true,
  free_resize: true,
  divider_gap: 8,
};

function installHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      if (cmd === "wm_windows") return { windows: [] };
      return null;
    },
    listen: async () => () => {},
  };
}

/**
 * 另一扇 `WebviewWindow`（设置屏）写了这枚键。它留下的唯一通告就是 `storage` ——
 * 浏览器对**别的文档**写入时所派的那一个。
 */
function settingsWindowRebinds(newWindow: unknown): void {
  const json = JSON.stringify({
    version: 1,
    overlays: {},
    system: { newWindow },
    spaces: {},
    touch: {},
    updatedAt: 0,
  });
  window.localStorage.setItem(CONFIG_KEY, json);
  // A real cross-document write announces itself as a `StorageEvent` **carrying the key** — and
  // the keyboard hook filters on it (`e.key === KEYBOARD_CONFIG_KEY`), unlike the store's handler.
  window.dispatchEvent(new StorageEvent("storage", { key: CONFIG_KEY, newValue: json }));
}

async function openFileMenu(container: HTMLElement): Promise<HTMLElement> {
  await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="menu-file-trigger"]')!);
  await tick();
  return container.querySelector<HTMLElement>('[data-testid="menu-file-panel"]')!;
}

/**
 * The keycap span alone — not the row's whole text. `rowText(...).not.toContain("⌘N")` would be
 * **unfailable**: the rebind target ⌥⌘N contains ⌘N as a substring, so that assertion could never
 * redden on the very defect it names.
 */
const keycap = (panel: HTMLElement, id: string): string =>
  panel
    .querySelector<HTMLElement>(`[data-testid="menu-file-${id}"] [class*="text-white/45"]`)
    ?.textContent?.trim() ?? "";

describe("TopbarMainMenu — the hint follows a rebind made after mount (REQ-A1309)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("rebinding newWindow in the settings window moves the keycap in the file menu", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const file = await openFileMenu(container);
    expect(keycap(file, "file.new-window")).toBe("⌘N");

    settingsWindowRebinds({ key: "n", meta: true, alt: true });
    await tick();
    await settle();

    // 壳此刻按 ⌥⌘N 派发；菜单必须说同一条弦，而不是它挂载时那条。
    expect(keycap(file, "file.new-window")).toBe("⌥⌘N");
  });

  test("disabling newWindow leaves the file menu with no keycap on that row", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    const file = await openFileMenu(container);
    expect(keycap(file, "file.new-window")).toBe("⌘N");

    settingsWindowRebinds(null);
    await tick();
    await settle();

    // 「做不到就不假装」：这条绑定被禁用，菜单就不能再画它的键帽。
    expect(keycap(file, "file.new-window")).toBe("");
    // …而它旁边那条（未被动过）照旧画着，证明上面那条不是因为读空而通过。
    expect(keycap(file, "file.close")).toBe("⌘W");
  });
});
