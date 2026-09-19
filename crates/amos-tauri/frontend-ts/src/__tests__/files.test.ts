import { describe, expect, test } from "bun:test";
import {
  addEntry,
  childrenOf,
  contentContains,
  filterByName,
  folderPath,
  isInside,
  makeEntry,
  makeId,
  moveEntry,
  pathOf,
  renameEntry,
  searchFiles,
  sortChildren,
  toggleFav,
  recentFiles,
  moveEntries,
  normalizeFiles,
  folderTree,
  hasName,
  moveToTrash,
  restoreFromTrash,
  purgeFromTrash,
  normalizeTrash,
  MAX_TRASH_ITEMS,
  type FEntry,
} from "../lib/files";

const mk = (id: string, type: FEntry["type"], name: string, parent?: string): FEntry =>
  parent ? { id, type, name, parent, ts: 1 } : { id, type, name, ts: 1 };

describe("files tree ops", () => {
  const a = mk("a", "folder", "A");
  const b = mk("b", "folder", "B", "a");
  const ff = mk("f", "file", "x.txt", "a");
  const rr = mk("r", "file", "root.txt");
  const list = [a, b, ff, rr];

  test("children/path reflect the tree", () => {
    expect(childrenOf(list, undefined).map((e) => e.id)).toEqual(["a", "r"]);
    expect(childrenOf(list, "a").map((e) => e.id)).toEqual(["b", "f"]);
    expect(pathOf(list, "f").map((e) => e.id)).toEqual(["a", "f"]);
    expect(pathOf(list, undefined)).toEqual([]);
  });

  test("rename only touches the target (children keep id-based parent)", () => {
    const next = renameEntry(list, "a", "C");
    expect(next.find((e) => e.id === "a")?.name).toBe("C");
    expect(next.find((e) => e.id === "b")?.parent).toBe("a");
  });

  test("move to root and to a folder", () => {
    const toRoot = moveEntry(list, "f", undefined);
    expect(toRoot.find((e) => e.id === "f")?.parent).toBeUndefined();
    const moved = moveEntry(toRoot, "f", "a");
    expect(moved.find((e) => e.id === "f")?.parent).toBe("a");
  });

  test("a folder cannot move into its own subtree (cycle guard)", () => {
    const small = [a, b];
    const attempted = moveEntry(small, "a", "b"); // b is inside a
    expect(attempted).toEqual(small);
    expect(isInside(small, "b", "a")).toBe(true);
  });

  test("moving a folder to the trash cascades to descendants only", () => {
    const after = moveToTrash(list, [], new Set(["a"]), 1).list;
    expect(after.map((e) => e.id)).toEqual(["r"]);
  });

  test("pathOf / isInside are cycle-safe on corrupted (looping) input", () => {
    // A corrupted store where x<->y form a parent cycle (should never be produced
    // by the app, but must not hang pathOf / isInside if it ever exists).
    const x = mk("x", "folder", "X", "y");
    const y = mk("y", "folder", "Y", "x");
    const bad = [x, y];
    const p = pathOf(bad, "x");
    expect(p.length).toBeLessThanOrEqual(bad.length); // terminates, bounded
    // isInside terminates and does not falsely report reaching an outside node.
    expect(isInside(bad, "x", "zz")).toBe(false);
    expect(isInside(bad, "y", "x")).toBe(true); // still correct on the cycle
  });

  test("makeEntry builds typed entries and addEntry appends (immutable)", () => {
    const folder = makeEntry("folder", "Docs", "root", 1);
    expect(folder.type).toBe("folder");
    expect(folder.parent).toBe("root");
    expect(folder.content).toBeUndefined(); // folders carry no file content
    expect(typeof folder.id).toBe("string");

    const file = makeEntry("file", "readme.txt", undefined, 2);
    expect(file.parent).toBeUndefined();
    expect(file.content).toBe(""); // files start empty

    const list = [folder];
    const next = addEntry(list, file);
    expect(next.length).toBe(2);
    expect(list.length).toBe(1); // immutable
  });

  test("makeId yields unique ids for consecutive calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => makeId()));
    expect(ids.size).toBe(20); // no collisions
    expect(makeId("f").startsWith("f")).toBe(true); // prefix respected
  });

  test("sortChildren orders by name / time / default within one folder", () => {
    const root = [
      mk("b", "file", "banana.txt", "root"),
      mk("a", "file", "Apple.txt", "root"),
      mk("c", "file", "cherry.txt", "root"),
    ];
    expect(sortChildren(root, "root", "name").map((e) => e.id)).toEqual(["a", "b", "c"]); // case-insensitive-ish
    const withTs = [
      { id: "old", type: "file" as const, name: "old.txt", parent: "root", ts: 1 },
      { id: "new", type: "file" as const, name: "new.txt", parent: "root", ts: 99 },
      { id: "mid", type: "file" as const, name: "mid.txt", parent: "root", ts: 50 },
    ];
    expect(sortChildren(withTs, "root", "time").map((e) => e.id)).toEqual(["new", "mid", "old"]);
    expect(sortChildren(withTs, "root", "default").map((e) => e.id)).toEqual(["old", "new", "mid"]);
  });

  test("filterByName is case-insensitive and empty query is a passthrough", () => {
    const kids = [
      { id: "1", type: "file" as const, name: "ReadMe.txt", ts: 1 },
      { id: "2", type: "file" as const, name: "photo.png", ts: 1 },
    ];
    expect(filterByName(kids, "readme").map((e) => e.id)).toEqual(["1"]);
    expect(filterByName(kids, "README").map((e) => e.id)).toEqual(["1"]);
    expect(filterByName(kids, "  ").length).toBe(2); // empty query passes all
    expect(filterByName(kids, "zzz")).toEqual([]);
  });

  test("searchFiles finds across directories by name and (optionally) content", () => {
    const tree = [
      mk("a", "folder", "Docs"),
      mk("f1", "file", "todo.txt", "a"),
      mk("f2", "file", "notes.txt", "a"),
      mk("r", "file", "root.txt"),
    ];
    const withContent: FEntry[] = [
      { id: "a", type: "folder", name: "Docs", ts: 1 },
      { id: "f1", type: "file", name: "todo.txt", parent: "a", content: "Buy Amos gear", ts: 1 },
      { id: "f2", type: "file", name: "notes.txt", parent: "a", content: "ideas", ts: 1 },
      { id: "r", type: "file", name: "root.txt", content: "Amos rocks", ts: 1 },
    ];
    // name match anywhere in the tree (cross-directory)
    expect(searchFiles(tree, "todo", false).map((e) => e.id)).toEqual(["f1"]);
    // content match only when enabled, folders never content-match; results in name order
    expect(searchFiles(withContent, "amos", true).map((e) => e.id)).toEqual(["r", "f1"]);
    expect(searchFiles(withContent, "amos", false)).toEqual([]);
    // empty query → no results
    expect(searchFiles(withContent, "  ", true)).toEqual([]);
  });

  test("folderPath returns the ancestor breadcrumb or empty at root", () => {
    const tree = [
      mk("a", "folder", "Docs"),
      mk("b", "folder", "Media", "a"),
      mk("f", "file", "pic.png", "b"),
      mk("r", "file", "root.txt"),
    ];
    expect(folderPath(tree, "f")).toBe("Docs / Media");
    expect(folderPath(tree, "r")).toBe(""); // at root
    expect(folderPath(tree, "nope")).toBe("");
  });

  test("toggleFav toggles an id and recentFiles keeps newest files", () => {
    expect(toggleFav([], "a")).toEqual(["a"]);
    expect(toggleFav(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleFav(["a"], "nope")).toEqual(["a", "nope"]);

    const files = [
      { id: "old", type: "file" as const, name: "old.txt", ts: 1 },
      { id: "mid", type: "file" as const, name: "mid.txt", ts: 50 },
      { id: "new", type: "file" as const, name: "new.txt", ts: 99 },
      { id: "dir", type: "folder" as const, name: "folder", ts: 999 }, // folders excluded
    ];
    expect(recentFiles(files, 2).map((e) => e.id)).toEqual(["new", "mid"]);
    expect(recentFiles(files, 0)).toEqual([]);
  });

  test("the trash removes the union of subtrees and is a no-op when empty", () => {
    const files = [
      mk("a", "folder", "A"),
      mk("a1", "file", "inA", "a"),
      mk("b", "folder", "B"),
      mk("b1", "file", "inB", "b"),
      mk("c", "file", "C"),
    ];
    // trashing folders a + file c → also takes a's child, keeps b's subtree
    const r = moveToTrash(files, [], new Set(["a", "c"]), 1);
    expect(r.list.map((e) => e.id).sort()).toEqual(["b", "b1"]);
    // …and the ledger receives **one item per selected top-most entry**.
    expect(r.moved.map((m) => m.id)).toEqual(["a", "c"]);
    expect(moveToTrash(files, [], new Set(), 1).list).toBe(files); // same ref (no-op)
    expect(moveToTrash(files, [], new Set(["nope"]), 1).list).toEqual(files); // unknown → unchanged
  });

  test("moveEntries relocates several items under a destination", () => {
    const files = [
      mk("a", "folder", "A"),
      mk("b", "folder", "B"),
      mk("x", "file", "x.txt"),
      mk("y", "file", "y.txt"),
      mk("a1", "file", "inA", "a"),
    ];
    // move x.txt + y.txt into folder A
    const moved = moveEntries(files, new Set(["x", "y"]), "a");
    const movedOf = (id: string) => moved.find((e) => e.id === id);
    expect(movedOf("x")?.parent).toBe("a");
    expect(movedOf("y")?.parent).toBe("a");
    expect(movedOf("a1")?.parent).toBe("a"); // untouched
    // empty set is a no-op (same ref)
    expect(moveEntries(files, new Set(), "a")).toBe(files);
    // moving folder A into B is fine; into itself is guarded unchanged
    const intoB = moveEntries(files, new Set(["a"]), "b");
    expect(intoB.find((e) => e.id === "a")?.parent).toBe("b");
    const intoSelf = moveEntries(files, new Set(["a"]), "a");
    expect(intoSelf.find((e) => e.id === "a")?.parent).toBeUndefined();
  });

  test("folderTree lists folders breadth-first with nesting depth", () => {
    // order: a, c root folders; b nested inside a
    const files = [
      mk("a", "folder", "A"),
      mk("c", "folder", "C"),
      mk("b", "folder", "B", "a"),
      mk("x", "file", "x.txt"),
    ];
    const tree = folderTree(files);
    expect(tree.map((n) => `${n.depth}:${n.id}`)).toEqual(["0:a", "0:c", "1:b"]);
    expect(tree.every((n) => n.depth >= 0)).toBe(true);
    // files are excluded entirely
    expect(tree.some((n) => n.id === "x")).toBe(false);
    // a self-parent (corrupted cycle) does not hang and is not double-listed
    const cyc = folderTree([mk("loop", "folder", "L", "loop"), mk("a2", "folder", "A2")]);
    expect(cyc.length).toBeLessThanOrEqual(2);
  });

  test("normalizeFiles drops garbage, back-fills ids, and de-duplicates", () => {
    const corrupt: unknown = [
      { id: "x", type: "file", name: "ok.txt", content: "hi", ts: 5 },
      { id: "x", type: "file", name: "dup.txt", ts: 6 }, // id collision
      { type: "folder", name: "no-id" }, // missing id → back-filled
      { id: "b", type: "folder", name: "   " }, // blank name → dropped
      { id: "c", type: "ghost", name: "bad" }, // bad type → dropped
      null,
      42,
      "text",
    ];
    const out = normalizeFiles(corrupt);
    expect(out.length).toBe(3); // ok.txt + dup.txt + no-id folder
    const ids = new Set(out.map((e) => e.id));
    expect(ids.size).toBe(3); // all unique
    const first = out.find((e) => e.name === "ok.txt");
    expect(first).toMatchObject({ id: "x", type: "file", content: "hi", ts: 5 });
    expect(out.every((e) => e.type === "file" || e.type === "folder")).toBe(true);
    expect(out.every((e) => (e.name ?? "").trim() !== "")).toBe(true);
    // non-array input → empty, never crash
    expect(normalizeFiles(null)).toEqual([]);
    expect(normalizeFiles({})).toEqual([]);
  });

  test("cycle-injected parent chains never hang delete/move/path ops", () => {
    // a → b → a (mutual) plus a self-parented folder.
    const cyc = [
      mk("a", "folder", "A", "b"),
      mk("b", "folder", "B", "a"),
      mk("self", "folder", "Self", "self"),
      mk("x", "file", "x.txt", "a"),
    ];
    // pathOf on a cyclic node terminates (no infinite loop)
    const p = pathOf(cyc, "a");
    expect(p.length).toBeGreaterThan(0);
    // isInside tolerates the cycle (returns a definitive answer, no hang)
    expect(typeof isInside(cyc, "b", "a")).toBe("boolean");
    // the trash removes a subtree even when the parent chain is cyclic
    const removed = moveToTrash(cyc, [], new Set(["a"]), 1).list;
    expect(removed.length).toBe(1); // only `self` survives (a's subtree = a+b+x)
    expect(removed[0]!.id).toBe("self");
    expect(removed.every((e) => e.id !== "a" && e.id !== "x" && e.id !== "b")).toBe(true);
    // moveEntry rejects moving a folder into its own (cyclic) subtree
    const moved = moveEntry(cyc, "a", "b");
    expect(moved.find((e) => e.id === "a")?.parent).toBe("b"); // already at b (unchanged semantics)
    const intoSelf = moveEntry(cyc, "a", "a");
    expect(intoSelf.find((e) => e.id === "a")?.parent).toBe("b"); // guarded, unchanged
  });

  test("search/sort tolerate empty, huge and degenerate inputs", () => {
    const big = Array.from({ length: 5000 }, (_, i) =>
      i % 2 === 0
        ? mk(`f${i}`, "file", `item${i}.txt`)
        : mk(`d${i}`, "folder", `Folder${i}`),
    );
    // empty query passes everything; non-matching returns nothing
    expect(filterByName(big, "   ").length).toBe(big.length);
    expect(filterByName(big, "zzz-not-here")).toEqual([]);
    // empty query on searchFiles returns [] (no accidental full scan)
    expect(searchFiles(big, "   ", false)).toEqual([]);
    // stable sort never throws on a huge list and preserves total count
    expect(sortChildren(big, undefined, "name").length).toBe(big.length);
    expect(sortChildren(big, undefined, "time").length).toBe(big.length);
    // degenerate empties
    expect(sortChildren([], undefined, "name")).toEqual([]);
    expect(filterByName([], "x")).toEqual([]);
    // contentContains on content-less file never matches a non-empty query
    expect(contentContains(mk("z", "file", "z"), "qqq")).toBe(false);
  });
});

