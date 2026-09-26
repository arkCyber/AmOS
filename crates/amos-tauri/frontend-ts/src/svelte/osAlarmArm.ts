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
 *
 * **Never throws**, and the reason is a property of the bridge rather than a `try`: both
 * wrappers bottom out in `invoke` (`lib/backend.ts`), which catches every rejection and
 * answers `null` (REQ-A296). A stray `catch` here would therefore be decoration — it reads
 * like error handling while the refusal arrives as an ordinary `null` that nobody checks
 * (REQ-A875; `scripts/dead-catch-scan.mjs` is the gate for that shape).
 */
import { ALARM_KEY, nextArmments } from "../lib/alarmCore";
import { readStoreValue } from "../lib/amosStore";
import { cancelNativeAlarm, registerNativeAlarm, type NativeAlarmDeviceState } from "../lib/backend";
import { normalizeAlarms } from "../lib/time";

/** Ids currently registered with the host scheduler (`alarm:<id>`). */
let armed = new Set<string>();

/**
 * Ids the host was asked to cancel and did **not** confirm the OS released (REQ-A875).
 *
 * Every id here is also still in [`armed`]: `armed` doubles as the retry queue, so the next
 * reconcile asks again rather than forgetting. It is kept separately because "we have not
 * cancelled this yet" is a fact the alarm list should be able to state, and because a
 * successful re-arm removes the id from here (`wanted` wins over a stale cancellation).
 */
let unconfirmedCancel = new Set<string>();

/**
 * Last **device** outcomes the host reported (REQ-A369).
 *
 * The host used to answer nothing at all, so this module could not tell "the OS will wake the
 * phone at 07:00" from "we wrote a number into a hash map" — which is exactly the difference a
 * sleeping phone cares about (F-TAU-007, measured: the WebView's call resolved while
 * `dumpsys alarm` was empty). `arm.state === "scheduled"` is the only state that means the
 * alarm survives a doze or a killed process; the rest are reported so the UI can warn, never
 * assumed away.
 */
let lastArm: NativeAlarmDeviceState | null = null;
let lastCancel: NativeAlarmDeviceState | null = null;

/** Device states from the most recent reconcile (diagnostics + the alarm UI's warning). */
export function nativeAlarmDeviceState(): {
  arm: NativeAlarmDeviceState | null;
  cancel: NativeAlarmDeviceState | null;
} {
  return { arm: lastArm, cancel: lastCancel };
}

/** Does the host say the OS actually holds an exact alarm (so a sleeping phone wakes)? */
export function nativeWakeArmed(): boolean {
  return lastArm?.state === "scheduled";
}

/** Ids this module believes are registered (diagnostics / tests). */
export function armedNativeAlarmIds(): string[] {
  return [...armed];
}

/**
 * Ids whose cancellation the **device** never confirmed (REQ-A875 / F-ALM-004).
 *
 * Non-empty means: the OS may still fire a registration the user disabled or deleted, and
 * this module is still asking. The alarm list says so rather than leaving it to the log —
 * the host's `device.state` is the only thing that can tell "the OS let go" from "we asked
 * and wrote nothing down" (`DeviceOutcome::keeps_ledger` in `alarm_sched.rs` makes the same
 * argument for the ledger).
 */
export function unconfirmedNativeCancelIds(): string[] {
  return [...unconfirmedCancel];
}

/** Test seam: forget the bookkeeping (the host side is mocked in tests anyway). */
export function resetArmedNativeAlarmsForTest(): void {
  armed = new Set<string>();
  unconfirmedCancel = new Set<string>();
  lastArm = null;
  lastCancel = null;
}

/**
 * Did the **device** actually let go of this id?
 *
 * The complement of `DeviceOutcome::keeps_ledger()`, and deliberately so. There, the *Rust*
 * ledger may keep a row only for `scheduled` / `host_only` — every other state means the OS
 * does not hold the alarm. Here, *this* module may forget that it ever registered an id only
 * for `cancelled` / `host_only`; every other state (`unavailable`, `unattached`, `denied`,
 * `disallowed`, `unknown`, and no reply at all) means we could not make the device let go,
 * which is not the same fact as "it did".
 */
function deviceReleased(state: NativeAlarmDeviceState["state"] | undefined): boolean {
  return state === "cancelled" || state === "host_only";
}

/**
 * Make the host scheduler match the persisted alarm list. Returns the ids left
 * armed — which now includes any id whose cancellation the device did not confirm, because
 * it *is* still armed there (REQ-A875). Never throws (see the module doc: that is `invoke`'s
 * contract, not a `catch`); an unreadable store returns what is already armed.
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
  //
  // REQ-A875 / F-ALM-004: **ask the host first, forget second.** This used to drop the id
  // *before* calling (`armed.delete(id)` above the `await`), so a cancellation the device did
  // not carry out was forgotten permanently. `armed` is this module's only record that the
  // host holds an id, so no later reconcile could ever ask again — and the host still fires
  // it, which is the second case in this module's own doc ("a disabled or deleted alarm's
  // registration was never cancelled"). Now an id stays in `armed` until the device says it
  // let go, so `armed` is also the retry queue.
  for (const id of [...armed]) {
    if (wanted.has(id)) continue;
    const reply = await cancelNativeAlarm(id);
    if (reply) lastCancel = reply.device;
    if (reply && deviceReleased(reply.device.state)) {
      armed.delete(id);
      unconfirmedCancel.delete(id);
    } else {
      unconfirmedCancel.add(id);
    }
  }

  // Arm (idempotently) every enabled alarm's next occurrence.
  //
  // The `armed.add` below is deliberately **unconditional**, and the asymmetry with the loop
  // above is the whole point: keeping an id we did not need to keep costs one idempotent
  // cancel later, while forgetting one the device still holds costs a ring nobody can stop.
  // The two directions are not mirror images, so only the unrecoverable one waits for the
  // verdict. An alarm that came back into `wanted` is no longer an unconfirmed cancellation.
  for (const arm of desired) {
    const reply = await registerNativeAlarm(arm.id, arm.atMs);
    if (reply) lastArm = reply.device;
    armed.add(arm.id);
    unconfirmedCancel.delete(arm.id);
  }
  return [...armed];
}
