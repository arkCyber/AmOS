/**
 * spaces-panel-keys.svelte.test.ts — 面板自己的上一个/下一个桌面键必须读**实时绑定**，
 * 与它画出来的图例、与桌面壳的判据同一份（REQ-A1308, F-SH-582）。
 *
 * 缺陷（对 HEAD 核实）：`SpacesPanel::handleKeyDown` 写死了 `e.ctrlKey && e.key === "ArrowLeft"`，
 * 而同一文件里画图例的 `hintPrev` / `hintNext` 读的是 `createKeyboardBindings()`（REQ-A553
 * 正是为这件事改的）。同一件事实两个来源，于是：
 *
 *   • 用户在设置里**禁用** `spacesPrev`：图例如实不再画 `<kbd>`（"做不到就不假装"），
 *     面板里按 ⌃← 却照样切桌面；
 *   • 用户把 `spacesPrev` 改绑到 ⌥←：图例印着 ⌥←，按 ⌃← 也仍然切。
 *
 * 为什么线上的默认绑定遮不住它：桌面壳在 **capture** 阶段听同一个 `keydown`
 * （`DesktopShell` 的 `KEY_LISTENER`），默认绑定命中时会 `stopPropagation()`，面板的
 * bubble 监听器根本收不到；面板的写死判据**恰恰只在壳没有消费时**被跑到 —— 也就是
 * 它唯一能生效的场合，正是它最不该生效的场合（键被禁用或被改绑）。
 *
 * 本用例独立渲染面板（壳不在场），走真实入口：往 window 派发 keydown，断言宿主收到了
 * 什么。三条：默认键仍然工作（证明处理函数是活的，不是被删掉）、禁用后完全不动、
 * 改绑后只有新弦动作。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import SpacesPanel from "../src/svelte/SpacesPanel.svelte";
import * as backend from "../src/lib/backend";

vi.mock("../src/lib/backend");

const CONFIG_KEY = "amos.keyboard.config";

const SPACES = [
  { id: "space-0", name: "桌面 1", windows: [] },
  { id: "space-1", name: "桌面 2", windows: [] },
];

function seedSpaces(spaces: Record<string, unknown>): void {
  localStorage.setItem(
    CONFIG_KEY,
    JSON.stringify({ version: 1, overlays: {}, system: {}, spaces, touch: {}, updatedAt: 0 }),
  );
}

/** Every bridge read the panel makes, with a switch that always accepts. */
function mockBridge(): void {
  vi.mocked(backend.invoke).mockImplementation((async (cmd: string) => {
    switch (cmd) {
      case "spaces_list":
        return SPACES;
      case "spaces_active":
        return 0;
      case "wm_windows":
        return { windows: [] };
      case "spaces_switch":
        return { index: 1, hide_failed: [], show_failed: [] };
      default:
        return null;
    }
  }) as never);
}

const switchedTo = (container: HTMLElement): number =>
  [...container.querySelectorAll<HTMLElement>(".space-card")].findIndex((c) =>
    c.className.includes("border-blue-600"),
  );

describe("SpacesPanel — the arrow chords follow the user's binding (REQ-A1308)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  test("the default chord still steps to the previous desktop", async () => {
    mockBridge();
    const { container } = render(SpacesPanel);
    await waitFor(() => expect(switchedTo(container)).toBe(0));

    await fireEvent.keyDown(window, { key: "ArrowLeft", ctrlKey: true });

    // prevSpaceIndex(0, 2) wraps to 1
    await waitFor(() => expect(switchedTo(container)).toBe(1));
  });

  test("a disabled chord is inert inside the panel (the legend already says nothing)", async () => {
    seedSpaces({ spacesPrev: null });
    mockBridge();
    const { container } = render(SpacesPanel);
    await waitFor(() => expect(switchedTo(container)).toBe(0));

    await fireEvent.keyDown(window, { key: "ArrowLeft", ctrlKey: true });

    expect(switchedTo(container)).toBe(0);
    expect(backend.invoke).not.toHaveBeenCalledWith("spaces_switch", expect.anything());
  });

  test("a rebound chord steps on the new key, not on the old literal", async () => {
    seedSpaces({ spacesPrev: { key: "ArrowLeft", ctrl: true, alt: true } });
    mockBridge();
    const { container } = render(SpacesPanel);
    await waitFor(() => expect(switchedTo(container)).toBe(0));

    // the old literal no longer belongs to anyone
    await fireEvent.keyDown(window, { key: "ArrowLeft", ctrlKey: true });
    expect(switchedTo(container)).toBe(0);

    // the chord the user actually configured does
    await fireEvent.keyDown(window, { key: "ArrowLeft", ctrlKey: true, altKey: true });
    await waitFor(() => expect(switchedTo(container)).toBe(1));
  });

  test("a disabled next chord is inert inside the panel", async () => {
    seedSpaces({ spacesNext: null });
    mockBridge();
    const { container } = render(SpacesPanel);
    await waitFor(() => expect(switchedTo(container)).toBe(0));

    await fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true });

    expect(switchedTo(container)).toBe(0);
    expect(backend.invoke).not.toHaveBeenCalledWith("spaces_switch", expect.anything());
  });

  test("a rebound next chord steps on the new key, not on the old literal", async () => {
    seedSpaces({ spacesNext: { key: "ArrowRight", ctrl: true, alt: true } });
    mockBridge();
    const { container } = render(SpacesPanel);
    await waitFor(() => expect(switchedTo(container)).toBe(0));

    await fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true });
    expect(switchedTo(container)).toBe(0);

    await fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true, altKey: true });
    await waitFor(() => expect(switchedTo(container)).toBe(1));
  });
});
