import { describe, expect, test } from "bun:test";
import {
  childrenOf,
  deleteEntry,
  isInside,
  moveEntry,
  pathOf,
  renameEntry,
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

  test("deleting a folder cascades to descendants only", () => {
    const after = deleteEntry(list, "a");
    expect(after.map((e) => e.id)).toEqual(["r"]);
  });
});
