/**
 * webman-remove-download.svelte.test.ts — 删一条**在跑**的下载，必须先请宿主停下（REQ-A1317）。
 *
 * 修前 `removeDownloadEntry` 就是一句 `removeDownload(id)`：把行从列表里删掉，**传输照跑**。
 * 后果不是"多下了一个文件"，而是三个面同时说谎 ——
 *   • 宿主继续写盘、继续发进度事件；
 *   • `applyProgress` 折进的那一行**已经不在了**（`updateDownload` 判定 "Download not
 *     found"、被丢弃）；
 *   • 屏幕上彻底看不见这次传输，而字节还在流。
 * 用户以为点 ✕ 就停了。
 *
 * 本文件也钉住站点数据的「没能问」与「没有」分得开（REQ-A1318）—— 两件事共用同一个
 * `webmanDownloads` 桥，所以放在同一个文件里才测得到真实的 mock 形状。
 *
 * 第三件事（REQ-A1383 / FMEA F-SH-646）：`removeDownload` 的**另一半**答复。`removeDownloadEntry`
 * 读了它（`if (removeDownload(id)) { … 播报「删除」 }`），却**没有 `else`** —— 存储三次重试都没
 * 落盘时，行留在屏幕上、一个字也**没有**。同一个文件里另外四处同类动作（书签行的 ✕ REQ-A1258、
 * `clearHistory` REQ-A1330、`onClearCompleted`、以及 `removeDownloadEntry` 自己的
 * `removeNotAsked` 那一支）都是**两向都说话**：一次没生效的删除必须说出口，否则它与一颗坏掉的
 * 按钮在屏幕上一模一样。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY } from "../src/lib/webman";
import { setFormFactor } from "../src/lib/formAuthority.svelte";
import { zh } from "../src/i18n/locales/zh";

type Row = {
  id: string;
  url: string;
  filename: string;
  progress: number;
  status: string;
  createdAt: number;
};

const startDownload = vi.hoisted(() => vi.fn(async () => null));
const cancelDownload = vi.hoisted(() => vi.fn(async () => false));
const listCookies = vi.hoisted(() => vi.fn(async (): Promise<unknown> => []));
const clearCookies = vi.hoisted(() => vi.fn(async (): Promise<unknown> => 0));
const onDownloadProgress = vi.hoisted(() => vi.fn(async () => () => {}));
const loadDownloads = vi.hoisted(() => vi.fn(() => [] as Row[]));
const removeDownload = vi.hoisted(() => vi.fn(() => true));

/** 调用顺序的记录 —— "先请宿主停、再删行"是本条的要害，只看"有没有调用"不够。 */
let calls: string[];

const LIVE: Row = {
  id: "d-live",
  url: "http://127.0.0.1:1/a.bin",
  filename: "a.bin",
  progress: 42,
  status: "downloading",
  createdAt: 1,
};
const DONE: Row = {
  id: "d-done",
  url: "http://127.0.0.1:1/b.bin",
  filename: "b.bin",
  progress: 100,
  status: "completed",
  createdAt: 2,
};

let rows: Row[];

vi.mock("../src/lib/webmanDownloads", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, startDownload, cancelDownload, listCookies, clearCookies, onDownloadProgress };
});

vi.mock("../src/lib/webman", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, loadDownloads, removeDownload };
});

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  setFormFactor("desktop");
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [
        { id: "tab-1", url: "http://127.0.0.1:1/", title: "A", favicon: "", loading: false, scrollY: 0, pinned: false },
      ],
    }),
  );
  rows = [{ ...LIVE }, { ...DONE }];
  calls = [];
  // `afterEach` 会把所有 mock 复位（含实现），所以每次都要重新装上默认实现 ——
  // 少装一个，`onMount` 里 `onDownloadProgress(...).then(...)` 就会对 `undefined` 取 `.then`。
  startDownload.mockImplementation(async () => null);
  onDownloadProgress.mockImplementation(async () => () => {});
  loadDownloads.mockImplementation(() => rows.map((r) => ({ ...r })));
  removeDownload.mockImplementation((id: string) => {
    calls.push(`remove:${id}`);
    const i = rows.findIndex((r) => r.id === id);
    if (i === -1) return false;
    rows.splice(i, 1);
    return true;
  });
  cancelDownload.mockImplementation(async (id: string) => {
    calls.push(`cancel:${id}`);
    return true;
  });
  listCookies.mockResolvedValue([]);
  clearCookies.mockResolvedValue(0);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  setFormFactor(null);
  for (const m of [startDownload, cancelDownload, listCookies, clearCookies, onDownloadProgress, loadDownloads, removeDownload]) {
    m.mockReset();
  }
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
/** 删行那颗 ✕ —— 用 aria-label（不是字形 ✕，标签条的关闭钮也有同一字形）。 */
const removeButtons = (h: { container: HTMLElement }) =>
  buttons(h).filter((b) => b.getAttribute("aria-label") === zh["webman.download.remove"]);

async function openPanel(h: { container: HTMLElement }, label: string) {
  await fireEvent.click(btnByAria(h, zh["webman.a11y.menu"])!);
  await settle();
  await fireEvent.click(buttons(h).find((b) => (b.textContent ?? "").includes(label))!);
  await settle();
}

