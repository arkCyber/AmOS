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
 * process is dead — that half is the native exact-alarm scheduler, registered and
 * cancelled by `svelte/osAlarmArm` (which reports the host's device verdict; see
 * `scheduler_alarm_register` in `crates/amos-tauri/src/alarm_sched.rs`) — and the
 * arrival chime follows the same effective arrival-sound policy as every other
 * notification (so Do-Not-Disturb can silence the chime while the visual banner
 * still shows). A continuously looping native-style ring while you stay on another
 * screen is out of scope for the WebView layer.
 */
import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "./amosStore";
import { NOTIF_KEY, NOTIF_CAP, normalizeNotifs, removeNotif, type Notif } from "./settings";
import { normalizeAlarms, dayAllowed, nextAlarmAtMs, type Alarm } from "./time";
import { bgT } from "../svelte/bgText";

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
/** An alarm's scheduled time as `HH:MM`. One formatter, because two identities are built out
 *  of it — the ring-instance marker (`firedKey`) and the notification row (`ringKey`). */
export const hhmm = (a: Alarm): string => `${p2(a.hour)}:${p2(a.min)}`;
/** Stable "ring instance" for an alarm = its identity at one scheduled time. */
export const firedKey = (a: Alarm): string => `${a.id}|${hhmm(a)}`;

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

/** Ids whose raw persisted entry carries `ringing:true`, before any day test. */
export function flaggedRingingIds(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(raw)) {
    for (const o of raw) {
      if (o && typeof o === "object" && (o as { ringing?: unknown }).ringing === true) {
        const id = (o as { id?: unknown }).id;
        if (typeof id === "string" && id) out.add(id);
      }
    }
  }
  return out;
}

/**
 * The ids whose persisted `ringing:true` is *this day's* ring — the arrival was surfaced
 * **today**.
 *
 * `ringing` is a transient bit (a Snooze/Dismiss ring is live for the minutes after it
 * fires) written into durable storage, and the only things that retract it are user
 * gestures — `alarmsReducer`'s `toggle`/`dismiss`/`snooze`. So an alarm the user never
 * touched stays `ringing:true` **forever**: the arrival banner ignored, or the Clock app
 * closed while it rang. `collectDueRings` skips a ringing id, so such a bit silences the
 * alarm for good. The `ALARM_FIRED_KEY` marker records the date a ring was surfaced, and
 * requiring it to be *today* is what turns the bit back into what it means (REQ-A1392).
 */
