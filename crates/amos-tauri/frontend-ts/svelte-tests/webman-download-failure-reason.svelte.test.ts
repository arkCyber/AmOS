/**
 * webman-download-failure-reason.svelte.test.ts — 失败的行必须把**宿主给的理由**读出来（REQ-A1171 / FMEA F-SH-466）。
 *
 * `webman_download.rs::EVENT_PROGRESS` 在失败时带 `error: Some(e)`（写盘错误）或
 * `Some(e.message.clone())`（传输错误），`webmanDownloads.ts::asProgressEvent` 逐字段收窄
 * （非字符串归一为 `null`），`DownloadProgressEvent.error` 的契约写着「只在 failed 时出现」。
 * 可是**没有读者**：`applyProgress` 把事件整个折进存储行，而 `Download` 行上没有 error 字段，
 * 于是理由一路丢到 `/dev/null` —— 屏幕只说「失败」，不说**为什么**。这条通道从宿主发出、
 * 经桥接校验、有测试钉住，却没有一端渲染它。
 *
 * 本文件把「读」钉住，并把**两向**都钉：宿主给了理由 ⇒ 行上照实显示（不编）；宿主没给
 * （`null`）⇒ 嘴上什么都不说（不编一个「未知错误」）；重试 ⇒ 上一次的理由收走（它说的是
 * 上一次那次传输）；删除 / 清除完成 ⇒ 那一格跟着行一起清掉，别在内存里留死条目。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import WebManApp from "../src/svelte/WebManApp.svelte";
import { TABS_KEY } from "../src/lib/webman";
import { zh } from "../src/i18n/locales/zh";
import type { DownloadProgressEvent } from "../src/lib/webmanDownloads";

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
const listCookies = vi.hoisted(() => vi.fn(async () => []));
const onDownloadProgress = vi.hoisted(() => vi.fn());
const loadDownloads = vi.hoisted(() => vi.fn(() => [] as Row[]));
const updateDownload = vi.hoisted(() => vi.fn(() => true));
const removeDownload = vi.hoisted(() => vi.fn(() => true));
const clearCompletedDownloads = vi.hoisted(() => vi.fn(() => true));

/** 宿主进度事件的落点：订阅时把回调存下，测试里 `emit()` 直接喂事件。 */
let sink: ((e: DownloadProgressEvent) => void) | null = null;
const emit = (e: Partial<DownloadProgressEvent> & { id: string; status: DownloadProgressEvent["status"] }) =>
  sink!({ received: 0, total: 0, error: null, ...e } as DownloadProgressEvent);

const ROW: Row = {
  id: "d-1",
  url: "http://127.0.0.1:1/a.bin",
  filename: "a.bin",
  progress: 42,
  status: "downloading",
  createdAt: 1,
};

/** 存储行的真身：`loadDownloads` 每次读出一份**拷贝**，`updateDownload` 改真身。 */
let rows: Row[];

vi.mock("../src/lib/webmanDownloads", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, startDownload, cancelDownload, listCookies, onDownloadProgress };
});

vi.mock("../src/lib/webman", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    loadDownloads,
    updateDownload,
    removeDownload,
    clearCompletedDownloads,
  };
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
  rows = [{ ...ROW }];
  sink = null;
  loadDownloads.mockImplementation(() => rows.map((r) => ({ ...r })));
  updateDownload.mockImplementation((id: string, progress: number, status?: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return false;
    row.progress = progress;
    if (status) row.status = status;
    return true;
  });
  onDownloadProgress.mockImplementation(async (cb: (e: DownloadProgressEvent) => void) => {
    sink = cb;
    return () => {};
  });
  startDownload.mockResolvedValue(null);
  removeDownload.mockReturnValue(true);
  clearCompletedDownloads.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  startDownload.mockReset();
  updateDownload.mockReset();
  loadDownloads.mockReset();
  cancelDownload.mockReset();
  onDownloadProgress.mockReset();
  removeDownload.mockReset();
  clearCompletedDownloads.mockReset();
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

/** 打开 ⋮ 菜单 → 点「下载」→ 下载面板出现。 */
async function openDownloadsPanel(h: { container: HTMLElement }) {
  await fireEvent.click(btnByAria(h, zh["webman.a11y.menu"])!);
  await settle();
  const item = buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.downloads"]));
  await fireEvent.click(item!);
  await settle();
}

describe("WebManApp — 失败原因：读宿主的答复", () => {
  test("宿主给了理由 ⇒ 行上照实显示（HTTP 404）", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "failed", error: "HTTP 404" });
    await settle();

    expect(txt(h)).toContain("HTTP 404");
    expect(txt(h)).toContain(zh["webman.download.failedReason"].replace("{reason}", "HTTP 404"));
  });

  test("宿主没给理由（null）⇒ 什么都不说，不编一个", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "failed", error: null });
    await settle();

    // 状态词还在（「失败」），但理由那一行不出现。
    expect(txt(h)).toContain(zh["webman.downloadStatus.failed"]);
    expect(txt(h)).not.toContain("失败原因");
  });

  test("重试 ⇒ 上一次的理由收走（它说的是上一次那次传输）", async () => {
    startDownload.mockResolvedValue(null); // 重试也接不上：行会再次 failed，但理由已清
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "failed", error: "HTTP 404" });
    await settle();
    expect(txt(h)).toContain("HTTP 404");

    await fireEvent.click(btnByAria(h, zh["webman.download.retry"])!);
    await settle();

    expect(txt(h)).not.toContain("HTTP 404");
  });

  test("删除那条行 ⇒ 理由跟着行一起清掉，不会漏到下一次同 id", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "failed", error: "HTTP 404" });
    await settle();
    await fireEvent.click(btnByAria(h, zh["webman.download.remove"])!);
    await settle();

    expect(txt(h)).not.toContain("HTTP 404");
  });
});
