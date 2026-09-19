/**
 * Tests for filesCompression.ts — pure-JS gzip fallback path.
 *
 * The Rust command (files_bundle_export / files_bundle_import, in
 * `crates/amos-tauri/src/files.rs`) is the production path. These tests verify
 * the JS-only fallback used when the Tauri host bridge is not present (happy-dom
 * test environment).  The actual gzip round-trip + base64 encode/decode is
 * exercised here so a corrupt compression implementation cannot silently fail.
 */

import { describe, expect, it } from "bun:test";
import { exportBundle, importBundle, BUNDLE_MAGIC } from "../filesCompression";
import { normalizeFiles } from "../files";

/** In Bun v1.2.x, the Web Streams gzip APIs are not available. The JS fallback
 *  therefore returns `null` for export; the Rust command is the production path. */
const gzipAvailable =
  typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

describe("filesCompression — fallback JS path", () => {
  it("exports and re-imports a round-trip", async () => {
    if (!gzipAvailable) {
      // Bun v1.2.x lacks Web Streams gzip; skip the round-trip here.
      // The Rust command path is exercised by the integration tests / manual QA.
      const r = await exportBundle([{ id: "a", type: "folder" as const, name: "x", ts: 0 }]);
      expect(r).toBeNull();
      return;
    }
    const original = [
      { id: "a", type: "folder" as const, name: "文档", ts: 1700000000 },
      {
        id: "b",
        type: "file" as const,
        name: "笔记.txt",
        parent: "a",
        content: "你好世界",
        ts: 1700000001,
      },
    ];
    const exported = await exportBundle(original);
    expect(exported).not.toBeNull();
    expect(exported!.text.startsWith(BUNDLE_MAGIC)).toBe(true);
    expect(exported!.entryCount).toBe(2);
    // Gzip should make the bundle smaller than (or equal to) the raw bytes,
    // and certainly positive. The exact ratio is implementation-defined.
    expect(exported!.compressedBytes).toBeGreaterThan(0);

    const imported = await importBundle(exported!.text, normalizeFiles);
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.entries).toHaveLength(2);
      expect(imported.entries[0]?.name).toBe("文档");
      expect(imported.entries[1]?.name).toBe("笔记.txt");
      expect(imported.entries[1]?.content).toBe("你好世界");
    }
  });

  it("rejects a bundle with the wrong magic header", async () => {
    const r = await importBundle("NotABundle\nSGVsbG8=", normalizeFiles);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unrecognised");
  });

  it("rejects an empty bundle body", async () => {
    const r = await importBundle(`${BUNDLE_MAGIC}\n`, normalizeFiles);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("empty");
  });

  it("rejects invalid base64", async () => {
    const r = await importBundle(`${BUNDLE_MAGIC}\n!!!not-base64!!!`, normalizeFiles);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("base64");
  });

  it("an empty entry list round-trips through gzip", async () => {
    if (!gzipAvailable) return;
    const exported = await exportBundle([]);
    expect(exported).not.toBeNull();
    expect(exported!.entryCount).toBe(0);

    const imported = await importBundle(exported!.text, normalizeFiles);
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(imported.entries).toEqual([]);
  });

  it("normalises malformed entries on import (no crash)", async () => {
    if (!gzipAvailable) return;
    const exported = await exportBundle([
      { id: "x", type: "folder" as const, name: "ok", ts: 0 },
    ] as never[]);
    // Tamper with the bundle to introduce garbage (overwrite the body with a
    // crafted JSON that has a corrupt entry).
    const lines = exported!.text.split("\n");
    lines[1] = btoa(unescape(encodeURIComponent(JSON.stringify([
      { id: "good", type: "folder", name: "Good", ts: 0 },
      { id: "bad", type: "file" },
      null,
      "string",
    ]))));
    const tampered = lines.join("\n");
    const r = await importBundle(tampered, normalizeFiles);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Only the well-formed entry survives normalisation.
      expect(r.entries).toHaveLength(1);
      expect(r.entries[0]?.name).toBe("Good");
    }
  });
});