/**
 * REQ-A455 — the trash. Every case here is a property the *safety net* must have, in the
 * order they matter: nothing is lost by deleting (`moveToTrash` is reversible), a folder
 * comes back whole, the ledger cannot grow without bound, and the ways a restore can fail
 * are **named** instead of silently resolved.
 */
describe("trash: moveToTrash", () => {
  const tree = (): FEntry[] => [
    mk("doc", "folder", "文档"),
    mk("a", "file", "a.txt", "doc"),
    mk("b", "file", "b.txt", "doc"),
    mk("c", "file", "c.txt"),
  ];

  test("a deleted file leaves the tree and is recoverable byte-for-byte", () => {
    const before = tree();
    const r = moveToTrash(before, [], new Set(["c"]), 1000);
    expect(r.list.map((e) => e.id)).toEqual(["doc", "a", "b"]);
    expect(r.moved).toHaveLength(1);
    expect(r.moved[0]!).toMatchObject({ id: "c", deletedAt: 1000 });
    expect(r.trash[0]!.members).toEqual([before.find((e) => e.id === "c")!]);
    // …and putting it back is the identity (the property a safety net is judged on).
    const back = restoreFromTrash(r.list, r.trash, "c");
    expect(back.outcome).toEqual({ kind: "restored", to: undefined });
    expect(back.trash).toEqual([]);
    expect(back.list.find((e) => e.id === "c")).toEqual(before.find((e) => e.id === "c")!);
  });

  test("a folder takes its whole subtree, and remembers where it came from", () => {
    const r = moveToTrash(tree(), [], new Set(["doc"]), 7);
    expect(r.list.map((e) => e.id)).toEqual(["c"]);
    expect(r.trash[0]!.members.map((e) => e.id)).toEqual(["doc", "a", "b"]); // root FIRST
    // A root-level entry carries **no** `fromParent` key at all (not `undefined`): the
    // ledger must not claim a location it never had.
    expect(r.moved[0]!.id).toBe("doc");
    expect("fromParent" in r.moved[0]!).toBe(false);
    // Put back: root under the same parent, children still pointing at the root.
    const back = restoreFromTrash(r.list, r.trash, "doc");
    expect(back.outcome.kind).toBe("restored");
    expect(back.list.map((e) => e.id).sort()).toEqual(["a", "b", "c", "doc"]);
    expect(back.list.find((e) => e.id === "a")!.parent).toBe("doc");
  });

  test("selecting a folder AND something inside it yields ONE item, not two", () => {
    // Otherwise the ledger would hold a copy of a child whose parent is also inside it,
    // and restoring the parent would resurrect a duplicate.
    const r = moveToTrash(tree(), [], new Set(["doc", "a"]), 1);
    expect(r.moved).toHaveLength(1);
    expect(r.moved[0]!.id).toBe("doc");
    expect(r.trash[0]!.members.map((e) => e.id)).toEqual(["doc", "a", "b"]);
  });

  test("an empty selection and an unknown id are no-ops that keep the ledger object", () => {
    const t = tree();
    const empty = moveToTrash(t, [], new Set(), 1);
    expect(empty).toEqual({ list: t, trash: [], moved: [], dropped: 0 });
    const unknown = moveToTrash(t, [], new Set(["ghost"]), 1);
    expect(unknown.list).toBe(t);
    expect(unknown.dropped).toBe(0);
  });

  test("the ledger is bounded: the OLDEST item is evicted, and each eviction is reported", () => {
    let list: FEntry[] = [];
    let trash: ReturnType<typeof moveToTrash>["trash"] = [];
    let evicted = 0;
    const total = MAX_TRASH_ITEMS + 3;
    for (let i = 0; i < total; i++) {
      list = [...list, mk(`f${i}`, "file", `f${i}.txt`)];
      const r = moveToTrash(list, trash, new Set([`f${i}`]), i);
      list = r.list;
      trash = r.trash;
      // `dropped` is **per call** ("this delete evicted N"), which is what the UI can say.
      expect(r.dropped).toBe(i < MAX_TRASH_ITEMS ? 0 : 1);
      evicted += r.dropped;
    }
    expect(evicted).toBe(3);
    expect(trash).toHaveLength(MAX_TRASH_ITEMS);
    // Newest first, oldest gone — the whole point of a bounded safety net.
    expect(trash[0]!.id).toBe(`f${total - 1}`);
    expect(trash.some((t) => t.id === "f0")).toBe(false);
    expect(trash.some((t) => t.id === "f3")).toBe(true);
  });
});

