/**
 * notes-share.svelte.test.ts — the share sheet's *second* producer: Notes (REQ-A708
 * follow-up on REQ-A703).
 *
 * Files was the sheet's only producer, which left the contract "some surface
 * produces, some handler consumes" half-populated. A note is the natural text
 * payload: its body goes to `openShareSheet` with the note's own title line as the
 * header, and a blank note is refused (with a reason) instead of opening a sheet
 * that hands an empty string to every handler.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import NotesApp from "../src/svelte/NotesApp.svelte";
import { writeStoreValue } from "../src/lib/amosStore";
import { NOTES_KEY, type Note } from "../src/lib/notes";
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

const seed = (notes: Note[]) => writeStoreValue(NOTES_KEY, notes);

/** A collapsed row shows only its title; the action list (and the share button)
 *  needs the row expanded first — tap it. */
const clickShare = async (host: { container: HTMLElement }) => {
  const row = host.container.querySelector(
    '[data-drag-source="note"]',
  ) as HTMLButtonElement | null;
  expect(row, "note row").toBeTruthy();
  await fireEvent.click(row!);
  const btn = host.container.querySelector(
    '[data-testid="note-share"]',
  ) as HTMLButtonElement | null;
  expect(btn, "note share button").toBeTruthy();
  await fireEvent.click(btn!);
};

describe("NotesApp 分享 → 系统分享面板 (REQ-A708)", () => {
  test("有内容的笔记：打开面板并带上笔记正文与标题行", async () => {
    seed([{ id: "n1", text: "购物清单\n牛奶、鸡蛋", ts: 1 }]);
    const host = render(NotesApp);
    await clickShare(host);

    const p = sharePayload();
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("text");
    expect(p!.title).toBe("购物清单");
    expect(p!.value).toBe("购物清单\n牛奶、鸡蛋");
  });

  test("空笔记：拒绝开面板并说明原因", async () => {
    seed([{ id: "n2", text: "", ts: 1 }]);
    const host = render(NotesApp);
    await clickShare(host);

    expect(sharePayload()).toBeNull();
    const status = host.container.querySelector('[data-testid="note-status"]');
    expect(status?.textContent ?? "").toContain(zh["note.shareEmpty"]);
  });

  test("只有手写的笔记：列表说它有内容，分享就不能说它是空的", async () => {
    seed([
      {
        id: "n3",
        text: "",
        ts: 1,
        ink: {
          w: 300,
          h: 120,
          strokes: [
            { tool: "pen", color: "#000", width: 2, pts: [{ x: 1, y: 1, p: 0.5, t: 0 }] },
          ],
        },
      },
    ]);
    const host = render(NotesApp);

    // 同一行画着「✎ 手写」——应用自己已经承认这条笔记有内容。
    expect(host.container.querySelector('[data-testid="note-row-ink"]')).toBeTruthy();

    await clickShare(host);

    expect(sharePayload()).toBeNull();
    const status = host.container.querySelector('[data-testid="note-status"]');
    const text = status?.textContent ?? "";
    // 拒绝仍然要说清原因，但原因不是「空」——它只是没有可当文本分享的正文。
    expect(text).not.toContain(zh["note.shareEmpty"]);
    expect(text).toContain(zh["note.shareInk"]);
  });
});
