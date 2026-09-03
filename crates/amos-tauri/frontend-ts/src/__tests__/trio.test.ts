import { describe, expect, test } from "bun:test";
import { appendMessage, appendQuote, clearMessages, normalizeMessages, removeMessageAt, seedMessages } from "../lib/messages";
import { fmtBubbleTime, isNewDay, messageDayLabel } from "../lib/messages";
import { unreadCount, markAllRead, markRead } from "../lib/messages";
import { backspace, clearDial, pushKey, KEYS, MAX_DIAL_LEN } from "../lib/phone";
import { seedTracks, normalizeTracks, stepIndex, wrap, removeTrack, nextIndexAfterRemoval, nextIndex, pctProgress, seekSeconds, DEMO_LYRICS, lyricIndex } from "../lib/music";

describe("messages", () => {
  test("seeds a conversation and appends outgoing chronologically", () => {
    const seed = seedMessages(3000);
    expect(seed.length).toBe(3);
    const next = appendMessage(seed, "收到", 4000);
    expect(next.length).toBe(4);
    expect(next[3]).toEqual({ from: "me", text: "收到", ts: 4000 });
  });

  test("appendQuote attaches a quote and trims/drops empty ones", () => {
    const seed = seedMessages(1000);
    const q = appendQuote(seed, "好的！", "要不要试试 AI 应用？", 2000);
    expect(q[q.length - 1]).toEqual({
      from: "me",
      text: "好的！",
      ts: 2000,
      quote: "要不要试试 AI 应用？",
    });
    // whitespace-only quote degrades to a normal message
    const plain = appendQuote(seed, "收到", "   ", 2000);
    expect(plain[plain.length - 1]).toEqual({ from: "me", text: "收到", ts: 2000 });
  });

  test("clearMessages resets to a brand-new empty conversation", () => {
    const next = clearMessages();
    expect(next).toEqual([]);
  });

  test("removeMessageAt deletes exactly one message, immutably", () => {
    const seed = seedMessages(1000);
    const after = removeMessageAt(seed, 1);
    expect(after.length).toBe(seed.length - 1);
    expect(after.map((m) => m.text)).toEqual([
      "你好！Amos 系统感觉怎么样？",
      "要不要试试 AI 应用？",
    ]);
    expect(seed.length).toBe(3); // original untouched

    // out-of-range index → true no-op (same reference)
    expect(removeMessageAt(seed, -1)).toBe(seed);
    expect(removeMessageAt(seed, seed.length)).toBe(seed);
  });

  test("bubble times and day grouping helpers are deterministic", () => {
    // noon local time — constructed locally so tests aren't TZ-sensitive
    const noon = new Date(2024, 0, 2, 12, 5).getTime();
    expect(fmtBubbleTime(noon)).toBe("12:05");

    const now = noon; // same instant as "now"
    expect(messageDayLabel(noon, now)).toBe("today");
    expect(messageDayLabel(noon - 86400000, now)).toBe("yesterday");
    expect(messageDayLabel(noon - 2 * 86400000, now)).toBe("2023-12-31");

    expect(isNewDay(noon - 86400000, noon)).toBe(true);
    expect(isNewDay(noon, noon)).toBe(false);
    expect(isNewDay(noon, noon + 60_000)).toBe(false); // same day
  });

  test("read/unread helpers count and clear only incoming messages", () => {
    const seed = seedMessages(1000); // them(read) , me, them(unread)
    expect(unreadCount(seed)).toBe(1);

    // mark all read → none unread; again is a no-op (same ref)
    const all = markAllRead(seed);
    expect(unreadCount(all)).toBe(0);
    expect(markAllRead(all)).toBe(all);

    // markRead on the specific unread incoming clears it; outgoing are ignored
    const one = markRead(seed, 2);
    expect(unreadCount(one)).toBe(0);
    expect(unreadCount(markRead(seed, 1))).toBe(1); // me is never counted/cleared
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

  test("pushKey never exceeds the max dial length", () => {
    let n = "";
    for (let i = 0; i < MAX_DIAL_LEN + 5; i++) n = pushKey(n, String(i % 10));
    expect(n.length).toBe(MAX_DIAL_LEN);
    // further presses are ignored, and the existing number is untouched
    const before = n;
    expect(pushKey(n, "9")).toBe(before);
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

  test("removeTrack filters by id without mutating the input", () => {
    const list = seedTracks();
    const next = removeTrack(list, "m2");
    expect(next.map((t) => t.id)).toEqual(["m1", "m3"]);
    expect(list.length).toBe(3); // original untouched
    expect(removeTrack(list, "nope")).toEqual(list);
  });

  test("nextIndexAfterRemoval keeps the same song when possible", () => {
    // removing a track *after* the playing one → index unchanged
    expect(nextIndexAfterRemoval(1, 2, 3)).toBe(1);
    // removing a track *before* the playing one → index shifts left
    expect(nextIndexAfterRemoval(2, 0, 3)).toBe(1);
    // removing the currently-playing one → next track slides into this slot
    expect(nextIndexAfterRemoval(1, 1, 2)).toBe(1);
    // removing the *last* playing track → falls back to the new last entry
    expect(nextIndexAfterRemoval(2, 2, 2)).toBe(1);
    // everything collapses to a single track
    expect(nextIndexAfterRemoval(2, 2, 1)).toBe(0);
    // removing the only track (empty result) is guarded to 0
    expect(nextIndexAfterRemoval(0, 0, 0)).toBe(0);
  });

  test("nextIndex honours repeat mode (one / off / all)", () => {
    const total = seedTracks().length; // 3
    // repeat one: stays put
    expect(nextIndex(0, total, 1, "one")).toBe(0);
    expect(nextIndex(2, total, 1, "one")).toBe(2);
    // off: clamps at the ends
    expect(nextIndex(2, total, 1, "off")).toBe(2);
    expect(nextIndex(0, total, -1, "off")).toBe(0);
    expect(nextIndex(1, total, 1, "off")).toBe(2);
    // all: wraps
    expect(nextIndex(2, total, 1, "all")).toBe(0);
    expect(nextIndex(0, total, -1, "all")).toBe(2);
  });

  test("progress helpers bound the fraction and map to seconds", () => {
    const total = 200;
    expect(pctProgress(100, total)).toBeCloseTo(0.5);
    expect(pctProgress(-5, total)).toBe(0);
    expect(pctProgress(1e9, total)).toBe(1);
    expect(pctProgress(0, 0)).toBe(0); // no total → 0 (no NaN)

    expect(seekSeconds(0.25, total)).toBe(50);
    expect(seekSeconds(1, total)).toBe(total); // seek-to-end → next track
    expect(seekSeconds(-1, total)).toBe(0); // clamped
    expect(seekSeconds(0.5, 0)).toBe(0); // no total → 0
  });

  test("lyricIndex highlights a line that scrolls across the track", () => {
    const len = DEMO_LYRICS.length; // 5
    const total = 100;
    expect(lyricIndex(0, total, len)).toBe(0); // start of track
    expect(lyricIndex(100, total, len)).toBe(len - 1); // end → last line
    // evenly spaced across the duration
    expect(lyricIndex(20, total, len)).toBe(1);
    expect(lyricIndex(45, total, len)).toBe(2);
    expect(lyricIndex(-1, total, len)).toBe(0); // clamped
    expect(lyricIndex(999, total, len)).toBe(len - 1); // clamped
    expect(lyricIndex(10, total, 0)).toBe(0); // no lines → 0
  });
});
describe("storage normalization guards", () => {
  test("normalizeMessages drops bad sender/blank bodies, keeps read/quote", () => {
    const corrupt: unknown = [
      { from: "them", text: "hi", ts: 1, read: true },
      { from: "me", text: "ok", ts: 2, quote: "hi" },
      { from: "ghost", text: "x", ts: 3 }, // bad sender → dropped
      { from: "them", text: "   ", ts: 4 }, // blank body → dropped
      null,
      5,
      {},
    ];
    const out = normalizeMessages(corrupt);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ from: "them", text: "hi", ts: 1, read: true });
    expect(out[1]).toEqual({ from: "me", text: "ok", ts: 2, quote: "hi" });
    expect(normalizeMessages(null)).toEqual([]);
    expect(normalizeMessages({})).toEqual([]);
  });

  test("normalizeTracks drops title-less, back-fills ids, dedups", () => {
    const corrupt: unknown = [
      { id: "a", title: "晨光", artist: "Amos" },
      { id: "a", title: "星河" }, // id collision
      { title: "晚风" }, // no id → back-filled
      { title: "  " }, // blank title → dropped
      null,
      7,
    ];
    const out = normalizeTracks(corrupt);
    expect(out.length).toBe(3);
    const ids = new Set(out.map((t) => t.id));
    expect(ids.size).toBe(3);
    expect(out.find((t) => t.title === "晨光")?.artist).toBe("Amos");
    expect(out.find((t) => t.title === "星河")?.artist).toBe(""); // optional defaulted
    expect(normalizeTracks(undefined)).toEqual([]);
  });
});

