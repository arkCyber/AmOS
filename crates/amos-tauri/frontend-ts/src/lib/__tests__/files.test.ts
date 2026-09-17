/**
 * Tests for files.ts — pure functions for file/folder operations.
 *
 * Aerospace-grade coverage: cycle safety, batch operations, search, sort.
 */
import { describe, test, expect } from "vitest";
import {
  addEntry,
  childrenOf,
  deleteEntries,
  deleteEntry,
  filterByName,
  folderPath,
  folderTree,
  hasName,
  isInside,
  makeEntry,
  makeId,
  moveEntries,
  moveEntry,
  normalizeFiles,
  pathOf,
  recentFiles,
  renameEntry,
  searchFiles,
  sortChildren,
  toggleFav,
  type FEntry,
} from "../files";

describe("files.ts — pure functions", () => {
  describe("makeId", () => {
    test("generates unique ids", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(makeId());
      }
      expect(ids.size).toBe(100);
    });

    test("respects custom prefix", () => {
      const id = makeId("test");
      expect(id).toMatch(/^test/);
    });
  });

  describe("makeEntry", () => {
    test("creates folder with parent", () => {
      const e = makeEntry("folder", "Documents", "root", 1000);
      expect(e.type).toBe("folder");
      expect(e.name).toBe("Documents");
      expect(e.parent).toBe("root");
      expect(e.ts).toBe(1000);
      expect(e.id).toBeDefined();
    });

    test("creates file with empty content", () => {
      const e = makeEntry("file", "note.txt", undefined, 2000);
      expect(e.type).toBe("file");
      expect(e.content).toBe("");
      expect(e.parent).toBeUndefined();
    });
  });

  describe("normalizeFiles — corruption tolerance", () => {
    test("empty array passes through", () => {
      expect(normalizeFiles([])).toEqual([]);
    });

    test("non-array returns empty", () => {
      expect(normalizeFiles(null)).toEqual([]);
      expect(normalizeFiles(undefined)).toEqual([]);
      expect(normalizeFiles("invalid")).toEqual([]);
      expect(normalizeFiles(42)).toEqual([]);
    });

    test("filters out non-object entries", () => {
      const input = [
        { id: "a", type: "folder", name: "A", ts: 0 },
        "invalid",
        null,
        { id: "b", type: "file", name: "B", ts: 0 },
      ];
      const result = normalizeFiles(input);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("A");
      expect(result[1].name).toBe("B");
    });

    test("filters out entries with invalid type", () => {
      const input = [
        { id: "a", type: "folder", name: "A", ts: 0 },
        { id: "b", type: "invalid", name: "B", ts: 0 },
        { id: "c", type: "file", name: "C", ts: 0 },
      ];
      const result = normalizeFiles(input);
      expect(result).toHaveLength(2);
      expect(result.map((e) => e.name)).toEqual(["A", "C"]);
    });

    test("filters out entries with empty name", () => {
      const input = [
        { id: "a", type: "folder", name: "", ts: 0 },
        { id: "b", type: "file", name: "  ", ts: 0 },
        { id: "c", type: "file", name: "Valid", ts: 0 },
      ];
      const result = normalizeFiles(input);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Valid");
    });

    test("back-fills missing id", () => {
      const input = [{ type: "folder", name: "NoId", ts: 0 }];
      const result = normalizeFiles(input);
      expect(result).toHaveLength(1);
      expect(result[0].id).toMatch(/^n/);
    });

    test("de-duplicates id collisions", () => {
      const input = [
        { id: "dup", type: "folder", name: "A", ts: 0 },
        { id: "dup", type: "file", name: "B", ts: 0 },
        { id: "dup", type: "file", name: "C", ts: 0 },
      ];
      const result = normalizeFiles(input);
      expect(result).toHaveLength(3);
      const ids = result.map((e) => e.id);
      expect(new Set(ids).size).toBe(3);
      expect(ids[0]).toBe("dup");
      expect(ids[1]).toMatch(/^dup-/);
      expect(ids[2]).toMatch(/^dup-/);
    });

    test("tolerates missing/invalid timestamps", () => {
      const input = [
        { id: "a", type: "folder", name: "A" },
        { id: "b", type: "file", name: "B", ts: "invalid" },
        { id: "c", type: "file", name: "C", ts: NaN },
      ];
      const result = normalizeFiles(input);
      expect(result).toHaveLength(3);
      expect(result.every((e) => e.ts === 0)).toBe(true);
    });
  });

  describe("cycle safety — pathOf", () => {
    test("stops on circular parent chain", () => {
      const list: FEntry[] = [
        { id: "a", type: "folder", name: "A", parent: "b", ts: 0 },
        { id: "b", type: "folder", name: "B", parent: "a", ts: 0 },
      ];
      const path = pathOf(list, "a");
      expect(path.length).toBeLessThanOrEqual(2);
      expect(path.some((e) => e.id === "a")).toBe(true);
    });

    test("handles self-referential parent", () => {
      const list: FEntry[] = [
        { id: "loop", type: "folder", name: "Loop", parent: "loop", ts: 0 },
      ];
      const path = pathOf(list, "loop");
      expect(path).toHaveLength(1);
      expect(path[0].id).toBe("loop");
    });

    test("returns path from root to target", () => {
      const list: FEntry[] = [
        { id: "root", type: "folder", name: "Root", ts: 0 },
        { id: "child", type: "folder", name: "Child", parent: "root", ts: 0 },
        { id: "grand", type: "file", name: "Grand", parent: "child", ts: 0 },
      ];
      const path = pathOf(list, "grand");
      expect(path).toHaveLength(3);
      expect(path.map((e) => e.name)).toEqual(["Root", "Child", "Grand"]);
    });
  });

  describe("cycle safety — isInside", () => {
    test("detects folder contains itself (circular)", () => {
      const list: FEntry[] = [
        { id: "a", type: "folder", name: "A", parent: "b", ts: 0 },
        { id: "b", type: "folder", name: "B", parent: "a", ts: 0 },
      ];
      expect(isInside(list, "a", "b")).toBe(true);
      expect(isInside(list, "b", "a")).toBe(true);
    });

    test("detects child is inside parent", () => {
      const list: FEntry[] = [
        { id: "root", type: "folder", name: "Root", ts: 0 },
        { id: "child", type: "folder", name: "Child", parent: "root", ts: 0 },
      ];
      expect(isInside(list, "child", "root")).toBe(true);
      expect(isInside(list, "root", "child")).toBe(false);
    });

    test("returns false for unrelated entries", () => {
      const list: FEntry[] = [
        { id: "a", type: "folder", name: "A", ts: 0 },
        { id: "b", type: "folder", name: "B", ts: 0 },
      ];
      expect(isInside(list, "a", "b")).toBe(false);
      expect(isInside(list, "b", "a")).toBe(false);
    });
  });

  describe("cycle safety — folderTree", () => {
    test("terminates on corrupted graph", () => {
      const list: FEntry[] = [
        { id: "loop", type: "folder", name: "Loop", parent: "loop", ts: 0 },
      ];
      const tree = folderTree(list);
      expect(tree).toHaveLength(0);
    });

    test("builds breadth-first tree with depth", () => {
      const list: FEntry[] = [
        { id: "a", type: "folder", name: "A", ts: 0 },
        { id: "b", type: "folder", name: "B", parent: "a", ts: 0 },
        { id: "c", type: "folder", name: "C", parent: "b", ts: 0 },
        { id: "d", type: "folder", name: "D", ts: 0 },
      ];
      const tree = folderTree(list);
      expect(tree).toHaveLength(4);
      expect(tree.find((n) => n.id === "a")?.depth).toBe(0);
      expect(tree.find((n) => n.id === "b")?.depth).toBe(1);
      expect(tree.find((n) => n.id === "c")?.depth).toBe(2);
      expect(tree.find((n) => n.id === "d")?.depth).toBe(0);
    });
  });

  describe("batch operations — deleteEntries", () => {
    test("removes subtree union", () => {
      const list: FEntry[] = [
        { id: "a", type: "folder", name: "A", ts: 0 },
        { id: "b", type: "folder", name: "B", parent: "a", ts: 0 },
        { id: "c", type: "file", name: "C", parent: "b", ts: 0 },
        { id: "d", type: "file", name: "D", ts: 0 },
      ];
      const result = deleteEntries(list, new Set(["a", "d"]));
      expect(result).toHaveLength(0);
    });

    test("empty set is no-op", () => {
      const list: FEntry[] = [
        { id: "a", type: "folder", name: "A", ts: 0 },
      ];
      const result = deleteEntries(list, new Set());
      expect(result).toBe(list);
    });
  });

  describe("batch operations — moveEntries", () => {
    test("moves multiple entries to destination", () => {
      const list: FEntry[] = [
        { id: "root", type: "folder", name: "Root", ts: 0 },
        { id: "a", type: "file", name: "A", ts: 0 },
        { id: "b", type: "file", name: "B", ts: 0 },
      ];
      const result = moveEntries(list, new Set(["a", "b"]), "root");
      expect(result.find((e) => e.id === "a")?.parent).toBe("root");
      expect(result.find((e) => e.id === "b")?.parent).toBe("root");
    });

    test("rejects moving folder into its own subtree", () => {
      const list: FEntry[] = [
        { id: "a", type: "folder", name: "A", ts: 0 },
        { id: "b", type: "folder", name: "B", parent: "a", ts: 0 },
      ];
      const result = moveEntries(list, new Set(["a"]), "b");
      expect(result.find((e) => e.id === "a")?.parent).toBeUndefined();
    });
  });

  describe("search & sort", () => {
    test("searchFiles matches name case-insensitively", () => {
      const list: FEntry[] = [
        { id: "a", type: "file", name: "Document.txt", ts: 0 },
        { id: "b", type: "file", name: "photo.jpg", ts: 0 },
        { id: "c", type: "file", name: "README.md", ts: 0 },
      ];
      const result = searchFiles(list, "doc", false);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Document.txt");
    });

    test("searchFiles global mode searches all entries", () => {
      const list: FEntry[] = [
        { id: "a", type: "folder", name: "Docs", ts: 0 },
        { id: "b", type: "file", name: "note.txt", parent: "a", ts: 0 },
      ];
      const result = searchFiles(list, "note", true);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("note.txt");
    });

    test("sortChildren by name uses locale", () => {
      const list: FEntry[] = [
        { id: "root", type: "folder", name: "Root", ts: 0 },
        { id: "c", type: "file", name: "Charlie", parent: "root", ts: 100 },
        { id: "a", type: "file", name: "Alice", parent: "root", ts: 200 },
        { id: "b", type: "file", name: "Bob", parent: "root", ts: 300 },
      ];
      const result = sortChildren(list, "root", "name");
      expect(result.map((e) => e.name)).toEqual(["Alice", "Bob", "Charlie"]);
    });

    test("sortChildren by time (newest first)", () => {
      const list: FEntry[] = [
        { id: "root", type: "folder", name: "Root", ts: 0 },
        { id: "old", type: "file", name: "Old", parent: "root", ts: 100 },
        { id: "new", type: "file", name: "New", parent: "root", ts: 300 },
        { id: "mid", type: "file", name: "Mid", parent: "root", ts: 200 },
      ];
      const result = sortChildren(list, "root", "time");
      expect(result.map((e) => e.name)).toEqual(["New", "Mid", "Old"]);
    });

    test("sortChildren default preserves insertion order", () => {
      const list: FEntry[] = [
        { id: "root", type: "folder", name: "Root", ts: 0 },
        { id: "c", type: "file", name: "C", parent: "root", ts: 100 },
        { id: "a", type: "file", name: "A", parent: "root", ts: 200 },
        { id: "b", type: "file", name: "B", parent: "root", ts: 300 },
      ];
      const result = sortChildren(list, "root", "default");
      expect(result.map((e) => e.name)).toEqual(["C", "A", "B"]);
    });
  });

  describe("recentFiles", () => {
    test("returns most recent entries", () => {
      const list: FEntry[] = [
        { id: "a", type: "file", name: "Old", ts: 100 },
        { id: "b", type: "file", name: "New", ts: 300 },
        { id: "c", type: "file", name: "Mid", ts: 200 },
      ];
      const result = recentFiles(list, 2);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("New");
      expect(result[1].name).toBe("Mid");
    });
  });

  describe("toggleFav", () => {
    test("adds id to empty list", () => {
      expect(toggleFav([], "a")).toEqual(["a"]);
    });

    test("removes existing id", () => {
      expect(toggleFav(["a", "b", "c"], "b")).toEqual(["a", "c"]);
    });

    test("adds missing id", () => {
      expect(toggleFav(["a", "c"], "b")).toEqual(["a", "c", "b"]);
    });
  });

  describe("hasName", () => {
    test("returns true for duplicate name", () => {
      const children: FEntry[] = [
        { id: "a", type: "folder", name: "Docs", ts: 0 },
      ];
      expect(hasName(children, "Docs")).toBe(true);
    });

    test("returns false for unique name", () => {
      const children: FEntry[] = [
        { id: "a", type: "folder", name: "Docs", ts: 0 },
      ];
      expect(hasName(children, "Photos")).toBe(false);
    });
  });
});
