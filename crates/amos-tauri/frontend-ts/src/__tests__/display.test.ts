import { describe, expect, it } from "bun:test";
import {
  autoOffDue,
  clampAutoOffSec,
  idleElapsedSec,
  AUTOOFF_STORE_KEY,
  WAKE_HOME_KEY,
  WAKE_HOME_MIN_MS,
  makeWakeHomeGate,
  wakeHomeDue,
  wakeHomeEnabled,
} from "../lib/display";

describe("wakeHomeDue (real-wake decision)", () => {
  const now = 1_000_000;
  it("never counts as a wake if it wasn't away", () => {
    expect(wakeHomeDue(null, now)).toBe(false);
    expect(wakeHomeDue(undefined, now)).toBe(false);
  });
  it("ignores brief absences shorter than the minimum", () => {
    expect(wakeHomeDue(now - 300, now)).toBe(false);
    expect(wakeHomeDue(now - (WAKE_HOME_MIN_MS - 1), now)).toBe(false);
  });
  it("counts a wake once the absence reaches the minimum", () => {
    expect(wakeHomeDue(now - WAKE_HOME_MIN_MS, now)).toBe(true);
    expect(wakeHomeDue(now - 60_000, now)).toBe(true);
  });
  it("honors a custom minimum", () => {
    expect(wakeHomeDue(now - 500, now, 1000)).toBe(false);
    expect(wakeHomeDue(now - 1500, now, 1000)).toBe(true);
  });
});

describe("wakeHomeEnabled (wake → dock policy)", () => {
  it("defaults ON for absent/unknown values", () => {
    expect(wakeHomeEnabled(undefined)).toBe(true);
    expect(wakeHomeEnabled(null)).toBe(true);
    expect(wakeHomeEnabled("")).toBe(true);
    expect(wakeHomeEnabled({})).toBe(true);
  });
  it("true-like values → on, false-like → off", () => {
    expect(wakeHomeEnabled(true)).toBe(true);
    expect(wakeHomeEnabled(1)).toBe(true);
    expect(wakeHomeEnabled("true")).toBe(true);
    expect(wakeHomeEnabled("1")).toBe(true);
    expect(wakeHomeEnabled(false)).toBe(false);
    expect(wakeHomeEnabled(0)).toBe(false);
    expect(wakeHomeEnabled("false")).toBe(false);
    expect(wakeHomeEnabled("0")).toBe(false);
  });
  it("exposes the durable store key", () => {
    expect(WAKE_HOME_KEY).toBe("amos.wakeHome");
  });
});

describe("makeWakeHomeGate (live wake → dock gate)", () => {
  function gateAt(now: { t: number }) {
    let fired = 0;
    const gate = makeWakeHomeGate({
      enabled: () => true,
      now: () => now.t,
      wakeHome: () => (fired += 1),
    });
    return { gate, fired: () => fired };
  }

  it("does not fire a return without a preceding leave", () => {
    const now = { t: 1000 };
    const { gate, fired } = gateAt(now);
    gate.onReturn();
    expect(fired()).toBe(0);
  });

  it("fires home after an absence long enough to be a real wake", () => {
    const now = { t: 1000 };
    const { gate, fired } = gateAt(now);
    gate.onLeave();
    now.t = 1000 + WAKE_HOME_MIN_MS;
    gate.onReturn();
    expect(fired()).toBe(1);
  });

  it("ignores a brief absence (notification peek / focus steal)", () => {
    const now = { t: 1000 };
    const { gate, fired } = gateAt(now);
    gate.onLeave();
    now.t = 1000 + (WAKE_HOME_MIN_MS - 1);
    gate.onReturn();
    expect(fired()).toBe(0);
  });

  it("fires at most once per leave (double return is a no-op)", () => {
    const now = { t: 1000 };
    const { gate, fired } = gateAt(now);
    gate.onLeave();
    now.t = 5000;
    gate.onReturn();
    gate.onReturn(); // e.g. both visibilitychange and focus fire
    expect(fired()).toBe(1);
  });

  it("respects the live preference: disabled never fires, even after a long absence", () => {
    let enabled = false;
    let fired = 0;
    let t = 1000;
    const gate = makeWakeHomeGate({
      enabled: () => enabled,
      now: () => t,
      wakeHome: () => (fired += 1),
    });
    gate.onLeave();
    t = 5000;
    gate.onReturn(); // disabled → no fire despite the long absence
    expect(fired).toBe(0);
    // Toggling on then doing leave/return fires.
    enabled = true;
    gate.onLeave();
    t = 9000;
    gate.onReturn();
    expect(fired).toBe(1);
  });
});

describe("display screen-state helpers", () => {
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
