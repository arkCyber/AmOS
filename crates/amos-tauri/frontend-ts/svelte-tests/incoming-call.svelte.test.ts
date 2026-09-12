/**
 * incoming-call.svelte.test.ts — Svelte incoming-call island (offline via a fake
 * Tauri telephony bridge). The state machine: Ringing→Answer/Decline; answering
 * →talking (mute/record/hangup); Ended persists the incoming call to the shared
 * call log then hides. No call ⇒ nothing renders (offline parity with React).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import IncomingCall from "../src/svelte/IncomingCall.svelte";
import { readStoreValue } from "../src/lib/amosStore";
import {
  CALLLOG_KEY,
  resetPendingCallsForTest,
  pendingCallCount,
} from "../src/lib/calllog";
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
  resetPendingCallsForTest(); // the pending queue is module state, shared inside this file
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

  test("blank/hidden caller id shows the localized unknown label", async () => {
    const emit = installBridge();
    const { container } = render(IncomingCall);
    await settle();

    emit({ id: "c3", direction: "Incoming", state: "Ringing", peer: "" });
    await tick();
    await settle();
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    // headline falls back to the localized "unknown" text, no number sub-row
    expect((dialog?.textContent ?? "")).toContain(zh["phone.unknown"]);
  });

  /**
   * REQ-A150 — this is the one write in the app with no screen left to report a failure
   * (the overlay is closing), which is why it used to be allow-listed as a *residual gap*:
   * a rejected append cost that history row silently. Now it is queued in memory for the
   * Phone screen's history to flush, and that screen admits it while it is still pending.
   */
  test("a rejected call-log write keeps the row pending instead of losing it", async () => {
    const emit = installBridge();
    const { container } = render(IncomingCall);
    await settle();

    emit({ id: "c9", direction: "Incoming", state: "Ringing", peer: "13900000000" });
    await tick();
    await settle();

    // Exactly this key now rejects (a full/unavailable store), everything else works.
    const original = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, "setItem").mockImplementation((k: string, v: string) => {
      if (k === CALLLOG_KEY) throw new Error("QuotaExceededError");
      original(k, v);
    });

    emit({ id: "c9", direction: "Incoming", state: "Ended", peer: "13900000000" });
    await tick();
    await settle();

    expect(container.querySelector('[role="dialog"]')).toBeNull(); // the call still closed
    expect(readStoreValue<unknown[]>(CALLLOG_KEY, [])).toEqual([]); // nothing landed…
    expect(pendingCallCount()).toBe(1); // …but nothing was lost
  });
});
