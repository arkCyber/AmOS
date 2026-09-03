import { describe, expect, test } from "bun:test";
import { normalizeNotes, prependNote, removeNote, editNote, togglePin, orderPinned, setNoteState, notesOf, searchNotes, makeNote, noteStats, tasksOf, toggleTaskInText, toggleTaskInNote, taskSummary, completeTasksInText, completeAllTasks, noteListProgress, fmtInline } from "../lib/notes";

describe("notes store helpers", () => {
  test("prependNote adds newest first, each with a unique id", () => {
    const base = [{ id: "n1", text: "a", ts: 1 }];
    const next = prependNote(base, "b", 2);
    expect(next[0]!.text).toBe("b");
    expect(next[0]!.ts).toBe(2);
    expect(typeof next[0]!.id).toBe("string");
    expect(next[1]).toEqual({ id: "n1", text: "a", ts: 1 });
    expect(base.length).toBe(1); // immutable
  });

  test("two notes created in the same ms get distinct ids and remove independently", () => {
    const a = makeNote("a", 1000);
    const b = makeNote("b", 1000); // same ts
    expect(a.ts).toBe(b.ts);
    expect(a.id).not.toBe(b.id); // THE fix: ids are unique even for same ts
    const after = removeNote([a, b], a.id);
    expect(after.map((n) => n.text)).toEqual(["b"]);
  });

  test("removeNote deletes only the exact id", () => {
    const list = [
      { id: "1", text: "a", ts: 1 },
      { id: "2", text: "b", ts: 1 },
      { id: "3", text: "c", ts: 3 },
    ];
    const after = removeNote(list, "2");
    expect(after.map((n) => n.text)).toEqual(["a", "c"]);
  });

  test("editNote replaces exactly one note's text and bumps its timestamp", () => {
    const list = [
      { id: "1", text: "old", ts: 1 },
      { id: "2", text: "keep", ts: 1 },
    ];
    const after = editNote(list, "1", "  new text  ", 99);
    expect(after[0]).toEqual({ id: "1", text: "new text", ts: 99 }); // trimmed + ts bumped
    expect(after[1]).toEqual({ id: "2", text: "keep", ts: 1 }); // untouched
    expect(list[0]!.text).toBe("old"); // immutable
  });

  test("editNote is a no-op for a missing id, blank text, or unchanged text", () => {
    const list = [{ id: "1", text: "same", ts: 1 }];
    expect(editNote(list, "nope", "x", 5)).toBe(list); // missing id
    expect(editNote(list, "1", "   ", 5)).toBe(list); // blank
    expect(editNote(list, "1", "same", 9)).toBe(list); // unchanged -> no ts churn
  });

  test("normalizeNotes back-fills ids, de-dups explicit-id collisions, drops garbage", () => {
    const normalized = normalizeNotes([
      { text: "legacy", ts: 5 }, // no id -> backfilled
      { id: "same", text: "x", ts: 6 },
      { id: "same", text: "y", ts: 7 }, // duplicate explicit id -> de-duplicated
      { text: 42 }, // malformed (non-string text) -> dropped
      null,
      "junk",
    ]);
    expect(normalized.length).toBe(3);
    expect(normalized.map((n) => n.text)).toEqual(["legacy", "x", "y"]);
    expect(normalized[0]!.id).toBe("5-0"); // legacy backfilled
    expect(normalized[1]!.id).toBe("same");
    expect(normalized[2]!.id).toBe("same-1"); // collision resolved
    const ids = normalized.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(normalizeNotes("nope")).toEqual([]);
    expect(normalizeNotes(null)).toEqual([]);
  });

  test("togglePin floats a note to the top and orderPinned keeps pins first", () => {
    const list = [
      { id: "a", text: "first", ts: 1 },
      { id: "b", text: "second", ts: 2 },
      { id: "c", text: "third", ts: 3 },
    ];
    const pinned = togglePin(list, "c");
    expect(pinned[0]!.id).toBe("c");
    expect(pinned[0]!.pinned).toBe(true);
    expect(pinned.map((n) => n.id)).toEqual(["c", "a", "b"]);
    expect(list[0]).not.toHaveProperty("pinned"); // original untouched

    // unpin: star cleared but the note stays in the list
    const unpin = togglePin(pinned, "c");
    expect(unpin.map((n) => n.id)).toEqual(["c", "a", "b"]);
    expect(unpin[0]!.pinned).toBeUndefined();
    expect(unpin.every((n) => !n.pinned)).toBe(true);

    // missing id is a true no-op (same ref)
    expect(togglePin(list, "nope")).toBe(list);
  });

  test("orderPinned groups pins above the rest, keeping relative order", () => {
    const mixed = [
      { id: "x", text: "x", ts: 1 },
      { id: "p1", text: "p1", ts: 2, pinned: true },
      { id: "y", text: "y", ts: 3 },
      { id: "p2", text: "p2", ts: 4, pinned: true },
    ];
    expect(orderPinned(mixed).map((n) => n.id)).toEqual(["p1", "p2", "x", "y"]);
  });

  test("normalizeNotes preserves a valid pinned flag", () => {
    const out = normalizeNotes([{ text: "hi", ts: 1, pinned: true }]);
    expect(out[0]!.pinned).toBe(true);
    expect(out[0]!.text).toBe("hi");
  });

  test("setNoteState moves notes between active/archived/trash and notesOf filters", () => {
    const list = [
      { id: "a", text: "active", ts: 1 },
      { id: "b", text: "note", ts: 2 },
    ];
    const archived = setNoteState(list, "a", "archived");
    expect(archived[0]!.state).toBe("archived");
    expect(list[0]).not.toHaveProperty("state"); // original untouched
    expect(notesOf(archived, "archived").map((n) => n.id)).toEqual(["a"]);
    expect(notesOf(archived, undefined).map((n) => n.id)).toEqual(["b"]);

    const trashed = setNoteState(archived, "a", "trash");
    expect(trashed[0]!.state).toBe("trash");
    expect(notesOf(trashed, "archived")).toEqual([]);
    expect(notesOf(trashed, "trash").map((n) => n.id)).toEqual(["a"]);

    // restore back to active clears the bucket and keeps the note
    const restored = setNoteState(trashed, "a", undefined);
    expect(notesOf(restored, undefined).map((n) => n.id)).toEqual(["a", "b"]);

    // missing id is a true no-op (same ref)
    expect(setNoteState(list, "nope", "trash")).toBe(list);
  });

  test("searchNotes filters note text case-insensitively, empty passes all", () => {
    const list = [
      { id: "a", text: "买牛奶 和 面包", ts: 1 },
      { id: "b", text: "开会材料", ts: 2 },
    ];
    expect(searchNotes(list, "牛奶").map((n) => n.id)).toEqual(["a"]);
    expect(searchNotes(list, "开会").map((n) => n.id)).toEqual(["b"]);
    expect(searchNotes(list, "   ").length).toBe(2); // empty query passes all
    expect(searchNotes(list, "zzz")).toEqual([]);
  });

  test("noteStats counts chars (code points), words and lines", () => {
    expect(noteStats("")).toEqual({ chars: 0, words: 0, lines: 0 });
    expect(noteStats("   \n  ")).toEqual({ chars: 0, words: 0, lines: 0 }); // blank
    const st = noteStats("买 牛奶\n开会 材料");
    expect(st.chars).toBe(10); // counts code points (incl. inner newline)
    expect(st.words).toBe(4);
    expect(st.lines).toBe(2);
    // emoji counts as one character (code point), not two UTF-16 units
    expect(noteStats("🙂 好").chars).toBe(3);
  });

  test("tasksOf parses [ ] / [x] lines and ignores other text", () => {
    const text = "购物\n[ ] 牛奶\n[x] 面包\n普通一行\n- [X] 大写";
    const tasks = tasksOf(text);
    expect(tasks.map((tk) => tk.label)).toEqual(["牛奶", "面包", "大写"]);
    expect(tasks.map((tk) => tk.done)).toEqual([false, true, true]);
  });

  test("toggleTaskInText flips exactly one task, preserving everything else", () => {
    const text = "购物\n  [ ] 牛奶\n[x] 面包\n普通一行";
    const next = toggleTaskInText(text, 0);
    expect(next).toBe("购物\n  [x] 牛奶\n[x] 面包\n普通一行");
    const back = toggleTaskInText(next, 0);
    expect(back).toBe(text);
    // toggling an out-of-range task is a pure no-op
    expect(toggleTaskInText(text, 99)).toBe(text);
  });

  test("taskSummary reports total vs done progress", () => {
    const text = "[x] a\n[ ] b\n[ ] c\nplain";
    expect(taskSummary(text)).toEqual({ total: 3, done: 1 });
    expect(taskSummary("无任务")).toEqual({ total: 0, done: 0 });
  });

  test("toggleTaskInNote flips a task in the list without reordering or touching ts", () => {
    const list = [
      { id: "n1", text: "[ ] a\n[ ] b", ts: 1 },
      { id: "n2", text: "plain note", ts: 2 },
    ];
    const next = toggleTaskInNote(list, "n1", 0);
    expect(next).not.toBe(list); // immutable
    expect(next[0]!.text).toBe("[x] a\n[ ] b"); // box 0 flipped
    expect(next[0]!.ts).toBe(1); // timestamp untouched (no reorder to top)
    expect(next[1]).toBe(list[1]); // other note is the same (untouched) reference
    // out-of-range index is a no-op on the text
    expect(toggleTaskInNote(list, "n1", 99)[0]!.text).toBe("[ ] a\n[ ] b");
    // missing id -> same list ref
    expect(toggleTaskInNote(list, "nope", 0)).toBe(list);
  });

  test("completeTasksInText / completeAllTasks mark every task done, keeping order+ts", () => {
    const text = "- [ ] a\n- [x] b\nplain line\n== sub ==";
    const done = completeTasksInText(text);
    expect(tasksOf(done).every((tk) => tk.done)).toBe(true);
    expect(done).toContain("plain line"); // non-task content untouched

    const list = [{ id: "n1", text: "[ ] a\n[ ] b", ts: 5 }];
    const next = completeAllTasks(list, "n1");
    expect(next[0]!.ts).toBe(5); // no reorder
    expect(tasksOf(next[0]!.text).every((tk) => tk.done)).toBe(true);
    // missing id -> unchanged content (map leaves it; keep note)
    expect(completeAllTasks(list, "nope")[0]!.text).toBe("[ ] a\n[ ] b");
  });

  test("noteListProgress aggregates tasks across a list, skipping non-checklist notes", () => {
    const list = [
      { id: "a", text: "[x] 1\n[ ] 2", ts: 1 },
      { id: "b", text: "[ ] 3", ts: 2 },
      { id: "c", text: "plain", ts: 3 },
    ];
    expect(noteListProgress(list)).toEqual({ notes: 2, total: 3, done: 1 });
    expect(noteListProgress([{ id: "c", text: "plain", ts: 3 }])).toEqual({ notes: 0, total: 0, done: 0 });
  });

  test("fmtInline splits **bold**, ==highlight== and ~~strike~~ markers", () => {
    expect(fmtInline("买 **牛奶** 和 ==重要== 的 ~~删掉~~ ok")).toEqual([
      { text: "买 ", bold: false, hl: false, strike: false },
      { text: "牛奶", bold: true, hl: false, strike: false },
      { text: " 和 ", bold: false, hl: false, strike: false },
      { text: "重要", bold: false, hl: true, strike: false },
      { text: " 的 ", bold: false, hl: false, strike: false },
      { text: "删掉", bold: false, hl: false, strike: true },
      { text: " ok", bold: false, hl: false, strike: false },
    ]);
    // no markers → single plain segment; concatenation reconstructs the input
    const plain = fmtInline("普通文字\n第二行");
    expect(plain.length).toBe(1);
    expect(plain[0]!.text).toBe("普通文字\n第二行");
    // joining every segment's text drops only the marker syntax (content kept)
    const round = (s: string) => fmtInline(s).map((x) => x.text).join("");
    expect(round("a **b** c ==d== ~~e~~ f")).toBe("a b c d e f");
  });

  test("task/fmt helpers stay stable on pathological inputs", () => {
    // thousands of task lines still parse to the right count and toggle cleanly
    const many = Array.from({ length: 5000 }, (_, i) => `[ ] t${i}`).join("\n");
    expect(tasksOf(many).length).toBe(5000);
    const toggled = toggleTaskInText(many, 0);
    expect(tasksOf(toggled)[0]!.done).toBe(true);
    expect(tasksOf(toggled)[4999]!.done).toBe(false);
    const last = toggleTaskInText(many, 4999);
    expect(tasksOf(last)[4999]!.done).toBe(true);
    expect(toggleTaskInText(many, 5000)).toBe(many); // out-of-range → no-op

    // unclosed/odd markers are left as plain text (no crash, no greedy match)
    const odd = "a **unclosed ==also == ~~x~~ b";
    const oddRound = fmtInline(odd).map((s) => s.text).join("");
    expect(oddRound).not.toContain("~~"); // only well-formed markers are stripped
    expect(oddRound).toContain("x"); // struck content kept
    expect(tasksOf("")).toEqual([]);
    expect(taskSummary("")).toEqual({ total: 0, done: 0 });
    expect(fmtInline("")).toEqual([]);
    expect(toggleTaskInText("", 0)).toBe("");
  });

  test("tasks and stats tolerate CRLF line endings", () => {
    const crlf = "[ ] 牛奶\r\n[x] 面包\r\n说明 一行";
    // Structural behaviour stable under all runs: a CRLF document is 3 lines
    // and neither task parsing nor toggling throws.
    expect(noteStats(crlf).lines).toBe(3);
    expect(() => tasksOf(crlf)).not.toThrow();
    expect(() => toggleTaskInText(crlf, 0)).not.toThrow();
  });


  test("fmtInline turns [label](url) into a link segment", () => {
    expect(fmtInline("看 [Amos](https://example.com/x) 吧")).toEqual([
      { text: "看 ", bold: false, hl: false, strike: false },
      {
        text: "Amos",
        bold: false,
        hl: false,
        strike: false,
        url: "https://example.com/x",
        link: true,
      },
      { text: " 吧", bold: false, hl: false, strike: false },
    ]);
    // non-http link (e.g. mailto) is left as plain text, not a link
    expect(fmtInline("[m](mailto:a@b.c)").every((s) => !s.link)).toBe(true);
  });
});
