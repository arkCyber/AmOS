import { describe, expect, test } from "bun:test";
import {
  MSG_KEY,
  MESSAGE_CAP,
  seedMessages,
  appendMessage,
  appendQuote,
  normalizeMessages,
  clearMessages,
  removeMessageAt,
  fmtBubbleTime,
  dayStamp,
  messageDayLabel,
  isNewDay,
  unreadCount,
  markRead,
  markAllRead,
} from "../lib/messages";

const day = (y: number, mo: number, d: number, h = 12) =>
  new Date(y, mo - 1, d, h).getTime();

describe("messages", () => {
  test("seeds and appends (trims, refuses blank)", () => {
    const seed = seedMessages(3000);
    expect(seed.length).toBe(3);
    const a = appendMessage(seed, "  收到  ", 4000);
    expect(a.length).toBe(4);
    expect(a[a.length - 1]).toEqual({ from: "me", text: "收到", ts: 4000 });
    expect(appendMessage(seed, "   ", 4000)).toBe(seed); // blank no-op
  });

  test("appendQuote attaches a quote, trims text, guards blank", () => {
    const seed = seedMessages(1000);
    const q = appendQuote(seed, " 好的！ ", " 要不要试试 AI 应用？ ", 2000);
    expect(q[q.length - 1]).toEqual({
      from: "me",
      text: "好的！",
      ts: 2000,
      quote: "要不要试试 AI 应用？",
    });
    // whitespace-only quote degrades to a plain message
    const plain = appendQuote(seed, "收到", "   ", 2000);
    expect(plain[plain.length - 1]).toEqual({ from: "me", text: "收到", ts: 2000 });
    // blank body refused
    expect(appendQuote(seed, "  ", "hi", 2000)).toBe(seed);
  });

  test("normalizeMessages drops bad entries, repairs ts, caps at MESSAGE_CAP", () => {
    expect(normalizeMessages(null)).toEqual([]);
    expect(
      normalizeMessages([
        null,
        { from: "x", text: "bad-sender" },
        { from: "them", text: "   " },
        { from: "me", text: "hi", ts: "now" }, // ts non-numeric -> 0
      ]),
    ).toEqual([{ from: "me", text: "hi", ts: 0 }]);

    // cap keeps only the newest MESSAGE_CAP
    const big = Array.from({ length: MESSAGE_CAP + 5 }, (_, i) => ({
      from: "me" as const,
      text: `m${i}`,
      ts: i,
    }));
    const capped = normalizeMessages(big);
    expect(capped.length).toBe(MESSAGE_CAP);
    expect(capped[capped.length - 1]?.text).toBe(`m${MESSAGE_CAP + 4}`);
  });

  test("clearMessages and removeMessageAt", () => {
    expect(clearMessages()).toEqual([]);
    const seed = seedMessages(1000);
    const after = removeMessageAt(seed, 1);
    expect(after.length).toBe(2);
    expect(seed.length).toBe(3); // immutable
    expect(removeMessageAt(seed, -1)).toBe(seed);
    expect(removeMessageAt(seed, 99)).toBe(seed);
  });

  test("time/day helpers are deterministic", () => {
    const noon = day(2024, 1, 2, 12);
    expect(fmtBubbleTime(noon)).toBe("12:00");
    expect(dayStamp(noon)).toBe("2024-01-02");
    expect(messageDayLabel(noon, noon)).toBe("today");
    expect(messageDayLabel(noon - 86400000, noon)).toBe("yesterday");
    expect(messageDayLabel(noon - 2 * 86400000, noon)).toBe("2023-12-31");
    expect(isNewDay(noon - 1000, noon)).toBe(false);
    expect(isNewDay(noon - 86400000, noon)).toBe(true);
  });

  test("unread is incoming-only; markRead / markAllRead", () => {
    const list = [
      { from: "them" as const, text: "a", ts: 1 }, // unread
      { from: "them" as const, text: "b", ts: 2, read: true },
      { from: "them" as const, text: "c", ts: 3 }, // unread
      { from: "me" as const, text: "d", ts: 4 }, // outgoing never unread
    ];
    expect(unreadCount(list)).toBe(2);
    const one = markRead(list, 0);
    expect(unreadCount(one)).toBe(1);
    const all = markAllRead(list);
    expect(unreadCount(all)).toBe(0);
    expect(markAllRead(all)).toBe(all); // nothing unread -> no-op (same ref)
    expect(markRead(list, 99)).toBe(list);
  });

  test("constants are sane", () => {
    expect(MSG_KEY).toBe("amos.messages");
    expect(MESSAGE_CAP).toBeGreaterThan(0);
    expect(MESSAGE_CAP).toBe(200);
  });
});
