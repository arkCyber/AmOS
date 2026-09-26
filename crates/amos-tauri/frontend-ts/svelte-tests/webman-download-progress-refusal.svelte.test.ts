/**
 * webman-download-progress-refusal.svelte.test.ts — 进度事件折进存储行时，写盘裁决也必须被读
 * （REQ-A1358 / FMEA F-SH-622）。
 *
 * 下载面板上其它每一条写入路径都读裁决：「重试」读 `updateDownload(id, 0, "pending")`（REQ-A1343
 * 前的 REQ-A1072）、`downloadCurrentPage` ∕ `retryDownload` 的收尾读它（REQ-A1344）、取消读
 * （`onCancelDownload`）、删除 ∕ 清除完成读（`removeDownload` ∕ `clearCompletedDownloads`）。
 * **只剩 `applyProgress` 一条没读** —— 宿主每来一次进度事件，它把事件折进存储行，然后
 * `downloadsTick++` 让面板重读。
 *
 * 后果不是"少一条记录"，而是**四个面同时说谎**：徽章 ∕ 进度条都从**存储行**画，拒写后行仍停在
 * 旧状态（「下载中」的条不动），而 `downloadBytes` 是**内存**读数、照涨不误 —— 屏幕上一根不动的
 * 条下面挂着一直在涨的字节数；传输其实在盘上跑完了，界面上永远不会说「已完成」，刷新之后那行
 * 还是旧的；而这是一个纯背景写入，没有任何 toast 会替它说话（F-SH-590 只交代了"行被删掉"那一支，
 * 从未区分"没这行"与"没写进去"）。
 *
 * 修法：`applyProgress` 把裁决读回来；**先分清两件事** —— 这一行**还在不在**本地列表里。不在
 * ⇒ 用户已经删掉它（REQ-A1317 会先请宿主停），这次事件本来就该被丢掉，`false` 是"没这行"而
 * 不是"没写进去"；在 ⇒ `false` 就是存储拒写，把话挂到下载面板顶部（`StoreErrorBar`）。
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

/** 存储行的真身：`loadDownloads` 每次读出一份**拷贝**。 */
let rows: Row[];
/** 存储此刻收不收写入。 */
let storeRefuses: boolean;

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
  storeRefuses = false;
  sink = null;
  loadDownloads.mockImplementation(() => rows.map((r) => ({ ...r })));
  // 与真 `updateDownload` 同形：**没这行**也回 false（这正是必须与「拒写」分开的那一支）。
  updateDownload.mockImplementation((id: string, progress: number, status?: string) => {
    if (storeRefuses) return false;
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
const storeErr = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="store-write-error"]');

/** 打开 ⋮ 菜单 → 点「下载」→ 下载面板出现。 */
async function openDownloadsPanel(h: { container: HTMLElement }) {
  await fireEvent.click(btnByAria(h, zh["webman.a11y.menu"])!);
  await settle();
  const item = buttons(h).find((b) => (b.textContent ?? "").includes(zh["webman.downloads"]));
  await fireEvent.click(item!);
  await settle();
}

describe("WebManApp — 进度事件的写盘裁决被读到（REQ-A1358 / F-SH-622）", () => {
  test("存储拒了这次进度写入 ⇒ 面板顶部说「存储写入失败」，且那一行**仍停在旧状态**", async () => {
    storeRefuses = true;
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "completed", received: 999, total: 999 });
    await settle();

    expect(storeErr(h)?.textContent).toContain(zh["common.storeWriteFailed"]);
    // 旧的形状：`updateDownload` 的 `false` 被丢掉 ⇒ 面板上除了"条没动"，一个字的解释都没有。
    // 行本身**确实**没变（拒写 ⇒ `loadDownloads` 读回旧值）—— 界面不得替它说「已完成」。
    expect(txt(h)).not.toContain(zh["webman.downloadStatus.completed"]);
    expect(txt(h)).toContain("42%");
  });

  test("存储收下了 ⇒ 那一行**真的**翻成「已完成」，且没有那句失败（反向半边）", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "completed", received: 999, total: 999 });
    await settle();

    expect(storeErr(h)).toBeNull();
    expect(txt(h)).toContain(zh["webman.downloadStatus.completed"]);
  });

  test("事件说的是**已经删掉**的那一行 ⇒ 一声不吭（「没这行」不是「没写进去」）", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    // 用户在传输途中删掉了这一行（`removeDownloadEntry` 会先请宿主停，REQ-A1317）；
    // 此刻仍在飞的进度事件落不到任何行 —— 那一下必须保持沉默。
    await fireEvent.click(btnByAria(h, zh["webman.download.remove"])!);
    await settle();
    expect(rows).toHaveLength(0);

    emit({ id: "d-1", status: "downloading", received: 500, total: 999 });
    await settle();

    expect(storeErr(h)).toBeNull();
  });

  test("拒写之后又写进去一条 ⇒ 那句失败撤掉（它说的是一件已经过期的事）", async () => {
    storeRefuses = true;
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    emit({ id: "d-1", status: "downloading", received: 500, total: 999 });
    await settle();
    expect(storeErr(h)).not.toBeNull();

    storeRefuses = false;
    emit({ id: "d-1", status: "completed", received: 999, total: 999 });
    await settle();

    expect(storeErr(h)).toBeNull();
    expect(txt(h)).toContain(zh["webman.downloadStatus.completed"]);
  });
});
