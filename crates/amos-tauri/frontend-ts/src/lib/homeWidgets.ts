/**
 * homeWidgets.ts — the home screen's **widget stack**: which widgets the user has placed,
 * and how that list arranges into rows.
 *
 * Why this exists: the home screen already drew a clock tile and a weather tile, but they
 * were **hard-coded markup** (`HomeDock.svelte`'s "fixed widgets header") — there was no
 * way to add a battery or calendar widget, no way to remove one, and no way to reorder
 * them. iPadOS (and every Android tablet) lets the user build that stack; here the answer
 * to "which widgets are on my home screen" lived as two literal `<button>` elements.
 *
 * Rules this module exists to keep (same shape as `formLayout.ts`, the sibling that turns
 * the host's *class* into content decisions):
 *
 *   1. **Missing or malformed stored state yields today's stack, never a capability.**
 *      Nothing in the store (no key at all, `null`, a bare object, a JSON string) means
 *      *the default*: the clock and the weather tile this screen has always shown. Only a
 *      well-formed **array** is taken at face value — including `[]`, which is a real
 *      user intent ("I removed them all"), not corruption.
 *   2. **The catalog is closed.** A kind the build does not know is dropped, not stored
 *      and rendered as a blank tile. `WidgetKind` is derived from `WIDGET_KINDS`, so a
 *      stored string cannot become a kind by typing.
 *   3. **One of each kind.** A kind is either on the home screen or it is not; adding a
 *      second clock would render the same reading twice next to itself. This keeps
 *      add/remove/reorder total functions over a *set*, and the gallery's rows honest
 *      toggles rather than counters.
 *   4. **Every widget opens a real app.** `WidgetSpec.appId` is an id from `APP_META`
 *      (`appMeta.ts`), never an invented destination — a widget with nowhere to go would
 *      be a dead tile.
 *
 * The widget *contents* (time, forecast, battery, next event) are NOT here: they come from
 * the same live sources the rest of the shell reads, in `svelte/HomeWidgets.svelte`. This
 * module is only the arrangement.
 */

/** Store key for the home widget list (`configuration`: losing it costs a re-add). */
export const HOME_WIDGETS_KEY = "amos.home.widgets";

/** The kinds this build can render. The `WidgetKind` union is derived from this tuple, so
 *  the two can never drift (the pattern `lib/taskmgr.ts` adopted after REQ-A669). */
