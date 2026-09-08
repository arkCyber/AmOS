/* OS-level "due alarm" alerts.

 * An alarm that reaches its time should alert the user wherever they are (home
 * screen, another app, even the lock screen) — not only while the Clock app
 * happens to be open. The React Shell mounts `useDueAlarmAlerts()` once
 * (mirroring `useDueReminderAlerts`), which periodically reconciles the shared
 * `amos.alarms` store (the same one the Svelte ClockApp persists) and, the first
 * time each scheduled ring is reached, pushes ONE app notification and marks the
 * alarm `ringing:true` in the store.
 *
 * Unlike reminders, alarms are recurring, so the "already alerted" marker is
 * keyed by `id|HH:MM` AND the calendar day (date) — a daily alarm rings again
 * the next day, a snoozed/edited alarm (new HH:MM) rings at its new time, and
 * the same ring is never delivered twice within a day.
 *
 * Because the ClockApp and this notifier share the persisted store, opening the
 * Clock app clears the arrival badge (its app is named `app.clock`) and shows the
 * now-`ringing` alarm so the user can Snooze / Dismiss it. Publishing is
 * suppressed while the Clock app itself is the focused foreground app (its own
 * in-app ring is already on screen).
 *
 * Honest boundary: this delivers the *arrival* alert + badge on any screen while
 * the System UI is alive, plus marks the store so a later-open Clock screen shows
 * a live Snooze/Dismiss ring. It does NOT run when the device is asleep or the OS
 * process is dead (that needs a native `amos-scheduler AlarmExact` bridge), and the
 * arrival chime follows the same effective arrival-sound policy as every other
 * notification (so Do-Not-Disturb can silence the chime while the visual banner
 * still shows). A continuously looping native-style ring while you stay on another
 * screen is out of scope for the WebView layer.
 */
import { readStoreValue, writeStoreValue } from "./amosStore";
import { NOTIF_KEY, NOTIF_CAP, type Notif } from "./settings";
import { normalizeAlarms, dayAllowed, nextAlarmAtMs, type Alarm } from "./time";
import { registerNativeAlarm } from "./backend";
import { zh } from "../i18n/locales/zh";

/** Persisted alarm list key (shared with the Svelte ClockApp). */
export const ALARM_KEY = "amos.alarms";
/** Markers of rings already surfaced: `id|HH:MM` → `YYYY-MM-DD` it fired on. */
export const ALARM_FIRED_KEY = "amos.alarmNotifFired";
/** Internal app id of the Clock app. While focused there, we don't also publish. */
export const CLOCK_APP_ID = "clock";
/** Background reconcile cadence. Alarms are minute-granular, so a 2s poll is
 *  near-on-time yet cheap (a real OS would use an exact scheduler). */
export const ALARM_ALERT_INTERVAL_MS = 2_000;

const p2 = (n: number) => String(n).padStart(2, "0");
/** Stable "ring instance" for an alarm = its identity at one scheduled time. */
export const firedKey = (a: Alarm): string => `${a.id}|${p2(a.hour)}:${p2(a.min)}`;

/** Calendar day (local) of a Date, e.g. "2026-09-07". */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** Tolerate a malformed fired store → a map of `id|HH:MM` → date string. */
export function normalizeFired(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!k) continue;
    const d = o[k];
    if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) out[k] = d;
  }
  return out;
}

/** Alarms that should ring RIGHT NOW: enabled, repeat-day allows today, their
 *  HH:MM has just arrived, not already ringing, and not yet alerted today. */
export function collectDueRings(
  alarms: Alarm[],
  ringingIds: ReadonlySet<string>,
  fired: Record<string, string>,
  now: Date,
): Alarm[] {
  const day = dateKey(now);
  return alarms.filter(
    (a) =>
      a.enabled &&
      !ringingIds.has(a.id) &&
      dayAllowed(a, now) &&
      a.hour === now.getHours() &&
      a.min === now.getMinutes() &&
      fired[firedKey(a)] !== day,
  );
}

/** Record that each ring was alerted today (bounds growth by dropping old dates). */
export function markRung(
  fired: Record<string, string>,
  rings: Alarm[],
  now: Date,
): Record<string, string> {
  const out = { ...fired };
  const day = dateKey(now);
  for (const a of rings) out[firedKey(a)] = day;
  return out;
}

