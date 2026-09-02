import { describe, expect, test } from "bun:test";
import { prependNote, removeNote } from "../lib/notes";

describe("notes store helpers", () => {
  test("prependNote adds newest first with a timestamp", () => {
    const base = [{ text: "a", ts: 1 }];
    const next = prependNote(base, "b", 2);
    expect(next[0]).toEqual({ text: "b", ts: 2 });
    expect(next[1].text).toBe("a");
    expect(base.length).toBe(1); // immutable
  });

  test("removeNote deletes by timestamp and keeps the rest", () => {
    const list = [
      { text: "a", ts: 1 },
      { text: "b", ts: 2 },
      { text: "c", ts: 3 },
    ];
    const after = removeNote(list, 2);
    expect(after.map((n) => n.text)).toEqual(["a", "c"]);
    expect(after.length).toBe(2);
  });
});
