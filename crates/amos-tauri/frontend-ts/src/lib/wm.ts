/**
 * Multi-window layout bridge: typed wrappers for the Tauri `wm_*` layout/split
 * commands (crates/amos-tauri/src/wm.rs) plus pure helpers a UI uses to render a
 * split screen. Like the other lib modules, wrappers return `null` when not
 * running inside Tauri, so the shell can show a "not connected" state instead of
 * throwing.
 *
 * They delegate to `lib/backend.ts`'s `invoke` (the single source of truth for
 * "call a command"): it returns `null` **and records the failure in the
 * diagnostics ledger** when a command errors. A local re-implementation that
 * awaited `__TAURI_INTERNALS__.invoke` directly looked equivalent but was not — a
 * failing command (Rust `Err`, e.g. "split geometry is not available") **rejected**
 * the promise, so every consumer that did not hand-roll a `.catch` produced an
 * unhandled rejection and the failure never reached the ledger the UI reads
 * (REQ-A220).
 *
 * Wire shapes mirror the Rust `LayoutSnapshot` / `SplitLayoutInfo` / `PaneLayout`
 * (plus the form-factor capability fields: class, content columns, multi-window,
 * free resize, divider width).
 */
import { bridgeDiag, invoke, subscribe } from "./backend";
import type { BridgeDiag } from "./backend";

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
  /** Device class the host resolved at startup (`AMOS_FORM_FACTOR` or its build). */
  form: FormFactor;
  /** Content columns the current screen width supports (1..=4) — the runtime
   * phone-vs-tablet signal (`amos_wm::form::LayoutPolicy::columns_for`). */
  columns: number;
  /** May this class show more than one app window at once? */
  multi_window: boolean;
  /** May the user freely move/resize windows on this class? */
  free_resize: boolean;
  /** Divider width between two split panes (px). */
  divider_gap: number;
}

/** Device class the host runs as (`crates/amos-wm/src/form.rs`). */
export type FormFactor = "phone" | "tablet" | "desktop" | "robot";

// ---- Command wrappers (null when offline **or** when the command fails) ----

/** Read the current layout + split state (screen, panes, split candidates). */
export function wmLayoutSnapshot(): Promise<LayoutSnapshot | null> {
  return invoke<LayoutSnapshot>("wm_layout_snapshot");
}

/**
 * Name the window this runs in — on macOS, what **its** title bar shows.
 *
 * The target is the **calling** window (the host injects it, REQ-A428): an app window
 * names itself, the launcher window names itself. That distinction matters because
 * `Shell.svelte`'s title effect runs in every window, and before REQ-A428 the host named
 * the launcher no matter which window asked — so an app window's localized name landed on
 * the desktop window while the app window kept its label-derived English name (measured on
 * a live launch: `Settings | 236,69` and `设置 | 0,29` for the launcher).
 *
 * `title` is the localized name of the app that is on screen, or `null` for the surfaces
 * that are the shell itself (launcher / lock / edit / library). `null` does **not** mean
 * "empty": the host restores the name that window was created with — the configured
 * product title for the launcher, the app's own name for an app window — so the product
 * name lives in exactly one place (`tauri.conf.json`) instead of a second copy here (the
 * rule REQ-A234 applied to the launcher label).
 *
 * Resolves to the title the host actually applied (a long third-party display name is
 * truncated host-side, with a visible `…`), or `null` when there is no host / the call
 * failed: a caller that asked for a name can then tell whether it got that name.
 */
export function wmSetShellTitle(title: string | null): Promise<string | null> {
  return invoke<string>("wm_set_shell_title", { title });
}

/** Set the full window area the split layout sub-divides. */
export function wmLayoutSetScreen(width: number, height: number): Promise<LayoutSnapshot | null> {
  return invoke<LayoutSnapshot>("wm_layout_set_screen", { width, height });
}

/**
 * Draw the **native menu bar** in the shell's language (REQ-A437).
 *
 * The menu bar is rendered by the host (AppKit), so a UI language change has to reach it: the
 * host rebuilds its tree and answers with the locale it applied, or `null` when there is no
 * host (a browser preview) — never silently pretending.
 */
export function menuSetLocale(locale: string): Promise<string | null> {
  return invoke<string>("menu_set_locale", { locale });
}

