/**
 * webman-cancel-not-asked.svelte.test.ts — 「没能问」不是「宿主没有这次传输」（REQ-A1343 / FMEA F-SH-608）。
 *
 * `cancelDownload` 的 `false` 是一句**关于宿主**的事实（宿主手里没有这个 id ⇒ 这次传输不在跑），
 * 而适配器此前写成 `(await invoke<boolean>(…)) ?? false`：`invoke` 对「命令失败」与「没有桥」
 * 都解析 `null`，`?? false` 于是把第三种答复 —— **没能问** —— 折成了同一句话。
 *
 * 代价不是文案：`onCancelDownload` 见到 `false` 就把行画成 `failed`（还长出「重试」）并播报
 * 「取消已中断」；`removeDownloadEntry` 见到 `false` 就删行。桥抖一下，一条**在跑**的传输就
 * 会既被播报成已中断、又被从列表里删掉，而宿主的字节还在流 —— 后者正是 REQ-A1317 /
 * F-SH-590 那个形状（行没了、进度事件折进一行不存在的记录）。
 *
 * 所以本文件钉住两向：`null` ⇒ 行**不动**、如实说没得到答复、且**不说**那两句断言宿主的文案。
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
const cancelDownload = vi.hoisted(() => vi.fn(async () => null as boolean | null));
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
  cancelDownload.mockResolvedValue(null);
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

describe("WebManApp — 取消 ∕ 删除：没能问就不能断言", () => {
  test("取消：宿主没答 ⇒ 行**不动**（仍挂着「取消」），并如实说没得到答复", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    await fireEvent.click(btnByAria(h, zh["webman.download.cancel"])!);
    await settle();

    expect(txt(h)).toContain(zh["webman.download.cancelNotAsked"]);
    // 两向都钉：既不许把它画成已中断（那是在替宿主说话），也不许假装取消成功（无声）。
    expect(btnByAria(h, zh["webman.download.cancel"]), "没能问 ⇒ 行不该被改掉").toBeTruthy();
    expect(btnByAria(h, zh["webman.download.retry"]), "没能问 ⇒ 不该长出「重试」").toBeUndefined();
    expect(txt(h)).not.toContain(zh["webman.download.cancelInterrupted"]);
    expect(rows[0]!.status, "存储行也必须原样").toBe("downloading");
  });

  test("删除：宿主没答 ⇒ 行**留在列表里**（字节可能还在流），并如实说没确认停下", async () => {
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    await fireEvent.click(btnByAria(h, zh["webman.download.remove"])!);
    await settle();

    expect(txt(h)).toContain(zh["webman.download.removeNotAsked"]);
    expect(rows, "没能确认停下 ⇒ 不删行").toHaveLength(1);
    expect(txt(h), "行还在屏幕上").toContain(LIVED.filename);
    expect(txt(h)).not.toContain(zh["webman.download.remove"]);
  });

  test("宿主收下了删除的取消 ⇒ 两向都不说那两句「没能问」（对照）", async () => {
    cancelDownload.mockResolvedValue(true);
    const h = render(WebManApp);
    await settle();
    await openDownloadsPanel(h);

    await fireEvent.click(btnByAria(h, zh["webman.download.remove"])!);
    await settle();

    // 收下了 ⇒ 那两句「没能问」都不该出现：这是一次**有答复**的删除。
    // （行本身由存储的真身收尾，而 `loadDownloads` 是本文件的替身、不跟着变，
    //   所以这里只钉「说了什么」与「确实问过宿主」这两件。）
    expect(txt(h)).not.toContain(zh["webman.download.removeNotAsked"]);
    expect(txt(h)).not.toContain(zh["webman.download.cancelNotAsked"]);
    expect(cancelDownload).toHaveBeenCalledTimes(1);
    expect(cancelDownload).toHaveBeenCalledWith(LIVED.id);
  });
});
