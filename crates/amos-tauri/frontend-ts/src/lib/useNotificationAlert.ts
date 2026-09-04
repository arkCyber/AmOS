import { useEffect, useRef } from "react";
import { NOTIF_KEY, type Notif } from "./settings";
import { useStoreValue } from "./useStoreValue";
import { useAlertPolicy, shouldRingOnArrival, shouldVibrateOnArrival } from "./sound";
import { playNotifyTone } from "./notifyTone";

/**
 * Global "notification arrived" alert.
 *
 * Mount once in the shell (always rendered, across home/apps/lock/overlays) so a
 * haptic pulse / ring tone fires no matter which screen is showing, gated by the
 * *effective* sound policy (DND or disabled bits silence it). Tracks the previous
 * unread length internally so an already-populated inbox never buzzes on mount.
 */
export function useNotificationAlert(): void {
  const notifs = useStoreValue<Notif[]>(NOTIF_KEY, []);
  const { effective } = useAlertPolicy();
  const prevUnread = useRef<number>(notifs.length);

  useEffect(() => {
    const before = prevUnread.current;
    prevUnread.current = notifs.length;
    if (shouldVibrateOnArrival(before, notifs.length, effective)) {
      try {
        navigator.vibrate?.(25);
      } catch {
        /* vibration unsupported — ignore */
      }
    }
    if (shouldRingOnArrival(before, notifs.length, effective)) {
      playNotifyTone();
    }
  }, [notifs.length, effective]);
}
