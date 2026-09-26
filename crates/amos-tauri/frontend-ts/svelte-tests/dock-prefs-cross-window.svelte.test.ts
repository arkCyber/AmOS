/**
 * dock-prefs-cross-window.svelte.test.ts — 在「设置」里改 Dock 偏好，已经挂着的 Dock 必须跟着动（REQ-A1281）。
 *
 * 「Dock」设置页把名下的四枚控件都写进 `dock.prefs.v1`，并在页脚逐字承诺
 * **「更改将立即生效」**。可它和 Dock **不在同一个文档里**：`settingsPages.ts` 开篇就写明
 * 「Dock 跑在启动器的 `WebviewWindow`，设置屏跑在自己的」——所以那次写入要走
 * **跨窗口**那半条通路（同源 localStorage 的 `storage` 事件，以及宿主把
 * `store-updated` 推给每个窗口；`svelte/store.ts::createStoreValue` 正是把两条都接上
 * 的那枚原语）才能到达 Dock。
 *
 * 而 Dock 读了**一次**就不再回看：`onMount` 里 `readStoreValue(DOCK_PREFS_KEY)` 存进
 * `$state`，没有任何订阅。于是用户在设置里把 Dock 从「底部」改成「左侧」，屏幕上那只
 * Dock 纹丝不动 —— 直到启动器窗口重新加载。同一份文件里另外三枚键（`HomeLayout`、
 * `NOTIF_KEY`、`SETTINGS_KEY`）**都**用了 `createStoreValue`，只有这枚偏好键落在外面
 * （REQ-A1238 / F-SH-518 是同一族的另一个面：页面在该订阅的地方没有订阅）。
 *
 * 这个文件把「写者来自**另一扇窗口**」如实建模：写 localStorage 再派一个 `storage`
 * 事件，正是浏览器对别的文档写入时唯一的通告。同窗口的 `writeStoreValue` 走
 * `STORE_CHANGED_EVENT`，那是 Dock 自己右键菜单的路径（它本来就就地改了 `prefs`），
 * 不是这条缺陷。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import Dock from "../src/svelte/Dock.svelte";
import DockPage from "../src/svelte/settings/DockPage.svelte";
import { LAYOUT_KEY, readStoreValue, writeStoreValue, type HomeLayout } from "../src/lib/amosStore";
import { DOCK_PREFS_KEY, DEFAULT_DOCK_PREFS, type DockPrefs } from "../src/lib/dockPrefs";

const SEEDED: HomeLayout = { page: [], dock: ["clock", "notes", "files"], hidden: [] };
const settle = () => new Promise((r) => setTimeout(r, 20));

function installHost(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async () => null,
    listen: async () => () => {},
  };
}

/**
 * 另一扇 `WebviewWindow` 写了这枚键 —— 设置窗就是那个写者。它只留下一个 `storage`
 * 事件；一个订阅了这枚键的组件（`createStoreValue`）会因此重读，一个只在挂载时读过
 * 一次的组件不会。
 */
const settingsWindowWritesPrefs = (over: Partial<DockPrefs>): void => {
  window.localStorage.setItem(
    DOCK_PREFS_KEY,
    JSON.stringify({ ...DEFAULT_DOCK_PREFS, ...over }),
  );
  window.dispatchEvent(new Event("storage"));
};

const wrapper = (c: HTMLElement) => c.querySelector<HTMLElement>('[role="toolbar"]')!;
const panel = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-testid="dock-panel"]')!;

beforeEach(() => {
  window.localStorage.clear();
  installHost();
  writeStoreValue(LAYOUT_KEY, SEEDED);
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("Dock.svelte — 设置窗口改了 dock.prefs.v1，Dock 必须立即跟随（REQ-A1281）", () => {
  test("位置：底 → 左，Dock 的方向与朝向当场改变", async () => {
    window.localStorage.setItem(
      DOCK_PREFS_KEY,
      JSON.stringify({ ...DEFAULT_DOCK_PREFS, position: "bottom" }),
    );
    const { container } = render(Dock);
    await tick();
    await settle();
    expect(wrapper(container).getAttribute("aria-orientation")).toBe("horizontal");
    expect(panel(container).classList.contains("flex-col")).toBe(false);

    settingsWindowWritesPrefs({ position: "left" });
    await tick();
    await settle();

    // 「更改将立即生效」——这句话在设置页上写着，就必须在 Dock 上成立。
    expect(wrapper(container).getAttribute("aria-orientation")).toBe("vertical");
    expect(panel(container).classList.contains("flex-col")).toBe(true);
  });

  test("自动隐藏：关 → 开，Dock 当场收起", async () => {
    const { container } = render(Dock);
    await tick();
    await settle();
    expect(panel(container).style.transform).toBe("translate(0, 0)");

    settingsWindowWritesPrefs({ autoHide: true });
    await tick();
    await settle();

    expect(panel(container).style.transform).toBe("translateY(100%)");
  });

  test("图标尺寸：32 → 64，面板读到的就是新尺寸", async () => {
    const { container } = render(Dock);
    await tick();
    await settle();
    expect(panel(container).style.getPropertyValue("--dock-icon-size")).toBe("48px");

    settingsWindowWritesPrefs({ iconSize: 64 });
    await tick();
    await settle();

    expect(panel(container).style.getPropertyValue("--dock-icon-size")).toBe("64px");
  });
});

describe("DockPage.svelte — Dock 窗口改了同一枚键，设置页也必须跟随（REQ-A1281）", () => {
  test("控件跟随新读数，且不会拿着陈旧的值把另一项覆盖回去", async () => {
    const { container } = render(DockPage);
    await tick();
    await settle();

    const positionButtons = () =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button')];

    // Dock 窗口（启动器）改了**两项**：位置 → 左，图标 → 64。
    settingsWindowWritesPrefs({ position: "left", iconSize: 64 });
    await tick();
    await settle();

    // 页上的控件当场显示新读数（而不是挂载时那份）。
    expect(positionButtons().map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
    ]);

    // 用户接着点「右侧」：写出去的整个对象必须站在**当前**读数上。从陈旧快照出发的那半
    // 会把刚在 Dock 里调好的 64 退回默认的 48 —— 用户没碰过的控件被另一次操作悄悄改掉。
    await fireEvent.click(positionButtons()[2]);
    await settle();
    const stored = readStoreValue<DockPrefs>(DOCK_PREFS_KEY, { ...DEFAULT_DOCK_PREFS });
    expect(stored.position).toBe("right");
    expect(stored.iconSize).toBe(64);
  });
});
