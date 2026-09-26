/**
 * Mission Control with Spaces bar tests
 * 
 * 验证 Mission Control 面板的 Spaces 栏集成：
 * - Spaces 栏显示所有虚拟桌面
 * - 当前 Space 高亮显示
 * - 窗口数量指示器
 * - 点击切换桌面
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import MissionControl from "../src/svelte/MissionControl.svelte";
import * as backend from "../src/lib/backend";
import * as spaces from "../src/lib/spaces";

vi.mock("../src/lib/backend");
vi.mock("../src/lib/spaces");
vi.mock("../src/lib/focusTrap", () => ({
  attachFocusTrap: vi.fn(() => () => {}),
}));

describe("MissionControl with Spaces", () => {
  const mockWindows = {
    windows: [
      { label: "photos", kind: "App", state: "Focused" },
      { label: "files", kind: "App", state: "Normal" },
    ],
  };

  const mockSpaces = [
    { id: "space-0", name: "Desktop 1", windows: ["photos"] },
    { id: "space-1", name: "Desktop 2", windows: ["files", "player"] },
    { id: "space-2", name: "Work", windows: [] },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "wm_windows") return mockWindows;
      return null;
    });
    vi.mocked(spaces.listSpaces).mockResolvedValue(mockSpaces);
    vi.mocked(spaces.activeSpace).mockResolvedValue(0);
    // REQ-A513: 成功是**报告对象**（`switchSpace` 从前返回 boolean，而单位返回的桥
    // 成功也是 `null` ⇒ 判据恒 false ⇒ 浮层从不关闭）。这里用真实形状：没有窗口掉队。
    vi.mocked(spaces.switchSpace).mockResolvedValue({
      index: 0,
      hide_failed: [],
      show_failed: [],
    });
    // `spacesFailure` 是 F-SH-577 引入的"唯一的措辞规则"；automock 让它返回 `undefined`，
    // 于是既有那条"拒绝不关浮层"的测试会踩到解构 —— 这里给整套一个合理默认，各条测试按需覆盖。
    vi.mocked(spaces.spacesFailure).mockReturnValue({ key: "spaces.errorOutOfBounds" });
    // REQ-A1310：`onSpacesChanged` 是**订阅**，组件把它返回的退订函数存进了 `$effect` 的清理。
    // automock 让它返回 `undefined`，于是每一次卸载都抛 `stop is not a function`（full-suite 下
    // 汇成 17 条 Unhandled Rejection）。这里给一个真的退订函数 —— 与 `focusTrap` 的 mock 同形。
    vi.mocked(spaces.onSpacesChanged).mockReturnValue(() => {});
  });

  it("renders spaces bar when spaces available", async () => {
    render(MissionControl, { props: { onclose: vi.fn() } });
    
    await waitFor(() => {
      expect(screen.queryByTestId("mission-spaces")).toBeTruthy();
    });
  });

  it("displays all spaces with names", async () => {
    render(MissionControl, { props: { onclose: vi.fn() } });
    
    await waitFor(() => {
      expect(screen.getByText("Desktop 1")).toBeTruthy();
      expect(screen.getByText("Desktop 2")).toBeTruthy();
      expect(screen.getByText("Work")).toBeTruthy();
    });
  });

  it("highlights current space", async () => {
    render(MissionControl, { props: { onclose: vi.fn() } });
    
    await waitFor(() => {
      const desktop1Button = screen.getByText("Desktop 1").closest("button");
      expect(desktop1Button?.className).toContain("bg-white/10");
      expect(desktop1Button?.className).toContain("ring-1");
    });
  });

  it("shows window count indicators", async () => {
    render(MissionControl, { props: { onclose: vi.fn() } });
    
    await waitFor(() => {
      const spaces = screen.getByTestId("mission-spaces");
      // Desktop 1 has 1 window = 1 dot
      // Desktop 2 has 2 windows = 2 dots
      // Work has 0 windows = no dots
      const dots = spaces.querySelectorAll(".h-1.w-1.rounded-full");
      expect(dots.length).toBeGreaterThan(0);
    });
  });

  it("switches space on click", async () => {
    const onclose = vi.fn();
    render(MissionControl, { props: { onclose } });
    
    await waitFor(() => {
      expect(screen.getByText("Desktop 2")).toBeTruthy();
    });

    const desktop2Button = screen.getByText("Desktop 2").closest("button");
    await fireEvent.click(desktop2Button!);

    expect(spaces.switchSpace).toHaveBeenCalledWith(1);
    
    // Should close after delay
    await waitFor(() => {
      expect(onclose).toHaveBeenCalled();
    }, { timeout: 300 });
  });

  it("shows aria labels with window counts", async () => {
    render(MissionControl, { props: { onclose: vi.fn() } });
    
    await waitFor(() => {
      // Note: i18n will provide "window" or "windows" based on count
      const desktop1 = screen.getByText("Desktop 1").closest("button");
      expect(desktop1?.getAttribute("aria-label")).toBeTruthy();
      expect(desktop1?.getAttribute("aria-label")).toContain("Desktop 1");
    });
  });

  it("hides spaces bar when spaces not available", async () => {
    vi.mocked(spaces.listSpaces).mockResolvedValue(null);
    
    render(MissionControl, { props: { onclose: vi.fn() } });
    
    await waitFor(() => {
      expect(screen.queryByTestId("mission-spaces")).toBeFalsy();
    });
  });

  it("still shows window list when spaces unavailable", async () => {
    vi.mocked(spaces.listSpaces).mockResolvedValue(null);
    
    render(MissionControl, { props: { onclose: vi.fn() } });
    
    await waitFor(() => {
      expect(screen.getByTestId("mission-windows")).toBeTruthy();
    });
  });

  it("shows +N indicator for spaces with many windows", async () => {
    const manyWindowsSpaces = [
      { id: "space-0", name: "Desktop 1", windows: ["w1", "w2", "w3", "w4", "w5", "w6", "w7"] },
    ];
    vi.mocked(spaces.listSpaces).mockResolvedValue(manyWindowsSpaces);
    
    render(MissionControl, { props: { onclose: vi.fn() } });
    
    await waitFor(() => {
      // Should show 5 dots + "+2" text
      expect(screen.getByText("+2")).toBeTruthy();
    });
  });

  it("marks current space with aria-current", async () => {
    render(MissionControl, { props: { onclose: vi.fn() } });
    
    await waitFor(() => {
      const desktop1 = screen.getByText("Desktop 1").closest("button");
      expect(desktop1?.getAttribute("aria-current")).toBe("true");
      
      const desktop2 = screen.getByText("Desktop 2").closest("button");
      expect(desktop2?.getAttribute("aria-current")).toBeFalsy();
    });
  });

  it("handles switch space failure gracefully", async () => {
    // REQ-A513: 拒绝的形状是 `null`（不是 `false`）。
    vi.mocked(spaces.switchSpace).mockResolvedValue(null);
    const onclose = vi.fn();
    
    render(MissionControl, { props: { onclose } });
    
    await waitFor(() => {
      expect(screen.getByText("Desktop 2")).toBeTruthy();
    });

    const desktop2Button = screen.getByText("Desktop 2").closest("button");
    await fireEvent.click(desktop2Button!);

    expect(spaces.switchSpace).toHaveBeenCalledWith(1);
    
    // Should NOT close if switch failed
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(onclose).not.toHaveBeenCalled();
  });

  /**
   * F-SH-577 — 拒绝（`null`）从前是**一条无声的分支**：命令没发生，浮层留着不动，屏幕上
   * 没有一个字。用户看到的"点了没反应"与"这个按钮坏了"完全同形，而它的姊妹面
   * `SpacesPanel.applySwitch` 对**同一个** `spaces_switch` 拒绝是写下一行错误再留着的。
   *
   * 上面那条 `"handles switch space failure gracefully"` 只断言了**否定的一半**（没关浮层）
   * —— 这正是这个缺陷能活到今天的原因：测试名字说的是"优雅地处理失败"，读起来像已覆盖，
   * 而"用户被告诉了什么"从没被问过。这条测试问的就是那一半。
   */
  it("tells the user why a refused switch did not happen (F-SH-577)", async () => {
    vi.mocked(spaces.switchSpace).mockResolvedValue(null);
    // `spacesFailure` 是那条"唯一的措辞规则"；本套件把 `../src/lib/spaces` 整体 automock 了，
    // 所以要显式把它接回来（它的真身由 `lib/spaces` 自己的单元测试守着）。
    vi.mocked(spaces.spacesFailure).mockReturnValue({ key: "spaces.errorOutOfBounds" });
    const onclose = vi.fn();
    render(MissionControl, { props: { onclose } });

    await waitFor(() => expect(screen.getByText("Desktop 2")).toBeTruthy());
    await fireEvent.click(screen.getByText("Desktop 2").closest("button")!);

    // 用户读到了那句话（而不是"点了没反应"）……
    const notice = await waitFor(() => screen.getByTestId("mission-switch-error"));
    expect(notice.textContent).toBeTruthy();
    // ……而浮层**不关**：这句话是本浮层里唯一能读它的地方（与 `switchWarning` 同一条理由）。
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByTestId("mission-switch-error")).toBeTruthy();
    expect(onclose).not.toHaveBeenCalled();
    // 点「关闭」只清掉这句话、不关浮层：用户可以接着挑另一个桌面。
    await fireEvent.click(screen.getByTestId("mission-switch-error-dismiss"));
    expect(screen.queryByTestId("mission-switch-error")).toBeNull();
    expect(onclose).not.toHaveBeenCalled();
  });

  /**
   * REQ-A513 — "账本动了、屏幕没动"的窗口从前只进 `tracing::warn!`：命令返回 `()`，前端连
   * 有没有这回事都无从知道。现在报告把它们带回来，浮层当场说一句 —— 用户看得见那些没跟
   * 过来的窗口，别处看不见。**浮层不再照常关闭**（REQ-A1083）：这句话是本浮层里唯一能看见
   * 那些窗口的地方，自毁式关闭会让它没人读得到；生命周期由下面那条测试守住。
   */
  it("says when the switch worked but some windows did not follow (REQ-A513)", async () => {
    vi.mocked(spaces.switchSpace).mockResolvedValue({
      index: 1,
      hide_failed: [{ label: "notes", reason: "window 'notes' is not registered" }],
      show_failed: [],
    });
    const onclose = vi.fn();
    render(MissionControl, { props: { onclose } });

    await waitFor(() => expect(screen.getByText("Desktop 2")).toBeTruthy());
    await fireEvent.click(screen.getByText("Desktop 2").closest("button")!);

    const notice = await waitFor(() => screen.getByTestId("mission-switch-partial"));
    // 1 个窗口没跟过来：提示说的是「1 个窗口」。
    expect(notice.textContent).toContain("1");
  });

  /**
   * REQ-A1083 — the sentence the panel writes must outlive the write. The overlay used to
   * auto-close 200 ms after `switchWarning` was set, so the only place the user could read
   * "N windows did not follow" was torn down before it could be read; the sibling
   * `SpacesPanel` keeps the same sentence until the user dismisses it (`spaces-switch-partial`
   * + a 关闭 button). A warning the panel itself destroys is a warning with no reader.
   */
  it("keeps the partial-switch notice on screen instead of auto-closing it away (REQ-A1083)", async () => {
    vi.mocked(spaces.switchSpace).mockResolvedValue({
      index: 1,
      hide_failed: [{ label: "notes", reason: "window 'notes' is not registered" }],
      show_failed: [],
    });
    const onclose = vi.fn();
    render(MissionControl, { props: { onclose } });

    await waitFor(() => expect(screen.getByText("Desktop 2")).toBeTruthy());
    await fireEvent.click(screen.getByText("Desktop 2").closest("button")!);

    await waitFor(() => expect(screen.getByTestId("mission-switch-partial")).toBeTruthy());
    // Outlive the 200 ms the auto-close used to wait: the sentence must still be readable.
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByTestId("mission-switch-partial")).toBeTruthy();
    expect(onclose).not.toHaveBeenCalled();
    // And the user can dismiss it, like the settings page's SpacesPanel.
    await fireEvent.click(screen.getByTestId("mission-switch-dismiss"));
    expect(screen.queryByTestId("mission-switch-partial")).toBeNull();
    expect(onclose).toHaveBeenCalled();
  });

  it("arrow keys walk the Spaces row, then down into the window row", async () => {
    render(MissionControl, { props: { onclose: vi.fn() } });
    await waitFor(() => expect(screen.getByTestId("mission-spaces")).toBeTruthy());

    const spaceTiles = () =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-testid="mission-spaces"] button')];
    const windowTiles = () =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-testid="mission-windows"] button')];
    expect(spaceTiles().length).toBe(3);
    expect(windowTiles().length).toBe(2);

    // Nothing holds the focus yet (the trap is mocked in this suite): the first nav key opens
    // the walk on the Spaces row, which is the row the panel draws first.
    await fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(document.activeElement).toBe(spaceTiles()[0]);
    await fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(document.activeElement).toBe(spaceTiles()[1]);
    // Down keeps the column and lands on the window row…
    await fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(windowTiles()[1]);
    // …where Left / Right walk within that row and wrap.
    await fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(document.activeElement).toBe(windowTiles()[0]);
    // Up goes back to the Spaces row at the same column.
    await fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(spaceTiles()[0]);
  });
});

