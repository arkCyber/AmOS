/* OS-level "due reminder" alerts.
 *
 * A reminder that reaches its due time should alert the user wherever they are
 * (home screen, another app, even the lock screen) — not only while the
 * Reminders app happens to be open. The Shell mounts `useDueReminderAlerts()`
 * once (mirroring `useNotificationAlert`), which periodically reconciles the
 * reminder store and fires ONE app notification per reminder the first time its
 * due instant is reached. Persisted "fired" markers (`amos.reminderFired`,
 * reminder id → dueAt already alerted) make the publish idempotent, so the
 * global arrival banner / dock badge / haptic / ring react to genuinely new
 * alerts, and opening the Reminders app clears them like any other app's.
 *
 * Pure helpers are exported for tests; `syncDueReminderAlerts` is the side-
 * effecting entry point used by the hook (and callable on its own).
 */
import { readStoreValue, writeStoreValue } from "./amosStore";
import { NOTIF_KEY, NOTIF_CAP, normalizeNotifs, type Notif } from "./settings";
import {
  REMINDERS_KEY,
  isOverdueNow,
  normalizeReminders,
  type Reminder,
} from "./reminders";
import { zh } from "../i18n/locales/zh";

export { REMINDERS_KEY };

export const FIRED_KEY = "amos.reminderFired";
/** Internal app id of the Reminders app (`svelte/appRegistry.ts`). While the user
 *  is focused there, due alerts are not published (the items are on screen). */
export const REMINDERS_APP_ID = "reminders";
/** How often the OS re-checks due times (a coarse background scheduler). */
export const DUE_ALERT_INTERVAL_MS = 15_000;
export const DUE_ALERT_ICON = "✅";

export function normalizeFired(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!k) continue;
    const t = o[k];
    if (typeof t === "number" && Number.isFinite(t)) out[k] = t;
  }
  return out;
}

/** Newly-reached, not-yet-alerted reminders, earliest first, bounded by `cap`. */
export function collectDueAlerts(
  reminders: Reminder[],
  fired: Record<string, number>,
  now: number,
  cap = 40,
): Reminder[] {
  return reminders
    .filter(
      (r) =>
        // The "due and still pending" rule lives in `lib/reminders` (and is
        // unit-tested there); the notifier must not keep a second copy of it.
        isOverdueNow(r, now) && fired[r.id] !== r.dueAt,
    )
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
    .slice(0, cap);
}

/** Record that each alerting reminder has been alerted at its current dueAt. */
export function markFired(
  fired: Record<string, number>,
  alerts: Reminder[],
): Record<string, number> {
  const out = { ...fired };
  for (const r of alerts) if (typeof r.dueAt === "number") out[r.id] = r.dueAt;
  return out;
}

/** Drop markers for reminders that no longer carry a due date (bounds growth). */
export function pruneFired(
  fired: Record<string, number>,
  reminders: Reminder[],
): Record<string, number> {
  const live = new Set(reminders.filter((r) => typeof r.dueAt === "number").map((r) => r.id));
  const out: Record<string, number> = {};
  for (const k of Object.keys(fired)) {
    const v = fired[k];
    if (live.has(k) && typeof v === "number") out[k] = v;
  }
  return out;
}

/** Turn alerting reminders into OS notifications (pure). */
export function alertsToNotifs(alerts: Reminder[], app: string, now: number): Notif[] {
  return alerts.map((r) => ({
    id: `rem:${r.id}`,
    app,
    icon: DUE_ALERT_ICON,
    title: r.title.length > 60 ? `${r.title.slice(0, 60)}…` : r.title,
    time: typeof r.dueAt === "number" ? r.dueAt : now,
  }));
}

/** Side-effecting reconciliation: fire new alerts + prune markers. Idempotent. */
export function syncDueReminderAlerts(now = Date.now()): void {
  const reminders = normalizeReminders(readStoreValue<unknown>(REMINDERS_KEY, []));
  const fired = normalizeFired(readStoreValue<unknown>(FIRED_KEY, {}));
  const alerts = collectDueAlerts(reminders, fired, now);
  if (alerts.length > 0) {
    // Normalize the existing list: a corrupt value must not wedge the alert
    // pipeline (spreading a non-array would throw on every tick, forever).
    const existing = normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, []));
    const fresh = alertsToNotifs(alerts, zh["app.reminders"], now);
    // Newest alert first, keep the rest, respect the notification cap.
    writeStoreValue(NOTIF_KEY, [...fresh.reverse(), ...existing].slice(0, NOTIF_CAP));
  }
  const next = pruneFired(markFired(fired, alerts), reminders);
  if (JSON.stringify(next) !== JSON.stringify(fired)) writeStoreValue(FIRED_KEY, next);
}

/** Mount once in the OS Shell: reconcile on boot, on a timer, and whenever the
 *  reminders (or their markers) change — fires alerts on every screen.
 *
 *  `activeAppId` is the currently-focused app id (from the Shell). While it is
 *  the Reminders app itself, publishing is suppressed: its items are already on
 *  screen, so a banner/badge would be redundant (and annoying). Leaving the app
 *  lets the next reconcile deliver any newly-due alert as usual.
 */