describe("hasName (child-name lookup)", () => {
  test("detects whether a child with the given name exists", () => {
    const kids = [
      makeEntry("folder", "docs", undefined, 1),
      makeEntry("file", "readme.md", undefined, 2),
    ];
    expect(hasName(kids, "docs")).toBe(true);
    expect(hasName(kids, "readme.md")).toBe(true);
    expect(hasName(kids, "missing.txt")).toBe(false);
    expect(hasName([], "anything")).toBe(false);
  });
});

describe("trash: restoreFromTrash", () => {
  test("a trashed child is only reachable with its parent (the ledger holds the subtree)", () => {
    const r = moveToTrash(
      [mk("doc", "folder", "文档"), mk("a", "file", "a.txt", "doc")],
      [],
      new Set(["doc"]),
      1,
    );
    // The child left the tree *inside* its folder, so it is not a ledger row of its own…
    expect(restoreFromTrash(r.list, r.trash, "a").outcome).toEqual({ kind: "not-found" });
    // …and restoring the folder brings both back.
    const back = restoreFromTrash(r.list, r.trash, "doc");
    expect(back.list.map((e) => e.id).sort()).toEqual(["a", "doc"]);
  });

  test("a folder that disappeared while its child was in the trash restores at the root", () => {
    const moved = moveToTrash(
      [mk("doc", "folder", "文档"), mk("a", "file", "a.txt", "doc")],
      [],
      new Set(["a"]),
      1,
    );
    expect(moved.trash[0]!.fromParent).toBe("doc");
    // The user deleted the folder afterwards — the child's home no longer exists.
    const back = restoreFromTrash([], moved.trash, "a");
    expect(back.outcome).toEqual({ kind: "restored-to-root" });
    expect(back.list[0]!.parent).toBeUndefined();
  });

  test("two collisions are REFUSED by name, never resolved behind the user's back", () => {
    const r = moveToTrash(
      [mk("doc", "folder", "文档"), mk("a", "file", "a.txt", "doc")],
      [],
      new Set(["a"]),
      1,
    );
    // (1) a new sibling took the name while it was away
    const sameName = restoreFromTrash([r.list[0]!, mk("other", "file", "a.txt", "doc")], r.trash, "a");
    expect(sameName.outcome).toEqual({ kind: "name-conflict", name: "a.txt" });
    // (2) the same id is already back in the tree (hand-edited store)
    const sameId = restoreFromTrash([...r.list, mk("a", "file", "a.txt", "doc")], r.trash, "a");
    expect(sameId.outcome).toEqual({ kind: "id-conflict", id: "a" });
    // Neither refusal changed anything.
    expect(sameName.trash).toHaveLength(1);
    expect(sameId.list.find((e) => e.id === "a")).toBeTruthy();
  });

  test("an unknown key is not-found (another window may have purged it)", () => {
    expect(restoreFromTrash([], [], "nope").outcome).toEqual({ kind: "not-found" });
  });
});