/** Drop markers that are for a different day or whose alarm no longer exists. */
export function pruneRung(
  fired: Record<string, string>,
  alarms: Alarm[],
  today: string,
): Record<string, string> {
  const live = new Set(alarms.map((a) => a.id));
  const out: Record<string, string> = {};
  for (const k of Object.keys(fired)) {
    if (fired[k] === today && live.has(k.slice(0, k.indexOf("|")))) out[k] = fired[k];
  }
  return out;
}

/** Turn ringing alarms into OS notifications (stable ids + the Clock app name,
 *  so opening the Clock app clears its badge like any other app's). */
export function ringsToNotifs(rings: Alarm[], app: string, nowMs: number): Notif[] {
  return rings.map((a) => {
    const hm = `${p2(a.hour)}:${p2(a.min)}`;
    const title = a.label && a.label.trim() ? a.label.trim() : hm;
    return {
      id: `alarm:${a.id}:${hm}`,
      app,
      icon: a.tone ?? "🔔",
      title: title.length > 60 ? `${title.slice(0, 60)}…` : title,
      body: a.label && a.label.trim() ? hm : undefined,
      time: nowMs,
    };
  });
}

/** Pure: the next native arming for just-fired (still-enabled) alarms — feed the
 *  exact-wake host so a daily alarm re-arms for its next occurrence. */
export function nextArmments(
  list: readonly Alarm[],
  nowMs: number,
): Array<{ id: string; atMs: number }> {
  const out: Array<{ id: string; atMs: number }> = [];
  for (const a of list) {
    if (!a.enabled) continue;
    const at = nextAlarmAtMs(a, nowMs);
    if (at !== null) out.push({ id: `alarm:${a.id}`, atMs: at });
  }
  return out;
}

/** Side-effecting reconcile: fire due alarms (badge + mark ringing) idempotently. */
export function syncDueAlarmAlerts(nowMs = Date.now()): void {
  const now = new Date(nowMs);
  const raw = readStoreValue<unknown>(ALARM_KEY, []);
  const alarms = normalizeAlarms(raw);
  const ringingIds = new Set<string>();
  if (Array.isArray(raw)) {
    for (const o of raw) {
      if (o && typeof o === "object" && (o as { ringing?: unknown }).ringing === true) {
        const id = (o as { id?: unknown }).id;
        if (typeof id === "string" && id) ringingIds.add(id);
      }
    }
  }
  const fired = normalizeFired(readStoreValue<unknown>(ALARM_FIRED_KEY, {}));
  const rings = collectDueRings(alarms, ringingIds, fired, now);

  if (rings.length > 0) {
    const ringSet = new Set(rings.map((a) => a.id));
    // Mark them ringing in the shared store so a later-open Clock screen shows a
    // live Snooze/Dismiss ring instead of a one-shot reminder.
    const nextList = alarms.map((a) =>
      ringSet.has(a.id) ? { ...a, ringing: true } : a,
    );
    if (JSON.stringify(nextList) !== JSON.stringify(alarms)) {
      writeStoreValue(ALARM_KEY, nextList);
    }
    const existing = readStoreValue<Notif[]>(NOTIF_KEY, []);
    const fresh = ringsToNotifs(rings, zh["app.clock"], nowMs);
    // Newest alert first, keep the rest, respect the notification cap.
    writeStoreValue(NOTIF_KEY, [...fresh.reverse(), ...existing].slice(0, NOTIF_CAP));
  }

  const next = pruneRung(markRung(fired, rings, now), alarms, dateKey(now));
  if (JSON.stringify(next) !== JSON.stringify(fired)) {
    writeStoreValue(ALARM_FIRED_KEY, next);
  }

  // Native exact-wake: re-arm each just-fired enabled alarm for its NEXT
  // occurrence (offline/no Tauri bridge → fire-and-forget no-op).
  for (const arm of nextArmments(rings, nowMs)) {
    try {
      void registerNativeAlarm(arm.id, arm.atMs).catch(() => {
        /* offline / unavailable */
      });
    } catch {
      /* ignore */
    }
  }
}


