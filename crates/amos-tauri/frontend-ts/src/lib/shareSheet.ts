/**
 * shareSheet.ts — the *pure* half of the system share sheet.
 *
 * A share sheet is a two-sided contract: some surface **produces** content (a file,
 * a note) and some handler **consumes** it. For a long time `Shortcut.quickActions`
 * declared `"shareSheet"` but nothing ever read it and no surface ever produced a
 * payload — the field was pure declaration. This module is the consuming half's
 * brain: it decides *what may be shared* (normalization) and *who is a share
 * target* (a shortcut that opted in). The reactive host and the overlay live in
 * `svelte/shareSheet.svelte.ts` / `ShareSheet.svelte`; nothing here touches a window,
 * so every rule is unit-testable headlessly.
 */
import type { QuickActionType, Shortcut } from "./shortcuts";

/** What kind of content is being shared. */
export type ShareKind = "text" | "file";

/** A payload handed to the sheet: the content plus a short label for its header. */
export interface SharePayload {
  kind: ShareKind;
  /** The content itself (file text / note text). Never empty after normalization. */
  value: string;
  /** A short human label (file name / note title). */
  title: string;
}

/**
 * Coerce a possibly-malformed payload into a valid one, or reject it.
 *
 * Rejection (returns `null`) is deliberate and total: sharing content that is
 * missing or whitespace-only would open a sheet that hands an empty string to
 * every target — a handler that appears to run and does nothing. The producer
 * gets told "no" instead. `title` is optional and falls back to the trimmed
 * value's first line so the header is never the literal word "undefined".
 */
export function normalizeSharePayload(raw: unknown): SharePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind: ShareKind = o.kind === "file" ? "file" : "text";
  if (typeof o.value !== "string") return null;
  const value = o.value;
  if (value.trim() === "") return null;
  const title = typeof o.title === "string" && o.title.trim() !== ""
    ? o.title.trim()
    : value.trim().split("\n", 1)[0]!.slice(0, 80);
  return { kind, value, title };
}

/** Build a text payload (REQ-A713). The **domain** owns this shape: a shell that
 *  inlines `{ kind: "text", … }` is rewriting the vocabulary it should be reading
 *  (the same rule the drag-and-drop kernel enforces), so producers call this. */
export function textShare(value: string, title: string): SharePayload {
  return { kind: "text", value, title };
}

/** Build a file payload (see `textShare` for why the literal lives here). */
export function fileShare(value: string, title: string): SharePayload {
  return { kind: "file", value, title };
}

/** Whether a shortcut opted into the system share sheet. */
export function isShareTarget(shortcut: Shortcut): boolean {
  return shortcut.quickActions.includes("shareSheet");
}

/**
 * The shortcuts that should appear as handlers in the share sheet, in library
 * order. A shortcut with no actions is still listed — running it is a no-op, but
 * that is the user's own authored choice, not a sheet-invented dead switch.
 */
export function shareSheetTargets(shortcuts: readonly Shortcut[]): Shortcut[] {
  return shortcuts.filter(isShareTarget);
}

/**
 * Pure toggle for the editor: return `quickActions` with share-sheet membership
 * set to `on`, preserving any other surfaces in their current order. Kept pure so
 * the editor's write is a value, not a mutation.
 */
export function withShareSheet(
  quickActions: readonly QuickActionType[],
  on: boolean,
): QuickActionType[] {
  const rest = quickActions.filter((q) => q !== "shareSheet");
  return on ? [...rest, "shareSheet"] : rest;
}

