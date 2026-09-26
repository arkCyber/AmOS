import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  parseRagHit,
  parseRagIndex,
  parseRagQuery,
  parseRagRemove,
  parseRagStatus,
  ragIndex,
  ragQuery,
  ragQueryRefusedForForeground,
  ragRemove,
  ragStatus,
  RAG_DEFAULT_TOP_K,
  RAG_FOREGROUND_REQUIRED,
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
  test("an unindexed index reports no dimension, not 0", () => {
    // `RagStatusReply.dimension` is `optional`: absent while nothing has been ingested
    // (`RagStore::dim() == None`). `0` is not a dimension the daemon can produce — the
    // vector index refuses `ZeroDimension` — so the documented `0` sentinel of an older
    // daemon's reply means the same thing as absence: unknown.
    expect(parseRagStatus({ indexed: 0, embedder: "mock" })).toEqual({
      indexed: 0,
      dimension: null,
      embedder: "mock",
    });
    expect(parseRagStatus({ indexed: 0, dimension: 0, embedder: "mock" })).toEqual({
      indexed: 0,
      dimension: null,
      embedder: "mock",
    });
    // …and a real dimension is preserved (positive control: an "always null" parser fails).
    expect(parseRagStatus({ indexed: 3, dimension: 384, embedder: "mock" })!.dimension).toBe(384);
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

describe("wire keys (Tauri resolves an argument by its lowerCamelCase name)", () => {
  let realWindow: unknown;
  beforeEach(() => {
    realWindow = (globalThis as { window?: unknown }).window;
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = realWindow;
  });
  function bridge(recorder: { cmd: string; args: Record<string, unknown> }[]) {
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          recorder.push({ cmd, args: args ?? {} });
          if (cmd === "rag_query") return { hits: [], count: 0 };
          return null;
        },
        listen: async () => async () => {},
      },
      localStorage: new Map() as unknown as Storage,
    };
  }

  test("rag_query sends `topK` (the key the command declares), never `top_k`", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    bridge(calls);
    await ragQuery("hello", 3);
    const query = calls.find((c) => c.cmd === "rag_query");
    expect(query).toBeDefined();
    expect(query!.args).toEqual({ query: "hello", topK: 3 });
    // `top_k` matched no Rust parameter → the command failed with
    // `missing required key topK` and the UI showed "search offline".
    expect(query!.args.top_k).toBeUndefined();
  });

  test("rag_query clamps top-k through the same normaliser on the wire", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    bridge(calls);
    await ragQuery("hello", 1_000_000);
    expect(calls.find((c) => c.cmd === "rag_query")!.args.topK).toBe(RAG_MAX_TOP_K);
  });
});

describe("ragQueryRefusedForForeground — which fact a null carries (F-AI-019)", () => {
  let realWindow: unknown;
  beforeEach(() => {
    realWindow = (globalThis as { window?: unknown }).window;
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = realWindow;
  });
  function bridgeThatRejects(err: unknown) {
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string) => {
          if (cmd === "rag_query") throw err;
          return null;
        },
        listen: async () => async () => {},
      },
      localStorage: new Map() as unknown as Storage,
    };
  }

  test("true only for the host's own foreground code", async () => {
    bridgeThatRejects({ code: RAG_FOREGROUND_REQUIRED, message: "refused" });
    expect(await ragQuery("q")).toBeNull();
    expect(ragQueryRefusedForForeground()).toBe(true);
  });

  test("false for any other refusal — an unreachable index is not a refusal of this window", async () => {
    bridgeThatRejects({ code: "amos.rag.rpc_failed", message: "daemon absent" });
    expect(await ragQuery("q")).toBeNull();
    expect(ragQueryRefusedForForeground()).toBe(false);
  });

  test("false when the read succeeded, and false with no bridge at all", async () => {
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {
        invoke: async () => ({ hits: [], count: 0 }),
        listen: async () => async () => {},
      },
      localStorage: new Map() as unknown as Storage,
    };
    expect(await ragQuery("q")).toEqual({ hits: [], count: 0 });
    expect(ragQueryRefusedForForeground()).toBe(false);

    (globalThis as { window?: unknown }).window = undefined;
    expect(await ragQuery("q")).toBeNull();
    expect(ragQueryRefusedForForeground()).toBe(false);
  });
});
