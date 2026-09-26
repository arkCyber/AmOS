/**
 * webman-retry-single-flight.svelte.test.ts — 一次按键 = 一次传输：重试必须挡住重入，且写不进「重试中」就不许开跑（REQ-A1072 / FMEA F-SH-387）。
 *
 * `retryDownload`（`WebManApp.svelte`）把一条失败的行重新交给宿主。两件事会打破
 * 「一行 = 一次传输」：
 *
 * ①**重入**：行是从存储重读画出来的（`downloadsTick` → `$derived`），状态要等 Svelte 冲一次才
 *   落到 DOM —— 从「点下重试」到「重试按钮消失」之间有一个窗口，第二次点会落到**同一行**上。
 *   宿主对**已在传输中的 id** 不照用，而是**另铸一个新 id**
 *   （`crates/amos-tauri/src/webman_download.rs::begin`：只有 `!cancel.contains_key(candidate)`
 *   才照用调用方给的 id）。而进度事件按 `event.id` 折进存储行（`applyProgress` →
 *   `updateDownload(event.id, …)`），新 id 落不到任何一行 ⇒ 那次传输**没有行**：网络上多跑一趟、
 *   盘上多一个文件、完成事件被无声丢掉。
 * ②**不读判定**：`updateDownload(id, 0, "pending")` 有返回值（存储会拒写）。丢掉它，行就仍停在
 *   "failed"、重试按钮仍挂在屏幕上，而传输已经真的开跑 —— 用户以为没动，再点一次就撞上①。
 *
 * 本文件把两半都钉住，且**两向**都钉：重入被挡（只调一次）／窗口过后允许再点（不是永久锁死）；
 * 写不进就不开跑（有话说、`startDownload` 零调用）／写进就照常开跑。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY } from "../src/lib/webman";
import { zh } from "../src/i18n/locales/zh";

type Row = {
  id: string;
  url: string;
  filename: string;
  progress: number;
  status: string;
  createdAt: number;
};

const startDownload = vi.hoisted(() => vi.fn());
const cancelDownload = vi.hoisted(() => vi.fn(async () => true));
const listCookies = vi.hoisted(() => vi.fn(async () => []));
const onDownloadProgress = vi.hoisted(() => vi.fn(async () => () => {}));
const loadDownloads = vi.hoisted(() => vi.fn(() => [] as Row[]));
const updateDownload = vi.hoisted(() => vi.fn(() => true));

const FAILED: Row = {
  id: "d-failed",
  url: "http://127.0.0.1:1/b.bin",
  filename: "b.bin",
  progress: 0,
  status: "failed",
  createdAt: 1,
};

vi.mock("../src/lib/webmanDownloads", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, startDownload, cancelDownload, listCookies, onDownloadProgress };
});

vi.mock("../src/lib/webman", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, loadDownloads, updateDownload };
});

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.setItem(
    TABS_KEY,
    JSON.stringify({
      version: 1,
      data: [
        { id: "tab-1", url: "http://127.0.0.1:1/", title: "A", favicon: "", loading: false, scrollY: 0, pinned: false },
      ],
    }),
  );
  loadDownloads.mockReturnValue([FAILED]);
  updateDownload.mockReturnValue(true);
  startDownload.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  startDownload.mockReset();
  updateDownload.mockReset();
  loadDownloads.mockReset();
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 打开 ⋮ 菜单 → 点「下载」→ 下载面板出现。 */
async function openDownloadsPanel(h: { container: HTMLElement }) {
  await fireEvent.click(btnByAria(h, zh["webman.a11y.menu"])!);
  await settle();
  const item = buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.downloads"]));
  await fireEvent.click(item!);
  await settle();
}

