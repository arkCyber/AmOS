/**
 * share-sheet-copy-refusal.svelte.test.ts — 分享面板的「拷贝」必须读宿主的判决（REQ-A1235）。
 *
 * `ShareSheet.svelte` 里两个目标各是一条路径，**只有一条读了判决**：
 *
 * - `runTarget` 的注释逐字写下了这条规则 —— 「Closing the sheet *is* the success gesture, so it
 *   now happens only when `result.success`, and a refusal is said in the surface that started it
 *   (REQ-A856, REQ-A1140)」，代码也照做（`if (result.success) dismiss(); else runError = …`）。
 * - `copyTarget` 逐字 `if (!payload) return; dismiss(); await clipboardWrite({ kind: "text", text:
 *   payload.value }, "share-sheet");` —— **先**收起面板（成功手势），**再**去读 payload。
 *
 * **实测的根因比「丢了判决」更硬**：`dismiss()` 调 `closeShareSheet()` 把共享的 `payload` 置空，
 * 而组件顶部的 `const payload = $derived(sharePayload())` 立刻就反映它 —— 于是下一行的
 * `payload.value` 读的是 `null.value`，**抛 TypeError**，`clipboardWrite` **一次都没被调用**。
 * 也就是说「拷贝」这个目标**从来没拷贝过任何东西**：调用点的 `void` 把这次拒绝吞掉，而面板已经收起。
 * 本文件的每一例都先断言 `clipboardWrite` 的调用次数，就是为了把这条事实钉住（而不是只钉「提示没画」）。
 *
 * 第二层缺陷叠在上面：即便拿到了值，`ClipboardEntry | null` 也是丢掉的 —— 而 `null` 正是宿主拒绝
 * （正文超过 `MAX_TEXT_LEN` = 1 MiB，或整个没有桥的 WebView），收起面板又**就是**成功手势。
 *
 * 同文件的 `failureNote`（原 `runError`）状态与它的 `role="alert"` 渲染点已经存在 —— 拷贝这一路
 * 只是没有写进去。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import ShareSheet from "../src/svelte/ShareSheet.svelte";
import { closeShareSheet, openShareSheet } from "../src/svelte/shareSheetState.svelte";
import * as clipboard from "../src/lib/clipboard";
import { zh } from "../src/i18n/locales/zh";

vi.mock("../src/lib/clipboard");

const TEXT = "要分享的正文";

/** Open the sheet with a valid payload and hand back the rendered host. */
async function openSheet() {
  const rendered = render(ShareSheet);
  expect(openShareSheet({ kind: "text", value: TEXT, title: "备注" })).toBe(true);
  await waitFor(() => expect(screen.getByTestId("share-sheet")).toBeTruthy());
  return rendered;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(clipboard.clipboardWrite).mockReset();
  closeShareSheet();
});

afterEach(() => {
  cleanup();
  closeShareSheet();
  window.localStorage.clear();
});

describe("ShareSheet — 拷贝这一路必须读宿主的判决，而不是把它当成成功（REQ-A1235）", () => {
  test("被拒绝的拷贝要说出来（同文件里 `runTarget` 早就这么做）", async () => {
    vi.mocked(clipboard.clipboardWrite).mockResolvedValue(null);
    await openSheet();

    await fireEvent.click(screen.getByTestId("share-target-copy"));

    await waitFor(() => {
      expect(clipboard.clipboardWrite).toHaveBeenCalledTimes(1);
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(zh["shareSheet.copyFailed"]);
    });
  });

  test("被拒绝的拷贝不得把面板收起 —— 收起**就是**成功手势", async () => {
    vi.mocked(clipboard.clipboardWrite).mockResolvedValue(null);
    await openSheet();

    await fireEvent.click(screen.getByTestId("share-target-copy"));

    // Give the whole chain a chance to settle before asking whether it is still up.
    await waitFor(() => expect(clipboard.clipboardWrite).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("share-sheet")).toBeTruthy();
  });

  test("拷贝落地时照旧收起面板、且一句话也不说（失败路径没有把成功路径改坏）", async () => {
    vi.mocked(clipboard.clipboardWrite).mockResolvedValue({
      seq: 1,
      source: "share-sheet",
      owner: "main",
      timestamp_ms: 0,
      payload: { kind: "text", text: TEXT },
    });
    await openSheet();

    await fireEvent.click(screen.getByTestId("share-target-copy"));

    await waitFor(() => expect(screen.queryByTestId("share-sheet")).toBeNull());
    // …and it asked the host for the right thing: the payload's text, under this surface's source.
    expect(clipboard.clipboardWrite).toHaveBeenCalledWith({ kind: "text", text: TEXT }, "share-sheet");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
