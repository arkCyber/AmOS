import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { zh } from "../i18n/locales/zh";
import {
  FIRED_KEY,
  alertsToNotifs,
  collectDueAlerts,
  markFired,
  normalizeFired,
  pruneFired,
  syncDueReminderAlerts,
} from "../lib/reminderNotify";
import { REMINDERS_KEY, type Reminder } from "../lib/reminders";
import { NOTIF_KEY } from "../lib/settings";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

const NOW = new Date(2026, 8, 4, 14, 0, 0, 0).getTime();
const r = (id: string, dueAt?: number, over: Partial<Reminder> = {}): Reminder => ({
  id,
  title: `事项-${id}`,
  listId: "inbox",
  priority: 0,
  flagged: false,
  createdAt: NOW,
  ...(dueAt === undefined ? {} : { dueAt }),
  ...over,
});

afterEach(() => {
  window.localStorage.removeItem(REMINDERS_KEY);
  window.localStorage.removeItem(FIRED_KEY);
  window.localStorage.removeItem(NOTIF_KEY);
});

describe("reminderNotify — OS-level due alerts", () => {
  test("collectDueAlerts only returns new, reached, pending reminders (earliest first)", () => {
    const reminders = [
      r("future", NOW + 3_600_000), // not due yet
      r("overdue2", NOW - 3_600_000), // due, not fired
      r("overdue1", NOW - 2 * 3_600_000), // due earlier, not fired
      r("done", NOW - 3_600_000, { completed: true, completedAt: NOW }), // completed → skip
      r("fired", NOW - 60_000), // due but already fired
    ];
    const fired = { fired: NOW - 60_000 };
    const got = collectDueAlerts(reminders, fired, NOW);
    expect(got.map((x) => x.id)).toEqual(["overdue1", "overdue2"]); // sorted ascending
  });

  test("collectDueAlerts honours the cap", () => {
    const reminders = [1, 2, 3, 4, 5].map((n) => r(`m${n}`, NOW - n * 1000));
    expect(collectDueAlerts(reminders, {}, NOW, 2).map((x) => x.id)).toEqual(["m5", "m4"]);
  });

  test("markFired + pruneFired update and bound the markers", () => {
    const fired = markFired({}, [r("a", 111), r("b", 222)]);
    expect(fired).toEqual({ a: 111, b: 222 });
    // prune drops markers whose reminder no longer carries a due date / is gone.
    const pruned = pruneFired(fired, [r("a", 111), r("b")]); // b now has no dueAt
    expect(pruned).toEqual({ a: 111 });
    // tolerate malformed fired store
    expect(normalizeFired(null)).toEqual({});
    expect(normalizeFired({ a: "x", b: 5 })).toEqual({ b: 5 });
  });

  test("alertsToNotifs shapes stable id + localized app name", () => {
    const n = alertsToNotifs([r("a", 123, { title: "很长的".repeat(40) })], zh["app.reminders"], NOW);
    expect(n[0]!.id).toBe("rem:a");
    expect(n[0]!.app).toBe(zh["app.reminders"]);
    expect(n[0]!.time).toBe(123);
    expect(n[0]!.title!.length).toBeLessThanOrEqual(61); // truncated
  });

  test("syncDueReminderAlerts fires once per reminder and is idempotent", () => {
    const reminders = [
      r("dueNow", NOW - 5_000),
      r("later", NOW + 3_600_000),
      r("completedOverdue", NOW - 9_000, { completed: true, completedAt: NOW - 1_000 }),
    ];
    window.localStorage.setItem(REMINDERS_KEY, JSON.stringify(reminders));

    syncDueReminderAlerts(NOW);
    let notifs = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as { id: string }[];
    expect(notifs.filter((x) => x.id === "rem:dueNow")).toHaveLength(1);
    expect(notifs.filter((x) => x.id === "rem:later")).toHaveLength(0); // not due
    expect(notifs.filter((x) => x.id === "rem:completedOverdue")).toHaveLength(0); // done
    const fired = JSON.parse(window.localStorage.getItem(FIRED_KEY) ?? "{}") as Record<string, number>;
    expect(fired["dueNow"]).toBe(NOW - 5_000);

    // Same instant again → no duplicate arrivals, markers unchanged.
    syncDueReminderAlerts(NOW);
    notifs = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]");
    expect(notifs.filter((x) => x.id === "rem:dueNow")).toHaveLength(1);

    // A second reminder reaching its due time later appends exactly one more.
    syncDueReminderAlerts(NOW + 3_600_000);
    notifs = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]");
    expect(notifs.filter((x) => x.id === "rem:later")).toHaveLength(1);
  });
});
