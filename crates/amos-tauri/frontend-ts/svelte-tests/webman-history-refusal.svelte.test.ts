/**
 * webman-history-refusal.svelte.test.ts — 「这一条访问没记进历史」必须被读到
 * （REQ-A1357 / FMEA F-SH-621）。
 *
 * `addToHistory` 原先签 `void`：`saveHistoryStore` 早就问过存储才作答（REQ-A1329），可写者把
 * 裁决一扔，失败只剩一句 `logger.error`。于是「存储拒写」与「记下了」在屏幕上**完全一样** ——
 * 用户导航过去，历史面板里却没有这一条，没有任何一个字解释它为什么不在。这是 `webman.ts`
 * 最后一个签 `void` 的写者。
 *
 * 修法：`addToHistory` 回报「这条访问在不在历史里」；`loadUrl` 在手边就有 `settings.privateMode`
 * 的地方分辨「拒写」与「隐私模式有意不记」，拒写时把话挂在**历史面板顶部**（`StoreErrorBar`），
 * **不用 toast** —— `showToast` 是单槽，同一次导航里 `persistSession()` 刚可能说过话，再播一句
 * 会把它立刻盖掉。
 *
 * 这里把 `addToHistory` 换成一个可切真 ∕ 假的门面：默认走**真**实现（真写盘），单个用例把它
 * 钉成 `false` 来演一次拒写。列表由真的 `searchHistory` 填 —— 所以「拒写的那条不在列表里」
 * 是**真**的缺席，不是断言出来的。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { HISTORY_KEY, SETTINGS_KEY, TABS_KEY, loadHistory } from "../src/lib/webman";
import { zh } from "../src/i18n/locales/zh";

type AddFn = (url: string, title?: string, privateMode?: boolean) => boolean;

const h = vi.hoisted(() => ({
  addToHistory: (() => false) as AddFn,
  real: (() => false) as AddFn,
}));

vi.mock("../src/lib/webman", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  // 捕获真实现，交给用例按需切换（默认就是它）。
  h.real = actual.addToHistory as AddFn;
  h.addToHistory = h.real;
  return {
    ...actual,
    addToHistory: (url: string, title?: string, pm?: boolean) => h.addToHistory(url, title, pm),
  };
});

const HOME = "http://127.0.0.1:1/";
const NEW = "http://127.0.0.1:2/";

const seed = (settings: Record<string, unknown> = {}) => {
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [{ id: "tab-1", url: HOME, title: "A", favicon: "", loading: false, scrollY: 0, pinned: false }],
    }),
  );
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify({ version: 1, data: [] }));
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
};

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  seed();
  h.addToHistory = h.real;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  h.addToHistory = h.real;
});

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const buttons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")] as HTMLButtonElement[];
const btnByAria = (h: { container: HTMLElement }, label: string) =>
  buttons(h).find((b) => b.getAttribute("aria-label") === label);
const addressBar = (h: { container: HTMLElement }) =>
  h.container.querySelector("input.pl-10") as HTMLInputElement;
const storeErr = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="store-write-error"]');
/** 历史面板那一格（「清除历史」按钮的父容器）—— 只看列表，不含地址栏里那个 URL。 */
const historyPanel = (h: { container: HTMLElement }) =>
  buttons(h).find((b) => (b.textContent ?? "").trim() === zh["webman.clearHistory"])!.parentElement!;

/** 在地址栏里敲一个 URL 并回车 —— 走的就是用户导航的那条路（`navigate` → `loadUrl`）。 */
async function goTo(h: { container: HTMLElement }, url: string) {
  await fireEvent.input(addressBar(h), { target: { value: url } });
  await fireEvent.keyDown(addressBar(h), { key: "Enter" });
  await settle();
}

/** 打开 ⋮ 菜单 → 点「历史」→ 列表由 `debounce(…, 300)` 填。 */
async function openHistoryPanel(h: { container: HTMLElement }) {
  await fireEvent.click(btnByAria(h, zh["webman.a11y.menu"])!);
  await settle();
  const item = buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.history"]));
  await fireEvent.click(item!);
  await settle();
  await new Promise<void>((r) => setTimeout(r, 400));
  await settle();
}

describe("WebManApp — 历史写盘裁决被读到（REQ-A1357 / F-SH-621）", () => {
  test("存储拒了这一次访问 ⇒ 历史面板顶部说「没能记进历史」，且那一条**当面缺席**", async () => {
    h.addToHistory = () => false;
    const hh = render(WebManApp);
    await settle();
    await goTo(hh, NEW);
    await openHistoryPanel(hh);

    // 那句话就挂在历史面板里（不是别的屏）；列表**当面**为空 —— 旧形状下这里一个字的解释都没有。
    expect(historyPanel(hh).textContent).toContain(zh["webman.history.saveFailed"]);
    expect(storeErr(hh)?.textContent).toContain(zh["webman.history.saveFailed"]);
    expect(historyPanel(hh).textContent).toContain(zh["webman.noHistory"]);
    expect(historyPanel(hh).textContent).not.toContain(NEW);
  });

  test("存储收下了 ⇒ 那一条**在**列表里，且没有那句失败（反向半边，防「一律报失败」假绿）", async () => {
    const hh = render(WebManApp);
    await settle();
    await goTo(hh, NEW);
    await openHistoryPanel(hh);

    expect(storeErr(hh)).toBeNull();
    // 真实现真的写进了存储（不只是界面上的假象），面板也画出了非空列表。
    expect(loadHistory().map((e) => e.url)).toContain(NEW);
    expect(historyPanel(hh).textContent).not.toContain(zh["webman.noHistory"]);
  });

  test("隐私模式**有意不记** ⇒ 一声不吭（那不是拒写；把它说成失败是假报）", async () => {
    window.localStorage.clear();
    seed({ privateMode: true });
    // 真实现：隐私模式下 `addToHistory` 也回 false，但盘上确实没写。
    const hh = render(WebManApp);
    await settle();
    await goTo(hh, NEW);
    await openHistoryPanel(hh);

    expect(storeErr(hh)).toBeNull();
    expect(historyPanel(hh).textContent).toContain(zh["webman.noHistory"]);
    expect(historyPanel(hh).textContent).not.toContain(NEW);
  });

  test("拒写之后又记成了一条 ⇒ 那句失败撤掉（它说的是一件已经过期的事）", async () => {
    h.addToHistory = () => false;
    const hh = render(WebManApp);
    await settle();
    await goTo(hh, NEW);
    await openHistoryPanel(hh);
    expect(storeErr(hh)).not.toBeNull();

    // 存储好起来了：下一次导航记成功（面板仍开着）⇒ 顶部那句必须消失、这一条出现。
    h.addToHistory = h.real;
    const THIRD = "http://127.0.0.1:3/";
    await goTo(hh, THIRD);
    await new Promise<void>((r) => setTimeout(r, 400));
    await settle();

    expect(storeErr(hh)).toBeNull();
    expect(loadHistory().map((e) => e.url)).toContain(THIRD);
  });
});
