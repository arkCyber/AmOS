/**
 * phone-outgoing.svelte.test.ts — Svelte OUTGOING happy path (offline via a fake
 * telephony bridge). Complementary to phone.svelte.test.ts (which covers dial
 * WITHOUT a daemon → localized error) and to the pure lib mirror useOutgoingCalls.
 * Here the daemon answers telephony_dial with a call id, so we verify the real
 * component wiring: Dial → in-call UI + outgoing call-log entry → Active ⇒
 * "talking" (ringback/connected) → Ended ⇒ reset back to the keypad.
 */
import { afterEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import PhoneApp from "../src/svelte/PhoneApp.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { CALLLOG_KEY } from "../src/lib/calllog";
import { TELEPHONY_EVENT } from "../src/lib/backend";
import { zh } from "../src/i18n/locales/zh";

type AnyWin = Record<string, unknown>;
type Cb = (e: { payload: unknown }) => void;

const cleanBridge = () => delete (window as AnyWin).__TAURI_INTERNALS__;

/** Bridge: telephony_dial succeeds with a fixed call id; end/others no-op. */
function installBridge(): (payload: unknown) => void {
  const listeners = new Map<string, Cb>();
  (window as AnyWin).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) =>
      cmd === "telephony_dial" ? { id: "out-1", state: "Dialing" } : null,
    listen: async (channel: string, cb: Cb) => {
      listeners.set(channel, cb);
      return () => {
        listeners.delete(channel);
      };
    },
  };
  return (payload) => listeners.get(TELEPHONY_EVENT)?.({ payload: payload as unknown });
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const txt = (h: { container: HTMLElement }) => h.container.textContent ?? "";
const key = (h: { container: HTMLElement }, aria: string) =>
  h.container.querySelector(`button[aria-label="${aria}"]`) as HTMLButtonElement | null;

afterEach(cleanBridge);

describe("PhoneApp.svelte outgoing (fake telephony bridge)", () => {
  test("dial → in-call UI + log entry; Active ⇒ talking; Ended ⇒ reset", async () => {
    const emit = installBridge();
    const host = render(PhoneApp);
    await settle();

    // key in a number and press call
    for (const d of "13800000000") await fireEvent.click(key(host, d)!);
    const callBtn = key(host, "call");
    expect(callBtn).toBeTruthy();
    await fireEvent.click(callBtn as HTMLButtonElement);
    await tick();
    await settle();

    // daemon accepted → in-call UI with a hang-up control, number visible
    expect(key(host, "end")).toBeTruthy();
    expect(txt(host)).toContain("13800000000");

    // outgoing call was written to the shared log at dial time
    const log = readStoreValue<unknown[]>(CALLLOG_KEY, []);
    expect(log.length).toBeGreaterThan(0);

    // connected → "talking" state shows the duration/timer UI
    emit({ id: "out-1", peer: "13800000000", state: "Active", direction: "Outgoing" });
    await tick();
    await settle();
    expect(txt(host)).toContain(zh["phone.talking"]);
    expect(host.container.querySelector('[aria-label="call duration"]')).toBeTruthy();

    // hang-up / remote end → back to the idle keypad, no phantom call
    emit({ id: "out-1", peer: "13800000000", state: "Ended", direction: "Outgoing" });
    await tick();
    await settle();
    expect(key(host, "end")).toBeFalsy();
    expect(txt(host)).not.toContain(zh["phone.talking"]);
    // the outgoing log entry survives the reset
    expect(readStoreValue<unknown[]>(CALLLOG_KEY, []).length).toBeGreaterThan(0);
  });
});
