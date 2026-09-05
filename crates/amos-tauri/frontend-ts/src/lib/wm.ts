/**
 * Multi-window layout bridge: typed wrappers for the Tauri `wm_*` layout/split
 * commands (crates/amos-tauri/src/wm.rs) plus pure helpers a UI uses to render a
 * split screen. Like the other lib modules, wrappers return `null` when not
 * running inside Tauri, so the shell can show a "not connected" state instead of
 * throwing.
 *
 * Wire shapes mirror the Rust `LayoutSnapshot` / `SplitLayoutInfo` / `PaneLayout`.
 */
export type SplitAxis = "vertical" | "horizontal" | string;

export interface PaneLayout {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SplitLayoutInfo {
  axis: SplitAxis;
  percent: number;
  primary: string;
  secondary: string;
  panes: PaneLayout[];
}

export interface LayoutSnapshot {
  screen_w: number;
  screen_h: number;
  split: SplitLayoutInfo | null;
  candidates: string[];
}

interface Bridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen?(channel: string, handler: (e: { payload: unknown }) => void): Promise<() => void>;
}

function bridge(): Bridge | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: Bridge };
  return w && typeof w.__TAURI_INTERNALS__ === "object"
    ? (w.__TAURI_INTERNALS__ as Bridge)
    : null;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  const b = bridge();
  if (!b) return null;
  return (await b.invoke(command, args)) as T;
}

// ---- Command wrappers (null when offline) ----

/** Read the current layout + split state (screen, panes, split candidates). */
export function wmLayoutSnapshot(): Promise<LayoutSnapshot | null> {
  return call<LayoutSnapshot>("wm_layout_snapshot");
}

/** Set the full window area the split layout sub-divides. */
export function wmLayoutSetScreen(width: number, height: number): Promise<LayoutSnapshot | null> {
  return call<LayoutSnapshot>("wm_layout_set_screen", { width, height });
}

/** Enter a split between two windows along an axis (`vertical`|`horizontal`). */
export function wmSplit(
  primary: string,
  secondary: string,
  axis: SplitAxis,
): Promise<LayoutSnapshot | null> {
  return call<LayoutSnapshot>("wm_split", { primary, secondary, axis });
}

/** Set the divider so the primary pane takes `percent` (1..=99). */
export function wmSplitResize(percent: number): Promise<LayoutSnapshot | null> {
  return call<LayoutSnapshot>("wm_split_resize", { percent });
}

/** Move the divider by `delta` percentage points. */
export function wmSplitMove(delta: number): Promise<LayoutSnapshot | null> {
  return call<LayoutSnapshot>("wm_split_move", { delta });
}

/** Swap which window is in the primary pane. */
export function wmSplitSwap(): Promise<LayoutSnapshot | null> {
  return call<LayoutSnapshot>("wm_split_swap");
}

/** End the active split (windows return to fullscreen). */
export function wmSplitExit(): Promise<LayoutSnapshot | null> {
  return call<LayoutSnapshot>("wm_split_exit");
}

/** The window labels the host can offer for entering a split. */
export function wmSplitCandidates(): Promise<string[] | null> {
  return call<string[]>("wm_split_candidates");
}

/** GUI demo: run the split cycle (enter → resize/swap ×2 → exit) on the two front
 * candidates of the real multi-window host. Returns the final snapshot (null offline). */
export function wmSplitDemo(): Promise<LayoutSnapshot | null> {
  return call<LayoutSnapshot>("wm_split_demo");
}

/** Tauri event the Rust host broadcasts after any layout change. */
export const LAYOUT_CHANGED_EVENT = "layout-changed";

/**
 * Subscribe to layout changes broadcast by the host (so non-initiating windows /
 * surfaces refresh without their own command round-trip). Payloads are normalized
 * before `handler` runs. Resolves to an unsubscribe function; a no-op when the
 * bridge has no `listen` (offline / host build).
 */
export function onLayoutChanged(
  handler: (snap: LayoutSnapshot) => void,
): Promise<() => void> {
  const b = bridge();
  if (!b || typeof b.listen !== "function") {
    return Promise.resolve(() => {});
  }
  const registered = b.listen(LAYOUT_CHANGED_EVENT, (e) => {
    handler(normalizeLayout(e.payload));
  });
  // Defensive: the real Tauri bridge returns a Promise<unlisten>, but treat a
  // plain function (test double / older host) as already-unsubscribable.
  if (registered && typeof (registered as { then?: unknown }).then === "function") {
    return (registered as Promise<() => void>).catch(() => () => {});
  }
  return Promise.resolve(registered as unknown as () => void);
}

