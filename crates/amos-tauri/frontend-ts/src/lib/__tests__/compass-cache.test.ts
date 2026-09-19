import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  isCachedDeclinationValid,
  fetchDeclinationWithCache,
} from "../compass";

// ---------------------------------------------------------------------------
// `fetch` 缝：**这个文件曾经真的去打 NOAA 的 HTTPS 接口**。
//
// `fetchDeclinationWithCache` 在缓存失效/缺失时调用 `fetchDeclination`，后者 `fetch` 的是
// `https://www.ngdc.noaa.gov/…` 并带 `AbortSignal.timeout(5000)`。实测的后果是这条用例
// 在负载下**超时失败**：`Test "returns fromCache=false when no cache exists" timed out
// after 5009ms` —— 因为那个 5s 中止与 bun 的 5s 单测默认超时是同一个量级，慢网时谁也
// 不会先完成。测试不该依赖网络与外部服务：这里把应答换成确定性的（`beforeAll` 装 /
// `afterAll` 还原，pure 批次是一个进程跑所有文件，桩漏出去会改别的文件的行为）。
// ---------------------------------------------------------------------------

interface StubbedResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

const realFetch = globalThis.fetch;
let respondWith: (url: string) => StubbedResponse;

beforeAll(() => {
  (globalThis as { fetch: unknown }).fetch = (input: unknown) =>
    Promise.resolve(respondWith(String(input)));
});
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});
beforeEach(() => {
  respondWith = () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ result: [{ declination: 12.5 }] }),
  });
});

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
      // 走到 API 时取的是**API 的值**，不是传进来的旧值（离线时这条会退化到 0）。
      expect(result.declination).toBeCloseTo(12.5, 5);
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
