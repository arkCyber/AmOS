/**
 * Cross-framework UI events — the Svelte → React direction.
 *
 * The React shell owns the app's theme + locale providers (they render the shell
 * chrome + all React screens). A Svelte screen can now be the *switcher* too
 * (e.g. the Svelte Settings screen), so when the Svelte side changes the shared
 * `amos-ui.theme` / `amos-ui.locale` keys it broadcasts a window event here; the
 * React ThemeProvider / I18nProvider listen and re-sync their context live.
 *
 * Plain TS (no runes / no React) so both frameworks can import it.
 */
export const AMOS_THEME_CHANGED_EVENT = "amos:theme-changed";
export const AMOS_LOCALE_CHANGED_EVENT = "amos:locale-changed";