describe("WebManApp — 重试：一次按键 = 一次传输", () => {
  test("连点两次「重试」⇒ 宿主只被交给一次（第一次还在飞时第二次被挡住）", async () => {
    const d = deferred<null>();
    startDownload.mockReturnValue(d.promise);
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    const retry = btnByAria(h, zh["webman.download.retry"])!;
    expect(retry, "失败行应有「重试」按钮").toBeTruthy();
    // 同一 tick 内两次派发：第一次的处理函数停在 await 上，第二次必须被挡下。
    fireEvent.click(retry);
    fireEvent.click(retry);
    await settle();

    expect(startDownload).toHaveBeenCalledTimes(1);
    expect(startDownload).toHaveBeenCalledWith(FAILED.url, FAILED.filename, FAILED.id);

    d.resolve(null);
    await settle();
  });

  test("第一次落地之后，再点仍可重试（守卫只覆盖在飞窗口，不是永久锁死）", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    const retry = btnByAria(h, zh["webman.download.retry"])!;
    await fireEvent.click(retry);
    await settle();
    // 行仍是 failed（本用例的存储替身不改行），按钮还在 —— 重试必须仍然可用。
    const retry2 = btnByAria(h, zh["webman.download.retry"])!;
    await fireEvent.click(retry2);
    await settle();

    expect(startDownload).toHaveBeenCalledTimes(2);
  });

  test("存储拒了「重试中」这次写入 ⇒ 说一句，且一次都**不**交给宿主", async () => {
    updateDownload.mockReturnValue(false);
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    await fireEvent.click(btnByAria(h, zh["webman.download.retry"])!);
    await settle();

    expect(startDownload).not.toHaveBeenCalled();
    expect(txt(h)).toContain(zh["webman.download.retryNotRecorded"]);
    expect(txt(h)).not.toContain(zh["webman.download.downloadAddedFailed"]);
  });

  test("存储收下了 ⇒ 照常开跑，且不误报（反向半边）", async () => {
    startDownload.mockResolvedValue({ id: FAILED.id, url: FAILED.url, filename: FAILED.filename, location: "/tmp/b.bin" });
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    await fireEvent.click(btnByAria(h, zh["webman.download.retry"])!);
    await settle();

    expect(startDownload).toHaveBeenCalledTimes(1);
    expect(txt(h)).not.toContain(zh["webman.download.retryNotRecorded"]);
    expect(txt(h)).not.toContain(zh["webman.download.downloadAddedFailed"]);
  });
});

/**
 * 失败落不下去时说什么（REQ-A1344 / FMEA F-SH-609）。
 *
 * 两条「宿主没开始」的路 —— 首次下载（`downloadCurrentPage`）与重试（`retryDownload`）——
 * 都要把行收尾成 `failed`，而那次写入**有返回值**。丢弃它，存储拒写时行就停在 `pending`：
 * 面板永远显示「等待中」和一颗「取消」，替一次宿主根本没开始的传输背书，而那句失败提示
 * 3 秒后就从屏幕上消失了。兄弟 `onCancelDownload` 读的正是这个判定。
 */
describe("WebManApp — 失败收尾写入被拒时要如实说", () => {
  test("重试：宿主没开始、而「失败」也写不进 ⇒ 说另一句，不假装标好了", async () => {
    startDownload.mockResolvedValue(null);
    // 只拒**收尾那次**（status === "failed"）：重试路径先写一次 "pending"，那一次是另一个
    // 判定（`retryNotRecorded`，见上一个 describe）。两处都拒会让用例走岔路。
    updateDownload.mockImplementation((_id: string, _p: number, status?: string) => status !== "failed");
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    await fireEvent.click(btnByAria(h, zh["webman.download.retry"])!);
    await settle();

    expect(txt(h)).toContain(zh["webman.download.failureNotRecorded"]);
    expect(txt(h)).not.toContain(zh["webman.download.downloadAddedFailed"]);
  });

  test("重试：写进去了 ⇒ 说「无法添加下载」（对照，不是一律报失败）", async () => {
    startDownload.mockResolvedValue(null);
    updateDownload.mockReturnValue(true);
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    await fireEvent.click(btnByAria(h, zh["webman.download.retry"])!);
    await settle();

    expect(txt(h)).toContain(zh["webman.download.downloadAddedFailed"]);
    expect(txt(h)).not.toContain(zh["webman.download.failureNotRecorded"]);
  });

  test("首次下载：宿主没开始、而「失败」也写不进 ⇒ 说另一句", async () => {
    startDownload.mockResolvedValue(null);
    updateDownload.mockImplementation((_id: string, _p: number, status?: string) => status !== "failed");
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    const start = buttons(h).find((b) =>
      (b.textContent ?? "").includes(zh["webman.download.downloadCurrent"]),
    )!;
    expect(start, "下载面板应有「下载当前页」").toBeTruthy();
    await fireEvent.click(start);
    await settle();

    expect(txt(h)).toContain(zh["webman.download.failureNotRecorded"]);
    expect(txt(h)).not.toContain(zh["webman.download.downloadAddedFailed"]);
  });
});
