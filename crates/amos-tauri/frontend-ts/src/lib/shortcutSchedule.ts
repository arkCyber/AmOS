/**
 * shortcutSchedule.ts — the WebView half of `shortcuts_trigger_*` (Rust side:
 * `crates/amos-tauri/src/shortcut_triggers.rs`).
 *
 * Split of responsibility, restated here because it is the thing to preserve:
 * **Rust owns *when*** (a wall-clock ledger + the platform's exact-alarm binding, so a
 * time trigger still fires with no window open and no `setInterval` running), and
 * **this side owns the plan** (which shortcut/trigger pairs exist, translated from the
 * user's stored shortcuts). Nothing here decides an action — the poll answer is an
 * instruction ("this trigger is due at this instant"), and `lib/shortcuts.ts` executes.
 *
 * Outside Tauri every call degrades to `null`/`[]` (the `lib/clipboard.ts` convention),
 * and the shell then falls back to its own heartbeat — a browser-only host has no
 * scheduler bridge, and the shell says so rather than pretending it is armed.
 */
import { invoke } from "./backend";
import type { Shortcut, Trigger } from "./shortcuts";

/** One time trigger as Rust expects it (camelCase, mirroring `TimeTriggerSpec`). */
export interface ShortcutTriggerSpec {
  /** `"<shortcutId>:<triggerId>"` — identity in the ledger. */
  key: string;
  /** `"HH:mm"` (24-hour); an unreadable value is rejected by Rust **by name**. */
  time: string;
  /** ISO weekdays 1..7 (7 = Sunday); empty/absent = every day. */
  days?: number[];
}

/**
 * What the OS half of an arming actually did (`alarm_sched::DeviceOutcome`, serde-tagged
 * `{ state, detail? }`). `host_only` means "the ledger holds it, no `AlarmManager` here";
 * the refusal states (`disallowed` / `denied` / `unavailable` / `unattached` / `unknown`)
 * mean the phone will **not** wake.
 *
 * The shell must not round that up. {@link osHoldsAlarm} is the one rule (it mirrors the
 * Rust `DeviceOutcome::keeps_ledger`), and `osShortcutTriggers` logs a line for every armed
 * trigger the OS did **not** take — the same way it already surfaces a `rejected` rule — so
 * a trigger that will not fire while the phone dozes is never mistaken for one that will.
 */
export interface DeviceOutcome {
  state: string;
  detail?: unknown;
}

/**
 * The device states that mean the OS half really holds the alarm — exactly the Rust
 * `alarm_sched::DeviceOutcome::keeps_ledger` set (`matches!(self, Scheduled | HostOnly)`).
 *
 * Every other state — a refusal (`disallowed` / `denied` / `unavailable` / `unattached`),
 * the glue's own `unknown`, or a token we do not recognise — means the phone will not be
 * woken, so the shell says so instead of treating the trigger as armed. Keeping this list
 * as a whitelist (not a blacklist of refusals) makes an unfamiliar token fail **safe**: an
 * unknown word is treated as "not held", never as a working alarm.
 */
export const DEVICE_HOLDS = ["scheduled", "host_only"] as const;

/** Whether `state` means the OS half really holds the alarm (see {@link DEVICE_HOLDS}). */
export function osHoldsAlarm(state: string): boolean {
  return (DEVICE_HOLDS as readonly string[]).includes(state);
}

/** One armed trigger in the sync reply. */
export interface ArmedTrigger {
  key: string;
  /** Absolute epoch ms of the next occurrence. */
  atMs: number;
  device: DeviceOutcome;
}

/** One rule Rust refused, with its own reason. */
export interface RejectedTrigger {
  key: string;
  reason: string;
}

export interface TriggerSyncReply {
  armed: ArmedTrigger[];
  rejected: RejectedTrigger[];
  /** Keys that were in the previous plan and are gone from this one. */
  canceled: string[];
}

/** One due trigger from the poll. */
export interface FiredTrigger {
  key: string;
  atMs: number;
}

/** The ledger key for one trigger — the single place that format is defined. */
export function triggerKey(shortcutId: string, triggerId: string): string {
  return `${shortcutId}:${triggerId}`;
}

/** Split a ledger key back into its parts; `null` when it is not a well-formed key. */
export function parseTriggerKey(key: string): { shortcutId: string; triggerId: string } | null {
  const at = key.indexOf(":");
  if (at <= 0 || at === key.length - 1) return null;
  return { shortcutId: key.slice(0, at), triggerId: key.slice(at + 1) };
}

/**
 * Translate the stored shortcuts into the Rust plan.
 *
 * Only **enabled `time` triggers** have a wall-clock instant; every other type is a
 * signal the shell itself observes and feeds to the runtime directly. A trigger whose
 * `time` is missing or malformed is still sent: Rust refuses it *by key* and the shell
 * surfaces the reason, which is how the user finds out their rule is unreadable (a
 * silently dropped trigger is a broken automation nobody can see).
 */
export function timeTriggerSpecs(shortcuts: Shortcut[]): ShortcutTriggerSpec[] {
  const specs: ShortcutTriggerSpec[] = [];
  for (const shortcut of shortcuts) {
    for (const trigger of shortcut.triggers ?? []) {
      if (!trigger.enabled || trigger.type !== "time") continue;
      specs.push(specFor(shortcut.id, trigger));
    }
  }
  return specs;
}

function specFor(shortcutId: string, trigger: Trigger): ShortcutTriggerSpec {
  const config = trigger.config ?? {};
  const time = typeof config.time === "string" ? config.time : "";
  const rawDays = Array.isArray(config.days) ? config.days : [];
  const days = rawDays
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  return days.length > 0
    ? { key: triggerKey(shortcutId, trigger.id), time, days }
    : { key: triggerKey(shortcutId, trigger.id), time };
}

/** Replace the whole time-trigger plan. `null` = no bridge. */
export function syncTimeTriggers(
  triggers: ShortcutTriggerSpec[],
  nowMs?: number
): Promise<TriggerSyncReply | null> {
  return invoke<TriggerSyncReply>(
    "shortcuts_trigger_sync",
    nowMs === undefined ? { triggers } : { triggers, nowMs }
  );
}

/** Fire the due triggers and re-arm repeating ones. `null` = no bridge. */
export async function pollTimeTriggers(nowMs?: number): Promise<FiredTrigger[] | null> {
  const reply = await invoke<{ due: FiredTrigger[] }>(
    "shortcuts_trigger_poll",
    nowMs === undefined ? {} : { nowMs }
  );
  return reply === null ? null : (reply.due ?? []);
}
