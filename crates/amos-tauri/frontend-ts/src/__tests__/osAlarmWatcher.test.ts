import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ALARM_KEY, ALARM_FIRED_KEY } from "../lib/alarmCore";
import { NOTIF_KEY } from "../lib/settings";
import { alarmWatcherTick } from "../svelte/osAlarmWatcher";

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
