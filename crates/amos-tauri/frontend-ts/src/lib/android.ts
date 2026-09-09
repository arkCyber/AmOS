/**
 * Pure helpers + persistence for the 安卓应用 (Android compatibility) app.
 *
 * The UI lists legacy Waydroid/demo apps (via the shared gRPC pipe through the
 * Rust `get_android_apps` command) and launches them on tap. These helpers keep
 * the recents list and PNG-bytes->data-URI conversion free of DOM so they are
 * unit-testable headlessly.
 */
import { readStoreValue, writeStoreValue } from "./amosStore";

/** Serializable view of an installed app returned by `get_android_apps`. */
export interface AndroidApp {
  name: string;
  package_name: string;
  icon_path?: string;
  activity?: string;
}

/** Result of `launch_android_app`. */
export interface AndroidLaunchResult {
  success: boolean;
  window_id?: string;
  window_label?: string;
  error?: string;
}

export interface AndroidRecent {
  package_name: string;
  name: string;
  ts: number;
}

export const ANDROID_RECENT_KEY = "amos.android.recent";

/** Load the "recently launched" package list (empty array when nothing stored). */
export function readRecents(): AndroidRecent[] {
  const l = readStoreValue<AndroidRecent[] | null>(ANDROID_RECENT_KEY, null);
  return Array.isArray(l) ? l : [];
}

/** Prepend a launched package (dedup, cap at 6) and persist. */
export function addRecent(list: AndroidRecent[], item: AndroidRecent): AndroidRecent[] {
  const next = [item, ...list.filter((x) => x.package_name !== item.package_name)].slice(0, 6);
  writeStoreValue(ANDROID_RECENT_KEY, next);
  return next;
}

/** PNG bytes (0..255) from the backend -> a base64 data URI for an <img src>. */
export function bytesToDataUri(bytes: ArrayLike<number>): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return "data:image/png;base64," + btoa(bin);
}

/** A friendly tile label: the app name when present, else its package. */
export function displayName(a: { name?: string; package_name: string }): string {
  return a.name || a.package_name;
}

/** How a launched package is surfaced in the grid: actively used vs. parked. */
export type AndroidRunTier = "running" | "background";

/**
 * Classify a package's container lifecycle tier for UI surfacing, from the
 * daemon's live LMK snapshot (`android_lmk_tasks`, mirror of `GetLmkSnapshot`):
 * focused / visible / foreground-service tasks are "running"; frozen ("cached")
 * or plain background tasks are "background". Absent or stopped / unknown →
 * `null` (no indicator), so the tile never lies about an app being alive.
 */
export function runTierForPackage(
  pkg: string,
  tasks: { package_name: string; state: string }[],
): AndroidRunTier | null {
  const task = tasks.find((t) => t.package_name === pkg);
  if (!task) return null;
  switch (task.state) {
    case "foreground":
    case "visible":
    case "foreground_service":
      return "running";
    case "background":
    case "cached":
      return "background";
    default:
      return null; // stopped / unknown → nothing to show
  }
}
