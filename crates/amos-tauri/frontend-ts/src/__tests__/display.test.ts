import { describe, expect, it } from "bun:test";
import {
  asScreenState,
  autoOffDue,
  clampAutoOffSec,
  dueForAutoSleep,
  idleElapsedSec,
  isOn,
  AUTOOFF_STORE_KEY,
} from "../lib/display";

describe("display screen-state helpers", () => {
  it("isOn / asScreenState round-trip the canonical on/off", () => {
    expect(isOn("on")).toBe(true);
    expect(isOn("off")).toBe(false);
    expect(asScreenState("off")).toBe("off");
    expect(asScreenState("on")).toBe("on");
    // Unknown values degrade conservatively to "on" (never claim it's off).
    expect(asScreenState(undefined)).toBe("on");
    expect(asScreenState("")).toBe("on");
  });

  it("clamps the idle timeout and treats <=0 as disabled", () => {
    expect(clampAutoOffSec(0)).toBe(0);
    expect(clampAutoOffSec(-5)).toBe(0);
    expect(clampAutoOffSec(Number.NaN)).toBe(0);
    expect(clampAutoOffSec(undefined)).toBe(0);
    expect(clampAutoOffSec(10)).toBe(10);
    expect(clampAutoOffSec(10.9)).toBe(10);
    expect(clampAutoOffSec("15")).toBe(15);
    // Large values are capped at 6h.
    expect(clampAutoOffSec(10_000_000)).toBe(6 * 60 * 60);
  });

  it("idleElapsedSec never goes negative under clock skew", () => {
    expect(idleElapsedSec(100, 120)).toBe(20);
    expect(idleElapsedSec(120, 100)).toBe(0);
  });

  it("autoOffDue fires only when enabled and the timeout has elapsed", () => {
    // Disabled never fires.
    expect(autoOffDue(0, 10_000, 0)).toBe(false);
    // Not yet idle.
    expect(autoOffDue(0, 9, 10)).toBe(false);
    // Exactly at the timeout.
    expect(autoOffDue(0, 10, 10)).toBe(true);
    // Activity resets the window.
    expect(autoOffDue(50, 59, 10)).toBe(false);
    expect(autoOffDue(50, 60, 10)).toBe(true);
  });

  it("exports the durable auto-off store key", () => {
    expect(AUTOOFF_STORE_KEY).toBe("amos.displayAutoOffSec");
  });
});

describe("dueForAutoSleep (live shell auto-off)", () => {
  it("is due only when idle elapses and no call holds the screen", () => {
    // Disabled / not yet idle → not due.
    expect(dueForAutoSleep(0, 999, 0, false)).toBe(false);
    expect(dueForAutoSleep(0, 9, 10, false)).toBe(false);
    // Idle elapses → due.
    expect(dueForAutoSleep(0, 10, 10, false)).toBe(true);
  });

  it("an active call holds the screen no matter how long idle", () => {
    expect(dueForAutoSleep(0, 10, 10, true)).toBe(false);
    expect(dueForAutoSleep(0, 60_000, 1, true)).toBe(false);
  });

  it("releases the hold when the call ends", () => {
    expect(dueForAutoSleep(0, 10, 10, false)).toBe(true);
  });
});
