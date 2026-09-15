import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { isDesktopFeatureEnabled } from "../desktopFeatures";

/**
 * desktopFeatures 的核心是「一个能力是否启用」——它的真源有两处:
 *   1. 浏览器/测试钩子:`window.__amosDisabledFeatures`(数组或字符串)
 *   2. 环境变量:`AMOS_DESKTOP_SHORTCUTS` / `AMOS_DOCK_CONTEXT_MENU`
 *
 * 这里验证:
 *   - 默认两个能力都是开(诚实 UI 默认启用声明的能力)
 *   - env 写 `disabled` ⇒ 关
 *   - env 写 `shortcuts,dock-context-menu` 列表 ⇒ 关
 *   - window 钩子数组 ⇒ 关
 *   - window 钩子字符串(逗号分隔)⇒ 关
 *   - 两路同时设置 ⇒ 关(并集,任一路关都关)
 *
 * ⚠ 不要在 beforeEach 全局清 `globalThis.window` —— 别的测试套件(用 jsdom/happy-dom)
 * 期望它存在;只在我们显式想测"有 window"分支时,先快照、跑、还原。
 */
describe("isDesktopFeatureEnabled", () => {
  const originalEnv = { ...process.env };
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    delete process.env.AMOS_DESKTOP_SHORTCUTS;
    delete process.env.AMOS_DOCK_CONTEXT_MENU;
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    // 严格还原到测试进入时的状态,避免污染后续套件(jsdom/happy-dom 装的 window)。
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it("默认两个能力都启用", () => {
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(true);
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(true);
  });

  it("env 单值 disabled ⇒ 关掉对应能力", () => {
    process.env.AMOS_DESKTOP_SHORTCUTS = "disabled";
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(false);
    // 不影响 dock-context-menu
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(true);
  });

  it("env 列表(逗号分隔)⇒ 关掉列出的能力", () => {
    process.env.AMOS_DOCK_CONTEXT_MENU = "dock-context-menu";
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(false);
  });

  it("env 大小写无关", () => {
    process.env.AMOS_DESKTOP_SHORTCUTS = "DISABLED";
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(false);
  });

  it("window 钩子(数组)⇒ 关掉列出的能力", () => {
    (globalThis as { window?: unknown }).window = globalThis;
    (window as { __amosDisabledFeatures?: unknown }).__amosDisabledFeatures = ["shortcuts"];
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(false);
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(true);
  });

  it("window 钩子(逗号字符串)⇒ 关掉列出的能力", () => {
    (globalThis as { window?: unknown }).window = globalThis;
    (window as { __amosDisabledFeatures?: unknown }).__amosDisabledFeatures =
      "shortcuts, dock-context-menu";
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(false);
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(false);
  });

  it("env 与 window 同时设置 ⇒ 仍关(并集)", () => {
    (globalThis as { window?: unknown }).window = globalThis;
    process.env.AMOS_DOCK_CONTEXT_MENU = "disabled";
    (window as { __amosDisabledFeatures?: unknown }).__amosDisabledFeatures = ["shortcuts"];
    expect(isDesktopFeatureEnabled("shortcuts")).toBe(false);
    expect(isDesktopFeatureEnabled("dock-context-menu")).toBe(false);
  });
});
