import { beforeEach, describe, expect, test } from "bun:test";
import { startOsTelephonyHold } from "../svelte/osTelephonyHold";
import { heldReasons, resetHoldBusForTest, screenHeld } from "../lib/keepAwakeCore";
import type { TelephonyCall } from "../lib/backend";

const call = (id: string, state: string): TelephonyCall => ({
  id,
  peer: "1",
  state,
  direction: "Incoming",
  emergency: false,
  recording: "Off",
});

/** A fake event source: captures the onEvent fn so the test can push calls. */
function fakeSource() {
  let handler: ((c: TelephonyCall) => void) | null = null;
  const subscribe = (onEvent: (c: TelephonyCall) => void): (() => void) => {
    handler = onEvent;
    return () => {
      handler = null;
    };
  };
  return { subscribe, emit: (c: TelephonyCall) => handler?.(c) };
}

describe("osTelephonyHold — calls keep the screen on", () => {
  beforeEach(() => resetHoldBusForTest());

  test("a ringing call asserts the 'call' hold; ending it releases", () => {
    const src = fakeSource();
    const stop = startOsTelephonyHold(src.subscribe);
    expect(screenHeld()).toBe(false);
    src.emit(call("A", "Ringing"));
    expect(heldReasons()).toEqual(["call"]);
    src.emit(call("A", "Ended"));
    expect(screenHeld()).toBe(false);
    stop();
  });

  test("overlapping calls each need their own End", () => {
    const src = fakeSource();
    const stop = startOsTelephonyHold(src.subscribe);
    src.emit(call("A", "Active"));
    src.emit(call("B", "Dialing"));
    src.emit(call("A", "Ended"));
    expect(heldReasons()).toEqual(["call"]); // B still holds
    src.emit(call("B", "Ended"));
    expect(screenHeld()).toBe(false);
    stop();
  });

  test("non-holding states (Held/idle) never assert the hold", () => {
    const src = fakeSource();
    const stop = startOsTelephonyHold(src.subscribe);
    src.emit(call("A", "Held"));
    src.emit(call("A", "Idle"));
    expect(screenHeld()).toBe(false);
    stop();
  });

  test("stop releases the hold and unsubscribes (no lingering pin)", () => {
    const src = fakeSource();
    const stop = startOsTelephonyHold(src.subscribe);
    src.emit(call("A", "Ringing"));
    expect(screenHeld()).toBe(true);
    stop();
    expect(screenHeld()).toBe(false);
    // After stop the source no longer forwards (handler cleared by unsubscribe).
    src.emit(call("A", "Ringing"));
    expect(screenHeld()).toBe(false);
  });
});
