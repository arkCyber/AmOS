/**
 * pushNotifBridge.ts — the seam between *remote push deliveries* and the shell's
 * one notification store.
 *
 * The shell already has exactly one truth for "what is in the notification
 * centre": `amos.notifications` (`lib/settings`, key `NOTIF_KEY`), whose values
 * are `Notif`. Everything that renders notifications — `NotificationCenter`
 * (list + dismiss/clear), `NotificationBanner` (arrival toast, chime, haptic,
 * DND gating) — reads that store. So a push delivery does **not** get its own
 * model or its own list; it gets **projected** into the same store by the two
 * pure functions here, and every existing surface picks it up for free.
 *
 * Pure by construction: no DOM, no Tauri, no clock of its own (the caller passes
 * `now`), so the mapping can be unit-tested against the real Rust record shape.
 */
import { extractAlertText, extractBadge, type PushPayload, type RustNotificationRecord } from "./pushNotifications";
import type { Notif } from "./settings";

/** Icon shown for a projected push delivery. */
export const PUSH_NOTIF_ICON = "📩";

/**
 * Project one Rust notification record into a `Notif`, or `null` when it must not
 * appear on screen.
 *
 * Honest boundaries (each one is a deliberate decision, not an accident):
 * - **No alert text ⇒ no visible notification.** A silent push
 *   (`content-available`) and a badge-only push are real deliveries with nothing
 *   to show; they stay in the Rust history (and the settings stats) but must not
 *   put a blank row in front of the user.
 * - **`received_at` is an ISO 8601 string**, not a millisecond number. When it
 *   cannot be parsed we do **not** drop a real delivery, and we do **not** invent
 *   a delivery instant either: the only instant we can honestly attribute to it is
 *   the moment we first saw it, so `fallbackNow` is used and the caller decides
 *   what that means.
 * - **`read` is copied from the device** (`Record.read`), so a notification the
 *   OS already considers seen is not re-shown as unread.
 */
export function pushRecordToNotif(rec: RustNotificationRecord, fallbackNow: number): Notif | null {
  const alert = extractAlertText(rec.payload);
  if (!alert) return null;

  const parsed = Date.parse(rec.received_at);
  const n: Notif = {
    id: rec.id,
    time: Number.isFinite(parsed) ? parsed : fallbackNow,
    icon: PUSH_NOTIF_ICON,
    source: "push",
    read: rec.read === true,
  };
  if (alert.title !== undefined) n.title = alert.title;
  if (alert.body !== undefined) n.body = alert.body;
  // The app the push *claims* to come from, when the payload carries one
  // (APNs custom data is flattened onto the payload object by the Rust side).
  const app = appLabel(rec.payload);
  if (app !== null) n.app = app;
  const badge = extractBadge(rec.payload);
  if (badge !== null) n.badge = badge;
  return n;
}

/** The payload's own app label, or `null` when it does not carry a usable one. */
function appLabel(payload: PushPayload): string | null {
  const raw = (payload as Record<string, unknown>).app;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Merge freshly-fetched push records into the shell's notification list
 * (immutable, bounded by the caller's `cap`).
 *
 * Rules, in order of importance:
 * 1. **An id we already hold is left alone.** The Rust history is re-read on every
 *    poll, so a record we already projected comes back for the rest of its life;
 *    re-projecting it would resurrect the local read flag the user just set.
 * 2. **New deliveries are added**, newest-first, so the store keeps the ordering
 *    every existing surface already assumes (`addNotif` prepends too).
 * 3. **Nothing is ever removed here.** A missing record is not proof of deletion
 *    (the fetch may simply have failed or been paginated); removal is an explicit
 *    user action (`dropPushNotifs` behind "clear push history").
 */
export function mergePushHistory(
  existing: Notif[],
  records: RustNotificationRecord[],
  now: number,
  cap: number,
): Notif[] {
  const held = new Set(existing.map((n) => n.id));
  const added: Notif[] = [];
  for (const rec of records) {
    if (held.has(rec.id)) continue;
    const projected = pushRecordToNotif(rec, now);
    if (!projected) continue;
    held.add(projected.id);
    added.push(projected);
  }
  if (added.length === 0) return existing;
  added.sort((a, b) => b.time - a.time);
  return [...added, ...existing].slice(0, Math.max(0, cap));
}

/**
 * Pure: drop every **push** notification from the list (immutable). This is the
 * local half of "clear push history" — the Rust history is cleared separately, and
 * doing one without the other would leave the list showing what the store no
 * longer has (or vice versa).
 */
export function dropPushNotifs(list: Notif[]): Notif[] {
  return list.filter((n) => n.source !== "push");
}
