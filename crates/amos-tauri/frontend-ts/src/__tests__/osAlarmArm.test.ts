import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ALARM_KEY } from "../lib/alarmCore";
import {
  armedNativeAlarmIds,
  reconcileNativeAlarms,
  resetArmedNativeAlarmsForTest,
} from "../svelte/osAlarmArm";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

let calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

function installBridge(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      return cmd === "scheduler_alarm_cancel" ? true : null;
    },
    listen: async () => async () => {},
  };
}
function goOffline(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
}

const alarm = (id: string, hour: number, min: number, enabled = true) => ({
  id,
  hour,
  min,
  label: "",
  enabled,
  ringing: false,
  tone: "🔔",
});

beforeEach(() => {
  calls = [];
  resetArmedNativeAlarmsForTest();
  window.localStorage.clear();
  installBridge();
});
afterEach(() => {
  goOffline();
  window.localStorage.clear();
  resetArmedNativeAlarmsForTest();
});

describe("osAlarmArm — native exact-alarm reconciliation", () => {
  test("registers the next occurrence of a freshly created alarm", async () => {
    // Before this module existed nothing ever armed a *new* alarm: only alarms
    // that had already fired were re-armed by syncDueAlarmAlerts.
    window.localStorage.setItem(ALARM_KEY, JSON.stringify([alarm("a1", 7, 30)]));
    const now = new Date(2024, 0, 1, 6, 0).getTime();
    const armed = await reconcileNativeAlarms(now);

    expect(armed).toEqual(["alarm:a1"]);
    expect(armedNativeAlarmIds()).toEqual(["alarm:a1"]);
    const reg = calls.filter((c) => c.cmd === "scheduler_alarm_register");
    expect(reg).toHaveLength(1);
    expect(reg[0]!.args.id).toBe("alarm:a1");
    expect(reg[0]!.args.atMs).toBe(new Date(2024, 0, 1, 7, 30).getTime());
  });

  test("cancels a registration once the alarm is disabled or deleted", async () => {
    window.localStorage.setItem(ALARM_KEY, JSON.stringify([alarm("a1", 7, 30)]));
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 0).getTime());
    calls = [];

    // The user turns it off → the native registration must go away, otherwise the
    // alarm still rings from the host scheduler.
    window.localStorage.setItem(ALARM_KEY, JSON.stringify([alarm("a1", 7, 30, false)]));
    const armed = await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 5).getTime());

    expect(armed).toEqual([]);
    expect(armedNativeAlarmIds()).toEqual([]);
    expect(calls).toEqual([{ cmd: "scheduler_alarm_cancel", args: { id: "alarm:a1" } }]);
  });

  test("re-registers (idempotently) without cancelling still-enabled alarms", async () => {
    window.localStorage.setItem(ALARM_KEY, JSON.stringify([alarm("a1", 7, 30)]));
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 0).getTime());
    calls = [];

    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 10).getTime());
    expect(calls.map((c) => c.cmd)).toEqual(["scheduler_alarm_register"]);
    expect(armedNativeAlarmIds()).toEqual(["alarm:a1"]);
  });

  test("offline: never throws, and a corrupt store is tolerated", async () => {
    goOffline();
    await reconcileNativeAlarms();
    expect(calls).toEqual([]); // no bridge → no commands

    window.localStorage.setItem(ALARM_KEY, JSON.stringify({ not: "an array" }));
    await expect(reconcileNativeAlarms()).resolves.toEqual([]);
  });
});
