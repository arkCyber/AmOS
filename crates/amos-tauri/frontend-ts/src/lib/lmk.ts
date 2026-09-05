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

/** A window in the Rust wm snapshot (`wm_windows`). */
export interface WmWindowInfo {
  label: string;
}

/** A live container task from the daemon LMK snapshot (`android_lmk_tasks`). */
export interface AndroidLmkTask {
  window_id: string;
  package_name: string;
  state: string;
}

function isLegacyLabel(label: string): boolean {
  return label.startsWith("legacy:");
}

/**
 * Pure reconciliation: which currently-registered `legacy:*` surfaces have no
 * matching live container task (so their app died without a `lmk-surface` event)?
 * `tasks` is the authoritative daemon `GetLmkSnapshot`; `windows` the Rust
 * `wm_windows`. The shell closes these to stay consistent with the authority.
 */
export function staleLegacySurfaceLabels(
  windows: WmWindowInfo[],
  tasks: AndroidLmkTask[],
): string[] {
  const alive = new Set(
    tasks.filter((t) => t.window_id).map((t) => legacySurfaceLabel(t.window_id)),
  );
  return windows
    .filter((w) => isLegacyLabel(w.label) && !alive.has(w.label))
    .map((w) => w.label);
}

/** Fetch the daemon's authoritative live LMK tasks (null when the daemon is down). */
export async function androidLmkTasks(): Promise<AndroidLmkTask[] | null> {
  return invoke<AndroidLmkTask[]>("android_lmk_tasks");
}

/** Fetch the Rust wm snapshot windows (null when not inside Tauri). */
export async function wmWindows(): Promise<{ windows?: WmWindowInfo[] } | null> {
  return invoke<{ windows?: WmWindowInfo[] }>("wm_windows");
}

/**
 * Reconcile: close any `legacy:*` surface that is registered but whose container
 * task is no longer alive per the authoritative daemon snapshot. Guards: if the
 * daemon snapshot is unavailable (daemon down ≠ app dead) or we're not bridged,
 * nothing is closed. Returns the number of stale surfaces closed.
 */
export async function reconcileLegacySurfaces(): Promise<number> {
  const tasks = await androidLmkTasks();
  if (!tasks) return 0; // daemon down is not "everything is dead".
  const wm = await wmWindows();
  const stale = staleLegacySurfaceLabels(wm?.windows ?? [], tasks);
  for (const label of stale) {
    await invoke("wm_close", { label });
  }
  return stale.length;
}

/**
 * Subscribe to the `lmk-surface` feed and auto-tear-down any surface the container
 * reclaimed/destroyed, then reconcile the rest against the authoritative snapshot
 * (covers events we might have missed). Returns an unsubscribe (noop outside Tauri).
 */
export async function startLmkSurfaceWatcher(): Promise<() => void> {
  return subscribe(LMK_SURFACE_EVENT, (raw) => {
    const p = raw as LmkSurfacePayload;
    if (shouldTearDown(p)) {
      void closeLegacySurface(p.window_id);
    }
    // Event-driven nudge: reconcile the whole legacy set too (cheap, rare).
    void reconcileLegacySurfaces();
  });
}

/** Default cadence for the background periodic reconcile (ms). */
export const RECONCILE_INTERVAL_MS = 30_000;
/**
 * Run one reconcile immediately (catches surfaces stale from before the shell
 * started watching), then every `intervalMs`. Returns a stop() that clears the
 * timer. No-op when not bridged (reconcile guards internally). A DOM-side helper;
 * the pure decision logic stays in `reconcileLegacySurfaces`.
 */
export function startPeriodicReconcile(intervalMs = RECONCILE_INTERVAL_MS): () => void {
  void reconcileLegacySurfaces();
  const id = window.setInterval(() => {
    void reconcileLegacySurfaces();
  }, intervalMs);
  return () => window.clearInterval(id);
}

// ---- LMK debug / user entry (bring-up `docs/android-lmk-e2e.md` G3) ---------

/** One container app the daemon LMK reclaimed/froze in a trigger round. */
export interface LmkVictim {
  package_name: string;
  window_id: string;
  killed: boolean;
}

/** Outcome of an `android_lmk_debug` call (serialized from `LmkDebugOutcome`). */
export interface LmkDebugOutcome {
  victims: LmkVictim[];
  note: string;
}

/**
 * Drive the daemon LMK from the System UI (bring-up debug entry):
 * `action` `"trigger"` asks the daemon to reclaim LRU victims (budget defaults to
 * 1); `"apply_freeze" | "apply_thaw" | "apply_reclaim"` target one container app
 * by `packageName`. Returns `null` when not bridged / daemon down.
 */
export async function androidLmkDebug(
  action: "trigger" | "apply_freeze" | "apply_thaw" | "apply_reclaim",
  packageName?: string,
  budget?: number,
): Promise<LmkDebugOutcome | null> {
  const args: Record<string, unknown> = { action };
  if (packageName !== undefined) args.packageName = packageName;
  if (budget !== undefined) args.budget = budget;
  return invoke<LmkDebugOutcome>("android_lmk_debug", args);
}

