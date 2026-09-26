/**
 * lib/rag.ts — Svelte-side client for the daemon's `Rag` retrieval service.
 *
 * Mirrors the workspace pattern (see `lib/deviceMic.ts` / `lib/backend.ts`): the
 * *pure* parts (type-guarded parsing of the daemon's reply shapes, top-k
 * normalisation) live here headless-testable, while every call funnels through
 * `backend.invoke` and **degrades to `null` outside the Tauri shell** — never a
 * fabricated hit. The corresponding Tauri bridge commands (`rag_status`,
 * `rag_query`, `rag_index`, `rag_remove`) are the live link to the daemon's gRPC
 * `service Rag`; until they exist in a running app these calls return `null` and
 * the UI shows "notes search offline" instead of guessing.
 */

import { bridgeDiag, invoke } from "./backend";

export interface RagHit {
  id: string;
  score: number; // cosine similarity (higher = closer)
  passage: string; // indexed text, for citations
}

export interface RagQueryResult {
  hits: RagHit[];
  count: number;
}

export interface RagStatus {
  indexed: number;
  /**
   * Vector width of the index, `null` until something has been ingested. `null` is
   * the honest answer for an empty index: `0` is not a dimension an embedder can
   * have (`amos-vector-db` refuses `ZeroDimension`), so it must never reach a
   * surface as the measurement 「0 维」.
   */
  dimension: number | null;
  embedder: string; // "mock" | "ollama" (honest backend label)
}

export interface RagIndexReply {
  indexed: boolean;
  dimension: number;
}

export interface RagRemoveReply {
  removed: boolean;
}

export const RAG_DEFAULT_TOP_K = 5;
export const RAG_MAX_TOP_K = 8;

/** Clamp a client top-k: 0/negative/NaN → default; never above the daemon cap. */
export function normalizeTopK(raw: number): number {
  const n = Number.isFinite(raw) ? Math.trunc(raw) : 0;
  const k = n <= 0 ? RAG_DEFAULT_TOP_K : n;
  return Math.min(k, RAG_MAX_TOP_K);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Defensive parse of one retrieval hit. `null` when malformed (never thrown). */
export function parseRagHit(raw: unknown): RagHit | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const passage = str(raw.passage);
  const score = num(raw.score);
  if (id === null || passage === null || score === null) return null;
  return { id, score, passage };
}

/** Defensive parse of a `rag_query` reply; malformed hits are dropped, not fatal. */
export function parseRagQuery(raw: unknown): RagQueryResult | null {
  if (!isObj(raw)) return null;
  const rawHits = Array.isArray(raw.hits) ? raw.hits : [];
  const hits: RagHit[] = [];
  for (const h of rawHits) {
    const p = parseRagHit(h);
    if (p) hits.push(p);
  }
  const count = num(raw.count);
  return { hits, count: count === null ? hits.length : Math.trunc(count) };
}

/**
 * Decode the `dimension` slot of a `rag_status` reply.
 *
 * The daemon sends the field **absent** while nothing has been ingested. It used to
 * be a bare `uint32` whose `0` meant "unknown" (`RagStore::dim() == None`), so `0`
 * from an older daemon is decoded the same way. Both mean *unknown*, never a width:
 * a zero-width vector cannot exist (`amos-vector-db` refuses `ZeroDimension`).
 */
function parseDimension(raw: unknown): number | null {
  const d = num(raw);
  if (d === null) return null;
  const n = Math.trunc(d);
  return n > 0 ? n : null;
}

/** Defensive parse of a `rag_status` reply. */
export function parseRagStatus(raw: unknown): RagStatus | null {
  if (!isObj(raw)) return null;
  const indexed = num(raw.indexed);
  const embedder = str(raw.embedder);
  if (indexed === null || embedder === null) return null;
  return { indexed: Math.trunc(indexed), dimension: parseDimension(raw.dimension), embedder };
}

/** Defensive parse of a `rag_index` reply. */
export function parseRagIndex(raw: unknown): RagIndexReply | null {
  if (!isObj(raw)) return null;
  const indexed = bool(raw.indexed);
  const dimension = num(raw.dimension);
  if (indexed === null || dimension === null) return null;
  return { indexed, dimension: Math.trunc(dimension) };
}

/** Defensive parse of a `rag_remove` reply. */
export function parseRagRemove(raw: unknown): RagRemoveReply | null {
  if (!isObj(raw)) return null;
  const removed = bool(raw.removed);
  return removed === null ? null : { removed };
}

// ---- Seam: each call is `null` when not bridged / command missing / malformed. ----

export async function ragStatus(): Promise<RagStatus | null> {
  return parseRagStatus(await invoke("rag_status", {}));
}

/** Retrieve the nearest indexed passages; `topK` is the wire key Tauri looks up. */
export async function ragQuery(query: string, topK = RAG_DEFAULT_TOP_K): Promise<RagQueryResult | null> {
  // `topK`, not `top_k`: the Rust parameter is `top_k: u32` and Tauri resolves a
  // command argument by its lowerCamelCase name, so a `top_k` key was a plain
  // `missing required key topK` error — every retrieval returned `null` ("search
  // offline") while the UI, the unit tests (they only saw the command name) and
  // every gate stayed green. Pinned by scripts/tauri-args-scan.mjs + rag.test.ts.
  return parseRagQuery(await invoke("rag_query", { query, topK: normalizeTopK(topK) }));
}

/** The host's own code for "the caller is not the window the user is looking at". */
export const RAG_FOREGROUND_REQUIRED = "amos.rag.foreground_required";

/**
 * Was the last {@link ragQuery}'s `null` a **foreground refusal** rather than the index being
 * unreachable? Two situations answer the same `null`, and a surface that draws both as "notes
 * search offline" makes a claim about the *index* when the index had just answered — it refused
 * *this window* (F-AI-019). `bridgeDiag` is per-command, so the retrieval's own diagnostic is the
 * thing to ask; there is no other signal on the wire.
 */
export function ragQueryRefusedForForeground(): boolean {
  const diag = bridgeDiag("rag_query");
  if (diag.ok !== false || diag.kind !== "command-failed") return false;
  const detail = diag.detail;
  const code =
    typeof detail === "object" && detail !== null
      ? (detail as { code?: unknown }).code
      : undefined;
  return code === RAG_FOREGROUND_REQUIRED;
}

export async function ragIndex(id: string, text: string): Promise<RagIndexReply | null> {
  return parseRagIndex(await invoke("rag_index", { id, text }));
}

export async function ragRemove(id: string): Promise<RagRemoveReply | null> {
  return parseRagRemove(await invoke("rag_remove", { id }));
}
