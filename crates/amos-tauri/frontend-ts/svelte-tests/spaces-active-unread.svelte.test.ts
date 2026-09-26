/**
 * spaces-active-unread.svelte.test.ts — 宿主拒答「哪个桌面是当前的」时，两个显示面都**不得编
 * 一个桌面出来**（REQ-A1558 ∕ FMEA F-SH-792）。
 *
 * `activeSpace()` 声明 `Promise<number | null>`；`null` 意为「宿主没有回答」—— `invoke` 从不
 * reject、失败解析为 `null`（REQ-A296）。修前两个**首读**把它折成 0：
 *
 *   - `SpacesPanel.svelte::loadSpaces` 逐字 `currentIndex = active ?? 0;`
 *   - `MissionControl.svelte::refreshSpaces` 逐字 `currentSpaceIndex = active ?? 0;`
 *
 * 于是宿主拒答时，Spaces 面板的第 0 张卡片带上 🖥️✨、「当前桌面」牌子与蓝色高亮，Mission
 * Control 顶部 Spaces 栏给第 0 个芯片挂上 `aria-current="true"` —— 一个没有任何人建立过的
 * 事实。更糟的是面板的归档路径：`handleAssignWindow` 收尾 `await applySwitch(currentIndex)`，
 * 用这个假的 0 **真的**调 `spaces_switch(0)` —— 用户只是把一个窗口归档，桌面却被切到了 0。
 *
 * 判据（同一读数的另外三处读者都拒绝折）：
 *   - `SpacesPanel::syncActiveDesktop` 逐字 `if (active === null || active === currentIndex) return;`
 *   - `MissionControl::syncActiveDesktop` 逐字 `if (active === null || active === currentSpaceIndex) return;`
 *   - `DesktopShell` 逐字 `if (!spaces || current === null) return;`
 * 只有**首读**折了 —— 且这两个假索引在 F-SH-581 ∕ F-SH-582 ∕ F-SH-585 的「如实边界」里被
 * 逐字登记为**另案**（"未一并处理 MissionControl ∕ SpacesPanel 的 `active ?? 0` 假索引"）。
 *
 * 与 `syncActiveDesktop` 的区别是故意的：那一条是**已知值的一次刷新**，宿主不回答时保持上一次
 * 的权威值（`spaces-panel-follows-shell-switch` 的末例钉着它）；本文件管的是**从来没有过权威
 * 值**的首读 —— 那里没有"上一次"可保持，只有"不知道"。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import SpacesPanel from "../src/svelte/SpacesPanel.svelte";
import MissionControl from "../src/svelte/MissionControl.svelte";
import { zh } from "../src/i18n/locales/zh";

/** The host's answer to `spaces_active`: a number, or `null` = 「没有回答」. */
let activeIndex: number | null = 0;
/** Every `spaces_switch` the host was asked to perform (its `index` argument). */
let switchCalls: number[] = [];
/** How many times a window was actually filed — proves the assign chain really ran. */
let moveCalls = 0;

function installHost(): void {
  activeIndex = 0;
  switchCalls = [];
  moveCalls = 0;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "spaces_list") {
        return [
          { id: "space-0", name: "桌面 1", windows: [] },
          { id: "space-1", name: "桌面 2", windows: [] },
        ];
      }
      // `null` here is the whole point: the host answered the *list*, so the panel has cards
      // to draw — but it did not answer *which* of them is active.
      if (cmd === "spaces_active") return activeIndex;
      if (cmd === "wm_windows") {
        const w = (id: number, label: string) => ({
          id,
          label,
          app: label,
          instance: 1,
          kind: "App",
          state: "Shown",
          focused: false,
        });
        // Two windows: Mission Control's open-guard wants ≥ 2, and SpacesPanel needs one
        // fileable window to drive the assign flow.
        return { windows: [w(1, "files"), w(2, "notes")] };
      }
      if (cmd === "spaces_move_window" || cmd === "spaces_unfile_window") {
        moveCalls++;
        return null;
      }
      if (cmd === "spaces_switch") {
        switchCalls.push(Number(args?.index));
        return { index: Number(args?.index), hide_failed: [], show_failed: [] };
      }
      return null;
    },
    listen: async () => () => {},
  };
}

const cards = (c: HTMLElement): HTMLElement[] => [
  ...c.querySelectorAll<HTMLElement>(".space-card"),
];

