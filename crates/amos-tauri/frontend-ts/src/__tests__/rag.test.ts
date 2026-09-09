import { describe, expect, test } from "bun:test";
import {
  parseRagHit,
  parseRagIndex,
  parseRagQuery,
  parseRagRemove,
  parseRagStatus,
  ragIndex,
  ragQuery,
  ragRemove,
  ragStatus,
  RAG_DEFAULT_TOP_K,
  RAG_MAX_TOP_K,
  normalizeTopK,
} from "../lib/rag";

describe("normalizeTopK", () => {
  test("maps 0/negative/NaN to the default and caps at the daemon maximum", () => {
    expect(normalizeTopK(0)).toBe(RAG_DEFAULT_TOP_K);
    expect(normalizeTopK(-3)).toBe(RAG_DEFAULT_TOP_K);
    expect(normalizeTopK(Number.NaN)).toBe(RAG_DEFAULT_TOP_K);
    expect(normalizeTopK(3)).toBe(3);
    expect(normalizeTopK(1_000_000)).toBe(RAG_MAX_TOP_K);
    expect(normalizeTopK(2.7)).toBe(2); // truncated, never fractional
  });
});

describe("parseRagHit", () => {
  test("accepts a well-formed hit", () => {
    expect(parseRagHit({ id: "note:a", score: 0.91, passage: "正文" })).toEqual({
      id: "note:a",
      score: 0.91,
      passage: "正文",
    });
  });

  test("rejects malformed hits (missing id / non-numeric score / array)", () => {
    expect(parseRagHit({ score: 0.9, passage: "x" })).toBeNull();
    expect(parseRagHit({ id: "a", score: "high", passage: "x" })).toBeNull();
    expect(parseRagHit([1, 2])).toBeNull();
    expect(parseRagHit(null)).toBeNull();
  });
});

describe("parseRagQuery", () => {
  test("parses hits and count", () => {
    const r = parseRagQuery({
      hits: [
        { id: "a", score: 0.9, passage: "A" },
        { id: "b", score: 0.8, passage: "B" },
      ],
      count: 2,
    });
    expect(r).not.toBeNull();
    expect(r!.hits.length).toBe(2);
    expect(r!.count).toBe(2);
  });

  test("drops malformed hits but keeps valid ones and falls back to hit count", () => {
    const r = parseRagQuery({
      hits: [{ id: "a", score: 0.9, passage: "A" }, { bad: true }, null],
      count: 7, // not trusted over reality; but kept as the reported count
    });
    expect(r!.hits.length).toBe(1);
    expect(r!.hits[0]!.id).toBe("a");
    expect(r!.count).toBe(7);
  });

  test("rejects non-object replies", () => {
    expect(parseRagQuery("nope")).toBeNull();
    expect(parseRagQuery(null)).toBeNull();
  });
});

describe("parseRagStatus", () => {
  test("parses a well-formed status", () => {
    expect(parseRagStatus({ indexed: 3, dimension: 384, embedder: "mock" })).toEqual({
      indexed: 3,
      dimension: 384,
      embedder: "mock",
    });
  });
  test("rejects malformed status", () => {
    expect(parseRagStatus({ indexed: "many", dimension: 384, embedder: "mock" })).toBeNull();
    expect(parseRagStatus({})).toBeNull();
  });
});

describe("parseRagIndex / parseRagRemove", () => {
  test("index reply", () => {
    expect(parseRagIndex({ indexed: true, dimension: 8 })).toEqual({ indexed: true, dimension: 8 });
    expect(parseRagIndex({ indexed: "yes", dimension: 8 })).toBeNull();
  });
  test("remove reply", () => {
    expect(parseRagRemove({ removed: true })).toEqual({ removed: true });
    expect(parseRagRemove({ removed: 1 })).toBeNull();
  });
});

describe("offline degradation (no Tauri bridge)", () => {
  test("all rag commands are null headless — never fabricated hits", async () => {
    // In a headless bun run there is no window.__TAURI_INTERNALS__, so every seam
    // must return null (the UI then shows "notes search offline").
    expect(await ragStatus()).toBeNull();
    expect(await ragQuery("q", 5)).toBeNull();
    expect(await ragIndex("note:a", "body")).toBeNull();
    expect(await ragRemove("note:a")).toBeNull();
  });
});
