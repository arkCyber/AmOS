/**
 * webman-address-bar-tracks-active-tab.svelte.test.ts — 地址栏说的是**哪一页**（REQ-A1276 / FMEA F-SH-551）。
 *
 * `inputValue` 是地址栏的内容，也是 **Enter 提交的那串字**（`handleKeydown` → `navigate()` →
 * `parseInput(inputValue, …)`）。全组件只有三处写它，都是"**用户刚刚做了一件事**"的落点：
 *
 *   • `loadUrl`（导航落定后回填真正生效的 URL）
 *   • `selectTab`（用户点了另一个标签页）
 *   • `addTab`（新标签页 ⇒ 空串）
 *
 * 缺的正是"**活动标签页被别的东西换掉了**"这一类 —— 两处：
 *
 *   ① **恢复会话**：`tabs = $state(loadTabs())` 带着 URL 回来，内容区画出那一页，而
 *      `inputValue` 停在初值 `""` ⇒ 屏幕上一个有内容的页面配着一个空地址栏。
 *   ② **关掉活动标签页**：`removeTab` 把 `activeTabId` 交给接管的那一个标签页（内容区随之换页），
 *      却**不碰** `inputValue` ⇒ 地址栏继续写着**刚被关掉的那一页**。这不是纯装饰：那串字是
 *      Enter 的输入，用户在"已经换页"的屏幕上按回车，会把接管页导航到**上一个页面的地址**。
 *
 * 两个面（内容区 / 地址栏）对"当前是哪一页"给出两个答案，而地址栏那一面还是冻住的
 * —— 与 REQ-A1209／F-SH-496（同一块屏幕上两个面给出两个答案）同族。
 *
 * 用回环地址：happy-dom 会真去取 iframe 的 src，指向公网等于让测试触网（`net-sentinel.mjs` 明文禁止）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

const PAGE_A = "http://127.0.0.1:1/";
const PAGE_B = "http://127.0.0.1:2/";
const TITLE_A = "Alpha";
const TITLE_B = "Beta";

const tab = (id: string, url: string, title: string) => ({
  id,
  url,
  title,
  favicon: "",
  loading: false,
  scrollY: 0,
  pinned: false,
});

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({ version: 1, data: [tab("tab-1", PAGE_A, TITLE_A), tab("tab-2", PAGE_B, TITLE_B)] }),
  );
  setFormFactor("desktop");
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

type Host = { container: HTMLElement };

const buttons = (h: Host) => [...h.container.querySelectorAll("button")] as HTMLButtonElement[];

/** 地址栏那一格 —— `pl-10` 是给左侧那把锁/放大镜留的位置，全屏只有它一个。 */
const addressBar = (h: Host) => h.container.querySelector("input.pl-10") as HTMLInputElement;

/** 内容区那一帧（桌面/平板形态）—— 它画的 URL 就是"屏幕上的那一页"。 */
const frameUrl = (h: Host) => h.container.querySelector("iframe")?.getAttribute("src") ?? null;

/** 标签条里那颗"选中这个标签页"的按钮（没有 aria-label，靠标题文字找）。 */
const tabButtonFor = (h: Host, title: string) =>
  buttons(h).find((b) => b.getAttribute("aria-label") === null && (b.textContent ?? "").includes(title));

/** 某个标签页右侧那颗 ✕ —— 它和标题在同一个容器里。 */
const closeButtonFor = (h: Host, title: string) =>
  buttons(h).find(
    (b) =>
      b.getAttribute("aria-label") === zh["webman.closeTab"] &&
      (b.parentElement?.textContent ?? "").includes(title),
  );

describe("REQ-A1276: 地址栏说的是活动标签页那一页", () => {
  test("恢复会话后，地址栏不是空的 —— 它得说出内容区正在画的那一页", async () => {
    const host = render(WebManApp);
    await settle();

    expect(frameUrl(host), "内容区应画着恢复回来的第一页").toBe(PAGE_A);
    expect(addressBar(host).value, "地址栏不能空着，而内容区有页面").toBe(PAGE_A);
  });

  test("关掉活动标签页后，地址栏跟着内容区换到接管的那一页（不能写着刚关掉的那页）", async () => {
    const host = render(WebManApp);
    await settle();

    // 先选中 tab-2，让地址栏合法地变成 PAGE_B（这一半今天是对的）。
    await fireEvent.click(tabButtonFor(host, TITLE_B)!);
    await settle();
    expect(addressBar(host).value).toBe(PAGE_B);
    expect(frameUrl(host)).toBe(PAGE_B);

    // 关掉**活动**标签页 ⇒ 内容区换到 tab-1。地址栏必须一起换。
    await fireEvent.click(closeButtonFor(host, TITLE_B)!);
    await settle();

    expect(frameUrl(host), "内容区应已换到接管的那一页").toBe(PAGE_A);
    expect(addressBar(host).value, "地址栏还写着刚被关掉的那一页").toBe(PAGE_A);
  });

  test("关掉**非**活动标签页时，地址栏里正在打的字不许被冲掉", async () => {
    const host = render(WebManApp);
    await settle();

    // 用户在地址栏里打了一半（还没按回车 —— 这一页什么都没发生）。
    const partial = "example.com/半截";
    await fireEvent.input(addressBar(host), { target: { value: partial } });
    await settle();
    expect(addressBar(host).value).toBe(partial);

    // 活动的是 tab-1（PAGE_A）；关掉 tab-2 —— 活动页没换，地址栏就不该被"照镜子"重写。
    await fireEvent.click(closeButtonFor(host, TITLE_B)!);
    await settle();

    expect(frameUrl(host), "活动页没变").toBe(PAGE_A);
    expect(addressBar(host).value, "关别人的标签页不该动用户正在打的字").toBe(partial);
  });
});
