/**
 * osPushWatcher.ts — shell-level poller that folds remote push deliveries into the
 * shell's one notification store.
 *
 * Why polling: `push_notifications.rs` records a delivery in its history but never
 * `emit`s a Tauri event, so the shell cannot be *told* about a delivery — it has to
 * ask. That ask is this watcher, and it is deliberately the thin part: the mapping
 * itself lives in the pure `lib/pushNotifBridge`, so what is left here is only
 * "when to ask" and "when to write".
 *
 * It writes **only when something new actually landed**, for two reasons: every
 * write broadcasts through the shared store (other windows re-read it), and a
 * no-op write on every tick would keep poking `NotificationBanner`'s arrival
 * detector with a list it has already seen.
 *
 * Honest boundaries:
 * - A delivery appears within `PUSH_POLL_MS`, not instantly — this is polling, not
 *   push. An event channel would need the Rust side to emit (research report §5.2).
 * - A failed fetch changes **nothing**: `getNotificationHistory` answers `[]` both
 *   when there is nothing new and when the host could not be reached, so treating it
 *   as "the deliveries are gone" would delete the user's list on every hiccup.
 */
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { bridged } from "../lib/backend";
import { getNotificationHistory } from "../lib/pushNotifications";
import { mergePushHistory } from "../lib/pushNotifBridge";
import { NOTIF_CAP, NOTIF_KEY, normalizeNotifs } from "../lib/settings";

/** How often the shell asks the push backend for deliveries it has not seen. */
export const PUSH_POLL_MS = 5_000;

/** Upper bound on the history records one poll asks for (mirrors the NC list cap). */
export const PUSH_HISTORY_LIMIT = 50;

/**
 * One poll: ask, merge, and write only on a real change.
 *
 * @returns how many notifications were added (0 when nothing was new, the host is
 *   not bridged, or the fetch failed).
 */
export async function pushWatcherTick(nowMs = Date.now()): Promise<number> {
  if (!bridged()) return 0;
  const records = await getNotificationHistory(PUSH_HISTORY_LIMIT);
  if (records.length === 0) return 0;
  // Normalize first so a corrupt store cannot be written back through the merge,
  // and so "nothing new" is an identity comparison on the very list we read.
  const held = normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, []));
  const merged = mergePushHistory(held, records, nowMs, NOTIF_CAP);
  if (merged === held) return 0;
  writeStoreValue(NOTIF_KEY, merged);
  return merged.length - held.length;
}

/** Start the poller. Returns a stop function (call on unmount). */
export function startPushWatcher(): () => void {
  const tick = () => {
    void pushWatcherTick().catch(() => {
      /* storage unavailable / backend threw — best effort; `invoke` logs the why */
    });
  };
  tick();
  const interval = window.setInterval(tick, PUSH_POLL_MS);
  return () => window.clearInterval(interval);
}
