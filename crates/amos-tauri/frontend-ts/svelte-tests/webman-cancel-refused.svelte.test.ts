/**
 * webman-cancel-refused.svelte.test.ts — 「取消」必须**读**宿主的答复（REQ-A1074 / FMEA F-SH-389）。
 *
 * `cancelDownload` → `crates/amos-tauri/src/webman_download.rs::webman_download_cancel`：
 * 宿主对**它没有的 id** 回 `false` —— 取消标志只在传输存续期内存在（`begin` 里 insert、
 * 作业结束时 `take_cancel`），所以 `false` 是一句**事实**：这次传输不在跑。
 *
 * 最常见的情形是**重启**：下载行是从存储重画出来的（`loadDownloads`），而传输只活在宿主的
 * **内存**里（`WebmanDownloads`），进程一重启就没了。屏幕于是永远显示一条「下载中」和一颗
 * 按下去毫无反应的「取消」。修前 `onclick={() => void cancelDownload(download.id)}` 把这个
 * 答复整个丢掉（`void`）⇒ 界面一直替一次不存在的传输背书。
 *
 * 本文件把两半都钉住，且**两向**都钉：宿主说「没有这次传输」⇒ 行收尾成可恢复的 `failed`
 * （长出「重试」）并如实说一句／宿主收下了 ⇒ 行**不动**、嘴上什么都不说（终态事件才是权威）；
 * 收尾写入若也被存储拒了 ⇒ 说另一句，别假装标好了。
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
const cancelDownload = vi.hoisted(() => vi.fn(async () => false));
const listCookies = vi.hoisted(() => vi.fn(async () => []));
const onDownloadProgress = vi.hoisted(() => vi.fn(async () => () => {}));
const loadDownloads = vi.hoisted(() => vi.fn(() => [] as Row[]));
const updateDownload = vi.hoisted(() => vi.fn(() => true));

const LIVED: Row = {
  id: "d-live",
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
  rows = [{ ...LIVED }];
  loadDownloads.mockImplementation(() => rows.map((r) => ({ ...r })));
  updateDownload.mockImplementation((id: string, progress: number, status?: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return false;
    row.progress = progress;
    if (status) row.status = status;
    return true;
  });
  cancelDownload.mockResolvedValue(false);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  startDownload.mockReset();
  updateDownload.mockReset();
  loadDownloads.mockReset();
  cancelDownload.mockReset();
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

describe("WebManApp — 取消：读宿主的答复", () => {
  test("宿主没有这次传输 ⇒ 行不再「下载中」（长出「重试」），并如实说一句", async () => {
    cancelDownload.mockResolvedValue(false);
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    const cancel = btnByAria(h, zh["webman.download.cancel"])!;
    expect(cancel, "下载中的行应有「取消」按钮").toBeTruthy();
    await fireEvent.click(cancel);
    await settle();

    expect(txt(h)).toContain(zh["webman.download.cancelInterrupted"]);
    expect(btnByAria(h, zh["webman.download.cancel"]), "不该再挂着「取消」").toBeUndefined();
    expect(btnByAria(h, zh["webman.download.retry"]), "应换成可恢复的「重试」").toBeTruthy();
  });

  test("宿主收下了取消 ⇒ 行**不动**、嘴上什么都不说（终态事件才是权威）", async () => {
    cancelDownload.mockResolvedValue(true);
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    await fireEvent.click(btnByAria(h, zh["webman.download.cancel"])!);
    await settle();

    expect(btnByAria(h, zh["webman.download.cancel"]), "宿主收下 ⇒ 行仍由终态事件收尾").toBeTruthy();
    expect(txt(h)).not.toContain(zh["webman.download.cancelInterrupted"]);
    expect(txt(h)).not.toContain(zh["webman.download.cancelFailed"]);
  });

  test("宿主没有这次传输、而收尾写入又被存储拒了 ⇒ 说另一句，别假装标好了", async () => {
    cancelDownload.mockResolvedValue(false);
    updateDownload.mockReturnValue(false);
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    await fireEvent.click(btnByAria(h, zh["webman.download.cancel"])!);
    await settle();

    expect(txt(h)).toContain(zh["webman.download.cancelFailed"]);
    expect(txt(h)).not.toContain(zh["webman.download.cancelInterrupted"]);
  });
});
