import { describe, expect, test } from "bun:test";
import { askNotes, syncNotesIndex, type RagClient } from "../lib/notesRagRun";
import type { RagQueryResult, RagRemoveReply } from "../lib/rag";

function note(id: string, text: string) {
  return { id, text, ts: 1 };
}

/** A recording fake daemon client with per-method programmability. */
function fakeClient(opts: {
  indexReplies?: (id: string) => { indexed: boolean; dimension: number } | null;
  removeReplies?: (id: string) => RagRemoveReply | null;
  queryReply?: RagQueryResult | null;
} = {}) {
  const indexed: string[] = [];
  const removed: string[] = [];
  const queried: string[] = [];
  const client: RagClient = {
    async index(id) {
      indexed.push(id);
      return opts.indexReplies ? opts.indexReplies(id) : { indexed: true, dimension: 3 };
    },
    async remove(id) {
      removed.push(id);
      return opts.removeReplies ? opts.removeReplies(id) : { removed: true };
    },
    async query(q) {
      queried.push(q);
      // Distinguish "not programmed" from an explicit offline `null`.
      return opts.queryReply === undefined ? { hits: [], count: 0 } : opts.queryReply;
    },
  };
  return { client, indexed, removed, queried };
}

describe("syncNotesIndex", () => {
  test("upserts every non-empty active note and returns the confirmed set", async () => {
    const f = fakeClient();
    const r = await syncNotesIndex(
      f.client,
      [note("a", "hello"), note("b", "   "), note("c", "world")],
      [],
    );
    expect(f.indexed).toEqual(["note:a", "note:c"]); // blank note skipped
    expect(r.indexed).toEqual(["note:a", "note:c"]);
    expect(r.skipped).toBe(0);
    expect(r.removed).toEqual([]);
  });

  test("a null (offline) reply is never recorded as indexed", async () => {
    const f = fakeClient({ indexReplies: (id) => (id === "note:a" ? null : { indexed: true, dimension: 3 }) });
    const r = await syncNotesIndex(f.client, [note("a", "hello"), note("b", "world")], []);
    expect(r.indexed).toEqual(["note:b"]);
    expect(r.skipped).toBe(1);
  });

  test("prunes indexed ids whose note is gone, only counting confirmed removals", async () => {
    const f = fakeClient({ removeReplies: (id) => (id === "note:dead" ? { removed: true } : null) });
    const r = await syncNotesIndex(
      f.client,
      [note("live", "still here")],
      ["note:live", "note:dead", "note:ghost"],
    );
    // Both stale ids are attempted; only the confirmed one is reported removed.
    expect(f.removed.sort()).toEqual(["note:dead", "note:ghost"]);
    expect(r.removed).toEqual(["note:dead"]);
    // Foreign (non-note) ids are never touched by prune.
    expect(f.removed).not.toContain("pdf:whatever");
  });

  test("keeps foreign indexed ids out of the prune set", async () => {
    const f = fakeClient();
    await syncNotesIndex(f.client, [note("a", "x")], ["pdf:doc#1", "note:a"]);
    expect(f.removed).toEqual([]); // pdf: is not ours; note:a is still active
  });
});

describe("askNotes", () => {
  test("queries the client with the trimmed question", async () => {
    const f = fakeClient({ queryReply: { hits: [], count: 0 } });
    await askNotes(f.client, "  地铁怎么走  ");
    expect(f.queried).toEqual(["地铁怎么走"]);
  });

  test("an empty/blank question never hits the daemon", async () => {
    const f = fakeClient();
    expect(await askNotes(f.client, "   ")).toBeNull();
    expect(f.queried).toEqual([]);
  });

  test("propagates an offline (null) reply as null (honest, not an empty answer)", async () => {
    const f = fakeClient({ queryReply: null });
    expect(await askNotes(f.client, "hello")).toBeNull();
  });
});
