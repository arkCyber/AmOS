import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "../i18n";
import { ThemeProvider } from "../theme";
import { LockScreen, RecentsPanel, SpotlightPanel } from "../components/SystemPanels";
import NotificationCenter from "../components/NotificationCenter";

const wrap = (el: ReactNode) => (
  <I18nProvider>
    <ThemeProvider>{el}</ThemeProvider>
  </I18nProvider>
);

describe("system panels SSR mount", () => {
  test("lock screen renders", () => {
    expect(renderToString(wrap(<LockScreen onUnlock={() => {}} />))).toContain("🔒");
  });
  test("recents panel renders when open (empty state)", () => {
    const html = renderToString(wrap(<RecentsPanel open onClose={() => {}} onOpen={() => {}} />));
    expect(html).toContain("暂无最近使用");
  });
  test("spotlight panel lists apps", () => {
    const html = renderToString(wrap(<SpotlightPanel open onClose={() => {}} onOpen={() => {}} />));
    expect(html).toContain("设置");
    expect(html).toContain("计算器");
  });
  test("notification center renders quick toggles + notifications", () => {
    const html = renderToString(wrap(<NotificationCenter open onClose={() => {}} />));
    expect(html).toContain("通知中心");
    expect(html).toContain("无线");
  });
});
