/**
 * DOM tests for the standalone NoteEditor.svelte (design: docs/notes-editor.md).
 *
 * NoteEditor is deliberately NOT wired into NotesApp yet, so this only mounts the
 * editor by itself against a seeded amos.notes store and verifies: typing marks
 * dirty, ‹ back **flushes the pending autosave** (never loses work) and writes
 * the edited text + bumped ts back to the store, and the live preview renders
 * rich markers.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import NoteEditor from "../src/svelte/NoteEditor.svelte";
import { readStoreValue } from "../src/lib/amosStore";

afterEach(cleanup);

const KEY = "amos.notes";
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function seed() {
  const note = { id: "n1", text: "旧标题", ts: 1000, created: 1000 };
  window.localStorage.setItem(KEY, JSON.stringify([note]));
  return note;
}

describe("NoteEditor.svelte", () => {
  test("typing + ‹ back flushes the autosave and updates the store", async () => {
    const note = seed();
    let closed = 0;
    const host = render(NoteEditor, {
      props: { note, onClose: () => (closed += 1) },
    });

    const ta = host.container.querySelector(
      'textarea[aria-label="note-editor-textarea"]',
    ) as HTMLTextAreaElement;
    expect(ta.value).toBe("旧标题");
    await fireEvent.input(ta, { target: { value: "新标题与 **加粗** 正文" } });
    await tick();

    // ‹ back must flush the pending autosave before returning.
    await fireEvent.click(host.container.querySelector('[aria-label="note-editor-back"]')!);
    await tick();

    expect(closed).toBe(1);
    const stored = readStoreValue<{ id: string; text: string; ts: number; created: number }[]>(
      KEY,
      [],
    );
    const n = stored.find((x) => x.id === "n1");
    expect(n).toBeTruthy();
    expect(n!.text).toBe("新标题与 **加粗** 正文");
    expect(n!.ts).toBeGreaterThan(1000); // ts bumped by the save
    expect(n!.created).toBe(1000); // created preserved
  });

  test("live preview renders rich markers", async () => {
    const note = seed();
    const host = render(NoteEditor, { props: { note, onClose: () => {} } });
    const ta = host.container.querySelector(
      'textarea[aria-label="note-editor-textarea"]',
    ) as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "**加粗** 与 #工作" } });
    await tick();

    await fireEvent.click(host.container.querySelector('[aria-label="note-editor-preview"]')!);
    await tick();

    const body = host.container.querySelector('[aria-label="note-editor-preview-body"]');
    expect(body).toBeTruthy();
    expect(body?.querySelector("strong")).toBeTruthy();
    expect((body?.textContent ?? "")).toContain("#工作");
  });

  test("a note that is no longer in the store is never silently saved", async () => {
    // Seed an EMPTY store; open the editor for a ghost note that doesn't exist.
    window.localStorage.setItem(KEY, JSON.stringify([]));
    const ghost = { id: "ghost", text: "old", ts: 1, created: 1 };
    let closed = 0;
    const host = render(NoteEditor, {
      props: { note: ghost, onClose: () => (closed += 1) },
    });
    const ta = host.container.querySelector(
      'textarea[aria-label="note-editor-textarea"]',
    ) as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "应该不会被写回" } });
    await tick();
    await fireEvent.click(host.container.querySelector('[aria-label="note-editor-back"]')!);
    await tick();

    expect(closed).toBe(1);
    // Nothing was written for the ghost note.
    const stored = readStoreValue<{ id: string }[]>(KEY, []);
    expect(stored.some((n) => n.id === "ghost")).toBe(false);
  });
});
