/**
 * webman-download-unknown-size.svelte.test.ts — 总量未知的下载不得印「0%」（REQ-A1613 / FMEA F-SH-822）。
 *
 * 宿主在**分块传输**（chunked，响应不带 `Content-Length`）上如实报 `total: null`
 * （`webman_download.rs::run_job` 逐字 `response.header("Content-Length").and_then(...)`，
 * 缺席即 `None`）。修前 `WebManApp.svelte::applyProgress` 把「说不出的百分比」折成行里那个 `0`
 * （`fromTotal ?? row?.progress ?? 0`），于是进度条与标签印「0%」—— 而**同一张卡**下面的字节行
 * （`bytes.total ? … : ""`）此刻正**不**印总数，一个事件两个面各说各话。
 *
 * 修法：`fromTotal` 未知时写 `null`（存储行类型 `number | null`），界面画一根**脉动的满宽条** +
 * 「大小未知」，只声称"在跑"、不声称"跑了多少"。
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
  progress: number | null;
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

/** 宿主进度事件的落点：订阅时把回调存下，测试里 `emit()` 直接喂事件。 */
let sink: ((e: DownloadProgressEvent) => void) | null = null;
const emit = (e: Partial<DownloadProgressEvent> & { id: string; status: DownloadProgressEvent["status"] }) =>
  sink!({ received: 0, total: 0, error: null, ...e } as DownloadProgressEvent);

/** 一行**刚开始**的下载：`addDownload` 给的就是 `progress: 0`（尚未收到任何进度事件）。 */
const ROW: Row = {
  id: "d-1",
  url: "http://127.0.0.1:1/a.bin",
  filename: "a.bin",
  progress: 0,
  status: "pending",
  createdAt: 1,
};

let rows: Row[];

vi.mock("../src/lib/webmanDownloads", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, startDownload, cancelDownload, listCookies, onDownloadProgress };
});

vi.mock("../src/lib/webman", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, loadDownloads, updateDownload, removeDownload };
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
  // 与真 `updateDownload` 同形：如实记录 `progress`（**包括 `null`**）。
  updateDownload.mockImplementation((id: string, progress: number | null, status?: string) => {
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
  removeDownload.mockImplementation((id: string) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return false;
    rows.splice(i, 1);
    return true;
  });
  startDownload.mockResolvedValue(null);
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

describe("WebManApp — 总量未知的下载不得印「0%」（REQ-A1613 / F-SH-822）", () => {
  test("分块响应（total: null）⇒ 不印 0%，改说「大小未知」", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    // 字节照实流进来（received > 0），但响应没有总长。
    emit({ id: "d-1", status: "downloading", received: 500, total: null });
    await settle();

    // 修前：`fromTotal ?? row?.progress ?? 0` ⇒ 0 ⇒ 印「0%」，而这一行其实已经在下载了。
    expect(txt(h)).not.toContain("0%");
    expect(txt(h)).toContain(zh["webman.download.sizeUnknown"]);
    // 那一行的进度条仍在（在跑），只是不声称跑了多少。
    expect(h.container.querySelector(".animate-pulse")).not.toBeNull();
  });

  test("总量已知 ⇒ 照旧印真实百分比，且不说「大小未知」（反向半边）", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "downloading", received: 50, total: 100 });
    await settle();

    expect(txt(h)).toContain("50%");
    expect(txt(h)).not.toContain(zh["webman.download.sizeUnknown"]);
  });
});
