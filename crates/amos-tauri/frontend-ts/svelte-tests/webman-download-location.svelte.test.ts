/**
 * webman-download-location.svelte.test.ts — 宿主在每次进度事件里都报「文件落在哪里」，
 * 而界面从来没读过（REQ-A1367 / FMEA F-SH-631）。
 *
 * `DownloadProgressEvent.location`（`lib/webmanDownloads.ts`）不只是一个必填字段：
 * `asProgressEvent` 把它**当成校验的一部分** —— `typeof p.location !== "string"` 就
 * `return null`，**整条事件被丢掉**。所以宿主为它花的功夫，是"没有它连进度都不会到达 UI"
 * 的那种重量。字段的语义写在类型注释里：「Where the transfer is landing. Desktop /
 * non-Android: an absolute file path. Android: the MediaStore `content://` URI」。
 *
 * 而它**一个读者都没有**：面板把 `Download` 行画成文件名 + 域名 + 徽章 ∕ 进度条 + 字节数
 * （`downloadBytes`）+ 失败原因（`downloadErrors`），唯独没有"这个文件去哪了" —— 桌面系统上
 * 一次下载完成后，用户从列表里**找不到**他的文件。宿主在 Rust 侧已经把这件事查得一清二楚
 * （`webman_download.rs::run_job` 的 `emit` 收一个 `location: String`），却在最后一跳丢掉。
 * 同族：REQ-A1171 / F-SH-466（失败原因曾经也没读者）。
 *
 * **难一层：只有 `completed` 报的位置指的是一个**还在那儿**的文件。** Rust 侧逐支摆着
 * （`run_job` 的 `match outcome`）：`Completed` ⇒ `placed.location`（`DirSink` 给
 * `dest`，`MediaStoreSink` 给 `item.uri` —— 见 `place` 的注释「report the name it adopted,
 * not the one we proposed」）；`Failed` ∕ `Canceled` ∕ `Downloading` ⇒ `part.to_string_lossy()`
 * —— 那是 `.part` 暂存路径，而且 `let _ = std::fs::remove_file(&part);` 就在 emit **之前**跑
 * （失败 ∕ 取消两支），或（下载中那支）文件还在被写、名字也还会变。把这三种位置画出来，
 * 就是在替一个**不存在的文件**、或一个**会被改名/替换的中间名字**背书。
 *
 * 所以修法只有一条：**在 `completed` 那一支把事件里的位置记下来**，随行落盘（与
 * `downloadErrors` 那条"只在内存"的取舍相反 —— 完成的文件是**留在**盘上的，重启后那条行
 * 说的仍是真话），再在那一行下面画出来；`downloading` ∕ `failed` ∕ `canceled` 一个字不说。
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
  /** 宿主在 `completed` 时报回来的落点（本轮的读者）。 */
  location?: string;
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
const emit = (
  e: Partial<DownloadProgressEvent> & { id: string; status: DownloadProgressEvent["status"] },
) => sink!({ received: 0, total: 0, error: null, location: "", ...e } as DownloadProgressEvent);

/** 完成事件报回来的落点：一个真的在那儿等着用户去打开的文件。 */
const SAVED_TO = "/home/u/Downloads/a.bin";
/** 其余各支报回来的落点：`run_job` 里的 `.part` 暂存路径（文件已被删或还会被改名）。 */
const PART_PATH = "/tmp/amos/a.bin.part";

const ROW: Row = {
  id: "d-1",
  url: "http://127.0.0.1:1/a.bin",
  filename: "a.bin",
  progress: 42,
  status: "downloading",
  createdAt: 1,
};

/** 存储行的真身：`loadDownloads` 每次读出一份**拷贝**。 */
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
  // 与真 `updateDownload` 同形：四个参数，第四个只在自己是字符串时才落进行里。
  updateDownload.mockImplementation(
    (id: string, progress: number, status?: string, location?: string) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return false;
      row.progress = progress;
      if (status) row.status = status;
      if (typeof location === "string") row.location = location;
      return true;
    },
  );
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

describe("WebManApp — 下载完成后的落点被读到（REQ-A1367 / F-SH-631）", () => {
  test("完成事件带着落点 ⇒ 那一行把文件**在哪**说出来", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "completed", received: 999, total: 999, location: SAVED_TO });
    await settle();

    expect(txt(h)).toContain(SAVED_TO);
  });

  test("落点随行落盘（完成的文件是**留在**盘上的，重启后那条行说的仍是真话）", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "completed", received: 999, total: 999, location: SAVED_TO });
    await settle();

    expect(rows[0]!.location).toBe(SAVED_TO);
  });

  test("存储行**已带着**落点（上一次会话留下的）⇒ 面板照旧说出来", async () => {
    rows = [{ ...ROW, progress: 100, status: "completed", location: SAVED_TO }];
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    expect(txt(h)).toContain(SAVED_TO);
  });

  test("「下载中」报的落点是 `.part` 暂存路径 ⇒ 一个字不说（文件还在写、名字还会变）", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "downloading", received: 500, total: 999, location: PART_PATH });
    await settle();

    expect(txt(h)).not.toContain(PART_PATH);
  });

  test("失败事件报的落点那个文件**已被删掉**（`remove_file` 就在 emit 前）⇒ 一个字不说", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "failed", received: 0, total: 999, location: PART_PATH });
    await settle();

    expect(txt(h)).not.toContain(PART_PATH);
  });
});
