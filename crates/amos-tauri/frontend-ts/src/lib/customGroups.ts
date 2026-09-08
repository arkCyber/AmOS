/**
 * customGroups.ts — user-defined (custom) groups in the iOS-style App Library.
 *
 * A custom group is a NAMED folder holding a set of member app ids, persisted
 * under `amos.appLibrary.groups`. Membership is editable: apps can be added /
 * removed; the group card previews up to the first few member apps (falling back
 * to a 📁 icon when empty).
 */
import { readStoreValue, writeStoreValue } from "./amosStore";

export interface CustomGroup {
  id: string;
  /** User-typed display name (not localized — shown verbatim). */
  name: string;
  /** Member app ids (built-in or `store:*`), in the order added. */
  apps: string[];
  /** Optional user-chosen emoji icon (defaults to a folder when absent). */
  icon?: string;
}

export const CUSTOM_GROUPS_KEY = "amos.appLibrary.groups";

/** Current custom groups (empty when none / storage unavailable). */
export function getCustomGroups(): CustomGroup[] {
  const v = readStoreValue<unknown>(CUSTOM_GROUPS_KEY, []);
  if (!Array.isArray(v)) return [];
  return v.filter(
    (g): g is CustomGroup =>
      !!g &&
      typeof g === "object" &&
      typeof (g as CustomGroup).id === "string" &&
      typeof (g as CustomGroup).name === "string",
  ).map((g) => ({
    id: g.id,
    name: g.name,
    apps: Array.isArray(g.apps) ? g.apps : [],
    icon: typeof (g as CustomGroup).icon === "string" ? (g as CustomGroup).icon : undefined,
  }));
}

function persist(list: CustomGroup[]): void {
  writeStoreValue(CUSTOM_GROUPS_KEY, list);
}

/** Append a new (empty) group, persisting it; returns the created group + new list. */
export function addCustomGroup(
  current: CustomGroup[],
  name: string,
): { groups: CustomGroup[]; created: CustomGroup } {
  const trimmed = name.trim();
  const created: CustomGroup = {
    id: uid(),
    name: trimmed || "未命名分组",
    apps: [],
  };
  const groups = [...current, created];
  persist(groups);
  return { groups, created };
}

/** Replace one group's member apps (persist + return the new list). */
export function setGroupApps(
  current: CustomGroup[],
  id: string,
  apps: string[],
): CustomGroup[] {
  const groups = current.map((g) =>
    g.id === id ? { ...g, apps: [...apps] } : g,
  );
  persist(groups);
  return groups;
}

/** Rename a group (trimmed, non-empty; persist + return the new list). */
export function renameCustomGroup(
  current: CustomGroup[],
  id: string,
  name: string,
): CustomGroup[] {
  const trimmed = name.trim();
  if (!trimmed) return current;
  const groups = current.map((g) => (g.id === id ? { ...g, name: trimmed } : g));
  persist(groups);
  return groups;
}

/** Set (or clear, with `undefined`) a group's custom emoji icon (persisted). */
export function setGroupIcon(
  current: CustomGroup[],
  id: string,
  icon: string | undefined,
): CustomGroup[] {
  const groups = current.map((g) =>
    g.id === id ? { ...g, icon: icon ? icon : undefined } : g,
  );
  persist(groups);
  return groups;
}

/** Remove one custom group by id, persisting the result. */
export function removeCustomGroup(current: CustomGroup[], id: string): CustomGroup[] {
  const groups = current.filter((g) => g.id !== id);
  persist(groups);
  return groups;
}

/** A short, collision-resistant local id (works without crypto.randomUUID). */
function uid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

