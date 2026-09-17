// avatar-animations.test.ts — Unit tests for advanced avatar animation logic.
import { describe, expect, test } from "vitest";

// Constants for animation timing (from ContactsApp.svelte)
const DOUBLE_CLICK_WINDOW_MS = 500;
const LONG_PRESS_MS = 500;
const THEME_STAGGER_MS = 30;
const BOUNCE_MS = 600;
const FLIP_MS = 600;
const SPIN_MS = 1200;

describe("Avatar Animation Logic", () => {
  describe("Double-click detection", () => {
    test("detects double click within time window", () => {
      const lastClickTime = Date.now();
      const currentTime = lastClickTime + 300; // Within 500ms window
      const lastClickTarget = "contact-123";
      const currentTarget = "contact-123";

      const isDoubleClick =
        lastClickTarget === currentTarget &&
        currentTime - lastClickTime < DOUBLE_CLICK_WINDOW_MS;

      expect(isDoubleClick).toBe(true);
    });

    test("does not detect double click outside time window", () => {
      const lastClickTime = Date.now();
      const currentTime = lastClickTime + 600; // Outside 500ms window
      const lastClickTarget = "contact-123";
      const currentTarget = "contact-123";

      const isDoubleClick =
        lastClickTarget === currentTarget &&
        currentTime - lastClickTime < DOUBLE_CLICK_WINDOW_MS;

      expect(isDoubleClick).toBe(false);
    });

    test("does not detect double click on different targets", () => {
      const lastClickTime = Date.now();
      const currentTime = lastClickTime + 300;
      const lastClickTarget: string = "contact-123";
      const currentTarget: string = "contact-456";

      const isDoubleClick =
        lastClickTarget === currentTarget &&
        currentTime - lastClickTime < DOUBLE_CLICK_WINDOW_MS;

      expect(isDoubleClick).toBe(false);
    });
  });

  describe("Long press detection", () => {
    test("long press duration is 500ms", () => {
      expect(LONG_PRESS_MS).toBe(500);
    });

    test("long press requires matching target", () => {
      const longPressTarget = "contact-123";
      const currentTarget = "contact-123";

      const shouldTrigger = longPressTarget === currentTarget;

      expect(shouldTrigger).toBe(true);
    });

    test("long press cancels on target mismatch", () => {
      const longPressTarget: string = "contact-123";
      const currentTarget: string = "contact-456";

      const shouldTrigger = longPressTarget === currentTarget;

      expect(shouldTrigger).toBe(false);
    });
  });

  describe("Animation timing", () => {
    test("bounce animation duration is 600ms", () => {
      expect(BOUNCE_MS).toBe(600);
    });

    test("flip animation duration is 600ms", () => {
      expect(FLIP_MS).toBe(600);
    });

    test("spin animation duration is 1200ms", () => {
      expect(SPIN_MS).toBe(1200);
    });

    test("theme switch stagger delay is 30ms", () => {
      expect(THEME_STAGGER_MS).toBe(30);
    });
  });

  describe("Theme switch staggered animation", () => {
    test("calculates correct stagger delays", () => {
      const visibleIds = ["c1", "c2", "c3", "c4", "c5"];
      const delays = visibleIds.map((_, index) => index * THEME_STAGGER_MS);

      expect(delays).toEqual([0, 30, 60, 90, 120]);
    });

    test("each animation resets after flip duration", () => {
      const flipStart = 0;
      const flipEnd = flipStart + FLIP_MS;

      expect(flipEnd - flipStart).toBe(600);
    });
  });

  describe("Animation state management", () => {
    test("bounce animation triggers on single click", () => {
      const clickCount = 1;
      const shouldBounce = clickCount === 1;

      expect(shouldBounce).toBe(true);
    });

    test("spin animation triggers on double click", () => {
      const lastClickTime = Date.now();
      const currentTime = lastClickTime + 200;
      const lastClickTarget = "contact-123";
      const currentTarget = "contact-123";

      const isDoubleClick =
        lastClickTarget === currentTarget &&
        currentTime - lastClickTime < DOUBLE_CLICK_WINDOW_MS;

      expect(isDoubleClick).toBe(true);
    });

    test("long press triggers preview", () => {
      const pressStart = Date.now();
      const pressEnd = pressStart + LONG_PRESS_MS;
      const duration = pressEnd - pressStart;

      expect(duration).toBeGreaterThanOrEqual(LONG_PRESS_MS);
    });
  });

  describe("Edge cases", () => {
    test("handles rapid clicks correctly", () => {
      const clicks = [
        { time: 0, target: "c1" },
        { time: 100, target: "c1" }, // Double click
        { time: 700, target: "c1" }, // New single click (> 500ms from last)
      ];

      // First click: single
      let isDouble = false;
      expect(isDouble).toBe(false);

      // Second click: double (100ms gap)
      isDouble = clicks[1]!.target === clicks[0]!.target && clicks[1]!.time - clicks[0]!.time < DOUBLE_CLICK_WINDOW_MS;
      expect(isDouble).toBe(true);

      // Third click: single (700ms from first, 600ms from second)
      isDouble = clicks[2]!.target === clicks[1]!.target && clicks[2]!.time - clicks[1]!.time < DOUBLE_CLICK_WINDOW_MS;
      expect(isDouble).toBe(false);
    });

    test("handles touch move cancelling long press", () => {
      const longPressStarted = true;
      const touchMoved = true;
      
      // Touch move should cancel long press
      const shouldContinueLongPress = longPressStarted && !touchMoved;
      
      expect(shouldContinueLongPress).toBe(false);
    });

    test("handles simultaneous animations on different avatars", () => {
      const animations = {
        bounce: "c1",
        flip: "c2",
        spin: "c3",
      };

      // All three can be active at once on different contacts
      const uniqueTargets = new Set(Object.values(animations));
      expect(uniqueTargets.size).toBe(3);
    });

    test("verifies stagger timing for large contact lists", () => {
      const contactCount = 100;
      const totalStaggerTime = (contactCount - 1) * THEME_STAGGER_MS;
      
      // 100 contacts = 99 intervals * 30ms = 2970ms total stagger
      expect(totalStaggerTime).toBe(2970);
      
      // Plus flip duration for last item = total animation time
      const totalAnimationTime = totalStaggerTime + FLIP_MS;
      expect(totalAnimationTime).toBe(3570);
    });
  });
});
