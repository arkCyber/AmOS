/**
 * Reactive theme singleton for Svelte 5 apps — the Svelte counterpart of the
 * React `useTheme` context.
 *
 * Implemented as a runes module so `mode`/`osDark` are shared `$state`: Svelte
 * components call `themeMode()`/`themeDark()` in markup and update reactively.
 *
 * The *pure* decisions + persistence live in `lib/themeCore` (the single, unit-
 * tested source of truth); this module only adds the reactive runes state and the
 * OS-preference listener on top of them, so there is no duplicated logic.
 */
import { AMOS_THEME_CHANGED_EVENT } from "./ui-events";
import {
  THEME_KEY,
  applyDarkClass,
  isThemeMode,
  readStored,
  resolveDark,
  writeStored,
  type ThemeMode,
} from "../lib/themeCore";

export type { ThemeMode };

function readMode(): ThemeMode {
  const s = readStored(THEME_KEY, "auto");
  return isThemeMode(s) ? s : "auto";
}
function persistMode(m: ThemeMode): void {
  writeStored(THEME_KEY, m);
}
/** Effective dark decision for a mode + the current OS preference. */
function dark(mode: ThemeMode, osDark: boolean): boolean {
  return resolveDark(mode, new Date().getHours(), osDark);
}
/** Reflect the decision on <html>, tolerating a DOM-less (SSR) environment. */
function applyDarkClassSafe(isDark: boolean): void {
  try {
    applyDarkClass(isDark);
  } catch {
    /* ignore */
  }
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
  return dark(mode, osDark);
}

/** Set + persist the mode and reflect it on <html> immediately. */
export function setThemeMode(m: ThemeMode): void {
  const changed = m !== mode;
  mode = m;
  persistMode(m);
  
  // Add transition class before switching
  if (typeof document !== "undefined") {
    document.documentElement.classList.add("theme-transitioning");
  }
  
  applyDarkClassSafe(dark(mode, osDark));
  
  // Remove transition class after animation
  if (typeof document !== "undefined") {
    setTimeout(() => {
      document.documentElement.classList.remove("theme-transitioning");
    }, 200);
  }
  
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
  // Use setThemeMode which handles animation
  setThemeMode(themeDark() ? "light" : "dark");
}

// Track OS preference changes (matches the React provider) so "auto" follows
// the system. Guarded — safe under SSR/tests without matchMedia.
// NOTE: registered on module import. The earlier `if (osPrefersDark() && …)`
// version **skipped** the listener on light systems, so flipping the OS theme
// from light→dark never refreshed the UI. Now we always attach (when a real
// browser matchMedia exists), and the listener body just reads the current
// `osPrefersDark()` value on each event.
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      osDark = osPrefersDark();
      applyDarkClassSafe(dark(mode, osDark));
    });
}
