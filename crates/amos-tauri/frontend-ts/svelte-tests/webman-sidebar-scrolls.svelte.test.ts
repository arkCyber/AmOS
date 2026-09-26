/**
 * webman-sidebar-scrolls.svelte.test.ts — 侧边栏那几格列表**能不能滚**（REQ-A1291 / FMEA F-SH-561）。
 *
 * 设置/书签/历史/下载四格画在同一个侧边栏里，而这个侧边栏是 WebMan 自己管的一块区域：
 *
 * ```svelte
 * <div class="flex flex-1 overflow-hidden">        <!-- 主内容区：裁掉溢出 -->
 *   {#if panel !== null}
 *     <div class="w-72 border-r …">                <!-- 侧边栏：没有任何滚动容器 -->
 *       <div class="flex border-b … p-3">…</div>   <!-- 头部 -->
 *       {#if panel === "bookmarks"}
 *         <div class="p-2">…</div>                 <!-- 面板体：也没有 -->
 * ```
 *
 * 应用宿主（`AppPane.svelte:125` / `DesktopAppWindow.svelte:250`）自己是一句
 * `min-h-0 flex-1 overflow-y-auto overscroll-contain`，但它救不了这里：WebMan 的根是
 * `h-full`（chrome 式外壳，自己不长大），长度全在侧边栏内部，而侧边栏的容器是
 * `overflow-hidden` —— 折叠线以下的行被裁掉、**没有任何滚动条**，永远够不到。
 *
 * 同一个组件的标签条自己有 `overflow-x-auto`（`WebManApp.svelte:923`），仓库自己的做法就摆在那儿；
 * 侧边栏漏了这一层。修法与宿主同形：侧栏 `flex h-full … flex-col overflow-hidden`，头部
 * `shrink-0`，面板体 `min-h-0 flex-1 overflow-y-auto` —— `flex-1` 让它拿到剩余高度，
 * `min-h-0` 让它**被允许**矮于内容（flex 项默认 `min-height:auto` 会把它顶回内容高度），
 * 两个都不是装饰：缺任一个，`overflow-y-auto` 都不生效，内容仍被裁。
 *
 * 用回环地址的标签页：happy-dom 会真去取 iframe 的 src，指向公网等于让测试触网。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { BOOKMARKS_KEY, TABS_KEY } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [
        {
          id: "tab-1",
          url: "http://127.0.0.1:1/",
          title: "Alpha",
          favicon: "",
          loading: false,
          scrollY: 0,
          pinned: false,
        },
      ],
    }),
  );
  window.localStorage.setItem(
    BOOKMARKS_KEY,
    JSON.stringify({
      version: 1,
      data: Array.from({ length: 30 }, (_, i) => ({
        id: `bm-${i}`,
        url: `http://127.0.0.1:1/b${i}`,
        title: `Bookmark ${i}`,
        favicon: "",
        createdAt: i,
      })),
    }),
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

/** 打开 ⋮ 菜单 → 点一行（按可见文案找）。 */
async function openPanel(h: Host, label: string) {
  await fireEvent.click(buttons(h).find((b) => b.getAttribute("aria-label") === zh["webman.a11y.menu"])!);
  await settle();
  await fireEvent.click(buttons(h).find((b) => (b.textContent ?? "").includes(label))!);
  await settle();
}

/** 侧边栏本身（全屏唯一那个 `w-72`）。 */
const sidebar = (h: Host) => h.container.querySelector("div.w-72") as HTMLElement;

/** 面板体 —— 侧栏的直接子 `div.p-2`（头部是 `p-3`，两者分得开）。 */
const panelBody = (h: Host) => h.container.querySelector("div.w-72 > div.p-2") as HTMLElement;

describe("REQ-A1291: 侧边栏的面板是滚动的，不是被裁掉的一截", () => {
  test("书签面板的面板体是纵向滚动容器（30 条书签够不着就等于没有）", async () => {
    const host = render(WebManApp);
    await settle();
    await openPanel(host, zh["webman.bookmarks"]);

    expect(sidebar(host), "侧边栏该在（面板打开了）").toBeTruthy();
    expect(
      panelBody(host)?.className,
      `面板体不是滚动容器：${panelBody(host)?.className}`,
    ).toContain("overflow-y-auto");
  });

  test("历史面板走的是同一个侧栏 —— 它也滚（别只修一格）", async () => {
    const host = render(WebManApp);
    await settle();
    await openPanel(host, zh["webman.history"]);

    expect(
      panelBody(host)?.className,
      `历史面板体不是滚动容器：${panelBody(host)?.className}`,
    ).toContain("overflow-y-auto");
  });

  test("面板体是被高度约束的（flex-1 + min-h-0）—— 否则 overflow-y-auto 不生效，内容照样被裁", async () => {
    const host = render(WebManApp);
    await settle();
    await openPanel(host, zh["webman.bookmarks"]);

    const cls = panelBody(host)?.className ?? "";
    expect(cls, "面板体没拿到剩余高度（缺 flex-1）").toContain("flex-1");
    expect(cls, "面板体被 min-height:auto 顶回内容高度（缺 min-h-0），overflow-y-auto 于是是死的").toContain(
      "min-h-0",
    );
  });
});