/** Enter a split between two windows along an axis (`vertical`|`horizontal`). */
/** Enter a split between two windows (`axis`: `vertical` | `horizontal` | `auto`,
 * where `auto` lets the host pick from the screen's aspect). */
export function wmSplit(
  primary: string,
  secondary: string,
  axis: SplitAxis,
): Promise<LayoutSnapshot | null> {
  return invoke<LayoutSnapshot>("wm_split", { primary, secondary, axis });
}

/** Set the divider so the primary pane takes `percent` (1..=99). */
export function wmSplitResize(percent: number): Promise<LayoutSnapshot | null> {
  return invoke<LayoutSnapshot>("wm_split_resize", { percent });
}

/** Move the divider by `delta` percentage points. */
export function wmSplitMove(delta: number): Promise<LayoutSnapshot | null> {
  return invoke<LayoutSnapshot>("wm_split_move", { delta });
}

/** Swap which window is in the primary pane. */
export function wmSplitSwap(): Promise<LayoutSnapshot | null> {
  return invoke<LayoutSnapshot>("wm_split_swap");
}

/** End the active split (windows return to fullscreen). */
export function wmSplitExit(): Promise<LayoutSnapshot | null> {
  return invoke<LayoutSnapshot>("wm_split_exit");
}

// ---- Individual window commands ----
//
// REQ-A415 — these four return `Promise<boolean>`, and the promise now really resolves
// to a boolean. The old bodies were `(await invoke<boolean>(cmd, { label })) ?? false`:
// the *host* answers `wm_open`/`wm_focus`/`wm_hide`/`wm_close` with a `WmSnapshot`
// (`Result<WmSnapshot, String>` in `crates/amos-tauri/src/wm.rs`), so on success the
// value was a **snapshot object**, not `true` — the declared type was a lie that only
// stayed hidden because every caller happened to write `void wmX(...)`. The honest
// derivation is the null check: `lib/backend`'s `invoke` resolves `null` for "no bridge
// / the command failed" and never for success, so `!== null` is exactly "did it land".

/** Open (show) a named app window. `false` = no bridge, or the host refused. */
export async function wmOpen(label: string): Promise<boolean> {
  return (await invoke<unknown>("wm_open", { label })) !== null;
}

/** Close a named app window. `false` = no bridge, or the host refused. */
export async function wmClose(label: string): Promise<boolean> {
  return (await invoke<unknown>("wm_close", { label })) !== null;
}

/** Hide a named app window (minimize off-screen). `false` = no bridge, or refused. */
export async function wmHide(label: string): Promise<boolean> {
  return (await invoke<unknown>("wm_hide", { label })) !== null;
}

/** Bring a named app window to the front and focus it. `false` = no bridge, or refused. */
export async function wmFocus(label: string): Promise<boolean> {
  return (await invoke<unknown>("wm_focus", { label })) !== null;
}

/**
 * Zoom a named app window — the Window menu's **Zoom** (maximize ⇄ restore).
 *
 * REQ-A415: the host had no such command, so the shell's `menu.zoom` branch was an
 * explicit no-op. `false` = no bridge, the window is gone, or the host refused (a split
 * pane's rectangle belongs to the split — see `crates/amos-tauri/src/wm.rs::wm_zoom`).
 */
export async function wmZoom(label: string): Promise<boolean> {
  return (await invoke<unknown>("wm_zoom", { label })) !== null;
}

/** Toggle full screen on a named app window. `false` = no bridge, or refused. */
export async function wmFullscreen(label: string): Promise<boolean> {
  return (await invoke<unknown>("wm_fullscreen", { label })) !== null;
}

/**
 * Toggle maximize ⇄ restore on a named app window — the **title bar's double-click**.
 *
 * G-α: macOS users double-click a window's title bar to toggle maximize; with
 * `title_bar_style(Overlay)` the host already accepts the underlying Tauri call, but
 * the shell never wired the gesture. The host refuses for split panes (their
 * rectangle belongs to the split) and for windows that have been closed since the
 * 5 s `wm_windows` poll — a refused call is recorded in `bridgeDiag("wm_maximize")`,
 * not swallowed (the REQ-A297 phase-2 §4 typed-error discipline).
 *
 * `false` = no bridge, the window is gone, or the host refused.
 */
