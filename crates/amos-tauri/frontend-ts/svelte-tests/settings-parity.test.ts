/**
 * React ↔ Svelte dual-implementation parity tests for the SETTINGS screen.
 *
 * The React Settings (src/apps.tsx → `Settings`, via COMPONENTS.settings) and the
 * Svelte SettingsApp (src/svelte/SettingsApp.svelte) run the same pure libs +
 * shared stores. Offline (no bridge) both render the same set of always-visible
 * groups (外观/语言/自动息屏/唤醒 + iCloud + AI + 壁纸 + 锁屏 + LMK调试) while the
 * data-driven panels (Sensor/System/TaskManager) hide. We assert the shared
 * visible labels appear in both.
 */
import { afterEach, describe, expect, test } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { render } from "@testing-library/svelte";
import SettingsApp from "../src/svelte/SettingsApp.svelte";
import { ThemeProvider } from "../src/theme";
import { I18nProvider } from "../src/i18n";
import { AppComponent } from "../src/apps";
import {
  AMOS_LOCALE_CHANGED_EVENT,
  AMOS_THEME_CHANGED_EVENT,
} from "../src/svelte/ui-events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    m.root.unmount();
    m.host.remove();
  }
  window.localStorage.clear();
});
const txt = (root: HTMLElement) => root.textContent ?? "";
const settle = () => new Promise((r) => setTimeout(r, 50));

function mountReactSettings() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  root.render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        I18nProvider,
        null,
        React.createElement(AppComponent as React.FC<{ id: string }>, { id: "settings" }),
      ),
    ),
  );
  return host;
}

describe("React ↔ Svelte settings parity (offline)", () => {
  test("the always-visible setting groups render in both", async () => {
    const react = mountReactSettings();
    await act(async () => {});
    await settle();
    const reactTxt = txt(react);

    const svelte = render(SettingsApp);
    await settle();
    const svelteTxt = txt(svelte.container);

    for (const label of [
      "外观",
      "语言",
      "自动息屏",
      "iCloud 同步",
      "AI 推理后端",
      "壁纸",
      "锁屏背景",
      "启用锁屏密码",
      "LMK 调试",
    ]) {
      expect(reactTxt).toContain(label);
      expect(svelteTxt).toContain(label);
    }
    // Data-driven monitor panels are hidden offline in BOTH (no broken cards).
    expect(reactTxt).not.toContain("系统工作状况");
    expect(svelteTxt).not.toContain("系统工作状况");
  });

  test("the React shell follows Svelte-driven theme + locale change events", async () => {
    const react = mountReactSettings();
    await act(async () => {});
    await settle();
    expect(txt(react)).toContain("外观");

    // A Svelte screen switching the language broadcasts the event → React follows.
    await act(async () => {
      window.dispatchEvent(new CustomEvent(AMOS_LOCALE_CHANGED_EVENT, { detail: "en" }));
    });
    await settle();
    expect(txt(react)).toContain("Appearance");
    expect(txt(react)).not.toContain("外观");

    // And a Svelte theme switch updates React's theme context (footer line shows it).
    await act(async () => {
      window.dispatchEvent(new CustomEvent(AMOS_THEME_CHANGED_EVENT, { detail: "dark" }));
    });
    await settle();
    expect(txt(react)).toMatch(/mode=dark/);
  });
});
