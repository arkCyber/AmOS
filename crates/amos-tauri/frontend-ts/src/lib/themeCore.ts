/**
 * lib/themeCore.ts — **React-free** theme helpers (single source of truth).
 *
 * The legacy React `src/theme/index.tsx` re-exports these for its provider; the
 * Svelte shell and pure tests import this directly, so removing React later
 * never loses the logic. `readStored`/`writeStored` touch the DOM only through a
 * safe try/catch and a no-op-friendly `window.Amos?` seam.
 */

export type ThemeMode = "light" | "dark" | "auto";
export const THEME_KEY = "amos-ui.theme";

/** Persist/read without throwing (sandboxed storage may be blocked). */
export function readStored(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
    window.Amos?.storeWrite?.(key, value);
  } catch {
    /* ignore */
  }
}

export function isThemeMode(v: string | null): v is ThemeMode {
  return v === "light" || v === "dark" || v === "auto";
}

/** Pure: given mode + current hour + OS dark preference, decide if UI is dark. */
export function resolveDark(mode: ThemeMode, _hour: number, prefersDark: boolean): boolean {
  switch (mode) {
    case "dark":
      return true;
    case "light":
      return false;
    case "auto":
    default:
      return prefersDark;
  }
}

/** Apply (or remove) Tailwind's `dark` class on <html> (or the given root). */
export function applyDarkClass(dark: boolean, root?: HTMLElement): void {
  const el = root ?? document.documentElement;
  el.classList.toggle("dark", dark);
}
