/**
 * realCall.ts — the shell-global memory of a call **owned by the platform's in-call
 * service** (the id `REAL_CALL_ID`).
 *
 * Why a module rather than component state: the in-call UI lives in `PhoneApp`, which
 * `AppPane` remounts on every app switch (`{#key id}`), so nothing component-local
 * survives a trip to the home screen and back. And the daemon cannot answer for it
 * either — `telephony_status` asks the daemon, which never sees a call AmOS owns through
 * `ROLE_DIALER`; that call is reported by nobody but `incall.rs`'s `nativeState` upcall
 * on the `telephony-event` channel. So the one subscriber that is *never* remounted
 * (`IncomingCall`, mounted once by `Shell`) writes down what that stream last said, and
 * `PhoneApp` re-adopts from here on mount / on returning to the foreground (REQ-A1231).
 *
 * Nothing here invents a call: every field comes from a bridge event, and only an
 * explicit `Ended` clears the record. An event that omits a toggle leaves the toggle
 * alone — the same "absent is no claim" rule the call surfaces apply, kept here so a
 * re-adopted call shows the route / mute / recording the user last chose rather than the
 * defaults a raw last-event snapshot would imply (`incall.rs`'s upcall, for instance,
 * carries no toggle at all).
 */
import type { TelephonyCall } from "./backend";
import { REAL_CALL_ID } from "./phone";

let live: TelephonyCall | null = null;

/** Record one bridge event, if it is about the platform-owned call. */
export function noteRealCall(c: TelephonyCall): void {
  if (c.id !== REAL_CALL_ID) return;
  if (c.state === "Ended") {
    live = null;
    return;
  }
  const prev = live;
  live = {
    ...c,
    recording: typeof c.recording === "string" ? c.recording : prev?.recording,
    muted: typeof c.muted === "boolean" ? c.muted : prev?.muted,
    speaker: typeof c.speaker === "boolean" ? c.speaker : prev?.speaker,
    hold: typeof c.hold === "boolean" ? c.hold : prev?.hold,
  };
}

/** The platform-owned call as the stream last described it, or `null` if none is live. */
export function realCallSnapshot(): TelephonyCall | null {
  return live;
}

/**
 * Forget the platform-owned call because a surface just hung it up and the host
 * **accepted** that.
 *
 * The record is otherwise cleared only by the stream's own `Ended`, which the daemon
 * reports "a beat after a *successful* `telephony_end`" (`PhoneApp.svelte::endCall`) —
 * the documented lag its component-local `endedIds` set exists for. That set cannot
 * cover this record: the reader who re-adopts from it (`PhoneApp`) is remounted on
 * every app switch, so the set dies exactly when the record is needed. Without this,
 * hang up → leave before `Ended` lands → return re-adopts a call the user ended, and
 * the in-call UI (a hang-up key and a running timer) comes back over nothing.
 *
 * Called at the **success** point of each hang-up site, never before: a refused
 * `telephony_end` (F-ALM-004) must keep the call — and so the record (REQ-A1234).
 */
export function forgetRealCall(id: string): void {
  if (id !== REAL_CALL_ID) return;
  live = null;
}

/** Clear the record between tests — the module state is shared across a test file. */
export function resetRealCallForTest(): void {
  live = null;
}
