/**
 * webman-site-data-list.svelte.test.ts — 「站点数据」列的是不是**整口 jar**（REQ-A1290 / FMEA F-SH-560）。
 *
 * 设置面板的站点数据一节把宿主那口真实 cookie jar 列出来，供用户查看与清空。它的列表逐字是
 *
 * ```svelte
 * <ul class="max-h-40 overflow-y-auto px-2">
 *   {#each cookies.slice(0, 20) as cookie (cookie.domain + '|' + cookie.path + '|' + cookie.name)}
 * ```
 *
 * —— `slice(0, 20)` 把列表**悄悄**截到 20 条：jar 里第 21 条起不出现，屏幕上没有任何一处
 * 说"还有别的"，而外层容器本来就是 `max-h-40 overflow-y-auto`（**它自己会滚**）—— 那个上限
 * 不是布局所迫，纯粹是把用户的 jar 藏起来。用户打开这一节是想知道"我的 jar 里有什么"，
 * 数到 20 条就以为那就是全部；紧接着那颗「清除站点数据」把**看不见的那些**一起删掉。
 *
 * 与历史面板同族（那边 `searchHistory` 也封在 20 条，侧栏还不会滚，见 REQ-A1230 那一节的
 * 附注）；本条只钉站点数据这一处，因为它**已经**在可滚动容器里，删掉上限不需要动布局。
 *
 * 用回环地址/无 URL 的标签页：happy-dom 会真去取 iframe 的 src，指向公网等于让测试触网
 * （`net-sentinel.mjs` 明文禁止）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

/** 25 条 —— 比那个上限多 5 条，足够让"截断"与"没截断"分得开。 */
const JAR_SIZE = 25;

const cookieJar = () =>
  Array.from({ length: JAR_SIZE }, (_, i) => ({
    name: `c${String(i).padStart(2, "0")}`,
    value: `v${i}`,
    domain: "example.com",
    path: "/",
    secure: false,
    httpOnly: false,
  }));

/** 只答这一条命令的宿主桥；其余命令一律 `null`（与套件里其它 webman 用例同形）。 */
function installJarBridge(cookies: unknown) {
  const invoke = async (cmd: string) => (cmd === "webman_cookies_list" ? cookies : null);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    listen: async () => () => {},
  };
}

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
  setFormFactor("desktop");
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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
async function openSettingsPanel(h: Host) {
  await fireEvent.click(buttons(h).find((b) => b.getAttribute("aria-label") === zh["webman.a11y.menu"])!);
  await settle();
  await fireEvent.click(buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.settings"]))!);
  await settle();
}

/** 站点数据那一份列表（它自己的滚动容器是全屏唯一的 `max-h-40`）。 */
const jarRows = (h: Host) => [...h.container.querySelectorAll("ul.max-h-40 li")];

describe("REQ-A1290: 站点数据列的是整口 jar，不是一个悄悄截断的窗口", () => {
  test("jar 里有 25 条 ⇒ 列表里就该有 25 行（容器本来就会滚，没有理由藏）", async () => {
    installJarBridge(cookieJar());
    const host = render(WebManApp);
    await settle();
    await openSettingsPanel(host);

    expect(host.container.textContent, "这一节该列出 jar 的内容").toContain("example.com");
    expect(jarRows(host).length, `jar 有 ${JAR_SIZE} 条，列表却只画了 ${jarRows(host).length} 行`).toBe(JAR_SIZE);
    // 第一条与最后一条都要在 —— 只数行数可能被"换了 20 条"蒙混过去。
    const text = jarRows(host).map((li) => li.textContent ?? "").join("|");
    expect(text).toContain("c00");
    expect(text).toContain(`c${JAR_SIZE - 1}`);
  });

  test("jar 为空时仍是空态（别把空 jar 画成一列空的 li）", async () => {
    installJarBridge([]);
    const host = render(WebManApp);
    await settle();
    await openSettingsPanel(host);

    expect(host.container.textContent).toContain(zh["webman.siteData.empty"]);
    expect(jarRows(host).length).toBe(0);
  });

  /**
   * REQ-A1560/F2：「这一节列的是**下载管线**的 jar，不是你的浏览 cookie」那句话必须**始终**在
   * ——修前它只活在空态文案里（`webman.siteData.empty` 曾写作「下载管线的 cookie 罐目前为空」），
   * 也就是**只在它无关紧要的时候**说出来。列表一旦非空，屏幕上是一列 cookie + 一颗写着
   * 「清除站点数据」的按钮，用户读到的意思就是"这是我的浏览站点数据"——而那颗按钮清不到
   * 浏览 cookie（那份住在宿主 WebView 里）。这条缺陷的判据**正是**"非空时还在不在"。
   */
  test("jar 非空时，边界说明仍在（不能只活在空态里）", async () => {
    installJarBridge(cookieJar());
    const host = render(WebManApp);
    await settle();
    await openSettingsPanel(host);

    expect(jarRows(host).length).toBe(JAR_SIZE); // 先证明这一节此刻处在"有内容"的那一态
    expect(
      host.container.textContent,
      "非空时缺了边界说明 ⇒ 那颗「清除站点数据」看上去在清浏览 cookie",
    ).toContain(zh["webman.siteData.scope"]);
  });

  test("jar 为空时，边界说明也在（两态都不许少）", async () => {
    installJarBridge([]);
    const host = render(WebManApp);
    await settle();
    await openSettingsPanel(host);

    expect(host.container.textContent).toContain(zh["webman.siteData.scope"]);
  });
});
