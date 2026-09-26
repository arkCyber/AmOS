/**
 * splitPersist.ts — the durable form of the shell's **split intent**.
 *
 * The shell owns *intent* (which two apps, which axis, what ratio); the host owns
 * geometry (`amos_wm::layout::split_panes`). Until now that intent died with the
 * process, so a tablet that was closed on a split came back on a bare home screen
 * (`docs/multi-window.md` §REQ-A512 boundary ③). This module is the decode half:
 * a **pure** `parseSplit` that turns whatever is on disk into a usable intent *or*
 * `null`.
 *
 * The honest boundary is here, not in the caller: a persisted split is only returned
 * when **both** pane apps are still installed. An app that was uninstalled between
 * runs (or a hand-edited `amos.split` naming an id that never existed) yields `null`
 * rather than a split the shell would then have to render as one pane of nothing. The
 * same rule the home `getLayout` follows: repair against what is actually available,
 * never trust the stored ids.
 *
 * `clampSplitPercent` is the **one** clamp for the ratio. `shellState.setSplitPercent`
 * and `enterSplit` both go through it, so a restore cannot slip a 0 % / 100 % divider
 * (a pane with no width) past the host, which would reject it anyway.
 */
/** The axis the shell asks the host for. `auto` defers to the host's own class rule
 * (`LayoutPolicy::split_axis`), which is what makes a rotation after entering the
 * split still correct. Declared **here** (the low layer) so this module carries no
 * Svelte import; `shellState` re-exports it as `SurfaceSplitAxis`. */
export type SurfaceSplitAxis = "vertical" | "horizontal" | "auto";

/** localStorage / Rust-store key holding the last committed split intent. */
export const SPLIT_KEY = "amos.split";

/** Every axis the shell may ask for — mirrors `SurfaceSplitAxis` (kept as a value so
 * a hand-edited store can be validated at runtime, not merely at compile time). */
export const SPLIT_AXES = ["vertical", "horizontal", "auto"] as const;

/** Neither pane may reach zero width/height: the host's `split_panes` would reject a
 * degenerate request (`min_pane`), so the shell never hands it one. */
export const SPLIT_PERCENT_MIN = 1;
export const SPLIT_PERCENT_MAX = 99;

/** The clamped ratio, or `50` for anything that is not a finite number (the same
 * conservative default a fresh `enterSplit` uses). */
export function clampSplitPercent(p: unknown): number {
  if (typeof p !== "number" || !Number.isFinite(p)) return 50;
  const r = Math.round(p);
  if (r < SPLIT_PERCENT_MIN) return SPLIT_PERCENT_MIN;
  if (r > SPLIT_PERCENT_MAX) return SPLIT_PERCENT_MAX;
  return r;
}

/** The decoded intent: two distinct, still-installed panes, a known axis, a clamped
 * ratio. */
export interface PersistedSplit {
  readonly primary: string;
  readonly secondary: string;
  readonly axis: SurfaceSplitAxis;
  readonly percent: number;
}

function asAxis(v: unknown): SurfaceSplitAxis {
  return typeof v === "string" && (SPLIT_AXES as readonly string[]).includes(v)
    ? (v as SurfaceSplitAxis)
    : "auto";
}

/**
 * Whether two app ids may occupy the two panes: each a **non-empty** string, and the
 * two **distinct**. This is the one description of the rule. The decode half
 * (`parseSplit`) and both live doors into `kind: "split"` — `enterSplit` and `open`'s
 * pane retarget — defer to it, so a split the running shell commits is always one this
 * module can read back. A same-app pair is refused because it is **not two panes**: it
 * is one app painted twice, and `restoreSplit` would silently drop it on the next
 * launch instead of bringing back what the user had (REQ-A700).
 */
export function isSplittablePair(primary: string, secondary: string): boolean {
  return primary !== "" && secondary !== "" && primary !== secondary;
}

/**
 * Decode a stored split against the apps that are **currently available**.
 *
 * Returns `null` (never a partial intent) when the value is not an object, either id
 * is missing / not a string / the same as the other / not in `available`. An unknown
 * or absent axis falls back to `"auto"` and an absent/garbage ratio to `50` — those
 * two are *recoverable* nuances, whereas an unavailable pane is not: the shell has no
 * app to put in it. That asymmetry is deliberate.
 */
export function parseSplit(raw: unknown, available: readonly string[]): PersistedSplit | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const { primary, secondary } = o;
  if (typeof primary !== "string" || typeof secondary !== "string") return null;
  if (!isSplittablePair(primary, secondary)) return null;
  if (!available.includes(primary) || !available.includes(secondary)) return null;
  return { primary, secondary, axis: asAxis(o.axis), percent: clampSplitPercent(o.percent) };
}

/** The on-disk shape of a live split (the inverse of `parseSplit`, for a writer that
 * wants to be explicit about the four keys rather than spreading a `Surface`). */
export function encodeSplit(s: PersistedSplit): PersistedSplit {
  return { primary: s.primary, secondary: s.secondary, axis: s.axis, percent: clampSplitPercent(s.percent) };
}
