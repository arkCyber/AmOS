/**
 * shellState.svelte.ts — Svelte top-level shell navigation state.
 *
 * `Shell.svelte` reads this runes store to decide what to render (home / an app
 * screen / lock / edit) and the open overlay flags, and persists `amos.home.layout`.
 * Actions are pure state transitions with no framework UI on the import graph.
 *
 * NOTE: `open()` already records a recent for built-in apps (drives the App
 * Library "Frequently Used" group) using the appMeta module. Clearing the opened
 * app's notification badge is still a later foundation step.
 */
import {
  LAYOUT_KEY,
  pushRecent,
  getLayout,
  knownAppIds,
  restoreStorePlacements,
  defaultLayout,
  readStoreValue,
  writeStoreValue,
  writeStoreValueChecked,
  removeStoreValue,
  type HomeLayout,
} from "../lib/amosStore";
import { appTitleKey, appIds } from "../lib/appMeta";
import { announceAppOpened } from "../lib/shortcuts";
import { setFormFactor } from "../lib/formAuthority.svelte";
import {
  SPLIT_KEY,
  clampSplitPercent,
  encodeSplit,
  isSplittablePair,
  parseSplit,
  type PersistedSplit,
  type SurfaceSplitAxis,
} from "../lib/splitPersist";
import {
  SLIDE_OVER_KEY,
  SLIDE_PERCENT_DEFAULT,
  clampSlidePercent,
  encodeSlideOver,
  parseSlideOver,
  type PersistedSlideOver,
  type SurfaceSlideOverAxis,
} from "../lib/slideOver";
import type { LayoutSnapshot } from "../lib/wm";
import { wmOpenWithDiag } from "../lib/wm";

/** Split orientation the shell *asks for* — see `lib/splitPersist::SurfaceSplitAxis`.
 * Re-exported here because `Surface` is this module's vocabulary. */
export type { SurfaceSplitAxis };
/** Slide Over orientation the shell *asks for* — see
 * `lib/slideOver::SurfaceSlideOverAxis`. */
export type { SurfaceSlideOverAxis };

/**
 * The floating **Slide Over** panel (REQ-A675): a third, narrow app that overlays
 * whatever `Surface` is showing instead of joining it.
 *
 * Deliberately **not** a `Surface` variant: a panel co-exists with home / an app / a
 * split rather than replacing it, so making it a surface would force every `kind` check
 * in the render layer to grow a fourth state. It is an overlay layer above the surface,
 * below the system sheets (`NotificationCenter` etc.), like `_pulseId`.
 */
export interface SlideOverState {
  /** The app id shown in the panel. */
  readonly id: string;
  /** The edge it hugs; `auto` defers to the host's class rule. */
  readonly axis: SurfaceSlideOverAxis;
  /** Its share of the screen extent along `axis` (see `lib/slideOver`'s band). */
  readonly percent: number;
  /** Whether it is currently slid off its edge. */
  readonly hidden: boolean;
}

export type Surface =
  | { kind: "home" }
  | { kind: "app"; id: string }
  | { kind: "library" }
  | { kind: "lock" }
  | { kind: "edit" }
  | {
      kind: "split";
      primary: string;
      secondary: string;
      axis: SurfaceSplitAxis;
      percent: number;
    };

/** Which surface is shown. */
let _surface = $state<Surface>({ kind: "home" });
/** Overlay toggles (system sheets above home & app). */
let _ncOpen = $state(false);
let _recentsOpen = $state(false);
let _spotOpen = $state(false);
/** Id of the app icon currently pulsing (Spotlight soft-launch), if any. */
let _pulseId = $state<string | null>(null);
/** How many soft launches have happened. `_pulseId` is the *matching value* and a value
 * can repeat — picking the same Spotlight result twice, with a page swipe in between,
 * writes the id it already holds (Svelte's runes compare primitives, so no notification
 * fires at all) and the "reveal the icon" consumer would be told nothing. The launch is
 * an event, so it gets an identity that changes per event. */
