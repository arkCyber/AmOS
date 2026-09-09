import { describe, expect, test } from "bun:test";
import { normalizeNotes, prependNote, removeNote, editNote, togglePin, orderPinned, setNoteState, notesOf, searchNotes, makeNote, fmtTime, noteStats, tasksOf, toggleTaskInText, toggleTaskInNote, taskSummary, completeTasksInText, completeAllTasks, noteListProgress, fmtInline, noteTitle, notePreview, noteDayOf, tagsOf, hasTag, filterByTag, setManyState, setPinned, removeMany, exportBaseName, noteExportText, createdOf, editedOf } from "../lib/notes";
import { orderByModified } from "../lib/notes";

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
describe("hashtags (#tag)", () => {
  test("tagsOf collects unique tags in order, case-insensitively deduped", () => {
    expect(tagsOf("买 #牛奶 和 #Work 再 #work")).toEqual(["牛奶", "Work"]);
    expect(tagsOf("无标签文本 #_u #x-y")).toEqual(["_u", "x-y"]);
    expect(tagsOf("中文 #标签也支持 ok")).toEqual(["标签也支持"]);
    expect(tagsOf("没有")).toEqual([]);
  });

  test("tagsOf ignores mid-word # (abc#tag); repeated ## still yields the word", () => {
    // `abc#notatag`: the # is preceded by a word char -> not a tag.
    // `##y`: the 2nd # is preceded by a # (not a word char) -> #y is a tag.
    expect(tagsOf("abc#notatag #x ##y")).toEqual(["x", "y"]);
  });

  test("hasTag matches a real token, not a substring, case-insensitively", () => {
    expect(hasTag("见 #Work 一下", "work")).toBe(true);
    expect(hasTag("加班 #working 中", "work")).toBe(false); // substring
    expect(hasTag("加班 #working 中", "working")).toBe(true);
    expect(hasTag("abc#x 里", "x")).toBe(false); // mid-word
    expect(hasTag("文本", "")).toBe(false);
  });

  test("filterByTag keeps only notes carrying the tag", () => {
    const list = [
      { id: "1", text: "买菜 #food", ts: 1 },
      { id: "2", text: "健身", ts: 2 },
      { id: "3", text: "外卖 #FOOD", ts: 3 },
      { id: "4", text: "食材 #food 详单", ts: 4 },
    ];
    expect(filterByTag(list, "food").map((n) => n.id)).toEqual(["1", "3", "4"]);
    expect(filterByTag(list, "nope")).toEqual([]);
  });

  test("fmtInline colors #tags as tag segments and preserves text on round-trip", () => {
    expect(fmtInline("记得 #todo 明天")).toEqual([
      { text: "记得 ", bold: false, hl: false, strike: false },
      { text: "#todo", bold: false, hl: false, strike: false, tag: true },
      { text: " 明天", bold: false, hl: false, strike: false },
    ]);
    // tags inside **bold** stay inside the bold span (no double tagging)
    const bold = fmtInline("**#inside** plain #outside");
    expect(bold[0]).toEqual({ text: "#inside", bold: true, hl: false, strike: false });
    expect(bold[bold.length - 1]).toMatchObject({ text: "#outside", tag: true });
    // verbatim round-trip of plain text (marker syntax like ** is consumed by design)
    const src = "a #b 中文#标签 ## x #y-z";
    expect(fmtInline(src).map((s) => s.text).join("")).toBe(src);
  });


  test("tags near punctuation and a numeric tag are recognized; empty text yields []", () => {
    // `#x#y`: the 2nd # is preceded by a word char -> only #x is a tag (mid-word rule).
    expect(tagsOf("(#work) #工作，#会议。 #x#y #123")).toEqual(["work", "工作", "会议", "x", "123"]);
    expect(tagsOf("")).toEqual([]);
  });

  test("hasTag accepts a leading '#' and never matches inside a bare URL fragment", () => {
    expect(hasTag("提 #work 吧", "#work")).toBe(true);
    // `x.com/a#frag`: the # is preceded by a word char -> not a tag.
    expect(hasTag("看 https://x.com/a#frag 了", "frag")).toBe(false);
  });

  test("filterByTag keeps input order and composes with plain subset rules", () => {
    const list = [
      { id: "1", text: "a #keep", ts: 1 },
      { id: "2", text: "b #KEEP 再 #other", ts: 2 },
      { id: "3", text: "c", ts: 3 },
      { id: "4", text: "d #keep-extra", ts: 4 }, // #keep-extra != #keep
    ];
    expect(filterByTag(list, "keep").map((n) => n.id)).toEqual(["1", "2"]);
  });

  test("fmtInline does not tag inside link/label text nor split a #-word at hyphen end", () => {
    // The visible label "[click me #x]" has no url marker -> its #x is still a tag,
    // but the real link "[go](https://e.com/p#frag)" label "go" has none.
    const linked = fmtInline("见 [go](https://e.com/p#frag) 好了");
    expect(linked.some((s) => s.link && s.text === "go")).toBe(true);
    expect(linked.some((s) => s.tag && s.text === "#frag")).toBe(false); // in the url, skipped
  });
});

