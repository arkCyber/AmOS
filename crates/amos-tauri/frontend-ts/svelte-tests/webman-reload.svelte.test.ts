/**
 * webman-reload.svelte.test.ts — 工具栏那颗 ↻ 宣称的动作是**重新取当前这一页**（REQ-A1184 / FMEA F-SH-475）。
 *
 * 它的 `aria-label` 是 `webman.a11y.reload`、图标是 ↻、旁边没有第二颗「前往」。修前它接的是
 * `navigate()`（=「把地址栏里的东西当成一次新导航」），于是「刷新」这句话在三处不成立：
 *
 *   ① **地址栏里有一段没按回车的输入**时点 ↻：那段文字被**提交**成一次导航 —— 用户按的是刷新，
 *      屏幕却跳到了另一个地址，而 ⌘R 的表现完全不同。
 *   ② **地址栏被清空**时点 ↻：`parseInput("")` 回空串 ⇒ 一颗**刷新**按钮播报「无效的 URL」，
 *      而且按下去什么都没发生（那颗按钮还亮着）。
 *   ③ ⌘R 走的是**另一条**代码路径（`runBrowserIntent` 的 `iframe.src = iframe.src`）——
 *      那句注释「两条入口不可能给出不同行为」在 ↻ 这里不成立。正因为引擎的重新取文档只能靠
 *      **直接写 frame 的 `src`**（`src={activeTab.url}` 值没变时 Svelte 不碰 DOM），
 *      把同一个 URL 再喂给 `navigate()` 也**不会**刷新 —— 那会是一颗自称刷新、实则只改存储的按钮。
 *
 * 同族的第二笔账：本组件的两个定时器原来都**无主**（没有句柄、不取消、卸载不清）——
 * toast 的 3 秒被后一条 toast 的闹钟提前熄掉，加载指示的 800ms 被 800ms 内的第二次导航提前熄掉。
 *
 * 全部用回环地址（`127.0.0.1:1` / `:2` / `:3`）：happy-dom 会真去取 iframe 的 src，
 * 指向公网就是让测试触网（`net-sentinel.mjs` 明文禁止）。回环立刻被拒，全程离线。
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
const PAGE_C = "http://127.0.0.1:3/";

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
  vi.restoreAllMocks();
  setFormFactor(null);
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

/** 假时钟下的冲一冲（`settle` 自己用的 setTimeout 也被冻住了，故不能复用）。 */
const settleFake = async () => {
  await tick();
  await vi.advanceTimersByTimeAsync(0);
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

const buttons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")] as HTMLButtonElement[];

const btnByAria = (h: { container: HTMLElement }, label: string) =>
  buttons(h).find((b) => b.getAttribute("aria-label") === label);

/** 那颗 ↻（修前它也在这；本文件算的是**它的动作**，不是它的存在）。 */
const reloadBtn = (h: { container: HTMLElement }) => btnByAria(h, zh["webman.a11y.reload"]);

const addressBar = (h: { container: HTMLElement }) =>
  h.container.querySelector('input[type="text"]') as HTMLInputElement;

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";

/** 引擎此刻真正拿着的那份文档 —— 这才是「当前这一页」的读数，地址栏/存储都不是。 */
const frameUrl = (h: { container: HTMLElement }) =>
  h.container.querySelector("iframe")?.getAttribute("src") ?? null;

const storedTab = (): { url: string; loading: boolean } =>
  (JSON.parse(window.localStorage.getItem(TABS_KEY) ?? "{}") as { data: Array<{ url: string; loading: boolean }> })
    .data[0]!;

/** 加载指示（标签条 / 地址栏两处共用 `animate-spin`）。 */
const spinning = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("span")].some((s) =>
    (s.getAttribute("class") ?? "").includes("animate-spin"),
  );

/** 在地址栏里敲 URL 并回车（= 用户发起一次真实导航）。 */
async function navigateTo(h: { container: HTMLElement }, url: string) {
  const input = addressBar(h);
  await fireEvent.input(input, { target: { value: url } });
  await fireEvent.keyDown(input, { key: "Enter" });
  await settle();
}

/** 只敲、不回车 —— 「地址栏里有一段没提交的输入」。 */
async function typeWithoutEnter(h: { container: HTMLElement }, url: string) {
  await fireEvent.input(addressBar(h), { target: { value: url } });
}