let _pulseSeq = $state(0);
/** The floating Slide Over panel, if one is open (see `SlideOverState`). */
let _slideOver = $state<SlideOverState | null>(null);
/**
 * The **system ink layer** (REQ-A1590): a scratch drawing surface floating over whatever the
 * shell is showing. Deliberately not persisted and not a `Surface` — it is a transient overlay
 * like the three sheets, and a drawing is not a place the shell can *navigate* to. The drawing
 * itself lives in `SystemInkLayer.svelte` (which stays mounted), so reopening within a run
 * resumes the same sheet; this flag is only "is the layer up".
 */
let _sysInkOpen = $state(false);
/** The persisted home layout (kept in sync when we reach the store). On a fresh
 * run (or a previously-persisted-but-empty home) with built-in apps available we
 * seed a real default via getLayout(appIds()) — the built-in dock apps + the rest
 * on a page. Without this, a first boot has NO persisted layout and the Svelte
 * shell fell back to an all-empty {page:[],dock:[],hidden:[]}, leaving the home
 * grid and dock blank ("页面内容不完整"). getLayout() already returns the default
 * when nothing is persisted; we additionally treat a *persisted-but-empty* home
 * as needing a default so a stale empty amos.home.layout can't blank the launcher. */
function seededHome(): HomeLayout {
  const available = appIds();
  const l = getLayout(available);
  if (l.page.length === 0 && l.dock.length === 0 && available.length > 0) {
    return defaultLayout(available);
  }
  return l;
}
const initialLayout: HomeLayout = seededHome();
let _layout = $state<HomeLayout>(initialLayout);
// True while the last home-layout write was refused by the store. The home screen is
// drawn from `_layout`, so a refused write that still moved it would show a placement
// the durable key does not hold (it reverts on the next launch). The *message* is the
// UI's business — this module keeps no framework UI on its import graph.
let _layoutRefused = $state(false);

// Track form factor to decide SPA vs multi-window (desktop).
let _layoutSnap = $state<LayoutSnapshot | null>(null);

// Svelte 5 forbids exporting reassigned $state from a module, so expose getters.
export function surface(): Surface {
  return _surface;
}
export function ncOpen(): boolean {
  return _ncOpen;
}
export function recentsOpen(): boolean {
  return _recentsOpen;
}
export function spotOpen(): boolean {
  return _spotOpen;
}
export function pulseId(): string | null {
  return _pulseId;
}
/** The soft launch's event counter — changes on **every** launch, including a repeat of
 * the same id (see `_pulseSeq`). Consumers that must *do* something per launch (reveal
 * the icon) key on this; consumers that only highlight key on `pulseId`. */
export function pulseSeq(): number {
  return _pulseSeq;
}
export function slideOver(): SlideOverState | null {
  return _slideOver;
}
/** Whether the system ink layer is up (REQ-A1590). */
export function sysInkOpen(): boolean {
  return _sysInkOpen;
}
export function layout(): HomeLayout {
  return _layout;
}

/** Update the layout snapshot (called by Shell.svelte on host updates).
 *
 * This is also the **one production writer of the device class**: storing the
 * snapshot re-asserts its `form` into `lib/formAuthority`, so the class every app
 * reads can never disagree with the measured screen it arrived with. `Shell.svelte`
 * therefore does not need a second `setFormFactor` call that could be forgotten at a
 * new push site. */
export function setLayoutSnapshot(snap: LayoutSnapshot | null): void {
  _layoutSnap = snap;
  setFormFactor(snap?.form ?? null);
}

/**
 * The host's latest layout snapshot (the **one** authority for the device class, the
 * measured screen and the column signal). Exposed as a reactive read of a module-level
 * rune, so a component that derives from it (`$derived(layoutSnap()?.columns)`)
 * re-renders on every `layout-changed` push — the property a manual-subscribe
 * snapshot does **not** have.
 *
 * Apps that need the class *and* its measurements (e.g. the Settings sidebar's
 * `masterDetail(form, columns, width)`) read them from this snapshot rather than
 * prop-drilling through `AppPane`'s dynamic `<AppComp />` mount.
 */
