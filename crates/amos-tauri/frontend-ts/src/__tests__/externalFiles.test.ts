import { describe, expect, it } from "bun:test";
import type { MediaItem } from "../lib/media";
import {
  buildExternalFileView,
  dedupeExternal,
  externalGlyph,
  filterExternalByName,
  formatBytes,
  groupByCollection,
  mergeDeduped,
  normalizeExternalFile,
  recentExternalFiles,
  sortExternalFiles,
  toExternalFile,
  totalExternalBytes,
} from "../lib/externalFiles";

function item(partial: Partial<MediaItem> & { name: string; uri: string; ts: number }): MediaItem {
  return {
    id: partial.uri,
    kind: "file",
    collection: "download",
    mime: null,
    size_bytes: null,
    ...partial,
  };
}

describe("externalGlyph + formatBytes", () => {
  it("maps kinds to stable glyphs", () => {
    expect(externalGlyph("image")).toBe("🖼");
    expect(externalGlyph("video")).toBe("🎬");
    expect(externalGlyph("audio")).toBe("🎵");
    expect(externalGlyph("file")).toBe("📄");
    expect(externalGlyph("download")).toBe("📦");
  });

  it("formats byte sizes human-readably and degrades gracefully", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(-3)).toBe("—");
  });
});

describe("toExternalFile / normalizeExternalFile", () => {
  it("maps a native item to a read-only display node", () => {
    const it = item({ name: "notes.pdf", uri: "content://dl/1", ts: 5, size_bytes: 2048 });
    const f = toExternalFile(it);
    expect(f).toMatchObject({
      id: "content://dl/1",
      name: "notes.pdf",
      uri: "content://dl/1",
      sizeBytes: 2048,
      ts: 5,
    });
  });

  it("normalizes raw payloads and drops the unparseable", () => {
    const ok = normalizeExternalFile({
      id: "x",
      name: "a.apk",
      kind: "download",
      collection: "download",
      uri: "mock://a.apk",
      mime: null,
      size_bytes: 7,
      ts: 1,
    });
    expect(ok?.name).toBe("a.apk");
    expect(normalizeExternalFile(null)).toBeNull();
    expect(normalizeExternalFile({})).toBeNull(); // no id/name
  });
});

describe("sort / filter / total", () => {
  const files = [
    toExternalFile(item({ name: "b.txt", uri: "u-b", ts: 1, size_bytes: 300 })),
    toExternalFile(item({ name: "a.pdf", uri: "u-a", ts: 3, size_bytes: 100 })),
    toExternalFile(item({ name: "c.png", uri: "u-c", ts: 2, size_bytes: 50 })),
  ];

  it("sorts by name / date / size", () => {
    expect(sortExternalFiles(files, "name").map((f) => f.name)).toEqual(["a.pdf", "b.txt", "c.png"]);
    expect(sortExternalFiles(files, "date").map((f) => f.name)).toEqual(["a.pdf", "c.png", "b.txt"]);
    expect(sortExternalFiles(files, "size").map((f) => f.name)).toEqual(["b.txt", "a.pdf", "c.png"]);
  });

  it("filters by name and totals bytes", () => {
    expect(filterExternalByName(files, "PDF").map((f) => f.name)).toEqual(["a.pdf"]);
    expect(filterExternalByName(files, "zzz")).toEqual([]);
    expect(filterExternalByName(files, "")).toHaveLength(3);
    expect(totalExternalBytes(files)).toBe(450);
  });
});

