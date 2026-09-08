import { describe, expect, test } from "bun:test";
import {
  CITY_CATALOG,
  normalizeCityQuery,
  resolveCity,
  searchCities,
} from "../lib/cityIndex";

describe("cityIndex — larger world-clock catalog + pure search", () => {
  test("catalog is sizable with unique IANA zones", () => {
    expect(CITY_CATALOG.length).toBeGreaterThan(40);
    const zones = new Set(CITY_CATALOG.map((c) => c.zone));
    expect(zones.size).toBe(CITY_CATALOG.length);
  });

  test("resolveCity finds an entry by zone", () => {
    expect(resolveCity("Asia/Tokyo")?.en).toBe("Tokyo");
    expect(resolveCity("Nope/Nowhere")).toBeUndefined();
  });

  test("zh search matches the localized name", () => {
    const ny = searchCities("纽约", "zh");
    expect(ny.map((c) => c.zone)).toContain("America/New_York");
  });

  test("en search is case-insensitive on the display name", () => {
    expect(searchCities("new", "en").map((c) => c.zone)).toContain("America/New_York");
    expect(searchCities("PARIS", "en").map((c) => c.zone)).toContain("Europe/Paris");
  });

  test("IANA zone is matchable regardless of locale", () => {
    expect(searchCities("Tokyo", "zh").map((c) => c.zone)).toContain("Asia/Tokyo");
  });

  test("exclude removes already-added zones; empty query returns all sorted", () => {
    const ex = new Set(["Europe/Paris"]);
    expect(searchCities("", "en", ex).map((c) => c.zone)).not.toContain("Europe/Paris");
    // Pass an explicit high limit so the whole (51-entry) catalog is returned.
    const all = searchCities("", "en", undefined, CITY_CATALOG.length + 1);
    expect(all.length).toBe(CITY_CATALOG.length);
    expect(all[0]!.en).toBe("Amsterdam"); // sorted A→… by en name
  });

  test("normalizeCityQuery trims + lowercases", () => {
    expect(normalizeCityQuery("  New York  ")).toBe("new york");
  });
});
