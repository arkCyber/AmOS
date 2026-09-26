/**
 * phone-real-call-readopt.svelte.test.ts — a live call must survive an app switch
 * (REQ-A1231 / FMEA F-SH-513).
 *
 * The newest round made a call that AmOS *owns* through `ROLE_DIALER` a thing the Phone
 * page drives: a dial-out with no daemon falls back to Android `ACTION_CALL`, Telecom
 * resolves it back into this app's own `AmosInCallService`, and the bridge reports it
 * under the fixed id `real` (`lib/phone.ts::REAL_CALL_ID`). The page adopted it at dial
 * time, so the keypad stopped being a dead end — the exact sentence that round's own
 * comment is about: "stepping back to the keypad and calling it 'handed to the system'
 * left a live call with no control anywhere on screen (the 'system' that took it *is*
 * this app)".
 *
 * The surface it did not reach is the *second* half of that: the page's call state is
 * component-local, and `AppPane` renders every app inside `{#key id}` — so leaving the
 * Phone app mid-call and coming back mounts a **fresh** `PhoneApp` with no call. Its
 * re-adoption entry point, `adoptLiveCall()` (mount + `visibilitychange`/`focus`), asks
 * `telephony_status`, which asks the **daemon** — and the daemon has never heard of this
 * call: it is reported by nothing but `incall.rs`'s `nativeState` upcall. The shell's
 * global `IncomingCall` subscriber *is* subscribed to that stream and is not remounted,
 * but it drops outgoing calls (`if (c.direction !== "Incoming") return;`), and the Kotlin
 * glue exposes no query for it (no Notification, no Activity — this WebView is the only
 * control surface). So the bare keypad came back over a live call, and `onTelephonyEvent`
 * in the fresh page ignores events for a call it never adopted (`activeRef` null).
 *
 * These tests mount the shell subscriber and the page together, then literally unmount
 * the page and mount a new one — no new event is emitted in between, which is the point.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import IncomingCall from "../src/svelte/IncomingCall.svelte";
import PhoneApp from "../src/svelte/PhoneApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { CALLLOG_KEY } from "../src/lib/calllog";
import { resetRealCallForTest } from "../src/lib/realCall";
import { TELEPHONY_EVENT } from "../src/lib/backend";
import { zh } from "../src/i18n/locales/zh";

type AnyWin = Record<string, unknown>;
type Cb = (e: { payload: unknown }) => void;

const cleanBridge = () => delete (window as AnyWin).__TAURI_INTERNALS__;

/**
 * A device where AmOS holds `ROLE_DIALER` and **no daemon** answers: `telephony_dial`
 * declines, `real_dial` (the `ACTION_CALL` path) takes it, and the role query says the
 * role is held — the same shape as `phone-outgoing.svelte.test.ts`'s
 * `installNoDaemonDefaultDialerBridge`. `telephony_status` answers `[]`: that is the
 * whole point — the daemon the page asks on remount knows nothing about this call.
 */
function installBridge(): (payload: unknown) => void {
  // A *list* per channel, not a slot: this is the first test with two subscribers on the
  // `telephony-event` channel at once (the shell overlay and the Phone page), and the
  // real host fans an event out to every listener. A single-slot fake would let the
  // second `listen` silently replace the first, hiding the whole shell subscriber — the
  // very thing under test here.
  const listeners = new Map<string, Cb[]>();
  (window as AnyWin).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "telephony_dial") return null;
      if (cmd === "real_dial") return "dialing via Android Telecom";
      if (cmd === "telephony_default_dialer_status") {
        return { role_supported: true, role_held: true, role_requestable: true };
      }
      if (cmd === "telephony_status") return [];
      return null;
    },
    listen: async (channel: string, cb: Cb) => {
      const list = listeners.get(channel) ?? [];
      list.push(cb);
      listeners.set(channel, list);
      return () => {
        listeners.set(channel, (listeners.get(channel) ?? []).filter((f) => f !== cb));
      };
    },
  };
  return (payload) =>
    [...(listeners.get(TELEPHONY_EVENT) ?? [])].forEach((cb) => cb({ payload: payload as unknown }));
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const key = (h: { container: HTMLElement }, aria: string) =>
  h.container.querySelector(`button[aria-label="${aria}"]`) as HTMLButtonElement | null;

