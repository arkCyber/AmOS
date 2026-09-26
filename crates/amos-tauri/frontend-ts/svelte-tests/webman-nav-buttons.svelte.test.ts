/**
 * webman-nav-buttons.svelte.test.ts — 地址栏 ← / → 的**接线**（REQ-A598 / FMEA F-SH-081）。
 *
 * 纯函数的行为由 `src/lib/__tests__/webman-nav-history.test.ts` 钉住；本文件钉住的是**缺陷
 * 原本所在的那一层**：`WebManApp.svelte` 里那两个按钮。修复前它们是
 * `onclick={() => (canGoBack = !canGoBack)}` —— 点一下只翻转一个布尔量，`inputValue` 与
 * `activeTab.url` 都不动，也就是 `WEBMAN_IMPLEMENTATION_REPORT.md` 里那个 ✅「导航历史」
 * **在任何模式下都不成立**。因此这里不看函数返回值，只看**屏幕上的地址栏与按钮状态**。
 *
 * 用的是**回环**地址（`127.0.0.1:1` / `:2`）：happy-dom 会真的去加载 iframe 的 src，
 * 指向公网就等于让测试触网（本仓 `net-sentinel.mjs` 明文禁止）。回环立刻被拒，全程离线。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

const PAGE_A = "http://127.0.0.1:1/";
const PAGE_B = "http://127.0.0.1:2/";

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

const buttonByLabel = (h: { container: HTMLElement }, label: string) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | undefined;

const addressBar = (h: { container: HTMLElement }) =>
  h.container.querySelector('input[type="text"]') as HTMLInputElement;

/** 在地址栏里敲一个 URL 并回车（= 用户发起一次真实导航）。 */
async function navigateTo(h: { container: HTMLElement }, url: string) {
  const input = addressBar(h);
  await fireEvent.input(input, { target: { value: url } });
  await fireEvent.keyDown(input, { key: "Enter" });
  await settle();
}

/** activity tab 落盘后的 URL（回退/前进是否真的把这一页换了，以存储为准）。 */
const storedTabUrl = (): string => {
  const raw = window.localStorage.getItem(TABS_KEY);
  if (!raw) return "";
  const parsed = JSON.parse(raw) as { data: Array<{ url: string }> };
  return parsed.data[0]?.url ?? "";
};

describe("REQ-A598: 地址栏 ← / → 是真的导航（不是 toggle）", () => {
  test("恢复出来的一页：两个方向都不可去（← / → 都是灰的）", async () => {
    seedTab(PAGE_A);
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    expect(buttonByLabel(host, "←")!.disabled).toBe(true);
    expect(buttonByLabel(host, "→")!.disabled).toBe(true);
  });

  test("导航到第二页后 ← 变可点；点它回到第一页（地址栏 + 落盘标签一起回去）", async () => {
    seedTab(PAGE_A);
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    await navigateTo(host, PAGE_B);
    expect(addressBar(host).value).toBe(PAGE_B);
    expect(buttonByLabel(host, "←")!.disabled).toBe(false);
    expect(buttonByLabel(host, "→")!.disabled).toBe(true);

    await fireEvent.click(buttonByLabel(host, "←")!);
    await settle();

    expect(addressBar(host).value).toBe(PAGE_A);
    expect(storedTabUrl()).toBe(PAGE_A);
    // 退回来之后前向支路打开 —— 这正是"toggle 版"给不出的行为。
    expect(buttonByLabel(host, "→")!.disabled).toBe(false);
  });

  test("后退之后再点 → 回到第二页", async () => {
    seedTab(PAGE_A);
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    await navigateTo(host, PAGE_B);
    await fireEvent.click(buttonByLabel(host, "←")!);
    await settle();
    await fireEvent.click(buttonByLabel(host, "→")!);
    await settle();

    expect(addressBar(host).value).toBe(PAGE_B);
    expect(storedTabUrl()).toBe(PAGE_B);
    expect(buttonByLabel(host, "→")!.disabled).toBe(true);
  });

  test("后退到第一页后导航到新页 ⇒ → 变灰（前进支路被截断）", async () => {
    seedTab(PAGE_A);
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    await navigateTo(host, PAGE_B);
    await fireEvent.click(buttonByLabel(host, "←")!);
    await settle();
    expect(buttonByLabel(host, "→")!.disabled).toBe(false);

    await navigateTo(host, "http://127.0.0.1:3/");
    expect(buttonByLabel(host, "→")!.disabled).toBe(true);
  });
});

describe("REQ-A968: 菜单按钮把展开态说给 AT", () => {
  test("⋮ 菜单按钮的 aria-expanded 随菜单开合", async () => {
    seedTab(PAGE_A);
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();
    const menu = () =>
      [...host.container.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === zh["webman.a11y.menu"],
      ) as HTMLButtonElement;
    expect(menu()).toBeTruthy();
    expect(menu().getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(menu());
    await settle();
    expect(menu().getAttribute("aria-expanded")).toBe("true");
  });
});
