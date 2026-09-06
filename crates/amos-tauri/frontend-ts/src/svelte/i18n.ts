/**
 * Framework-free i18n helper for Svelte 5 apps.
 *
 * It reuses the SAME locale dictionaries and the same string key the React
 * shell uses (`src/i18n`), but intentionally imports only the PURE locale
 * modules (never `src/i18n/index.tsx`, which pulls in React at module load).
 * The active locale is read from the shared key the React shell already writes
 * (`amos-ui.locale`), so a Svelte app mounted inside the React shell or as a
 * future standalone root keeps translating in lock-step with the shell.
 */
import { zh } from "../i18n/locales/zh";
import { en } from "../i18n/locales/en";
import { isLocale } from "../i18n/types";

/** Mirrors the LOCALE_KEY const from the React i18n provider (shared store). */
export const LOCALE_KEY = "amos-ui.locale";

const DICTS: Record<"zh" | "en", Record<string, string>> = {
  zh: zh as unknown as Record<string, string>,
  en: en as unknown as Record<string, string>,
};

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** Current locale, defaulting to the shell default "zh". Never throws. */
export function currentLocale(): "zh" | "en" {
  try {
    const stored =
      typeof localStorage !== "undefined" ? localStorage.getItem(LOCALE_KEY) : null;
    return isLocale(stored) ? stored : "zh";
  } catch {
    return "zh";
  }
}

/** Same {param} interpolation the React shell's `translate()` performs. */
export function translate(
  dict: Record<string, string>,
  key: string,
  params?: Record<string, string | number>,
): string {
  const raw = dict[key];
  const base = raw ?? key;
  if (!params) return base;
  return base.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

/** Build a `t()` bound to the currently active locale. */
export function makeT(): TranslateFn {
  const dict = DICTS[currentLocale()] ?? DICTS.zh;
  return (key, params) => translate(dict, key, params);
}
