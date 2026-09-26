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
    expect(normalizeNotesPrefs({ openInEditor: true })).toEqual({
      openInEditor: true,
      sortByModified: false,
      palmRejection: true,
    });
    expect(normalizeNotesPrefs({ openInEditor: "yes" })).toEqual(defaultNotesPrefs);
    expect(normalizeNotesPrefs({ openInEditor: true, extra: 1 })).toEqual({
      openInEditor: true,
      sortByModified: false,
      palmRejection: true,
    });
  });
  test("sortByModified defaults off and is boolean-coerced", () => {
    expect(normalizeNotesPrefs({})).toEqual({
      openInEditor: false,
      sortByModified: false,
      palmRejection: true,
    });
    expect(normalizeNotesPrefs({ openInEditor: true, sortByModified: true })).toEqual({
      openInEditor: true,
      sortByModified: true,
      palmRejection: true,
    });
    expect(normalizeNotesPrefs({ sortByModified: "yes" })).toEqual(defaultNotesPrefs);
  });
  // REQ-A526: palm rejection is the one pref whose *safe* value is "on", so a legacy
  // stored blob (written before the field existed) must degrade to true, not false —
  // a palm that draws is not a recoverable mistake.
  test("palmRejection defaults ON and is boolean-coerced", () => {
    expect(normalizeNotesPrefs({ openInEditor: true, sortByModified: true }).palmRejection).toBe(true);
    expect(normalizeNotesPrefs({ palmRejection: false }).palmRejection).toBe(false);
    expect(normalizeNotesPrefs({ palmRejection: true }).palmRejection).toBe(true);
    expect(normalizeNotesPrefs({ palmRejection: "no" }).palmRejection).toBe(true);
    expect(normalizeNotesPrefs({ palmRejection: 0 }).palmRejection).toBe(true);
    expect(defaultNotesPrefs.palmRejection).toBe(true);
  });
});
