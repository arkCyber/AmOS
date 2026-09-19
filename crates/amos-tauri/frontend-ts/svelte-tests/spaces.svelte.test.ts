/**
 * SpacesPanel.svelte 组件测试
 *
 * 由于测试环境的限制（缺少完整的 Svelte 渲染环境），这里只进行基本的
 * 模块导入与源码扫描测试。完整的 UI 测试需要在真实的浏览器环境或
 * Tauri 应用中进行。
 */

import { describe, test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const componentPath = resolve(__dirname, "../src/svelte/SpacesPanel.svelte");

describe("SpacesPanel.svelte - 模块完整性", () => {
  test("组件文件存在", () => {
    expect(existsSync(componentPath)).toBe(true);
  });

  test("组件依赖的 spaces 模块可以导入", async () => {
    const spaces = await import("../src/lib/spaces");

    expect(typeof spaces.listSpaces).toBe("function");
    expect(typeof spaces.activeSpace).toBe("function");
    expect(typeof spaces.switchSpace).toBe("function");
    expect(typeof spaces.createSpace).toBe("function");
    expect(typeof spaces.deleteSpace).toBe("function");
    expect(typeof spaces.moveWindowToSpace).toBe("function");
    expect(typeof spaces.unfileWindow).toBe("function");
    expect(typeof spaces.renameSpace).toBe("function");
    expect(typeof spaces.isSpacesAvailable).toBe("function");
    expect(typeof spaces.getSpacesStatus).toBe("function");
  });

  test("组件文件包含正确的内容", () => {
    const content = readFileSync(componentPath, "utf-8");
    // 关键元素 — REQ-A297 phase-2 i18n 扫除后,文案都走 t() 了。
    expect(content).toContain("spaces.title");
    expect(content).toContain("spaces.newDesktop");
    expect(content).toContain("listSpaces");
    expect(content).toContain("switchSpace");
    expect(content).toContain("createSpace");
    expect(content).toContain("deleteSpace");
    expect(content).toContain("renameSpace");
    expect(content).toContain("space-card");
    // i18n-scan 的硬要求 — 文件的 user-visible markup 再不许有 zh 字面量。
    // (JSDoc 注释里的中文不算 — i18n-scan 只看 markup,跟它口径一致。)
    expect(content).not.toContain("新建桌面");
    expect(content).not.toContain("加载失败");
    expect(content).not.toContain("加载中");
  });

  test("组件文件包含样式定义", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("<style>");
    expect(content).toContain(".spaces-panel");
    expect(content).toContain("animation");
  });

  test("组件文件包含交互逻辑", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("handleSwitch");
    expect(content).toContain("handleCreate");
    expect(content).toContain("handleDelete");
    expect(content).toContain("startEdit");
    expect(content).toContain("saveEdit");
    expect(content).toContain("cancelEdit");
  });

  /**
   * REQ-A449 — 窗口归档。Spaces 的一半此前**没有 UI**：`spaces_move_window` 在桥上有导出、
   * 却没有任何调用者（`scripts/unwired-baseline.json` 里挂着它），于是只有手工从 shell 归档过的
   * 窗口才会跟着桌面切换走。这里按本文件既有口径（源码扫描）钉住那块 UI 的存在与两条纪律。
   */
  test("窗口归档 UI 存在，且规则仍在宿主一侧", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("moveWindowToSpace");
    expect(content).toContain("unfileWindow");
    expect(content).toContain("spaces_unfile_window");
    expect(content).toContain("handleAssignWindow");
    expect(content).toContain("wmWindows");
    expect(content).toContain("fileableWindows");
    // 归档之后**重新应用当前桌面**（不是在这里自己判断可见性）：可见性的唯一规则在宿主的
    // `switch_plan`，这一行就是"让屏幕跟上账本"。
    expect(content).toContain("switchSpace(currentIndex)");
    // 三个状态都要能显示：读不到 / 没有窗口 / 有列表。
    expect(content).toContain("spaces.windows");
    expect(content).toContain("spaces.windowsUnavailable");
    expect(content).toContain("spaces.noWindows");
    expect(content).toContain("spaces.unfiled");
    expect(content).toContain("spaces.assignWindow");
  });

  test("新文案没有以字面量进 markup（i18n-scan 的硬要求）", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).not.toContain("窗口归档");
    expect(content).not.toContain("未归档");
    expect(content).not.toContain("读不到窗口列表");
  });
});
