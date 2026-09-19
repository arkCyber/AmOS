/**
 * customGroups.ts — user-defined (custom) groups in the iOS-style App Library.
 *
 * A custom group is a NAMED folder holding a set of member app ids, persisted
 * under `amos.appLibrary.groups`. Membership is editable: apps can be added /
 * removed; the group card previews up to the first few member apps (falling back
 * to a 📁 icon when empty).
 */
import { readStoreValue, writeStoreValue } from "./amosStore";
import { localId } from "./localId";

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
    // REQ-A406: `apps` 也要**逐元素**校验。读侧对 `id`/`name` 是严格的（认不出就丢整行），
    // 却把 `apps` 原样透传 —— 于是 `apps: [1, "notes"]` 会变成"分组里有一个 id=1 的成员"：
    // 一个用户可编辑的 localStorage 就能让 App Library 渲染出不存在的瓦片。成员本来就只有
    // 一个含义（应用 id），所以非字符串元素直接丢掉，与 `id`/`name` 的判据一致。
    apps: Array.isArray(g.apps) ? g.apps.filter((a): a is string => typeof a === "string") : [],
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
    // A group id is identity: `renameCustomGroup` / `setGroupApps` / `removeCustomGroup`
    // all match on it. Prefer the platform UUID when the WebView has it, else the shared
    // `localId` (REQ-A401) — never the old `Date.now() + 6 random digits` fallback, which
    // collides in a tight loop under a frozen clock.
    id: newGroupId(),
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

/**
 * A new group id: the platform UUID when the WebView exposes one, else the shared
 * `localId` (REQ-A401). Both are counter/entropy-backed; neither is
 * `Date.now()` + a handful of random digits, which is what this used to be.
 */
function newGroupId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return localId("g");
}

