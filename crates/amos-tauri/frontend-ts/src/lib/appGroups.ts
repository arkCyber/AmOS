/**
 * appGroups.ts — React-free grouping model for the iOS-style "App Library" page.
 *
 * Every known built-in app id maps to exactly one display category; unknown /
 * third-party (`store:…`) ids fall back to the catch-all "other" group. Pure TS
 * so the Svelte AppLibrary screen and any test share the same logic (no React on
 * the import graph).
 *
 * Two pure helpers:
 *   - categorizeApps(available) → ordered, non-empty category folders
 *   - frequentTools(recents, available) → the "Frequently Used" set (top group)
 */
import type { MessageKey } from "../i18n/locales/zh";

export type CategoryId =
  | "communication"
  | "media"
  | "productivity"
  | "utilities"
  | "system"
  | "other";

/** Built-in app id → its category (defaults to "other" for the unknown/ext ids). */
const ASSIGN: Record<string, CategoryId> = {
  phone: "communication",
  messages: "communication",
  contacts: "communication",
  mail: "communication",
  camera: "media",
  photos: "media",
  music: "media",
  player: "media",
  vmemos: "media",
  notes: "productivity",
  reminders: "productivity",
  calendar: "productivity",
  calculator: "productivity",
  ai: "productivity",
  interpreter: "productivity",
  monitor: "productivity",
  devocare: "system",
  clock: "utilities",
  weather: "utilities",
  maps: "utilities",
  files: "utilities",
  magnifier: "utilities",
  settings: "system",
  privacy: "system",
  android: "system",
  store: "system",
  terminal: "utilities",
};

export function categoryOf(id: string): CategoryId {
  return ASSIGN[id] ?? "other";
}

/** Display order + localized label for each category (App Library folder row). */
export interface CategoryDef {
  id: CategoryId;
  nameKey: MessageKey;
}

export const CATEGORY_ORDER: CategoryDef[] = [
  { id: "communication", nameKey: "group.communication" },
  { id: "media", nameKey: "group.media" },
  { id: "productivity", nameKey: "group.productivity" },
  { id: "utilities", nameKey: "group.utilities" },
  { id: "system", nameKey: "group.system" },
  { id: "other", nameKey: "group.other" },
];

/** A non-empty category folder, with the ids that belong to it (input order). */
export interface CategoryFolder {
  id: CategoryId;
  nameKey: MessageKey;
  apps: string[];
}

/** Bucket `available` ids into categories, dropping empty groups, in display order. */
export function categorizeApps(available: readonly string[]): CategoryFolder[] {
  const buckets = new Map<CategoryId, string[]>();
  for (const id of available) {
    const c = categoryOf(id);
    const list = buckets.get(c);
    if (list) list.push(id);
    else buckets.set(c, [id]);
  }
  const out: CategoryFolder[] = [];
  for (const def of CATEGORY_ORDER) {
    const apps = buckets.get(def.id);
    if (apps && apps.length > 0) out.push({ id: def.id, nameKey: def.nameKey, apps });
  }
  return out;
}

/**
 * The top "Frequently Used" group: the most-recently-opened apps (recents order,
 * most recent first) that are still available, capped at `max`. Apps outside
 * `available` (hidden/uninstalled) are dropped so we never show a stale icon.
 */
export function frequentTools(
  recents: readonly string[],
  available: readonly string[],
  max = 8,
): string[] {
  const avail = new Set(available);
  const out: string[] = [];
  for (const id of recents) {
    if (out.length >= max) break;
    if (avail.has(id)) out.push(id);
  }
  return out;
}
