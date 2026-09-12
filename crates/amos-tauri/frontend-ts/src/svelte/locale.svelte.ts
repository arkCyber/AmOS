/**
 * Reactive, framework-free i18n singleton for Svelte 5 apps — implemented as a
 * runes module (`.svelte.ts`) so `locale` is a shared `$state`.
 *
 * Why this exists alongside `./i18n.ts`: `./i18n.ts` holds the pure, one-shot
 * helpers (`translate`, `currentLocale`) that read the locale once and that this
 * module builds on. This module is the REACTIVE variant: components call
 * `t(key)`/`locale()` inside markup and Svelte re-renders them the instant
 * `setLocale()` is called (fine-grained signal tracking works through function
 * calls during render).
 *
 * Cross-window sync: the shell owns locale switching and calls `setLocale()`
 * whenever the UI locale changes, so every mounted Svelte app updates in place
 * — no remount, no state loss. It persists to the same key the shell writes
 * (`amos-ui.locale`).
 */
import { zh } from "../i18n/locales/zh";
import { en } from "../i18n/locales/en";
import type { Locale } from "../i18n/types";
import { isLocale } from "../i18n/types";
import { currentLocale, translate, LOCALE_KEY } from "./i18n";
import { systemStoreSet } from "../lib/backend";
import { SVELTE_LOCALE_EVENT } from "./locale-events";
import { AMOS_LOCALE_CHANGED_EVENT } from "./ui-events";

export { LOCALE_KEY };

const DICTS: Record<Locale, Record<string, string>> = {
  zh: zh as unknown as Record<string, string>,
  en: en as unknown as Record<string, string>,
};

// Shared reactive locale (module-level rune). All Svelte apps share one instance.
let current = $state<Locale>(currentLocale());

/** Reactive read of the active locale — safe to call inside markup/$derived. */
export function locale(): Locale {
  return current;
}

/**
 * Reactive `t()` — re-evaluates when the shared locale changes.
 *
 * Delegates the lookup + `{param}` interpolation to the pure `translate()`
 * helper so there is exactly ONE interpolation implementation for the whole UI
 * (a second private copy here could drift from it).
 */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(DICTS[current], key, params);
}

/** Set + persist the locale (mirrors the shell's persistence behaviour). */
export function setLocale(l: Locale): void {
  const changed = l !== current;
  if (changed) current = l;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem("amos-ui.locale", l);
    if (typeof document !== "undefined") document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
    // Mirror to the Rust shared store (the locale is stored *raw*, like the theme,
    // not JSON-encoded — `currentLocale()` reads the same raw string back).
    void systemStoreSet(LOCALE_KEY, l);
  } catch {
    /* ignore */
  }
  if (changed) {
    try {
      window.dispatchEvent(new CustomEvent(AMOS_LOCALE_CHANGED_EVENT, { detail: l }));
    } catch {
      /* ignore */
    }
  }
}

/** Guarded setter for callers that only hold a raw string (validates to Locale). */
export function setLocaleSafe(v: string | null | undefined): void {
  if (v != null && isLocale(v)) setLocale(v);
}

// Shell → Svelte locale bridge: `Shell.svelte` broadcasts the shell locale as a
// window event; apply it here so already-mounted Svelte apps re-key in place.
// (First mount needs no event — the host already persisted the locale to
// localStorage, which `currentLocale()` reads at module load.) The same guarded
// setter the tests exercise is used here, so the "raw string → Locale" validation
// has one implementation.
if (typeof window !== "undefined") {
  window.addEventListener(SVELTE_LOCALE_EVENT, (e) => {
    setLocaleSafe((e as CustomEvent<string | null | undefined>).detail);
  });
}
