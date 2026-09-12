/**
 * Pure-Svelte host boot: apply persisted theme + locale to the document.
 *
 * The shell toggles Tailwind's `dark` class on <html> and sets `lang` here,
 * replacing the removed React ThemeProvider/I18nProvider DOM effect.
 * Deliberately reads persisted keys DIRECTLY (no import side effect) so this is
 * deterministic to unit-test and independent of module initialization order.
 */
const THEME_KEY = "amos-ui.theme";
const LOCALE_KEY = "amos-ui.locale";

/** Toggle Tailwind `dark` on <html> from the persisted/preferred theme. */
export function applyThemeToDom(): void {
  try {
    if (typeof document === "undefined") return;
    const mode =
      typeof localStorage !== "undefined" ? localStorage.getItem(THEME_KEY) : null;
    const osDark =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    const dark = mode === "dark" ? true : mode === "light" ? false : Boolean(osDark);
    document.documentElement.classList.toggle("dark", dark);
  } catch {
    /* ignore */
  }
}

/** Set <html lang> from the persisted locale (default zh-CN). */
export function applyLocaleToDom(): void {
  try {
    if (typeof document === "undefined") return;
    const locale =
      typeof localStorage !== "undefined" ? localStorage.getItem(LOCALE_KEY) : null;
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
  } catch {
    /* ignore */
  }
}

/** Full OS-chrome boot for the pure-Svelte host. */
export function bootOsChrome(): void {
  applyThemeToDom();
  applyLocaleToDom();
}
