/**
 * incoming-call.svelte.test.ts — Svelte incoming-call island (offline via a fake
 * Tauri telephony bridge). The state machine: Ringing→Answer/Decline; answering
 * →talking (mute/record/hangup); Ended persists the incoming call to the shared
 * call log then hides. No call ⇒ nothing renders (offline parity with React).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import IncomingCall from "../src/svelte/IncomingCall.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import { CALLLOG_KEY } from "../src/lib/calllog";
import { zh } from "../src/i18n/locales/zh";

type AnyWin = Record<string, unknown>;
const TELEPHONY_EVENT = "telephony-event";

const cleanBridge = () =>
  delete (window as AnyWin).__TAURI_INTERNALS__;

function installBridge(): (payload: unknown) => void {
  const listeners = new Map<string, (e: { payload: unknown }) => void>();
  (window as AnyWin).__TAURI_INTERNALS__ = {
    invoke: async () => null,
    listen: async (channel: string, cb: (e: { payload: unknown }) => void) => {
      listeners.set(channel, cb);
      return () => {
        listeners.delete(channel);
      };
    },
  };
  return (payload) =>
    listeners.get(TELEPHONY_EVENT)?.({ payload: payload as unknown });
}

beforeEach(() => {
  window.localStorage.clear();
  cleanBridge();
});
afterEach(() => cleanBridge());

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("IncomingCall.svelte (fake telephony bridge)", () => {
  test("renders nothing with no call", async () => {
    installBridge();
    const { container } = render(IncomingCall);
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test("Ringing shows Answer/Decline; answering enters talking; Ended logs + hides", async () => {
    const emit = installBridge();
    const { container } = render(IncomingCall);
    await settle();

    emit({ id: "c1", direction: "Incoming", state: "Ringing", peer: "13800000000" });
    await tick();
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    const answer = container.querySelector(
      `button[aria-label="${zh["phone.answer"]}"]`,
    ) as HTMLButtonElement | null;
    expect(answer).toBeTruthy();

    await fireEvent.click(answer!); // → talking
    await tick();
    expect(container.querySelector(`button[aria-label="${zh["phone.hangup"]}"]`)).toBeTruthy();

    emit({ id: "c1", direction: "Incoming", state: "Ended", peer: "13800000000" });
    await tick();
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const log = readStoreValue<unknown[]>(CALLLOG_KEY, []);
    expect(log.length).toBeGreaterThan(0); // finished incoming call logged
  });

  test("Decline hides and does not enter talking", async () => {
    const emit = installBridge();
    const { container } = render(IncomingCall);
    await settle();

    emit({ id: "c2", direction: "Incoming", state: "Ringing", peer: "13900000000" });
    await tick();
    await settle();
    const decline = container.querySelector(
      `button[aria-label="${zh["phone.decline"]}"]`,
    ) as HTMLButtonElement | null;
    expect(decline).toBeTruthy();
    await fireEvent.click(decline!);
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
