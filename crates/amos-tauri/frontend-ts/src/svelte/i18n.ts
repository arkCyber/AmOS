/**
 * Framework-free i18n primitives for Svelte 5 apps.
 *
 * It reuses the SAME locale dictionaries and the same string key the shell uses
 * (`src/i18n`), but intentionally imports only the PURE locale modules (never a
 * React entry, which would drag React into the import graph). The active locale
 * is read from the shared key the shell writes (`amos-ui.locale`).
 *
 * This module holds the NON-reactive half: `currentLocale()` (the pure reader the
 * reactive singleton hydrates from) and `translate()` (the pure lookup +
 * interpolation the reactive `t()` delegates to). The reactive singleton lives in
 * `./locale.svelte.ts`.
 */
import { isLocale } from "../i18n/types";

/** Mirrors the LOCALE_KEY const from the shell's i18n provider (shared store). */
export const LOCALE_KEY = "amos-ui.locale";

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

/**
 * Pure dictionary lookup + `{param}` interpolation (no reactivity). This is the
 * single interpolation implementation: the reactive `t()` in
 * `./locale.svelte.ts` delegates to it, and tests use it as the dictionary
 * oracle. There is deliberately no bound-`t()` factory here — the reactive
 * singleton is the only `t` the shell uses.
 */
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
