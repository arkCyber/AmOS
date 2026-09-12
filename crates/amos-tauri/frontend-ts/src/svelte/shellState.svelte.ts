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
import { saveLayout, pushRecent, getLayout, defaultLayout, type HomeLayout } from "../lib/amosStore";
import { appTitleKey, appIds } from "../lib/appMeta";

export type Surface =
  | { kind: "home" }
  | { kind: "app"; id: string }
  | { kind: "library" }
  | { kind: "lock" }
  | { kind: "edit" };

/** Which surface is shown. */
let _surface = $state<Surface>({ kind: "home" });
/** Overlay toggles (system sheets above home & app). */
let _ncOpen = $state(false);
let _recentsOpen = $state(false);
let _spotOpen = $state(false);
/** Id of the app icon currently pulsing (Spotlight soft-launch), if any. */
let _pulseId = $state<string | null>(null);
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
export function layout(): HomeLayout {
  return _layout;
}

function clearOverlays() {
  _ncOpen = false;
  _recentsOpen = false;
  _spotOpen = false;
}

/** Open an app screen (from dock/grid/recents/library). Records a recent (built-ins
 * only — third-party ids don't pollute the frequently-used set) so the App Library
 * "Frequently Used" group stays live, mirroring the shell's `open`. */
export function open(id: string): void {
  if (appTitleKey(id) !== null) pushRecent(id);
  clearOverlays();
  _surface = { kind: "app", id };
}

/** Enter the iOS-style "App Library" page (grouped apps + frequently used). */
export function enterLibrary(): void {
  clearOverlays();
  _pulseId = null;
  _surface = { kind: "library" };
}

/** Spotlight "soft launch": pulse the icon on home, stay home. */
export function softLaunch(id: string): void {
  clearOverlays();
  _surface = { kind: "home" };
  _pulseId = id;
}

/** Persist a new home layout (used by HomeDock/EditHome actions). */
export function applyLayout(next: HomeLayout): void {
  _layout = next;
  saveLayout(next);
}

/** Return to the home surface (home pill / back / hardware home). */
export function goHome(): void {
  clearOverlays();
  _pulseId = null;
  _surface = { kind: "home" };
}

export function lock(): void {
  clearOverlays();
  _surface = { kind: "lock" };
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

/** Reset to the initial home state (for tests / HMR). */
export function resetShellState(): void {
  _surface = { kind: "home" };
  _ncOpen = false;
  _recentsOpen = false;
  _spotOpen = false;
  _pulseId = null;
  // Same non-empty seeding as module init (see seededHome): a fresh / empty
  // persisted home must not blank the launcher grid + dock.
  _layout = seededHome();
}


