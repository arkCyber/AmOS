import { describe, expect, test } from "bun:test";
import { appendMessage, seedMessages } from "../lib/messages";
import { backspace, clearDial, pushKey, KEYS } from "../lib/phone";
import { seedTracks, stepIndex, wrap } from "../lib/music";

describe("messages", () => {
  test("seeds a conversation and appends outgoing chronologically", () => {
    const seed = seedMessages(3000);
    expect(seed.length).toBe(3);
    const next = appendMessage(seed, "收到", 4000);
    expect(next.length).toBe(4);
    expect(next[3]).toEqual({ from: "me", text: "收到", ts: 4000 });
  });
});

describe("phone", () => {
  test("dials digits and edits the number", () => {
    expect(KEYS.length).toBe(12);
    let n = "";
    for (const k of ["1", "3", "8", "0"]) n = pushKey(n, k);
    expect(n).toBe("1380");
    expect(backspace(n)).toBe("138");
    expect(clearDial(n)).toBe("");
  });
});

describe("music", () => {
  test("wraps indices across the playlist", () => {
    const total = seedTracks().length;
    expect(wrap(-1, total)).toBe(total - 1);
    expect(stepIndex(0, total, -1)).toBe(total - 1);
    expect(stepIndex(total - 1, total, 1)).toBe(0);
    expect(stepIndex(1, total, 1)).toBe(2);
  });

  test("wrap/stepIndex never produce NaN for an empty playlist", () => {
    expect(wrap(5, 0)).toBe(0);
    expect(stepIndex(0, 0, 1)).toBe(0);
    expect(wrap(3, -2)).toBe(0); // non-positive total guarded
    expect(Number.isNaN(wrap(1, 0))).toBe(false);
  });
});
