/**
 * webman-stale-loading.svelte.test.ts — 「正在加载」这个**瞬时指示位被落盘了**，而唯一能把它
 * 熄掉的是一枚**活在组件内存里的闹钟**（REQ-A1376 / FMEA F-SH-640）。
 *
 * `WebManApp.svelte::markLoading` 是本组件**唯一**一处写 `Tab.loading` 的地方：点亮 → 落盘，
 * 排一个 800ms 的定时器 → 到时熄掉 → 再落盘。问题出在两次落盘**之间**：那 800ms 里盘上的这一行
 * 写着 `loading: true`，而能把它改回 `false` 的那枚定时器挂在这个组件的生命周期上 ——
 * `onDestroy` 会把它 `clearTimeout` 掉（那是**对的**，见那句话的注释：到期去写一个不在屏幕上的
 * 组件的状态是错的）。可是**盘上那一行不会跟着消失**。
 *
 * 于是：一次导航之后 800ms 内关掉浏览器（或宿主崩溃 / 断电 / 重启 —— AmOS 上浏览器的生命周期
 * 就是一个窗口），下次打开时 `loadTabs()` 把 `loading: true` 原样带回来，而这个新组件**没有**
 * 任何东西能再熄掉它（`onMount` 只种导航栈、订下载事件、刷 cookie、挂键盘监听）。屏幕上就是：
 *
 *   • 标签条上那一格**永远**转着圈；
 *   • 地址栏左端那个字形**永远**是加载圈 —— 而它正是「现在是不是隐私模式」的**唯一**那一面
 *     （🔒/🔓），所以隐私模式的指示被永久盖住了。
 *
 * 这是「一条活过了 remount 的记录没有撤回器」（`project_surviving_record_has_no_retractor`）
 * 与「一个瞬时位不是会话状态」的交点。修法在**读侧**：`loadTabStore` 把 `loading` 归一化成
 * `false` —— 从盘上回来的行**不可能**正在加载，因为做那次加载的东西已经不存在了。
 *
 * 本文件同时钉住**反方向**：修法不是"把加载圈删掉"。同一次导航里那个圈必须照常亮、照常熄。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

const buttons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")] as HTMLButtonElement[];

/** 一整行落盘的标签页 —— `loading` 由调用方给，因为**它就是本测试的被测对象**。 */
function seedTab(url: string, loading: boolean) {
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [
        { id: "tab-1", url, title: url, favicon: "", loading, scrollY: 0, pinned: false },
      ],
    }),
  );
}

/** 加载圈：标签条上一格一个、地址栏左端一个 —— 全组件只有这两处画 `.animate-spin`。 */
const spinners = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll(".animate-spin")] as HTMLElement[];

/**
 * 地址栏左端那个字形 —— 它是地址栏输入框的**前一个兄弟**（`pl-10` 只为它留位置，全组件只此一处）。
 * 加载时它那一支画的是加载圈（`textContent` 为空串），否则是隐私模式的 🔒 / 🔓。
 */
const addressGlyph = (h: { container: HTMLElement }) => {
  const input = h.container.querySelector("input.pl-10") as HTMLInputElement | null;
  if (!input) throw new Error("地址栏输入框不在（pl-10 是它的唯一样式标记）");
  return input.previousElementSibling?.textContent?.trim() ?? "";
};

/** 在地址栏里敲一个地址并回车 —— 走的是真实的 `navigate` → `loadUrl` → `markLoading`。 */
async function navigateTo(h: { container: HTMLElement }, url: string) {
  const input = h.container.querySelector("input.pl-10") as HTMLInputElement;
  await fireEvent.input(input, { target: { value: url } });
  await fireEvent.keyDown(input, { key: "Enter" });
  await settle();
}

describe("REQ-A1376: 一条 800ms 内被关掉的会话，下次打开不能永远转圈", () => {
  test("盘上带着 `loading: true` 回来 ⇒ 标签条与地址栏都不画加载圈", async () => {
    seedTab("http://127.0.0.1:1/", true);
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    // 修前：两处都在转（`.animate-spin` 有 2 个，地址栏那个字形是空串）。
    expect(spinners(host)).toHaveLength(0);
  });

  test("同一条行回来时，地址栏说的是「现在是不是隐私模式」，不是一圈假的加载", async () => {
    seedTab("http://127.0.0.1:1/", true);
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    expect(addressGlyph(host)).toBe("🔓");
  });

  test("反方向：一次**真的**导航里那个圈照常亮、照常熄（修法不是删掉加载圈）", async () => {
    seedTab("http://127.0.0.1:1/", false);
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();
    expect(spinners(host)).toHaveLength(0);

    await navigateTo(host, "http://127.0.0.1:1/next");
    // 导航刚发生 ⇒ 这一格正在加载，圈必须亮（标签条 + 地址栏两处）。
    expect(spinners(host)).toHaveLength(2);
    expect(addressGlyph(host)).toBe("");

    // 800ms 的承诺到期 ⇒ 圈自己熄掉，隐私模式的字形回到地址栏。
    await new Promise<void>((r) => setTimeout(r, 900));
    await settle();
    expect(spinners(host)).toHaveLength(0);
    expect(addressGlyph(host)).toBe("🔓");
  });

  test("落盘的一行本来就 `loading: false` ⇒ 一直不转（对照组）", async () => {
    seedTab("http://127.0.0.1:1/", false);
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    expect(spinners(host)).toHaveLength(0);
    expect(addressGlyph(host)).toBe("🔓");
  });
});
