/**
 * DOM tests for the full-page NoteEditor.svelte (design: docs/notes-editor.md).
 *
 * NoteEditor is mounted by NotesApp (the list's "Full page" button swaps to it), and
 * is also mounted on its own here against a seeded amos.notes store to verify:
 * typing marks dirty, ‹ back **flushes the pending autosave** (never loses work) and
 * writes the edited text + bumped ts back to the store, and the live preview renders
 * rich markers.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import NoteEditor from "../src/svelte/NoteEditor.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { setLocale } from "../src/svelte/locale.svelte";

afterEach(cleanup);
// The other cases assert the zh wording; never let one locale leak into the next.
afterEach(() => setLocale("zh"));

const KEY = "amos.notes";
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function seed() {
  const note = { id: "n1", text: "旧标题", ts: 1000, created: 1000 };
  window.localStorage.setItem(KEY, JSON.stringify([note]));
  return note;
}

/**
 * Swap in a storage whose writes of `key` throw the way a full quota does, and return
 * a restore function. (`window.localStorage` is a per-access proxy, so the prototype
 * cannot be patched — the window property itself is replaced.)
 */
function failWritesFor(key: string): () => void {
  const real = window.localStorage;
  const fake = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    removeItem: (k: string) => real.removeItem(k),
    setItem: (k: string, v: string) => {
      if (k === key) throw new Error("QuotaExceededError");
      real.setItem(k, v);
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return () =>
    Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
}

/**
 * A `PointerEvent` shaped closely enough for InkCanvas. happy-dom ships no PointerEvent
 * constructor, so a plain bubbling `Event` is stamped with the fields the component reads
 * (`classifyPointer` sees only these plain values — it takes no DOM type on purpose).
 */
function pev(type: string, props: Record<string, unknown> = {}): PointerEvent {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, {
    pointerId: 1,
    pointerType: "pen",
    isPrimary: true,
    width: 1,
    height: 1,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    clientX: 0,
    clientY: 0,
    ...props,
  });
  return e as unknown as PointerEvent;
}

/** Draw one stroke on the canvas: down, move(s), up. */
async function stroke(canvas: Element, moves: PointerEvent[], down?: Record<string, unknown>) {
  canvas.dispatchEvent(pev("pointerdown", down));
  await tick();
  for (const m of moves) {
    canvas.dispatchEvent(m);
    await tick();
  }
  canvas.dispatchEvent(pev("pointerup"));
  await tick();
}

const inkOf = (id: string) =>
  readStoreValue<{ id: string; ink?: { strokes: unknown[] } }[]>(KEY, []).find((n) => n.id === id)?.ink;

