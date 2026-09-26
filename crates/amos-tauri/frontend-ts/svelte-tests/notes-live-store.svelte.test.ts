/**
 * notes-live-store.svelte.test.ts — the Notes screen must FOLLOW `amos.notes`, not
 * photograph it (REQ-A1351 / F-SH-615).
 *
 * `amos.notes` has **two** writers in one session, and only one of them is this screen:
 *
 *   * this screen's own verbs (`add` / `saveEdit` / the batch verbs / `importMd`) go
 *     through `persist()`, which writes the key *and* assigns its own `notes` copy — so a
 *     write from here is indistinguishable from a write that was followed;
 *   * the Spotlight sheet's 「存为笔记」 (`SpotlightPanel.runNewNote`) writes a brand-new
 *     note to the same key from **outside** this component and then hands its id back over
 *     the `notes` deep-link channel (`appLinks.openNote` → `notesChannel`), i.e. it
 *     deliberately asks *this* screen to reveal what it just stored.
 *
 * `NotesApp` read the key once at mount (`const seeded = normalizeNotes(readStoreValue(…))`)
 * and never subscribed. So on a Notes screen that is already on screen — which is exactly
 * what `openNote` produces, because `open("notes")` re-commits `{kind:"app", id:"notes"}`,
 * the same id `AppPane` is already mounting, so nothing remounts — the sheet's save left
 * the note *stored but invisible*: absent from the list, and the deep link's own lookup
 * (`const target = notes.find((n) => n.id === v.noteId)`) resolved the fresh id against the
 * pre-write array and decided the note did not exist. The app that owns notes was the last
 * one to hear about the note.
 *
 * Why the existing cases cannot see it: every one of them writes through this screen's own
 * controls, and a value that never changes after mount is indistinguishable from one that
 * is followed. `spotlight-panel.svelte.test.ts` mounts the sheet alone (it hands the id to
 * the channel and asserts the *channel*, never the reader), and `notes.svelte.test.ts`
 * mounts Notes alone. The two writers are never on stage together.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import NotesApp from "../src/svelte/NotesApp.svelte";
import { NOTES_KEY, normalizeNotes, prependNote } from "../src/lib/notes";
import type { Note } from "../src/lib/notes";
import { readStoreValue, writeStoreValueChecked } from "../src/lib/amosStore";
import { notesChannel } from "../src/svelte/appLinks";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { resetShellState } from "../src/svelte/shellState.svelte";
import { setLocale } from "../src/svelte/locale.svelte";

const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const editorBox = (h: { container: HTMLElement }) =>
  h.container.querySelector('textarea[data-testid="note-editor-textarea"]') as
    | HTMLTextAreaElement
    | null;

/**
 * Save `text` the way `SpotlightPanel.runNewNote` does — a **second writer** outside this
 * component: read the shared key, prepend, write it back, then hand the new note's id to
 * this screen over the deep-link channel. Returns the new id.
 *
 * Deliberately the real order (write, *then* link): `openNote` is called after the store
 * accepted the note, so a reader that follows the key has the note in hand by the time the
 * link arrives.
 */
function otherSurfaceSavesNote(text: string, nonce = 1): string {
  const list = normalizeNotes(readStoreValue<unknown>(NOTES_KEY, []));
  const next = prependNote(list, text, Date.now());
  const created = next[0]!;
  expect(writeStoreValueChecked(NOTES_KEY, next)).toBe(true);
  notesChannel().set({ noteId: created.id, nonce });
  return created.id;
}

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  resetShellState();
  setLocale("zh");
});
afterEach(() => {
  cleanup();
  resetPropsChannels();
  resetShellState();
  setLocale("zh");
});

describe("NotesApp.svelte — the list follows amos.notes (REQ-A1351)", () => {
  test("a note saved from another surface is listed without a remount", async () => {
    const host = render(NotesApp);
    await tick();
    expect(txt(host)).toContain("暂无备忘录");

    otherSurfaceSavesNote("买牛奶");
    await tick();

    expect(txt(host)).toContain("买牛奶");
  });

  test("the deep link reveals the note the other surface just wrote", async () => {
    const host = render(NotesApp);
    await tick();

    otherSurfaceSavesNote("今晚买牛奶");
    await tick();

    const ed = editorBox(host);
    expect(ed).toBeTruthy();
    expect(ed!.value).toContain("今晚买牛奶");
  });

  test("an archive from another surface is followed too — the list is a mirror", async () => {
    window.localStorage.setItem(
      NOTES_KEY,
      JSON.stringify([{ id: "a1", text: "旧笔记", ts: 1 }]),
    );
    const host = render(NotesApp);
    await tick();
    expect(txt(host)).toContain("旧笔记");

    writeStoreValueChecked(NOTES_KEY, [{ id: "a1", text: "旧笔记", ts: 1, state: "archived" }]);
    await tick();

    // Archived notes leave the 备忘录 tab; nothing was appended, the list moved.
    expect(txt(host)).not.toContain("旧笔记");
    expect(txt(host)).toContain("暂无备忘录");
  });

  test("a deep link to an id nobody has is still ignored (no phantom note)", async () => {
    const host = render(NotesApp);
    await tick();

    notesChannel().set({ noteId: "no-such-note-id", nonce: 7 });
    await tick();

    expect(txt(host)).toContain("暂无备忘录");
    expect(editorBox(host)).toBeNull();
  });

  test("complement: the screen's own 保存 still writes the key and lists the note", async () => {
    const host = render(NotesApp);
    const ta = host.container.querySelector(
      'textarea[data-testid="note-compose"]',
    ) as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "本页新建" } });
    await fireEvent.click(
      [...host.container.querySelectorAll("button")].find(
        (b) => (b.textContent ?? "").trim() === "保存",
      ) as HTMLButtonElement,
    );
    await tick();

    expect(txt(host)).toContain("本页新建");
    const stored = readStoreValue<Note[]>(NOTES_KEY, []);
    expect(stored.some((n) => n.text === "本页新建")).toBe(true);
  });
});
