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
  clockOf,
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

  test("a 「since」 window must key on `seq`, not on a length delta (REQ-A853)", () => {
    // The read side of the ledger has one rule (documented on `recentDiag`): "what arrived
    // since I looked" is a **mark** question. Fill past capacity first — from here on every
    // new entry evicts an old one, so `recentDiag(-1).length` never grows again. This is the
    // state the pure-logic batch reaches (every non-DOM file shares one process) and the
    // state a long session is in all day.
    for (let i = 0; i < RING_CAP + 3; i++) amosWarn("ring", `e${i}`);
    const before = recentDiag(-1).length;
    const mark = recentDiag(1)[0]?.seq ?? 0;
    amosError("api", "配置没落盘，重启后会用回上一次的值");

    // The seq window finds it — and only it (not "everything newest").
    const found = recentDiag(-1).filter((e) => e.seq > mark);
    expect(found.map((e) => e.msg)).toEqual(["配置没落盘，重启后会用回上一次的值"]);
    expect(found.some((e) => e.msg === `e${RING_CAP + 2}`)).toBe(false);

    // The negative witness: the length-delta window is **empty here**, which is exactly why
    // the rule above exists — an assertion built on it reports "never recorded" about an
    // entry sitting in the ring. (Negative control, outside the repo: put the old
    // length-delta window back and run this file after a saturating one —
    // `/tmp/saturate.test.ts` — and the REQ-A806 assertion goes red, `Received: undefined`.)
    expect(diagStats().evicted).toBeGreaterThan(0);
    expect(recentDiag(-1).length).toBe(before); // the buffer is full: length cannot grow
    expect(recentDiag(-1).slice(0, recentDiag(-1).length - before)).toEqual([]);

    // The mark is the ledger's high-water, not a position in the ring: a clear makes the
    // window empty ("nothing since"), never "everything", and — because `clearDiag` empties
    // the ring but does **not** reset `seq` — an entry recorded after a clear is still
    // *after* a mark taken before it. (A counter that restarted would make this red.)
    clearDiag();
    expect(recentDiag(-1).filter((e) => e.seq > mark)).toEqual([]);
    amosWarn("ring", "after clear");
    expect(recentDiag(-1).filter((e) => e.seq > mark).map((e) => e.msg)).toEqual(["after clear"]);
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

/**
 * REQ-A839 — the *reason* survives to the reader.
 *
 * `JSON.stringify(new Error("boom"))` is `"{}"`: `message` and `stack` are non-enumerable,
 * so every ledger entry whose detail was an exception (and every `console.warn` of one on
 * the device) said nothing. These pin the reason, not just the fact of a failure.
 */
describe("a recorded failure carries its reason, not just its name", () => {
  test("an Error detail renders name + message, never `{}`", () => {
    amosWarn("backend", "foo failed", new TypeError("x is not a function"));
    const e = recentDiag(1)[0]!;
    expect(e.detail).not.toBe("{}");
    expect(e.detail).toContain("TypeError: x is not a function");
    // …and the first stack frame, which is the half logcat is not available for.
    expect(e.detail).toContain(" · at ");
  });

  test("an Error nested in a plain object is rendered too (the `BridgeDiag` shape)", () => {
    // This is exactly what `invoke` records: `{ok:false, kind:"command-failed", detail: err}`.
    // `JSON.stringify` renders the nested Error as `{}`, so the ledger used to keep
    // `{"ok":false,…,"detail":{}}` — a failure whose shape is intact and whose cause is gone.
    amosWarn("backend", "bar failed", {
      ok: false,
      kind: "command-failed",
      command: "bar",
      detail: new Error("host refused"),
    });
    const d = recentDiag(1)[0]!.detail;
    expect(d).toContain('"ok":false');
    expect(d).toContain("Error: host refused");
    expect(d).not.toContain('"detail":{}');
  });

  test("an exception from another realm is rendered (instanceof fails, the shape does not)", () => {
    // A rejection that crossed a realm boundary has a foreign prototype; `instanceof Error`
    // is `false` for it, so the shape check is what has to carry this case.
    const foreign = { name: "AmosError", message: "amos.spaces.delete_last", stack: "x\n  at h" };
    expect(foreign instanceof Error).toBe(false);
    amosWarn("spaces", "delete refused", foreign);
    expect(recentDiag(1)[0]!.detail).toContain("AmosError: amos.spaces.delete_last");
  });

  test("a message-less Error still says which kind of failure it was", () => {
    const bare = new Error("");
    bare.stack = "Error\n  at nowhere";
    amosWarn("x", "bare", bare);
    expect(recentDiag(1)[0]!.detail).toBe("Error · at nowhere");
  });

  test("a huge exception message is truncated by the entry cap", () => {
    amosWarn("x", "huge-err", new Error("z".repeat(5000)));
    const d = recentDiag(1)[0]!.detail;
    expect(d.length).toBeLessThan(600);
    expect(d).toContain("+");
  });

  test("a hostile detail is still never fatal (the Error probe can throw too)", () => {
    const hostile = {
      get name(): string {
        throw new Error("hostile name getter");
      },
      message: "m",
      stack: "s",
    };
    expect(() => amosWarn("boom", "hostile-error-shaped", hostile)).not.toThrow();
    expect(recentDiag(1)[0]!.msg).toBe("hostile-error-shaped");
  });

  test("an entry logged without a detail keeps an empty one (the row stays one line)", () => {
    amosWarn("x", "no-detail");
    expect(recentDiag(1)[0]!.detail).toBe("");
  });
});

/** The row's timestamp — half of what a failures panel is asked. */
describe("clockOf: when the entry was recorded", () => {
  test("formats as zero-padded HH:MM:SS on this device's clock", () => {
    const d = new Date(2026, 8, 21, 9, 7, 3);
    expect(clockOf(d.getTime())).toBe("09:07:03");
  });

  test("refuses to invent a time it does not have", () => {
    expect(clockOf(Number.NaN)).toBe("--:--:--");
    expect(clockOf(0)).toBe("--:--:--");
    expect(clockOf(Number.POSITIVE_INFINITY)).toBe("--:--:--");
  });

  test("a recorded entry's own ts is what the row would read", () => {
    const before = Date.now();
    amosWarn("x", "timed");
    const ts = recentDiag(1)[0]!.ts;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(clockOf(ts)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