export async function wmMaximize(label: string): Promise<boolean> {
  return (await invoke<unknown>("wm_maximize", { label })) !== null;
}

// ---- Diagnostic-aware variants (for callers that need bridgeDiag on failure) ----
// These return `null` on failure so callers can distinguish "host refused" from
// "offline". The plain `wmOpen`/`wmClose`/`wmHide`/`wmFocus` variants above are
// for fire-and-forget calls that don't need diagnostics.

/** Open + get the diagnostics record on failure. Returns `null` when the bridge
 * is unavailable or the command failed (use `bridgeDiag("wm_open")` for the reason). */
export async function wmOpenWithDiag(
  label: string,
): Promise<{ ok: true } | { ok: false; diag: BridgeDiag }> {
  const result = await invoke<unknown>("wm_open", { label });
  if (result !== null) return { ok: true };
  return { ok: false, diag: bridgeDiag("wm_open") };
}

/** Close + get the diagnostics record on failure. */
export async function wmCloseWithDiag(
  label: string,
): Promise<{ ok: true } | { ok: false; diag: BridgeDiag }> {
  const result = await invoke<unknown>("wm_close", { label });
  if (result !== null) return { ok: true };
  return { ok: false, diag: bridgeDiag("wm_close") };
}

/** Hide + get the diagnostics record on failure. */
export async function wmHideWithDiag(
  label: string,
): Promise<{ ok: true } | { ok: false; diag: BridgeDiag }> {
  const result = await invoke<unknown>("wm_hide", { label });
  if (result !== null) return { ok: true };
  return { ok: false, diag: bridgeDiag("wm_hide") };
}

/** Focus + get the diagnostics record on failure. */
export async function wmFocusWithDiag(
  label: string,
): Promise<{ ok: true } | { ok: false; diag: BridgeDiag }> {
  const result = await invoke<unknown>("wm_focus", { label });
  if (result !== null) return { ok: true };
  return { ok: false, diag: bridgeDiag("wm_focus") };
}

/** The window labels the host can offer for entering a split: the front two shown
 * windows it **owns** (a `legacy:*` container surface has no window to place, so it is
 * never offered — REQ-A226). */
export function wmSplitCandidates(): Promise<string[] | null> {
  return invoke<string[]>("wm_split_candidates");
}

/** GUI demo: run the split cycle (enter → resize/swap ×2 → exit) on the two front
 * candidates of the real multi-window host. Returns the final snapshot (null offline). */
export function wmSplitDemo(): Promise<LayoutSnapshot | null> {
  return invoke<LayoutSnapshot>("wm_split_demo");
}

/** Tauri event the Rust host broadcasts after any layout change. */
export const LAYOUT_CHANGED_EVENT = "layout-changed";

// ---- Window list (`wm_windows`) ----

/** One window in the host's `wm_windows` snapshot (Rust `wm::WindowInfo`). */
export interface WmWindowInfo {
  id: number;
  label: string;
  /** `"Launcher"` | `"App"` | `"System"` — the host's own spelling. */
  kind: string;
  /** `"Hidden"` | `"Shown"` | `"Focused"`. */
  state: string;
  focused: boolean;
  /**
   * True for a composited container surface that has **no** `WebviewWindow`
   * (e.g. `legacy:<window_id>`, see `docs/android-compat.md`): it participates in
   * focus/z-order but is owned by the container, not by this process.
   */
  external: boolean;
}

/** The host's whole windowing state (Rust `wm::WmSnapshot`). */
export interface WmWindowsSnapshot {
  focused: number | null;
  windows: WmWindowInfo[];
}

/**
 * Read the host's window list (`wm_windows`).
 *
 * `null` when not bridged or when the command failed — `lib/backend.ts`'s `invoke`
 * records the failure in the diagnostics ledger and never rejects. A payload that
 * *did* arrive is **narrowed, never trusted** (see [`normalizeWindows`]), so a
 * debug surface cannot invent a window the host does not have.
 */
export async function wmWindows(): Promise<WmWindowsSnapshot | null> {
  const raw = await invoke<unknown>("wm_windows");
  return raw === null || raw === undefined ? null : normalizeWindows(raw);
}

