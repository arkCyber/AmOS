import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

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

/**
 * Pure: given the user's mode + current time hour + OS dark preference, decide
 * whether the UI should render dark. Extracted for unit testing.
 */
export function resolveDark(mode: ThemeMode, _hour: number, prefersDark: boolean): boolean {
  switch (mode) {
    case "dark":
      return true;
    case "light":
      return false;
    case "auto":
    default:
      // 'auto' follows the OS. A day/night variant (hour-based) can be added by
      // treating a 4th value, but OS-follow is the most predictable default.
      return prefersDark;
  }
}

/** Apply (or remove) Tailwind's `dark` class on <html>. */
export function applyDarkClass(dark: boolean, root?: HTMLElement): void {
  const el = root ?? document.documentElement;
  el.classList.toggle("dark", dark);
}

interface ThemeContextValue {
  mode: ThemeMode;
  /** effective boolean used to render */
  dark: boolean;
  setMode: (m: ThemeMode) => void;
  /** @deprecated convenience toggle between light/dark */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const stored = readStored(THEME_KEY, "auto");
    return isThemeMode(stored) ? stored : "auto";
  });
  const [osDark, setOsDark] = useState<boolean>(() =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  // Track OS preference changes while in 'auto'.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setOsDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const dark = resolveDark(mode, new Date().getHours(), osDark);

  useEffect(() => {
    applyDarkClass(dark);
    window.Amos?.applyTheme?.(); // let the legacy shell resync if present
  }, [dark]);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    writeStored(THEME_KEY, m);
  }, []);
  const toggle = useCallback(() => setMode(dark ? "light" : "dark"), [dark, setMode]);

  const value = useMemo<ThemeContextValue>(() => ({ mode, dark, setMode, toggle }), [mode, dark, setMode, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}
