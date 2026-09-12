/**
 * lib/notesRag.ts — UI-agnostic orchestration that turns the daemon `Rag` client
 * (`lib/rag.ts`) into "index my notes / ask my files".
 *
 * The heavy lifting (embedding, vector search, persistence) stays in the daemon.
 * This module is only the *decisions the UI makes* — stable ids, which notes to
 * upsert, which indexed ids to drop on delete/archive, how to turn retrieved
 * passages into a cited context for the chat model, and a small busy/error state
 * machine a Svelte component can mount. Every function is pure + headless-tested;
 * the actual `rag.ts` calls are wired by the component.
 */

import type { RagHit } from "./rag";
import { noteTitle, type Note } from "./notes";

/** Namespace prefix put in front of a note id so a note's passage is addressable
 *  in the daemon index without colliding with other sources (e.g. `pdf:…`). */
export const NOTES_RAG_PREFIX = "note:";

/** Durable-store key holding the ids the UI last told the daemon it indexed
 *  (the daemon has no list RPC, so this is the UI's own bookkeeping for prune). */
export const NOTES_RAG_INDEXED_KEY = "amos.notesRagIndexed";

/** The stable daemon index id for a note (upsert by this id on edit is idempotent). */
export function noteRagId(noteId: string): string {
  return `${NOTES_RAG_PREFIX}${noteId}`;
}

/** Strip the prefix back to a note id; `null` when the id is from another source. */
export function noteIdFromRagId(ragId: string): string | null {
  if (!ragId.startsWith(NOTES_RAG_PREFIX)) return null;
  const rest = ragId.slice(NOTES_RAG_PREFIX.length);
  return rest.length > 0 ? rest : null;
}

/** One upsert into the daemon index. */
export interface RagIndexOp {
  id: string;
  text: string;
}

/** Index ops for every (non-empty) active note — used for a bulk first index.
 *  Upsert semantics make this idempotent, so re-running after an edit is safe. */
export function notesToIndex(notes: readonly Note[]): RagIndexOp[] {
  const ops: RagIndexOp[] = [];
  for (const n of notes) {
    const text = n.text.trim();
    if (!text) continue;
    ops.push({ id: noteRagId(n.id), text });
  }
  return ops;
}

/**
 * Which currently-indexed ids should be **removed** because their note is no
 * longer active (deleted, trashed, or archived out of the "ask" scope).
 * `indexedIds` is what the UI last told the daemon it indexed (the daemon has no
 * list RPC, so this is the UI's own bookkeeping).
 */
export function notesToRemove(
  activeNoteIds: readonly string[],
  indexedIds: readonly string[],
): string[] {
  const active = new Set(activeNoteIds);
  const out: string[] = [];
  for (const ragId of indexedIds) {
    const noteId = noteIdFromRagId(ragId);
    if (noteId !== null && !active.has(noteId)) out.push(ragId);
  }
  return out;
}

/**
 * Human, citation-style label for one retrieval hit: the source note's title
 * when the hit is a (still-present) note, else the raw id (e.g. a future
 * `pdf:` source, or a note deleted since indexing). Never invents a title.
 */
export function hitSourceLabel(hitId: string, notes: readonly Note[]): string {
  const noteId = noteIdFromRagId(hitId);
  if (noteId === null) return hitId;
  const n = notes.find((x) => x.id === noteId);
  if (!n) return noteId;
  return noteTitle(n.text) || noteId;
}

/**
 * Compact, deterministic "cited context": each retrieved passage as a `- …` line.
 * At least the first hit is always kept (so a long single passage still surfaces);
 * further lines are only added while the budget allows. Empty input → empty string.
 */
export function buildCitedSnippet(hits: readonly RagHit[], maxChars = 1200): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const h of hits) {
    const p = h.passage.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const line = `- ${p}`;
    if (lines.length > 0 && used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Turn a user question + retrieved snippet into the context-augmented prompt for
 * the chat model (this is the "拼 Context → 喂本地模型" step). When there are no
 * notes to cite, returns the bare question.
 */
export function buildRagPrompt(question: string, snippet: string): string {
  const q = question.trim();
  const snip = snippet.trim();
  if (!snip) return q;
  return [
    "根据以下我保存的笔记内容回答问题。若笔记里没有依据，请如实说明，再给出一般性回答。",
    "",
    "[我的笔记片段]",
    snip,
    "",
    `[问题] ${q}`,
  ].join("\n");
}

// ---- A tiny busy/error state machine the Notes/Ai component can mount. ----

export type RagPhase = "idle" | "indexing" | "asking" | "error";

export interface RagUiState {
  phase: RagPhase;
  /** Human message for the last failure (empty when idle/ok). */
  error: string;
}

export type RagUiEvent =
  | { type: "index_started" }
  | { type: "index_done" }
  | { type: "index_failed"; error: string }
  | { type: "ask_started" }
  | { type: "ask_done" }
  | { type: "ask_failed"; error: string }
  | { type: "reset" };

export const initialRagUi: RagUiState = { phase: "idle", error: "" };

/** Start a new index/ask only from `idle` or `error` (one op at a time). */
export function ragUiReducer(state: RagUiState, event: RagUiEvent): RagUiState {
  switch (event.type) {
    case "index_started":
      return state.phase === "idle" || state.phase === "error"
        ? { phase: "indexing", error: "" }
        : state;
    case "index_done":
      return state.phase === "indexing" ? { phase: "idle", error: "" } : state;
    case "index_failed":
      return state.phase === "indexing" ? { phase: "error", error: event.error } : state;
    case "ask_started":
      return state.phase === "idle" || state.phase === "error"
        ? { phase: "asking", error: "" }
        : state;
    case "ask_done":
      return state.phase === "asking" ? { phase: "idle", error: "" } : state;
    case "ask_failed":
      return state.phase === "asking" ? { phase: "error", error: event.error } : state;
    case "reset":
      return initialRagUi;
  }
}
