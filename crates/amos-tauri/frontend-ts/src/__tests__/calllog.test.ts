import { beforeEach, describe, expect, test } from "bun:test";
import {
  CALLLOG_CAP,
  CALLLOG_KEY,
  callDateStamp,
  callDigits,
  callHistory,
  callWhenLabel,
  clearCallHistory,
  resetPendingCallsForTest,
  filterHistory,
  flushPendingCalls,
  fmtCallClock,
  frequentNumbers,
  logNameFor,
  missedCalls,
  normalizeCallLog,
  normalizeDirection,
  pendingCallCount,
  queuePendingCall,
  recentNumbers,
  recordCall,
  sameCallNumber,
  type CallFilter,
  type CallRecord,
} from "../lib/calllog";

function r(number: string, ts: number, name?: string): CallRecord {
  return { number, ts, name };
}

describe("calllog", () => {
  test("callDigits keeps only meaningful digits (and a leading +)", () => {
    expect(callDigits("+86 138-0000 0001")).toBe("+8613800000001");
    expect(callDigits("138 (0000) 0001")).toBe("13800000001");
    expect(callDigits("  ")).toBe("");
  });

  test("normalizeCallLog keeps valid records newest-first and caps (history preserved)", () => {
    const raw = [
      r("222", 2),
      null,
      r("111", 1),
      { number: "  ", ts: 3 },
      r("222", 4), // repeat is KEPT (so frequency can be counted)
      { number: 42, ts: 9 },
    ];
    const out = normalizeCallLog(raw);
    expect(out.map((x) => x.number)).toEqual(["222", "222", "111"]); // newest-first, repeats kept
    expect(out[0]!.ts).toBe(4);
    expect(normalizeCallLog("nope")).toEqual([]);
  });

  test("recordCall prepends (keeping history), never mutates, caps", () => {
    const list = [r("111", 1, "Alice"), r("222", 2, "Bob")];
    const next = recordCall(list, "222", "Bob", 3);
    expect(next).toHaveLength(3); // repeat retained for frequency stats
    expect(next[0]!.number).toBe("222");
    expect(next[0]!.ts).toBe(3);
    expect(list).toHaveLength(2); // immutable
    expect(recordCall(list, "   ", undefined, 3)).toBe(list); // blank refused
    // cap
    let many = list;
    for (let i = 0; i < CALLLOG_CAP + 10; i++) many = recordCall(many, `num${i}`, undefined, i);
    expect(many.length).toBeLessThanOrEqual(CALLLOG_CAP);
  });

  test("recordCall never stores a number as its own name", () => {
    const out = recordCall([], "138 0000 0001", "138 0000 0001", 1);
    expect(out[0]!.name).toBeUndefined();
    const named = recordCall([], "138 0000 0001", "Alice", 1);
    expect(named[0]!.name).toBe("Alice");
  });

  test("recentNumbers / logNameFor / frequentNumbers", () => {
    const list = normalizeCallLog([
      r("111", 1, "Alice"),
      r("111", 2),
      r("222", 3, "Bob"),
      r("222", 4, "Bob"),
      r("222", 5, "Bob"),
    ]);
    expect(recentNumbers(list, 2)).toEqual(["222", "111"]);
    expect(logNameFor(list, "222")).toBe("Bob");
    expect(logNameFor(list, "999")).toBeUndefined();
    expect(frequentNumbers(list, 1)).toEqual(["222"]); // most calls
    expect(CALLLOG_KEY).toBe("amos.calllog");
  });

  test("frequentNumbers returns the most recent display form, not digit keys", () => {
    const list = [
      r("+86 138 0000 0001", 1, "Alice"),
      r("+86 138 0000 0001", 2, "Alice"),
      r("+86 138 0000 0001", 3, "Alice"),
      r("999", 4),
    ];
    expect(frequentNumbers(list, 1)).toEqual(["+86 138 0000 0001"]);
    expect(frequentNumbers(list, 2)).toEqual(["+86 138 0000 0001", "999"]);
  });

  test("sameCallNumber unifies +CC and bare forms, keeps distinct numbers apart", () => {
    expect(sameCallNumber("+86 138 0000 0001", "13800000001")).toBe(true);
    expect(sameCallNumber("+86 13800000001", "+86 138 0000 0001")).toBe(true);
    expect(sameCallNumber("13800000001", "13800000001")).toBe(true);
    expect(sameCallNumber("13800000001", "999")).toBe(false);
    expect(sameCallNumber("", "13800000001")).toBe(false);
  });

  test("recent & frequent treat a number dialed in +CC and bare forms as one", () => {
    const list = normalizeCallLog([
      r("13800000001", 1),
      r("+86 138 0000 0001", 2),
      r("13800000001", 3),
    ]);
    expect(recentNumbers(list, 5)).toEqual(["13800000001"]); // single distinct number
    expect(frequentNumbers(list, 1)).toHaveLength(1); // counted once as a group
  });
});

  test("logNameFor resolves +CC and bare local forms of the same number to one name", () => {
    const mk = (number: string, name?: string, ts = 0): CallRecord => ({ number, name, ts });
    const list = [
      mk("13800000001", "Alice", 3),
      mk("+86 13800000001", undefined, 2),
      mk("13900000002", "Bob", 1),
    ];
    // bare lookup finds the name stored on the +CC form (and vice-versa)
    expect(logNameFor(list, "+86 13800000001")).toBe("Alice");
    expect(logNameFor(list, "13800000001")).toBe("Alice");
    expect(logNameFor(list, "13900000002")).toBe("Bob");
    expect(logNameFor(list, "999")).toBeUndefined();
    expect(logNameFor(list, "")).toBeUndefined();
  });