/**
 * REQ-A473 — the switcher must name a window by its **app**, not by its platform label.
 *
 * The defect this pins was introduced by the identity model itself: `label` stopped being
 * the app id (`files_2` is the second Files window), so the old `appTitleKey(label)` lookup
 * found nothing and the switcher printed the capitalized raw label (`Files_2`) with the
 * generic 🧩 icon — i.e. it named windows after an identifier the user never sees anywhere
 * else. The name now comes from the shared `windowName`, which resolves the label first.
 */
describe("MissionControl — window names come from the app identity (REQ-A473)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(spaces.listSpaces).mockResolvedValue([]);
    vi.mocked(spaces.activeSpace).mockResolvedValue(0);
  });

  function hostWith(windows: unknown[]): void {
    vi.mocked(backend.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "wm_windows") return { windows };
      return null;
    });
  }

  it("shows the localized app name for an instance window, marked with its instance", async () => {
    hostWith([
      { label: "files", app: "files", kind: "App", state: "Focused" },
      { label: "files_2", app: "files", kind: "App", state: "Normal" },
    ]);
    render(MissionControl, { props: { onclose: vi.fn() } });

    await waitFor(() => {
      // Both windows are listed…
      expect(screen.getAllByTestId("mission-windows").length).toBeGreaterThan(0);
    });
    // …under names that say which app and which window (zh is the shell default).
    await waitFor(() => {
      expect(screen.getByText("文件")).toBeTruthy();
      expect(screen.getByText("文件 — 2")).toBeTruthy();
    });
    // The raw platform label must NOT be what the user reads.
    expect(screen.queryByText("files_2")).toBeNull();
    expect(screen.queryByText("Files_2")).toBeNull();
  });

  it("still resolves a host payload that predates the identity fields", async () => {
    // An older host reports no `app`: the label alone must still name the window (the
    // shared resolver owns that fallback — a switcher that said `notes_3` would be the
    // defect above returning through a different door).
    //
    // Two windows on purpose: the panel itself is hidden for 0/1 windows
    // (`shouldShowMissionControl` — macOS's ⌘Tab does not open a one-item switcher).
    hostWith([
      { label: "notes_3", kind: "App", state: "Normal" },
      { label: "maps", kind: "App", state: "Normal" },
    ]);
    render(MissionControl, { props: { onclose: vi.fn() } });
    await waitFor(() => {
      expect(screen.getByText("备忘录 — 3")).toBeTruthy();
      expect(screen.getByText("地图")).toBeTruthy();
    });
    expect(screen.queryByText("notes_3")).toBeNull();
  });
});
