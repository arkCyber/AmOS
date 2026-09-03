/* Shared iOS-style UI tokens + primitives. Keep every page on the same
   glass-cell / grouped-list / switch language instead of hand-written classes. */

/** iOS grouped-cell container (Settings list look). */
export const GROUP =
  "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";
/** A full-width label row inside a group. */
export const ROW = "flex items-center justify-between gap-3 px-4 py-3";
/** Primary (15px, iOS settings body) text label. */
export const LABEL = "text-[15px] text-neutral-800 dark:text-neutral-100";
/** Hairline divider between grouped rows. */
export const SUB = "h-px bg-black/5 dark:bg-white/10";
/** Neutral text field on a grouped card. */
export const FIELD = "w-full rounded-lg bg-black/5 px-2.5 py-1.5 text-sm outline-none dark:bg-white/10";

/** A pill/chip: filled accent when active, translucent fill when idle. */
export function pillCls(active: boolean): string {
  return (
    "rounded-full px-3 py-1.5 text-xs transition " +
    (active ? "bg-accent text-white" : "bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300")
  );
}

/** Legacy solid chip used directly on an app canvas (not on a glass card):
 *  matches the old neutral chip exactly so adoption is visually neutral. */
export function chip(active: boolean, size: "xs" | "sm" | "md" | "lg" = "xs"): string {
  const pad =
    size === "md"
      ? "px-3 py-1.5 text-sm"
      : size === "sm"
        ? "px-3 py-1 text-sm"
        : size === "lg"
          ? "px-4 py-1.5 text-sm"
          : "px-3 py-1 text-xs";
  return (
    `${pad} rounded-full transition ` +
    (active ? "bg-accent text-white" : "bg-neutral-300 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200")
  );
}

/** A small round action button (not a tab/chip): neutral / accent / danger. */
export function btn(
  kind: "neutral" | "accent" | "danger" = "neutral",
  size: "sm" | "md" | "lg" = "md",
): string {
  const pad =
    size === "sm" ? "px-3 py-1 text-xs" : size === "lg" ? "px-4 py-1.5 text-sm" : "px-3 py-1 text-sm";
  const tone =
    kind === "accent"
      ? "bg-accent text-white"
      : kind === "danger"
        ? "bg-danger text-white"
        : "bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100";
  return `${pad} rounded-full ${tone} transition active:scale-95 disabled:opacity-40`;
}

/** iOS green switch. */
export function Switch({
  on,
  onToggle,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  label?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className={
        "h-7 w-[46px] shrink-0 rounded-full p-0.5 transition " +
        (on ? "bg-green-500" : "bg-neutral-300 dark:bg-neutral-600")
      }
    >
      <span
        className={
          "block h-6 w-6 rounded-full bg-white shadow transition-transform " +
          (on ? "translate-x-[18px]" : "translate-x-0")
        }
      />
    </button>
  );
}