describe("trash: purgeFromTrash + normalizeTrash", () => {
  test("purge is the only destructive op, and an empty set keeps the same array", () => {
    const r = moveToTrash([mk("c", "file", "c.txt")], [], new Set(["c"]), 1);
    expect(purgeFromTrash(r.trash, new Set())).toBe(r.trash);
    expect(purgeFromTrash(r.trash, new Set(["c"]))).toEqual([]);
    // An id that is not in the ledger also leaves the array untouched.
    expect(purgeFromTrash(r.trash, new Set(["ghost"]))).toBe(r.trash);
  });

  test("normalizeTrash repairs a hand-edited ledger instead of trusting it", () => {
    expect(normalizeTrash("nope")).toEqual([]);
    expect(normalizeTrash([null, 42, {}])).toEqual([]);
    // Root missing from `members` ⇒ nothing to name, nothing to look up ⇒ dropped.
    expect(normalizeTrash([{ id: "x", members: [mk("y", "file", "y.txt")], deletedAt: 5 }])).toEqual(
      [],
    );
    // A duplicate id keeps the first; a bad clock becomes 0; members are re-ordered root-first.
    const out = normalizeTrash([
      { id: "a", members: [mk("b", "file", "b.txt"), mk("a", "folder", "A")], deletedAt: "soon" },
      { id: "a", members: [mk("a", "folder", "other")], deletedAt: 3 },
      { id: "z", members: [mk("z", "file", "z.txt")], deletedAt: 9, fromParent: "" },
    ]);
    expect(out.map((t) => t.id)).toEqual(["a", "z"]);
    expect(out[0]!.members.map((m) => m.id)).toEqual(["a", "b"]);
    expect(out[0]!.deletedAt).toBe(0);
    // An empty `fromParent` is noise, not a location.
    expect(out[1]!.fromParent).toBeUndefined();
    expect(out[1]!.deletedAt).toBe(9);
  });
});

