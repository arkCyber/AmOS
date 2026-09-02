import type { Locale } from "../i18n/types";

export interface DayForecast {
  daysFromNow: number;
  icon: string;
  temp: number;
  /** ±1 degrees, cosmetic variance per day so it isn't constant. */
  range: string;
}

/** Deterministic 5-day mock forecast (aligned with the legacy Weather app). */
export function forecast(): DayForecast[] {
  return [
    { daysFromNow: 0, icon: "⛅", temp: 26, range: "22°–30°" },
    { daysFromNow: 1, icon: "⛅", temp: 24, range: "20°–27°" },
    { daysFromNow: 2, icon: "🌧️", temp: 21, range: "18°–24°" },
    { daysFromNow: 3, icon: "☁️", temp: 23, range: "19°–26°" },
    { daysFromNow: 4, icon: "☀️", temp: 27, range: "22°–31°" },
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
