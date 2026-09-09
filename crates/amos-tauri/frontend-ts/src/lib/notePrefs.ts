/**
 * lib/notePrefs.ts — persisted Notes preferences (small, pure).
 *
 * Keep prefs separate from note content (`amos.notes`) so toggling a setting
 * never rewrites/validates the note list. Load/save go through the shared
 * `amos.notesPrefs` store key; normalization is pure + headless-tested so a
 * corrupt/legacy value degrades to defaults, never a crash.
 */

import { readStoreValue, writeStoreValue } from "./amosStore";

export const NOTES_PREFS_KEY = "amos.notesPrefs";

export interface NotesPrefs {
  /** When on, tapping a collapsed note row opens the full-page editor instead of
   *  expanding it inline. Default off (preserves the existing list behaviour). */
  openInEditor: boolean;
  /** When on, the active list is ordered by last-modified (desc), pinned on top.
   *  Default off (preserves insertion/newest-first order). */
  sortByModified: boolean;
}

export const defaultNotesPrefs: NotesPrefs = { openInEditor: false, sortByModified: false };

/** Pure: coerce unknown stored bytes into a sane [`NotesPrefs`]. */
export function normalizeNotesPrefs(raw: unknown): NotesPrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultNotesPrefs;
  const o = raw as Record<string, unknown>;
  return {
    openInEditor: typeof o.openInEditor === "boolean" ? o.openInEditor : false,
    sortByModified: typeof o.sortByModified === "boolean" ? o.sortByModified : false,
  };
}

/** Read + normalize prefs from the store. */
export function loadNotesPrefs(): NotesPrefs {
  return normalizeNotesPrefs(readStoreValue<unknown>(NOTES_PREFS_KEY, undefined));
}

/** Persist prefs (single object write — safe for a small settings blob). */
export function saveNotesPrefs(prefs: NotesPrefs): void {
  writeStoreValue(NOTES_PREFS_KEY, prefs);
}
