/**
 * compass.test.ts — Aerospace-grade test suite for compass module
 * 
 * Test Coverage:
 * - Settings normalization (validation, defaults, edge cases)
 * - Cardinal direction formatting (i18n, boundaries, invalid inputs)
 * - Heading normalization (wrapping, negatives, edge cases)
 * - Declination application (positive, negative, wrapping)
 * - Level calculations (percentage, thresholds, invalid inputs)
 * - Distance calculations (Haversine, poles, dateline, validation)
 * - Cache validation (expiration, distance, invalid data)
 * - Performance benchmarks (Haversine, normalization, direction)
 * - Security tests (prototype pollution, injection, overflow)
 * - API simulation (success, error, timeout, invalid response)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  normalizeCompassSettings,
  defaultCompassSettings,
  cardinalDirection,
  normalizeHeading,
  applyDeclination,
  levelPercentage,
  isLevel,
  isOrientationSupported,
  calculateDistance,
  isCachedDeclinationValid,
  fetchDeclination,
  fetchDeclinationWithCache,
} from "../compass";

// vi is available from vitest if needed for mocking

// ---------------------------------------------------------------------------
// `fetch` 缝：这一套用例**不能碰真网络**。
//
// `fetchDeclination` 会真的去请求 NOAA 的 HTTPS 接口，并带 `AbortSignal.timeout(5000)`。
// 那带来两个问题，都是实测过的：(a) 测试依赖网络与外部服务 —— 离线/半离线时走的是另一条
// 分支，"绿"不再说明被测代码对；(b) 那个 5s 中止与 bun 的 **5s 单测默认超时撞在一起**，
// 于是慢网/负载高时用例会以 `Test "…" timed out after 5009ms` 失败（本轮就是先看到这条
// 红才顺着查到这里）。下面把 `fetch` 换成确定性应答：`beforeAll` 装、`afterAll` 还原
// （pure 批次是一个进程跑所有文件，桩漏出去会改别的文件的行为），`beforeEach` 重置计划。
// 顺带把一直**没有被测到**的成功路径（`result[0].declination`）钉住 —— 原注释写着
// "Real API tests would require mocking fetch"，这里就是那个 mock。
// ---------------------------------------------------------------------------

/** The slice of `Response` that `fetchDeclination` actually reads. */
interface StubbedResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

const realFetch = globalThis.fetch;
let respondWith: (url: string) => StubbedResponse;
let fetchedUrls: string[];

