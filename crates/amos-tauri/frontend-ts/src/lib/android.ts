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

/**
 * What `get_android_apps` answers: the list **plus which runtime produced it**.
 *
 * A host with no Android container (any macOS desktop, a Linux box without
 * Waydroid) is served by the daemon's built-in fixture, and the UI must say so —
 * presenting fixture data as "apps installed on this machine" is the exact
 * fabrication the rest of AmOS refuses.
 */
export interface AndroidAppsReply {
  apps: AndroidApp[];
  /** The runtime driver that answered (`waydroid` / `demo`); `""` when unknown. */
  runtime: string;
  /** True when `apps` is the built-in fixture, not this machine's apps. */
  demo: boolean;
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

/**
 * Normalize a `get_android_apps` reply. **Total** (never throws): an unknown
 * payload degrades to an empty list, and a malformed row is dropped rather than
 * rendered as a nameless tile.
 *
 * The `demo` flag is taken **only** from a literal `true`: an older daemon (or a
 * hand-written fixture) that omits it means "unknown", and `false` is the safe
 * reading there — the banner accuses the host of serving fixture data, so it must
 * follow a positive claim, never a missing field.
 */
export function normalizeAppsReply(raw: unknown): AndroidAppsReply {
  // A bare array (the pre-`AndroidAppsReply` shape) is still accepted: one less
  // way for a caller to be left with nothing, and `runtime` stays unknown.
  if (Array.isArray(raw)) {
    return { apps: normalizeAppRows(raw), runtime: "", demo: false };
  }
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  if (!obj) return { apps: [], runtime: "", demo: false };
  return {
    apps: normalizeAppRows(obj["apps"]),
    runtime: typeof obj["runtime"] === "string" ? obj["runtime"] : "",
    demo: obj["demo"] === true,
  };
}

function normalizeAppRows(rows: unknown): AndroidApp[] {
  if (!Array.isArray(rows)) return [];
  const out: AndroidApp[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const pkg = typeof r["package_name"] === "string" ? r["package_name"] : "";
    if (pkg === "") continue;
    out.push({
      name: typeof r["name"] === "string" ? r["name"] : "",
      package_name: pkg,
      icon_path: typeof r["icon_path"] === "string" ? r["icon_path"] : undefined,
      activity: typeof r["activity"] === "string" ? r["activity"] : undefined,
    });
  }
  return out;
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
