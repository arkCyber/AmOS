/**
 * OS-level **native exact-alarm reconciliation** for the pure-Svelte shell.
 *
 * `lib/alarmCore.syncDueAlarmAlerts` re-arms only the alarms that *just fired*: it
 * hands the host its next occurrence so a daily alarm keeps waking the device. Two
 * cases were therefore never covered:
 *
 *  * a freshly created (or re-enabled) alarm was **never registered** with the Rust
 *    exact-alarm scheduler — it only ever rang through the in-app watcher;
 *  * a disabled or deleted alarm's registration was **never cancelled**, so the
 *    native scheduler could still fire an alarm the user had turned off.
 *
 * This module owns that bookkeeping: on every alarm-list change it makes the host's
 * registrations match the list — arm each enabled alarm's next occurrence, cancel
 * ids that are gone or disabled. Best-effort: without a Tauri bridge both commands
 * are no-ops, and the in-app watcher still rings.
 */
import { ALARM_KEY, nextArmments } from "../lib/alarmCore";
import { readStoreValue } from "../lib/amosStore";
import { cancelNativeAlarm, registerNativeAlarm } from "../lib/backend";
import { normalizeAlarms } from "../lib/time";

/** Ids currently registered with the host scheduler (`alarm:<id>`). */
let armed = new Set<string>();

/** Ids this module believes are registered (diagnostics / tests). */
export function armedNativeAlarmIds(): string[] {
  return [...armed];
}

/** Test seam: forget the bookkeeping (the host side is mocked in tests anyway). */
export function resetArmedNativeAlarmsForTest(): void {
  armed = new Set<string>();
}

/**
 * Make the host scheduler match the persisted alarm list. Returns the ids left
 * armed. Never throws (offline / storage unavailable → best-effort no-op).
 */
export async function reconcileNativeAlarms(nowMs = Date.now()): Promise<string[]> {
  let desired: Array<{ id: string; atMs: number }> = [];
  try {
    // `nextArmments` already filters to enabled alarms with a next occurrence.
    desired = nextArmments(normalizeAlarms(readStoreValue<unknown>(ALARM_KEY, [])), nowMs);
  } catch {
    return [...armed];
  }
  const wanted = new Set(desired.map((a) => a.id));

  // Cancel registrations whose alarm is gone or disabled — otherwise a turned-off
  // alarm can still ring from the native scheduler.
  for (const id of [...armed]) {
    if (wanted.has(id)) continue;
    armed.delete(id);
    try {
      await cancelNativeAlarm(id);
    } catch {
      /* offline / unsupported */
    }
  }

  // Arm (idempotently) every enabled alarm's next occurrence.
  for (const arm of desired) {
    try {
      await registerNativeAlarm(arm.id, arm.atMs);
      armed.add(arm.id);
    } catch {
      /* offline / unsupported */
    }
  }
  return [...armed];
}
