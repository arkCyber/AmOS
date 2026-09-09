/**
 * Reactive, framework-free i18n singleton for Svelte 5 apps — implemented as a
 * runes module (`.svelte.ts`) so `locale` is a shared `$state`.
 *
 * Why this exists alongside `./i18n.ts`: `./i18n.ts` has pure, one-shot helpers
 * (`translate`, `makeT`, `currentLocale`) that read the locale once. This module
 * is the REACTIVE variant: components call `t(key)`/`locale()` inside markup and
 * Svelte re-renders them the instant `setLocale()` is called (fine-grained
 * signal tracking works through function calls during render).
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
import { currentLocale } from "./i18n";
import { SVELTE_LOCALE_EVENT } from "./locale-events";
import { AMOS_LOCALE_CHANGED_EVENT } from "./ui-events";

export { LOCALE_KEY } from "./i18n";

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

/** Same {param} interpolation the React shell uses. */
function interp(base: string, params?: Record<string, string | number>): string {
  if (!params) return base;
  return base.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

/** Reactive `t()` — re-evaluates when the shared locale changes. */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = DICTS[current];
  const raw = dict?.[key];
  return interp(raw ?? key, params);
}

/** Set + persist the locale (mirrors the React shell's persistence behaviour). */
export function setLocale(l: Locale): void {
  const changed = l !== current;
  if (changed) current = l;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem("amos-ui.locale", l);
    if (typeof document !== "undefined") document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
    (window as { Amos?: { storeWrite?(k: string, v: string): void } }).Amos?.storeWrite?.(
      "amos-ui.locale",
      l,
    );
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

// React shell → Svelte locale bridge: the React host (SvelteAppHost) broadcasts
// the shell locale as a window event; apply it here so already-mounted Svelte
// apps re-key in place. (First mount needs no event — React already persisted the
// locale to localStorage, which `currentLocale()` reads at module load.)
if (typeof window !== "undefined") {
  window.addEventListener(SVELTE_LOCALE_EVENT, (e) => {
    const detail = (e as CustomEvent<string | null | undefined>).detail;
    if (detail != null && isLocale(detail)) setLocale(detail);
  });
}
