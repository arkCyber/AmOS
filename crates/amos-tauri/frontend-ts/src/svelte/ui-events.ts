/**
 * Cross-screen UI events — broadcast when the shared theme / locale changes.
 *
 * The shell owns the reactive theme + locale singletons (`theme.svelte.ts` /
 * `locale.svelte.ts`), which render the chrome and every screen. When either
 * changes it broadcasts the matching window event here so any same-window
 * listener can re-sync live.
 *
 * Plain TS (no runes) so any module can import it.
 */
export const AMOS_THEME_CHANGED_EVENT = "amos:theme-changed";
export const AMOS_LOCALE_CHANGED_EVENT = "amos:locale-changed";
