/**
 * files-share.svelte.test.ts — the share sheet's *producer* in Files (REQ-A703).
 *
 * The system share sheet is only real if some surface can open it. Files is the
 * first: a file's text is handed to `openShareSheet`, which the sheet then renders.
 * A file with no content is the honest edge: the payload is refused and the user is
 * told why, rather than a sheet opening that hands an empty string to every handler.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import FilesApp from "../src/svelte/FilesApp.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { FILES_KEY, type FEntry } from "../src/lib/files";
import { closeShareSheet, sharePayload } from "../src/svelte/shareSheetState.svelte";
import { zh } from "../src/i18n/locales/zh";

beforeEach(() => {
  window.localStorage.clear();
  closeShareSheet();
});
afterEach(() => {
  cleanup();
  closeShareSheet();
  window.localStorage.clear();
});

const clickShare = async (host: { container: HTMLElement }, entryId: string) => {
  const btn = host.container.querySelector(
    `[data-testid="files-share-${entryId}"]`,
  ) as HTMLButtonElement | null;
  expect(btn, `share button for ${entryId}`).toBeTruthy();
  await fireEvent.click(btn!);
};

describe("FilesApp 分享 → 系统分享面板 (REQ-A703)", () => {
  test("有内容的文件：打开面板并带上文件正文与文件名", async () => {
    const host = render(FilesApp);
    await clickShare(host, "note"); // 种子文件说明.txt
    const p = sharePayload();
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("file");
    expect(p!.title).toBe("说明.txt");
    expect(p!.value).toContain("欢迎使用 Amos 文件管理器");
  });

  test("空文件：拒绝开面板并说明原因", async () => {
    const empty: FEntry[] = [
      { id: "blank", type: "file", name: "空.txt", content: "", ts: 1 },
    ];
    writeStoreValue(FILES_KEY, empty);

    const host = render(FilesApp);
    await clickShare(host, "blank");

    expect(sharePayload()).toBeNull();
    const alert = host.container.querySelector('[role="alert"]');
    expect(alert?.textContent ?? "").toContain(zh["files.shareNothing"]);
  });
});