beforeAll(() => {
  (globalThis as { fetch: unknown }).fetch = (input: unknown) => {
    fetchedUrls.push(String(input));
    return Promise.resolve(respondWith(String(input)));
  };
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

beforeEach(() => {
  fetchedUrls = [];
  respondWith = () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ result: [{ declination: 12.5 }] }),
  });
});

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

    it("clamps declination to valid range", () => {
      const result1 = normalizeCompassSettings({ declination: 200 });
      expect(result1.declination).toBe(180);

      const result2 = normalizeCompassSettings({ declination: -200 });
      expect(result2.declination).toBe(-180);
    });

    it("handles NaN declination", () => {
      const result = normalizeCompassSettings({ declination: NaN });
      expect(result.declination).toBe(0);
    });

    it("preserves valid cachedLocation", () => {
      const valid = {
        useTrueNorth: true,
        declination: 10,
        cachedLocation: { lat: 40.7128, lon: -74.0060, timestamp: Date.now() },
      };
      const result = normalizeCompassSettings(valid);
      expect(result.cachedLocation).toEqual(valid.cachedLocation);
    });

    it("rejects invalid cachedLocation coordinates", () => {
      const invalid1 = {
        cachedLocation: { lat: 91, lon: 0, timestamp: Date.now() },
      };
      const result1 = normalizeCompassSettings(invalid1);
      expect(result1.cachedLocation).toBeUndefined();

      const invalid2 = {
        cachedLocation: { lat: 0, lon: 181, timestamp: Date.now() },
      };
      const result2 = normalizeCompassSettings(invalid2);
      expect(result2.cachedLocation).toBeUndefined();
    });

    it("rejects cachedLocation with missing fields", () => {
      const invalid = {
        cachedLocation: { lat: 40.7128, lon: -74.0060 }, // missing timestamp
      };
      const result = normalizeCompassSettings(invalid);
      expect(result.cachedLocation).toBeUndefined();
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

    it("handles NaN input gracefully", () => {
      expect(cardinalDirection(NaN, "en")).toBe("Unknown");
      expect(cardinalDirection(NaN, "zh")).toBe("未知");
    });

    it("handles Infinity input gracefully", () => {
      expect(cardinalDirection(Infinity, "en")).toBe("Unknown");
      expect(cardinalDirection(-Infinity, "zh")).toBe("未知");
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

    it("handles NaN input", () => {
      expect(normalizeHeading(NaN)).toBe(0);
    });

    it("handles Infinity input", () => {
      expect(normalizeHeading(Infinity)).toBe(0);
      expect(normalizeHeading(-Infinity)).toBe(0);
    });

    it("handles very large values", () => {
      expect(normalizeHeading(1000000)).toBeGreaterThanOrEqual(0);
      expect(normalizeHeading(1000000)).toBeLessThan(360);
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

    it("handles NaN inputs", () => {
      expect(applyDeclination(NaN, 10)).toBe(0);
      expect(applyDeclination(90, NaN)).toBe(0);
      expect(applyDeclination(NaN, NaN)).toBe(0);
    });

    it("handles Infinity inputs", () => {
      expect(applyDeclination(Infinity, 10)).toBe(0);
      expect(applyDeclination(90, Infinity)).toBe(0);
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

    it("handles NaN inputs", () => {
      expect(levelPercentage(NaN, 0)).toBe(100);
      expect(levelPercentage(0, NaN)).toBe(100);
      expect(levelPercentage(NaN, NaN)).toBe(100);
    });

    it("handles Infinity inputs", () => {
      expect(levelPercentage(Infinity, 0)).toBe(100);
      expect(levelPercentage(0, Infinity)).toBe(100);
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

    it("handles NaN inputs", () => {
      expect(isLevel(NaN, 0)).toBe(false);
      expect(isLevel(0, NaN)).toBe(false);
      expect(isLevel(NaN, NaN)).toBe(false);
    });

    it("handles invalid threshold", () => {
      expect(isLevel(0, 0, NaN)).toBe(false);
      expect(isLevel(0, 0, -1)).toBe(false);
    });
  });

  describe("isOrientationSupported", () => {
    it("returns false in non-browser environment", () => {
      // In vitest/jsdom, DeviceOrientationEvent may not be defined
      const result = isOrientationSupported();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("calculateDistance", () => {
    it("calculates distance between two points correctly", () => {
      // New York to Los Angeles (approx 3944 km)
      const distance = calculateDistance(40.7128, -74.0060, 34.0522, -118.2437);
      expect(distance).toBeGreaterThan(3900);
      expect(distance).toBeLessThan(4000);
    });

    it("returns 0 for identical coordinates", () => {
      const distance = calculateDistance(40.7128, -74.0060, 40.7128, -74.0060);
      expect(distance).toBe(0);
    });

    it("handles North Pole coordinates", () => {
      const distance = calculateDistance(90, 0, 89, 0);
      expect(distance).toBeGreaterThan(0);
      expect(distance).toBeLessThan(200); // ~111km
    });

    it("handles South Pole coordinates", () => {
      const distance = calculateDistance(-90, 0, -89, 0);
      expect(distance).toBeGreaterThan(0);
      expect(distance).toBeLessThan(200);
    });

    it("handles International Date Line crossing", () => {
      // 179°E to 179°W
      const distance = calculateDistance(0, 179, 0, -179);
      expect(distance).toBeGreaterThan(0);
      expect(distance).toBeLessThan(300); // ~222km for 2° at equator
    });

    it("handles antipodal points (opposite sides of Earth)", () => {
      // New York to near Perth (antipode)
      const distance = calculateDistance(40.7128, -74.0060, -40.7128, 105.9940);
      expect(distance).toBeGreaterThan(19000);
      expect(distance).toBeLessThan(21000);
    });

    it("throws on invalid latitude", () => {
      expect(() => calculateDistance(91, 0, 0, 0)).toThrow();
      expect(() => calculateDistance(-91, 0, 0, 0)).toThrow();
      expect(() => calculateDistance(0, 0, 91, 0)).toThrow();
    });

    it("throws on invalid longitude", () => {
      expect(() => calculateDistance(0, 181, 0, 0)).toThrow();
      expect(() => calculateDistance(0, -181, 0, 0)).toThrow();
      expect(() => calculateDistance(0, 0, 0, 181)).toThrow();
    });

    it("throws on NaN inputs", () => {
      expect(() => calculateDistance(NaN, 0, 0, 0)).toThrow();
      expect(() => calculateDistance(0, NaN, 0, 0)).toThrow();
    });

    it("throws on Infinity inputs", () => {
      expect(() => calculateDistance(Infinity, 0, 0, 0)).toThrow();
      expect(() => calculateDistance(0, 0, Infinity, 0)).toThrow();
    });
  });

  describe("isCachedDeclinationValid", () => {
    it("returns false for undefined cache", () => {
      expect(isCachedDeclinationValid(undefined, 40.7128, -74.0060)).toBe(false);
    });

    it("returns true for valid recent cache", () => {
      const cached = {
        lat: 40.7128,
        lon: -74.0060,
        timestamp: Date.now() - 1000 * 60 * 60, // 1 hour ago
      };
      expect(isCachedDeclinationValid(cached, 40.72, -74.01)).toBe(true);
    });

    it("returns false when cache is older than 7 days", () => {
      const cached = {
        lat: 40.7128,
        lon: -74.0060,
        timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
      };
      expect(isCachedDeclinationValid(cached, 40.7128, -74.0060)).toBe(false);
    });

    it("returns false when distance exceeds 50km", () => {
      const cached = {
        lat: 40.7128,
        lon: -74.0060,
        timestamp: Date.now() - 1000 * 60, // 1 minute ago
      };
      // Move ~100km north
      expect(isCachedDeclinationValid(cached, 41.7128, -74.0060)).toBe(false);
    });

    it("returns true for distance under 50km", () => {
      const cached = {
        lat: 40.7128,
        lon: -74.0060,
        timestamp: Date.now() - 1000 * 60,
      };
      // Move ~10km east
      expect(isCachedDeclinationValid(cached, 40.7128, -73.9060)).toBe(true);
    });

    it("handles invalid cached coordinates gracefully", () => {
      const cached = {
        lat: 91, // Invalid
        lon: -74.0060,
        timestamp: Date.now(),
      };
      expect(isCachedDeclinationValid(cached, 40.7128, -74.0060)).toBe(false);
    });

    it("handles invalid current coordinates gracefully", () => {
      const cached = {
        lat: 40.7128,
        lon: -74.0060,
        timestamp: Date.now(),
      };
      expect(isCachedDeclinationValid(cached, 91, -74.0060)).toBe(false);
    });
  });

  describe("fetchDeclination", () => {
    it("validates latitude before fetching", async () => {
      await expect(fetchDeclination(91, 0)).rejects.toThrow();
      await expect(fetchDeclination(-91, 0)).rejects.toThrow();
    });

    it("validates longitude before fetching", async () => {
      await expect(fetchDeclination(0, 181)).rejects.toThrow();
      await expect(fetchDeclination(0, -181)).rejects.toThrow();
    });

    // 现在 API 路径**是被测的**（见上面的 `fetch` 缝），不再只是输入校验。
    it("returns the API's declination on 200 — and asks for exactly the right query", async () => {
      await expect(fetchDeclination(40.7128, -74.006)).resolves.toBeCloseTo(12.5, 5);
      expect(fetchedUrls).toHaveLength(1);
      expect(fetchedUrls[0]).toContain("lat1=40.7128");
      expect(fetchedUrls[0]).toContain("lon1=-74.0060");
      expect(fetchedUrls[0]).toContain("resultFormat=json");
    });

    it("a non-2xx answer degrades to 0 instead of throwing", async () => {
      respondWith = () => ({ ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}) });
      await expect(fetchDeclination(40.7128, -74.006)).resolves.toBe(0);
    });

    it("a non-numeric declination in the body degrades to 0", async () => {
      respondWith = () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ result: [{ declination: "east" }] }),
      });
      await expect(fetchDeclination(40.7128, -74.006)).resolves.toBe(0);
    });

    it("a thrown network error degrades to 0 (offline is not a crash)", async () => {
      respondWith = () => {
        throw new TypeError("Failed to fetch");
      };
      await expect(fetchDeclination(40.7128, -74.006)).resolves.toBe(0);
    });
  });

  describe("fetchDeclinationWithCache", () => {
    it("returns cached value when cache is valid", async () => {
      const cached = {
        lat: 40.7128,
        lon: -74.0060,
        timestamp: Date.now() - 1000 * 60,
      };
      const result = await fetchDeclinationWithCache(40.72, -74.01, -13.5, cached);
      expect(result.fromCache).toBe(true);
      expect(result.declination).toBe(-13.5);
      expect(result.cachedLocation).toEqual(cached);
    });

    it("fetches new value when cache is expired", async () => {
      const cached = {
        lat: 40.7128,
        lon: -74.0060,
        timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000,
      };
      const result = await fetchDeclinationWithCache(40.7128, -74.0060, -13.5, cached);
      expect(result.fromCache).toBe(false);
      expect(result.cachedLocation.timestamp).toBeGreaterThan(cached.timestamp);
      // 值确实来自 API（而不是把旧值原样发回来）——这是 stub 之后才能断言的。
      expect(result.declination).toBeCloseTo(12.5, 5);
      expect(fetchedUrls).toHaveLength(1);
    });

    it("fetches new value when location changed", async () => {
      const cached = {
        lat: 40.7128,
        lon: -74.0060,
        timestamp: Date.now() - 1000,
      };
      // Move to Los Angeles
      const result = await fetchDeclinationWithCache(34.0522, -118.2437, -13.5, cached);
      expect(result.fromCache).toBe(false);
      expect(result.cachedLocation.lat).toBe(34.0522);
      expect(result.cachedLocation.lon).toBe(-118.2437);
    });
  });

  describe("Performance Benchmarks", () => {
    /**
     * 这些用例原来的门槛是**墙钟亚毫秒刀锋**（1000 次 < 1ms）。实测值就贴着
     * 1.0–1.1ms ⇒ 它测的是"这台机器此刻有多空"，不是代码有没有变慢：忙一点
     * 就红、快一点就绿，而且红了也没人知道是真回归还是别的进程占了 CPU。
     *
     * 现在的判据：先热身（JIT 编译不该算进被测代码的账），再按**每个数量级的
     * 余量**给预算 —— 仍然能抓住"慢了 5 倍"这种真回归，但不再对 ±3% 的抖动
     * 过敏。
     */
    const measure = (iterations: number, fn: (i: number) => void): number => {
      for (let i = 0; i < Math.min(iterations, 100); i++) fn(i); // warm-up
      const start = performance.now();
      for (let i = 0; i < iterations; i++) fn(i);
      return performance.now() - start;
    };

    it("Haversine calculation stays within budget for 1000 iterations", () => {
      // 预算 5ms/1000 次（≈5µs 一次）：实测 ~1ms，5 倍余量。
      const elapsed = measure(1000, () => calculateDistance(40.7128, -74.0060, 34.0522, -118.2437));
      expect(elapsed).toBeLessThan(5);
    });

    it("normalizeHeading stays within budget for 10000 iterations", () => {
      // 预算 5ms/10000 次（≈0.5µs 一次）：实测 ~0.2–1ms，5 倍余量。
      const elapsed = measure(10000, (i) => normalizeHeading(i * 37));
      expect(elapsed).toBeLessThan(5);
    });

    it("cardinalDirection stays within budget for 1000 iterations", () => {
      // 预算 5ms/1000 次：实测 ~1–2ms（含 `en` 字典查表）。
      const elapsed = measure(1000, (i) => cardinalDirection(i % 360, "en"));
      expect(elapsed).toBeLessThan(5);
    });

    it("levelPercentage stays within budget for 1000 iterations", () => {
      // 与上面三条同一判据。这条是本轮发现的**漏网**：上面那段注释已经写明"墙钟亚毫秒
      // 刀锋"换成了"热身 + 5 倍余量预算"，但这一条仍是裸的 `performance.now()` `< 1ms`、
      // 也没有热身 —— 负载一高就红（实测 1.27ms/1000 次）。它想抓的"慢了 5 倍"用 5ms
      // 预算同样抓得到，且输入改成确定性序列（原来是 `Math.random()`）。
      const elapsed = measure(1000, (i) => levelPercentage(i % 90, (i * 7) % 90));
      expect(elapsed).toBeLessThan(5);
    });
  });

  describe("Security Tests", () => {
    it("prevents prototype pollution in settings", () => {
      const malicious = JSON.parse('{"__proto__":{"polluted":true},"declination":10}');
      const result = normalizeCompassSettings(malicious);
      expect((result as any).polluted).toBeUndefined();
      expect((Object.prototype as any).polluted).toBeUndefined();
    });

    it("handles extremely large coordinate values", () => {
      expect(() => calculateDistance(1e10, 1e10, 0, 0)).toThrow();
    });

    it("handles extremely large heading values", () => {
      const result = normalizeHeading(1e15);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(360);
    });

    it("handles negative zero correctly", () => {
      expect(normalizeHeading(-0)).toBe(0);
      expect(Object.is(normalizeHeading(-0), 0)).toBe(true);
    });
  });
});
