/**
 * webman-content-boundary.svelte.test.ts — 内容承载的**诚实边界**必须被说出来，且只在它成立
 * 的那一态说出来（REQ-A1560 / F3）。
 *
 * 背景：大屏内容区是 `<iframe sandbox={iframeSandbox(settings)}>`，**不是**独立浏览器引擎。
 * 站点可以用 `X-Frame-Options: DENY` / `frame-ancestors 'none'` 拒绝被嵌入，那时帧里是一片
 * **空白且不报错**（`onerror` 不触发 —— 组件里两处注释都写着这一点）。用户眼前没有内容、没有
 * 解释，也不知道工具栏那颗 ⎋（「在外部浏览器中打开」）就是唯一的出路。这句话此前**只活在代码
 * 注释里**——正是"一个 mitigation 的理由是没人读的散文"那一族缺陷。
 *
 * 本文件钉两件事：
 *  1. 大屏类别（内联帧存在）⇒ 设置面板里**有**这句话，且它点名了那朵云外的出路。
 *  2. 手机类别（内容区是一张卡片 + 外部链接，**没有**这个帧）⇒ 这句话**不**出现 ——
 *     在那种形态下它是一句不成立的陈述，画出来比不画更糟。
 *
 * 用回环地址：happy-dom 会真去取 iframe 的 src，指向公网等于让测试触网（`net-sentinel.mjs`
 * 明文禁止）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [
        {
          id: "tab-1",
          url: "http://127.0.0.1:1/",
          title: "127.0.0.1",
          favicon: "",
          loading: false,
          scrollY: 0,
          pinned: false,
        },
      ],
    }),
  );
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

type Host = { container: HTMLElement };
const buttons = (h: Host) => [...h.container.querySelectorAll("button")] as HTMLButtonElement[];

/** 打开 ⋮ 菜单 → 点「设置」。 */
async function openSettings(h: Host) {
  await fireEvent.click(
    buttons(h).find((b) => b.getAttribute("aria-label") === zh["webman.a11y.menu"])!,
  );
  await settle();
  await fireEvent.click(
    buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.settings"]))!,
  );
  await settle();
}

describe("REQ-A1560/F3: 内容承载的边界在设置面板里被说出来（仅内联形态）", () => {
  test("大屏（存在内联帧）⇒ 有这句说明，且它点名了外部浏览器那条出路", async () => {
    setFormFactor("desktop");
    const h = render(WebManApp);
    await settle();
    await openSettings(h);

    expect(
      h.container.textContent,
      "内容区是沙箱 iframe 这件事必须说给用户 —— 否则拒嵌的站点只剩一片没有解释的空白",
    ).toContain(zh["webman.contentBoundary"]);
    // 只描述问题、不指出路 = 半句话。这句必须把用户引到那颗 ⎋ 上。
    expect(zh["webman.contentBoundary"]).toContain(zh["webman.openInExternalBrowser"]);
  });

  test("手机（没有内联帧）⇒ 这句话**不**出现（在那里它不成立）", async () => {
    setFormFactor("phone");
    const h = render(WebManApp);
    await settle();
    await openSettings(h);

    expect(h.container.textContent).not.toContain(zh["webman.contentBoundary"]);
  });
});
