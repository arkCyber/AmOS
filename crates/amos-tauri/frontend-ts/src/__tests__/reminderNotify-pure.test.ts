import { describe, expect, test } from "bun:test";
// NOTE: this file intentionally does NOT register happy-dom, so it is classed as a
// pure (non-DOM) test and its coverage of reminderNotify's window-free cores counts
// toward the src/lib pure coverage gate (reminderNotify.test.ts covers the same
// functions but registers happy-dom, which the P2-1 pure-batch gate excludes).
import {
  alertsToNotifs,
  collectDueAlerts,
  markFired,
  normalizeFired,
  pruneFired,
} from "../lib/reminderNotify";
import { zh } from "../i18n/locales/zh";
import type { Reminder } from "../lib/reminders";

const NOW = new Date(2026, 8, 4, 14, 0, 0, 0).getTime();
const r = (id: string, dueAt?: number, over: Partial<Reminder> = {}): Reminder => ({
  id,
  title: `item-${id}`,
  listId: "inbox",
  priority: 0,
  flagged: false,
  createdAt: NOW,
  ...(dueAt === undefined ? {} : { dueAt }),
  ...over,
});

describe("reminderNotify pure cores (window-free, counted by pure coverage gate)", () => {
  test("normalizeFired tolerates garbage and keeps only finite timestamps", () => {
    expect(normalizeFired(null)).toEqual({});
    expect(normalizeFired(undefined)).toEqual({});
    expect(normalizeFired([])).toEqual({});
    expect(normalizeFired("nope")).toEqual({});
    expect(normalizeFired(42)).toEqual({});
    expect(normalizeFired({ a: "x", b: 5, c: Number.NaN, d: 7.5, "": 9 })).toEqual({ b: 5, d: 7.5 });
  });

  test("collectDueAlerts returns only due, pending, not-yet-fired reminders sorted ascending", () => {
    const reminders = [
      r("future", NOW + 3_600_000), // not due yet
      r("noDue"), // no dueAt
      r("overdue2", NOW - 3_600_000), // due, not fired
      r("overdue1", NOW - 2 * 3_600_000), // due earlier
      r("done", NOW - 3_600_000, { completed: true, completedAt: NOW }), // completed
      r("fired", NOW - 60_000), // already fired
    ];
    const fired = { fired: NOW - 60_000 };
    expect(collectDueAlerts(reminders, fired, NOW).map((x) => x.id)).toEqual([
      "overdue1",
      "overdue2",
    ]);
  });

  test("collectDueAlerts applies the cap and a non-numeric cap is tolerated", () => {
    const many = [0, 1, 2, 3, 4, 5].map((n) => r(`m${n}`, NOW - n * 1000));
    expect(collectDueAlerts(many, {}, NOW, 3).map((x) => x.id)).toEqual(["m5", "m4", "m3"]);
    // No cap given → default 40; a large set is sliced.
    const huge = Array.from({ length: 50 }, (_, i) => r(`h${i}`, NOW - i));
    expect(collectDueAlerts(huge, {}, NOW).length).toBe(40);
  });

  test("markFired records the dueAt for each alerting reminder (immutable)", () => {
    const base = { other: 1 };
    const out = markFired(base, [r("a", 111), r("b", 222), r("noDue")]);
    expect(out).toEqual({ other: 1, a: 111, b: 222 });
    expect(base).toEqual({ other: 1 }); // unchanged input
  });

  test("pruneFired drops markers whose reminder is gone or no longer has a due date", () => {
    const fired = { a: 111, b: 222, c: 333 };
    const reminders = [r("a", 111), r("b"), r("c", 333)];
    expect(pruneFired(fired, reminders)).toEqual({ a: 111, c: 333 });
    expect(pruneFired(fired, [])).toEqual({});
  });

  test("alertsToNotifs builds stable ids, localized app, truncated titles", () => {
    const short = alertsToNotifs([r("s", 100)], zh["app.reminders"], NOW);
    expect(short[0]).toMatchObject({ id: "rem:s", app: zh["app.reminders"], icon: "✅", time: 100 });
    const long = r("l", 200, { title: "很长的".repeat(30) });
    const n = alertsToNotifs([long], "app", NOW)[0]!;
    expect(n.title!.length).toBeLessThanOrEqual(61);
    expect(n.title!.endsWith("…")).toBe(true);
    // Missing dueAt → falls back to `now`.
    const noDue = alertsToNotifs([r("nd")], "app", NOW)[0]!;
    expect(noDue.time).toBe(NOW);
  });
});
