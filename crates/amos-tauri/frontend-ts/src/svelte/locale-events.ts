/**
 * Plain (non-runes) constants for the locale bridge. Kept in a normal `.ts` so
 * the shell can import it under `bun` without pulling in a runes (`.svelte.ts`)
 * module that bun can't parse.
 */
/** Window event the shell dispatches when the locale changes. */
export const SVELTE_LOCALE_EVENT = "amos-svelte-locale";