// REQ-A1525 / F-SH-770: `MediaItem.size_bytes` is `number | null` — `null` means the
// platform did not report that file's size. The old total folded it to 0, so the
// Files screen's header printed a byte count nobody measured (`0 B` when no size was
// reported at all) while each row on that same screen printed 「—」 for the very same
// file. An unmeasured size withholds the total; only a real 0 sums to 0.
describe("totalExternalBytes with unmeasured sizes (REQ-A1525)", () => {
  const known = (name: string, uri: string, size_bytes: number) =>
    toExternalFile(item({ name, uri, ts: 1, size_bytes }));
  const unknown = (name: string, uri: string) => toExternalFile(item({ name, uri, ts: 1 }));

  it("withholds the total when a file's size was not reported", () => {
    expect(totalExternalBytes([unknown("a", "u-a")])).toBeNull();
    // A partial sum is not "the total" either — one unmeasured file in the list
    // makes the exact total unknowable.
    expect(totalExternalBytes([known("a", "u-a", 100), unknown("b", "u-b")])).toBeNull();
    expect(totalExternalBytes([unknown("b", "u-b"), known("a", "u-a", 100)])).toBeNull();
  });

  it("still totals when every size was reported", () => {
    expect(totalExternalBytes([known("a", "u-a", 100), known("b", "u-b", 350)])).toBe(450);
    // Positive control: a *measured* zero is not the same as an unmeasured one.
    expect(totalExternalBytes([known("a", "u-a", 0), known("b", "u-b", 0)])).toBe(0);
    expect(totalExternalBytes([])).toBe(0);
  });

  it("buildExternalFileView carries the withheld total through", () => {
    const raw = [
      { id: "u-a", name: "a.pdf", uri: "u-a", kind: "file", collection: "download", ts: 1, size_bytes: 10 },
      { id: "u-b", name: "b.pdf", uri: "u-b", kind: "file", collection: "download", ts: 2 },
    ];
    const view = buildExternalFileView(raw);
    expect(view.fileCount).toBe(2);
    expect(view.totalBytes).toBeNull();
  });
});

describe("group / dedupe / merge / recent", () => {
  const dlA = toExternalFile(
    item({ name: "a.pdf", uri: "dl-a", ts: 3, collection: "download", size_bytes: 10 }),
  );
  const dlB = toExternalFile(
    item({ name: "b.pdf", uri: "dl-b", ts: 1, collection: "download", size_bytes: 20 }),
  );
  const pic = toExternalFile(
    item({ name: "c.png", uri: "pic-c", ts: 2, collection: "pictures", size_bytes: 30 }),
  );

  it("groups by collection preserving first-seen order", () => {
    const groups = groupByCollection([dlB, pic, dlA]);
    expect(groups.map((g) => g.collection)).toEqual(["download", "pictures"]);
    expect(groups[0]?.files).toHaveLength(2);
    expect(groups[1]?.files.map((f) => f.name)).toEqual(["c.png"]);
    expect(groupByCollection([])).toEqual([]);
  });

  it("dedupes by uri and merges two sources", () => {
    const dup = toExternalFile(item({ name: "a.pdf", uri: "dl-a", ts: 9, collection: "download" }));
    const dd = dedupeExternal([dlA, dup, dlB]);
    expect(dd).toHaveLength(2);
    expect(dd.map((f) => f.name)).toEqual(["a.pdf", "b.pdf"]);
    // union of {dl-a} ∪ {pic-c, dl-b} → 3 distinct uris
    expect(mergeDeduped([dlA, dup], [pic, dlB])).toHaveLength(3);
  });

  it("recent returns newest first and pushes unknown-mtime last", () => {
    const noTs = toExternalFile(item({ name: "z.txt", uri: "dl-z", ts: 0 }));
    const recent = recentExternalFiles([noTs, dlB, pic, dlA], 3);
    expect(recent.map((f) => f.name)).toEqual(["a.pdf", "c.png", "b.pdf"]);
    const wide = recentExternalFiles([noTs, dlB], 5);
    expect(wide[wide.length - 1]?.name).toBe("z.txt");
    expect(recentExternalFiles([dlA], 0)).toEqual([]);
  });

  it("buildExternalFileView normalizes, groups, sorts and aggregates a raw list", () => {
    const raw = [
      { id: "dl-b", name: "b.pdf", uri: "dl-b", kind: "file", collection: "download", ts: 1, size_bytes: 20 },
      { id: "dl-a", name: "a.pdf", uri: "dl-a", kind: "file", collection: "download", ts: 3, size_bytes: 10 },
      { id: "pic-c", name: "c.png", uri: "pic-c", kind: "image", collection: "pictures", ts: 2, size_bytes: 30 },
      null, // unparseable → dropped
      "garbage",
    ];
    const view = buildExternalFileView(raw);
    expect(view.fileCount).toBe(3);
    expect(view.totalBytes).toBe(60);
    expect(view.groups.map((g) => g.collection)).toEqual(["download", "pictures"]);
    // each group sorted by name
    expect(view.groups[0]?.files.map((f) => f.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(view.groups[1]?.files.map((f) => f.name)).toEqual(["c.png"]);
    expect(buildExternalFileView([])).toEqual({ groups: [], fileCount: 0, totalBytes: 0 });
  });
});
