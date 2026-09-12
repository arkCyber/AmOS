import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { zh } from "../i18n/locales/zh";
import {
  ALARM_FIRED_KEY,
  ALARM_KEY,
  collectDueRings,
  dateKey,
  firedKey,
  markRung,
  normalizeFired,
  nextArmments,
  pruneRung,
  ringsToNotifs,
  syncDueAlarmAlerts,
} from "../lib/alarmCore";
import { NOTIF_KEY } from "../lib/settings";
import type { Alarm } from "../lib/time";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

const NOW = new Date(2026, 8, 7, 8, 0, 30); // 2026-09-07 (Monday) 08:00:30
const al = (over: Partial<Alarm> & { id: string; hour: number; min: number }): Alarm => ({
  label: "",
  enabled: true,
  ringing: false,
  tone: "🔔",
  ...over,
});

afterEach(() => {
  window.localStorage.removeItem(ALARM_KEY);
  window.localStorage.removeItem(ALARM_FIRED_KEY);
  window.localStorage.removeItem(NOTIF_KEY);
});

describe("alarmCore — OS-level due alarms", () => {
  test("collectDueRings returns exactly the enabled alarms whose HH:MM just arrived", () => {
    const alarms = [
      al({ id: "due", hour: 8, min: 0, label: "起床" }), // 08:00 now → rings
      al({ id: "disabled", hour: 8, min: 0, enabled: false }),
      al({ id: "later", hour: 9, min: 0 }), // not due yet
      al({ id: "ringing", hour: 8, min: 0 }), // already ringing → skip
      al({ id: "alreadyFired", hour: 8, min: 0 }), // alerted today → skip
      al({ id: "weekend", hour: 8, min: 0, repeat: [0, 6] }), // Monday → skip
      al({ id: "weekday", hour: 8, min: 0, repeat: [1, 2, 3, 4, 5] }), // Monday → rings
    ];
    const fired = { [firedKey(al({ id: "alreadyFired", hour: 8, min: 0 }))]: dateKey(NOW) };
    const got = collectDueRings(alarms, new Set(["ringing"]), fired, NOW).map((a) => a.id);
    expect(got).toEqual(["due", "weekday"]);
  });

  test("markRung + pruneRung bound markers to today's still-live alarms", () => {
    const one = al({ id: "w1", hour: 8, min: 0 });
    const two = al({ id: "w2", hour: 9, min: 0 });
    const fired = markRung({}, [one, two], NOW);
    expect(fired[firedKey(one)]).toBe("2026-09-07");
    expect(fired[firedKey(two)]).toBe("2026-09-07");
    // Same alarm ringing again next day is allowed (different date marker).
    expect(collectDueRings([one], new Set(), fired, new Date(2026, 8, 8, 8, 0))).toHaveLength(1);
    // prune: drop markers for removed alarms / a different day.
    expect(pruneRung(fired, [one], "2026-09-07")).toEqual({ [firedKey(one)]: "2026-09-07" });
    expect(pruneRung(fired, [one], "2026-09-08")).toEqual({});
    expect(normalizeFired(null)).toEqual({});
    expect(normalizeFired({ a: 5, b: "2026-09-07", c: "junk" })).toEqual({
      b: "2026-09-07",
    });
  });

  test("ringsToNotifs shapes stable ids + localized Clock app name", () => {
    const n = ringsToNotifs(
      [al({ id: "a", hour: 8, min: 0, label: "很长的".repeat(40) })],
      zh["app.clock"],
      NOW.getTime(),
    );
    expect(n[0]!.id).toBe("alarm:a:08:00");
    expect(n[0]!.app).toBe(zh["app.clock"]);
    expect(n[0]!.icon).toBe("🔔");
    expect(n[0]!.title!.length).toBeLessThanOrEqual(61);
    expect(n[0]!.body).toBe("08:00"); // labelled alarm keeps the time in the body
    // Unlabelled alarm uses the time as the title and omits the body.
    const n2 = ringsToNotifs([al({ id: "b", hour: 7, min: 5 })], zh["app.clock"], NOW.getTime());
    expect(n2[0]!.title).toBe("07:05");
    expect(n2[0]!.body).toBeUndefined();
  });

  test("syncDueAlarmAlerts fires once, marks ringing, and refires the next day after dismiss", () => {
    const seed = [
      al({ id: "w1", hour: 8, min: 0, label: "起床" }),
      al({ id: "off", hour: 8, min: 0, enabled: false }),
      al({ id: "later", hour: 9, min: 0 }),
    ];
    window.localStorage.setItem(ALARM_KEY, JSON.stringify(seed));

    syncDueAlarmAlerts(NOW.getTime());
    let notifs = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]") as { id: string }[];
    expect(notifs.filter((x) => x.id === "alarm:w1:08:00")).toHaveLength(1);
    expect(notifs.filter((x) => x.id.startsWith("alarm:off"))).toHaveLength(0);
    expect(notifs.filter((x) => x.id.startsWith("alarm:later"))).toHaveLength(0);
    // The ringing flag is persisted so a later-open Clock screen shows a live ring.
    const stored = JSON.parse(window.localStorage.getItem(ALARM_KEY) ?? "[]") as Alarm[];
    expect(stored.find((a) => a.id === "w1")!.ringing).toBe(true);
    const fired = JSON.parse(window.localStorage.getItem(ALARM_FIRED_KEY) ?? "{}") as Record<
      string,
      string
    >;
    expect(fired[firedKey(al({ id: "w1", hour: 8, min: 0 }))]).toBe("2026-09-07");

    // Same instant again → no duplicate arrival (already ringing / marker set).
    syncDueAlarmAlerts(NOW.getTime());
    notifs = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]");
    expect(notifs.filter((x) => x.id === "alarm:w1:08:00")).toHaveLength(1);

    // User acknowledges (dismisses → ringing false). Next day the daily alarm
    // fires again (its date marker no longer matches).
    const acknowledged = JSON.parse(window.localStorage.getItem(ALARM_KEY) ?? "[]") as Alarm[];
    acknowledged.find((a) => a.id === "w1")!.ringing = false;
    window.localStorage.setItem(ALARM_KEY, JSON.stringify(acknowledged));
    const nextDay = new Date(2026, 8, 8, 8, 0, 30); // 2026-09-08 (Tuesday)
    syncDueAlarmAlerts(nextDay.getTime());
    notifs = JSON.parse(window.localStorage.getItem(NOTIF_KEY) ?? "[]");
    expect(notifs.filter((x) => x.id === "alarm:w1:08:00")).toHaveLength(2);
  });

  test("nextArmments plans only enabled alarms' next native occurrence", () => {
    // 2026-09-07 Monday 08:00 local.
    const now = new Date(2026, 8, 7, 8, 0).getTime();
    const mk = (id: string, hour: number, min: number, enabled: boolean): Alarm => ({
      id, hour, min, label: "", enabled, ringing: false, tone: "🔔",
    });
    const enabled = mk("a", 7, 30, true);
    const disabled = mk("off", 9, 0, false);
    const armed = nextArmments([enabled, disabled], now);
    expect(armed).toHaveLength(1);
    expect(armed[0]!.id).toBe("alarm:a");
    // 07:30 today already passed at 08:00 → next is tomorrow 07:30.
    expect(armed[0]!.atMs).toBe(new Date(2026, 8, 8, 7, 30).getTime());
  });
});
