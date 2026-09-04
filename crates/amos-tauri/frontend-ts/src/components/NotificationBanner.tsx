import { useEffect, useRef, useState } from "react";
import { writeStoreValue } from "../lib/amosStore";
import { NOTIF_KEY, newestAddedNotif, removeAppNotifs, type Notif } from "../lib/settings";
import { useStoreValue } from "../lib/useStoreValue";
import { useAlertPolicy } from "../lib/sound";

/** How long a banner stays up before auto-dismissing. */
const SHOW_MS = 4200;

/**
 * Transient "notification arrived" banner.
 *
 * Mounted once in the phone frame (over every screen: home / app / lock). When a
 * notification is added and Do-Not-Disturb is OFF, the newest one appears as a
 * toast near the top for a few seconds (tap to dismiss). DND suppresses the
 * banner — those notifications stay only in the Notification Center.
 */
export default function NotificationBanner() {
  const notifs = useStoreValue<Notif[]>(NOTIF_KEY, []);
  const { dnd } = useAlertPolicy();
  const [banner, setBanner] = useState<Notif | null>(null);
  const timer = useRef<number | null>(null);
  const prev = useRef<Notif[]>(notifs);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => {
    // DND hides a visible banner and suppresses new ones.
    if (dnd) {
      setBanner(null);
      clearTimer();
      prev.current = notifs;
      return;
    }
    const added = newestAddedNotif(prev.current, notifs);
    if (added) {
      setBanner(added);
      clearTimer();
      timer.current = window.setTimeout(() => {
        setBanner(null);
        timer.current = null;
      }, SHOW_MS);
    }
    prev.current = notifs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifs, dnd]);

  useEffect(() => clearTimer, []);

  // Acknowledge: mark the banner's app notifications as read (badge clears) and
  // dismiss the toast. Safe regardless of whether the app is navigable.
  const ack = () => {
    if (!banner) return;
    if (banner.app) {
      writeStoreValue(NOTIF_KEY, removeAppNotifs(notifs, banner.app));
    }
    setBanner(null);
  };

  if (!banner) return null;
  return (
    <button
      onClick={ack}
      aria-label="notification: acknowledge"
      className="absolute inset-x-3 top-[46px] z-[70] flex items-start gap-3 rounded-2xl bg-white/90 px-3 py-2.5 text-left shadow-lg ring-1 ring-black/10 backdrop-blur-md dark:bg-neutral-900/90 dark:ring-white/10"
    >
      <span className="text-xl leading-none" aria-hidden>
        {banner.icon ?? "🔔"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-neutral-900 dark:text-white">
          {banner.app ?? banner.title ?? "Notification"}
        </span>
        {banner.title && (
          <span className="block truncate text-xs text-neutral-700 dark:text-neutral-300">
            {banner.title}
          </span>
        )}
        {banner.body && (
          <span className="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
            {banner.body}
          </span>
        )}
      </span>
      <span aria-hidden className="opacity-50">
        ✓
      </span>
    </button>
  );
}
