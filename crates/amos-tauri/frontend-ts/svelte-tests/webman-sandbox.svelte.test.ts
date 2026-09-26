/**
 * webman-sandbox.svelte.test.ts — 内联 iframe 的 `sandbox` 是**设置的真值**的接线
 * （REQ-A600 / FMEA F-SH-082）。
 *
 * 纯函数的行为由 `src/lib/__tests__/webman-sandbox.test.ts` 钉住；本文件钉住的是**缺陷
 * 原本所在的那一层**：`WebManApp.svelte` 的 `<iframe sandbox=…>`。修复前那里是**字面量**
 * `"allow-scripts allow-popups allow-forms"`，于是 `blockPopups: true`（源码注释写的
 * 「阻止弹窗」）是**假声明** —— `allow-popups` 恒被授予，而 `javaScriptEnabled: false`
 * 也不会有任何效果。因此这里不看函数返回值，只看**渲染出来的 iframe 属性**与**开关落盘值**。
 *
 * 用的是**回环**地址：happy-dom 会真的去加载 iframe 的 src，指向公网就等于让测试触网
 * （本仓 `net-sentinel.mjs` 明文禁止）。回环立刻被拒，全程离线。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { SETTINGS_KEY, TABS_KEY } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { t } from "../src/svelte/locale.svelte";

const PAGE = "http://127.0.0.1:1/";
const HOME = "http://127.0.0.1:9/";

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  setFormFactor(null);
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

function seedTab(url: string) {
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [{ id: "tab-1", url, title: url, favicon: "", loading: false, scrollY: 0, pinned: false }],
    }),
  );
}

function seedSettings(over: Record<string, unknown>) {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(over));
}

const frame = (h: { container: HTMLElement }) =>
  h.container.querySelector("iframe") as HTMLIFrameElement;
const sandbox = (h: { container: HTMLElement }) => frame(h)?.getAttribute("sandbox") ?? "";
const addressBar = (h: { container: HTMLElement }) =>
  h.container.querySelector('input[type="text"]') as HTMLInputElement;

const buttonByLabel = (h: { container: HTMLElement }, label: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? "") === label,
  ) as HTMLButtonElement | undefined;

const buttonContaining = (h: { container: HTMLElement }, text: string) =>
  [...h.container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(text),
  ) as HTMLButtonElement | undefined;

const storedTabUrl = (): string => {
  const raw = window.localStorage.getItem(TABS_KEY);
  return raw ? (JSON.parse(raw) as { data: Array<{ url: string }> }).data[0]?.url ?? "" : "";
};
const storedSettings = (): Record<string, unknown> =>
  JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}") as Record<string, unknown>;

/** 打开 ⋮ 菜单 → 点「设置」→ 侧栏出现。 */
async function openSettings(h: { container: HTMLElement }) {
  await fireEvent.click(buttonByLabel(h, t("webman.a11y.menu"))!);
  await settle();
  await fireEvent.click(buttonContaining(h, t("webman.settings"))!);
  await settle();
}

describe("REQ-A600: iframe 的 sandbox 由设置派生（不是写死的字面量）", () => {
  test("默认（阻止弹窗 / 开 JS）⇒ 有 allow-scripts，**没有** allow-popups", async () => {
    seedTab(PAGE);
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    expect(sandbox(host)).toContain("allow-scripts");
    expect(sandbox(host)).not.toContain("allow-popups");
  });

  test("持久化的 `blockPopups: false` ⇒ iframe 真的拿到 allow-popups", async () => {
    seedTab(PAGE);
    seedSettings({ blockPopups: false });
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    expect(sandbox(host)).toContain("allow-popups");
  });

  test("持久化的 `javaScriptEnabled: false` ⇒ iframe 撤掉 allow-scripts", async () => {
    seedTab(PAGE);
    seedSettings({ javaScriptEnabled: false });
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    expect(sandbox(host)).not.toContain("allow-scripts");
  });

  test("设置面板里点「阻止弹窗」开关 ⇒ 沙箱当场撤回 allow-popups 且落盘", async () => {
    seedTab(PAGE);
    seedSettings({ blockPopups: false });
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();
    expect(sandbox(host)).toContain("allow-popups"); // 先证明开关此刻是「不阻止」

    await openSettings(host);
    await fireEvent.click(buttonContaining(host, t("webman.blockPopups"))!);
    await settle();

    expect(sandbox(host)).not.toContain("allow-popups");
    expect(storedSettings().blockPopups).toBe(true);
  });
});

describe("REQ-A600: 主页按钮消费 `settings.homepage`", () => {
  test("点 🏠 导航到 homepage（地址栏与落盘标签一起过去）", async () => {
    seedTab(PAGE);
    seedSettings({ homepage: HOME });
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    await fireEvent.click(buttonByLabel(host, t("webman.a11y.home"))!);
    await settle();

    expect(addressBar(host).value).toBe(HOME);
    expect(storedTabUrl()).toBe(HOME);
  });
});
