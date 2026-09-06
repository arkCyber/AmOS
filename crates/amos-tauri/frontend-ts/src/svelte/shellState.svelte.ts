/**
 * shellState.svelte.ts — Svelte top-level shell navigation state (Phase-3).
 *
 * The React-free counterpart of App.tsx's Shell state machine. A future
 * `Shell.svelte` reads this runes store to decide what to render (home / an app
 * screen / lock / edit) and the open overlay flags, and persists amos.home.layout
 * the way the React shell does. Actions are pure state transitions with NO React
 * on the import graph.
 *
 * NOTE: opening an app also clears that app's notification badge + records a
 * recent — that needs a React-free APPS meta module (id→titleKey), a later
 * Phase-3 foundation. Until then this module owns only surface/overlay/layout.
 */
import { saveLayout, type HomeLayout } from "../lib/amosStore";
import { readStoreValue } from "../lib/amosStore";

export type Surface =
  | { kind: "home" }
  | { kind: "app"; id: string }
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
/** The persisted home layout (kept in sync when we reach the store). */
const initialLayout: HomeLayout =
  readStoreValue<HomeLayout | null>("amos.home.layout", null) ?? {
    page: [],
    dock: [],
    hidden: [],
  };
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

/** Open an app screen (from dock/grid/recents). */
export function open(id: string): void {
  clearOverlays();
  _surface = { kind: "app", id };
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
  _layout =
    readStoreValue<HomeLayout | null>("amos.home.layout", null) ?? {
      page: [],
      dock: [],
      hidden: [],
    };
}


