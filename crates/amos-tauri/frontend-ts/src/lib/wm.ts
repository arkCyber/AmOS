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
 * free resize, divider width). This declared mirror is bound to the Rust structs by
 * `src/__tests__/declaredMirrors.test.ts` ("wm.ts layout wire shapes == the
 * amos-tauri::wm serde structs", REQ-A667), which reads `crates/amos-tauri/src/wm.rs`.
 */
import { bridgeDiag, bridged, invoke, subscribe } from "./backend";
import type { BridgeDiag } from "./backend";
import type { SnapZone } from "./snapZones";
import { appOfWindowLabel, splitWindowLabel } from "./windowRoute";

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
  /**
   * Width of the Stage Manager rail the stage loses off its **left edge** (px), or `0`
   * when there is no rail — the mode is off, this class has none, or the screen is too
   * narrow to afford one beside a minimum pane.
   *
   * The one number the desktop shell lays out **around**: the rail's own width and the
   * left inset of the desktop icon grid. It is here rather than on `StageSnapshot`
   * because it is policy-derived geometry (like `divider_gap` and `columns` beside it) and
   * because the `layout-changed` push is the channel that already fires when it changes,
   * so a shell reads it exactly once.
   */
  rail_width: number;
}

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

/**
 * Make the **native menu bar's** accelerators follow the shell's key bindings (REQ-A485).
 *
 * The host builds its rows with literal accelerators; a rebound or disabled chord would leave those
 * rows advertising a key the shell no longer matches (or, worse, one the user turned off). The host
 * answers with the number of rows it updated, or `null` when there is no host (a browser preview) —
 * never silently pretending. `null` values in the payload mean "this binding is off".
 */
export function menuSetShortcuts(
  shortcuts: Record<string, string | null>,
): Promise<number | null> {
  return invoke<number>("menu_set_shortcuts", { shortcuts });
}

/**
 * Set the divider so the primary pane takes `percent` (1..=99).
 *
 * REQ-A1707 — the rest of this family (`wm_split`, `wm_split_move`, `wm_split_swap`,
 * `wm_split_exit`) has only the [`wmSplitWithDiag`] form: the Settings window page is the
 * sole caller of each and needs the typed refusal, so a plain twin was a second API nobody
 * called. They were kept alive by their own doc comments alone until `unwired-scan` learned
 * to ignore `//` mentions. This one is a different case — it is already an accepted
 * `scripts/unwired-baseline.json` entry with a test-only caller — so it stays.
 */
