import { describe, expect, test } from "bun:test";
import {
  DRAFT_CAP,
  draftId,
  normalizeDrafts,
  removeDraft,
  saveDraft,
  sortDrafts,
} from "../lib/smsDrafts";

describe("smsDrafts (pure)", () => {
  test("saving keeps one draft per address and sorts newest first", () => {
    let list = saveDraft([], "+8613800138000", "hi", 100);
    list = saveDraft(list, "10086", "TD", 200);
    list = saveDraft(list, "+8613800138000", "hi again", 300); // replaces
    expect(list.length).toBe(2);
    // newest first
    expect(list[0]).toEqual({
      id: draftId("+8613800138000"),
      address: "+8613800138000",
      text: "hi again",
      ts: 300,
    });
    expect(list[1]?.text).toBe("TD");
    expect(list[1]?.ts).toBe(200);
  });

  test("a blank body removes the draft instead of storing an empty one", () => {
    let list = saveDraft([], "10086", "TD", 1);
    list = saveDraft(list, "10086", "   ", 2);
    expect(list).toEqual([]);
  });

  test("removeDraft drops only the addressed draft", () => {
    const list = saveDraft(saveDraft([], "10086", "a", 1), "10010", "b", 2);
    const after = removeDraft(list, draftId("10086"));
    expect(after.map((d) => d.address)).toEqual(["10010"]);
    expect(removeDraft(after, "nope").length).toBe(1);
  });

  test("normalizeDrafts is a corruption guard", () => {
    const raw = [
      { id: "d:1", address: "10086", text: "ok", ts: 5 },
      { address: "  ", text: "no address" },
      { address: "10010", text: "" },
      { address: "10011", text: "no ts" },
      "garbage",
      null,
    ];
    const out = normalizeDrafts(raw);
    // Blank-address/blank-body rows are dropped; the rest sort newest-first.
    expect(out.map((d) => d.address)).toEqual(["10086", "10011"]);
    expect(out[0]?.id).toBe("d:1");
    expect(out[1]?.id).toBe(draftId("10011")); // id derived when missing
    expect(out[1]?.ts).toBe(0);
    expect(normalizeDrafts("nope")).toEqual([]);
  });

  test("the stored list is bounded", () => {
    let list: ReturnType<typeof saveDraft> = [];
    for (let i = 0; i < DRAFT_CAP + 10; i++) list = saveDraft(list, `100${i}`, `t${i}`, i);
    expect(list.length).toBe(DRAFT_CAP);
    expect(sortDrafts(list)[0]?.ts).toBe(DRAFT_CAP + 9); // newest kept
  });
});
