import { describe, expect, test } from "bun:test";
import { normalizeNotes, prependNote, removeNote, makeNote } from "../lib/notes";

describe("notes store helpers", () => {
  test("prependNote adds newest first, each with a unique id", () => {
    const base = [{ id: "n1", text: "a", ts: 1 }];
    const next = prependNote(base, "b", 2);
    expect(next[0].text).toBe("b");
    expect(next[0].ts).toBe(2);
    expect(typeof next[0].id).toBe("string");
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
    expect(normalized[0].id).toBe("5-0"); // legacy backfilled
    expect(normalized[1].id).toBe("same");
    expect(normalized[2].id).toBe("same-1"); // collision resolved
    const ids = normalized.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(normalizeNotes("nope")).toEqual([]);
    expect(normalizeNotes(null)).toEqual([]);
  });
});
