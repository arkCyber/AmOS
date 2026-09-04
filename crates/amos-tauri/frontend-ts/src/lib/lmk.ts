/**
 * Android LMK surface bridge: consumes the daemon's `lmk-surface` feed (forwarded
 * by `crates/amos-tauri/src/android_lmk.rs` from the `WatchLmk` gRPC stream) and
 * tears down the matching `legacy:<window_id>` external surface in the wm core
 * when the container reclaimed/destroyed it.
 *
 * Pure helpers are unit-tested; `startLmkSurfaceWatcher` is wired once at the app
 * level (outside Tauri it degrades to a no-op unsubscribe).
 */

import { invoke, subscribe } from "./backend";

/** Tauri event name for one daemon `WatchLmk` decision (Rust side emits this). */
export const LMK_SURFACE_EVENT = "lmk-surface";

/** Serializable container LMK decision forwarded from the Rust bridge. */
export interface LmkSurfacePayload {
  window_id: string;
  package_name: string;
  /** `"reclaimed"` | `"frozen"` | `"thawed"` | `"destroyed"` | `"unknown"`. */
  kind: string;
  /** True when the surface should be torn down (reclaimed/destroyed). */
  close_surface: boolean;
}

/** The `amos-wm` external-surface label for a container window id. */
export function legacySurfaceLabel(windowId: string): string {
  return `legacy:${windowId}`;
}

/** Whether an LMK event asks the shell to tear down the legacy surface. */
export function shouldTearDown(p: LmkSurfacePayload): boolean {
  return Boolean(p && p.close_surface && p.window_id);
}

/** Tear down the `legacy:<windowId>` external surface via the wm core. */
export async function closeLegacySurface(windowId: string): Promise<boolean> {
  const snap = await invoke("wm_close", { label: legacySurfaceLabel(windowId) });
  return snap != null;
}

/**
 * Subscribe to the `lmk-surface` feed and auto-tear-down any surface the container
 * reclaimed/destroyed. Returns an unsubscribe (a noop outside Tauri).
 */
export async function startLmkSurfaceWatcher(): Promise<() => void> {
  return subscribe(LMK_SURFACE_EVENT, (raw) => {
    const p = raw as LmkSurfacePayload;
    if (shouldTearDown(p)) {
      void closeLegacySurface(p.window_id);
    }
  });
}
