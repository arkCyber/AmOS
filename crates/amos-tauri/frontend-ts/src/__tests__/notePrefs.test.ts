import { describe, expect, test } from "bun:test";
import { defaultNotesPrefs, normalizeNotesPrefs } from "../lib/notePrefs";

describe("normalizeNotesPrefs", () => {
  test("defaults when raw is missing / not an object", () => {
    expect(normalizeNotesPrefs(null)).toEqual(defaultNotesPrefs);
    expect(normalizeNotesPrefs("x")).toEqual(defaultNotesPrefs);
    expect(normalizeNotesPrefs([1])).toEqual(defaultNotesPrefs);
    expect(normalizeNotesPrefs(undefined)).toEqual(defaultNotesPrefs);
  });
  test("accepts a boolean openInEditor and ignores junk", () => {
    expect(normalizeNotesPrefs({ openInEditor: true })).toEqual({ openInEditor: true, sortByModified: false });
    expect(normalizeNotesPrefs({ openInEditor: "yes" })).toEqual(defaultNotesPrefs);
    expect(normalizeNotesPrefs({ openInEditor: true, extra: 1 })).toEqual({ openInEditor: true, sortByModified: false });
  });
  test("sortByModified defaults off and is boolean-coerced", () => {
    expect(normalizeNotesPrefs({})).toEqual({ openInEditor: false, sortByModified: false });
    expect(normalizeNotesPrefs({ openInEditor: true, sortByModified: true })).toEqual({
      openInEditor: true,
      sortByModified: true,
    });
    expect(normalizeNotesPrefs({ sortByModified: "yes" })).toEqual(defaultNotesPrefs);
  });
});
