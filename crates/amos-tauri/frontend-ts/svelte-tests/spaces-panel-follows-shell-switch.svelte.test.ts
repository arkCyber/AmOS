/**
 * spaces-panel-follows-shell-switch.svelte.test.ts — 打开着的 Spaces 面板必须在**别人**换了桌面
 * 之后跟着换（REQ-A1311, F-SH-585）。
 *
 * 缺陷（对 HEAD 核实）：面板的「当前桌面」是挂载时从 `spaces_active` 读来的**快照**
 * （`SpacesPanel.svelte:116  currentIndex = active ?? 0`），此后除了它自己那次 `loadSpaces()`
 * 再没有人更新它。可是默认绑定下，面板打开时按 ⌃←/⌃→ 真正跑的是**壳**那一份处理器 ——
 * `DesktopShell` 在 **capture** 阶段听同一个 `keydown` 并 `stopPropagation()`
 * （`KEY_LISTENER`），所以面板自己那条 bubble 监听器根本收不到（这正是 F-SH-582 记下的
 * 相位遮蔽）。于是：
 *
 *   壳按 ⌃→ 换了桌面 → 屏幕上的窗口真的换了 → 而面板的高亮、🖥️✨、以及那张「当前桌面」
 *   的牌子，全都还留在**上一个**桌面上。
 *
 * 面板于是对同一个事实给出与属主相反的说法（`project_page_did_not_subscribe_where_its_twins_did`
 * 那一族：属主改了事实，显示该事实的面从不被告知）。壳那条路径**每次**都重新
 * `activeSpace()`（`DesktopShell.svelte:647`），所以它自己不会错 —— 错的是它从不**通告**。
 *
 * 为什么既有用例发现不了：`spaces-panel-*.svelte.test.ts` 三份都**独立挂载面板**，切换由面板
 * 自己发起（`handleSwitch` → `applySwitch` 自己写 `currentIndex`）；`desktop-shell.svelte.test.ts`
 * 只断言"按 ⌃↑ 面板开没开"。没有一份建模「面板开着 + 换桌面的是壳」这条路径。
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

/**
 * The host's **live** active desktop. `spaces_switch` moves it, exactly as the real host does —
 * so the test can tell "the shell switched" apart from "the panel still draws the old one".
 */
let activeIndex = 0;

/**
 * When true, the host **stops answering** `spaces_active` (offline mid-session). A re-read that
 * gets `null` must leave the last authoritative value alone — the guard `syncActiveDesktop`'s
 * doc comment names. Flipped by the test that drives that leaf.
 */
let activeUnavailable = false;

function installHost(): void {
  activeIndex = 0;
  activeUnavailable = false;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "wm_layout_snapshot") return DESKTOP_SNAPSHOT;
      // **Two** app windows: Mission Control's open-guard
      // (`openRefusal` → `shouldShowMissionControl`, ≥ 2) refuses to open an empty overview, and
      // that guard is not what this file is testing.
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
        return { windows: [w(1, "files"), w(2, "notes")] };
      }
      if (cmd === "spaces_list") {
        return [
          { id: "space-0", name: "桌面 1", windows: [] },
          { id: "space-1", name: "桌面 2", windows: [] },
        ];
      }
      if (cmd === "spaces_active") return activeUnavailable ? null : activeIndex;
      if (cmd === "spaces_switch") {
        activeIndex = Number(args?.index);
        return { hide_failed: [], show_failed: [] };
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
  cards(c).filter((el) => el.textContent?.includes("当前桌面")).length;

/** Which desktop Mission Control's top bar marks as current, or `-1` when it marks none. */
const mcCurrent = (c: HTMLElement): number => {
  const bar = c.querySelector<HTMLElement>('[data-testid="mission-spaces"]');
  if (!bar) return -1;
  return [...bar.querySelectorAll<HTMLElement>("button")].findIndex(
    (el) => el.getAttribute("aria-current") === "true",
  );
};

describe("SpacesPanel — the open panel follows a desktop switch made by the shell (REQ-A1311)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("⌃→ handled by the shell moves the panel's highlight to the new desktop", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    fireEvent.keyDown(window, { key: "ArrowUp", ctrlKey: true });
    await tick();
    await settle();
    expect(cards(container)).toHaveLength(2);
    expect(highlighted(container)).toBe(0);
    expect(currentBadgeCount(container)).toBe(1);

    // The shell consumes this chord in capture phase; the panel never sees the event.
    fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true });
    await tick();
    await settle();

    // The shell really switched (otherwise the assertion below could pass by accident).
    expect(activeIndex).toBe(1);
    // …so the panel must say 1 too. At HEAD it still says 0: the panel advertises a desktop the
    // owner has already left.
    expect(highlighted(container)).toBe(1);
    expect(currentBadgeCount(container)).toBe(1);
  });

  test("⌃← handled by the shell wraps the panel's highlight to the last desktop", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    fireEvent.keyDown(window, { key: "ArrowUp", ctrlKey: true });
    await tick();
    await settle();
    expect(highlighted(container)).toBe(0);

    fireEvent.keyDown(window, { key: "ArrowLeft", ctrlKey: true });
    await tick();
    await settle();

    // Cyclic wrap: from 0 back to the last desktop. The panel must not keep pointing at 0.
    expect(activeIndex).toBe(1);
    expect(highlighted(container)).toBe(1);
  });

  test("Mission Control's space bar follows a switch the shell made (its twin surface)", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    fireEvent.keyDown(window, { key: "F3" });
    await tick();
    await settle();
    expect(container.querySelector('[data-testid="mission-control"]')).toBeTruthy();
    expect(mcCurrent(container)).toBe(0);

    fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true });
    await tick();
    await settle();

    expect(activeIndex).toBe(1);
    // Same defect family as the panel above, on the surface that draws the same fact.
    expect(mcCurrent(container)).toBe(1);
  });

  test("a re-read the host never answers leaves the last authoritative desktop alone", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    fireEvent.keyDown(window, { key: "ArrowUp", ctrlKey: true });
    await tick();
    await settle();
    expect(highlighted(container)).toBe(0);

    // The host goes away without the panel being told *which* desktop is now current. The
    // announcement is still delivered (some other owner switched) but the follow-up read comes
    // back `null` — "did not answer" is not "desktop 0", and it is certainly not "desktop null".
    activeUnavailable = true;
    window.dispatchEvent(new CustomEvent("spaces-changed"));
    await tick();
    await settle();

    // Still 0 — not -1 (which is what `currentIndex = null` would draw: no card matches).
    expect(highlighted(container)).toBe(0);
    expect(currentBadgeCount(container)).toBe(1);
  });

  test("an index the panel has no card for does not blank the highlight", async () => {
    installHost();
    const { container } = render(DesktopShell);
    await tick();
    await settle();

    fireEvent.keyDown(window, { key: "ArrowUp", ctrlKey: true });
    await tick();
    await settle();
    expect(highlighted(container)).toBe(0);

    // A desktop the panel does not have a card for (closed in another surface between the switch
    // and this read). Moving the highlight to it would leave *no* card current.
    activeIndex = 99;
    window.dispatchEvent(new CustomEvent("spaces-changed"));
    await tick();
    await settle();

    expect(highlighted(container)).toBe(0);
  });
});