describe("REQ-A1317: 删除在跑的下载 ⇒ 先请宿主停下", () => {
  test("删一条「下载中」的行：cancel 先于 remove（顺序是 load-bearing 的）", async () => {
    const h = render(WebManApp);
    await settle();
    await openPanel(h, zh["webman.downloads"]);

    expect(removeButtons(h).length, "两条下载各有一颗 ✕").toBe(2);
    // 第一行是仍在跑的 d-live。
    await fireEvent.click(removeButtons(h)[0]!);
    await settle();

    expect(calls).toEqual(["cancel:d-live", "remove:d-live"]);
    expect(txt(h)).toContain(zh["webman.download.remove"]);
  });

  test("删一条「已完成」的行：**不**发取消（它本来就不在跑，别打扰宿主）", async () => {
    const h = render(WebManApp);
    await settle();
    await openPanel(h, zh["webman.downloads"]);

    await fireEvent.click(removeButtons(h)[1]!);
    await settle();

    expect(calls).toEqual(["remove:d-done"]);
  });

  test("宿主说「没有这次传输」也照样删掉那一行（行消失与宿主状态无关）", async () => {
    cancelDownload.mockImplementation(async (id: string) => {
      calls.push(`cancel:${id}`);
      return false;
    });
    const h = render(WebManApp);
    await settle();
    await openPanel(h, zh["webman.downloads"]);

    await fireEvent.click(removeButtons(h)[0]!);
    await settle();

    expect(calls).toEqual(["cancel:d-live", "remove:d-live"]);
    expect(rows.some((r) => r.id === "d-live")).toBe(false);
  });
});

describe("REQ-A1318: 站点数据 —— 「没能问」不是「没有」", () => {
  test("宿主没作答（null）⇒ 画「无法读取」，不是「空 jar」", async () => {
    listCookies.mockResolvedValue(null);
    const h = render(WebManApp);
    await settle();
    await openPanel(h, zh["webman.settings"]);

    expect(txt(h)).toContain(zh["webman.siteData.unavailable"]);
    expect(txt(h), "不许把没问到的 jar 说成空的").not.toContain(zh["webman.siteData.empty"]);
  });

  test("宿主作答「空数组」⇒ 仍是空态（真的没有 ≠ 没能问）", async () => {
    listCookies.mockResolvedValue([]);
    const h = render(WebManApp);
    await settle();
    await openPanel(h, zh["webman.settings"]);

    expect(txt(h)).toContain(zh["webman.siteData.empty"]);
    expect(txt(h)).not.toContain(zh["webman.siteData.unavailable"]);
  });

  test("清空被宿主沉默 ⇒ 说「未能清除」，不说「已清除」", async () => {
    listCookies.mockResolvedValue([{ name: "sid", value: "x", domain: "example.com", path: "/", secure: false, httpOnly: false }]);
    clearCookies.mockResolvedValue(null);
    const h = render(WebManApp);
    await settle();
    await openPanel(h, zh["webman.settings"]);

    const clear = buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.siteData.clear"]));
    expect(clear, "jar 非空时才有清除按钮").toBeTruthy();
    await fireEvent.click(clear!);
    await settle();

    expect(txt(h)).toContain(zh["webman.cookies.clearFailed"]);
    expect(txt(h)).not.toContain(zh["webman.cookies.cleared"]);
  });

  test("清空被宿主确认 ⇒ 说「已清除」", async () => {
    listCookies.mockResolvedValue([{ name: "sid", value: "x", domain: "example.com", path: "/", secure: false, httpOnly: false }]);
    clearCookies.mockResolvedValue(1);
    const h = render(WebManApp);
    await settle();
    await openPanel(h, zh["webman.settings"]);

    await fireEvent.click(
      buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.siteData.clear"]))!,
    );
    await settle();

    expect(txt(h)).toContain(zh["webman.cookies.cleared"]);
    expect(txt(h)).not.toContain(zh["webman.cookies.clearFailed"]);
  });
});

describe("REQ-A1383: 存储拒了这次删除 ⇒ 必须说出来（一次没生效的删除不得静默）", () => {
  /** 存储三次重试都没落盘 —— `removeDownload` 回 `false`，行理应留在屏幕上。 */
  const refuseRemoval = () => {
    removeDownload.mockImplementation((id: string) => {
      calls.push(`remove:${id}`);
      return false;
    });
  };

  test("删一条「已完成」的行被拒 ⇒ 该行留着，且屏幕上有一句话（不是一颗坏按钮）", async () => {
    refuseRemoval();
    const h = render(WebManApp);
    await settle();
    await openPanel(h, zh["webman.downloads"]);

    expect(txt(h), "点之前不预置那句话").not.toContain(zh["webman.download.removeFailed"]);
    await fireEvent.click(removeButtons(h)[1]!);
    await settle();

    expect(calls).toEqual(["remove:d-done"]);
    expect(rows.some((r) => r.id === "d-done"), "拒写 ⇒ 这一行必须还在").toBe(true);
    expect(txt(h)).toContain(zh["webman.download.removeFailed"]);
  });

  test("删一条「下载中」的行被拒（先请宿主停、再删）⇒ 同样说出来，行仍在", async () => {
    refuseRemoval();
    const h = render(WebManApp);
    await settle();
    await openPanel(h, zh["webman.downloads"]);

    await fireEvent.click(removeButtons(h)[0]!);
    await settle();

    expect(calls, "顺序不变：先 cancel 再 remove").toEqual(["cancel:d-live", "remove:d-live"]);
    expect(rows.some((r) => r.id === "d-live")).toBe(true);
    expect(txt(h)).toContain(zh["webman.download.removeFailed"]);
  });

  test("对照：删**成功**时说「删除」，绝不说失败那一句", async () => {
    const h = render(WebManApp);
    await settle();
    await openPanel(h, zh["webman.downloads"]);

    await fireEvent.click(removeButtons(h)[1]!);
    await settle();

    expect(rows.some((r) => r.id === "d-done")).toBe(false);
    expect(txt(h), "成功的那一次不许说失败").not.toContain(zh["webman.download.removeFailed"]);
  });
});
