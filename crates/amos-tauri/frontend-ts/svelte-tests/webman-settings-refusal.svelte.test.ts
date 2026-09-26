/**
 * webman-settings-refusal.svelte.test.ts — 五个设置开关也必须**读**写盘裁决
 * （REQ-A1353 / FMEA F-SH-617）。
 *
 * `saveSettings` 早就问过存储才作答（返回 `boolean`；REQ-A1331 ∕ F-SH-597 正是为此把它从
 * `void` 改过来的），同面板的 `saveHomepage` 也早就读了它。可按「隐私 ∕ 引擎 ∕ 安全搜索 ∕
 * 弹窗 ∕ JS」的五个调用点一直写作 `settings = {…}; saveSettings(settings);` —— 裁决写出来就
 * 扔了。存储拒写时：屏幕上的开关**翻了**、引擎的选中标记**移了**、地址栏的 🔒 ∕ 🔓 也换了，
 * 而盘上还是旧值 —— 重启（或任何一次重读）之后它们一起弹回去，中间一个字都没有。
 *
 * 修法：五个开关都经 `commitSettings()` —— 拒写 ⇒ 退回内存里的原值 + 说 `settingsSaveFailed`。
 *
 * 这里用**活的消费者**来钉「退回原值」，而不是开关自己那一格的自说自话：JS 开关的真值由
 * `iframeSandbox` 译进 iframe 的 `sandbox`（`allow-scripts` 在不在），隐私模式则由地址栏的
 * placeholder 反映。钉住消费者，别人才改不坏。
 *
 * 只换掉 `saveSettings` 这一处；`loadSettings` ∕ `iframeSandbox` ∕ `loadTabs` 走真实现。用回环地址。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { SETTINGS_KEY, TABS_KEY } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

const saveSettings = vi.hoisted(() => vi.fn(() => true));

vi.mock("../src/lib/webman", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, saveSettings };
});

const PAGE = "http://127.0.0.1:1/";

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [{ id: "tab-1", url: PAGE, title: "A", favicon: "", loading: false, scrollY: 0, pinned: false }],
    }),
  );
  // 空设置对象 ⇒ 走 `DEFAULT_SETTINGS`：privateMode=false、javaScriptEnabled=true、searchEngine=google。
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({}));
  saveSettings.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  saveSettings.mockReset();
  setFormFactor(null);
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")] as HTMLButtonElement[];
const btnByAria = (h: { container: HTMLElement }, label: string) =>
  buttons(h).find((b) => b.getAttribute("aria-label") === label);
const btnByText = (h: { container: HTMLElement }, label: string) =>
  buttons(h).find((b) => (b.textContent ?? "").includes(label));
const sandbox = (h: { container: HTMLElement }) =>
  h.container.querySelector("iframe")?.getAttribute("sandbox") ?? "";
const addressBar = (h: { container: HTMLElement }) =>
  h.container.querySelector("input.pl-10") as HTMLInputElement;

async function openSettings(h: { container: HTMLElement }) {
  await fireEvent.click(btnByAria(h, zh["webman.a11y.menu"])!);
  await settle();
  await fireEvent.click(btnByText(h, zh["webman.settings"])!);
  await settle();
}

describe("WebManApp — 五个设置开关读了写盘裁决（REQ-A1353 / F-SH-617）", () => {
  test("存储拒了这次 JS 开关 ⇒ 说「设置没能保存」，且 sandbox 仍带 allow-scripts（退回原值）", async () => {
    saveSettings.mockReturnValue(false);
    setFormFactor("desktop");
    const h = render(WebManApp);
    await settle();
    await openSettings(h);
    expect(sandbox(h)).toContain("allow-scripts"); // 默认开着

    await fireEvent.click(btnByText(h, zh["webman.javaScript"])!);
    await settle();

    expect(txt(h)).toContain(zh["webman.toast.settingsSaveFailed"]);
    // 修前的形状：`settings` 已经改了 ⇒ sandbox 撤掉了 allow-scripts —— 屏幕上脚本已关，
    // 盘上仍是开的；重启后开关自己弹回去，中间一个字都没有。
    expect(sandbox(h)).toContain("allow-scripts");
  });

  test("存储收下了 ⇒ 这次 JS 开关**真的**生效：sandbox 撤掉 allow-scripts，且没有失败提示", async () => {
    setFormFactor("desktop");
    const h = render(WebManApp);
    await settle();
    await openSettings(h);

    await fireEvent.click(btnByText(h, zh["webman.javaScript"])!);
    await settle();

    expect(sandbox(h)).not.toContain("allow-scripts");
    // 对照：防「一律报失败 ∕ 一律回退」的假绿。
    expect(txt(h)).not.toContain(zh["webman.toast.settingsSaveFailed"]);
  });

  test("存储拒了这次引擎切换 ⇒ 说「设置没能保存」，✓ 仍在**原来那个**引擎上", async () => {
    saveSettings.mockReturnValue(false);
    setFormFactor("desktop");
    const h = render(WebManApp);
    await settle();
    await openSettings(h);
    expect(btnByText(h, "google")!.textContent).toContain("✓");

    await fireEvent.click(btnByText(h, "bing")!);
    await settle();

    expect(txt(h)).toContain(zh["webman.toast.settingsSaveFailed"]);
    expect(btnByText(h, "google")!.textContent).toContain("✓");
    expect(btnByText(h, "bing")!.textContent).not.toContain("✓");
  });

  test("存储拒了这次隐私模式 ⇒ 说「设置没能保存」，地址栏的提示仍是旧的那个", async () => {
    saveSettings.mockReturnValue(false);
    setFormFactor("desktop");
    const h = render(WebManApp);
    await settle();
    await openSettings(h);
    const before = addressBar(h).placeholder;
    expect(before).toBe(zh["webman.searchOrEnterUrl"]);

    await fireEvent.click(btnByText(h, zh["webman.privateMode"])!);
    await settle();

    expect(txt(h)).toContain(zh["webman.toast.settingsSaveFailed"]);
    // 隐私模式的真值反映在地址栏那一格（`settings.privateMode ? … : …`）—— 退回原值。
    expect(addressBar(h).placeholder).toBe(before);
  });
});
