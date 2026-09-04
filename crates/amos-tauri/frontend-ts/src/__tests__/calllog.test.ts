import { describe, expect, test } from "bun:test";
import {
  CALLLOG_CAP,
  CALLLOG_KEY,
  callDigits,
  frequentNumbers,
  logNameFor,
  normalizeCallLog,
  recentNumbers,
  recordCall,
  sameCallNumber,
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