/** Which card the panel draws as **current**, or `-1` when it draws none. */
const highlighted = (c: HTMLElement): number =>
  cards(c).findIndex((el) => el.className.includes("border-blue-600"));

const currentBadgeCount = (c: HTMLElement): number =>
  cards(c).filter((el) => el.textContent?.includes(zh["spaces.currentDesktop"])).length;

/** Which desktop Mission Control's top bar marks as current, or `-1` when it marks none. */
const mcCurrent = (c: HTMLElement): number => {
  const bar = c.querySelector<HTMLElement>('[data-testid="mission-spaces"]');
  if (!bar) return -1;
  return [...bar.querySelectorAll<HTMLElement>("button")].findIndex(
    (el) => el.getAttribute("aria-current") === "true",
  );
};

const windowSelect = (c: HTMLElement): HTMLSelectElement | null =>
  c.querySelector('section[aria-labelledby="spaces-windows-heading"] select');

describe("REQ-A1558 — a refused `spaces_active` marks no desktop current (both surfaces)", () => {
  beforeEach(() => {
    localStorage.clear();
    installHost();
  });
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    document.body.innerHTML = "";
  });

  test("SpacesPanel: 宿主拒答 ⇒ 没有任何卡片被标成当前，并如实说明", async () => {
    activeIndex = null; // the host did not answer which desktop is current
    const { container } = render(SpacesPanel);

    await waitFor(() => expect(cards(container)).toHaveLength(2));

    // 修前这里逐字是 0 —— 第 0 张卡带着 🖥️✨ 与「当前桌面」牌子，那是编的。
    expect(highlighted(container)).toBe(-1);
    expect(currentBadgeCount(container)).toBe(0);
    // 不编，也不沉默：用户看得见为什么没有卡片被标成当前。
    expect(
      container.querySelector('[data-testid="spaces-active-unread"]')?.textContent ?? "",
    ).toContain(zh["spaces.activeUnavailable"]);
  });

  test("SpacesPanel 正控：宿主答了 0 ⇒ 第 0 张卡被标成当前，且没有那句说明", async () => {
    activeIndex = 0;
    const { container } = render(SpacesPanel);

    await waitFor(() => expect(cards(container)).toHaveLength(2));

    expect(highlighted(container)).toBe(0);
    expect(currentBadgeCount(container)).toBe(1);
    expect(container.querySelector('[data-testid="spaces-active-unread"]')).toBeNull();
  });

  test("SpacesPanel: 归档一个窗口不会用假的 0 去**真的**切换桌面", async () => {
    activeIndex = null;
    const { container } = render(SpacesPanel);
    await waitFor(() => expect(windowSelect(container)).toBeTruthy());

    await fireEvent.change(windowSelect(container)!, { target: { value: "space-1" } });
    // 先证明归档那一步**真的跑了**（否则下面那条空断言是恒真的）：
    await waitFor(() => expect(moveCalls).toBe(1));
    // 再给收尾的 `loadSpaces → applySwitch` 一点时间 —— 修前它会用假的 0 调 `spaces_switch(0)`。
    await new Promise((r) => setTimeout(r, 60));
    expect(switchCalls).toEqual([]);
  });

  test("SpacesPanel 正控:归档一个窗口在宿主答了 0 时照旧重放切换", async () => {
    activeIndex = 0;
    const { container } = render(SpacesPanel);
    await waitFor(() => expect(windowSelect(container)).toBeTruthy());

    await fireEvent.change(windowSelect(container)!, { target: { value: "space-1" } });
    await waitFor(() => expect(switchCalls).toEqual([0]));
  });

  test("MissionControl: 宿主拒答 ⇒ 没有芯片挂着 aria-current（它的姊妹面）", async () => {
    activeIndex = null;
    const { container } = render(MissionControl, { props: { onclose: () => {} } });

    await waitFor(() => expect(container.querySelector('[data-testid="mission-spaces"]')).toBeTruthy());
    // 修前这里逐字是 0 —— 第 0 个芯片替宿主说了「我是当前的」。
    expect(mcCurrent(container)).toBe(-1);
  });

  test("MissionControl 正控：宿主答了 1 ⇒ 第 1 个芯片挂 aria-current", async () => {
    activeIndex = 1;
    const { container } = render(MissionControl, { props: { onclose: () => {} } });

    await waitFor(() => expect(container.querySelector('[data-testid="mission-spaces"]')).toBeTruthy());
    expect(mcCurrent(container)).toBe(1);
  });
});
