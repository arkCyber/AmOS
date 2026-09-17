/**
 * Tests for hotCorners.ts — pure functions (no DOM dependencies).
 */
import { describe, test, expect } from "vitest";
import {
  isInHotZone,
  modifierMatches,
  normalizeHotCorners,
  DEFAULT_HOT_CORNERS,
  type HotCornerConfig,
} from "../hotCorners";

describe("hotCorners.ts", () => {
  describe("isInHotZone", () => {
    const W = 1920;
    const H = 1080;

    test("top-left corner (within zone)", () => {
      expect(isInHotZone(5, 5, W, H, "top-left")).toBe(true);
      expect(isInHotZone(0, 0, W, H, "top-left")).toBe(true);
      expect(isInHotZone(15, 15, W, H, "top-left")).toBe(true);
    });

    test("top-left corner (outside zone)", () => {
      expect(isInHotZone(16, 5, W, H, "top-left")).toBe(false);
      expect(isInHotZone(5, 16, W, H, "top-left")).toBe(false);
      expect(isInHotZone(100, 100, W, H, "top-left")).toBe(false);
    });

    test("top-right corner", () => {
      expect(isInHotZone(1915, 5, W, H, "top-right")).toBe(true);
      expect(isInHotZone(1920, 0, W, H, "top-right")).toBe(true);
      expect(isInHotZone(1905, 5, W, H, "top-right")).toBe(true);
      expect(isInHotZone(1904, 5, W, H, "top-right")).toBe(false);
    });

    test("bottom-left corner", () => {
      expect(isInHotZone(5, 1075, W, H, "bottom-left")).toBe(true);
      expect(isInHotZone(0, 1080, W, H, "bottom-left")).toBe(true);
      expect(isInHotZone(15, 1065, W, H, "bottom-left")).toBe(true);
      expect(isInHotZone(5, 1064, W, H, "bottom-left")).toBe(false);
    });

    test("bottom-right corner", () => {
      expect(isInHotZone(1915, 1075, W, H, "bottom-right")).toBe(true);
      expect(isInHotZone(1920, 1080, W, H, "bottom-right")).toBe(true);
      expect(isInHotZone(1905, 1065, W, H, "bottom-right")).toBe(true);
      expect(isInHotZone(1904, 1075, W, H, "bottom-right")).toBe(false);
      expect(isInHotZone(1915, 1064, W, H, "bottom-right")).toBe(false);
    });

    test("custom zone size", () => {
      expect(isInHotZone(25, 25, W, H, "top-left", 30)).toBe(true);
      expect(isInHotZone(25, 25, W, H, "top-left", 20)).toBe(false);
    });
  });

  describe("modifierMatches", () => {
    test("no modifier required", () => {
      const e = new MouseEvent("mousemove");
      expect(modifierMatches(e, undefined)).toBe(true);
    });

    test("shift required and pressed", () => {
      const e = new MouseEvent("mousemove", { shiftKey: true });
      expect(modifierMatches(e, "shift")).toBe(true);
    });

    test("shift required but not pressed", () => {
      const e = new MouseEvent("mousemove");
      expect(modifierMatches(e, "shift")).toBe(false);
    });

    test("control required", () => {
      const e1 = new MouseEvent("mousemove", { ctrlKey: true });
      expect(modifierMatches(e1, "control")).toBe(true);
      const e2 = new MouseEvent("mousemove", { shiftKey: true });
      expect(modifierMatches(e2, "control")).toBe(false);
    });

    test("alt required", () => {
      const e1 = new MouseEvent("mousemove", { altKey: true });
      expect(modifierMatches(e1, "alt")).toBe(true);
      const e2 = new MouseEvent("mousemove");
      expect(modifierMatches(e2, "alt")).toBe(false);
    });

    test("meta required", () => {
      const e1 = new MouseEvent("mousemove", { metaKey: true });
      expect(modifierMatches(e1, "meta")).toBe(true);
      const e2 = new MouseEvent("mousemove");
      expect(modifierMatches(e2, "meta")).toBe(false);
    });
  });

  describe("normalizeHotCorners", () => {
    test("valid configuration passes through", () => {
      const input: HotCornerConfig[] = [
        { corner: "top-left", action: "mission-control", delay: 500 },
        { corner: "top-right", action: "launchpad", delay: 300 },
        { corner: "bottom-left", action: "disabled", delay: 0 },
        { corner: "bottom-right", action: "lock-screen", modifier: "shift", delay: 1000 },
      ];
      const result = normalizeHotCorners(input);
      expect(result).toHaveLength(4);
      expect(result[0]).toEqual(input[0]);
      expect(result[3].modifier).toBe("shift");
    });

    test("malformed input returns defaults", () => {
      expect(normalizeHotCorners(null)).toEqual(DEFAULT_HOT_CORNERS);
      expect(normalizeHotCorners(undefined)).toEqual(DEFAULT_HOT_CORNERS);
      expect(normalizeHotCorners("invalid")).toEqual(DEFAULT_HOT_CORNERS);
      expect(normalizeHotCorners(42)).toEqual(DEFAULT_HOT_CORNERS);
    });

    test("partial config back-fills missing corners", () => {
      const input = [{ corner: "top-left", action: "launchpad", delay: 500 }];
      const result = normalizeHotCorners(input);
      expect(result).toHaveLength(4);
      expect(result.find((c) => c.corner === "top-left")?.action).toBe("launchpad");
      expect(result.find((c) => c.corner === "top-right")).toBeDefined();
      expect(result.find((c) => c.corner === "bottom-left")).toBeDefined();
      expect(result.find((c) => c.corner === "bottom-right")).toBeDefined();
    });

    test("duplicate corners are rejected", () => {
      const input = [
        { corner: "top-left", action: "launchpad", delay: 500 },
        { corner: "top-left", action: "mission-control", delay: 300 }, // duplicate
      ];
      const result = normalizeHotCorners(input);
      const topLeft = result.filter((c) => c.corner === "top-left");
      expect(topLeft).toHaveLength(1);
      expect(topLeft[0].action).toBe("launchpad"); // first wins
    });

    test("invalid action is rejected", () => {
      const input = [{ corner: "top-left", action: "invalid-action", delay: 500 }];
      const result = normalizeHotCorners(input);
      const topLeft = result.find((c) => c.corner === "top-left");
      expect(topLeft?.action).toBe("mission-control"); // falls back to default
    });

    test("invalid delay defaults to 500", () => {
      const input = [
        { corner: "top-left", action: "launchpad", delay: -100 },
        { corner: "top-right", action: "launchpad", delay: NaN },
        { corner: "bottom-left", action: "launchpad", delay: "invalid" },
      ];
      const result = normalizeHotCorners(input);
      expect(result.find((c) => c.corner === "top-left")?.delay).toBe(500);
      expect(result.find((c) => c.corner === "top-right")?.delay).toBe(500);
      expect(result.find((c) => c.corner === "bottom-left")?.delay).toBe(500);
    });

    test("invalid modifier is rejected", () => {
      const input = [{ corner: "top-left", action: "launchpad", modifier: "invalid", delay: 500 }];
      const result = normalizeHotCorners(input);
      // Entry with invalid modifier should be skipped entirely
      const topLeft = result.find((c) => c.corner === "top-left");
      expect(topLeft?.action).toBe("mission-control"); // falls back to default
    });
  });
});
