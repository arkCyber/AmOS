import { describe, expect, test } from "bun:test";
import { forecast, dayLabel, intlTag, cToF, displayTemp, convertRange, adjustForecast, shiftRange, WEATHER_CITIES, defaultWeatherCities, normalizeWeatherCities, removeWeatherCity, addWeatherCity } from "../lib/weather";

describe("weather", () => {
  test("provides a deterministic 5-day forecast starting today", () => {
    const days = forecast();
    expect(days.length).toBe(5);
    expect(days[0]!.daysFromNow).toBe(0);
    days.forEach((d, i) => expect(d.daysFromNow).toBe(i));
  });

  test("intlTag maps locales and dayLabel yields a weekday string", () => {
    expect(intlTag("zh")).toBe("zh-CN");
    expect(intlTag("en")).toBe("en-US");
    const base = new Date(2024, 0, 1); // a Monday
    expect(dayLabel("en", base, 0).length).toBeGreaterThan(0);
    expect(dayLabel("zh", base, 1).length).toBeGreaterThan(0);
  });

  test("temperature helpers convert between C and F deterministically", () => {
    expect(cToF(0)).toBe(32);
    expect(cToF(26)).toBe(79); // 26*9/5+32 = 78.8 → 79
    expect(displayTemp(26, "c")).toBe("26°");
    expect(displayTemp(26, "f")).toBe("79°F");
    // range strings convert both bounds in F, and pass through in C
    expect(convertRange("22°–30°", "c")).toBe("22°–30°");
    expect(convertRange("22°–30°", "f")).toBe("72°F–86°F"); // 22→72, 30→86
  });

  test("multi-city offsets shift temps and ranges, and zero-offset copies", () => {
    const base = forecast();
    const london = adjustForecast(base, -7);
    expect(london[0]!.temp).toBe(base[0]!.temp - 7);
    expect(london[0]!.range).toBe("15°–23°"); // "22°–30°" − 7
    // range is independent of the day list
    expect(shiftRange("22°–30°", 5)).toBe("27°–35°");
    expect(shiftRange("0°–5°", -2)).toBe("-2°–3°"); // negatives handled
    // zero offset returns a copy with identical values
    const beijing = adjustForecast(base, 0);
    expect(beijing).toEqual(base);
    expect(beijing).not.toBe(base);
    expect(WEATHER_CITIES[0]!.offset).toBe(0); // default city = base forecast
  });

  test("editable city subset: default 4, add (dedupe/cap), remove, sanitize garbage", () => {
    const def = defaultWeatherCities();
    expect(def.map((c) => c.id)).toEqual(["beijing", "tokyo", "london", "newyork"]);
    const paris = WEATHER_CITIES.find((c) => c.id === "paris")!;
    const five = addWeatherCity(def, paris);
    expect(five.length).toBe(5);
    expect(five[4]!.id).toBe("paris");
    expect(addWeatherCity(five, paris)).toBe(five); // dup -> no-op
    const sydney = WEATHER_CITIES.find((c) => c.id === "sydney")!;
    const six = addWeatherCity(five, sydney);
    expect(six.length).toBe(6); // capped
    // remove
    expect(removeWeatherCity(six, "tokyo").map((c) => c.id)).not.toContain("tokyo");
    // sanitize persisted garbage: unknown ids / non-strings dropped, de-duped
    expect(normalizeWeatherCities([{ id: "mars" }, 3, null, { id: "tokyo" }, { id: "tokyo" }])).toEqual([
      { id: "tokyo", offset: -2 },
    ]);
    expect(normalizeWeatherCities("nope")).toEqual(def);
    expect(normalizeWeatherCities([])).toEqual(def);
  });

  test("forecast carries bounded humidity and a wind level every day", () => {
    for (const d of forecast()) {
      expect(Number.isInteger(d.humidity)).toBe(true);
      expect(d.humidity).toBeGreaterThanOrEqual(0);
      expect(d.humidity).toBeLessThanOrEqual(100);
      expect(d.wind.trim()).not.toBe("");
    }
    // humidity/wind survive city offsets untouched (only temp/range shift).
    const moved = adjustForecast(forecast(), -7);
    expect(moved[2]!.humidity).toBe(forecast()[2]!.humidity);
  });
});
