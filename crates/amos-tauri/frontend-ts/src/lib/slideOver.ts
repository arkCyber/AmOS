/**
 * slideOver.ts — the durable form of the shell's **Slide Over intent**.
 *
 * Slide Over is the third, *floating* pane: a narrow app panel that overlays whatever
 * the shell is showing (home, an app, or an existing two-pane split) instead of
 * sharing the screen with it (REQ-A675). Like `splitPersist` (REQ-A512) this module is
 * the decode half — the shell owns *intent* (which app, which axis, what share), the
 * host owns geometry (`amos_wm::layout::slide_over_pane` reached via `wm_slide_over_rect`).
 *
 * The honest boundary is the same as the split's: a persisted panel is only returned
 * when its app is **still installed**. An uninstalled app (or a hand-edited
 * `amos.slideOver` naming an id that never existed) yields `null` rather than a panel
 * the shell would then have to paint as a pane of nothing.
 *
 * `clampSlidePercent` is the **one** clamp for the panel's share. It is deliberately
 * **narrower** than the split's 1..=99: a floating panel below ~15% is an unreadable
 * sliver, and one above ~60% is no longer floating *over* the app — it has become a
 * second pane, which is what `enterSplit` exists for. Refusing that as "Slide Over"
 * keeps the two gestures distinct instead of letting the panel silently become a split.
 */
/** The axis the shell asks the host for. `auto` defers to the host's own class rule
 * (`LayoutPolicy::split_axis`), which is what makes a rotation after opening the panel
 * still correct. Declared **here** (the low layer) so this module carries no Svelte
 * import; `shellState` re-exports it as `SurfaceSlideOverAxis`. */
export type SurfaceSlideOverAxis = "vertical" | "horizontal" | "auto";

/** localStorage / Rust-store key holding the last committed Slide Over intent. */
export const SLIDE_OVER_KEY = "amos.slideOver";

/** Every axis the shell may ask for — mirrors `SurfaceSlideOverAxis` (kept as a value
 * so a hand-edited store can be validated at runtime, not merely at compile time). */
export const SLIDE_OVER_AXES = ["vertical", "horizontal", "auto"] as const;

/** The narrower band the shell offers a floating panel (see the module doc). */
export const SLIDE_PERCENT_MIN = 15;
export const SLIDE_PERCENT_MAX = 60;

/** A fresh panel's share — a third, matching `amos_wm::slide::DEFAULT_SLIDE_PERCENT`. */
export const SLIDE_PERCENT_DEFAULT = 33;

/** The clamped share, or {@link SLIDE_PERCENT_DEFAULT} for anything not a finite
 * number (the same conservative default a fresh panel opens at). An in-range value is
 * rounded; an out-of-range one is pulled to the nearest end of the band. */
export function clampSlidePercent(p: unknown): number {
  if (typeof p !== "number" || !Number.isFinite(p)) return SLIDE_PERCENT_DEFAULT;
  const r = Math.round(p);
  if (r < SLIDE_PERCENT_MIN) return SLIDE_PERCENT_MIN;
  if (r > SLIDE_PERCENT_MAX) return SLIDE_PERCENT_MAX;
  return r;
}

/** The decoded intent: one still-installed app, a known axis, a clamped share. */
export interface PersistedSlideOver {
  readonly id: string;
  readonly axis: SurfaceSlideOverAxis;
  readonly percent: number;
}

function asAxis(v: unknown): SurfaceSlideOverAxis {
  return typeof v === "string" && (SLIDE_OVER_AXES as readonly string[]).includes(v)
    ? (v as SurfaceSlideOverAxis)
    : "auto";
}

/**
 * Decode a stored panel against the apps that are **currently available**.
 *
 * Returns `null` (never a partial intent) when the value is not an object or `id` is
 * missing / not a non-empty string / not in `available`. An unknown or absent axis
 * falls back to `"auto"` and an absent/garbage share to a clamped default — those two
 * are *recoverable* nuances, whereas an unavailable app is not: the shell has no app to
 * put in the panel. That asymmetry mirrors `parseSplit`.
 */
export function parseSlideOver(raw: unknown, available: readonly string[]): PersistedSlideOver | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const { id } = o;
  if (typeof id !== "string" || id === "") return null;
  if (!available.includes(id)) return null;
  return { id, axis: asAxis(o.axis), percent: clampSlidePercent(o.percent) };
}

/** The on-disk shape of a live panel (the inverse of `parseSlideOver`, for a writer
 * that wants to be explicit about the three keys rather than spreading a `Surface`). */
export function encodeSlideOver(s: PersistedSlideOver): PersistedSlideOver {
  return { id: s.id, axis: s.axis, percent: clampSlidePercent(s.percent) };
}
