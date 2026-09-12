/**
 * debugLog.test.ts — the shell's diagnostic ledger (audit P1-3, TS half).
 *
 * Pins the properties that make it usable as evidence: a **bounded** ring, an
 * honest **drop** accounting (capacity + level filtering), never throwing on hostile
 * values, subscription/unsubscription, and a clear that does not erase the fact that
 * entries were dropped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

import {
  RING_CAP,
  amosError,
  amosLog,
  amosWarn,
  clearDiag,
  diag,
  diagStats,
  recentDiag,
  setDiagMinLevel,
  subscribeDiag,
} from "../lib/debugLog";

afterEach(() => {
  clearDiag();
  setDiagMinLevel("info");
});

describe("diagnostic ledger (bounded, honest about what it dropped)", () => {
  test("records entries newest-first with level/area/message", () => {
    amosWarn("backend", "first");
    amosError("store", "second", { key: "amos.x" });
    const got = recentDiag(2);
    const newest = got[0]!;
    const older = got[1]!;
    expect(newest.level).toBe("error");
    expect(newest.area).toBe("store");
    expect(newest.detail).toContain("amos.x");
    expect(older.level).toBe("warn");
    expect(older.msg).toBe("first");
  });

  test("the ring is bounded and counts evictions (never unbounded growth)", () => {
    for (let i = 0; i < RING_CAP + 7; i++) amosWarn("ring", `e${i}`);
    const s = diagStats();
    expect(s.recorded).toBe(RING_CAP);
    expect(s.evicted).toBe(7);
    // The newest survives; the oldest was dropped.
    expect(recentDiag(1)[0]?.msg).toBe(`e${RING_CAP + 6}`);
    expect(recentDiag(RING_CAP).some((e) => e.msg === "e0")).toBe(false);
  });

  test("a level below the threshold is filtered AND counted as suppressed", () => {
    setDiagMinLevel("warn");
    diag("debug", "x", "dbg");
    amosLog("x", "info");
    expect(diagStats().recorded).toBe(0);
    expect(diagStats().suppressed).toBe(2);
    amosWarn("x", "warn");
    expect(diagStats().recorded).toBe(1);
    // Lowering the threshold lets debug through from then on.
    setDiagMinLevel("debug");
    diag("debug", "x", "dbg2");
    expect(recentDiag(1)[0]?.msg).toBe("dbg2");
  });

  test("clearing the list keeps the drop counters (a clear is not a cover-up)", () => {
    setDiagMinLevel("warn");
    amosLog("x", "filtered"); // suppressed
    for (let i = 0; i < RING_CAP + 1; i++) amosWarn("x", `w${i}`); // one eviction
    const before = diagStats();
    clearDiag();
    const after = diagStats();
    expect(after.recorded).toBe(0);
    expect(after.evicted).toBe(before.evicted);
    expect(after.suppressed).toBe(before.suppressed);
  });

  test("a hostile detail never throws and is truncated", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => amosWarn("boom", "circular", circular)).not.toThrow();
    expect(() => amosWarn("boom", "bigint", 10n)).not.toThrow();
    const throwing = {
      get x(): string {
        throw new Error("nope");
      },
    };
    expect(() => amosWarn("boom", "getter", throwing)).not.toThrow();
    amosWarn("boom", "huge", "z".repeat(5000));
    const huge = recentDiag(1)[0]!;
    expect(huge.detail.length).toBeLessThan(600);
    expect(huge.detail).toContain("+");
  });

  test("subscribers see new entries and stop after unsubscribing", () => {
    const seen: string[] = [];
    const off = subscribeDiag((e) => seen.push(e.msg));
    amosWarn("sub", "one");
    off();
    amosWarn("sub", "two");
    expect(seen).toEqual(["one"]);
  });

  test("a throwing subscriber cannot break logging", () => {
    const off = subscribeDiag(() => {
      throw new Error("subscriber blew up");
    });
    expect(() => amosWarn("sub", "still recorded")).not.toThrow();
    off();
    expect(recentDiag(1)[0]?.msg).toBe("still recorded");
  });
});