// ---- Pure model helpers (render the split deterministically) ----

/** Coerce a raw `wm_layout_snapshot` payload into a typed view (never throws). */
export function normalizeLayout(raw: unknown): LayoutSnapshot {
  const s = (raw ?? {}) as Partial<LayoutSnapshot>;
  const split = s.split;
  return {
    screen_w: num(s.screen_w, 0),
    screen_h: num(s.screen_h, 0),
    split: split
      ? {
          axis: split.axis ?? "vertical",
          percent: pct(split.percent),
          primary: split.primary ?? "",
          secondary: split.secondary ?? "",
          panes: Array.isArray(split.panes) ? (split.panes as PaneLayout[]) : [],
        }
      : null,
    candidates: Array.isArray(s.candidates) ? (s.candidates as string[]) : [],
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** A divider percent must be 1..=99; anything else falls back to 50. */
function pct(v: unknown): number {
  const n = num(v, 50);
  return n >= 1 && n <= 99 ? n : 50;
}

/** Is a split currently active? */
export function splitActive(s: LayoutSnapshot): boolean {
  return s.split !== null && s.split.panes.length >= 2;
}

/** Is `label` one of the two split windows? */
export function isInSplit(s: LayoutSnapshot, label: string): boolean {
  const sp = s.split;
  return !!sp && (sp.primary === label || sp.secondary === label);
}

/** The window in the primary (first) pane, or `null` when no split. */
export function primaryWindow(s: LayoutSnapshot): string | null {
  return s.split ? s.split.primary : null;
}

/** The window in the secondary (second) pane, or `null` when no split. */
export function secondaryWindow(s: LayoutSnapshot): string | null {
  return s.split ? s.split.secondary : null;
}

/** Should `label` be rendered at all right now? In split mode only the two split
 * windows are visible; in fullscreen (no split) every surface is shown whole. */
export function isVisibleSurface(s: LayoutSnapshot, label: string): boolean {
  return !s.split || isInSplit(s, label);
}

/** The pane rect for a split window (best effort; pane order may change on swap). */
export function paneFor(s: LayoutSnapshot, label: string): PaneLayout | null {
  const sp = s.split;
  if (!sp) return null;
  return sp.panes.find((p) => p.label === label) ?? null;
}

/**
 * The rect a surface should render into, or `null` when it should be hidden:
 * * split active → its pane, or `null` if the surface is not one of the two split
 *   windows (it must not cover the split);
 * * no split (fullscreen) → the whole screen.
 * Screen origin is (0,0) with `screen_w × screen_h`.
 */
export function rectForLabel(s: LayoutSnapshot, label: string): PaneLayout | null {
  if (s.split) return paneFor(s, label);
  return { label, x: 0, y: 0, width: s.screen_w, height: s.screen_h };
}

/** A surface plus the rect it should occupy right now. */
export interface SurfacePlacement {
  label: string;
  rect: PaneLayout;
}

/**
 * Decide which of `labels` are visible and where each goes, in paint order.
 * * split active → the two split windows (primary then secondary pane);
 * * fullscreen → each supplied label shown whole (callers usually pass the one
 *   focused surface).
 * Hidden (non-split-window) labels are excluded so they never cover the stage.
 */
export function layoutSurfaces(s: LayoutSnapshot, labels: string[]): SurfacePlacement[] {
  if (s.split) {
    const out: SurfacePlacement[] = [];
    for (const label of [s.split.primary, s.split.secondary]) {
      const rect = paneFor(s, label);
      if (rect) out.push({ label, rect });
    }
    return out;
  }
  return labels
    .filter((label) => isVisibleSurface(s, label))
    .map((label) => ({ label, rect: rectForLabel(s, label)! }));
}

/** CSS pixels for absolutely-positioning a pane inside the shell. */
export function paneCss(p: PaneLayout): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  return { left: p.x, top: p.y, width: p.width, height: p.height };
}

/** Human label, e.g. `"a ⇆ b · vertical @ 50%"`. */
export function describeSplit(sp: SplitLayoutInfo | null): string {
  if (!sp) return "fullscreen";
  return `${sp.primary} ⇆ ${sp.secondary} · ${sp.axis} @ ${sp.percent}%`;
}
