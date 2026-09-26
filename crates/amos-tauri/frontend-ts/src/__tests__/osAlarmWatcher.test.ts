import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ALARM_KEY, ALARM_FIRED_KEY } from "../lib/alarmCore";
import { NOTIF_KEY } from "../lib/settings";
import { writeStoreValue } from "../lib/amosStore";
import { alarmWatcherTick, startAlarmWatcher } from "../svelte/osAlarmWatcher";
import { armedNativeAlarmIds, resetArmedNativeAlarmsForTest } from "../svelte/osAlarmArm";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

afterEach(() => {
  window.localStorage.removeItem(ALARM_KEY);
  window.localStorage.removeItem(ALARM_FIRED_KEY);
  window.localStorage.removeItem(NOTIF_KEY);
});

describe("osAlarmWatcher — pure-Svelte host alarm reconcile", () => {
  test("runs the alarm sync when the Clock app is not focused", () => {
    // Empty alarm store is a valid reconcile (no throw, no false fires).
    expect(alarmWatcherTick(null)).toBe(true);
    expect(alarmWatcherTick("settings")).toBe(true);
  });

  test("suppressed while the Clock app is the focused surface", () => {
    expect(alarmWatcherTick("clock")).toBe(false);
  });

  test("tolerates a corrupt store without throwing", () => {
    window.localStorage.setItem(ALARM_KEY, JSON.stringify({ not: "an array" }));
    expect(alarmWatcherTick(null)).toBe(true);
  });
});

describe("osAlarmWatcher — native exact-alarm arming (wiring)", () => {
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  const alarm = (id: string, hour: number, min: number, enabled = true) => ({
    id,
    hour,
    min,
    label: "",
    enabled,
    ringing: false,
    tone: "🔔",
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    resetArmedNativeAlarmsForTest();
  });

  function bridge(calls: string[], args: Record<string, unknown>[] = []): void {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, a: Record<string, unknown> = {}) => {
        calls.push(cmd);
        args.push(a);
        // The cancel reply **in the producer's shape** (`AlarmCanceled`), not `true`:
        // a bare boolean is not a value `scheduler_alarm_cancel` can return, so the
        // module's `lastCancel` stayed `undefined` and nothing could read the verdict
        // (REQ-A875 — see `osAlarmArm.test.ts` for the same fixture fix).
        if (cmd === "scheduler_alarm_cancel") {
          return { id: a.id, wasRegistered: true, device: { state: "cancelled" } };
        }
        if (cmd === "scheduler_alarm_register") {
          return { id: a.id, atMs: a.atMs, device: { state: "scheduled" } };
        }
        return null;
      },
      listen: async () => async () => {},
    };
  }

  test("starting the watcher arms persisted alarms; turning one off cancels it", async () => {
    const calls: string[] = [];
    bridge(calls);
    writeStoreValue(ALARM_KEY, [alarm("a1", 7, 30)]);

    const stop = startAlarmWatcher(() => null);
    await settle();
    // A boot may never open the Clock screen, so the watcher must arm what's
    // already persisted (previously only *fired* alarms were ever re-armed).
    expect(calls).toContain("scheduler_alarm_register");

    calls.length = 0;
    writeStoreValue(ALARM_KEY, [alarm("a1", 7, 30, false)]);
    await settle();
    stop();
    // "off" must reach the host scheduler, or the alarm still rings from it.
    expect(calls).toContain("scheduler_alarm_cancel");
  });

  // REQ-A875 / F-ALM-004. `alarmCore.syncDueAlarmAlerts` used to re-arm the alarm it had
  // just fired itself, inside a `try`/`catch` around a bridge call that cannot throw — so
  // the host's answer was dropped, and a daily alarm whose next arm was refused was never
  // asked again. Registration now has one owner (`osAlarmArm`) and this is the seam that
  // feeds it: a tick that rang must re-arm through the module that reads the verdict.
  test("a ring re-arms the fired alarm for its next occurrence", async () => {
    const calls: string[] = [];
    const args: Record<string, unknown>[] = [];
    bridge(calls, args);
    const ring = new Date(2026, 8, 7, 8, 0, 0, 0); // 2026-09-07 Monday 08:00 sharp
    writeStoreValue(ALARM_KEY, [alarm("w1", 8, 0)]);

    expect(alarmWatcherTick(null, ring.getTime())).toBe(true);
    await settle();

    const reg = args.filter((_, i) => calls[i] === "scheduler_alarm_register");
    expect(reg).toHaveLength(1);
    expect(reg[0]!.id).toBe("alarm:w1");
    // The fired occurrence is behind us — the arm must be strictly in the future, or the
    // phone would be woken for an alarm that already rang.
    expect(reg[0]!.atMs).toBe(new Date(2026, 8, 8, 8, 0, 0, 0).getTime());
    expect(armedNativeAlarmIds()).toEqual(["alarm:w1"]);
  });

  test("a tick that rang nothing re-arms nothing", async () => {
    // The control for the test above: without it, a watcher that re-armed on *every* tick
    // would pass — and it would register a future occurrence on every interval forever.
    const calls: string[] = [];
    bridge(calls);
    writeStoreValue(ALARM_KEY, [alarm("w1", 8, 0)]);

    alarmWatcherTick(null, new Date(2026, 8, 7, 6, 0).getTime());
    await settle();

    // `writeStoreValue` mirrors to the host (`system_store_set`), so the claim is about
    // the scheduler commands specifically, not about "the bridge saw nothing".
    expect(calls.filter((c) => c.startsWith("scheduler_alarm_"))).toEqual([]);
  });

  // The focused-Clock case, and why the ring-driven re-arm above is not the only path:
  // `alarmWatcherTick` deliberately does nothing there (the Clock screen has its own
  // in-app ring), but ClockApp latches the ring *into the store*, and this listener
  // reconciles on that write regardless of focus. Without this test, deleting the
  // store-driven reconcile would leave the Clock case silently un-armed — the exact
  // regression that removing `alarmCore`'s second copy of the loop could have caused.
  test("a store write still arms while the Clock app is focused", async () => {
    const calls: string[] = [];
    bridge(calls);

    const stop = startAlarmWatcher(() => "clock");
    await settle();
    expect(alarmWatcherTick("clock")).toBe(false); // no duplicate in-app alert
    calls.length = 0;

    writeStoreValue(ALARM_KEY, [alarm("w1", 8, 0)]);
    await settle();
    stop();
    expect(calls).toContain("scheduler_alarm_register");
  });
});
