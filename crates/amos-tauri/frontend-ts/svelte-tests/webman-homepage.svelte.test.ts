/**
 * webman-homepage.svelte.test.ts — 「主页」这个设置**只有读者、没有写者**（REQ-A1215 / FMEA F-SH-501）。
 *
 * 🏠 消费 `settings.homepage`（REQ-A600 修的就是「这个设置被声明、被默认、被反序列化，
 * 却没有任何代码路径读它」）。但全仓**没有一个地方写得进去**：
 *
 *   - `WebManSettings.homepage` 只有声明与默认值（`webman.ts`）；
 *   - `loadSettings` 会把它从存储里读出来；
 *   - 设置面板里**没有任何控件**；`saveSettings` 的全部调用点都是别的开关；
 *   - 唯一的「生产者」是测试自己：`webman-sandbox.svelte.test.ts` 的
 *     `seedSettings({ homepage: HOME })` 直接戳 localStorage。
 *
 * 也就是说：主页按钮宣称去「你的主页」，而那个值**用户永远改不了**（只能是编译期默认值）。
 * 一条只有读者、其值只能由测试夹具生产的设置，是这个仓里的老形状 —— 夹具喂的是一个
 * 生产路径里不存在的值。
 *
 * 本文件从**用户那一侧**钉住它：面板里得有一个控件、能改、改完 🏠 就去那儿、非法输入如实拒绝、
 * 设过的值跨渲染活着。用回环地址（happy-dom 会真去取 iframe 的 src，指向公网等于让测试触网，
 * `net-sentinel.mjs` 明文禁止）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { SETTINGS_KEY, TABS_KEY, loadSettings } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

const PAGE = "http://127.0.0.1:1/";
const HOME = "http://127.0.0.1:9/";
const OTHER = "http://127.0.0.1:8/";
/** 手打 `127.0.0.1:8` 应当得到的结果（没有 scheme ⇒ 按 https 处理）。 */
const OTHER_SSL = "https://127.0.0.1:8/";

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

function seedTab(url: string) {
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [{ id: "tab-1", url, title: url, favicon: "", loading: false, scrollY: 0, pinned: false }],
    }),
  );
}

const seedSettings = (over: Record<string, unknown>) =>
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(over));

const buttons = (h: { container: HTMLElement }) =>
  [...h.container.querySelectorAll("button")] as HTMLButtonElement[];

const addressBar = (h: { container: HTMLElement }) =>
  h.container.querySelector("input.pl-10") as HTMLInputElement;

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";

const storedTabUrl = () =>
  (JSON.parse(window.localStorage.getItem(TABS_KEY) ?? "{}") as { data: Array<{ url: string }> }).data[0]!.url;

const homeBtn = (h: { container: HTMLElement }) =>
  buttons(h).find((b) => b.getAttribute("aria-label") === zh["webman.a11y.home"]);

/** 该控件此前**不存在** —— 这就是本轮的缺陷。 */
const homepageInput = (h: { container: HTMLElement }) =>
  h.container.querySelector(`input[aria-label="${zh["webman.homepage"]}"]`) as HTMLInputElement | null;

const homepageSaveBtn = (h: { container: HTMLElement }) =>
  buttons(h).find((b) => b.getAttribute("aria-label") === zh["webman.homepageSave"]);

async function openSettings(h: { container: HTMLElement }) {
  const menuBtn = buttons(h).find((b) => b.getAttribute("aria-label") === zh["webman.a11y.menu"]);
  await fireEvent.click(menuBtn!);
  await settle();
  const entry = buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.settings"]));
  await fireEvent.click(entry!);
  await settle();
}

/** 渲染 + 打开设置面板 + 把主页改成 `value` 并提交。 */
async function setHomepage(h: { container: HTMLElement }, value: string) {
  await openSettings(h);
  const input = homepageInput(h);
  if (!input) throw new Error("设置面板里没有改「主页」的输入框");
  await fireEvent.input(input, { target: { value } });
  await fireEvent.click(homepageSaveBtn(h)!);
  await settle();
}

describe("REQ-A1215: 「主页」得有人写得进去（在此之前它的唯一生产者是测试夹具）", () => {
  test("面板里那个控件能把主页设成用户输入的地址，🏠 随后就去那儿", async () => {
    seedTab(PAGE);
    seedSettings({});
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    await openSettings(host);
    const input = homepageInput(host);
    // 修前这里就是空的：`homepage` 有读者、没有写者 —— 用户改不了这个值。
    expect(input).toBeTruthy();

    await fireEvent.input(input!, { target: { value: HOME } });
    await fireEvent.click(homepageSaveBtn(host)!);
    await settle();

    await fireEvent.click(homeBtn(host)!);
    await settle();

    expect(addressBar(host).value).toBe(HOME);
    expect(storedTabUrl()).toBe(HOME);
  });

  test("非法地址被如实拒绝：报错、不动已生效的主页（也不给 🏠 换目的地）", async () => {
    seedTab(PAGE);
    seedSettings({ homepage: HOME });
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    await setHomepage(host, "javascript:alert(1)");

    // 说了话（不是静默地把垃圾当成主页），而且没有说「已保存」。
    expect(txt(host)).not.toContain(zh["webman.toast.homepageSaved"]);
    expect(loadSettings().homepage).toBe(HOME);

    await fireEvent.click(homeBtn(host)!);
    await settle();
    expect(addressBar(host).value).toBe(HOME);
    expect(storedTabUrl()).toBe(HOME);
  });

  test("设过的值落盘，并且跨渲染活着", async () => {
    seedTab(PAGE);
    seedSettings({ homepage: HOME });
    setFormFactor("desktop");
    const first = render(WebManApp);
    await settle();
    await setHomepage(first, OTHER);

    expect(loadSettings().homepage).toBe(OTHER);

    // 重新挂载一次：值来自存储，不是某一次点击留在内存里的痕迹。
    cleanup();
    setFormFactor("desktop");
    const second = render(WebManApp);
    await settle();
    await fireEvent.click(homeBtn(second)!);
    await settle();
    expect(addressBar(second).value).toBe(OTHER);
  });

  test("没打 scheme 时按 https 处理（那一格不必逼用户手打协议）", async () => {
    seedTab(PAGE);
    seedSettings({ homepage: HOME });
    setFormFactor("desktop");
    const host = render(WebManApp);
    await settle();

    await setHomepage(host, "127.0.0.1:8");
    expect(loadSettings().homepage).toBe(OTHER_SSL);

    await fireEvent.click(homeBtn(host)!);
    await settle();
    expect(addressBar(host).value).toBe(OTHER_SSL);
  });
});
