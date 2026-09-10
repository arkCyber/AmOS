/**
 * AmOS-local SMS drafts.
 *
 * **Why local:** on Android 4.4+ only the *default* SMS app may write to the
 * system provider, so a non-default app cannot persist drafts into
 * `content://sms` (type=3). Rows of that kind are still *read* by the SMS
 * provider and shown in this folder when another app created them, but our own
 * drafts live here — honestly labelled as AmOS drafts in the UI.
 *
 * Pure helpers (no I/O) so they are unit-testable; the screen owns the store.
 */

export interface SmsDraft {
  /** Stable id (address-derived + timestamp) for list keys / deletion. */
  id: string;
  /** Destination the draft is addressed to (as typed; validated on send). */
  address: string;
  /** Draft body. */
  text: string;
  /** Last edit time (epoch ms) — drafts are listed newest-first. */
  ts: number;
}

/** Shared-store key for the local drafts. */
export const DRAFT_KEY = "amos.sms.drafts";

/** Upper bound on stored drafts (one per address, but bounded regardless). */
export const DRAFT_CAP = 50;

/** Stable id for a draft of `address`: one draft per destination. */
export function draftId(address: string): string {
  return `d:${address.trim()}`;
}

/** Corruption / back-compat guard for a stored draft list. */
export function normalizeDrafts(list: unknown): SmsDraft[] {
  if (!Array.isArray(list)) return [];
  const out: SmsDraft[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.address !== "string" || o.address.trim() === "") continue;
    if (typeof o.text !== "string" || o.text.trim() === "") continue; // empty draft = nothing
    out.push({
      id: typeof o.id === "string" && o.id !== "" ? o.id : draftId(o.address),
      address: o.address.trim(),
      text: o.text,
      ts: typeof o.ts === "number" && Number.isFinite(o.ts) ? o.ts : 0,
    });
  }
  return sortDrafts(out).slice(0, DRAFT_CAP);
}

/** Newest first. */
export function sortDrafts(list: readonly SmsDraft[]): SmsDraft[] {
  return [...list].sort((a, b) => b.ts - a.ts);
}

/**
 * Save (or replace) the draft for `address` — one draft per destination, so
 * editing and re-saving does not pile up copies. Blank text removes it instead
 * (an "empty draft" is not a draft).
 */
export function saveDraft(
  list: readonly SmsDraft[],
  address: string,
  text: string,
  now: number,
): SmsDraft[] {
  const addr = address.trim();
  if (!addr || text.trim() === "") return removeDraft(list, draftId(addr));
  const rest = list.filter((d) => d.id !== draftId(addr));
  return sortDrafts([...rest, { id: draftId(addr), address: addr, text, ts: now }]).slice(
    0,
    DRAFT_CAP,
  );
}

/** Remove one draft by id (no-op when absent). */
export function removeDraft(list: readonly SmsDraft[], id: string): SmsDraft[] {
  return list.filter((d) => d.id !== id);
}
