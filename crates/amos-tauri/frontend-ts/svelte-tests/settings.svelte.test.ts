/**
 * DOM tests for the Svelte 5 Settings screen (SettingsApp.svelte), restructured as
 * an iOS-style "grouped list + drill-down pages" screen.
 *
 * These verify the new information architecture and its interactions against the
 * same shared pure libs + stores as before:
 *   • the index renders the account card + grouped rows (network / display / …);
 *   • the flight-mode switch persists through the shared quick-settings store
 *     (lib/settings flipRadio + airplane cascade — same policy as control center);
 *   • sub pages are reachable by tapping their row and still persist for real:
 *     显示与亮度 → auto screen-off timeout; 锁屏密码 → passcode gating; 语言 → locale.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import SettingsApp from "../src/svelte/SettingsApp.svelte";
import { readStoreValue, writeStoreValue } from "../src/lib/amosStore";
import { setLocale } from "../src/svelte/locale.svelte";
import { AMOS_LOCALE_CHANGED_EVENT } from "../src/svelte/ui-events";
import { AUTOOFF_STORE_KEY } from "../src/lib/display";
import { LOCK_KEY, type LockCfg } from "../src/lib/lock";
import { SETTINGS_KEY, type QuickSettings } from "../src/lib/settings";
import { FOCUS_KEY } from "../src/lib/focusPrefs";

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  setLocale("zh"); // restore shared locale so later tests stay deterministic
});

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttonContaining = (h: { container: HTMLElement }, s: string) =>
  [...h.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(s)) as
    HTMLButtonElement | undefined;
const inputByPlaceholder = (h: { container: HTMLElement }, ph: string) =>
  [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("placeholder") === ph) as
    HTMLInputElement | undefined;
const switchByLabel = (h: { container: HTMLElement }, aria: string) =>
  [...h.container.querySelectorAll('[role="switch"]')].find(
    (b) => b.getAttribute("aria-label") === aria,
  ) as HTMLButtonElement | undefined;

/** Tap the index row whose text contains `label` to push its sub page. */
const navigate = async (h: { container: HTMLElement }, label: string) => {
  const row = buttonContaining(h, label);
  expect(row, `row "${label}"`).toBeTruthy();
  await fireEvent.click(row as HTMLButtonElement);
};

