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
 * detector with a list it has already seen. And "landed" is the *write's* verdict,
 * not the merge's: a store that refuses the write recorded nothing, so the tick
 * neither bounces the Dock nor reports a delivery (REQ-A1277).
 *
 * Honest boundaries:
 * - A delivery appears within `PUSH_POLL_MS`, not instantly — this is polling, not
 *   push. An event channel would need the Rust side to emit (research report §5.2).
 * - A failed fetch changes **nothing**: `getNotificationHistory` answers `null` when the
 *   host could not be reached and `[]` when it answered "there is nothing" — the tick treats
 *   both as *no news*, because treating a failed fetch as "the deliveries are gone" would
 *   delete the user's list on every hiccup. The two are still distinct at the reader
 *   (REQ-A1335), so a future caller that needs "the fetch failed" can ask for it.
 */
import { readStoreValue, writeStoreValueChecked } from "../lib/amosStore";
import { bridged } from "../lib/backend";
import { requestAttention, shellIsBackground, shouldRequestAttention } from "../lib/dockBadge";
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
 *   not bridged, the fetch failed, or the store refused the write — in that last
 *   case nothing landed and the Dock is not bounced; REQ-A1277).
 */
export async function pushWatcherTick(nowMs = Date.now()): Promise<number> {
  if (!bridged()) return 0;
  const records = await getNotificationHistory(PUSH_HISTORY_LIMIT);
  // `null` = the host did not answer, `[]` = it answered "nothing new". Both are *no news*.
  if (records === null || records.length === 0) return 0;
  // Normalize first so a corrupt store cannot be written back through the merge,
  // and so "nothing new" is an identity comparison on the very list we read.
  const held = normalizeNotifs(readStoreValue<unknown>(NOTIF_KEY, []));
  const merged = mergePushHistory(held, records, nowMs, NOTIF_CAP);
  if (merged === held) return 0;
  // Count the ids that were **not** already held, not the length delta (REQ-A589): the merge
  // caps the list, so at the cap a delivery that really landed leaves `merged.length` equal to
  // `held.length` — the old `merged.length - held.length` reported 0 for it, and the caller that
  // now depends on this number (the Dock-attention bounce) would have stayed silent exactly when
  // the user was most behind.
  const before = new Set(held.map((n) => n.id));
  const added = merged.reduce((n, x) => n + (before.has(x.id) ? 0 : 1), 0);
  // REQ-A1277 — **the write is the gate for every claim below it.** This module writes "only when
  // something new actually landed", and the Dock bounce *is* the announcement that one did; a store
  // that refused the write (full / unavailable — `writeJson` logs and answers `false`) recorded
  // nothing, so there is no delivery to announce and nothing to count. Dropping the verdict made
  // the bounce a claim about an arrival that never happened — and, because `held` is re-read from
  // the same store on the next poll, the merge re-adds the same record, `added` comes out >0 again
  // and the Dock bounced **every `PUSH_POLL_MS`** for as long as the refusal lasted. Once the write
  // lands the delivery is surfaced normally (the poll re-reads the host's history anyway), so
  // staying silent here loses nothing.
  if (!writeStoreValueChecked(NOTIF_KEY, merged)) return 0;
  // The delivery the allow-list asked for: a push that arrives while this window is in the
  // background is one the user can miss, so the Dock bounces **once** (the count is the badge's
  // job, `lib/dockBadge` — and `level: "info"`, never "critical", because the payload carries no
  // interruption level). Fire-and-forget: the poller must not wait on a cosmetic call.
  if (shouldRequestAttention(added, shellIsBackground())) void requestAttention("info");
  return added;
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
