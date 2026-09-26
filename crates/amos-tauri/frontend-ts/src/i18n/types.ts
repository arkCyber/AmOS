/** Supported locales. zh is the base dictionary; en is a full translation. */
export const LOCALES = ["zh", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(v: string | null): v is Locale {
  return (LOCALES as readonly string[]).includes(v ?? "");
}

/**
 * Map our `Locale` to the `Intl` tag its date/time formatting expects.
 *
 * Lives here (next to `Locale`) rather than in one feature module: several
 * surfaces format dates — the browser's history list, the weather forecast's
 * weekday names — and each one carrying its own `zh → "zh-CN"` branch is how a
 * new locale gets wired into some of them and forgotten in the rest.
 */
export function intlTag(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en-US";
}
