import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ALARM_KEY, ALARM_FIRED_KEY } from "../lib/alarmCore";
import { NOTIF_KEY } from "../lib/settings";
import { writeStoreValue } from "../lib/amosStore";
import { alarmWatcherTick, startAlarmWatcher } from "../svelte/osAlarmWatcher";
import { resetArmedNativeAlarmsForTest } from "../svelte/osAlarmArm";

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

  function bridge(calls: string[]): void {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        return cmd === "scheduler_alarm_cancel" ? true : null;
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
});