describe("call history: direction + time labels", () => {
  test("normalizeDirection whitelists; junk never becomes a direction", () => {
    expect(normalizeDirection("incoming")).toBe("incoming");
    expect(normalizeDirection("outgoing")).toBe("outgoing");
    expect(normalizeDirection("missed")).toBe("missed");
    expect(normalizeDirection("Incoming")).toBeUndefined();
    expect(normalizeDirection("received")).toBeUndefined();
    expect(normalizeDirection(undefined)).toBeUndefined();
    expect(normalizeDirection(1)).toBeUndefined();
  });

  test("recordCall stores a direction; junk directions are dropped", () => {
    const out = recordCall([], "13800000001", "Alice", 5, "incoming");
    expect(out[0]!.direction).toBe("incoming");
    // An unknown direction is not silently coerced to something else.
    const junk = recordCall([], "13800000001", undefined, 6, "bogus" as never);
    expect(junk[0]!.direction).toBeUndefined();
  });

  test("legacy records without a direction stay direction-less (never guessed)", () => {
    const out = normalizeCallLog([{ number: "111", ts: 1 }]);
    expect(out[0]!.direction).toBeUndefined();
    expect("direction" in out[0]!).toBe(false);
    // …while a stored valid one survives a normalize round-trip.
    const kept = normalizeCallLog([{ number: "222", ts: 2, direction: "missed" }]);
    expect(kept[0]!.direction).toBe("missed");
  });

  test("callWhenLabel buckets today / yesterday / older / unknown", () => {
    const now = new Date(2026, 8, 10, 12, 0, 0).getTime(); // local Sept 10 2026
    expect(callWhenLabel(now, now)).toBe("today");
    expect(callWhenLabel(now - 3600_000, now)).toBe("today");
    expect(callWhenLabel(now - 86400000, now)).toBe("yesterday");
    expect(callWhenLabel(new Date(2026, 7, 1, 9, 0).getTime(), now)).toBe("date");
    expect(callWhenLabel(0, now)).toBe("unknown");
    expect(callWhenLabel(Number.NaN, now)).toBe("unknown");
    // A calendar-day boundary is not a 24h window: 23:59 vs 00:01 next day differ.
    const late = new Date(2026, 8, 10, 23, 59, 0).getTime();
    const nextMorning = new Date(2026, 8, 11, 0, 1, 0).getTime();
    expect(callWhenLabel(late, nextMorning)).toBe("yesterday");
  });

  test("callDateStamp / fmtCallClock are padded and honest about unknown times", () => {
    const ts = new Date(2026, 8, 10, 9, 5).getTime();
    expect(callDateStamp(ts)).toBe("2026-09-10");
    expect(fmtCallClock(ts)).toBe("09:05");
    expect(callDateStamp(0)).toBe("");
    expect(fmtCallClock(0)).toBe("");
    expect(fmtCallClock(Number.NaN)).toBe("");
  });

  test("callHistory is newest-first + capped; missedCalls counts missed rows", () => {
    const list = normalizeCallLog([
      { number: "111", ts: 1, direction: "outgoing" },
      { number: "222", ts: 3, direction: "missed" },
      { number: "333", ts: 2, direction: "incoming" },
    ]);
    expect(callHistory(list).map((r) => r.number)).toEqual(["222", "333", "111"]);
    expect(callHistory("nope")).toEqual([]);
    expect(missedCalls(list)).toBe(1);
    expect(missedCalls([])).toBe(0);
    // cap still applies through callHistory
    const many = Array.from({ length: CALLLOG_CAP + 5 }, (_, i) => ({ number: `n${i}`, ts: i }));
    expect(callHistory(many)).toHaveLength(CALLLOG_CAP);
  });

  test("filterHistory selects one direction; 'all' is the whole (normalized) log", () => {
    const raw = [
      { number: "111", ts: 1, direction: "outgoing" },
      { number: "222", ts: 3, direction: "missed" },
      { number: "333", ts: 2, direction: "incoming" },
      { number: "444", ts: 4, direction: "missed" },
      { number: "555", ts: 5 }, // legacy row: no direction, never guessed into a bucket
    ];
    const all: CallFilter[] = ["all", "incoming", "outgoing", "missed"];
    expect(filterHistory(raw, "all").length).toBe(5);
    expect(filterHistory(raw, "missed").map((r) => r.number)).toEqual(["444", "222"]);
    expect(filterHistory(raw, "incoming").map((r) => r.number)).toEqual(["333"]);
    expect(filterHistory(raw, "outgoing").map((r) => r.number)).toEqual(["111"]);
    // A direction-less legacy row appears under "all" only — it is never counted
    // as any specific direction.
    for (const f of all) {
      const rows = filterHistory(raw, f);
      const has555 = rows.some((r) => r.number === "555");
      expect(has555).toBe(f === "all");
    }
    // Junk input degrades to the empty log rather than throwing.
    expect(filterHistory("nope", "all")).toEqual([]);
    expect(filterHistory([], "missed")).toEqual([]);
    // Capping/normalization still applies through the filter.
    const many = Array.from({ length: CALLLOG_CAP + 5 }, (_, i) => ({
      number: `n${i}`,
      ts: i,
      direction: "missed" as const,
    }));
    expect(filterHistory(many, "missed")).toHaveLength(CALLLOG_CAP);
  });

  test("clearCallHistory is the empty (valid, normalized) log", () => {
    const cleared = clearCallHistory();
    expect(cleared).toEqual([]);
    expect(callHistory(cleared)).toEqual([]);
    expect(missedCalls(cleared)).toBe(0);
    expect(filterHistory(cleared, "missed")).toEqual([]);
  });
});