export function layoutSnap(): LayoutSnapshot | null {
  return _layoutSnap;
}

function clearOverlays() {
  _ncOpen = false;
  _recentsOpen = false;
  _spotOpen = false;
  // The ink layer is a transient overlay too: any navigation dismisses it. `openSysInk` calls
  // this first and then raises the flag, so the order there is decide-then-raise.
  _sysInkOpen = false;
}

/** Open an app screen (from dock/grid/recents/library). Records a recent (built-ins
 * only — third-party ids don't pollute the frequently-used set) so the App Library
 * "Frequently Used" group stays live, mirroring the shell's `open`.
 * 
 * Desktop form factor: calls `wm_open` to create a real OS window (REQ-A249).
 * Phone/tablet: SPA routing; while a split is up, retargets the secondary pane.
 */
export async function open(id: string): Promise<void> {
  if (appTitleKey(id) !== null) pushRecent(id);
  clearOverlays();

  // Tell the automation runtime that an app was opened (`app` triggers). Announced
  // **here** — at the single point the shell commits to opening — so a trigger cannot
  // fire twice for one open, and a refused `wm_open` below never announces an app that
  // did not open (the announce sits after the desktop branch's outcome check).
  
  // Desktop form factor: multi-window (each app is a real WebviewWindow).
  //
  // REQ-A297 phase-2 §4: a refused `wm_open` is logged instead of
  // silently dropped. Pre-fix, the function would `await invoke(...)`
  // and unconditionally reset `_surface` to home — so a refused open
  // could leave the user looking at home with no app to interact
  // with and no diagnostic to explain why. We now branch on the null
  // result and only commit to "the app opened" (the surface reset)
  // when the host actually accepted the request.
  if (_layoutSnap?.form === "desktop") {
    const r = await wmOpenWithDiag(id);
    if (!r.ok) {
      const diag = r.diag;
      if (!diag.ok) {
        const code =
          diag.kind === "command-failed" &&
          diag.detail &&
          typeof diag.detail === "object"
            ? (diag.detail as { code?: string }).code
            : undefined;
        console.warn(
          `🛟 [shellState] wm_open(${id}) refused`,
          code ?? diag.kind,
        );
        // Surface stays where it was — don't claim the app opened if
        // the host refused. The user can re-tap from home; the
        // breadcrumb tells ops what went wrong.
        return;
      }
    }
    // Desktop stays on home after opening an app window (macOS behavior).
    _surface = { kind: "home" };
    announceAppOpened(id);
    return;
  }
  
  // Phone/tablet: single-window SPA routing (no change), EXCEPT while a split is
  // on screen — then an open retargets the secondary pane so the "pick second app"
  // flow (RecentsPanel) can swap it without tearing the split down.
  //
  // REQ-A512: a tablet reaches two panes through `enterSplit` below (an in-SPA
  // two-pane surface), **not** through native `WebviewWindow`s — Tauri v2 mobile
  // hosts one WebView, so `wm_open` cannot produce a second window on a device.
  // Both carryings share the single geometry rule `amos_wm::layout::split_panes`,
  // reached here via the pure `wm_pane_rects` command. `enterSplit` is gated on the
  // *measured* `columns >= 2` (phone ⇒ 1 ⇒ refused). The settings page still names
  // the native-window cause for desktop (`wm.whyNoCandidates`) and
  // `svelte-tests/shell-state.svelte.test.ts` pins this routing (touch ⇒ no
  // `wm_open`; desktop ⇒ `wm_open`).
  if (_surface.kind === "split") {
    // A retarget must keep the split one the durable form can read back. Opening the
    // app that already fills the primary pane would make both panes the same app, which
    // `parseSplit` refuses — the split would then be silently dropped instead of
    // restored on the next launch. Refused the same way `pickSecond` refuses it: the
    // app is already on screen in that pane, so nothing opens and nothing is announced.
    if (!isSplittablePair(_surface.primary, id)) return;
    _surface = { ..._surface, secondary: id };
    persistSplitNow(); // the pane swap is a deliberate change: persist it at once
    announceAppOpened(id);
    return;
  }
  _surface = { kind: "app", id };
  announceAppOpened(id);
}