export function liveRingingIds(
  raw: unknown,
  fired: Record<string, string>,
  now: Date,
): Set<string> {
  const flagged = flaggedRingingIds(raw);
  if (flagged.size === 0) return flagged;
  const day = dateKey(now);
  const out = new Set<string>();
  for (const a of normalizeAlarms(raw)) {
    if (flagged.has(a.id) && fired[firedKey(a)] === day) out.add(a.id);
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

/**
 * The notification row's identity for one ring **arrival**: `<alarm>:<HH:MM>:<that day>`.
 *
 * Derived, never minted (`localId`) — and the day is the load-bearing part. A daily alarm
 * reaches the same `HH:MM` *every* day, so without it the second day's ring was the same row
 * as the first: nothing on `amos.notifications` said so (the row was simply prepended again),
 * but the arrival banner decides "new" by comparing id **sets** (`newestAddedNotif`), so a
 * ring the user never opened kept one id forever and the OS never announced it again. The
 * calendar producer gets this right by construction (`cal:<id>@<startAt>`); this is the same
 * rule one producer over (REQ-A1400 ∕ F-SH-658).
 *
 * Being derived rather than minted is also what makes it usable as the row's *reconciliation*
 * key: a retry must land on the same row, which a fresh id would not.
 */
export function ringKey(a: Alarm, nowMs: number): string {
  return `alarm:${a.id}:${hhmm(a)}:${dateKey(new Date(nowMs))}`;
}

/** Turn ringing alarms into OS notifications (stable ids + the Clock app name,
 *  so opening the Clock app clears its badge like any other app's). */
export function ringsToNotifs(rings: Alarm[], app: string, nowMs: number): Notif[] {
  return rings.map((a) => {
    const hm = hhmm(a);
    const title = a.label && a.label.trim() ? a.label.trim() : hm;
    return {
      id: ringKey(a, nowMs),
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

/**
 * Side-effecting reconcile: fire due alarms (badge + mark ringing) idempotently.
 *
 * Returns whether anything **rang** on this call, so the caller can re-arm the fired
 * alarms for their next occurrence. That re-arm is not done here: registering with the
 * host's exact-alarm scheduler belongs to `svelte/osAlarmArm`, the one module that also
 * cancels and that reads the host's device verdict. This function used to hold a second,
 * fire-and-forget copy of it — a `try`/`catch` around a bridge call that cannot throw,
 * so the host's refusal arrived as an ordinary value nobody looked at (REQ-A875).
 */
export function syncDueAlarmAlerts(nowMs = Date.now()): boolean {
  const now = new Date(nowMs);
  const raw = readStoreValue<unknown>(ALARM_KEY, []);
  const alarms = normalizeAlarms(raw);
  // Read the day markers FIRST: whether a persisted `ringing:true` still counts as
  // "ringing" is decided by them (`liveRingingIds`), not by the raw bit alone.
  const fired = normalizeFired(readStoreValue<unknown>(ALARM_FIRED_KEY, {}));
  const live = liveRingingIds(raw, fired, now);
  const rings = collectDueRings(alarms, live, fired, now);

  // Reconcile the persisted `ringing` bits to exactly the live rings: set the ones that
  // just rang, and **retract the ones whose day has passed**. Only a user gesture
  // (toggle/dismiss/snooze) clears the bit otherwise, so an arrival the user never
  // touched would stay `ringing:true` forever — and since `collectDueRings` skips a
  // ringing id, silence the alarm from then on. Retracting it here is also what lets the
  // Clock screen's persisted-ring seed stay honest: it shows the ring it is handed, so
  // the store must only ever hand it today's (REQ-A1392).
  const desired = new Set<string>(live);
  for (const a of rings) desired.add(a.id);
  const flagged = flaggedRingingIds(raw);
  const settled = flagged.size === desired.size && [...flagged].every((id) => desired.has(id));
  // Mark them ringing in the shared store so a later-open Clock screen shows a
  // live Snooze/Dismiss ring instead of a one-shot reminder. `settled` already means the
  // store holds exactly this ringing set, so there is nothing to write and nothing to ask.
  // Otherwise the verdict matters, because the marker below is what bounds the bit: consuming
  // the day marker while the ring never reached the store would latch a "surfaced today" that
  // no surface holds, and — since `liveRingingIds` is what keeps a persisted ring alive —
  // leave the alarm silent for the rest of the day with nothing anywhere saying so.
  const latched = settled
    ? true
    : writeStoreValueChecked(
        ALARM_KEY,
        alarms.map((a) => (desired.has(a.id) ? { ...a, ringing: true } : a)),
      );

  if (rings.length > 0) {
    // Two things the two sibling producers (reminders / calendar) already do here, and this
    // one did not — both of them about the row being the *stored* shape, not the drawn one:
    //
    //  - Read through the corruption guard. Spreading a raw non-array (`{…}`, a number)
    //    throws `Spread syntax requires ...iterable`, and the throw escaped
    //    `alarmWatcherTick`'s `catch` → every 2 s tick answered `false` while the corrupt
    //    value stayed corrupt, so the whole alarm pipeline was wedged silently.
    //  - Replace, don't prepend. `alarm:<id>:<HH:MM>` names one ring instance, and a daily
    //    alarm reaches the same HH:MM every day, so each ring appended another copy of the
    //    *same row*. `normalizeNotifs` collapses them on read, so nothing on screen said
    //    anything — but they consumed `NOTIF_CAP` in the stored array, so enough days (or
    //    alarms) would push every real notification out of the store.
    const existing = normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, []));
    const fresh = ringsToNotifs(rings, bgT("app.clock"), nowMs);
    // Newest alert first, keep the rest, respect the notification cap.
    let list = existing;
    for (const n of fresh) list = [n, ...removeNotif(list, n.id)];
    writeStoreValue(NOTIF_KEY, list.slice(0, NOTIF_CAP));
  }

  // Consume the marker only for rings whose **ring is in the store** — that bit is the surface
  // the marker bounds (`liveRingingIds`), so it is the one this marker is gated on. The
  // arrival *row* is a second, additive channel: unlike the reminders ∕ calendar producers,
  // whose only surface is the row, a refused banner must not retract a live ring the Clock
  // app is already showing, so the row's verdict is deliberately not what decides this.
  const next = pruneRung(markRung(fired, latched ? rings : [], now), alarms, dateKey(now));
  if (JSON.stringify(next) !== JSON.stringify(fired)) {
    writeStoreValue(ALARM_FIRED_KEY, next);
  }

  return rings.length > 0;
}


