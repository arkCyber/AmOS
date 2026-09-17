/**
 * Shared CSS class tokens for the iOS-style Settings UI (kit strings used by the
 * settings index + sub pages + rows). Centralised so the grouped-list look stays
 * consistent across every page of the refactored Settings screen.
 */
export const GROUP =
  "overflow-hidden rounded-ios-card bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
export const ROW = "flex items-center justify-between gap-3 px-4 py-3 min-h-[44px]";
export const ROW_ACTIVE =
  "flex items-center justify-between gap-3 px-4 py-3 min-h-[44px] text-left w-full";
export const LABEL = "text-ios-body text-neutral-800 dark:text-neutral-100";
export const VALUE = "text-ios-body text-neutral-600 dark:text-neutral-400";
export const SUB = "h-px bg-black/5 dark:bg-white/10";
export const FIELD = "w-full rounded-ios-input bg-black/5 px-3.5 py-2.5 text-ios-body outline-none dark:bg-white/10";
export const CHEVRON = "text-neutral-400 dark:text-neutral-500";
export const H1 =
  "px-1 text-ios-large-title tracking-tight text-neutral-900 dark:text-neutral-50";
export const H2 =
  "text-ios-subhead font-semibold text-neutral-900 dark:text-neutral-50";
export const HINT = "text-ios-footnote text-neutral-600 dark:text-neutral-400";

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
