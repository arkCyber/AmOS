/**
 * shellChrome.test.ts — `lib/shellChrome.ts` 的形状 token（REQ-A405）。
 *
 * 这个模块此前**没有任何报告提到它**（没有测试 import 过它 ⇒ P2-1 门的分子分母里都不
 * 存在它），而 `TopBar` / `Dock` / `DesktopStage` / `Launchpad` / `Spotlight` /
 * `MissionControl` 六个组件直接把它当"桌面外观的唯一定义处"。它的注释里有三条**可测的
 * 承诺**（之前只有注释在说）：
 *   1. Tailwind 只看**字面量**类名 ⇒ token 里不许出现 `${…}` 插值（否则静默失样式）；
 *   2. 文档化的尺寸（24px 命中框 / 13px 字号 / 16px 圆角 / 200px 面板）必须真的在 token 里；
 *   3. 玻璃面必须同时带 `backdrop-filter` 与 `-webkit-backdrop-filter`
 *      （宿主是 WKWebView，只写标准属性等于在 Safari 上不生效）。
 */
import { describe, expect, test } from "bun:test";
import * as tokens from "../shellChrome";

describe("token 的形状约束", () => {
  test("每个导出都是非空字符串、不含模板插值、不含 undefined/NaN", () => {
    const entries = Object.entries(tokens);
    expect(entries.length).toBeGreaterThanOrEqual(26);
    for (const [name, value] of entries) {
      expect([name, typeof value]).toEqual([name, "string"]);
      expect([name, (value as string).trim().length > 0]).toEqual([name, true]);
      // Tailwind 在构建期扫源码里的字面量类名；`${…}` 会在运行期拼出一个它没见过的类。
      expect([name, (value as string).includes("${")]).toEqual([name, false]);
      expect([name, /undefined|NaN/.test(value as string)]).toEqual([name, false]);
    }
  });

  test("文档化的尺寸真的在 token 里（24px 命中框 / 13px 文字 / 16px 圆角 / 200px 面板）", () => {
    expect(tokens.CHROME_ICON_BUTTON).toContain("h-6");
    expect(tokens.CHROME_ICON_BUTTON).toContain("min-w-6");
    expect(tokens.CHROME_ICON_BUTTON).toContain("focus-visible:ring-2");
    expect(tokens.CHROME_TEXT).toContain("text-[13px]");
    expect(tokens.CHROME_READOUT).toContain("text-[13px]");
    expect(tokens.CHROME_MENU_ITEM).toContain("text-[13px]");
    expect(tokens.DOCK_ITEM_TILE).toContain("rounded-[16px]");
    expect(tokens.CHROME_MENU_PANEL).toContain("min-w-[200px]");
    expect(tokens.CHROME_READOUT_MIN_WIDTH).toBe("3.5rem");
  });

  test("六处玻璃面都带 -webkit- 前缀与背景色（WKWebView 是主宿主）", () => {
    const glass = Object.entries(tokens).filter(([k]) => k.startsWith("GLASS_") && k.endsWith("_STYLE"));
    expect(glass.map(([k]) => k).sort()).toEqual([
      "GLASS_CONTROL_CENTER_STYLE",
      "GLASS_DOCK_STYLE",
      "GLASS_LAUNCHPAD_STYLE",
      "GLASS_MISSION_CONTROL_STYLE",
      "GLASS_SPOTLIGHT_STYLE",
      "GLASS_TOPBAR_STYLE",
    ]);
    for (const [name, value] of glass) {
      const v = value as string;
      expect([name, v.includes("background: rgba(")]).toEqual([name, true]);
      expect([name, v.includes("backdrop-filter: blur(")]).toEqual([name, true]);
      expect([name, v.includes("-webkit-backdrop-filter: blur(")]).toEqual([name, true]);
    }
  });

  test("菜单项自带 disabled: 视觉（FMEA F-SH-001：不能动的行不能长得像能点）", () => {
    expect(tokens.CHROME_MENU_ITEM).toContain("disabled:");
    expect(tokens.CHROME_MENU_ITEM).toContain("disabled:cursor-default");
  });

  test("桌面图标的选中态与键盘焦点态是两套可见反馈（REQ-A273）", () => {
    expect(tokens.DESKTOP_ICON_SELECTED).not.toBe(tokens.DESKTOP_ICON_FOCUSED);
    expect(tokens.DESKTOP_ICON_FOCUSED).toContain("outline-white/80");
    expect(tokens.DESKTOP_ICON_SELECTED).toContain("outline-blue-400/90");
  });

  test("dock 的三个间距 token 各自独立（圆点占位 ≠ 圆点本身）", () => {
    expect(tokens.DOCK_RUNNING_DOT).not.toBe(tokens.DOCK_RUNNING_DOT_SLOT);
    expect(tokens.DOCK_RUNNING_DOT_SLOT).not.toContain("rounded-full");
    expect(tokens.DOCK_SEPARATOR).toContain("w-px");
  });
});
