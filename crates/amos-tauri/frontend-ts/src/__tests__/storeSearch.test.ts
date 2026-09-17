/**
 * Unit tests for `lib/storeSearch.ts` — the App Store search decision (REQ-A315).
 *
 * The rule under test is small but load-bearing: the *screen* must not be able to
 * turn an empty box into a search, and it must not silently shorten what the user
 * typed (the daemon owns the 256-byte ceiling and refuses a long query; the refusal
 * is shown, not hidden by truncation).
 */
import { describe, expect, it } from "bun:test";
import { searchQueryOf } from "../lib/storeSearch";

describe("searchQueryOf", () => {
  it("trims a real query and hands it on unchanged", () => {
    expect(searchQueryOf("pomodoro")).toBe("pomodoro");
    expect(searchQueryOf("  note markdown  ")).toBe("note markdown");
    expect(searchQueryOf("中国象棋")).toBe("中国象棋"); // non-ASCII is a real query
  });

  it("answers null for an empty box: that is *browse*, not a search for \"\"", () => {
    expect(searchQueryOf("")).toBeNull();
    expect(searchQueryOf("   ")).toBeNull();
    expect(searchQueryOf("\t\n ")).toBeNull();
  });

  it("is total for non-strings (a form value can be anything)", () => {
    expect(searchQueryOf(undefined)).toBeNull();
    expect(searchQueryOf(null)).toBeNull();
    expect(searchQueryOf(42)).toBeNull();
    expect(searchQueryOf({ q: "x" })).toBeNull();
  });

  it("never truncates: a too-long query goes to the host, which refuses it", () => {
    // Silently shortening what the user typed would be a lie about what was searched —
    // the daemon's own refusal (shown by the screen) is the honest path.
    const long = "x".repeat(500);
    expect(searchQueryOf(long)).toBe(long);
  });
});
