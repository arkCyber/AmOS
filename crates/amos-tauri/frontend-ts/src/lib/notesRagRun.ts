/**
 * lib/notesRagRun.ts — the *IO* half of "ask my notes": it performs the daemon
 * `Rag` calls that `lib/notesRag.ts` decides *about*.
 *
 * `notesRag.ts` stays pure (ids, index/remove sets, cited snippet, UI state
 * machine); this module is the thin async glue a Svelte component mounts,
 * taking the `RagClient` as an argument so it is unit-testable with a fake (no
 * Tauri / no daemon). Honesty rule: only **daemon-confirmed** outcomes are
 * recorded — an offline `null` reply is never treated as "indexed"/"removed",
 * so a later run retries it instead of silently believing it succeeded.
 */

import type { Note } from "./notes";
import { notesToIndex, notesToRemove } from "./notesRag";
import { ragIndex, ragQuery, ragRemove, type RagQueryResult, type RagRemoveReply } from "./rag";

/** The subset of the daemon `Rag` client the orchestrator uses (injectable). */
export interface RagClient {
  index(id: string, text: string): Promise<{ indexed: boolean; dimension: number } | null>;
  remove(id: string): Promise<RagRemoveReply | null>;
  query(query: string): Promise<RagQueryResult | null>;
}

/** The real client: each call degrades to `null` outside the Tauri shell. */
export const liveRagClient: RagClient = {
  index: (id, text) => ragIndex(id, text),
  remove: (id) => ragRemove(id),
  query: (q) => ragQuery(q),
};

/** Outcome of one [`syncNotesIndex`] pass. Every field is daemon-confirmed. */
export interface NotesIndexResult {
  /** Ids the daemon confirmed it (re)indexed — the new bookkeeping set. */
  indexed: string[];
  /** Active notes whose upsert got no confirmation (offline) — retried later. */
  skipped: number;
  /** Stale ids the daemon confirmed removed. */
  removed: string[];
}

/**
 * Upsert every active note into the daemon index and prune ids whose note is no
 * longer active. Idempotent (upsert semantics), so it is safe to run on every
 * ask. Returns the daemon-confirmed bookkeeping set the caller should persist.
 */
export async function syncNotesIndex(
  client: RagClient,
  notes: readonly Note[],
  indexedIds: readonly string[],
): Promise<NotesIndexResult> {
  const indexed: string[] = [];
  let skipped = 0;
  for (const op of notesToIndex(notes)) {
    const r = await client.index(op.id, op.text);
    if (r && r.indexed) indexed.push(op.id);
    else skipped += 1;
  }
  const activeNoteIds = notes.map((n) => n.id);
  const removed: string[] = [];
  for (const id of notesToRemove(activeNoteIds, indexedIds)) {
    const r = await client.remove(id);
    if (r && r.removed) removed.push(id);
  }
  return { indexed, skipped, removed };
}

/**
 * Retrieve the notes nearest to `question`. `null` means the daemon was not
 * reachable / the reply was malformed — the UI shows an honest "offline"
 * notice rather than an empty (but confident-looking) answer.
 */
export async function askNotes(
  client: RagClient,
  question: string,
): Promise<RagQueryResult | null> {
  const q = question.trim();
  if (!q) return null;
  return client.query(q);
}
