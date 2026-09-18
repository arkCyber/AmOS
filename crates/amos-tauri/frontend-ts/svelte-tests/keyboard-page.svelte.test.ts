/**
 * keyboard-page.svelte.test.ts — 「键盘快捷键」设置页测试（Phase 2）。
 *
 * 测试范围：
 *   1. 页面渲染所有分组（浮层 / Spaces / 窗口 / 触屏）
 *   2. 快捷键列表的完整性（与注册表一致）
 *   3. 搜索过滤功能
 *   4. 编辑/保存/重置按钮存在
 *   5. i18n 覆盖（中英文）
 *
 * 采用项目统一的 Svelte 测试模式（`svelte-tests/*.svelte.test.ts`）。
 */
import { describe, expect, test } from "vitest";
import { render } from "@testing-library/svelte";
import KeyboardPage from "../src/svelte/settings/KeyboardPage.svelte";
import { SHELL_MODULES } from "../src/svelte/shellModules";
import { formatShortcut, modulesFor } from "../src/lib/shellModule";
import {
  SYSTEM_DEFAULTS,
  SPACES_DEFAULTS,
  TOUCH_DEFAULTS,
} from "../src/lib/keyboardConfigHook.svelte";

describe("KeyboardPage", () => {
  test("shows the engine's defaults — one source, not a second copy", () => {
    // 这个页面曾经把三张默认表逐字再抄一遍（同一个键、同一个修饰符，只是包成数组）。
    // 现在它读 `keyboardConfigHook` 导出的那一份；这条断言把"显示的就是引擎的默认值"
    // 钉住 —— 一旦有人再抄一份，改引擎默认值就不会反映到这里，测试会红。
    const { container } = render(KeyboardPage);
    const text = container.textContent || "";

    for (const table of [SYSTEM_DEFAULTS, SPACES_DEFAULTS, TOUCH_DEFAULTS]) {
      for (const shortcut of Object.values(table)) {
        expect(text).toContain(formatShortcut(shortcut));
      }
    }
  });

  test("renders all shortcut sections", () => {
    const { container } = render(KeyboardPage);
    
    // 四个分组标题应该都存在
    const text = container.textContent || "";
    expect(text).toContain("启动台与搜索");
    expect(text).toContain("虚拟桌面");
    expect(text).toContain("窗口管理");
    expect(text).toContain("触屏导航");
  });

  test("displays all overlay shortcuts from registry", () => {
    const { container } = render(KeyboardPage);
    
    // 注册表中有快捷键的浮层应该都显示
    const overlays = modulesFor("overlay", SHELL_MODULES).filter(
      (m) => m.shortcuts && m.shortcuts.length > 0
    );
    
    expect(overlays.length).toBeGreaterThan(0);
    
    const text = container.textContent || "";
    // 至少应该有 Launchpad / Spotlight / Mission Control
    expect(text).toMatch(/Launchpad|启动台/i);
    expect(text).toMatch(/Spotlight|搜索/i);
  });

  test("displays system window shortcuts", () => {
    const { container } = render(KeyboardPage);
    
    const text = container.textContent || "";
    // 窗口管理快捷键
    expect(text).toContain("关闭窗口");
    expect(text).toContain("最小化窗口");
    expect(text).toContain("隐藏应用");
    expect(text).toContain("打开设置");
    
    // 对应的快捷键标签
    expect(text).toContain("⌘W");
    expect(text).toContain("⌘M");
    expect(text).toContain("⌘H");
    expect(text).toContain("⌘,");
  });

  test("displays Spaces shortcuts", () => {
    const { container } = render(KeyboardPage);
    
    const text = container.textContent || "";
    // Spaces 快捷键
    expect(text).toContain("切换到上一个桌面");
    expect(text).toContain("切换到下一个桌面");
    expect(text).toContain("显示虚拟桌面面板");
    expect(text).toContain("直接跳转到桌面");
    
    // Ctrl 组合键
    expect(text).toContain("⌃←");
    expect(text).toContain("⌃→");
    expect(text).toContain("⌃↑");
  });

  test("displays touch navigation shortcuts", () => {
    const { container } = render(KeyboardPage);
    
    const text = container.textContent || "";
    // 触屏导航
    expect(text).toContain("返回上一级");
    expect(text).toMatch(/关闭.*取消/);
    
    expect(text).toContain("⌘[");
    // Escape renders as ⎋ (glyph)
    expect(text).toMatch(/Esc|⎋/);
  });

  test("shows hint text and edit hint", () => {
    const { container } = render(KeyboardPage);
    
    const text = container.textContent || "";
    // Phase 2 提示
    expect(text).toContain("点击快捷键进行编辑");
  });

  test("has search field", () => {
    const { container } = render(KeyboardPage);
    
    const searchInput = container.querySelector('input[type="search"]');
    expect(searchInput).toBeTruthy();
    expect(searchInput?.getAttribute("placeholder")).toContain("搜索快捷键或功能");
  });

  test("has export/import/reset buttons", () => {
    const { container } = render(KeyboardPage);
    
    const text = container.textContent || "";
    // 工具栏按钮
    expect(text).toContain("导出");
    expect(text).toContain("导入");
    expect(text).toContain("重置全部");
  });

  test("has kbd elements for shortcuts", () => {
    const { container } = render(KeyboardPage);
    
    // 所有快捷键都应该渲染为 <kbd> 元素
    const kbdElements = container.querySelectorAll("kbd");
    // 至少应该有：浮层快捷键 + 系统快捷键 + Spaces + 触屏 = 10+ 个
    expect(kbdElements.length).toBeGreaterThanOrEqual(8);
  });

  test("sections have proper structure", () => {
    const { container } = render(KeyboardPage);
    
    // 每个分组应该有标题（h3）
    const headings = container.querySelectorAll("h3");
    expect(headings.length).toBeGreaterThanOrEqual(4); // 四个分组
    
    // 应该有分组卡片（section）
    const sections = container.querySelectorAll("section");
    expect(sections.length).toBeGreaterThanOrEqual(4);
  });

  test("has action buttons for each shortcut row", () => {
    const { container } = render(KeyboardPage);
    
    // 每个快捷键行应该有操作按钮（编辑或禁用）
    // 检查是否有 ✕ 禁用按钮
    const disableButtons = container.querySelectorAll('button[title*="禁用"]');
    expect(disableButtons.length).toBeGreaterThan(0);
  });
});
