/**
 * iCloud-style "cloud sync" for the Settings screen: a persisted on/off pref
 * plus a deterministic backup snapshot of the user-data stores. Pure + headless,
 * so the toggle and snapshot logic are unit-testable.
 */

export const SETTINGS_KEY = "amos.settings";
export const BACKUP_KEY = "amos.cloud.backup";
/** The user-data stores included in a backup snapshot. */
export const SYNC_STORES = [
  "amos.notes",
  "amos.files",
  "amos.photos",
  "amos.messages",
  "amos.music",
  "amos.files.fav",
  "amos.reminders",
  "amos.reminderLists",
] as const;

export interface CloudPrefs {
  enabled: boolean;
  /** Epoch ms of the last successful snapshot (0 = never). */
  lastSync: number;
}

/** Read {enabled,lastSync} out of a settings blob (tolerant of garbage). */
export function readCloud(prefs: Record<string, unknown> | null | undefined): CloudPrefs {
  if (!prefs || typeof prefs !== "object") return { enabled: false, lastSync: 0 };
  const o = prefs as Record<string, unknown>;
  return {
    enabled: o.iCloudSync === true,
    lastSync: typeof o.cloudLast === "number" && Number.isFinite(o.cloudLast) ? (o.cloudLast as number) : 0,
  };
}

/** Set one or more cloud prefs on a settings blob (returns a fresh object). */
export function setCloudPrefs(
  prefs: Record<string, unknown>,
  partial: Partial<CloudPrefs>,
): Record<string, unknown> {
  const base =
    prefs && typeof prefs === "object" && !Array.isArray(prefs) ? prefs : {};
  const next = { ...base };
  if (partial.enabled !== undefined) next.iCloudSync = partial.enabled;
  if (partial.lastSync !== undefined) next.cloudLast = partial.lastSync;
  return next;
}

/** Deterministic snapshot: stores keyed by fixed order, then JSON. The input is a
 * map of store-key → value; only present (non-undefined) values are included. */
export function snapshotStores(stores: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const k of SYNC_STORES) {
    const v = stores[k];
    if (v !== undefined) out[k] = v;
  }
  return JSON.stringify(out);
}
