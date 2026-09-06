/**
 * Reactive theme singleton for Svelte 5 apps — the Svelte counterpart of the
 * React `useTheme` context (`src/theme/index.tsx`).
 *
 * Implemented as a runes module so `mode`/`osDark` are shared `$state`: Svelte
 * components call `themeMode()`/`themeDark()` in markup and update reactively.
 *
 * Why the logic is duplicated (not imported from `src/theme`): that module is a
 * React context file (`createContext(...)` runs at import) — importing it would
 * drag React into the Svelte chunk. These few pure helpers are tiny and stable.
 *
 * Cross-framework: the React ThemeProvider already toggles Tailwind's `dark`
 * class on <html> and owns the OS-preference listener. This store is for Svelte
 * UI that needs to *render* from the theme (a toggle, an icon, a color choice),
 * and keeps itself in sync by reading the same `amos-ui.theme` key + matchMedia.
 */
import { AMOS_THEME_CHANGED_EVENT } from "./ui-events";

export type ThemeMode = "light" | "dark" | "auto";

const THEME_KEY = "amos-ui.theme";

function readMode(): ThemeMode {
  try {
    const s =
      typeof localStorage !== "undefined" ? localStorage.getItem(THEME_KEY) : null;
    return s === "light" || s === "dark" || s === "auto" ? s : "auto";
  } catch {
    return "auto";
  }
}
function persistMode(m: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, m);
    (window as { Amos?: { storeWrite?(k: string, v: string): void } }).Amos?.storeWrite?.(
      THEME_KEY,
      m,
    );
  } catch {
    /* ignore */
  }
}
function applyDarkClass(dark: boolean): void {
  try {
    document.documentElement.classList.toggle("dark", dark);
  } catch {
    /* ignore */
  }
}
function resolveDark(mode: ThemeMode, osDark: boolean): boolean {
  return mode === "dark" ? true : mode === "light" ? false : osDark;
}
function osPrefersDark(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  } catch {
    return false;
  }
}

let mode = $state<ThemeMode>(readMode());
let osDark = $state<boolean>(osPrefersDark());

/** Reactive read of the theme mode — safe to call inside markup/$derived. */
export function themeMode(): ThemeMode {
  return mode;
}
/** Reactive read of the *effective* dark boolean (mode auto → OS pref). */
export function themeDark(): boolean {
  return resolveDark(mode, osDark);
}

/** Set + persist the mode and reflect it on <html> immediately. */
export function setThemeMode(m: ThemeMode): void {
  const changed = m !== mode;
  mode = m;
  persistMode(m);
  applyDarkClass(resolveDark(mode, osDark));
  if (changed) {
    try {
      window.dispatchEvent(new CustomEvent(AMOS_THEME_CHANGED_EVENT, { detail: m }));
    } catch {
      /* ignore */
    }
  }
}

/** Convenience light<->dark toggle (keeps "auto" resolved to a concrete value). */
export function toggleTheme(): void {
  setThemeMode(themeDark() ? "light" : "dark");
}

// Track OS preference changes (matches the React provider) so "auto" follows
// the system. Guarded — safe under SSR/tests without matchMedia.
if (osPrefersDark() && typeof window !== "undefined" && typeof window.matchMedia === "function") {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", (e: MediaQueryListEvent) => {
      osDark = e.matches;
      applyDarkClass(resolveDark(mode, osDark));
    });
}