/** Whether this shell can show two panes at once, from the **measured** layout
 * snapshot (`columns` is `columns_for(measured width)`: phone ⇒ 1, tablet ⇒ 2,
 * desktop ⇒ up to 4). This is the single gate for `enterSplit`; it is deliberately
 * NOT `multi_window` (that is native-window semantics — see the union doc above). */
export function canSplit(): boolean {
  return (_layoutSnap?.columns ?? 0) >= 2;
}

/** Whether this shell can float a **Slide Over** panel. The same measured gate as
 * [`canSplit`]: on a one-column phone a floating panel would cover the whole app rather
 * than float over part of it, so a phone is never offered the control (rather than
 * being offered one that cannot work). */
export function canSlideOver(): boolean {
  return canSplit();
}

/* ---- Split persistence (REQ-A512 boundary ③) -------------------------------
 *
 * The intent is written at its **settle points**, never per frame: `enterSplit`
 * and a pane swap write immediately (rare, and the thing a restart should bring
 * back); `setSplitPercent` is coalesced, because the drag loop calls it once per
 * rAF and each `writeStoreValue` is a `store_set` round-trip to the Rust mirror.
 * A debounce keeps the invariant (what is on disk is the last committed ratio)
 * without turning a drag into sixty writes a second. `exitSplit` removes
 * synchronously so a closed split cannot be resurrected by a pending timer. */

/** Coalescing window for the mid-drag ratio. Short enough that a kill right after
 * a drag still lands the final value, long enough to collapse a whole drag. */
const SPLIT_PERSIST_DEBOUNCE_MS = 250;

let splitPersistTimer: ReturnType<typeof setTimeout> | null = null;

function splitToPersist(): PersistedSplit | null {
  const s = _surface;
  return s.kind === "split"
    ? { primary: s.primary, secondary: s.secondary, axis: s.axis, percent: s.percent }
    : null;
}

/** Write the current intent **now** (enter / swap / exit). */
function persistSplitNow(): void {
  if (splitPersistTimer !== null) {
    clearTimeout(splitPersistTimer);
    splitPersistTimer = null;
  }
  const p = splitToPersist();
  // `removeStoreValue` rather than writing `null`: an absent key is this store's own
  // "no split", and a reader's fallback fires either way (see its doc).
  // `encodeSplit` (not the raw intent) so the clamp is applied on the write path too:
  // whatever a future caller hands the shell, what lands on disk is a ratio
  // `parseSplit` will accept.
  if (p) writeStoreValue(SPLIT_KEY, encodeSplit(p));
  else removeStoreValue(SPLIT_KEY);
}

/** Coalesce the mid-drag ratio into one write per drag. */
function scheduleSplitPersist(): void {
  if (splitPersistTimer !== null) return;
  splitPersistTimer = setTimeout(() => {
    splitPersistTimer = null;
    persistSplitNow();
  }, SPLIT_PERSIST_DEBOUNCE_MS);
}

/** Drop the durable split intent **and** any pending ratio write. Every transition that
 * abandons the split surface for good must call this (`exitSplit`, `goHome`, `lock`):
 * the key means "the split the next launch should bring back", and once the surface has
 * moved on there is nothing to bring back — a surviving key would resurrect a layout the
 * user deliberately left. Cancelling the timer first is why a drag cannot land a write
 * *after* the split is gone (REQ-A700). */
function clearSplitIntent(): void {
  if (splitPersistTimer !== null) {
    clearTimeout(splitPersistTimer);
    splitPersistTimer = null;
  }
  removeStoreValue(SPLIT_KEY);
}