export function wmSplitResize(percent: number): Promise<LayoutSnapshot | null> {
  return invoke<LayoutSnapshot>("wm_split_resize", { percent });
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
//
// REQ-A555 — the generic now **names the reply the host really sends**. It was `unknown`
// here (and at 11 other call sites in this file), which is not a lie about the value but
// *was* a blind spot in the wire audit: `scripts/tauri-reply-scan.mjs` can only compare a
// reply whose TS type it can resolve, so "the shell reads `wm_open`'s reply as `unknown`"
// counted as unverifiable — the host's shape was never checked against anything. Every
// `wm_*` window command answers `Result<WmSnapshot, String>` and the TS name for that
// shape is `WmWindowsSnapshot` (declared below, next to the other window types), so the
// 10 call sites agree with `wm::WmSnapshot` by construction *and* the gate can now say so.

/** Open (show) a named app window. `false` = no bridge, or the host refused. */
export async function wmOpen(label: string): Promise<boolean> {
  return (await invoke<WmWindowsSnapshot>("wm_open", { label })) !== null;
}

/**
 * {@link wmOpen} for the chrome with nowhere on screen to draw a refusal — the Dock's
 * app / Finder / trash tiles, its overflow list, and its Settings shortcut.
 *
 * The host refuses `wm_open` for reasons a user reaches without a bug: an id the identity
 * model does not know (`wm.rs::WmState::open` → `identity_of_label`), a label naming a
 * window that is not the app's **first** instance (REQ-A473), or the class's
 * `multi_window` cap (`check_new_app_window`). `invoke` never rejects — it records the
 * reason in the per-command diagnosis and answers `null` — so `wmOpen` folds it into
 * `false`, and a tile that discards that boolean leaves a **dead click plus a ledger entry
 * nobody reads**. `DockFinderItem`'s own comment stated the belief that made this look
 * safe: 「a failure is recorded in the diagnostics ledger by `lib/backend` and needs no
 * handler here」. *Recorded* is not *read*: `lib/debugLog`'s header calls console output
 * the primary instrument for "why is X not rendering on the device" questions, and every
 * other entry point to this same act says so out loud — `Launchpad.openApp`, the
 * notification centre, both top-bar menus, `SpotlightOverlay`, and, on the very same Dock,
 * `DockContextMenu.noteFailure`. This is that report, once, for the callers that had none:
 * one message shape, and a `surface` tag saying which one died (REQ-A1176 / FMEA F-SH-469).
 */
export async function wmOpenReported(label: string, surface: string): Promise<boolean> {
  const ok = await wmOpen(label);
  if (ok) return true;
  const diag = bridgeDiag("wm_open");
  if (diag.ok) return false; // invariant: a null result implies a recorded failure
  const code =
    diag.kind === "command-failed" && diag.detail && typeof diag.detail === "object"
      ? (diag.detail as { code?: string }).code
      : undefined;
  console.warn(`🛟 [${surface}] wm_open(${label}) refused`, code ?? diag.kind);
  return false;
}

/** Hide a named app window (minimize off-screen). `false` = no bridge, or refused. */
export async function wmHide(label: string): Promise<boolean> {
  return (await invoke<WmWindowsSnapshot>("wm_hide", { label })) !== null;
}

/**
 * Zoom a named app window — the Window menu's **Zoom** (maximize ⇄ restore).
 *
 * REQ-A415: the host had no such command, so the shell's `menu.zoom` branch was an
 * explicit no-op. `false` = no bridge, the window is gone, or the host refused (a split
 * pane's rectangle belongs to the split — see `crates/amos-tauri/src/wm.rs::wm_zoom`).
 */
export async function wmZoom(label: string): Promise<boolean> {
  return (await invoke<WmWindowsSnapshot>("wm_zoom", { label })) !== null;
}

/** Toggle full screen on a named app window. `false` = no bridge, or refused. */
export async function wmFullscreen(label: string): Promise<boolean> {
  return (await invoke<WmWindowsSnapshot>("wm_fullscreen", { label })) !== null;
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
  return (await invoke<WmWindowsSnapshot>("wm_maximize", { label })) !== null;
}

// ---- Diagnostic-aware variants (for callers that need bridgeDiag on failure) ----
// These return `null` on failure so callers can distinguish "host refused" from
// "offline". The plain `wmOpen` / `wmHide` variants above are for fire-and-forget
// calls that don't need diagnostics; `wm_close` / `wm_focus` / `wm_minimize` have
// no plain twin at all (REQ-A1707 — their only callers are menus, chords and
// Mission Control, all of which report a refusal).

/**
 * Open **one more** window of the application `appId` (File ▸ New Window / ⌘N).
 *
 * REQ-A473. The host allocates the window's own label (lowest free instance number,
 * bounded) and returns the new snapshot — the caller names the **app**, never a window
 * label, so no UI can mint an arbitrary platform label.
 *
 * Only this diagnostics-aware form exists on purpose: every caller is a menu row or a
 * chord, both of which must be able to say **why** nothing happened (`host-refused`), so a
 * plain fire-and-forget twin would be a second API nothing calls (`unwired-scan` is the
 * gate that keeps those out).
 */
export async function wmNewWindowWithDiag(
  appId: string,
): Promise<{ ok: true } | { ok: false; diag: BridgeDiag }> {
  const result = await invoke<WmWindowsSnapshot>("wm_new_window", { appId });
  if (result !== null) return { ok: true };
  return { ok: false, diag: bridgeDiag("wm_new_window") };
}

/**
 * Focus the next (`forward: true`) or previous window **of `appId`** — macOS's ⌘` / ⌘⇧`.
 *
 * REQ-A473. Refused with a reason when the app has fewer than two windows: a "successful"
 * cycle that moved nothing is exactly the dead-chord shape the shell reports instead of
 * hiding (`desktopSystemKeys.deadChordMessage`). Diag-only, like
 * [`wmNewWindowWithDiag`] and for the same reason.
 */
export async function wmCycleAppWithDiag(
  appId: string,
  forward: boolean,
): Promise<{ ok: true } | { ok: false; diag: BridgeDiag }> {
  const result = await invoke<WmWindowsSnapshot>("wm_cycle_app", { appId, forward });
  if (result !== null) return { ok: true };
  return { ok: false, diag: bridgeDiag("wm_cycle_app") };
}

/**
 * There is deliberately **no** `wmAppOfLabel` wrapper here (REQ-A473's first draft had
 * one, removed in the same change): the host already reports every window's `app`/`instance`
 * in `wm_windows` — that is the one channel — and the boot route has to resolve a label
 * **before** any round trip is possible, which is `lib/windowRoute.ts`' job (its tests pin
 * the spelling to the Rust scheme). A wrapper nothing calls would be a dead capability on
 * both sides of the bridge.
 */

/** Open + get the diagnostics record on failure. Returns `null` when the bridge
 * is unavailable or the command failed (use `bridgeDiag("wm_open")` for the reason). */
export async function wmOpenWithDiag(
  label: string,
): Promise<{ ok: true } | { ok: false; diag: BridgeDiag }> {
  const result = await invoke<WmWindowsSnapshot>("wm_open", { label });
  if (result !== null) return { ok: true };
  return { ok: false, diag: bridgeDiag("wm_open") };
}

/** Close + get the diagnostics record on failure. */
export async function wmCloseWithDiag(
  label: string,
): Promise<{ ok: true } | { ok: false; diag: BridgeDiag }> {
  const result = await invoke<WmWindowsSnapshot>("wm_close", { label });
  if (result !== null) return { ok: true };
  return { ok: false, diag: bridgeDiag("wm_close") };
}

/** Hide + get the diagnostics record on failure. */
export async function wmHideWithDiag(
  label: string,
): Promise<{ ok: true } | { ok: false; diag: BridgeDiag }> {
  const result = await invoke<WmWindowsSnapshot>("wm_hide", { label });
  if (result !== null) return { ok: true };
  return { ok: false, diag: bridgeDiag("wm_hide") };
}

/**
 * Minimize a named app window — the **Minimize** menu row (⌘M) — plus the diagnostics record.
 *
 * REQ-A714: deliberately **not** {@link wmHideWithDiag}. ⌘M used to hide, so the window left
 * both the screen and the model and every model reader reported the app as closed (the
 * Dock's running dot went dark — `docs/DESKTOP_GAP_ANALYSIS_2026_SEP20.md` §2 A1). Here
 * the *platform* minimizes and the model is untouched, so the window stays in
 * `wm_windows`, the Dock keeps its dot, Mission Control still lists it, and focusing it
 * (the Dock tile, ⌘N) un-minimizes it (`crates/amos-tauri/src/wm.rs::WmState::minimize`,
 * REQ-A441's `reveal_window`).
 *
 * REQ-A724: the chord dispatcher needs the same refusal reporting the other focused-window
 * commands have — a ⌘M the host declines must be distinguishable from one that worked,
 * exactly as {@link wmHideWithDiag} / {@link wmFocusWithDiag} already are.
 */
export async function wmMinimizeWithDiag(
  label: string,
): Promise<{ ok: true } | { ok: false; diag: BridgeDiag }> {
  const result = await invoke<WmWindowsSnapshot>("wm_minimize", { label });
  if (result !== null) return { ok: true };
  return { ok: false, diag: bridgeDiag("wm_minimize") };
}

/** Focus + get the diagnostics record on failure. */
export async function wmFocusWithDiag(
  label: string,
): Promise<{ ok: true } | { ok: false; diag: BridgeDiag }> {
  const result = await invoke<WmWindowsSnapshot>("wm_focus", { label });
  if (result !== null) return { ok: true };
  return { ok: false, diag: bridgeDiag("wm_focus") };
}

// ---- Split commands — diagnostic-aware variants -----------------------------
//
// Each split command's only caller is the Settings window page, which must be able
// to **report why nothing happened** — it has to tell "no bridge" from "host
// refused" rather than silently dropping both into `null`.
//
// These `…WithDiag` variants carry the same REQ-A513 / F-SH-053 discipline the
// session and window commands already use: `{ ok: true }` means the host **did**
// the action, `{ ok: false, diag }` carries the typed reason (always available,
// so the caller can choose between logging / toasting / retrying).
//
// Only the diag form exists for these commands because there is no
// fire-and-forget call site; a plain twin would be a second API nothing calls.
// (REQ-A1707 — `wm_split` / `wm_split_move` / `wm_split_swap` / `wm_split_exit`
// each had such a twin, kept alive by nothing but the sentence that used to sit
// here. `wm_split_resize` above is the exception: it is already an accepted
// `unwired-baseline.json` entry with a test-only caller.)
//
// **Why these derive the kind themselves instead of reading `bridgeDiag`** — a bridge that
// resolves `null` *without* throwing is a "the host answered and refused" fact, which the
// ledger records as `ok: true` (it only writes `command-failed` when the bridge *throws*).
// `host-refused-null` carries that distinct fact. Honest caveat: the split / snap commands
// answer `Result<T, String>`, so a host `Err` reaches JS as a **rejected** promise (Tauri
// routes `Err` to the error callback — `tauri/src/ipc/mod.rs`), i.e. `command-failed`, not a
// resolved `null`; these wrappers label that case `host-refused-null` and drop the detail
// (the one renderer, `settings/WindowPage.svelte`, paints both kinds the same, so nothing
// user-visible turns on it). Recorded, not fixed, in `docs/DESKTOP_AUDIT_2026_SEP21.md` §8.14.

/** Diagnostics record a `…WithDiag` wrapper hands back on failure: the ledger's own shapes
 *  plus `host-refused-null`, the "the bridge resolved `null`" case above. */
export type WmReplyDiag =
  | BridgeDiag
  | { ok: false; kind: "host-refused-null"; command: string };

/** Enter a split + get the diagnostics record on failure.
 *
 *  `primary` / `secondary` are window labels the host already knows about (the
 *  Settings page reads them from `wm_split_candidates`); `axis` is
 *  `vertical` / `horizontal` / `auto` (`auto` lets the host pick from the real
 *  screen's aspect). Resolves to the post-split snapshot on success. */
export async function wmSplitWithDiag(
  primary: string,
  secondary: string,
  axis: SplitAxis,
): Promise<
  | { ok: true; snapshot: LayoutSnapshot }
  | { ok: false; diag: WmReplyDiag }
> {
  if (!bridged()) {
    return { ok: false, diag: { ok: false, kind: "not-bridged", command: "wm_split" } };
  }
  try {
    const snapshot = await invoke<LayoutSnapshot>("wm_split", { primary, secondary, axis });
    if (snapshot) return { ok: true, snapshot };
    return { ok: false, diag: { ok: false, kind: "host-refused-null", command: "wm_split" } };
  } catch (err) {
    return {
      ok: false,
      diag: { ok: false, kind: "command-failed", command: "wm_split", detail: err },
    };
  }
}

/** Move the divider by `delta` percentage points + get the diagnostics record. */
export async function wmSplitMoveWithDiag(
  delta: number,
): Promise<
  | { ok: true; snapshot: LayoutSnapshot }
  | { ok: false; diag: WmReplyDiag }
> {
  if (!bridged()) {
    return { ok: false, diag: { ok: false, kind: "not-bridged", command: "wm_split_move" } };
  }
  try {
    const snapshot = await invoke<LayoutSnapshot>("wm_split_move", { delta });
    if (snapshot) return { ok: true, snapshot };
    return { ok: false, diag: { ok: false, kind: "host-refused-null", command: "wm_split_move" } };
  } catch (err) {
    return {
      ok: false,
      diag: { ok: false, kind: "command-failed", command: "wm_split_move", detail: err },
    };
  }
}

/** Swap the primary and secondary panes + get the diagnostics record. */
export async function wmSplitSwapWithDiag(): Promise<
  { ok: true; snapshot: LayoutSnapshot } | { ok: false; diag: WmReplyDiag }
> {
  if (!bridged()) {
    return { ok: false, diag: { ok: false, kind: "not-bridged", command: "wm_split_swap" } };
  }
  try {
    const snapshot = await invoke<LayoutSnapshot>("wm_split_swap");
    if (snapshot) return { ok: true, snapshot };
    return { ok: false, diag: { ok: false, kind: "host-refused-null", command: "wm_split_swap" } };
  } catch (err) {
    return {
      ok: false,
      diag: { ok: false, kind: "command-failed", command: "wm_split_swap", detail: err },
    };
  }
}

/** End the active split + get the diagnostics record. */
export async function wmSplitExitWithDiag(): Promise<
  { ok: true; snapshot: LayoutSnapshot } | { ok: false; diag: WmReplyDiag }
> {
  if (!bridged()) {
    return { ok: false, diag: { ok: false, kind: "not-bridged", command: "wm_split_exit" } };
  }
  try {
    const snapshot = await invoke<LayoutSnapshot>("wm_split_exit");
    if (snapshot) return { ok: true, snapshot };
    return { ok: false, diag: { ok: false, kind: "host-refused-null", command: "wm_split_exit" } };
  } catch (err) {
    return {
      ok: false,
      diag: { ok: false, kind: "command-failed", command: "wm_split_exit", detail: err },
    };
  }
}

// ---- Window snapping (`wm_snap`) --------------------------------------------
//
// The rectangle the host placed a window in — Rust `amos_wm::layout::Bounds`, which is
// what `wm_snap` answers with (unlike the other window commands, whose reply is the
// whole `WmSnapshot`): a snap's whole outcome *is* the new frame, so the caller gets it
// and can say where the window went without a second round trip.
export interface SnapBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Snap a window to a named screen region — `wm_snap` (see `lib/snapZones.ts` for the
 * chords that reach it, and `crates/amos-wm/src/snap.rs` for the geometry rule).
 *
 * `zone` is a `SnapZone` wire key; the host parses it with `SnapZone::parse` and refuses
 * anything else **by name** rather than guessing. It also refuses, with a reason, when the
 * window is not registered, is an external container surface, is the screen itself
 * (`main`), belongs to a class without free window geometry (only the desktop class has
 * it), or is a pane of the active split — that pane's rectangle belongs to the split.
 *
 * Diag-only, like the split family and for the same reason: the host answers `null` when
 * it refuses, so the ledger alone cannot tell "the host said no" from "nobody answered".
 */
export async function wmSnapWithDiag(
  label: string,
  zone: SnapZone,
): Promise<{ ok: true; bounds: SnapBounds } | { ok: false; diag: WmReplyDiag }> {
  if (!bridged()) {
    return { ok: false, diag: { ok: false, kind: "not-bridged", command: "wm_snap" } };
  }
  try {
    const bounds = await invoke<SnapBounds>("wm_snap", { label, zone });
    if (bounds) return { ok: true, bounds };
    return { ok: false, diag: { ok: false, kind: "host-refused-null", command: "wm_snap" } };
  } catch (err) {
    return {
      ok: false,
      diag: { ok: false, kind: "command-failed", command: "wm_snap", detail: err },
    };
  }
}

/**
 * The app id a window record shows: the host's own answer when it sent one, else resolved
 * from the label (REQ-A473). `""` = a window that shows no application (the launcher, a
 * container surface).
 *
 * One helper, because every per-app reader needs exactly this and each deriving it
 * separately is how they start disagreeing about the same window. (`windowOf` applies the
 * same rule at the wire boundary, so a caller holding a normalized record and a caller
 * holding the raw payload cannot end up with different answers.)
 */
export function windowAppId(w: WmWindowInfo): string {
  return w.app !== "" ? w.app : (appOfWindowLabel(w.label) ?? "");
}

/** The focused window in a snapshot, or `null` when nothing is focused. */
export function focusedWindowOf(snapshot: WmWindowsSnapshot): WmWindowInfo | null {
  return snapshot.windows.find((w) => w.focused) ?? null;
}

/**
 * An **application's** windows, in the order the host listed them (REQ-A476).
 *
 * `appId` is an app id, not a label: the caller gets it from [`windowAppId`] or from a
 * record's `app` field (`focusedAppOf` is the usual source). Hidden windows are excluded
 * (nothing to show or tile) and the app comparison is a hard equality — a window that shows
 * a different app, or none at all, never leaks into another app's list.
 */
export function windowsOfApp(snapshot: WmWindowsSnapshot, appId: string): WmWindowInfo[] {
  if (appId === "") return [];
  return snapshot.windows.filter((w) => w.state !== "Hidden" && windowAppId(w) === appId);
}

/**
 * The windows **Mission Control** switches between: application windows, minus the ones that
 * are not on screen (F-SH-361).
 *
 * `kind === "App"` drops the Launcher and system surfaces (nothing to switch to), and
 * `state !== "Hidden"` drops windows parked behind ⌘M / "show desktop" / another Space.
 *
 * One owner, because two readers must not disagree: `MissionControl.svelte` *draws* this list
 * and `DesktopShell` asks the same question **before** opening the layer (`shouldShowMissionControl`
 * over this count). A count taken from a second rule is exactly how a layer opens for a list the
 * panel then declines to draw — an invisible layer that still eats the next Escape.
 */
export function missionControlWindows(snapshot: WmWindowsSnapshot): WmWindowInfo[] {
  return snapshot.windows.filter((w) => w.kind === "App" && w.state !== "Hidden");
}

/**
 * The **apps** that currently own a registered window — the Dock's running set (REQ-A709).
 *
 * The rule is "has a window", not "has a *visible* window": a window leaves `wm_windows`
 * only when it is **closed** (the host drops it from the model — `wm_close`), so every
 * listed window means its app is running, whatever its `state`. `Hidden` is *not* a closed
 * app: it is a running app whose window is momentarily off screen — ⌘M (`wm_hide`), the
 * "show desktop" hot corner, or a window parked on another Space. Keying the running dot on
 * `state !== "Hidden"` therefore darkened the dot for every one of those, and the user read
 * a running app as a closed one (the `docs/DESKTOP_GAP_ANALYSIS_2026_SEP20.md` §A1 defect).
 *
 * A window with no app (the Launcher, or a surface reporting `""`) is dropped: the Dock has
 * no tile to light, and `""` must never become a phantom running app.
 *
 * Contrast [`windowsOfApp`], which *does* drop Hidden windows — correct there, because a
 * caller asking "which of this app's windows can I show or tile?" has nothing to do with a
 * window that is not on screen. One rule must not be copied into the other: they answer
 * different questions ("is it running?" vs "what is on screen?").
 */
export function runningAppsOf(snapshot: WmWindowsSnapshot): Set<string> {
  const apps = new Set<string>();
  for (const w of snapshot.windows) {
    const app = windowAppId(w);
    if (app !== "") apps.add(app);
  }
  return apps;
}

/**
 * The app the **focused** window shows, or `null` when nothing is focused (or when what is
 * focused shows no app — the launcher).
 *
 * This is the one place "which application are we acting on?" is answered for the shell's
 * per-app features (⌘N/⌘` and App Exposé), so the chord handler, the menu row and the
 * overlay cannot disagree about it.
 */
export function focusedAppOf(snapshot: WmWindowsSnapshot): string | null {
  const f = focusedWindowOf(snapshot);
  if (!f) return null;
  const app = windowAppId(f);
  return app === "" ? null : app;
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

/**
 * The two pane rectangles a split of `width`×`height` would produce under this host's
 * class policy — **without opening or moving any window** (`wm_pane_rects`, REQ-A512).
 *
 * The touch shell lays two app panes out inside its own single WebView (a mobile Tauri
 * target has no second native window to place), and it must not re-implement the pane
 * geometry to do it: this asks the host, whose `split_panes` rule is the same one the
 * desktop split uses. `axis` is `vertical | horizontal | auto` (`auto` = the class's own
 * aspect rule).
 *
 * Resolves to `null` when there is no bridge, the command failed, **or** the screen
 * genuinely cannot host two minimum panes plus the divider (`Ok(None)` from the host).
 * A caller must then keep its previous layout rather than invent one — which is why this
 * never returns fabricated or zero-sized panes.
 */
export async function wmPaneRects(
  axis: SplitAxis,
  percent: number,
  width: number,
  height: number,
): Promise<PaneLayout[] | null> {
  return normalizePaneRects(
    await invoke<PaneLayout[]>("wm_pane_rects", { axis, percent, width, height }),
  );
}

/**
 * The rectangle a floating **Slide Over** panel of `width`×`height` would occupy under
 * this host's class policy — **without opening or moving any window**
 * (`wm_slide_over_rect`, REQ-A675).
 *
 * The touch shell paints a floating third pane inside its own single WebView (a mobile
 * Tauri target has no second native window to place), and it must not re-implement the
 * panel geometry to do it: this asks the host, whose `slide_over_pane` rule is the same
 * one any desktop consumer uses. `axis` is `vertical | horizontal | auto` (`auto` = the
 * class's own aspect rule).
 *
 * Resolves to `null` when there is no bridge, the command failed, **or** the inset rect
 * genuinely cannot hold a minimum panel (`Ok(None)` from the host). A caller must then
 * keep its previous layout rather than invent one — which is why this never returns a
 * fabricated or zero-sized rect.
 */
export async function wmSlideOverRect(
  axis: SplitAxis,
  percent: number,
  width: number,
  height: number,
): Promise<PaneLayout | null> {
  return normalizeSlideOverRect(
    await invoke<PaneLayout>("wm_slide_over_rect", { axis, percent, width, height }),
  );
}

/** Tauri event the Rust host broadcasts after any layout change. */
export const LAYOUT_CHANGED_EVENT = "layout-changed";

/**
 * Tauri event the Rust host broadcasts after the **window list** changes (REQ-A717) —
 * a window opened, closed, hid, showed or took/lost focus. Its payload is the same
 * `WmSnapshot` `wm_windows` answers with (`crates/amos-tauri/src/wm.rs::WM_CHANGED_EVENT`).
 *
 * The desktop chrome used to learn a window was gone only from a 5 s poll, so the Dock
 * kept a running dot for ~5 s after ⌘W. It now follows this push; the poll survives only
 * as a reconciliation safety net (`lib/wmWindowsPoll.ts`).
 */
export const WM_CHANGED_EVENT = "wm-changed";

// ---- Displays (`wm_displays`) — multi-display, REQ-A690 ----
//
// The platform readings behind multi-monitor support. A separate command from
// `wm_layout_snapshot` on purpose: the layout snapshot is the layout *model*'s wire shape
// (pinned in two languages), while this is what the *platform* reports — it changes on
// hot-plug, so a consumer asks for it rather than reading a cached field. The wire shapes
// mirror `amos_wm::display::{Display, DisplaySet}`; the declared mirror is bound to those
// Rust structs by `src/__tests__/declaredMirrors.test.ts`.

/**
 * One display in the caller's logical coordinate space (Rust `amos_wm::display::Display`).
 *
 * `bounds` is the full display rect (a global origin — a secondary display to the left has
 * a **negative** `x`); `work_area` is the same minus whatever the platform reserves (menu
 * bar, Dock), equal to `bounds` when the platform reports no reserved area. `scale` is
 * reported, never applied here. `primary` is true for the platform's primary display (at
 * most one).
 */
export interface DisplayInfo {
  bounds: SnapBounds;
  work_area: SnapBounds;
  /** DPI scale factor (logical → physical); `1` when unknown. */
  scale: number;
  /** True for the platform's primary display; at most one carries it. */
  primary: boolean;
  /** Human-readable name the platform gave, or `null` when it gave none. */
  name: string | null;
}

/** The displays a host can see, in the platform's own order (Rust `amos_wm::display::DisplaySet`). */
export interface DisplaySet {
  displays: DisplayInfo[];
}

/**
 * List the platform's displays (`wm_displays`, REQ-A690).
 *
 * The payload is **narrowed, never trusted** (see [`normalizeDisplays`]). Resolves to `null`
 * when there is no bridge or the command failed; an **empty** set is a real answer meaning
 * "the platform listed nothing", which callers treat as the single measured screen.
 */
export async function wmDisplays(): Promise<DisplaySet | null> {
  const raw = await invoke<DisplaySet>("wm_displays");
  return raw === null || raw === undefined ? null : normalizeDisplays(raw);
}

/**
 * Coerce a raw `wm_displays` payload into the typed view (never throws).
 *
 * A `displays` entry that is not an object is **dropped**; every field of a kept entry
 * falls back to the most conservative value (a zero rect, scale 1, not primary, no name) so
 * a malformed payload degrades to "a display at the origin" rather than throwing. The
 * field order matches `amos_wm::display::Display`'s declaration — the mirror test reads it.
 */
export function normalizeDisplays(raw: unknown): DisplaySet {
  const s = (raw ?? {}) as { displays?: unknown };
  const displays = Array.isArray(s.displays)
    ? s.displays.map(displayOf).filter((d): d is DisplayInfo => d !== null)
    : [];
  return { displays };
}

/** One display record, or `null` when the entry is not an object. */
function displayOf(v: unknown): DisplayInfo | null {
  if (v === null || typeof v !== "object") return null;
  const d = v as Partial<DisplayInfo>;
  return {
    bounds: boundsOf(d.bounds),
    work_area: boundsOf(d.work_area),
    scale: scaleOf(d.scale),
    primary: bool(d.primary, false),
    name: typeof d.name === "string" ? d.name : null,
  };
}

/** A display rect, defaulting to zero when the payload carries no usable one. */
function boundsOf(v: unknown): SnapBounds {
  const b = (v ?? {}) as Partial<SnapBounds>;
  return {
    x: num(b.x, 0),
    y: num(b.y, 0),
    width: Math.max(0, Math.trunc(num(b.width, 0))),
    height: Math.max(0, Math.trunc(num(b.height, 0))),
  };
}

/** A DPI scale must be finite and positive; anything else is `1`. */
function scaleOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1;
}

// ---- Window list (`wm_windows`) ----

/** One window in the host's `wm_windows` snapshot (Rust `wm::WindowInfo`; bound by
 * `declaredMirrors.test.ts`'s "wm.ts window-list wire shapes" — REQ-A704). */
export interface WmWindowInfo {
  id: number;
  label: string;
  /**
   * The **app id** this window shows (REQ-A473), or `""` for a window that shows no
   * application (the launcher, an external container surface).
   *
   * This is what per-app decisions must key on — the Dock's running dot, "is this app
   * open" — because `label` differs from the app id for every window after the first
   * (`files` vs `files_2`). `normalizeWindows` derives it from the label when the host
   * payload does not carry it, so an older host still yields a usable app id.
   */
  app: string;
  /** `1` for the app's first window, `2..` for later ones, `0` when there is no app. */
  instance: number;
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

/** The host's whole windowing state (Rust `wm::WmSnapshot`; bound by
 * `declaredMirrors.test.ts`'s "wm.ts window-list wire shapes" — REQ-A704). */
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
  const raw = await invoke<WmWindowsSnapshot>("wm_windows");
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
  // The host reports the identity (REQ-A473). When it does not (an older host, a partial
  // payload), the label is resolved through the *shared* pure resolver rather than left
  // empty — a `""` app would silently turn every per-app reader (the Dock's running dot,
  // "is this app open") into "no app", which is a wrong answer, not a missing one.
  const resolved = splitWindowLabel(w.label);
  const app = typeof w.app === "string" && w.app !== "" ? w.app : (resolved?.app ?? "");
  const instance =
    typeof w.instance === "number" && Number.isSafeInteger(w.instance) && w.instance > 0
      ? w.instance
      : (resolved?.instance ?? 0);
  return {
    id: num(w.id, 0),
    label: w.label,
    app,
    instance,
    kind: typeof w.kind === "string" && w.kind !== "" ? w.kind : "Unknown",
    state: typeof w.state === "string" ? w.state : "",
    focused: bool(w.focused, false),
    external: bool(w.external, false),
  };
}

/**
 * Subscribe to layout changes broadcast by the host (so non-initiating windows /
 * surfaces refresh without their own command round-trip). Payloads are normalized
 * before `handler` runs. Resolves to an unsubscribe, or `null` when the bridge could not
 * subscribe (offline / host build) — REQ-A838: a window that never receives a push and a
 * window whose layout genuinely never changes are otherwise indistinguishable, and this
 * subscription is what lets a non-initiating window skip its own command round-trip.
 *
 * Delegates to the shared `subscribe` helper: Tauri v2 injects no `listen` on
 * `__TAURI_INTERNALS__`, so a local `b.listen` call here was silently dead on
 * device (the bridge now synthesizes one through the event plugin).
 */
export function onLayoutChanged(
  handler: (snap: LayoutSnapshot) => void,
): Promise<(() => void) | null> {
  return subscribe(LAYOUT_CHANGED_EVENT, (payload) => handler(normalizeLayout(payload)));
}

/**
 * Subscribe to the host's **window-list** push (REQ-A717). The payload is normalized
 * exactly like a `wm_windows` reply (`normalizeWindows`), so a push and a poll cannot
 * hand a consumer two different shapes. Resolves to an unsubscribe, or `null` when the
 * bridge cannot subscribe (offline / host build without the event) — REQ-A838: a Dock whose
 * running dots never update must be able to tell that from "no app changed state".
 */
export function onWmChanged(
  handler: (snap: WmWindowsSnapshot) => void,
): Promise<(() => void) | null> {
  return subscribe(WM_CHANGED_EVENT, (payload) => {
    // A push that carries no object must not be *normalized* into `{ windows: [] }`: an empty
    // list reads as "every app closed" and would blank the Dock's running dots. The host only
    // ever emits a snapshot, so anything else is a bad frame and is dropped, not believed.
    if (payload === null || typeof payload !== "object") return;
    handler(normalizeWindows(payload));
  });
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
    // `0` — no rail — is the honest fallback for a malformed payload: a snapshot the shell
    // could not read must not reserve a strip for a rail it cannot confirm exists.
    rail_width: num(s.rail_width, 0),
  };
}

