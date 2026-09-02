/** Supported locales. zh is the base dictionary; en is a full translation. */
export const LOCALES = ["zh", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(v: string | null): v is Locale {
  return (LOCALES as readonly string[]).includes(v ?? "");
}
