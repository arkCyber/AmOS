/**
 * Shared CSS class tokens for the iOS-style Settings UI (kit strings used by the
 * settings index + sub pages + rows). Centralised so the grouped-list look stays
 * consistent across every page of the refactored Settings screen.
 */
export const GROUP =
  "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
export const ROW = "flex items-center justify-between gap-3 px-4 py-3";
export const ROW_ACTIVE =
  "flex items-center justify-between gap-3 px-4 py-3 text-left w-full";
export const LABEL = "text-[15px] text-neutral-800 dark:text-neutral-100";
export const VALUE = "text-[15px] opacity-50";
export const SUB = "h-px bg-black/5 dark:bg-white/10";
export const FIELD = "w-full rounded-lg bg-black/5 px-2.5 py-1.5 text-sm outline-none dark:bg-white/10";
export const CHEVRON = "opacity-30";
export const H1 =
  "px-1 text-[28px] font-bold tracking-tight text-neutral-900 dark:text-neutral-50";
export const H2 =
  "text-[15px] font-semibold text-neutral-900 dark:text-neutral-50";
export const HINT = "text-xs opacity-60";

/**
 * Unique id for one label↔control pair (REQ-A283).
 *
 * The a11y rule is that a control's name must come from its *visible* label, and the two
 * halves are wired by an id (`<label for={id}>` / `aria-labelledby={labelId}`, see
 * `Field.svelte`). Hand-writing those ids per page is exactly how they drift, so they are
 * generated here, from one counter: ids only ever need to be unique inside one document,
 * and a page (or a test) that mounts N rows gets N distinct ids.
 *
 * A monotonic counter (not `crypto.randomUUID`) because the value also lands in test
 * assertions / snapshots: a per-mount stable sequence keeps a failure readable.
 */
let fieldSeq = 0;

/** Next `amos-field-<n>` id. Use through `Field.svelte`, not directly in pages. */
export function nextFieldId(): string {
  fieldSeq += 1;
  return `amos-field-${fieldSeq}`;
}