describe("REQ-A1184: 工具栏 ↻ 是刷新（刷新当前这一页），不是第二颗「前往」", () => {
  test("地址栏里有一段没回车的输入 ⇒ 点 ↻ 不得把它提交成一次导航", async () => {
    seedTab(PAGE_A);
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    await typeWithoutEnter(host, PAGE_B);
    await fireEvent.click(reloadBtn(host)!);
    await settle();

    // 刷新的是**这一页**：引擎里的文档、落盘的 URL 都还是 A。
    expect(frameUrl(host)).toBe(PAGE_A);
    expect(storedTab().url).toBe(PAGE_A);
    // 用户敲的那段文字还在地址栏里（我们没有替他提交，也没有把它抹掉）。
    expect(addressBar(host).value).toBe(PAGE_B);
  });

  test("地址栏被清空 ⇒ 点 ↻ 不报「无效的 URL」，而是真的在刷新", async () => {
    seedTab(PAGE_A);
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    await typeWithoutEnter(host, "");
    await fireEvent.click(reloadBtn(host)!);
    await settle();

    expect(txt(host)).not.toContain(zh["webman.toast.invalidUrl"]);
    expect(storedTab().url).toBe(PAGE_A);
    // 按下去有动作，不是一颗亮着却不干事的按钮。
    expect(spinning(host)).toBe(true);
  });

  test("⌘R 与 ↻ 是同一件事（地址栏里压着未提交输入时，两条入口给同一个结果）", async () => {
    const run = async (act: (h: { container: HTMLElement }) => Promise<void>) => {
      cleanup();
      window.localStorage.clear();
      seedTab(PAGE_A);
      setFormFactor("desktop");
      const host = render(WebManApp);
      await settle();
      await typeWithoutEnter(host, PAGE_B);
      await act(host);
      await settle();
      const seen = { frame: frameUrl(host), stored: storedTab().url };
      cleanup();
      return seen;
    };

    const viaShortcut = await run(async () => {
      await fireEvent.keyDown(window, { key: "r", metaKey: true });
    });
    const viaButton = await run(async (h) => {
      await fireEvent.click(reloadBtn(h)!);
    });

    expect(viaButton).toEqual(viaShortcut);
    // 而且两者都停在**当前这一页**上（等价于一起错就没有意义了）。
    expect(viaButton).toEqual({ frame: PAGE_A, stored: PAGE_A });
  });
});

describe("REQ-A1184: 本组件的定时器是有主的（后一次动作不被前一次的闹钟熄掉）", () => {
  test("两条 toast 相隔 1 秒 ⇒ 后一条不会被前一条的 3 秒闹钟提前熄掉", async () => {
    seedTab(PAGE_A);
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    const star = () => buttons(host).find((b) => (b.textContent ?? "").trim() === "☆" || (b.textContent ?? "").trim() === "★")!;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await fireEvent.click(star()); // 第一次：加书签
    await settleFake();
    expect(txt(host)).toContain(zh["webman.toast.bookmarkAdded"]);

    await vi.advanceTimersByTimeAsync(1000);
    await fireEvent.click(star()); // 第二次：取消书签 ⇒ 上一条 toast 的闹钟必须作废
    await settleFake();
    expect(txt(host)).toContain(zh["webman.toast.bookmarkRemoved"]);

    // t=3100ms：前一条 toast 的 3 秒到了，后一条才亮了 2.1 秒 —— 它必须还在。
    await vi.advanceTimersByTimeAsync(2100);
    await tick();
    expect(txt(host)).toContain(zh["webman.toast.bookmarkRemoved"]);

    // 但它自己的 3 秒照旧会到（不是"永久钉住"）。
    await vi.advanceTimersByTimeAsync(1100);
    await tick();
    expect(txt(host)).not.toContain(zh["webman.toast.bookmarkRemoved"]);
  });

  test("800ms 之内的第二次导航 ⇒ 前一次的结束定时器不得熄掉新页的加载指示", async () => {
    seedTab(PAGE_A);
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await navigateToFake(host, PAGE_B); // t=0：B 的结束定时器排在 800ms
    expect(storedTab().loading).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    await navigateToFake(host, PAGE_C); // t=500：C 又排了一个

    await vi.advanceTimersByTimeAsync(300); // t=800：B 那一个的原定时刻
    expect(storedTab().url).toBe(PAGE_C);
    expect(storedTab().loading, "C 还在加载，B 的闹钟不该把指示熄掉").toBe(true);

    await vi.advanceTimersByTimeAsync(500); // t=1300：C 的自己到了
    expect(storedTab().loading).toBe(false);
  });
});

/** `navigateTo` 的假时钟版（`settle` 会卡住）。 */
async function navigateToFake(h: { container: HTMLElement }, url: string) {
  const input = addressBar(h);
  await fireEvent.input(input, { target: { value: url } });
  await fireEvent.keyDown(input, { key: "Enter" });
  await settleFake();
}
