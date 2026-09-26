/**
 * trackpad.test.ts — the pure reading of the desktop trackpad gesture layer (REQ-A1586).
 *
 * The rule under test is a *classifier*, so every case has to defend against the two ways a
 * classifier goes wrong: saying "swipe" when it is not (a mouse wheel, a pinch, a vertical
 * scroll — each pinned with a negative control) and saying "swipe" more than once per gesture
 * (momentum would switch Spaces three times per flick). The idle gap is fed a synthetic clock
 * so the rule is tested without waiting on real time.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyWheel,
  GESTURE_IDLE_MS,
  SWIPE_THRESHOLD_PX,
  TrackpadSwipeTracker,
  type WheelSample,
} from "../lib/trackpad";

const px = (deltaX: number, deltaY = 0, ctrlKey = false): WheelSample => ({
  deltaX,
  deltaY,
  deltaMode: 0,
  ctrlKey,
});

describe("classifyWheel", () => {
  test("a horizontal pixel-mode sample is a swipe", () => {
    expect(classifyWheel(px(40))).toBe("swipe");
    expect(classifyWheel(px(-40))).toBe("swipe");
  });

  test("a vertical sample is not a swipe (the scroll we must not eat)", () => {
    // Negative control: remove the `|deltaX| <= |deltaY|` guard and this fails.
    expect(classifyWheel(px(0, 40))).toBe("other");
    expect(classifyWheel(px(10, 40))).toBe("other");
    expect(classifyWheel(px(40, 40))).toBe("other");
  });

  test("a line/page-mode wheel is a mouse, never a swipe", () => {
    // Negative control: drop the `deltaMode !== 0` guard and a notch mouse wheel (line mode,
    // horizontal tilt) would navigate the desktop.
    expect(classifyWheel({ deltaX: 40, deltaY: 0, deltaMode: 1, ctrlKey: false })).toBe("other");
    expect(classifyWheel({ deltaX: 40, deltaY: 0, deltaMode: 2, ctrlKey: false })).toBe("other");
  });

  test("a pinch (browser-synthesized ctrlKey) is its own class, never a swipe", () => {
    // A pinch can carry horizontal travel; `ctrlKey` wins before the axis check.
    expect(classifyWheel(px(40, 0, true))).toBe("pinch");
    expect(classifyWheel(px(0, 0, true))).toBe("pinch");
  });
});

describe("TrackpadSwipeTracker", () => {
  test("stays silent until the accumulated travel reaches the threshold", () => {
    const t = new TrackpadSwipeTracker();
    let now = 1000;
    // A few sub-threshold samples must not fire (else a stray nudge navigates).
    for (let i = 0; i < 3; i++) {
      expect(t.push(px(10), now)).toBeNull();
      now += 16;
    }
  });

  test("fires once when the travel crosses the threshold, in the direction of the fingers", () => {
    const t = new TrackpadSwipeTracker();
    let now = 1000;
    let step: ReturnType<TrackpadSwipeTracker["push"]> = null;
    let firedAt = 0;
    for (let x = 0; x < SWIPE_THRESHOLD_PX + 60; x += 40) {
      step = t.push(px(40), now);
      if (step !== null) {
        firedAt = now;
        break;
      }
      now += 16;
    }
    // Content follows the fingers: swiping right (deltaX > 0) is "previous", like ⌃←.
    expect(step).toBe("prev");
    expect(firedAt).toBeGreaterThan(1000);

    // Momentum after lift-off keeps delivering samples; the latch must swallow all of them.
    for (let i = 0; i < 5; i++) {
      expect(t.push(px(80, 0), now + 16 * (i + 1))).toBeNull();
    }
  });

  test("swiping left asks for the next Space", () => {
    const t = new TrackpadSwipeTracker();
    let now = 1000;
    let step: ReturnType<TrackpadSwipeTracker["push"]> = null;
    for (let i = 0; i < 10 && step === null; i++) {
      step = t.push(px(-40), now);
      now += 16;
    }
    expect(step).toBe("next");
  });

  test("the latch clears after the idle gap, so a second flick switches again", () => {
    const t = new TrackpadSwipeTracker();
    // First gesture: 40px samples at 16ms until it fires.
    let now = 1000;
    let first: ReturnType<TrackpadSwipeTracker["push"]> = null;
    for (let i = 0; i < 12 && first === null; i++) {
      first = t.push(px(40), now);
      now += 16;
    }
    expect(first).toBe("prev");
    const lastSample = now - 16;

    // Within the same gesture (100ms after the last sample): still latched.
    expect(t.push(px(40), lastSample + 100)).toBeNull();

    // Past the idle gap measured from that last sample: a fresh gesture fires again.
    now = lastSample + 100 + GESTURE_IDLE_MS + 1;
    let second: ReturnType<TrackpadSwipeTracker["push"]> = null;
    for (let i = 0; i < 12 && second === null; i++) {
      second = t.push(px(40), now);
      now += 16;
    }
    expect(second).toBe("prev");
  });

  test("a vertical scroll between samples ends the in-flight gesture", () => {
    const t = new TrackpadSwipeTracker();
    let now = 1000;
    expect(t.push(px(40), now)).toBeNull();
    now += 16;
    // A vertical scroll is "other": the half-finished swipe is abandoned, not extended.
    expect(t.push(px(40, 200), now)).toBeNull();
    now += 16;
    // The same 40px that would have fired on top of the old sum must now be sub-threshold.
    expect(t.push(px(40), now)).toBeNull();
  });

  test("a direction reversal restarts the sum instead of cancelling it", () => {
    const t = new TrackpadSwipeTracker();
    let now = 1000;
    // 80px right, then back left — a net zero, and neither half reaches the threshold.
    expect(t.push(px(80), now)).toBeNull();
    now += 16;
    expect(t.push(px(-80), now)).toBeNull();
    now += 16;
    expect(t.push(px(-30), now)).toBeNull();
  });

  test("a pinch never fires, and it clears any half-finished swipe", () => {
    const t = new TrackpadSwipeTracker();
    let now = 1000;
    expect(t.push(px(80), now)).toBeNull();
    now += 16;
    expect(t.push(px(80, 0, true), now)).toBeNull();
    now += 16;
    expect(t.push(px(80), now)).toBeNull();
  });
});
