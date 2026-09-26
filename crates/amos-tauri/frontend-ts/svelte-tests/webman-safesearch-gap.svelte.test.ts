/**
 * webman-safesearch-gap.svelte.test.ts — 覆盖缺口必须对**用户**说出来（REQ-A1333 / FMEA F-SH-599）。
 *
 * `SAFE_SEARCH_PARAMS` 的注释说这张表只覆盖三个宿主、`baidu.com` 是**被记录的**缺口，并且
 * 「后果是明确的、也是**被说出来的**」。前半句是真的；后半句此前只在**测试**里成立 ——
 * `SAFE_SEARCH_UNMAPPED_HOSTS` 这条缺口清单一个生产读者都没有。于是设置面板里「安全搜索」
 * 亮着、而在百度上它什么都不做，用户那边一个字都没说：一个被代码承认的缺口，对着用户
 * 假装不存在（本仓记过这一类：一条只被测试读的常量，等于没被读）。
 *
 * 本文件从用户那一侧钉住它：选中百度 ⇒ 面板上出现那句话（且**说出宿主名**）；选回一个
 * 有参数的引擎、或把开关关掉 ⇒ 那句话消失（否则它就成了到处都挂着的噪音）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { SETTINGS_KEY, TABS_KEY } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

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
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
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
/** 引擎那一行按钮的文本是 `🔍` + 名字（选中时再跟一个 `✓`），所以按名字结尾认。 */
const engineBtn = (h: { container: HTMLElement }, engine: string) =>
  buttons(h).find((b) => (b.textContent ?? "").replace("✓", "").trim().endsWith(engine));
const safeSearchBtn = (h: { container: HTMLElement }) =>
  buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.safeSearch"]));

async function openSettings(h: { container: HTMLElement }) {
  await fireEvent.click(btnByAria(h, zh["webman.a11y.menu"])!);
  await settle();
  const entry = buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.settings"]));
  await fireEvent.click(entry!);
  await settle();
}

function seedSettings(over: Record<string, unknown>) {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(over));
}

describe("WebManApp — 「安全搜索」的覆盖缺口对用户说出来", () => {
  test("选中百度（表里没有它的参数）⇒ 面板上出现那句话，并点名宿主", async () => {
    seedSettings({ searchEngine: "baidu", safeSearch: true });
    setFormFactor("desktop");
    const h = render(WebManApp);
    await settle();
    await openSettings(h);

    // 修前：一个生产读者都没有 ⇒ 屏幕上只有那个亮着的开关。
    expect(txt(h)).toContain(zh["webman.safeSearchGap"].replace("{host}", "baidu.com"));
  });

  test("选回一个有参数的引擎 ⇒ 那句话不出现（不是到处都挂着的噪音）", async () => {
    seedSettings({ searchEngine: "baidu", safeSearch: true });
    setFormFactor("desktop");
    const h = render(WebManApp);
    await settle();
    await openSettings(h);
    expect(txt(h)).toContain(zh["webman.safeSearchGap"].replace("{host}", "baidu.com"));

    await fireEvent.click(engineBtn(h, "google")!);
    await settle();

    expect(txt(h)).not.toContain("baidu.com");
    expect(txt(h)).not.toContain(zh["webman.safeSearchGap"].replace("{host}", "google.com"));
  });

  test("把「安全搜索」关掉 ⇒ 那句话不出现（关着的时候它在任何引擎上都不生效）", async () => {
    seedSettings({ searchEngine: "baidu", safeSearch: true });
    setFormFactor("desktop");
    const h = render(WebManApp);
    await settle();
    await openSettings(h);

    await fireEvent.click(safeSearchBtn(h)!);
    await settle();

    expect(txt(h)).not.toContain(zh["webman.safeSearchGap"].replace("{host}", "baidu.com"));
  });
});
