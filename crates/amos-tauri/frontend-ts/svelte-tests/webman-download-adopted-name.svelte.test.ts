/**
 * webman-download-adopted-name.svelte.test.ts —— 宿主报的是**它实际采用的那个文件名**，
 * 而界面从来没读过（REQ-A1370 / FMEA F-SH-634）。
 *
 * `DownloadProgressEvent.filename`（`lib/webmanDownloads.ts`）和上一个字段（`location`，
 * REQ-A1367）是同一种东西：`asProgressEvent` 把它**当成校验的一部分** ——
 * `typeof p.filename !== "string"` 就 `return null`，**整条事件被丢掉**。也就是说宿主为它
 * 花的功夫，是"没有它连进度都不会到达 UI"的那种重量。
 *
 * 而它**一个读者都没有**：下载行画的是 `Download.filename`（存储行里那一位），而那一行是
 * **我们提议的**名字 —— `downloadCurrentPage` 把 `activeTab.title || url` 交给 `addDownload`。
 * 名字在宿主那边会被改两次：`sanitize_filename`（真写盘前）和目的地自己（
 * `MediaStoreSink` 在重名时追加 ` (1)`，`record` 那一行的注释逐字写着
 * 「**report the name it adopted, never the one we proposed, or the UI shows a name the
 * device does not have**」—— 点名了本轮的界面后果）。宿主把采用名一路报了出来，界面的
 * 最后一跳丢掉它，于是那一行一直显示一个**设备上不存在**的名字。
 *
 * **难一层：只有 `completed` 那一支报的名字是"它有的那个"。** `run_job` 的 `emit` 收一个
 * `adopted: Option<String>`，只有 `Completed` 传 `placed.filename`；其余各支传 `None` ⇒
 * 报的是 `run_job` 收到的那份**提议名**（`sanitize_filename` 之后）。而下载中的文件还在
 * `.part` 上、名字在 `place` 之前还会变（MediaStore 的重名改名就发生在那一刻）。所以修法
 * 只有一条：**在 `completed` 那一支把事件里的名字记下来**，其余各支一个字不动。
 *
 * 同族的最后一跳：`DirSink`（桌面路径）此前报 `None`（="你要的就是它有的那个"），而
 * `pick_path` 在重名时明明把它改成了 `report (1).pdf` —— 同一个说法两个 sink 只兑现了一半，
 * 由 `crates/amos-tauri/src/webman_download.rs` 的 Rust 测试守着。
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
  location?: string;
};

const startDownload = vi.hoisted(() => vi.fn(async () => null));
const cancelDownload = vi.hoisted(() => vi.fn(async () => false));
const listCookies = vi.hoisted(() => vi.fn(async () => []));
const onDownloadProgress = vi.hoisted(() => vi.fn());
const loadDownloads = vi.hoisted(() => vi.fn(() => [] as Row[]));
const updateDownload = vi.hoisted(() => vi.fn(() => true));
const removeDownload = vi.hoisted(() => vi.fn(() => true));

/** 宿主进度事件：订阅时把回调存下，测试里 `emit()` 直接喂事件。 */
let sink: ((e: DownloadProgressEvent) => void) | null = null;
const emit = (
  e: Partial<DownloadProgressEvent> & { id: string; status: DownloadProgressEvent["status"] },
) => sink!({ received: 0, total: 0, error: null, location: "", filename: "", ...e } as DownloadProgressEvent);

/** 我们提议的名字（`downloadCurrentPage` 存进那一行的）。 */
const PROPOSED = "report.pdf";
/** 目的地**采用**的名字：重名时 MediaStore ∕ `pick_path` 追加 ` (1)`（"report (1).pdf" 不含 "report.pdf"）。 */
const ADOPTED = "report (1).pdf";

const ROW: Row = {
  id: "d-1",
  url: "http://127.0.0.1:1/download",
  filename: PROPOSED,
  progress: 100,
  status: "completed",
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
  // 与真 `updateDownload` 同形：第五个参数（采用名）只在自己是字符串时才落进行里。
  updateDownload.mockImplementation(
    (id: string, progress: number, status?: string, location?: string, filename?: string) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return false;
      row.progress = progress;
      if (status) row.status = status;
      if (typeof location === "string") row.location = location;
      if (typeof filename === "string") row.filename = filename;
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

describe("WebManApp — 下载行显示的是宿主**采用**的名字（REQ-A1370 / F-SH-634）", () => {
  test("完成事件报的名字与行里不同 ⇒ 那一行说的是**它有的那个**，不是我们提议的", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);
    expect(txt(h)).toContain(PROPOSED);

    emit({ id: "d-1", status: "completed", received: 999, total: 999, filename: ADOPTED });
    await settle();

    expect(txt(h)).toContain(ADOPTED);
    expect(txt(h)).not.toContain(PROPOSED);
  });

  test("采用名随行落盘（重启后那一行说的仍是它有的那个名字）", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "completed", received: 999, total: 999, filename: ADOPTED });
    await settle();

    expect(rows[0]!.filename).toBe(ADOPTED);
  });

  test("存储行**已带着**采用名（上一次会话留下的）⇒ 面板照旧画出来", async () => {
    rows = [{ ...ROW, filename: ADOPTED }];
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    expect(txt(h)).toContain(ADOPTED);
  });

  test("「下载中」事件报的名字是我**们提议的**那一份 ⇒ 不动行里的名字", async () => {
    // 行里存的是页面标题（`downloadCurrentPage` 的提议），事件里是宿主 `sanitize_filename`
    // 之后的那一份 —— 两个都不是"目的地采用的名字"，所以这一支**不是**名字的权威。
    rows = [{ ...ROW, filename: "Example Domain", progress: 40, status: "downloading" }];
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "downloading", received: 400, total: 999, filename: "Example_Domain" });
    await settle();

    expect(rows[0]!.filename).toBe("Example Domain");
    expect(txt(h)).not.toContain("Example_Domain");
  });

  test("失败事件同理（`adopted` 只在该支为 `None`）⇒ 不动行里的名字", async () => {
    rows = [{ ...ROW, filename: "Example Domain", progress: 0, status: "downloading" }];
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "failed", received: 0, total: 999, error: "HTTP 404", filename: "Example_Domain" });
    await settle();

    expect(rows[0]!.filename).toBe("Example Domain");
    expect(txt(h)).not.toContain("Example_Domain");
  });
});
