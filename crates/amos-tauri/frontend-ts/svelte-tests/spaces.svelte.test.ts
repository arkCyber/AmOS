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

  test("窗口列表用共享的窗口名，而发给宿主的仍是**窗口标签**（REQ-A473）", () => {
    const content = readFileSync(componentPath, "utf-8");
    // The *name* the user reads comes from the shared resolver (an instance window is
    // `文件 — 2`, not the raw platform label), and it is handed the installed-tile list
    // (REQ-A1185) so a **store** app's window is named from the store registry rather than
    // falling through to its raw wire id…
    expect(content).toContain("windowName(w.label, w.app, ext)");
    // …while every host call still carries the **label**: `spaces_move_window` addresses a
    // *window*, so substituting the app id there would file the wrong window (or refuse).
    expect(content).toContain("handleAssignWindow(w.label");
    expect(content).toContain("spaceOfWindow(w.label)");
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

  /**
   * REQ-A513 — 面板必须按**报告**判断切换，而不是按一个恒假的布尔。
   *
   * 缺陷的形状：`spaces_switch` 返回 `()`（wire 上 `null`），而桥把失败也表达成 `null`
   * ⇒ `const ok = await switchSpace(i)` 在成功时也是 `false`，于是这行 `if (!ok)` 把**成功**
   * 的切换写成一行错误。现在成功是报告对象，`!report` 才真的表示"被拒绝"。
   */
  test("切换按报告判断，并把没跟过来的窗口说给用户（REQ-A513）", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("const report = await switchSpace(index)");
    expect(content).toContain("if (!report)");
    expect(content).toContain("report.hide_failed.length + report.show_failed.length");
    // 提示不是错误：切换确实发生了，所以走 `spaces.switchPartial` 且有自己的 testid。
    expect(content).toContain("spaces.switchPartial");
    expect(content).toContain('data-testid="spaces-switch-partial"');
  });

  /**
   * REQ-A553 — 底部快捷键图例必须读**实时绑定**，而不是写死的弦，且不许有"做不到的行"。
   *
   * 缺陷的形状（F-SH-003）：四条 `<kbd>` 全是硬编码字面量（`Ctrl+←` / `Ctrl+→` / `F3` /
   * `Ctrl+↑`），用户在设置里改键/禁用绑定后图例照旧印旧弦；更糟的是最后一行写「新建桌面：
   * Ctrl+↑」—— 而 `⌃↑` 是 `spacesPanel`（打开**本**面板），`SPACES_DEFAULTS` 里根本没有新建
   * 桌面的绑定，按下去不会新建任何东西。现在四个值来自 `createKeyboardBindings()`：改键跟着
   * 变，被禁用（`null`）则不画 `<kbd>`。
   */
  test("快捷键图例读实时绑定、且不印做不到的弦（REQ-A553）", () => {
    const content = readFileSync(componentPath, "utf-8");
    // 取值来自共享的绑定解析器（与 Dock / 顶栏同一本规则书），不是第二份快捷键表。
    expect(content).toContain("createKeyboardBindings");
    expect(content).toContain('getSpacesShortcut("spacesPrev")');
    expect(content).toContain('getSpacesShortcut("spacesNext")');
    expect(content).toContain('getSpacesShortcut("spacesDirect")');
    expect(content).toContain('getSpacesShortcut("spacesPanel")');
    // Mission Control 是**浮层注册表**里的 id（F3 / ⌘⇥），走浮层读取口。
    expect(content).toContain('getOverlayShortcut("mission-control")');
    // 写死的弦与那条假行都清掉了：`⌃↑` 打开的是本面板，不是"新建桌面"。
    expect(content).not.toContain("Ctrl+←");
    expect(content).not.toContain("Ctrl+→");
    expect(content).not.toContain("Ctrl+↑");
    expect(content).not.toContain("spaces.shortcutNew");
    expect(content).toContain("spaces.shortcutPanel");
  });

  /**
   * REQ-A556 — 面板**复用**共享的循环规则，默认桌面名走 i18n。
   *
   * 两处缺陷同形：面板各留了一份"自己的实现"。
   *   1. `handleArrowNavigation` 手抄了 `prevSpaceIndex` / `nextSpaceIndex` 的取模算术 ——
   *      而 `DesktopShell` 用的是那对**有测试**的函数。两份循环规则迟早漂移，且测试只盖住
   *      了其中一份。现在面板 import 同一对函数。
   *   2. 新建桌面用写死的 `Desktop ${n}`：英文用户看到的、中文用户看到的、以及宿主自己建的
   *      默认桌面（`桌面 1`）是**三套**命名。现在走 `t("spaces.defaultName", { n })`。
   */
  test("箭头导航复用共享循环规则、默认名走 i18n（REQ-A556）", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("prevSpaceIndex,");
    expect(content).toContain("nextSpaceIndex,");
    expect(content).toContain("prevSpaceIndex(currentIndex, spaces.length)");
    expect(content).toContain("nextSpaceIndex(currentIndex, spaces.length)");
    // 手抄的那份 wrap 算术没有了（它是"第二份规则"）。
    expect(content).not.toContain("currentIndex - 1");
    expect(content).not.toContain("spaces.length - 1");
    // 默认名不再写死英文，且不再有第四个命名约定。
    expect(content).toContain('t("spaces.defaultName", { n: spaces.length + 1 })');
    expect(content).not.toContain("`Desktop ");
  });
});
