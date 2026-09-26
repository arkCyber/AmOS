/**
 * webman-tab-model.svelte.test.ts — 标签条的**键盘模型**与**固定态**（REQ-A1315 / REQ-A1316）。
 *
 * 两件事在此前都不存在：
 *
 * ① **固定是一道单向门**。`Tab.pinned` 只在 `createTab(url, true)` 时被写一次，
 *    `removeTab` 见到 `pinned` 就 `return` —— 于是 ⋮ 菜单里的「新建固定标签」一旦点下，
 *    用户再也解不开它（`pinned` 没有任何往回写的路径），也只能干看着它关不掉。而标签条上
 *    连一个字形都没有：屏幕上唯一的差别是 ✕ 消失了，用户既不知道为什么，也不知道能取消。
 *    拒绝本身还是**静默**的（光秃秃的 `return`），与一个坏掉的按钮没有分别。
 *
 * ② **标签条没有任何键盘模型**。有 N 个标签，却只能用鼠标点。`⌘1`…`⌘9` 与 `⇧⌘[` / `⇧⌘]`
 *    是浏览器通行语义，这里补上；`⇧⌘]` 的真实按键形状是 `key: "}"`（Shift 之后产生的字符），
 *    与 REQ-A496 那个 `⌘⇧T` 的 `"T"` 是同一课 —— 判据只认 `]` 的话在真实键盘上永不成立。
 *
 * 纯函数的行为由 `src/lib/__tests__/webman-closed-tabs.test.ts` 钉住；本文件钉的是**接线**：
 * 键真的连到 `WebManApp` 的 `runBrowserIntent`，📌 真的画在标签条上。
 *
 * 用**回环**地址（`127.0.0.1:N`）：happy-dom 会真去取 iframe 的 src，指向公网等于让测试触网
 * （`net-sentinel.mjs` 明文禁止）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

type SeedTab = { id: string; url: string; title: string; pinned?: boolean };

const seed = (tabs: SeedTab[]) => {
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        favicon: "",
        loading: false,
        scrollY: 0,
        pinned: t.pinned ?? false,
      })),
    }),
  );
};

const storedTabs = (): Array<{ id: string; pinned: boolean }> => {
  const raw = window.localStorage.getItem(TABS_KEY);
  if (!raw) return [];
  return (JSON.parse(raw) as { data: Array<{ id: string; pinned: boolean }> }).data;
};

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

/** 真实键盘形状的 ⌘ 组合键 —— 派发到 window（`onMount` 把监听器挂在 window 上）。 */
async function press(init: KeyboardEventInit) {
  await fireEvent.keyDown(window, init);
  await settle();
}

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const buttons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")] as HTMLButtonElement[];
const btnByAria = (h: { container: HTMLElement }, label: string) =>
  buttons(h).find((b) => b.getAttribute("aria-label") === label);
const btnWithText = (h: { container: HTMLElement }, text: string) =>
  buttons(h).find((b) => (b.textContent ?? "").includes(text));
const iframeSrc = (h: { container: HTMLElement }) =>
  h.container.querySelector("iframe")?.getAttribute("src") ?? "";

/** 当前活动标签页的 URL —— 以内容帧为准（屏幕上真正换没换页）。 */
const activePage = (h: { container: HTMLElement }) => iframeSrc(h);

async function openMenu(h: { container: HTMLElement }) {
  await fireEvent.click(btnByAria(h, zh["webman.a11y.menu"])!);
  await settle();
}

