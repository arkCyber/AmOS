/**
 * webman-open-external.svelte.test.ts — 被站点拒嵌时的**真实出路**必须存在且必须被接线（REQ-A1168 / FMEA F-SH-465）。
 *
 * 背景：壳 CSP 的 `frame-src` 曾只允许应用商店的 `amos-app:` —— 于是 WebMan 内容区里**每一个**
 * 远程页面都被自己的 CSP 拒掉（内容空白），这是一条仓内配置缺陷，本轮已放开（A1）。但放开 CSP 只解决
 * 一半：站点自己可以用 `X-Frame-Options: DENY` / `frame-ancestors 'none'` 拒绝被嵌入，此时 iframe
 * 依旧空白，而 `onerror` **通常不会触发**（浏览器只是拦下不让画）。修前组件对此**没有任何出路** ——
 * i18n 里那句 `webman.openInExternalBrowser` 被声明、被翻译、被允许，却没有一个消费者（正是
 * 「一个 mitigation 的 reason 是没人读的散文」那一族缺陷）。
 *
 * 本文件钉三件事：
 *  1. 桌面/平板工具栏**真的有**这条按钮，且它把当前 URL 交给出口函数（不是空手势）。
 *  2. 出口函数答「没接住」（无 opener）时，界面**如实说失败** —— 不假装打开过。
 *  3. 手机类别**不**在工具栏重复：那条出口由内容区卡片自带的 `<a target="_blank">` 承担。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY } from "../src/lib/webman";
import { zh } from "../src/i18n/locales/zh";
import { setFormFactor } from "../src/lib/formAuthority.svelte";

const openInExternalBrowser = vi.hoisted(() => vi.fn(() => true));

// 只换掉出口函数这一处；其余（`loadTabs`/`sanitizeUrl`/…）走真实现。
vi.mock("../src/lib/webman", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, openInExternalBrowser };
});

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  openInExternalBrowser.mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  openInExternalBrowser.mockReset();
  vi.restoreAllMocks();
  setFormFactor(null);
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** 一个已打开真实页面的标签。URL 用回环，避免 happy-dom 去触网（net-sentinel 禁止）。 */
const TAB_URL = "http://127.0.0.1:1/";
function seedTab() {
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [
        {
          id: "tab-1",
          url: TAB_URL,
          title: "127.0.0.1",
          favicon: "",
          loading: false,
          scrollY: 0,
          pinned: false,
        },
      ],
    }),
  );
}

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")] as HTMLButtonElement[];
const btnByAria = (h: { container: HTMLElement }, label: string) =>
  buttons(h).find((b) => b.getAttribute("aria-label") === label);

describe("REQ-A1168: 「在外部浏览器中打开」是接线了的真出路", () => {
  test("桌面工具栏有这条按钮，且它把当前 URL 交给出口函数", async () => {
    seedTab();
    setFormFactor("desktop");
    const h = render(WebManApp);
    await settle();

    const btn = btnByAria(h, zh["webman.openInExternalBrowser"]);
    expect(btn, "桌面工具栏应有「外部浏览器」按钮").toBeTruthy();
    expect(btn!.disabled).toBe(false);

    await fireEvent.click(btn!);
    await settle();

    expect(openInExternalBrowser).toHaveBeenCalledTimes(1);
    expect(openInExternalBrowser).toHaveBeenCalledWith(TAB_URL);
  });

  test("出口函数答「没接住」⇒ 界面如实说失败，不假装打开过", async () => {
    openInExternalBrowser.mockReturnValue(false);
    seedTab();
    setFormFactor("desktop");
    const h = render(WebManApp);
    await settle();

    await fireEvent.click(btnByAria(h, zh["webman.openInExternalBrowser"])!);
    await settle();

    expect(txt(h)).toContain(zh["webman.toast.openExternalFailed"]);
  });

  test("出口函数答「接住了」⇒ 不播报失败（反向半边，防「一律报失败」假绿）", async () => {
    openInExternalBrowser.mockReturnValue(true);
    seedTab();
    setFormFactor("desktop");
    const h = render(WebManApp);
    await settle();

    await fireEvent.click(btnByAria(h, zh["webman.openInExternalBrowser"])!);
    await settle();

    expect(txt(h)).not.toContain(zh["webman.toast.openExternalFailed"]);
  });

  test("手机类别不在工具栏重复这条出口（内容区卡片自带 `<a target=_blank>`）", async () => {
    seedTab();
    setFormFactor("phone");
    const h = render(WebManApp);
    await settle();

    expect(btnByAria(h, zh["webman.openInExternalBrowser"])).toBeUndefined();
  });

  /**
   * REQ-A1560/F1：手机卡片那条出口是**裸的** `<a target="_blank">`，缺 `rel` 时被打开的页面
   * 拿到 `window.opener`，可以把它导航回一个钓鱼页（reverse tabnabbing）。同一个 feature 的
   * 兄弟 `openInExternalBrowser`（`webman.ts`）**显式**传了 `noopener,noreferrer` —— 这一支
   * 不能默认开着。这条出口此前**没有任何测试**（上面那条只断言工具栏按钮不在），所以这个缺陷
   * 一直是绿的。
   */
  test("手机卡片的 `target=_blank` 出口带 `rel=noopener noreferrer`（与工具栏那条同一个动作）", async () => {
    seedTab();
    setFormFactor("phone");
    const h = render(WebManApp);
    await settle();

    const anchors = [...h.container.querySelectorAll("a")] as HTMLAnchorElement[];
    const exit = anchors.find((a) => a.getAttribute("href") === TAB_URL);
    expect(exit, "手机卡片应有一条指向当前页的出口链接").toBeTruthy();
    expect(exit!.getAttribute("target")).toBe("_blank");

    const rel = (exit!.getAttribute("rel") ?? "").split(/\s+/);
    expect(rel, "缺 noopener ⇒ 目标页拿到 window.opener").toContain("noopener");
    expect(rel, "缺 noreferrer ⇒ 站点拿到完整 referrer").toContain("noreferrer");
  });
});