export const WIDGET_KINDS = ["clock", "weather", "battery", "calendar"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

/** iPadOS widget sizes, as they matter *here*: a `small` tile pairs with its neighbour on
 *  one row; a `large` tile owns its row. */
export type WidgetSize = "small" | "large";

export interface WidgetSpec {
  readonly kind: WidgetKind;
  readonly size: WidgetSize;
  /** The app a tap opens — always an id `appMeta.ts` knows. */
  readonly appId: string;
  /** i18n key for the widget's name. Reuses the app dictionary where an app of the same
   *  name exists, so the gallery and the app grid cannot call the same thing two names. */
  readonly labelKey: string;
}

/** The catalog, in the order the gallery lists it. */
export const WIDGET_CATALOG: readonly WidgetSpec[] = [
  { kind: "clock", size: "small", appId: "clock", labelKey: "app.clock" },
  { kind: "weather", size: "small", appId: "weather", labelKey: "app.weather" },
  { kind: "battery", size: "small", appId: "settings", labelKey: "widget.battery" },
  { kind: "calendar", size: "large", appId: "calendar", labelKey: "app.calendar" },
];

/**
 * The stack this screen has always drawn: the clock tile and the weather tile, in that
 * order. This is what an absent (or unusable) stored value decodes to, which is what keeps
 * "no widget key in the store" byte-equivalent to the hard-coded header it replaced.
 */
export const DEFAULT_WIDGET_KINDS: readonly WidgetKind[] = ["clock", "weather"];

/** How many widgets the stack admits. The stack lives above the icon grid on a *phone*
 *  viewport, so an unbounded list would push the grid off the screen; four is the catalog
 *  size, i.e. "all of them". */
export const MAX_WIDGETS = WIDGET_CATALOG.length;

/** How many `small` tiles share a row. */
export const WIDGETS_PER_ROW = 2;

/** The spec for a stored/queried kind, or `null` for anything the build does not know. */
export function widgetSpec(kind: unknown): WidgetSpec | null {
  if (typeof kind !== "string") return null;
  return WIDGET_CATALOG.find((w) => w.kind === kind) ?? null;
}

/**
 * The app a placed widget taps through to — the catalog's own `appId`.
 *
 * This exists because there was **no reader** for `appId`: the four destinations lived as
 * string literals in `HomeWidgets.svelte` (`onopen("settings")`, …) while the field that
 * rule 4 promises is a real `APP_META` id — and that `homeWidgets.test.ts` checks against
 * `appTitleKey` to prove "every widget opens a real app" — was read by nothing. The
 * guarantee was therefore about a value no runtime used: a tile could be given a dead
 * literal and the test stayed green. Routing the tap through the catalog makes the checked
 * field the one that actually opens the app (REQ-A1562 ∕ F-SH-795).
 *
 * Total: `kind` is a `WidgetKind`, i.e. a member of `WIDGET_KINDS`, and the catalog is
 * pinned equal to that tuple by the catalog test — so an entry always exists. The cast
 * mirrors `addWidget`'s.
 */
export function widgetAppId(kind: WidgetKind): string {
  return (widgetSpec(kind) as WidgetSpec).appId;
}

/**
 * Decode a stored value into the widget list.
 *
 * `null`/`undefined`/a non-array (including a malformed JSON string that survived the
 * store's own decode) ⇒ the **default** stack. An array ⇒ its entries filtered to known
 * kinds, de-duplicated (first occurrence wins, i.e. the earliest position), capped at
 * `MAX_WIDGETS`. An all-unknown or empty array decodes to `[]` — that is "the user has no
 * widgets", which the home screen renders as an empty stack with a way back in.
 */
export function normalizeWidgets(raw: unknown): WidgetKind[] {
  if (!Array.isArray(raw)) return [...DEFAULT_WIDGET_KINDS];
  const out: WidgetKind[] = [];
  for (const entry of raw) {
    const spec = widgetSpec(entry);
    if (spec === null) continue;
    if (out.includes(spec.kind)) continue;
    if (out.length >= MAX_WIDGETS) break;
    out.push(spec.kind);
  }
  return out;
}

/** Whether the stack can still take this kind: unknown ⇒ no, already placed ⇒ no, full ⇒ no. */
export function canAddWidget(kinds: readonly WidgetKind[], kind: unknown): boolean {
  const spec = widgetSpec(kind);
  if (spec === null) return false;
  if (kinds.includes(spec.kind)) return false;
  return kinds.length < MAX_WIDGETS;
}

/** Append a widget (`unchanged` when `canAddWidget` is false, so callers need not pre-check). */
export function addWidget(kinds: readonly WidgetKind[], kind: unknown): WidgetKind[] {
  if (!canAddWidget(kinds, kind)) return [...kinds];
  return [...kinds, (widgetSpec(kind) as WidgetSpec).kind];
}

/** Remove a widget by kind; an absent kind is a no-op. */
export function removeWidget(kinds: readonly WidgetKind[], kind: unknown): WidgetKind[] {
  const spec = widgetSpec(kind);
  if (spec === null) return [...kinds];
  return kinds.filter((k) => k !== spec.kind);
}

/** Move a widget one slot earlier/later, swapping with its neighbour. A move off either
 *  end is a no-op (the caller's buttons are disabled by `canMoveWidget`). */
export function moveWidget(
  kinds: readonly WidgetKind[],
  kind: unknown,
  delta: number,
): WidgetKind[] {
  const spec = widgetSpec(kind);
  if (spec === null) return [...kinds];
  const i = kinds.indexOf(spec.kind);
  if (i < 0) return [...kinds];
  const j = i + delta;
  if (j < 0 || j >= kinds.length) return [...kinds];
  const out = [...kinds];
  out[i] = out[j] as WidgetKind;
  out[j] = spec.kind;
  return out;
}

/** Whether `moveWidget(kinds, kind, delta)` would change anything — the disabled state of
 *  the reorder buttons, computed from the same neighbour arithmetic. */
export function canMoveWidget(
  kinds: readonly WidgetKind[],
  kind: unknown,
  delta: number,
): boolean {
  const spec = widgetSpec(kind);
  if (spec === null) return false;
  const i = kinds.indexOf(spec.kind);
  if (i < 0) return false;
  const j = i + delta;
  return j >= 0 && j < kinds.length;
}

/**
 * Arrange the list into rows. A `small` widget pairs with the next `small` one; a `large`
 * widget always starts its own row (and anything after it starts another). Unknown kinds
 * are skipped — a row is never a blank cell.
 *
 * `["clock", "weather"]` (the default) ⇒ `[["clock", "weather"]]`, the exact two-tile row
 * the hard-coded header drew.
 */
export function widgetRows(kinds: readonly WidgetKind[]): WidgetKind[][] {
  const rows: WidgetKind[][] = [];
  let row: WidgetKind[] = [];
  for (const kind of kinds) {
    const spec = widgetSpec(kind);
    if (spec === null) continue;
    if (spec.size === "large") {
      if (row.length > 0) {
        rows.push(row);
        row = [];
      }
      rows.push([spec.kind]);
      continue;
    }
    row.push(spec.kind);
    if (row.length === WIDGETS_PER_ROW) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}