describe("batch operations (multi-select)", () => {
  const base = [
    { id: "1", text: "a", ts: 1 },
    { id: "2", text: "b", ts: 2, pinned: true },
    { id: "3", text: "c", ts: 3, state: "archived" as const },
    { id: "4", text: "d", ts: 4, state: "trash" as const },
  ];

  test("setManyState moves many notes into a bucket and can restore them", () => {
    expect(setManyState(base, ["1", "2"], "archived").map((n) => n.state ?? null)).toEqual([
      "archived",
      "archived",
      "archived",
      "trash",
    ]);
    // restore out of trash
    expect(setManyState(base, ["4"], undefined).map((n) => n.state ?? null)).toEqual([
      null,
      null,
      "archived",
      null,
    ]);
    // untouched when no ids given
    expect(setManyState(base, [], "trash")).toBe(base);
  });

  test("setPinned(true) floats all selected to the top; (false) just clears the star", () => {
    const pinned = setPinned(base, ["1", "4"], true);
    expect(pinned.filter((n) => n.pinned).map((n) => n.id)).toEqual(["1", "2", "4"]);
    // every selected is pinned
    expect(pinned.every((n) => !["1", "4"].includes(n.id) || n.pinned)).toBe(true);
    const unpinned = setPinned(pinned, ["2"], false);
    expect(unpinned.find((n) => n.id === "2")!.pinned).toBeUndefined();
    expect(unpinned.length).toBe(pinned.length);
  });

  test("removeMany hard-deletes exactly the given ids", () => {
    expect(removeMany(base, ["1", "3", "nope"]).map((n) => n.id)).toEqual(["2", "4"]);
    expect(removeMany(base, [])).toBe(base);
  });
});

describe("export / share (.txt)", () => {
  test("exportBaseName stamps a filesystem-safe, padded date-time name", () => {
    const n = new Date(2026, 8, 6, 9, 5); // month is 0-based → Sep
    expect(exportBaseName(n)).toBe("备忘录-2026-09-06-0905");
    expect(exportBaseName(new Date(2026, 0, 3, 23, 59))).toBe("备忘录-2026-01-03-2359");
    // Only digits + `-` + the literal title prefix (safe for filesystems).
    expect(/[^备忘录0-9-]/.test(exportBaseName(n))).toBe(false);
  });

  test("noteExportText renders each note with title, timestamp, body, and a separator", () => {
    const list = [
      { id: "1", text: "买牛奶\n- [ ] 牛奶", ts: Date.UTC(2026, 8, 6) },
      { id: "2", text: "想法\n#idea 好点子", ts: Date.UTC(2026, 8, 6, 12) },
    ];
    const out = noteExportText(list);
    expect(out).toContain("买牛奶");
    expect(out).toContain("- [ ] 牛奶"); // body kept verbatim
    expect(out).toContain("#idea 好点子"); // rich markers kept as-is
    expect(out.split("\n\n----\n\n")).toHaveLength(2); // one separator between two notes
    expect(out.startsWith("买牛奶\n")).toBe(true); // title line first
  });

  test("noteExportText falls back to a placeholder title when the body has no text", () => {
    const out = noteExportText([{ id: "x", text: "   ", ts: 0 }]);
    expect(out).toContain("(无标题)");
  });
});

