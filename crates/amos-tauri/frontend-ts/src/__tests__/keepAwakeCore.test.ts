import { describe, expect, test } from "bun:test";
import {
  assertHold,
  clearAllHolds,
  heldReasons,
  onHoldChange,
  releaseHold,
  resetHoldBusForTest,
  screenHeld,
  videoHoldActive,
} from "../lib/keepAwakeCore";

describe("keep-awake reason bus", () => {
  test("starts clear; assert makes it held", () => {
    resetHoldBusForTest();
    expect(screenHeld()).toBe(false);
    assertHold("call");
    expect(screenHeld()).toBe(true);
    expect(heldReasons()).toEqual(["call"]);
    clearAllHolds();
  });

  test("heldReasons are sorted and unique", () => {
    resetHoldBusForTest();
    assertHold("nav");
    assertHold("call");
    assertHold("call"); // idempotent
    expect(heldReasons()).toEqual(["call", "nav"]);
    clearAllHolds();
  });

  test("release makes it not held; releasing an inactive reason is a no-op", () => {
    resetHoldBusForTest();
    assertHold("call");
    releaseHold("call");
    expect(screenHeld()).toBe(false);
    releaseHold("call"); // no-op, no crash
    clearAllHolds();
  });

  test("onHoldChange notifies on assert/release and unsubscribe stops it", () => {
    resetHoldBusForTest();
    let count = 0;
    const off = onHoldChange(() => (count += 1));
    assertHold("call");
    releaseHold("call");
    expect(count).toBe(2);
    off();
    assertHold("nav");
    expect(count).toBe(2); // unsubscribed → not notified
    clearAllHolds();
    resetHoldBusForTest();
  });

  test("videoHoldActive: playing video holds, music/paused/unknown does not", () => {
    expect(videoHoldActive(true, "video")).toBe(true);
    // Music must never hold the screen (a music player should let it sleep).
    expect(videoHoldActive(true, "audio")).toBe(false);
    // Paused video does not hold.
    expect(videoHoldActive(false, "video")).toBe(false);
    // No active track / unknown kind is honest "no hold".
    expect(videoHoldActive(true, null)).toBe(false);
    expect(videoHoldActive(true, undefined)).toBe(false);
  });
});
