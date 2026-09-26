/**
 * desktop-stage-settings-page.svelte.test.ts — 桌面右键菜单的两行「去设置」必须**落在它们
 * 命名的那一页**上（REQ-A1810 / FMEA F-SH-898）。
 *
 * `DesktopStage.svelte::showContextMenu` 的 base 行里有两行说要去设置：
 *
 *     { id: "change-wallpaper",  label: t("desktop.ctxChangeWallpaper"),  run: openSettings },
 *     { id: "display-settings",  label: t("desktop.ctxDisplaySettings"),  run: openSettings },
 *
 * 而 `openSettings` 逐字只有一句 `wmOpenWithDiag("settings")` —— 它打开设置应用，但落在**索引页**。
 * 用户点的是「更改壁纸…」，拿到的是一张列表；应用确实开了，只是不在他要的地方，而且没有一个字
 * 说明（`appLinks.openSettingsAt` 的文档把这一条写成"不许静默"：*"the app opened but not where
 * they asked to be — and that must not pass silently"*）。
 *
 * 这不是新形状，是同一条意图的**另一个入口**早就修好的那一半：Dock 的全局右键菜单
 * 「程序坞偏好设置…」（`handleOpenPreferences`，REQ-A790）走的是"**先写目的页 → 再开窗口**"
 * 两步，并且把写不进去的裁决说出来（`dock-open-preferences.svelte.test.ts` 两向都钉）。更刺眼的是
 * `Dock.svelte` 那一处的注释**逐字引用了桌面这一行**——*"exactly like the desktop stage's
 * 「显示设置」 row"* —— 却只有 Dock 那一半真的落到了目的页。
 *
 * 三件事读这行的人会假设，本文件逐条钉：
 *   1. 它**打开设置窗口**（`wm_open("settings")`），不是换成触屏壳的 surface（REQ-A415 之前
 *      Dock 那一行的死法）；
 *   2. 它落在**命名的那一页**上 —— 即目的页在开窗**之前**就已在 store 里（`wm_open` 是
 *      create-or-focus：第一次点击时还没有窗口可以接收广播，只会在挂载时从 store 里读）；
 *   3. 目的页写不进去时**说出来**，并且**不**开一张索引页让用户以为那就是他要的那页。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import DesktopShell from "../src/svelte/DesktopShell.svelte";
import { LAYOUT_KEY, readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { SETTINGS_PAGE_KEY } from "../src/lib/settingsPages";
import { setLocale } from "../src/svelte/locale.svelte";
import { zh } from "../src/i18n/locales/zh";

const DESKTOP_SNAPSHOT = {
  screen_w: 1600,
  screen_h: 900,
  split: null,
  candidates: [],
  form: "desktop",
  columns: 4,
  multi_window: true,
  free_resize: true,
  divider_gap: 8,
};

/**
 * The minimal host the desktop shell needs, plus a record of what the store held at the instant
 * `wm_open("settings")` was invoked — the only honest way to test the write-then-open order from
 * outside. Checking the store *after* the click cannot tell "written first" from "written after",
 * and only the former works on a first click.
 */
function installHost() {
  const calls: { cmd: string; args: unknown }[] = [];
  const atOpen: unknown[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      if (cmd === "wm_windows") return { windows: [] };
      if (cmd === "desktop_features_disabled") return [];
      if (cmd === "wm_open") {
        if ((args as { label?: string })?.label === "settings") {
          atOpen.push(readStoreValue(SETTINGS_PAGE_KEY, null));
        }
        // `lib/wm.ts` reports success as `result !== null`, so a fake host must answer window
        // mutations with an object — `null` reads as a refusal (REQ-A415).
        return { windows: [] };
      }
      return null;
    },
    listen: async () => () => {},
  };
  return { calls, atOpen };
}

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 40));
  await tick();
};

/** Swap in a storage whose writes of `key` throw, as a full quota does. */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}

/** Right-click the desktop's empty stage and press `testId`. */
async function clickStageRow(testId: string, failWrites = false) {
  writeStoreValue(LAYOUT_KEY, { page: ["notes", "files"], dock: [], hidden: [] });
  const { calls, atOpen } = installHost();
  const restore = failWrites ? failWritesFor(SETTINGS_PAGE_KEY) : () => {};
  try {
    const h = render(DesktopShell);
    await settle();
    // The stage's root `oncontextmenu` fires for a right-click on the backdrop; the icon grid is
    // part of that backdrop (icons stop propagation in their own handler, the grid does not).
    const grid = h.container.querySelector<HTMLElement>('[data-testid="desktop-icon-grid"]');
    const backdrop = grid ?? h.container;
    await fireEvent.contextMenu(backdrop, { clientX: 200, clientY: 200 });
    await tick();
    const row = h.container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    expect(row, `the desktop background menu must have a ${testId} row`).toBeTruthy();
    await fireEvent.click(row);
    await settle();
    return { container: h.container, calls, atOpen };
  } finally {
    restore();
  }
}

beforeEach(() => {
  window.localStorage.clear();
  setLocale("zh");
});
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  window.localStorage.clear();
  setLocale("zh");
});

describe("DesktopStage — 「更改壁纸…」/「显示设置」 opens the Settings window ON the page it names (REQ-A1810)", () => {
  test("「更改壁纸…」 opens the Settings WINDOW — the host gets `wm_open('settings')`", async () => {
    const { calls } = await clickStageRow("ctx-change-wallpaper");
    const opened = calls.filter((c) => c.cmd === "wm_open").map((c) => (c.args as { label?: string }).label);
    expect(opened).toContain("settings");
  });

  test("「更改壁纸…」 records the WALLPAPER page BEFORE opening", async () => {
    const { atOpen } = await clickStageRow("ctx-change-wallpaper");
    expect(atOpen).toEqual([{ page: "wallpaper", nonce: expect.any(Number) }]);
  });

  test("「显示设置」records the DISPLAY page BEFORE opening", async () => {
    const { atOpen } = await clickStageRow("ctx-display-settings");
    expect(atOpen).toEqual([{ page: "display", nonce: expect.any(Number) }]);
  });

  test("a refused write is REPORTED and no window is opened onto the wrong page", async () => {
    const { container, calls } = await clickStageRow("ctx-change-wallpaper", true);
    expect(container.querySelector('[data-testid="store-write-error"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="store-write-error"]')!.textContent).toContain(
      zh["common.storeWriteFailed"],
    );
    expect(calls.filter((c) => c.cmd === "wm_open")).toEqual([]);
    expect(readStoreValue(SETTINGS_PAGE_KEY, null)).toBeNull();
  });
});
