import { describe, it, expect } from "vitest";
import {
  isCachedDeclinationValid,
  fetchDeclinationWithCache,
} from "../compass";

describe("compass caching", () => {
  describe("isCachedDeclinationValid", () => {
    it("returns false for undefined cache", () => {
      expect(isCachedDeclinationValid(undefined, 40.7128, -74.006)).toBe(false);
    });

    it("returns true for recent cache at same location", () => {
      const cache = {
        lat: 40.7128,
        lon: -74.006,
        timestamp: Date.now() - 60 * 60 * 1000, // 1 hour ago
      };
      expect(isCachedDeclinationValid(cache, 40.7128, -74.006)).toBe(true);
    });

    it("returns false for expired cache (> 7 days)", () => {
      const cache = {
        lat: 40.7128,
        lon: -74.006,
        timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
      };
      expect(isCachedDeclinationValid(cache, 40.7128, -74.006)).toBe(false);
    });

    it("returns false for location changed > 50km", () => {
      const cache = {
        lat: 40.7128, // New York
        lon: -74.006,
        timestamp: Date.now() - 60 * 60 * 1000,
      };
      // Philadelphia is ~130km away
      expect(isCachedDeclinationValid(cache, 39.9526, -75.1652)).toBe(false);
    });

    it("returns true for location changed < 50km", () => {
      const cache = {
        lat: 40.7128, // New York City
        lon: -74.006,
        timestamp: Date.now() - 60 * 60 * 1000,
      };
      // ~20km away (within NYC)
      expect(isCachedDeclinationValid(cache, 40.73, -73.99)).toBe(true);
    });

    it("returns false at exactly 7 days boundary", () => {
      const cache = {
        lat: 40.7128,
        lon: -74.006,
        timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000 - 1000, // 7 days + 1 second
      };
      expect(isCachedDeclinationValid(cache, 40.7128, -74.006)).toBe(false);
    });
  });

  describe("fetchDeclinationWithCache", () => {
    it("returns fromCache=true when cache is valid", async () => {
      const cache = {
        lat: 40.7128,
        lon: -74.006,
        timestamp: Date.now() - 60 * 60 * 1000,
      };
      const currentDeclination = -13.5;
      
      const result = await fetchDeclinationWithCache(40.7128, -74.006, currentDeclination, cache);
      
      expect(result.fromCache).toBe(true);
      expect(result.declination).toBe(currentDeclination);
      expect(result.cachedLocation).toEqual(cache);
    });

    it("returns fromCache=false when cache is invalid", async () => {
      const cache = {
        lat: 40.7128,
        lon: -74.006,
        timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000, // Expired
      };
      const currentDeclination = -13.5;
      
      const result = await fetchDeclinationWithCache(40.7128, -74.006, currentDeclination, cache);
      
      expect(result.fromCache).toBe(false);
      expect(result.cachedLocation.lat).toBe(40.7128);
      expect(result.cachedLocation.lon).toBe(-74.006);
      expect(result.cachedLocation.timestamp).toBeGreaterThan(cache.timestamp);
    });

    it("returns fromCache=false when no cache exists", async () => {
      const currentDeclination = -13.5;
      
      const result = await fetchDeclinationWithCache(40.7128, -74.006, currentDeclination, undefined);
      
      expect(result.fromCache).toBe(false);
      expect(result.cachedLocation).toBeDefined();
      expect(result.cachedLocation.lat).toBe(40.7128);
      expect(result.cachedLocation.lon).toBe(-74.006);
    });

    it("creates new cache with current timestamp", async () => {
      const currentDeclination = -13.5;
      const before = Date.now();
      
      const result = await fetchDeclinationWithCache(40.7128, -74.006, currentDeclination, undefined);
      const after = Date.now();
      
      expect(result.cachedLocation.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.cachedLocation.timestamp).toBeLessThanOrEqual(after);
    });
  });
});