/** Enter the two-pane surface. Returns `false` (and leaves the surface untouched)
 * when `columns < 2` — a phone, or a tablet window too narrow to fit two panes — or
 * when the two ids are not a pair a split can hold (`isSplittablePair`: empty or the
 * same app twice, which the durable form would refuse to read back). This is the *only*
 * door into a fresh `kind: "split"`; the render layer may trust the gate. */
export function enterSplit(
  primary: string,
  secondary: string,
  axis: SurfaceSplitAxis = "auto",
  percent = 50,
): boolean {
  if (!isSplittablePair(primary, secondary)) return false;
  if (!canSplit()) return false;
  clearOverlays();
  _pulseId = null;
  _surface = {
    kind: "split",
    primary,
    secondary,
    axis,
    percent: clampSplitPercent(percent),
  };
  persistSplitNow();
  return true;
}

/** Collapse the split back to the primary app (the back affordance). A no-op on
 * any other surface so a stray back press can't fabricate an app screen. */
export function exitSplit(): void {
  if (_surface.kind !== "split") return;
  _surface = { kind: "app", id: _surface.primary };
  clearSplitIntent();
}

/** Move the divider. Clamped to 1..=99 by the shared rule (`splitPersist`), so
 * neither pane can reach zero width — the host `split_panes` would reject a
 * degenerate request anyway, and the drag loop should never hand it one. */
export function setSplitPercent(p: number): void {
  if (_surface.kind !== "split") return;
  _surface = { ..._surface, percent: clampSplitPercent(p) };
  scheduleSplitPersist();
}

/**
 * Bring back the split the previous run was closed on, if it is still honest to do
 * so. Called **once** by the shell's boot path, after the host has reported its
 * measured screen (the `columns` gate needs it).
 *
 * Refuses — returning `false` and leaving the surface alone — when:
 *   • the surface is not the untouched boot `home` (a lock screen, or a deep link
 *     that already routed somewhere, must not be overridden by a stale split);
 *   • the class is `desktop`, where apps are real OS windows and this in-shell
 *     surface is never offered (`Shell.splitAvailable` makes the same exclusion);
 *   • the screen cannot show two panes now (`canSplit()` — the device rotated to a
 *     phone class, or the window was narrowed before the restore);
 *   • either pane app is no longer installed (`parseSplit`'s rule) or the stored
 *     value is malformed.
 *
 * A refusal leaves the surface on `home`; a stale `amos.split` is simply ignored
 * (and overwritten on the next split), never repaired into a half-split.
 */
export function restoreSplit(): boolean {
  if (_surface.kind !== "home") return false;
  if (_layoutSnap?.form === "desktop") return false;
  if (!canSplit()) return false;
  // Validate a pane against the apps that **still exist**, which is not the same set
  // as the built-in registry: a store-installed app is a real, openable screen (it
  // renders through `AppPane`'s `ExtAppHost`) and can legitimately fill a pane. Using
  // `appIds()` alone read every installed store pane as a ghost and dropped the whole
  // split — the tablet case: split with a store app in the second pane, restart,
  // the split silently gone. `knownAppIds` is the one owner of "built-ins + installed
  // store tiles" (`lib/amosStore`), so this cannot drift from `getLayout`'s rule.
  //
  // Called twice on a real boot (here after the snapshot, and again from
  // `Shell.refreshStoreTiles` once the async tile cache warms) because a cold cache
  // would otherwise refuse a store pane for the whole session. The second call is a
  // no-op wherever the first succeeded — the `kind !== "home"` guard above.
  const p = parseSplit(readStoreValue<unknown>(SPLIT_KEY, null), knownAppIds(appIds()));
  if (!p) return false;
  _surface = { kind: "split", primary: p.primary, secondary: p.secondary, axis: p.axis, percent: p.percent };
  return true;
}

