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
