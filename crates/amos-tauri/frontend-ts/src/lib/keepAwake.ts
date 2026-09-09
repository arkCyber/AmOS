import { useEffect, useRef, useState } from "react";
import { onTelephonyEvent, type TelephonyCall } from "./backend";
import { holdSet } from "./useTelephonyHold";
// Pure reason bus lives in the React-free keepAwakeCore (single source of truth);
// this legacy file re-exports it for existing React consumers and adds React hooks.
import { assertHold, onHoldChange, releaseHold, screenHeld } from "./keepAwakeCore";
export {
  assertHold,
  clearAllHolds,
  heldReasons,
  releaseHold,
  screenHeld,
} from "./keepAwakeCore";

/**
 * Frontend **keep-awake reason bus** — the mirror of the Rust
 * `amos_display::ScreenController`'s reason-keyed holds (`set_hold("reason")` /
 * `clear_hold("reason")` / `held()`). A screen reason is *why* the display must
 * not auto-sleep: an active call, turn-by-turn navigation, a foreground video.
 *
 * Module-singleton so any component (the call surface, a future Maps nav
 * session, a video player) can assert/revoke its own reason without prop-drilling,
 * and the Shell's auto screen-off watcher reads the aggregate via
 * [`useScreenHold`]. Reasons are sticky until explicitly released, and each
 * source owns its own reason (call + nav can both hold).
 */

/**
 * Reactive "is the screen being held on by any reason?" — the Shell feeds this
 * into its auto screen-off watcher so an asserted hold (call today; nav/video
 * later) suppresses auto-sleep.
 */
export function useScreenHold(): boolean {
  const [held, setHeld] = useState<boolean>(screenHeld);
  useEffect(() => onHoldChange(() => setHeld(screenHeld())), []);
  return held;
}

/**
 * Subscribe telephony call-state to the keep-awake bus: while at least one call
 * is Ringing/Active/Dialing the screen is held (`"call"`); when the last one
 * ends it is released. Call-id aware (an End for one call never drops the hold
 * while another is still up).
 *
 * The bus is a module singleton, so on unmount we must release whatever this
 * subscriber asserted — otherwise a lingering `"call"` would keep suppressing
 * auto-sleep after the call surface goes away.
 */
export function useCallKeepAwake(): void {
  const activeRef = useRef<ReadonlySet<string>>(new Set());
  const holdingRef = useRef(false);
  useEffect(
    () =>
      onTelephonyEvent((call: TelephonyCall) => {
        const next = holdSet(activeRef.current, call);
        activeRef.current = next;
        const shouldHold = next.size > 0;
        if (shouldHold && !holdingRef.current) assertHold("call");
        else if (!shouldHold && holdingRef.current) releaseHold("call");
        holdingRef.current = shouldHold;
      }),
    [],
  );
  // Release our assertion if we unmount mid-hold.
  useEffect(
    () => () => {
      if (holdingRef.current) releaseHold("call");
    },
    [],
  );
}