/* ---- Slide Over (REQ-A675) --------------------------------------------------
 *
 * The panel's *intent* (which app, which axis, what share) is persisted at its settle
 * points exactly like the split's: `openSlideOver` and `setSlideOverAxis` write at
 * once (rare, deliberate); `setSlideOverPercent` is coalesced, because a resize drag
 * calls it once per rAF and each write is a `store_set` round-trip. The **hidden**
 * flag is deliberately *not* persisted: a panel that came back after a restart still
 * slid off its edge would look like it had failed to restore, so a restored panel is
 * always shown (see `restoreSlideOver`). */

/** Coalescing window for the mid-drag share — same rationale as the split's. */
const SLIDE_OVER_PERSIST_DEBOUNCE_MS = 250;

let slideOverPersistTimer: ReturnType<typeof setTimeout> | null = null;

function slideOverToPersist(): PersistedSlideOver | null {
  return _slideOver
    ? { id: _slideOver.id, axis: _slideOver.axis, percent: _slideOver.percent }
    : null;
}

/** Write the current intent **now** (open / close / axis change). */
function persistSlideOverNow(): void {
  if (slideOverPersistTimer !== null) {
    clearTimeout(slideOverPersistTimer);
    slideOverPersistTimer = null;
  }
  const p = slideOverToPersist();
  // An absent key is this store's own "no panel" (same rule as the split).
  if (p) writeStoreValue(SLIDE_OVER_KEY, encodeSlideOver(p));
  else removeStoreValue(SLIDE_OVER_KEY);
}

/** Coalesce the mid-drag share into one write per drag. */
function scheduleSlideOverPersist(): void {
  if (slideOverPersistTimer !== null) return;
  slideOverPersistTimer = setTimeout(() => {
    slideOverPersistTimer = null;
    persistSlideOverNow();
  }, SLIDE_OVER_PERSIST_DEBOUNCE_MS);
}

/** Open (or replace) the floating panel. Returns `false` — and leaves the panel
 * untouched — when `columns < 2` (a phone, or a tablet window too narrow to float a
 * panel over content). This is a *gate*, not a silent downgrade: the caller never gets
 * a panel the screen cannot honestly show. */
export function openSlideOver(
  id: string,
  axis: SurfaceSlideOverAxis = "auto",
  percent: number = SLIDE_PERCENT_DEFAULT,
): boolean {
  if (!canSlideOver()) return false;
  clearOverlays();
  _pulseId = null;
  _slideOver = { id, axis, percent: clampSlidePercent(percent), hidden: false };
  persistSlideOverNow();
  return true;
}

/** Close the panel. A no-op with no panel so a stray dismiss can't fabricate one. */
export function closeSlideOver(): void {
  if (_slideOver === null) return;
  _slideOver = null;
  persistSlideOverNow();
}

/**
 * Bring back the panel the previous run was closed on, if it is still honest to do so.
 * Called by the shell's boot path after the host has reported its measured screen (the
 * `columns` gate needs it), and **again** from `Shell.refreshStoreTiles` once the async
 * store-tile cache warms — a cold cache would otherwise refuse a store-app panel for the
 * whole session. The second call is a no-op wherever a panel is already on screen
 * (`_slideOver !== null`), so it cannot override a later user navigation.
 *
 * Refuses — returning `false` and leaving the panel closed — when the class is
 * `desktop` (apps there are real OS windows; this in-shell panel is never offered),
 * the screen cannot float a panel now (`canSlideOver()`), or the app is no longer
 * installed (`parseSlideOver`'s rule, which counts an installed store tile as installed).
 * A restored panel is always **shown**, whatever it was when the run ended — see the
 * section note above.
 */
