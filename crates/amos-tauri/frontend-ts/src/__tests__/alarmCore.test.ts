/**
 * Pure-logic tests for `lib/alarmCore.ts` — the OS-level "due alarm" alert layer
 * (date/array helpers + notification shaping + next-arming). These functions are
 * DOM-free and headless-testable; the side-effecting `syncDueAlarmAlerts` (which
 * reads/writes the shared store + calls the native-alarm bridge) is covered at the
 * store level elsewhere and intentionally not reached here.
 */
import { describe, expect, test } from "bun:test";
import {
  collectDueRings,
  dateKey,
  firedKey,
  markRung,
  nextArmments,
  normalizeFired,
  pruneRung,
  ringsToNotifs,
} from "../lib/alarmCore";
import type { Alarm } from "../lib/time";

function alarm(partial: Partial<Alarm>): Alarm {
  return {
    id: "a1",
    hour: 9,
    min: 5,
    label: "",
    enabled: true,
    ringing: false,
    ...partial,
  };
}

describe("alarmCore date/fired helpers", () => {
  test("dateKey formats a local date as YYYY-MM-DD", () => {
    expect(dateKey(new Date(2026, 8, 8))).toBe("2026-09-08");
    expect(dateKey(new Date(2026, 0, 3))).toBe("2026-01-03");
  });

  test("firedKey is id|HH:MM with zero-padded time", () => {
    expect(firedKey(alarm({ hour: 7, min: 3 }))).toBe("a1|07:03");
  });

  test("normalizeFired keeps only valid date strings, drops garbage", () => {
    expect(normalizeFired(null)).toEqual({});
    expect(normalizeFired([1, 2])).toEqual({}); // array → malformed
    expect(
      normalizeFired({
        "a1|09:05": "2026-09-08",
        "a2|07:00": "not-a-date",
        "": "2026-09-08",
        n: 5,
      }),
    ).toEqual({ "a1|09:05": "2026-09-08" });
  });
});

describe("alarmCore collectDueRings", () => {
  const now = new Date(2026, 8, 8, 9, 5); // 09:05 local
  const today = dateKey(now);

  test("includes an enabled, allowed, not-yet-fired alarm at the current minute", () => {
    const a = alarm({});
    const rings = collectDueRings([a], new Set(), {}, now);
    expect(rings).toEqual([a]);
  });

  test("excludes disabled / already-ringing / fired-today alarms", () => {
    const due = alarm({});
    const off = alarm({ id: "off", enabled: false });
    const ringing = alarm({ id: "ringing" });
    const firedToday = alarm({ id: "fired" });
    const rings = collectDueRings(
      [due, off, ringing, firedToday],
      new Set(["ringing"]),
      { [firedKey(firedToday)]: today },
      now,
    );
    expect(rings).toEqual([due]);
  });

  test("respects a repeat allowlist for today's weekday", () => {
    const on = alarm({ id: "on", repeat: [now.getDay()] });
    const offDay = alarm({ id: "off", repeat: [(now.getDay() + 1) % 7] });
    const rings = collectDueRings([on, offDay], new Set(), {}, now);
    expect(rings).toEqual([on]);
  });

  test("no-repeat alarm is treated as every day", () => {
    const a = alarm({ repeat: [] });
    expect(collectDueRings([a], new Set(), {}, now)).toEqual([a]);
  });
});

describe("alarmCore markRung / pruneRung", () => {
  test("markRung records each ring for the current day", () => {
    const now = new Date(2026, 8, 8, 9, 5);
    const r1 = alarm({ id: "a", hour: 9, min: 5 });
    const r2 = alarm({ id: "b", hour: 8, min: 0 });
    const out = markRung({ "old|01:00": "2026-09-07" }, [r1, r2], now);
    expect(out).toEqual({
      "old|01:00": "2026-09-07",
      "a|09:05": "2026-09-08",
      "b|08:00": "2026-09-08",
    });
  });

  test("pruneRung drops other-day markers and markers for deleted alarms", () => {
    const fired = {
      "a|09:05": "2026-09-08", // live today → keep
      "b|08:00": "2026-09-07", // other day → drop
      "gone|07:00": "2026-09-08", // alarm no longer exists → drop
    };
    const out = pruneRung(fired, [alarm({ id: "a" })], "2026-09-08");
    expect(out).toEqual({ "a|09:05": "2026-09-08" });
  });
});

describe("alarmCore ringsToNotifs", () => {
  test("shapes one notif per ring with the Clock app id", () => {
    const notifs = ringsToNotifs(
      [alarm({ id: "a", hour: 9, min: 5, label: "Stand up", tone: "🎯" })],
      "clock",
      1234,
    );
    expect(notifs).toHaveLength(1);
    const n = notifs[0]!;
    expect(n.id).toBe("alarm:a:09:05");
    expect(n.app).toBe("clock");
    expect(n.icon).toBe("🎯");
    expect(n.title).toBe("Stand up");
    expect(n.body).toBe("09:05"); // a labelled ring shows its time as the body
    expect(n.time).toBe(1234);
  });

  test("falls back to the time as title and defaults the icon for a bare ring", () => {
    const n = ringsToNotifs([alarm({ label: "" })], "clock", 1)[0]!;
    expect(n.title).toBe("09:05");
    expect(n.body).toBeUndefined();
    expect(n.icon).toBe("🔔");
  });

  test("truncates an over-long label to 60 chars", () => {
    const longLabel = "L".repeat(70);
    const n = ringsToNotifs([alarm({ label: longLabel })], "clock", 1)[0]!;
    expect(n.title).toBe(`${"L".repeat(60)}…`);
  });
});

describe("alarmCore nextArmments", () => {
  test("re-arms each enabled alarm for its next occurrence, skips disabled", () => {
    // now 08:00 → an every-day 09:05 alarm next fires today 09:05.
    const nowMs = new Date(2026, 8, 8, 8, 0, 0, 0).getTime();
    const expectedToday = new Date(2026, 8, 8, 9, 5, 0, 0).getTime();
    const enabled = alarm({ id: "a" });
    const disabled = alarm({ id: "off", enabled: false });
    const out = nextArmments([enabled, disabled], nowMs);
    expect(out).toEqual([{ id: "alarm:a", atMs: expectedToday }]);
  });
});