describe("fmtTime", () => {
  test("formats a timestamp into a localized string", () => {
    expect(typeof fmtTime(0)).toBe("string");
    expect(fmtTime(0).length).toBeGreaterThan(0);
    // different instants format differently
    expect(fmtTime(0)).not.toBe(fmtTime(86400000));
  });
});

describe("iOS-style note row helpers", () => {
  test("noteTitle returns the first meaningful line", () => {
    expect(noteTitle("买菜\n- [ ] 苹果")).toBe("买菜");
    expect(noteTitle("   - 标题行\n正文")).toBe("标题行");
    expect(noteTitle("   \n\n\n纯备注")).toBe("纯备注");
    expect(noteTitle("  ")).toBe("");
  });

  test("notePreview collapses the body after the title", () => {
    expect(notePreview("标题\n第一行\n  第二行")).toBe("第一行 第二行");
    expect(notePreview("只有标题")).toBe("");
    expect(notePreview("标题\n" + "长".repeat(200), 20).length).toBe(21); // 20 + ellipsis
  });

  test("noteDayOf reports whole-day deltas from now", () => {
    const now = new Date(2026, 8, 4, 12, 0, 0).getTime();
    expect(noteDayOf(now, now)).toBe(0); // today
    expect(noteDayOf(now - 86_400_000, now)).toBe(-1); // yesterday
    expect(noteDayOf(now + 86_400_000, now)).toBe(1); // tomorrow
  });
});


describe("note created/modified storage", () => {
  test("makeNote records created == ts", () => {
    const n = makeNote("hi", 500);
    expect(n.created).toBe(500);
    expect(createdOf(n)).toBe(500);
    expect(editedOf(n)).toBe(false); // not edited yet
  });

  test("editNote keeps created and bumps ts → editedOf true, createdOf stable", () => {
    const first = makeNote("a", 100);
    const after = editNote([first], first.id, "b", 999);
    const n = after[0]!;
    expect(n.created).toBe(100);
    expect(n.ts).toBe(999);
    expect(createdOf(n)).toBe(100);
    expect(editedOf(n)).toBe(true);
  });

  test("normalizeNotes back-fills created from ts for legacy notes", () => {
    const legacy = normalizeNotes([{ text: "legacy", ts: 42 }]);
    expect(legacy[0]!.created).toBeUndefined(); // older source had no created
    expect(createdOf(legacy[0]!)).toBe(42); // helper falls back to ts
    expect(editedOf(legacy[0]!)).toBe(false); // legacy: not "known edited"
  });

  test("normalizeNotes preserves a sane stored created", () => {
    const list = normalizeNotes([{ id: "x", text: "a", ts: 200, created: 100 }]);
    expect(list[0]!.created).toBe(100);
    expect(createdOf(list[0]!)).toBe(100);
    expect(editedOf(list[0]!)).toBe(true);
  });

  test("normalizeNotes ignores a non-numeric created and falls back", () => {
    const list = normalizeNotes([{ text: "a", ts: 5, created: "nope" }]);
    expect(list[0]!.created).toBeUndefined();
    expect(createdOf(list[0]!)).toBe(5);
  });
});


describe("orderByModified", () => {
  test("sorts by modified desc but keeps pinned notes on top", () => {
    const list = [
      { id: "a", text: "old", ts: 1 },
      { id: "b", text: "pinned old", ts: 2, pinned: true },
      { id: "c", text: "newest", ts: 9 },
    ];
    expect(orderByModified(list).map((n) => n.id)).toEqual(["b", "c", "a"]);
  });

  test("equal ts keeps insertion order (stable)", () => {
    const list = [
      { id: "x", text: "1", ts: 5 },
      { id: "y", text: "2", ts: 5 },
      { id: "z", text: "3", ts: 4 },
    ];
    expect(orderByModified(list).map((n) => n.id)).toEqual(["x", "y", "z"]);
  });

  test("does not mutate the input", () => {
    const list = [
      { id: "a", text: "old", ts: 1 },
      { id: "c", text: "new", ts: 9 },
    ];
    const before = list.map((n) => n.id);
    orderByModified(list);
    expect(list.map((n) => n.id)).toEqual(before);
  });
});