describe("REQ-A1315: 固定标签页 —— 📌 看得见、能解开、拒绝有声", () => {
  test("固定标签在标签条上画 📌（并有可读文本），未固定的不画", async () => {
    seed([
      { id: "t1", url: "http://127.0.0.1:1/", title: "A", pinned: true },
      { id: "t2", url: "http://127.0.0.1:2/", title: "B" },
    ]);
    const h = render(WebManApp);
    await settle();
    expect(txt(h)).toContain("📌");
    expect(txt(h)).toContain(zh["webman.tabPinned"]);
  });

  test("固定标签没有 ✕（关不掉），未固定的有", async () => {
    seed([
      { id: "t1", url: "http://127.0.0.1:1/", title: "A", pinned: true },
      { id: "t2", url: "http://127.0.0.1:2/", title: "B" },
    ]);
    const h = render(WebManApp);
    await settle();
    // ✕ 按钮只该有一个（未固定的那一张）。
    expect(btnByAria(h, zh["webman.closeTab"])).toBeTruthy();
    expect(
      buttons(h).filter((b) => b.getAttribute("aria-label") === zh["webman.closeTab"]).length,
    ).toBe(1);
  });

  test("⌘W 关固定标签 ⇒ 标签还在，并且**说出为什么**（修前是静默 return）", async () => {
    seed([{ id: "t1", url: "http://127.0.0.1:1/", title: "A", pinned: true }]);
    const h = render(WebManApp);
    await settle();

    await press({ key: "w", metaKey: true });

    expect(activePage(h)).toBe("http://127.0.0.1:1/");
    expect(storedTabs().length).toBe(1);
    expect(txt(h)).toContain(zh["webman.toast.pinnedTabCloseRefused"]);
  });

  test("菜单里的「取消固定」真的解开那道门：pinned 落盘为 false，✕ 回来", async () => {
    seed([
      { id: "t1", url: "http://127.0.0.1:1/", title: "A", pinned: true },
      { id: "t2", url: "http://127.0.0.1:2/", title: "B" },
    ]);
    const h = render(WebManApp);
    await settle();

    await openMenu(h);
    const unpin = btnWithText(h, zh["webman.unpinTab"]);
    expect(unpin, "固定中的标签应给出「取消固定」这一行").toBeTruthy();
    await fireEvent.click(unpin!);
    await settle();

    expect(storedTabs().find((t) => t.id === "t1")!.pinned).toBe(false);
    expect(txt(h)).toContain(zh["webman.toast.tabUnpinned"]);
    expect(
      buttons(h).filter((b) => b.getAttribute("aria-label") === zh["webman.closeTab"]).length,
      "取消固定后两张标签都该有 ✕",
    ).toBe(2);
  });

  test("菜单里的「固定此标签页」能把普通标签固定住（反方向也要成立）", async () => {
    seed([
      { id: "t1", url: "http://127.0.0.1:1/", title: "A" },
      { id: "t2", url: "http://127.0.0.1:2/", title: "B" },
    ]);
    const h = render(WebManApp);
    await settle();

    await openMenu(h);
    const pin = btnWithText(h, zh["webman.pinTab"]);
    expect(pin, "未固定的标签应给出「固定此标签页」").toBeTruthy();
    await fireEvent.click(pin!);
    await settle();

    expect(storedTabs().find((t) => t.id === "t1")!.pinned).toBe(true);
    expect(txt(h)).toContain(zh["webman.toast.tabPinned"]);
  });
});

describe("REQ-A1316: 标签条的键盘模型（⌘1…⌘9 / ⇧⌘[ / ⇧⌘]）", () => {
  const fiveTabs: SeedTab[] = [
    { id: "t1", url: "http://127.0.0.1:1/", title: "A" },
    { id: "t2", url: "http://127.0.0.1:2/", title: "B" },
    { id: "t3", url: "http://127.0.0.1:3/", title: "C" },
    { id: "t4", url: "http://127.0.0.1:4/", title: "D" },
    { id: "t5", url: "http://127.0.0.1:5/", title: "E" },
  ];

  test("⌘3 跳到第 3 个标签（内容帧真的换了页）", async () => {
    seed(fiveTabs);
    const h = render(WebManApp);
    await settle();
    expect(activePage(h)).toBe("http://127.0.0.1:1/");

    await press({ key: "3", metaKey: true });
    expect(activePage(h)).toBe("http://127.0.0.1:3/");
  });

  test("⌘9 永远是**最后一个**（5 个标签 ⇒ 第 5 个）", async () => {
    seed(fiveTabs);
    const h = render(WebManApp);
    await settle();

    await press({ key: "9", metaKey: true });
    expect(activePage(h)).toBe("http://127.0.0.1:5/");
  });

  test("⌘7 在只有 5 个标签时夹到最后一个（与 ⌘9 同一语义）", async () => {
    seed(fiveTabs);
    const h = render(WebManApp);
    await settle();

    await press({ key: "7", metaKey: true });
    expect(activePage(h)).toBe("http://127.0.0.1:5/");
  });

  test("⇧⌘} 去下一个标签；从最后一个环绕回第一个", async () => {
    seed(fiveTabs);
    const h = render(WebManApp);
    await settle();

    // 先到最后一个，再往前一步 ⇒ 环回第一个。
    await press({ key: "9", metaKey: true });
    await press({ key: "}", metaKey: true, shiftKey: true });
    expect(activePage(h)).toBe("http://127.0.0.1:1/");
  });

  test("⇧⌘{ 去上一个标签；从第一个环绕到最后一个", async () => {
    seed(fiveTabs);
    const h = render(WebManApp);
    await settle();

    await press({ key: "{", metaKey: true, shiftKey: true });
    expect(activePage(h)).toBe("http://127.0.0.1:5/");
  });

  test("⌘0 不是标签序号 ⇒ 什么都不做（不误吞、不换页）", async () => {
    seed(fiveTabs);
    const h = render(WebManApp);
    await settle();

    await press({ key: "2", metaKey: true });
    expect(activePage(h)).toBe("http://127.0.0.1:2/");
    await press({ key: "0", metaKey: true });
    expect(activePage(h), "⌘0 没有语义，不该动").toBe("http://127.0.0.1:2/");
  });

  test("（负控）不带 ⌘ 的 `]` 不是标签意图 —— 否则在输入框里打方括号会跳页", async () => {
    seed(fiveTabs);
    const h = render(WebManApp);
    await settle();

    await press({ key: "]", shiftKey: true });
    expect(activePage(h)).toBe("http://127.0.0.1:1/");
  });
});
