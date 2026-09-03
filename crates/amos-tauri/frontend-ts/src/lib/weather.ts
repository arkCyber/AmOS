import type { Locale } from "../i18n/types";

export interface DayForecast {
  daysFromNow: number;
  icon: string;
  temp: number;
  /** ±1 degrees, cosmetic variance per day so it isn't constant. */
  range: string;
  /** Relative humidity %, deterministic. */
  humidity: number;
  /** Gentle wind label (knots/level), deterministic. */
  wind: string;
}

/** Deterministic 5-day mock forecast (aligned with the legacy Weather app). */
export function forecast(): DayForecast[] {
  return [
    { daysFromNow: 0, icon: "⛅", temp: 26, range: "22°–30°", humidity: 62, wind: "2" },
    { daysFromNow: 1, icon: "⛅", temp: 24, range: "20°–27°", humidity: 58, wind: "3" },
    { daysFromNow: 2, icon: "🌧️", temp: 21, range: "18°–24°", humidity: 84, wind: "4" },
    { daysFromNow: 3, icon: "☁️", temp: 23, range: "19°–26°", humidity: 71, wind: "3" },
    { daysFromNow: 4, icon: "☀️", temp: 27, range: "22°–31°", humidity: 45, wind: "2" },
  ];
}

/** Map our Locale to an Intl tag used for day names. */
export function intlTag(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en-US";
}

/** Short weekday name for a day N days from `base`. */
export function dayLabel(locale: Locale, base: Date, daysFromNow: number): string {
  const d = new Date(base.getTime() + daysFromNow * 86400000);
  return d.toLocaleDateString(intlTag(locale), { weekday: "short" });
}

export type TempUnit = "c" | "f";

/** Celsius → rounded Fahrenheit. */
export function cToF(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

/** Render a temperature for the active unit. */
export function displayTemp(c: number, unit: TempUnit): string {
  return unit === "f" ? `${cToF(c)}°F` : `${c}°`;
}

/** Re-render a "min°–max°" range string in the active unit (passthrough in C). */
export function convertRange(range: string, unit: TempUnit): string {
  if (unit === "c") return range;
  const nums = range.match(/-?\d+/g);
  if (!nums || nums.length < 2) return range;
  return `${cToF(Number(nums[0]))}°F–${cToF(Number(nums[1]))}°F`;
}

/* ---- Multi-city: each city is a pure temperature + range offset from the
 * deterministic base forecast (headless-testable). ---- */
export interface WCity {
  id: string;
  /** Signed Celsius offset applied to the base (Beijing) forecast. */
  offset: number;
}

export const WEATHER_CITIES: WCity[] = [
  { id: "beijing", offset: 0 },
  { id: "tokyo", offset: -2 },
  { id: "london", offset: -7 },
  { id: "newyork", offset: -9 },
  { id: "paris", offset: -1 },
  { id: "sydney", offset: 4 },
];

/** Optional per-app subset cap (user-added cities must stay bounded). */
export const WEATHER_CITY_CAP = 6;
export const defaultWeatherCities = (): WCity[] => WEATHER_CITIES.slice(0, 4);

/** Sanitize a persisted city-subset list (unknown ids dropped, de-duped, capped).
 * Empty/invalid falls back to the default four. */
export function normalizeWeatherCities(
  v: unknown,
  fallback: WCity[] = defaultWeatherCities(),
): WCity[] {
  if (!Array.isArray(v)) return fallback;
  const known = new Map(WEATHER_CITIES.map((c) => [c.id, c]));
  const out: WCity[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const id = raw && typeof raw === "object" ? (raw as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(known.get(id)!);
    if (out.length >= WEATHER_CITY_CAP) break;
  }
  return out.length ? out : fallback;
}
export function removeWeatherCity(list: WCity[], id: string): WCity[] {
  return list.filter((c) => c.id !== id);
}
export function addWeatherCity(list: WCity[], city: WCity): WCity[] {
  if (list.some((c) => c.id === city.id)) return list;
  const next = list.length >= WEATHER_CITY_CAP ? list.slice(list.length - (WEATHER_CITY_CAP - 1)) : list;
  return [...next, city];
}

/** Shift one "min°–max°" range by a signed offset (pure). */
export function shiftRange(range: string, offset: number): string {
  const nums = range.match(/-?\d+/g);
  if (!nums || nums.length < 2) return range;
  return `${Number(nums[0]) + offset}°–${Number(nums[1]) + offset}°`;
}

/** Shift a whole 5-day forecast by a city's offset (temp and range). */
export function adjustForecast(days: readonly DayForecast[], offset: number): DayForecast[] {
  if (offset === 0) return [...days];
  return days.map((d) => ({
    ...d,
    temp: d.temp + offset,
    range: shiftRange(d.range, offset),
  }));
}
