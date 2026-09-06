/**
 * Plain (non-runes) constants shared between the React shell and the Svelte
 * i18n singleton. Kept in a normal `.ts` so the React host can import it under
 * `bun` without pulling in a runes (`.svelte.ts`) module that bun can't parse.
 */
/** Window event the React shell dispatches when its locale changes. */
export const SVELTE_LOCALE_EVENT = "amos-svelte-locale";