export function restoreSlideOver(): boolean {
  if (_layoutSnap?.form === "desktop") return false;
  if (!canSlideOver()) return false;
  // A panel already on screen is the user's own choice now — the re-attempt after the async
  // tile cache warms (see `Shell.refreshStoreTiles`) must not let the stored key override it,
  // exactly as `restoreSplit`'s `kind !== "home"` guard refuses a second attempt.
  if (_slideOver !== null) return false;
  // Validate against the apps that **still exist**, not the built-in registry: a store app is a
  // real, openable screen (`AppPane` → `ExtAppHost`), so validating against `appIds()` alone read
  // an installed store app as a ghost and the floating panel never came back after a restart —
  // the same rule, and the same fix, `restoreSplit` already carries. `knownAppIds` is the one
  // owner of "built-ins + installed store tiles" (`lib/amosStore`), so this cannot drift from it.
  const p = parseSlideOver(readStoreValue<unknown>(SLIDE_OVER_KEY, null), knownAppIds(appIds()));
  if (!p) return false;
  _slideOver = { id: p.id, axis: p.axis, percent: p.percent, hidden: false };
  return true;
}

/** Move the panel's share. Clamped to the panel band (`slideOver.ts`), so neither a
 * sliver nor a de-facto split can be requested; the resize drag should never hand the
 * host a share it would reject. */
export function setSlideOverPercent(p: number): void {
  if (_slideOver === null) return;
  _slideOver = { ..._slideOver, percent: clampSlidePercent(p) };
  scheduleSlideOverPersist();
}

/** Slide the panel off its edge. **Not** persisted (see the section note): it is a
 * transient glance, not a durable layout. Idempotent. */
export function hideSlideOver(): void {
  if (_slideOver === null || _slideOver.hidden) return;
  _slideOver = { ..._slideOver, hidden: true };
}
/** Reveal the panel. Idempotent. */
export function showSlideOver(): void {
  if (_slideOver === null || !_slideOver.hidden) return;
  _slideOver = { ..._slideOver, hidden: false };
}

/** Enter the iOS-style "App Library" page (grouped apps + frequently used). */
export function enterLibrary(): void {
  clearOverlays();
  _pulseId = null;
  _surface = { kind: "library" };
}

/** Spotlight "soft launch": pulse the icon on home, stay home. The pulse is only useful
 * if the icon is *on screen*, so the launch also bumps `_pulseSeq` — the home grid is
 * paged, and the id alone cannot tell a fresh launch from the one already handled.
 *
 * The pulse needs an icon to land on, and home draws exactly `layout.page` + `layout.dock`
 * (`HomeDock.pageIds`/`dockIds`). Spotlight, though, searches the whole registry — so a
 * pick can name an app home draws **nowhere**: one the user hid from EditHome, or a store
 * tile that was never placed on a page. There is no icon to reveal, so the soft launch
 * was a *silent no-op* — the sheet closed, the shell stayed home, and the screen did not
 * change. With nothing to reveal, do what the pick asked for and open the app: it is
 * installed and openable, and "search it, tap it, nothing happens" is the one answer a
 * search field must never give. */
export function softLaunch(id: string): void {
  if (!_layout.page.includes(id) && !_layout.dock.includes(id)) {
    void open(id);
    return;
  }
  clearOverlays();
  _surface = { kind: "home" };
  _pulseId = id;
  _pulseSeq++;
}

/** True while the last home-layout write was refused (the home screen says so). */
export function layoutRefused(): boolean {
  return _layoutRefused;
}

/**
 * Persist a new home layout (used by HomeDock/EditHome/AppLibrary actions).
 *
 * 这一枚键（`amos.home.layout`）的另外两个写者 —— `Dock.svelte` 的拖拽排序与
 * `Launchpad.commitLayout` —— 早就走 `writeStoreValueChecked` + `StoreErrorBar` 并在被拒时
 * 保持内存里的旧布局（REQ-A1346 ∕ F-SH-611）；这里原先逐字 `_layout = next; saveLayout(next);`，
 * 而 `saveLayout` 签 `void`（里面 `writeJson` 的返回值被丢掉）。于是存储拒写时 `_layout` 仍然
 * 移动、`HomeDock` 跟着把图标画到新位置，而盘上还是旧的 —— 重启（或另一次重读）之后它又跳回去，
 * 中间没有一句话。`reseatHomeLayout`（安装 ∕ 卸载后的回位）也走这条路径。
 */
