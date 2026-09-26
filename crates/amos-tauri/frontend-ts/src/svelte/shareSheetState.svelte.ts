/**
 * shareSheet.svelte.ts — the reactive host for the system share sheet.
 *
 * Holds the shared payload plus the snapshot of shortcuts that opted in at the
 * moment the sheet opened. Runes module so `ShareSheet.svelte` reads live state
 * and any app (e.g. Files) can call `openShareSheet(...)` without prop-drilling.
 *
 * All decisions live in `lib/shareSheet`; this file only adds reactivity and the
 * one I/O touch (reading the shortcut library).
 */
import { loadShortcuts, type Shortcut } from "../lib/shortcuts";
import {
  normalizeSharePayload,
  shareSheetTargets,
  type SharePayload,
} from "../lib/shareSheet";

let payload = $state<SharePayload | null>(null);
let targets = $state<Shortcut[]>([]);

/** Reactive read of the payload, or `null` when the sheet is closed. */
export function sharePayload(): SharePayload | null {
  return payload;
}

/** Reactive read of the share targets captured when the sheet opened. */
export function shareTargets(): Shortcut[] {
  return targets;
}

/**
 * Open the sheet with `raw`. Returns `false` (and does not open) when the payload
 * is unusable — the caller can then surface "nothing to share" instead of showing
 * an empty sheet.
 */
export function openShareSheet(raw: unknown): boolean {
  const normalized = normalizeSharePayload(raw);
  if (normalized === null) return false;
  payload = normalized;
  targets = shareSheetTargets(loadShortcuts());
  return true;
}

/** Close the sheet and drop the captured snapshot. */
export function closeShareSheet(): void {
  payload = null;
  targets = [];
}
