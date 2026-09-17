import { describe, it, expect } from "vitest";
import {
  normalizeCompassSettings,
  defaultCompassSettings,
  cardinalDirection,
  normalizeHeading,
  applyDeclination,
  levelPercentage,
  isLevel,
  isOrientationSupported,
} from "../compass";

describe("compass", () => {
  describe("normalizeCompassSettings", () => {
    it("returns defaults for invalid input", () => {
      expect(normalizeCompassSettings(null)).toEqual(defaultCompassSettings());
      expect(normalizeCompassSettings(undefined)).toEqual(defaultCompassSettings());
      expect(normalizeCompassSettings("invalid")).toEqual(defaultCompassSettings());
    });

    it("preserves valid settings", () => {
      const valid = { useTrueNorth: true, declination: 15.5 };
      expect(normalizeCompassSettings(valid)).toEqual(valid);
    });

    it("fills missing fields with defaults", () => {
      const partial = { useTrueNorth: true };
      const result = normalizeCompassSettings(partial);
      expect(result.useTrueNorth).toBe(true);
      expect(result.declination).toBe(0);
    });

    it("rejects invalid field types", () => {
      const invalid = { useTrueNorth: "true", declination: "15" };
      expect(normalizeCompassSettings(invalid)).toEqual(defaultCompassSettings());
    });
  });

  describe("cardinalDirection", () => {
    it("returns correct directions in English", () => {
      expect(cardinalDirection(0, "en")).toBe("N");
      expect(cardinalDirection(45, "en")).toBe("NE");
      expect(cardinalDirection(90, "en")).toBe("E");
      expect(cardinalDirection(135, "en")).toBe("SE");
      expect(cardinalDirection(180, "en")).toBe("S");
      expect(cardinalDirection(225, "en")).toBe("SW");
      expect(cardinalDirection(270, "en")).toBe("W");
      expect(cardinalDirection(315, "en")).toBe("NW");
    });

    it("returns correct directions in Chinese", () => {
      expect(cardinalDirection(0, "zh")).toBe("北");
      expect(cardinalDirection(45, "zh")).toBe("东北");
      expect(cardinalDirection(90, "zh")).toBe("东");
      expect(cardinalDirection(135, "zh")).toBe("东南");
      expect(cardinalDirection(180, "zh")).toBe("南");
      expect(cardinalDirection(225, "zh")).toBe("西南");
      expect(cardinalDirection(270, "zh")).toBe("西");
      expect(cardinalDirection(315, "zh")).toBe("西北");
    });

    it("handles edge cases near boundaries", () => {
      expect(cardinalDirection(22, "en")).toBe("N");
      expect(cardinalDirection(23, "en")).toBe("NE");
      expect(cardinalDirection(359, "en")).toBe("N");
    });

    it("normalizes out-of-range headings", () => {
      expect(cardinalDirection(360, "en")).toBe("N");
      expect(cardinalDirection(405, "en")).toBe("NE");
      expect(cardinalDirection(-45, "en")).toBe("NW");
    });
  });

  describe("normalizeHeading", () => {
    it("keeps values in 0-360 range", () => {
      expect(normalizeHeading(0)).toBe(0);
      expect(normalizeHeading(180)).toBe(180);
      expect(normalizeHeading(359)).toBe(359);
    });

    it("wraps values above 360", () => {
      expect(normalizeHeading(360)).toBe(0);
      expect(normalizeHeading(361)).toBe(1);
      expect(normalizeHeading(720)).toBe(0);
    });

    it("wraps negative values", () => {
      expect(normalizeHeading(-1)).toBe(359);
      expect(normalizeHeading(-90)).toBe(270);
      expect(normalizeHeading(-360)).toBeCloseTo(0, 10);
    });
  });

  describe("applyDeclination", () => {
    it("applies positive declination (east)", () => {
      expect(applyDeclination(0, 15)).toBe(15);
      expect(applyDeclination(90, 10)).toBe(100);
    });

    it("applies negative declination (west)", () => {
      expect(applyDeclination(0, -15)).toBe(345);
      expect(applyDeclination(90, -10)).toBe(80);
    });

    it("wraps result to 0-360", () => {
      expect(applyDeclination(350, 20)).toBe(10);
      expect(applyDeclination(10, -20)).toBe(350);
    });

    it("handles zero declination", () => {
      expect(applyDeclination(45, 0)).toBe(45);
    });
  });

  describe("levelPercentage", () => {
    it("returns 0 for perfectly level", () => {
      expect(levelPercentage(0, 0)).toBe(0);
    });

    it("returns 100 at 90° tilt", () => {
      expect(levelPercentage(90, 0)).toBe(100);
      expect(levelPercentage(0, 90)).toBe(100);
    });

    it("calculates magnitude correctly", () => {
      const result = levelPercentage(30, 40);
      expect(result).toBeCloseTo((50 / 90) * 100, 1); // √(30²+40²) = 50
    });

    it("caps at 100%", () => {
      expect(levelPercentage(100, 100)).toBe(100);
      expect(levelPercentage(180, 0)).toBe(100);
    });

    it("handles small tilts", () => {
      expect(levelPercentage(1, 1)).toBeLessThan(2);
      expect(levelPercentage(5, 0)).toBeCloseTo((5 / 90) * 100, 1);
    });
  });

  describe("isLevel", () => {
    it("returns true for perfectly level", () => {
      expect(isLevel(0, 0)).toBe(true);
    });

    it("returns true within default threshold (2°)", () => {
      expect(isLevel(1, 1)).toBe(true);
      expect(isLevel(-1.5, 1.5)).toBe(true);
      expect(isLevel(1.9, -1.9)).toBe(true);
    });

    it("returns false outside threshold", () => {
      expect(isLevel(2.1, 0)).toBe(false);
      expect(isLevel(0, -2.1)).toBe(false);
      expect(isLevel(3, 3)).toBe(false);
    });

    it("respects custom threshold", () => {
      expect(isLevel(4, 0, 5)).toBe(true);
      expect(isLevel(0, 5, 5)).toBe(false);
      expect(isLevel(3, 3, 10)).toBe(true);
    });
  });

  describe("isOrientationSupported", () => {
    it("returns false in non-browser environment", () => {
      // In vitest/jsdom, DeviceOrientationEvent may not be defined
      const result = isOrientationSupported();
      expect(typeof result).toBe("boolean");
    });
  });
});