export function applyLayout(next: HomeLayout): boolean {
  if (!writeStoreValueChecked(LAYOUT_KEY, next)) {
    _layoutRefused = true;
    return false;
  }
  _layoutRefused = false;
  _layout = next;
  return true;
}

/**
 * Put back a store app's page/dock/hidden placement that the **boot** repair dropped.
 *
 * The seed (`seededHome`) runs at module init, but `loadStoreTiles` is async and only
 * `Shell` starts it — so at that instant the store tile cache is cold, and a store app
 * the user had already placed reads as a ghost and is filtered out of the in-memory
 * layout. `Shell` calls this once the tiles arrive — and again on every install /
 * uninstall, so an app that really was removed is reconciled out. `lib/amosStore` owns
 * the reconcile (it re-reads the durable value, so a drag that landed while the tiles
 * were loading is picked up, never clobbered); this only persists the result.
 */
export function reseatHomeLayout(): void {
  const next = restoreStorePlacements(_layout, appIds());
  if (JSON.stringify(next) === JSON.stringify(_layout)) return;
  applyLayout(next);
}

/** Return to the home surface (home pill / back / hardware home). */
export function goHome(): void {
  clearOverlays();
  _pulseId = null;
  _surface = { kind: "home" };
  // Home abandons a split as surely as `exitSplit` does (it replaces the surface), so it
  // must drop the durable intent too — otherwise a split the user just dismissed is
  // resurrected by `restoreSplit` on the next launch.
  clearSplitIntent();
}

export function lock(): void {
  clearOverlays();
  _surface = { kind: "lock" };
  // The lock surface replaces the split as well (and `unlock` returns to home, never to
  // the split), so the intent must not outlive it — see `goHome`.
  clearSplitIntent();
}

export function unlock(): void {
  _surface = { kind: "home" };
}

export function enterEdit(): void {
  clearOverlays();
  _surface = { kind: "edit" };
}

export function exitEdit(): void {
  _surface = { kind: "home" };
}

export function setNc(v: boolean) {
  _ncOpen = v;
  if (v) {
    _recentsOpen = false;
    _spotOpen = false;
  }
}
export function setRecents(v: boolean) {
  _recentsOpen = v;
  if (v) {
    _ncOpen = false;
    _spotOpen = false;
  }
}
export function setSpot(v: boolean) {
  _spotOpen = v;
  if (v) {
    _ncOpen = false;
    _recentsOpen = false;
  }
}

/**
 * Raise the system ink layer (REQ-A1590). The sheets are dismissed first (`clearOverlays`,
 * which also resets this flag) and the layer is raised **after** — see `clearOverlays`'s note.
 * Idempotent: raising an already-raised layer changes nothing.
 */
export function openSysInk(): void {
  clearOverlays();
  _sysInkOpen = true;
}

/** Lower the ink layer. The drawing is kept (the component stays mounted) — see `_sysInkOpen`. */
export function closeSysInk(): void {
  _sysInkOpen = false;
}

/** Reset to the initial home state (for tests / HMR). */
export function resetShellState(): void {
  _surface = { kind: "home" };
  _ncOpen = false;
  _recentsOpen = false;
  _spotOpen = false;
  _sysInkOpen = false;
  _pulseId = null;
  // Same non-empty seeding as module init (see seededHome): a fresh / empty
  // persisted home must not blank the launcher grid + dock.
  _layout = seededHome();
  // Drop the split intent along with the surface: a reset must not leave a pending
  // debounce (or a stored split) that a later boot would restore into a state the
  // reset just disowned.
  clearSplitIntent();
  // Same for the floating panel: drop the state, any pending debounce, and the key.
  _slideOver = null;
  if (slideOverPersistTimer !== null) {
    clearTimeout(slideOverPersistTimer);
    slideOverPersistTimer = null;
  }
  removeStoreValue(SLIDE_OVER_KEY);
  // Clears the host class too (the honest "no host has answered" state) — see
  // `setLayoutSnapshot`.
  setLayoutSnapshot(null);
}


