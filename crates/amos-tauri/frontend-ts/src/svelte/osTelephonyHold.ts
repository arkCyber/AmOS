/**
 * React-free, shell-level keep-awake watcher for live calls.
 *
 * A ringing / answered / dialling call must keep the display on; ending the last
 * call releases it. This is the *runtime* half — the pure, call-id-aware
 * transition lives in `lib/useTelephonyHold` (`holdSet`) and the aggregate reason
 * bus in `lib/keepAwakeCore`. Folding the two here means overlapping calls each
 * need their own End, and an `Ended` for one call never drops another's hold.
 *
 * Started by `Shell.svelte` (alongside the other OS watchers); returns a stop fn
 * that unsubscribes and releases the `"call"` reason so a torn-down shell can
 * never leave the screen pinned on.
 */
import { onTelephonyEvent, type TelephonyCall } from "../lib/backend";
import { assertHold, releaseHold } from "../lib/keepAwakeCore";
import { holdSet } from "../lib/useTelephonyHold";

/**
 * Subscribe to call events and fold them into the `"call"` screen hold. The
 * subscriber is injectable (defaults to the real daemon event stream) so the
 * fold is unit-testable without Tauri.
 */
export function startOsTelephonyHold(
  subscribe: (onEvent: (call: TelephonyCall) => void) => () => void = onTelephonyEvent,
): () => void {
  let holding: ReadonlySet<string> = new Set<string>();
  const apply = (call: TelephonyCall): void => {
    const next = holdSet(holding, call);
    if (next === holding) return; // no-op event: no bus churn
    holding = next;
    if (holding.size > 0) assertHold("call");
    else releaseHold("call");
  };
  const unsubscribe = subscribe(apply);
  return () => {
    unsubscribe();
    holding = new Set<string>();
    releaseHold("call");
  };
}
