import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ALARM_KEY } from "../lib/alarmCore";
import {
  armedNativeAlarmIds,
  nativeAlarmDeviceState,
  nativeWakeArmed,
  reconcileNativeAlarms,
  resetArmedNativeAlarmsForTest,
  unconfirmedNativeCancelIds,
} from "../svelte/osAlarmArm";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

let calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

/**
 * The cancel reply **in the shape the producer sends** (`AlarmCanceled`:
 * `{ id, wasRegistered, device }`, `crates/amos-tauri/src/alarm_sched.rs`).
 *
 * It used to be `true`. That is not a value the command can return, so
 * `lastCancel` was assigned `undefined` and every assertion about the cancel half was
 * reading a field nothing had written — the fixture was the reason the defect below was
 * invisible, not the code (REQ-A875).
 */
function cancelReply(args: Record<string, unknown>, state: string): unknown {
  return { id: args.id, wasRegistered: true, device: { state } };
}

function installBridge(deviceState = "cancelled"): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      return cmd === "scheduler_alarm_cancel" ? cancelReply(args, deviceState) : null;
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
    // The host's answer is what makes the id forgettable, so it is read rather than assumed.
    expect(nativeAlarmDeviceState().cancel).toEqual({ state: "cancelled" });
    expect(unconfirmedNativeCancelIds()).toEqual([]);
  });

  // REQ-A875 / F-ALM-004. The cancel half used to drop the id from `armed` *before* asking
  // the host, so a cancellation the device did not carry out was forgotten permanently: the
  // OS kept the registration, `armed` no longer knew about it, and no later reconcile could
  // ask again. The alarm then rings from the native scheduler for a phone whose user turned
  // it off — the second case this module's own doc says it exists to prevent.
  test("a cancel the device did not carry out is remembered, and asked again", async () => {
    installBridge("unavailable");
    window.localStorage.setItem(ALARM_KEY, JSON.stringify([alarm("a1", 7, 30)]));
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 0).getTime());
    calls = [];

    window.localStorage.setItem(ALARM_KEY, JSON.stringify([alarm("a1", 7, 30, false)]));
    const armed = await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 5).getTime());

    // Not forgotten: the OS may still hold it, so the id stays armed and stays queued.
    expect(armed).toEqual(["alarm:a1"]);
    expect(armedNativeAlarmIds()).toEqual(["alarm:a1"]);
    expect(unconfirmedNativeCancelIds()).toEqual(["alarm:a1"]);
    expect(nativeAlarmDeviceState().cancel).toEqual({ state: "unavailable" });

    // …and the next reconcile asks again instead of having given up silently.
    calls = [];
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 10).getTime());
    expect(calls).toEqual([{ cmd: "scheduler_alarm_cancel", args: { id: "alarm:a1" } }]);
  });

  test("a host that never answers leaves the registration queued too", async () => {
    window.localStorage.setItem(ALARM_KEY, JSON.stringify([alarm("a1", 7, 30)]));
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 0).getTime());

    // No bridge at all: `invoke` answers `null` (REQ-A296), which is "we do not know",
    // not "the device let go". Nothing recorded it before, so nothing retried it.
    goOffline();
    window.localStorage.setItem(ALARM_KEY, JSON.stringify([alarm("a1", 7, 30, false)]));
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 5).getTime());

    expect(unconfirmedNativeCancelIds()).toEqual(["alarm:a1"]);
  });

  test("a re-enabled alarm stops being an unconfirmed cancellation", async () => {
    installBridge("unavailable");
    window.localStorage.setItem(ALARM_KEY, JSON.stringify([alarm("a1", 7, 30)]));
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 0).getTime());
    window.localStorage.setItem(ALARM_KEY, JSON.stringify([alarm("a1", 7, 30, false)]));
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 5).getTime());
    expect(unconfirmedNativeCancelIds()).toEqual(["alarm:a1"]);

    // The user turns it back on: the alarm is wanted again, so the stale cancellation is
    // not a fact about anything any more.
    window.localStorage.setItem(ALARM_KEY, JSON.stringify([alarm("a1", 7, 30)]));
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 6).getTime());

    expect(unconfirmedNativeCancelIds()).toEqual([]);
    expect(armedNativeAlarmIds()).toEqual(["alarm:a1"]);
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

  // REQ-A369: the host's answer now says what the **phone** will do. Before this, a
  // `scheduler_alarm_register` that only reached the in-memory ledger looked identical to one
  // that armed `AlarmManager` — a sleeping phone was never woken (F-TAU-007, device-measured).
  test("a device refusal is visible: the phone will not be woken", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        calls.push({ cmd, args });
        if (cmd === "scheduler_alarm_register") {
          return { id: args.id, atMs: args.atMs, device: { state: "disallowed" } };
        }
        return null;
      },
      listen: async () => async () => {},
    };
    window.localStorage.setItem(ALARM_KEY, JSON.stringify([alarm("a1", 7, 30)]));
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 0).getTime());

    // The registration *did* reach the host (the id is armed there)…
    expect(armedNativeAlarmIds()).toEqual(["alarm:a1"]);
    // …but the OS half did not happen, and the module says so instead of implying it did.
    expect(nativeAlarmDeviceState().arm).toEqual({ state: "disallowed" });
    expect(nativeWakeArmed()).toBe(false);
  });

  test("an OS-armed alarm reports that the phone can be woken", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        calls.push({ cmd, args });
        if (cmd === "scheduler_alarm_register") {
          return { id: args.id, atMs: args.atMs, device: { state: "scheduled" } };
        }
        return null;
      },
      listen: async () => async () => {},
    };
    window.localStorage.setItem(ALARM_KEY, JSON.stringify([alarm("a1", 7, 30)]));
    await reconcileNativeAlarms(new Date(2024, 0, 1, 6, 0).getTime());

    expect(nativeWakeArmed()).toBe(true);
    // Desktop/CI honesty in the same shape: `host_only` is a *state*, not a success.
    expect(nativeAlarmDeviceState().arm?.state).toBe("scheduled");
  });
});