describe("SettingsApp.svelte (iOS-style grouped index)", () => {
  test("renders the account card + grouped rows", () => {
    const host = render(SettingsApp);
    const text = txt(host);
    expect(text).toContain("设置");
    expect(text).toContain("AmOS 用户"); // account card on top
    for (const row of [
      "飞行模式",
      "无线局域网",
      "蓝牙",
      "蜂窝网络",
      "通知",
      "声音与触感",
      "专注模式",
      "显示与亮度",
      "壁纸",
      "锁屏密码",
      "语言",
      "iCloud",
      "AI 与智能",
      "隐私与安全性",
      "关于本机",
      "系统监控与开发者",
    ]) {
      expect(text, `index should surface row "${row}"`).toContain(row);
    }
  });

  test("flight-mode switch persists through the shared quick-settings store", async () => {
    const host = render(SettingsApp);
    const ap = switchByLabel(host, "飞行模式");
    expect(ap).toBeTruthy();
    await fireEvent.click(ap as HTMLButtonElement);

    const saved = readStoreValue<QuickSettings>(SETTINGS_KEY, {});
    expect(saved.airplane).toBe(true);
    // Airplane cascade: turning it on forces Wi-Fi + Bluetooth off (same as the
    // control center's flipRadio policy).
    expect(saved.wifi).toBe(false);
    expect(saved.bluetooth).toBe(false);

    // Flipping it back off restores a clean state.
    await fireEvent.click(switchByLabel(host, "飞行模式") as HTMLButtonElement);
    expect(readStoreValue<QuickSettings>(SETTINGS_KEY, {}).airplane).toBeFalsy();
  });

  test("drilling into 显示与亮度 lets you pick an auto screen-off timeout", async () => {
    const host = render(SettingsApp);
    await navigate(host, "显示与亮度");
    expect(txt(host)).toContain("外观");
    expect(txt(host)).toContain("自动息屏");
    await fireEvent.click(buttonContaining(host, "15 秒") as HTMLButtonElement);
    expect(readStoreValue<number>(AUTOOFF_STORE_KEY, 0)).toBe(15);
  });

  test("auto screen-off reflects an existing value and can be turned back off", async () => {
    writeStoreValue(AUTOOFF_STORE_KEY, 60); // seed a previously chosen timeout
    const host = render(SettingsApp);
    await navigate(host, "显示与亮度");

    const radioChecked = (label: string) =>
      [...host.container.querySelectorAll('[role="radio"]')].find(
        (b) => (b.textContent ?? "").trim() === label,
      )?.getAttribute("aria-checked");

    expect(radioChecked("60 秒")).toBe("true"); // existing value reflected on open
    await fireEvent.click(buttonContaining(host, "关闭") as HTMLButtonElement);
    expect(readStoreValue<number>(AUTOOFF_STORE_KEY, 0)).toBe(0); // back to off
    expect(radioChecked("关闭")).toBe("true");
  });

  test("cellular is now a real preference page", async () => {
    const host = render(SettingsApp);
    await navigate(host, "蜂窝网络");
    expect(txt(host)).toContain("蜂窝数据");
    expect(txt(host)).toContain("数据漫游");
  });

  test("now-real sub pages render their real controls", async () => {
    // notifications → real Do-Not-Disturb switch
    let host = render(SettingsApp);
    await navigate(host, "通知");
    expect(txt(host)).toContain("勿扰模式");
    // sound → preview button
    host = render(SettingsApp);
    await navigate(host, "声音与触感");
    expect(txt(host)).toContain("试听");
    // about → device/version rows (constant identity)
    host = render(SettingsApp);
    await navigate(host, "关于本机");
    expect(txt(host)).toContain("AmOS");
    // privacy → empty-ledger state (ledger cleared each test)
    host = render(SettingsApp);
    await navigate(host, "隐私与安全性");
    expect(txt(host)).toContain("暂无授权");
  });
  test("lock page refuses a too-short passcode", async () => {
    const host = render(SettingsApp);
    await navigate(host, "锁屏密码");
    await fireEvent.click(switchByLabel(host, "启用锁屏密码") as HTMLButtonElement);
    const pin = inputByPlaceholder(host, "4-6 位数字密码");
    expect(pin).toBeTruthy();
    await fireEvent.input(pin as HTMLInputElement, { target: { value: "12" } });
    await fireEvent.click(buttonContaining(host, "保存") as HTMLButtonElement);
    expect(readStoreValue<LockCfg>(LOCK_KEY, { enabled: false }).enabled).toBe(false);
  });

  test("lock page enables and persists a valid 6-digit passcode", async () => {
    const host = render(SettingsApp);
    await navigate(host, "锁屏密码");
    await fireEvent.click(switchByLabel(host, "启用锁屏密码") as HTMLButtonElement);
    const pin = inputByPlaceholder(host, "4-6 位数字密码");
    expect(pin).toBeTruthy();
    await fireEvent.input(pin as HTMLInputElement, { target: { value: "123456" } });
    await fireEvent.click(buttonContaining(host, "保存") as HTMLButtonElement);
    const saved = readStoreValue<LockCfg>(LOCK_KEY, { enabled: false });
    expect(saved.enabled).toBe(true);
    expect(saved.pin).toBe("123456");
  });

  test("switching the language on the 语言 page broadcasts the sync event", async () => {
    const seen: string[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener(AMOS_LOCALE_CHANGED_EVENT, on);
    try {
      const host = render(SettingsApp);
      await navigate(host, "语言");
      await fireEvent.click(buttonContaining(host, "English") as HTMLButtonElement);
      expect(seen).toContain("en");
    } finally {
      window.removeEventListener(AMOS_LOCALE_CHANGED_EVENT, on);
    }
  });

  test("the index search field live-filters rows and drills into a match", async () => {
    const host = render(SettingsApp);
    const input = [...host.container.querySelectorAll("input")].find(
      (i) => i.getAttribute("aria-label") === "搜索设置",
    ) as HTMLInputElement | undefined;
    expect(input).toBeTruthy();

    // Searching hides the account card + grouped view and shows only matches.
    await fireEvent.input(input as HTMLInputElement, { target: { value: "亮度" } });
    expect(txt(host)).toContain("显示与亮度");
    expect(txt(host)).not.toContain("AmOS 用户"); // account card hidden while searching

    // Tapping a result opens that sub page (and clears the search).
    await fireEvent.click(buttonContaining(host, "显示与亮度") as HTMLButtonElement);
    expect(txt(host)).toContain("外观");
  });

  test("index rows surface persisted state (focus subtitle)", async () => {
    // Focus scenario on → the 专注模式 row subtitle lists it.
    writeStoreValue(FOCUS_KEY, { dnd: false, work: true, sleep: false });
    const host = render(SettingsApp);
    expect(txt(host)).toContain("专注模式");
    expect(txt(host)).toContain("工作"); // enabled-scenario subtitle
  });

  test("index search also matches alias/sub-page keywords", async () => {
    const host = render(SettingsApp);
    const input = [...host.container.querySelectorAll("input")].find(
      (i) => i.getAttribute("aria-label") === "搜索设置",
    ) as HTMLInputElement | undefined;
    expect(input).toBeTruthy();

    // English alias finds the page even while the UI is in Chinese.
    await fireEvent.input(input as HTMLInputElement, { target: { value: "brightness" } });
    expect(txt(host)).toContain("显示与亮度");

    // Alias shared by two pages surfaces BOTH (通知 has 勿扰 in its sub page).
    await fireEvent.input(input as HTMLInputElement, { target: { value: "勿扰" } });
    expect(txt(host)).toContain("通知");
    expect(txt(host)).toContain("专注模式");

    // An unmatched term shows the empty state.
    await fireEvent.input(input as HTMLInputElement, { target: { value: "zzzqqq" } });
    expect(txt(host)).toContain("没有找到匹配的设置项。");
  });
});