/**
 * Coerce a raw `wm_windows` payload into the typed view (never throws).
 *
 * A record without a usable `label` is **dropped** (an unnamed window cannot be
 * addressed by any command), and every other field falls back to the most
 * conservative value — the same rule `normalizeLayout` follows for capabilities.
 */
export function normalizeWindows(raw: unknown): WmWindowsSnapshot {
  const s = (raw ?? {}) as { focused?: unknown; windows?: unknown };
  const windows = Array.isArray(s.windows)
    ? s.windows.map(windowOf).filter((w): w is WmWindowInfo => w !== null)
    : [];
  return {
    focused: typeof s.focused === "number" && Number.isFinite(s.focused) ? s.focused : null,
    windows,
  };
}

/** One window record, or `null` when the payload carries no usable label. */
function windowOf(v: unknown): WmWindowInfo | null {
  const w = (v ?? {}) as Partial<WmWindowInfo>;
  if (typeof w.label !== "string" || w.label === "") return null;
  return {
    id: num(w.id, 0),
    label: w.label,
    kind: typeof w.kind === "string" && w.kind !== "" ? w.kind : "Unknown",
    state: typeof w.state === "string" ? w.state : "",
    focused: bool(w.focused, false),
    external: bool(w.external, false),
  };
}

/**
 * Subscribe to layout changes broadcast by the host (so non-initiating windows /
 * surfaces refresh without their own command round-trip). Payloads are normalized
 * before `handler` runs. Resolves to an unsubscribe function; a no-op when the
 * bridge cannot subscribe (offline / host build).
 *
 * Delegates to the shared `subscribe` helper: Tauri v2 injects no `listen` on
 * `__TAURI_INTERNALS__`, so a local `b.listen` call here was silently dead on
 * device (the bridge now synthesizes one through the event plugin).
 */
export function onLayoutChanged(
  handler: (snap: LayoutSnapshot) => void,
): Promise<() => void> {
  return subscribe(LAYOUT_CHANGED_EVENT, (payload) => handler(normalizeLayout(payload)));
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
    // Form-factor capabilities: never gained from a malformed payload (see the
    // helpers), so an unreadable snapshot degrades to the phone/1-column view.
    form: formOf(s.form),
    columns: cols(s.columns),
    multi_window: bool(s.multi_window, false),
    free_resize: bool(s.free_resize, false),
    divider_gap: gap(s.divider_gap),
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

const FORM_FACTORS: readonly FormFactor[] = ["phone", "tablet", "desktop", "robot"];

/** An unknown / missing class reads as `phone`, the most restrictive one: a
 * capability must never be *gained* by a malformed payload. */
function formOf(v: unknown): FormFactor {
  return typeof v === "string" && (FORM_FACTORS as readonly string[]).includes(v)
    ? (v as FormFactor)
    : "phone";
}

/** Content columns are bounded 1..=4 (docs: `LayoutPolicy::columns_for`). */
function cols(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 4
    ? Math.trunc(v)
    : 1;
}

/** A divider width must be plausible; anything else falls back to the 8px default. */
function gap(v: unknown): number {
  const n = num(v, 8);
  return n >= 0 && n <= 64 ? Math.trunc(n) : 8;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
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

/**
 * The shared-store key the **host** writes when window focus changes
 * (`crates/amos-tauri/src/store.rs::APP_FOCUSED_KEY`, written on
 * `WmEvent::FocusChanged`).
 *
 * It lives here — next to `LAYOUT_CHANGED_EVENT`, in the module that owns the wm
 * protocol — so the desktop chrome (TopBar) imports the name instead of spelling
 * the literal a second time (a re-spelled key is how `amos.files.fav` drifted away
 * from `FILES_FAV_KEY` and silently missed every backup; see
 * `scripts/store-scan.mjs`).
 *
 * The host writes this key on every focus change; the desktop chrome reads **the
 * store** (not an event): one source, and `createStoreValue` already re-renders on
 * the `store-updated` broadcast. A dedicated `app-focused-changed` event used to be
 * emitted alongside it and was removed in REQ-A254 — `tauri-event-scan` reported it
 * as emitted-without-subscriber, and an exported `APP_FOCUSED_EVENT` constant here
 * had already been failed by `unwired-scan` for the same reason.
 */
export const APP_FOCUSED_KEY = "amos.app_focused";
