import { describe, expect, test } from "bun:test";
import {
  buildCitedSnippet,
  buildRagPrompt,
  hitSourceLabel,
  initialRagUi,
  noteIdFromRagId,
  noteRagId,
  notesToIndex,
  notesToRemove,
  ragUiReducer,
} from "../lib/notesRag";
import type { RagHit } from "../lib/rag";

function note(id: string, text: string) {
  return { id, text, ts: 1 };
}

const hit = (id: string, passage: string, score = 0.9): RagHit => ({ id, passage, score });

describe("ids", () => {
  test("noteRagId namespaces + noteIdFromRagId round-trips", () => {
    expect(noteRagId("abc")).toBe("note:abc");
    expect(noteIdFromRagId("note:abc")).toBe("abc");
    expect(noteIdFromRagId("pdf:x#p1")).toBeNull();
    expect(noteIdFromRagId("note:")).toBeNull();
  });
});

describe("notesToIndex", () => {
  test("emits one op per non-empty note in order, skipping blanks", () => {
    const ops = notesToIndex([note("a", "hello"), note("b", "   "), note("c", "world")]);
    expect(ops).toEqual([
      { id: "note:a", text: "hello" },
      { id: "note:c", text: "world" },
    ]);
  });
});

describe("notesToRemove", () => {
  test("removes indexed ids whose note is no longer active, keeps foreign ids out", () => {
    const out = notesToRemove(
      ["a", "c"], // b deleted/archived; note:z not ours to manage
      ["note:a", "note:b", "note:c", "pdf:file#p1"],
    );
    expect(out).toEqual(["note:b"]);
  });
});

describe("buildCitedSnippet", () => {
  test("renders passages as lines, dedupes, and always keeps the first hit", () => {
    const s = buildCitedSnippet(
      [hit("a", "预算正文"), hit("b", "预算正文"), hit("c", "会议纪要")],
      1000,
    );
    expect(s).toBe("- 预算正文\n- 会议纪要");
  });

  test("respects the char budget once more than one line", () => {
    const s = buildCitedSnippet([hit("a", "x"), hit("b", "y".repeat(100))], 5);
    // First line always kept; the second is dropped for exceeding the tiny budget.
    expect(s).toBe("- x");
  });

  test("empty input is empty string", () => {
    expect(buildCitedSnippet([])).toBe("");
  });
});

describe("buildRagPrompt", () => {
  test("wraps question with the cited context", () => {
    const p = buildRagPrompt("预算多少？", "- 预算 100 万");
    expect(p).toContain("[问题] 预算多少？");
    expect(p).toContain("- 预算 100 万");
  });
  test("returns the bare question when there is nothing to cite", () => {
    expect(buildRagPrompt("预算多少？", "   ")).toBe("预算多少？");
  });
});

describe("ragUiReducer state machine", () => {
  test("indexing flow", () => {
    const s = ragUiReducer(ragUiReducer(initialRagUi, { type: "index_started" }), {
      type: "index_done",
    });
    expect(s).toEqual({ phase: "idle", error: "" });
  });

  test("index failure surfaces an error and reset clears it", () => {
    const s = ragUiReducer(initialRagUi, { type: "index_started" });
    const failed = ragUiReducer(s, { type: "index_failed", error: "daemon offline" });
    expect(failed.phase).toBe("error");
    expect(failed.error).toBe("daemon offline");
    expect(ragUiReducer(failed, { type: "reset" })).toEqual(initialRagUi);
  });

  test("one operation at a time: ask cannot start while indexing", () => {
    const indexing = ragUiReducer(initialRagUi, { type: "index_started" });
    expect(ragUiReducer(indexing, { type: "ask_started" })).toBe(indexing);
  });

  test("ask_done returns to idle only from asking", () => {
    expect(ragUiReducer(initialRagUi, { type: "ask_done" })).toBe(initialRagUi);
  });
});

describe("hitSourceLabel (citation label)", () => {
  test("uses the note's title when the hit maps to a present note", () => {
    expect(hitSourceLabel("note:a", [note("a", "预算清单\n详细内容")])).toBe("预算清单");
  });

  test("falls back to the note id when the note is gone (stale index entry)", () => {
    expect(hitSourceLabel("note:gone", [note("a", "x")])).toBe("gone");
  });

  test("returns the raw id for a non-note source (e.g. a future pdf:) and for a titleless note", () => {
    expect(hitSourceLabel("pdf:doc#p1", [])).toBe("pdf:doc#p1");
    // A note whose title is empty falls back to its id (never an empty label).
    expect(hitSourceLabel("note:b", [note("b", "   ")])).toBe("b");
  });
});
