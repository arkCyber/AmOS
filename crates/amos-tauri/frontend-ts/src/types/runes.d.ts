/**
 * Ambient declarations for Svelte 5 runes macros ($state/$derived/$effect/…).
 *
 * `tsc` (the repo's `typecheck` script) has no knowledge of Svelte runes, but it
 * must still type-check `.svelte.ts` runes modules that plain `.ts` files import
 * (e.g. src/svelte/locale.svelte.ts). These globals give tsc a loose-but-correct
 * shape so the macros type-check without erroring.
 *
 * The Svelte compiler strips runes before real type-checking, and svelte-check
 * understands them natively — so these are a fallback for plain `tsc` only.
 */
declare function $state<T>(initial?: T): T;
declare function $derived<T>(expression: T): T;
declare function $effect(effect: () => void | (() => void)): void;
declare function $props<T extends Record<string, unknown>>(): T;
declare function $bindable<T>(value?: T): T;
