/**
 * webman-homepage-refusal.svelte.test.ts — 「已保存」必须由**写盘裁决**来答，而不是由入参来答
 * （REQ-A1331 / FMEA F-SH-597）。
 *
 * `saveHomepage` 的判据原来是 `sanitizeUrl` 通过了（那是**入参**，即意图）就播报「主页已保存」。
 * 而真正落盘的 `saveSettings` 签成 `void`：它经 `writeStoreValue`（**吞掉拒绝**）写盘，调用方
 * 无从知道存没存下。于是存储拒写时屏幕上说「已保存」，重启后主页回到旧值 —— 一次**没发生**的
 * 保存被播报成了事实；而且那一帧里 🏠 已经去了新地址，「生效的」与「存下的」也不一致。
 *
 * 修法：`saveSettings(): boolean` 问过存储才作答；拒写 ⇒ 说失败、把内存里的主页退回原值
 * （没存下的东西不许在屏幕上生效），草稿留着（用户打的字不丢）。
 *
 * 只换掉 `saveSettings` 这一处；`loadSettings` / `sanitizeUrl` / `loadTabs` 走真实现。用回环地址。
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
const HOME = "http://127.0.0.1:9/";
const OTHER = "http://127.0.0.1:8/";

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
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ homepage: HOME }));
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
const addressBar = (h: { container: HTMLElement }) =>
  h.container.querySelector("input.pl-10") as HTMLInputElement;
const homepageInput = (h: { container: HTMLElement }) =>
  h.container.querySelector(`input[aria-label="${zh["webman.homepage"]}"]`) as HTMLInputElement;

async function openSettings(h: { container: HTMLElement }) {
  await fireEvent.click(btnByAria(h, zh["webman.a11y.menu"])!);
  await settle();
  const entry = buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.settings"]));
  await fireEvent.click(entry!);
  await settle();
}

describe("WebManApp — 「主页已保存」由写盘裁决来答", () => {
  test("存储拒了这次保存 ⇒ 说「保存失败」，且 🏠 仍去**原来那个**主页", async () => {
    saveSettings.mockReturnValue(false);
    setFormFactor("desktop");
    const h = render(WebManApp);
    await settle();
    await openSettings(h);

    await fireEvent.input(homepageInput(h), { target: { value: OTHER } });
    await fireEvent.click(btnByAria(h, zh["webman.homepageSave"])!);
    await settle();

    expect(txt(h)).toContain(zh["webman.toast.homepageSaveFailed"]);
    // 旧形状：入参通过了校验就播报「已保存」——一次没发生的保存被说成了事实。
    expect(txt(h)).not.toContain(zh["webman.toast.homepageSaved"]);
    // 没存下的东西不许在屏幕上生效：🈚 主页退回原值，🏠 仍去 HOME。
    expect(homepageInput(h).value).toBe(OTHER); // 草稿留着，用户打的字不丢
    await fireEvent.click(btnByAria(h, zh["webman.a11y.home"])!);
    await settle();
    expect(addressBar(h).value).toBe(HOME);
  });

  test("存储收下了 ⇒ 说「主页已保存」，🏠 去新地址（反向半边）", async () => {
    setFormFactor("desktop");
    const h = render(WebManApp);
    await settle();
    await openSettings(h);

    await fireEvent.input(homepageInput(h), { target: { value: OTHER } });
    await fireEvent.click(btnByAria(h, zh["webman.homepageSave"])!);
    await settle();

    expect(txt(h)).toContain(zh["webman.toast.homepageSaved"]);
    expect(txt(h)).not.toContain(zh["webman.toast.homepageSaveFailed"]);
    await fireEvent.click(btnByAria(h, zh["webman.a11y.home"])!);
    await settle();
    expect(addressBar(h).value).toBe(OTHER);
  });
});