/**
 * Coerce a raw `wm_pane_rects` payload into exactly two typed pane rects, or `null`
 * when the reply is not two usable rectangles (never throws).
 *
 * `null` is the honest answer for both "the host could not fit a split on this screen"
 * and "the payload was malformed": either way the caller is told *no pane rects*, never
 * handed a fabricated or zero-sized layout. A rectangle with no usable size is dropped
 * rather than clamped — a zero-size pane is a layout bug, not a small pane.
 */
export function normalizePaneRects(raw: unknown): PaneLayout[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const first = paneOf(raw[0]);
  const second = paneOf(raw[1]);
  if (first === null || second === null) return null;
  return [first, second];
}

/**
 * Coerce a raw `wm_slide_over_rect` payload into one typed rect, or `null` when the
 * reply is not a usable rectangle (never throws).
 *
 * `null` is the honest answer for both "the host could not fit a panel on this screen"
 * and "the payload was malformed": either way the caller is told *no rect*, never handed
 * a fabricated or zero-sized panel. Shares `paneOf`'s rule with `normalizePaneRects` — a
 * rectangle with no usable size is dropped rather than clamped.
 */
export function normalizeSlideOverRect(raw: unknown): PaneLayout | null {
  return paneOf(raw);
}

/** One pane rectangle, or `null` when the record carries no usable size. */
function paneOf(v: unknown): PaneLayout | null {
  const p = (v ?? {}) as Partial<PaneLayout>;
  if (
    typeof p.width !== "number" ||
    typeof p.height !== "number" ||
    !Number.isFinite(p.width) ||
    !Number.isFinite(p.height) ||
    p.width < 1 ||
    p.height < 1
  ) {
    return null;
  }
  return {
    label: typeof p.label === "string" ? p.label : "",
    x: num(p.x, 0),
    y: num(p.y, 0),
    width: Math.trunc(p.width),
    height: Math.trunc(p.height),
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

/**
 * Device class the host runs as (`crates/amos-wm/src/form.rs`). The array is the one
 * declaration; {@link FormFactor} derives from it, so the allowlist {@link formOf}
 * consults is the type.
 */
export const FORM_FACTORS = ["phone", "tablet", "desktop", "robot"] as const;
export type FormFactor = (typeof FORM_FACTORS)[number];

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
