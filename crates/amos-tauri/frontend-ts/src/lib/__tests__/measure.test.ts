import { describe, it, expect } from "vitest";
import {
  normalizeMeasureSettings,
  normalizeMeasureHistory,
  defaultMeasureSettings,
  pixelDistance,
  estimateRealDistance,
  createMeasurement,
  formatDistance,
  parseDistance,
  calibrateReference,
  getReferenceObject,
  REFERENCE_OBJECTS,
  type MeasurePoint,
} from "../measure";

describe("measure", () => {
  describe("normalizeMeasureSettings", () => {
    it("returns defaults for invalid input", () => {
      expect(normalizeMeasureSettings(null)).toEqual(defaultMeasureSettings());
      expect(normalizeMeasureSettings(undefined)).toEqual(defaultMeasureSettings());
      expect(normalizeMeasureSettings("invalid")).toEqual(defaultMeasureSettings());
    });

    it("preserves valid settings", () => {
      const valid = { unit: "imperial" as const, referenceDistance: 600, showGuides: false };
      expect(normalizeMeasureSettings(valid)).toEqual(valid);
    });

    it("fills missing fields with defaults", () => {
      const partial = { unit: "metric" as const };
      const result = normalizeMeasureSettings(partial);
      expect(result.unit).toBe("metric");
      expect(result.referenceDistance).toBe(500);
      expect(result.showGuides).toBe(true);
    });

    it("rejects invalid field types", () => {
      const invalid = { unit: "unknown", referenceDistance: -100, showGuides: "yes" };
      const result = normalizeMeasureSettings(invalid);
      expect(result.unit).toBe("metric");
      expect(result.referenceDistance).toBe(500);
      expect(result.showGuides).toBe(true);
    });
  });

  describe("normalizeMeasureHistory", () => {
    it("returns empty array for invalid input", () => {
      expect(normalizeMeasureHistory(null)).toEqual([]);
      expect(normalizeMeasureHistory("invalid")).toEqual([]);
    });

    it("filters out invalid measurements", () => {
      const mixed = [
        { id: "m1", start: { x: 0.5, y: 0.5 }, end: { x: 0.8, y: 0.8 }, distance: 100, timestamp: 1000 },
        { id: "invalid", start: null, end: null },
        { start: { x: 0.2, y: 0.2 }, end: { x: 0.3, y: 0.3 } }, // missing id
      ];
      const result = normalizeMeasureHistory(mixed);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("m1");
    });

    it("keeps optional label field", () => {
      const withLabel = [
        {
          id: "m1",
          start: { x: 0.5, y: 0.5 },
          end: { x: 0.8, y: 0.8 },
          distance: 100,
          timestamp: 1000,
          label: "Test measurement",
        },
      ];
      const result = normalizeMeasureHistory(withLabel);
      expect(result[0].label).toBe("Test measurement");
    });

    it("limits to last 50 measurements", () => {
      const many = Array.from({ length: 100 }, (_, i) => ({
        id: `m${i}`,
        start: { x: 0.5, y: 0.5 },
        end: { x: 0.6, y: 0.6 },
        distance: 50,
        timestamp: i,
      }));
      const result = normalizeMeasureHistory(many);
      expect(result).toHaveLength(50);
    });
  });

  describe("pixelDistance", () => {
    it("calculates horizontal distance", () => {
      const p1: MeasurePoint = { x: 0.2, y: 0.5 };
      const p2: MeasurePoint = { x: 0.8, y: 0.5 };
      const dist = pixelDistance(p1, p2, 1000, 800);
      expect(dist).toBeCloseTo(600, 0); // 0.6 * 1000
    });

    it("calculates vertical distance", () => {
      const p1: MeasurePoint = { x: 0.5, y: 0.2 };
      const p2: MeasurePoint = { x: 0.5, y: 0.7 };
      const dist = pixelDistance(p1, p2, 1000, 800);
      expect(dist).toBeCloseTo(400, 0); // 0.5 * 800
    });

    it("calculates diagonal distance", () => {
      const p1: MeasurePoint = { x: 0.0, y: 0.0 };
      const p2: MeasurePoint = { x: 0.6, y: 0.8 };
      const dist = pixelDistance(p1, p2, 1000, 1000);
      expect(dist).toBeCloseTo(1000, 0); // 3-4-5 triangle scaled to 1000
    });

    it("returns zero for same point", () => {
      const p: MeasurePoint = { x: 0.5, y: 0.5 };
      expect(pixelDistance(p, p, 1000, 800)).toBe(0);
    });
  });

  describe("estimateRealDistance", () => {
    it("estimates distance proportional to pixel distance", () => {
      const refDist = 500; // mm
      const viewportWidth = 1000;
      
      // Half screen width
      const dist1 = estimateRealDistance(500, viewportWidth, refDist);
      expect(dist1).toBeGreaterThan(200);
      expect(dist1).toBeLessThan(400);
      
      // Full screen width
      const dist2 = estimateRealDistance(1000, viewportWidth, refDist);
      expect(dist2).toBeGreaterThan(400);
      expect(dist2).toBeLessThan(800);
    });

    it("scales with reference distance", () => {
      const viewportWidth = 1000;
      const pixelDist = 500;
      
      const dist1 = estimateRealDistance(pixelDist, viewportWidth, 300);
      const dist2 = estimateRealDistance(pixelDist, viewportWidth, 600);
      
      expect(dist2).toBeGreaterThan(dist1);
      expect(dist2 / dist1).toBeCloseTo(2, 0);
    });
  });

  describe("createMeasurement", () => {
    it("creates measurement with all fields", () => {
      const start: MeasurePoint = { x: 0.2, y: 0.3 };
      const end: MeasurePoint = { x: 0.8, y: 0.7 };
      
      const m = createMeasurement(start, end, 1000, 800, 500, "Test");
      
      expect(m.id).toMatch(/^m-\d+-[a-z0-9]+$/);
      expect(m.start).toEqual(start);
      expect(m.end).toEqual(end);
      expect(m.distance).toBeGreaterThan(0);
      expect(m.timestamp).toBeGreaterThan(0);
      expect(m.label).toBe("Test");
    });

    it("generates unique IDs", () => {
      const p1: MeasurePoint = { x: 0.5, y: 0.5 };
      const p2: MeasurePoint = { x: 0.6, y: 0.6 };
      
      const m1 = createMeasurement(p1, p2, 1000, 800, 500);
      const m2 = createMeasurement(p1, p2, 1000, 800, 500);
      
      expect(m1.id).not.toBe(m2.id);
    });
  });

  describe("formatDistance", () => {
    describe("metric", () => {
      it("formats small distances in mm", () => {
        expect(formatDistance(5.5, "metric")).toBe("5.5 mm");
        expect(formatDistance(25, "metric")).toBe("25 mm");
      });

      it("formats medium distances in cm or m", () => {
        expect(formatDistance(500, "metric")).toBe("50.0 cm");
        expect(formatDistance(1234, "metric")).toBe("1.23 m");
      });

      it("formats large distances in m", () => {
        expect(formatDistance(10000, "metric")).toBe("10.00 m");
        expect(formatDistance(5678, "metric")).toBe("5.68 m");
      });
    });

    describe("imperial", () => {
      it("formats inches", () => {
        expect(formatDistance(25.4, "imperial")).toBe('1.0"');
        expect(formatDistance(127, "imperial")).toBe('5.0"');
      });

      it("formats feet and inches", () => {
        expect(formatDistance(304.8, "imperial")).toBe("1'");
        expect(formatDistance(330.2, "imperial")).toBe(`1' 1.0"`);
      });

      it("omits small inches from feet", () => {
        expect(formatDistance(609.6, "imperial")).toBe("2'"); // Exactly 2 feet
      });
    });
  });

  describe("parseDistance", () => {
    describe("metric", () => {
      it("parses mm", () => {
        expect(parseDistance("50mm")).toBe(50);
        expect(parseDistance("50 mm")).toBe(50);
        expect(parseDistance("12.5 mm")).toBe(12.5);
      });

      it("parses cm", () => {
        expect(parseDistance("10cm")).toBe(100);
        expect(parseDistance("5.5 cm")).toBe(55);
      });

      it("parses m", () => {
        expect(parseDistance("1m")).toBe(1000);
        expect(parseDistance("2.5 m")).toBe(2500);
      });
    });

    describe("imperial", () => {
      it("parses inches", () => {
        expect(parseDistance("10in")).toBe(254);
        expect(parseDistance('12"')).toBeCloseTo(304.8, 1);
      });

      it("parses feet", () => {
        expect(parseDistance("1ft")).toBeCloseTo(304.8, 1);
        expect(parseDistance("2'")).toBeCloseTo(609.6, 1);
      });

      it("parses feet and inches", () => {
        expect(parseDistance("5' 6\"")).toBeCloseTo(1676.4, 1);
        expect(parseDistance("5ft 6in")).toBeCloseTo(1676.4, 1);
      });
    });

    it("returns null for invalid input", () => {
      expect(parseDistance("invalid")).toBeNull();
      expect(parseDistance("")).toBeNull();
    });
  });

  describe("calibrateReference", () => {
    it("calculates new reference distance", () => {
      const knownSize = 85.6; // Credit card width
      const measuredPixels = 200;
      const viewportWidth = 1000;
      const currentRef = 500;
      
      const newRef = calibrateReference(knownSize, measuredPixels, viewportWidth, currentRef);
      
      expect(newRef).toBeGreaterThan(100);
      expect(newRef).toBeLessThan(2000);
      expect(newRef).not.toBe(currentRef);
    });

    it("rejects unrealistic calibrations", () => {
      const knownSize = 85.6;
      const measuredPixels = 1; // Too small
      const viewportWidth = 1000;
      const currentRef = 500;
      
      const newRef = calibrateReference(knownSize, measuredPixels, viewportWidth, currentRef);
      
      expect(newRef).toBe(currentRef); // Keep current
    });

    it("handles large objects", () => {
      const knownSize = 297; // A4 paper height
      const measuredPixels = 600;
      const viewportWidth = 1000;
      const currentRef = 500;
      
      const newRef = calibrateReference(knownSize, measuredPixels, viewportWidth, currentRef);
      
      expect(newRef).toBeGreaterThan(100);
      expect(newRef).toBeLessThan(2000);
    });
  });

  describe("REFERENCE_OBJECTS", () => {
    it("provides standard reference objects", () => {
      expect(REFERENCE_OBJECTS.creditCard.size).toBe(85.6);
      expect(REFERENCE_OBJECTS.a4Paper.size).toBe(297);
      expect(REFERENCE_OBJECTS.usDollar.size).toBe(156);
      expect(REFERENCE_OBJECTS.usLetter.size).toBe(279.4);
    });

    it("all objects have required fields", () => {
      for (const obj of Object.values(REFERENCE_OBJECTS)) {
        expect(obj.name).toBeTruthy();
        expect(obj.size).toBeGreaterThan(0);
        expect(obj.unit).toBe("mm");
      }
    });
  });

  describe("getReferenceObject", () => {
    it("returns object by name", () => {
      const obj = getReferenceObject("creditCard");
      expect(obj).toEqual(REFERENCE_OBJECTS.creditCard);
    });

    it("returns null for unknown name", () => {
      expect(getReferenceObject("unknown")).toBeNull();
    });
  });
});
