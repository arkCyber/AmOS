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
    vi.mocked(spaces.switchSpace).mockResolvedValue(true);
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
    vi.mocked(spaces.switchSpace).mockResolvedValue(false);
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
});
