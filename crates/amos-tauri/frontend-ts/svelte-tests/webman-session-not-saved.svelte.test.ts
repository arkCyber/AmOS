/**
 * webman-session-not-saved.svelte.test.ts — 「已固定」/「已恢复」必须由**写盘裁决**来答，
 * 而不是由内存里那次赋值来答（REQ-A1350 / FMEA F-SH-613）。
 *
 * `saveTabs` 签成 `void`：里面那条 3 次重试循环跑完只在 `logger.error` 里留一行，调用方
 * 一个字也收不到（REQ-A1329 修的是「重试循环还能不能工作」，当时把这一半如实留下了 ——
 * 给 `saveTabs` 加返回值「只会造出一个没有读者的裁决」）。那个理由今天可查：本组件**已经**
 * 有一个播报面（`showToast` → `role="status"`），而且有两处**已经在说话**，只是说得不对 ——
 * `toggleActiveTabPinned` 与 `restoreLastClosedTab` 在 `saveTabs` 之后**无条件**播报
 * 「已固定此标签页」/「已恢复关闭的标签页」。存储拒写时，这两句是对一次**没发生**的保存
 * 所下的断言。
 *
 * 修法：`saveTabs(tabs): boolean` 问过存储才作答；组件新增 `persistSession()`（用户意图落点
 * 唯一会说话的那一处），拒写 ⇒ 说 `webman.toast.sessionNotSaved`。
 *
 * 边界（见 FMEA 行）：拒写时**不回退**内存里的会话 —— 标签页是**活的**浏览状态（用户正在看、
 * 正在用），回退等于让存储满的机器连关标签页都做不到；偏好类（主页 ∕ 布局）才回退，因为那些
 * 值的**唯一**用途就是持久化。拒写只让「重启后还在不在」这一件事为假，并如实说出来。
 *
 * 只换 `saveTabs` 这一处；`loadTabs` / `closeTab` / `reopenClosedTab` / `setTabPinned` 走真实现。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

const saveTabs = vi.hoisted(() => vi.fn(() => true));

vi.mock("../src/lib/webman", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, saveTabs };
});

const PAGE_A = "http://127.0.0.1:1/";
const PAGE_B = "http://127.0.0.1:2/";

const seedTabs = (tabs: { id: string; url: string }[]) =>
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: "T",
        favicon: "",
        loading: false,
        scrollY: 0,
        pinned: false,
      })),
    }),
  );

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  seedTabs([
    { id: "tab-1", url: PAGE_A },
    { id: "tab-2", url: PAGE_B },
  ]);
  saveTabs.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  saveTabs.mockReset();
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

async function openMenu(h: { container: HTMLElement }) {
  await fireEvent.click(btnByAria(h, zh["webman.a11y.menu"])!);
  await settle();
}

async function clickMenuEntry(h: { container: HTMLElement }, label: string) {
  const entry = buttons(h).find((b) => (b.textContent ?? "").includes(label));
  await fireEvent.click(entry!);
  await settle();
}

describe("WebManApp — 会话落盘失败必须说出口，不许把没发生的保存画成发生了", () => {
  test("存储拒了这次写入 ⇒ 固定**不**播报「已固定」，改说「没能存下」", async () => {
    setFormFactor("desktop");
    saveTabs.mockReturnValue(false);
    const h = render(WebManApp);
    await settle();

    await openMenu(h);
    await clickMenuEntry(h, zh["webman.pinTab"]);

    expect(txt(h)).toContain(zh["webman.toast.sessionNotSaved"]);
    // 旧形状：不看裁决就播报成功 —— 一次没发生的保存被说成了事实。
    expect(txt(h)).not.toContain(zh["webman.toast.tabPinned"]);
  });

  test("存储拒了这次写入 ⇒ 恢复标签页**不**播报「已恢复」，改说「没能存下」", async () => {
    setFormFactor("desktop");
    // 空白标签页：换页会把 iframe 指到不可达的回环地址上，`onerror` 会播一条「页面加载失败」
    // 盖掉这一条要看的 toast（happy-dom 里没有真的网络）。这一例只问"谁说了什么"，
    // 不该被 iframe 的噪声搅局。
    seedTabs([
      { id: "tab-1", url: "" },
      { id: "tab-2", url: "" },
    ]);
    const h = render(WebManApp);
    await settle();

    // 先真的关掉一个标签页，关闭栈里才有东西可恢复（这一步的写是收下的）。
    await fireEvent.click(btnByAria(h, zh["webman.closeTab"])!);
    await settle();

    saveTabs.mockReturnValue(false);
    await openMenu(h);
    await clickMenuEntry(h, zh["webman.reopenClosedTab"]);

    expect(txt(h)).toContain(zh["webman.toast.sessionNotSaved"]);
    // 旧形状：不看裁决就播报成功 —— 一次没发生的保存被说成了事实。
    expect(txt(h)).not.toContain(zh["webman.toast.tabRestored"]);
  });

  test("对照：存储收下了 ⇒ 说「已固定」，且**不**说「没能存下」（防「一律报失败」假绿）", async () => {
    setFormFactor("desktop");
    const h = render(WebManApp);
    await settle();

    await openMenu(h);
    await clickMenuEntry(h, zh["webman.pinTab"]);

    expect(txt(h)).toContain(zh["webman.toast.tabPinned"]);
    expect(txt(h)).not.toContain(zh["webman.toast.sessionNotSaved"]);
  });
});