/**
 * REQ-A150 — a rejected call-log write must not lose the row.
 *
 * The incoming-call overlay appends its row as the call ends, i.e. when no screen is up to
 * report a failure; before this, a rejected write cost that history row silently. The
 * queue below is what makes it recoverable, and its boundary (in-memory, so a reload
 * before a successful flush still loses it) is stated in `lib/calllog`.
 */
describe("pending calls (a rejected write is queued, not lost)", () => {
  beforeEach(() => resetPendingCallsForTest());

  test("a rejected append is queued with its direction and timestamp intact", () => {
    queuePendingCall(recordCall([], "13800000000", undefined, 1000, "incoming")[0]);

    expect(pendingCallCount()).toBe(1);
    // Assert through the real path (a flush), not through an inspection-only export.
    let saved: CallRecord[] = [];
    flushPendingCalls([], (next) => {
      saved = next;
      return true;
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.number).toBe("13800000000");
    expect(saved[0]?.direction).toBe("incoming");
    expect(saved[0]?.ts).toBe(1000);
  });

  test("a repeated Ended event does not queue the same row twice", () => {
    const rec = recordCall([], "13800000000", undefined, 1000, "missed")[0];
    queuePendingCall(rec);
    queuePendingCall(rec);

    let flushes = 0;
    flushPendingCalls([], () => {
      flushes += 1;
      return true;
    });
    expect(flushes).toBe(1);
    expect(pendingCallCount()).toBe(0);
  });

  test("a record with no usable number is never queued", () => {
    queuePendingCall({ number: "   ", ts: 1 });
    queuePendingCall(undefined);
    expect(pendingCallCount()).toBe(0);
  });

  test("a successful flush lands the queued call newest-first and empties the queue", () => {
    const existing = recordCall([], "100", undefined, 500, "outgoing");
    queuePendingCall(recordCall([], "200", undefined, 1000, "incoming")[0]);

    let saved: CallRecord[] = [];
    const landed = flushPendingCalls(existing, (next) => {
      saved = next;
      return true;
    });

    expect(landed).toBe(1);
    expect(saved.map((r) => r.number)).toEqual(["200", "100"]);
    expect(pendingCallCount()).toBe(0);
  });

  test("a still-failing flush keeps everything queued and claims nothing", () => {
    queuePendingCall(recordCall([], "200", undefined, 1000, "incoming")[0]);

    const landed = flushPendingCalls([], () => false);

    expect(landed).toBe(0);
    expect(pendingCallCount()).toBe(1);
  });

  test("the queue is bounded exactly like the log", () => {
    for (let i = 0; i < CALLLOG_CAP + 5; i++) {
      queuePendingCall({ number: `1380000${String(i).padStart(4, "0")}`, ts: 1000 + i });
    }
    expect(pendingCallCount()).toBe(CALLLOG_CAP);
  });
});

