import type { TelephonyCall } from "./backend";

/** Call states that keep the display on (Ring / answered / dialling). */
export function isHoldState(state: string): boolean {
  return state === "Ringing" || state === "Active" || state === "Dialing";
}

/**
 * Pure, **call-id-aware** reducer over the set of calls currently holding the
 * display on. `Ended` removes *that one call's id*; Ringing/Active/Dialing adds
 * it. An `Ended` for one call never releases a hold while another call is still
 * active, and overlapping calls each need their own End. Returns `prev`
 * unchanged (no re-render) when the event is a no-op.
 *
 * The keep-awake reason bus (`lib/keepAwake.ts` `useCallKeepAwake`) folds these
 * into a `"call"` screen hold.
 */
export function holdSet(
  prev: ReadonlySet<string>,
  call: TelephonyCall,
): ReadonlySet<string> {
  if (call.state === "Ended") {
    if (!prev.has(call.id)) return prev;
    const next = new Set(prev);
    next.delete(call.id);
    return next;
  }
  if (isHoldState(call.state)) {
    if (prev.has(call.id)) return prev;
    const next = new Set(prev);
    next.add(call.id);
    return next;
  }
  return prev;
}