describe("NoteEditor.svelte", () => {
  test("typing + ‹ back flushes the autosave and updates the store", async () => {
    const note = seed();
    let closed = 0;
    const host = render(NoteEditor, {
      props: { note, onClose: () => (closed += 1) },
    });

    const ta = host.container.querySelector(
      'textarea[data-testid="note-editor-textarea"]',
    ) as HTMLTextAreaElement;
    expect(ta.value).toBe("旧标题");
    await fireEvent.input(ta, { target: { value: "新标题与 **加粗** 正文" } });
    await tick();

    // ‹ back must flush the pending autosave before returning.
    await fireEvent.click(host.container.querySelector('[data-testid="note-editor-back"]')!);
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

  test("the status line is driven by the tested save-state reducer", async () => {
    const note = seed();
    const host = render(NoteEditor, { props: { note, onClose: () => {} } });
    const status = () =>
      host.container.querySelector('[data-testid="note-editor-status"]')?.textContent ?? "";
    const ta = host.container.querySelector(
      'textarea[data-testid="note-editor-textarea"]',
    ) as HTMLTextAreaElement;

    expect(status()).toContain("保存于"); // initialSaveState → "saved"

    // `edit` folds to dirty + "saving" synchronously, before the debounce fires.
    await fireEvent.input(ta, { target: { value: "改了" } });
    expect(status()).toContain("正在保存…");

    // Trailing-edge autosave → `saved` (and the draft really landed in the store).
    await new Promise((r) => setTimeout(r, 700));
    expect(status()).toContain("保存于");
    const stored = readStoreValue<{ id: string; text: string }[]>(KEY, []);
    expect(stored.find((x) => x.id === "n1")?.text).toBe("改了");
  });

  test("live preview renders rich markers", async () => {
    const note = seed();
    const host = render(NoteEditor, { props: { note, onClose: () => {} } });
    const ta = host.container.querySelector(
      'textarea[data-testid="note-editor-textarea"]',
    ) as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "**加粗** 与 #工作" } });
    await tick();

    await fireEvent.click(host.container.querySelector('[data-testid="note-editor-preview"]')!);
    await tick();

    const body = host.container.querySelector('[data-testid="note-editor-preview-body"]');
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
      'textarea[data-testid="note-editor-textarea"]',
    ) as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "应该不会被写回" } });
    // Let the trailing-edge autosave run (600 ms) so the failure is reported.
    await new Promise((r) => setTimeout(r, 700));
    // The failed save is surfaced (reducer `save_failed`) — not hidden behind the
    // generic "saving" text.
    const status = host.container.querySelector('[data-testid="note-editor-status"]');
    expect(status?.textContent ?? "").toContain("笔记已被删除");
    await fireEvent.click(host.container.querySelector('[data-testid="note-editor-back"]')!);
    await tick();

    expect(closed).toBe(1);
    // Nothing was written for the ghost note.
    const stored = readStoreValue<{ id: string }[]>(KEY, []);
    expect(stored.some((n) => n.id === "ghost")).toBe(false);
  });

  test("a rejected store write is a failed save, never a claimed \"保存于 …\"", async () => {
    const note = seed();
    // The draft must not be claimed as saved when the store refuses it: quota-exceeded.
    const restore = failWritesFor(KEY);
    try {
      const host = render(NoteEditor, { props: { note, onClose: () => {} } });
      const status = () =>
        host.container.querySelector('[data-testid="note-editor-status"]')?.textContent ?? "";
      const ta = host.container.querySelector(
        'textarea[data-testid="note-editor-textarea"]',
      ) as HTMLTextAreaElement;

      await fireEvent.input(ta, { target: { value: "改动会丢" } });
      expect(status()).toContain("正在保存…");
      await new Promise((r) => setTimeout(r, 700));

      // Honest failure, and crucially *not* the "saved at" label.
      expect(status()).toContain("本机存储写入失败");
      expect(status()).not.toContain("保存于");
      // …and the store really does not hold the edit.
      expect(
        readStoreValue<{ id: string; text: string }[]>(KEY, []).find((n) => n.id === "n1")?.text,
      ).toBe("旧标题");
    } finally {
      restore();
    }
  });

  test("every label this editor renders follows the locale (no hard-coded Chinese)", async () => {
    // Seed an ASCII note so any CJK left in the rendered editor is *copy*, not data.
    const note = { id: "n1", text: "Old title", ts: 1000, created: 1000 };
    window.localStorage.setItem(KEY, JSON.stringify([note]));
    setLocale("en");

    const host = render(NoteEditor, { props: { note, onClose: () => {} } });
    await tick();

    const ta = host.container.querySelector(
      'textarea[data-testid="note-editor-textarea"]',
    ) as HTMLTextAreaElement;
    expect(ta.placeholder).toBe("Start typing…"); // was hard-coded "开始输入…"
    const text = host.container.textContent ?? "";
    expect(text).toContain("Task"); // "☑ 勾选"
    expect(text).toContain("Make task"); // "＋ 任务"
    expect(text).toContain("Preview"); // "预览"
    expect(host.container.querySelector('[data-testid="note-editor-status"]')!.textContent).toContain(
      "Saved", // "保存于 {time}"
    );
    expect(host.container.querySelector('[data-testid="note-editor-preview"]')!.getAttribute("title")).toBe(
      "Rich-text preview", // "富文本预览"
    );
    expect(/[\u4e00-\u9fff]/.test(text)).toBe(false);
  });

  test("the ink toggle is an alternating view: aria-pressed flips, textarea \u2194 canvas", async () => {
    const note = seed();
    const host = render(NoteEditor, { props: { note, onClose: () => {} } });
    const q = (s: string) => host.container.querySelector(s);
    const draw = q('[data-testid="note-editor-draw"]')!;

    expect(draw.getAttribute("aria-pressed")).toBe("false");
    expect(q('[data-testid="note-editor-textarea"]')).toBeTruthy();
    expect(q('[data-testid="note-ink-canvas"]')).toBeNull();

    await fireEvent.click(draw);
    expect(draw.getAttribute("aria-pressed")).toBe("true");
    expect(q('[data-testid="note-ink-canvas"]')).toBeTruthy();
    expect(q('[data-testid="note-editor-textarea"]')).toBeNull();

    // The eraser button only exists while the drawing surface is up.
    expect(q('[data-testid="note-editor-eraser"]')).toBeTruthy();
    await fireEvent.click(draw);
    expect(q('[data-testid="note-editor-textarea"]')).toBeTruthy();
    expect(q('[data-testid="note-editor-eraser"]')).toBeNull();
  });

  test("a synthesized pen stroke is committed to the store after the debounce", async () => {
    // happy-dom has no `getCoalescedEvents`, so this case *is* the missing-API fallback path.
    const note = seed();
    const host = render(NoteEditor, { props: { note, onClose: () => {} } });
    await fireEvent.click(host.container.querySelector('[data-testid="note-editor-draw"]')!);

    const canvas = host.container.querySelector('[data-testid="note-ink-canvas"]')!;
    await stroke(canvas, [pev("pointermove", { clientX: 40, clientY: 40 })]);
    await new Promise((r) => setTimeout(r, 700));

    const ink = inkOf("n1");
    expect(ink).toBeTruthy();
    expect(ink!.strokes.length).toBe(1);
  });

  test("coalesced pointer moves are all sampled in a single handler call", async () => {
    const note = seed();
    const host = render(NoteEditor, { props: { note, onClose: () => {} } });
    await fireEvent.click(host.container.querySelector('[data-testid="note-editor-draw"]')!);
    const canvas = host.container.querySelector('[data-testid="note-ink-canvas"]')!;

    // One move event carrying three coalesced positions. The zig-zag is deliberate: all three
    // survive RDP simplification, so the stored point count is a direct read of the batch.
    const move = pev("pointermove", { clientX: 20, clientY: 20 });
    Object.assign(move, {
      getCoalescedEvents: () => [
        pev("pointermove", { clientX: 20, clientY: 0 }),
        pev("pointermove", { clientX: 20, clientY: 20 }),
        pev("pointermove", { clientX: 0, clientY: 20 }),
      ],
    });
    await stroke(canvas, [move]);
    await new Promise((r) => setTimeout(r, 700));

    const pts = inkOf("n1")?.strokes[0] as { pts: unknown[] } | undefined;
    expect(pts?.pts.length).toBe(4); // 1 down + 3 coalesced
  });

  test("a palm contact (wide touch while untouched by a pen) leaves no ink", async () => {
    const note = seed();
    const host = render(NoteEditor, { props: { note, onClose: () => {} } });
    await fireEvent.click(host.container.querySelector('[data-testid="note-editor-draw"]')!);
    const canvas = host.container.querySelector('[data-testid="note-ink-canvas"]')!;

    await stroke(
      canvas,
      [pev("pointermove", { pointerType: "touch", width: 30, clientX: 40, clientY: 40 })],
      { pointerType: "touch", width: 30 },
    );
    await new Promise((r) => setTimeout(r, 700));

    expect(inkOf("n1")).toBeFalsy();
  });

  test("the palm guard is overridable \u2014 the same contact draws with it off", async () => {
    const note = seed();
    const host = render(NoteEditor, {
      props: { note, onClose: () => {}, palmRejection: false },
    });
    await fireEvent.click(host.container.querySelector('[data-testid="note-editor-draw"]')!);
    const canvas = host.container.querySelector('[data-testid="note-ink-canvas"]')!;

    await stroke(
      canvas,
      [pev("pointermove", { pointerType: "touch", width: 30, clientX: 40, clientY: 40 })],
      { pointerType: "touch", width: 30 },
    );
    await new Promise((r) => setTimeout(r, 700));

    expect(inkOf("n1")?.strokes.length).toBe(1);
  });

  test("\u2039 back flushes a pending ink commit \u2014 the stroke survives leaving", async () => {
    const note = seed();
    const host = render(NoteEditor, { props: { note, onClose: () => {} } });
    await fireEvent.click(host.container.querySelector('[data-testid="note-editor-draw"]')!);
    const canvas = host.container.querySelector('[data-testid="note-ink-canvas"]')!;

    await stroke(canvas, [pev("pointermove", { clientX: 40, clientY: 40 })]);
    // No debounce wait: leaving must flush what is pending.
    await fireEvent.click(host.container.querySelector('[data-testid="note-editor-back"]')!);
    await tick();

    expect(inkOf("n1")?.strokes.length).toBe(1);
  });

  test("a rejected ink write is reported as a failed save", async () => {
    const note = seed();
    const restore = failWritesFor(KEY);
    try {
      const host = render(NoteEditor, { props: { note, onClose: () => {} } });
      await fireEvent.click(host.container.querySelector('[data-testid="note-editor-draw"]')!);
      const canvas = host.container.querySelector('[data-testid="note-ink-canvas"]')!;

      await stroke(canvas, [pev("pointermove", { clientX: 40, clientY: 40 })]);
      await new Promise((r) => setTimeout(r, 700));

      const status = host.container.querySelector('[data-testid="note-editor-status"]');
      expect(status?.textContent ?? "").toContain("\u672c\u673a\u5b58\u50a8\u5199\u5165\u5931\u8d25");
      expect(status?.textContent ?? "").not.toContain("\u4fdd\u5b58\u4e8e");
    } finally {
      restore();
    }
  });
});
