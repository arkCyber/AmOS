/**
 * phone-real-call-hangup.svelte.test.ts — a call the user hung up must not come back.
 *
 * `PhoneApp.endCall` keeps a component-local `endedIds` set precisely because the source it
 * re-adopts from lags: its own comment says the daemon "reports a call as live for a beat
 * after a *successful* `telephony_end`", and the set is what "stops a resume/recheck from
 * re-adopting a call the user just hung up (which would make the in-call screen reappear)".
 *
 * The platform-owned call (`REAL_CALL_ID`) is re-adopted from a **second** source — the
 * shell-global record the never-remounted `IncomingCall` writes (`lib/realCall.ts`,
 * REQ-A1231) — and that record has no equivalent of `endedIds`: it is cleared only by the
 * stream's own `Ended` event, which (per the comment above) routinely trails the hang-up.
 * The `Set` cannot cover the gap either, because it is component-local and **dies with the
 * remount** — the very situation the record was added to serve. So: hang up, leave the app
 * before the `Ended` arrives, come back — and the in-call UI is on screen again, over a
 * call the user ended, with a hang-up key and a running timer.
 *
 * Complementary to `phone-real-call-readopt.svelte.test.ts`, which pins the opposite
 * direction (a *live* call must come back). Neither test can be satisfied by simply
 * keeping or dropping the record: the two together are the invariant.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import IncomingCall from "../src/svelte/IncomingCall.svelte";
import PhoneApp from "../src/svelte/PhoneApp.svelte";
import { resetRealCallForTest } from "../src/lib/realCall";
import { TELEPHONY_EVENT } from "../src/lib/backend";
import { zh } from "../src/i18n/locales/zh";

type AnyWin = Record<string, unknown>;
type Cb = (e: { payload: unknown }) => void;

const cleanBridge = () => delete (window as AnyWin).__TAURI_INTERNALS__;

/**
 * No-daemon device where AmOS holds `ROLE_DIALER`, so a dial-out is resolved back into
 * this app's own in-call service (id `real`). `endFails` models the *other* honest
 * outcome: the in-call service refuses the hang-up (F-ALM-004), which must keep the
 * surface — and the record — rather than pretending the call is gone.
 *
 * Note what this bridge deliberately does **not** do: emit an `Ended` event after
 * `telephony_end` is accepted. That lag is the documented behaviour the existing
 * `endedIds` set exists for, and it is what opens the window under test.
 */
function installBridge(endFails = false): (payload: unknown) => void {
  const listeners = new Map<string, Cb[]>();
  (window as AnyWin).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "telephony_dial") return null;
      if (cmd === "real_dial") return "dialing via Android Telecom";
      if (cmd === "telephony_default_dialer_status") {
        return { role_supported: true, role_held: true, role_requestable: true };
      }
      if (cmd === "telephony_status") return [];
      if (cmd === "telephony_end" && endFails) {
        throw new Error("in-call service refused the hang-up");
      }
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

async function dialOurOwnCall(h: { container: HTMLElement }, emit: (p: unknown) => void) {
  for (const d of "13800000000") await fireEvent.click(key(h, d)!);
  await fireEvent.click(key(h, zh["phone.call"]) as HTMLButtonElement);
  await tick();
  await settle();
  emit({ id: "real", peer: "13800000000", state: "Active", direction: "Outgoing" });
  await tick();
  await settle();
}

describe("a hung-up platform call is not re-adopted", () => {
  test("hang up, leave before the Ended event lands, come back → bare keypad", async () => {
    const emit = installBridge();
    const shell = render(IncomingCall);
    await settle();
    const first = render(PhoneApp);
    await settle();
    await dialOurOwnCall(first, emit);
    expect(txt(first)).toContain(zh["phone.talking"]);

    // Hang up. The host accepts it; the stream has not said `Ended` yet (see the bridge).
    await fireEvent.click(key(first, zh["a11y.end"]) as HTMLButtonElement);
    await tick();
    await settle();
    expect(key(first, zh["a11y.end"])).toBeFalsy(); // the surface is gone
    expect(txt(first)).not.toContain(zh["phone.talking"]);

    // Leave the Phone app and come back — no `Ended` in between, and none ever.
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
   * The reverse control, on the same record: a **refused** hang-up ends nothing. The
   * surface stays (F-ALM-004), so the record must survive too — a fix that cleared it
   * unconditionally would redden this.
   */
  test("a refused hang-up keeps the call — the remount still adopts it", async () => {
    const emit = installBridge(true);
    const shell = render(IncomingCall);
    await settle();
    const first = render(PhoneApp);
    await settle();
    await dialOurOwnCall(first, emit);

    await fireEvent.click(key(first, zh["a11y.end"]) as HTMLButtonElement);
    await tick();
    await settle();
    // The call is still up: the surface (and its hang-up key) must still be there.
    expect(key(first, zh["a11y.end"])).toBeTruthy();

    first.unmount();
    await tick();
    const back = render(PhoneApp);
    await tick();
    await settle();
    expect(key(back, zh["a11y.end"])).toBeTruthy();
    expect(txt(back)).toContain(zh["phone.talking"]);
    shell.unmount();
  });

  /**
   * The second hang-up site. `IncomingCall.leave` backs 拒绝 / 挂断 for an incoming call —
   * including a **real** one, which the same record holds — and it too tears its surface
   * down on a successful end while the stream's `Ended` is still in flight.
   */
  test("hanging up an incoming real call in the overlay also forgets it", async () => {
    const emit = installBridge();
    const shell = render(IncomingCall);
    await settle();

    emit({ id: "real", peer: "13800000000", state: "Ringing", direction: "Incoming" });
    await tick();
    await settle();
    const answer = shell.container.querySelector(
      `button[aria-label="${zh["phone.answer"]}"]`,
    ) as HTMLButtonElement | null;
    expect(answer).toBeTruthy();
    await fireEvent.click(answer!);
    await tick();
    await settle();
    emit({ id: "real", peer: "13800000000", state: "Active", direction: "Incoming" });
    await tick();
    await settle();

    const end = shell.container.querySelector(
      `button[aria-label="${zh["phone.hangup"]}"]`,
    ) as HTMLButtonElement | null;
    expect(end).toBeTruthy();
    await fireEvent.click(end!);
    await tick();
    await settle();

    // The overlay is gone; now open the Phone app — it must not find a live call.
    const phone = render(PhoneApp);
    await tick();
    await settle();
    expect(key(phone, zh["a11y.end"])).toBeFalsy();
    shell.unmount();
  });
});