beforeEach(() => {
  window.localStorage.clear();
  resetRealCallForTest();
  cleanBridge();
});
afterEach(() => {
  resetRealCallForTest();
  cleanBridge();
});

/** Dial the shared number, which hand-offs to our own in-call service (id `real`). */
async function dialOurOwnCall(h: { container: HTMLElement }) {
  for (const d of "13800000000") await fireEvent.click(key(h, d)!);
  await fireEvent.click(key(h, zh["phone.call"]) as HTMLButtonElement);
  await tick();
  await settle();
}

describe("PhoneApp re-adopts a live platform-owned call after a remount", () => {
  test("left mid-call and returned → the in-call UI comes back with no new event", async () => {
    const emit = installBridge();
    // The shell's global subscriber: mounted once, never remounted by an app switch.
    const shell = render(IncomingCall);
    await settle();

    const first = render(PhoneApp);
    await settle();
    await dialOurOwnCall(first);
    expect(key(first, zh["a11y.end"])).toBeTruthy(); // adopted at dial time

    emit({ id: "real", peer: "13800000000", state: "Active", direction: "Outgoing" });
    await tick();
    await settle();
    expect(txt(first)).toContain(zh["phone.talking"]);

    // Leave the Phone app (`AppPane`'s `{#key id}` unmounts it) and come back. **No event
    // is emitted here** — re-adoption can only come from what the stream already said.
    first.unmount();
    await tick();
    const back = render(PhoneApp);
    await tick();
    await settle();

    expect(key(back, zh["a11y.end"])).toBeTruthy();
    expect(txt(back)).toContain("13800000000");
    expect(txt(back)).toContain(zh["phone.talking"]);
    shell.unmount();
  });

  test("the call survives as a log entry too — it was a real outgoing call", async () => {
    const emit = installBridge();
    const shell = render(IncomingCall);
    await settle();
    const first = render(PhoneApp);
    await settle();
    await dialOurOwnCall(first);
    emit({ id: "real", peer: "13800000000", state: "Active", direction: "Outgoing" });
    await tick();
    await settle();
    first.unmount();
    await tick();
    const back = render(PhoneApp);
    await tick();
    await settle();
    expect(readStoreValue<unknown[]>(CALLLOG_KEY, []).length).toBeGreaterThan(0);
    shell.unmount();
    // keep the adopted surface honest as well
    expect(key(back, zh["a11y.end"])).toBeTruthy();
  });

  /** Reverse control *inside* the fix: once the call ends, there is nothing to re-adopt. */
  test("once the call has ended, a remount does not resurrect it", async () => {
    const emit = installBridge();
    const shell = render(IncomingCall);
    await settle();
    const first = render(PhoneApp);
    await settle();
    await dialOurOwnCall(first);
    emit({ id: "real", peer: "13800000000", state: "Active", direction: "Outgoing" });
    await tick();
    await settle();
    emit({ id: "real", peer: "13800000000", state: "Ended", direction: "Outgoing" });
    await tick();
    await settle();

    first.unmount();
    await tick();
    const back = render(PhoneApp);
    await tick();
    await settle();
    expect(key(back, zh["a11y.end"])).toBeFalsy();
    expect(txt(back)).not.toContain(zh["phone.talking"]);
    shell.unmount();
  });

  /**
   * The negative control at the seam: with **nothing subscribed to the stream**, the same
   * remount over the same no-daemon bridge stays a bare keypad. Without this, the tests
   * above could be passing on some other path (a persisted call log, the bridge's own
   * `real_dial` reply) rather than on what the stream said.
   */
  test("with no shell subscriber, the remount cannot know — the keypad stays bare", async () => {
    installBridge();
    const first = render(PhoneApp);
    await settle();
    await dialOurOwnCall(first);
    first.unmount();
    await tick();
    const back = render(PhoneApp);
    await tick();
    await settle();
    expect(key(back, zh["a11y.end"])).toBeFalsy();
  });
});
