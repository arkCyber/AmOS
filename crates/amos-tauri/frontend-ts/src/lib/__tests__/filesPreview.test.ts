/**
 * Tests for filesPreview.ts — pure-JS fallback classifier.
 *
 * The Rust command (files_preview_bytes, in `crates/amos-tauri/src/files.rs`)
 * is the production path; these tests verify the **fallback** path used in the
 * happy-dom test environment where `__TAURI_INTERNALS__` is not present.
 */

import { describe, expect, it } from "bun:test";
import {
  decodeTextSafely,
  mimeFromName,
  planPreview,
  previewBytesLabel,
} from "../filesPreview";

describe("mimeFromName", () => {
  it("maps common extensions to MIME types", () => {
    expect(mimeFromName("photo.jpg")).toBe("image/jpeg");
    expect(mimeFromName("photo.jpeg")).toBe("image/jpeg");
    expect(mimeFromName("image.png")).toBe("image/png");
    expect(mimeFromName("song.MP3")).toBe("audio/mpeg");
    expect(mimeFromName("video.mp4")).toBe("video/mp4");
    expect(mimeFromName("README.md")).toBe("text/plain");
    expect(mimeFromName("data.json")).toBe("application/json");
    expect(mimeFromName("doc.xml")).toBe("application/xml");
    expect(mimeFromName("script.js")).toBe("application/javascript");
  });

  it("returns null for files without an extension", () => {
    expect(mimeFromName("noext")).toBeNull();
    expect(mimeFromName("")).toBeNull();
    expect(mimeFromName("file.")).toBeNull();
  });

  it("returns null for unknown extensions", () => {
    expect(mimeFromName("archive.zip")).toBeNull();
    expect(mimeFromName("binary.exe")).toBeNull();
  });
});

describe("decodeTextSafely", () => {
  it("decodes pure UTF-8 text losslessly", () => {
    const bytes = new TextEncoder().encode("你好，world");
    const r = decodeTextSafely(bytes);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("你好，world");
    expect(r.lossy).toBe(false);
  });

  it("returns false for NUL-containing bytes (binary signal)", () => {
    const bytes = new Uint8Array([0x68, 0x65, 0x00, 0x6c, 0x6c, 0x6f]);
    const r = decodeTextSafely(bytes);
    expect(r.ok).toBe(false);
  });

  it("returns ok for empty input", () => {
    const r = decodeTextSafely(new Uint8Array(0));
    expect(r.ok).toBe(true);
    expect(r.text).toBe("");
  });
});

describe("previewBytesLabel", () => {
  it("formats bytes human-readably", () => {
    expect(previewBytesLabel(0)).toBe("0 B");
    expect(previewBytesLabel(512)).toBe("512 B");
    // Exact boundaries (1 KB, 5 MB) shown as integers; fractional values as 1 decimal.
    expect(previewBytesLabel(1024)).toBe("1 KB");
    expect(previewBytesLabel(1536)).toBe("1.5 KB");
    expect(previewBytesLabel(5 * 1024 * 1024)).toBe("5 MB");
    expect(previewBytesLabel(-1)).toBe("—");
  });
});

describe("planPreview (fallback path)", () => {
  it("text file with declared mime", async () => {
    const bytes = new TextEncoder().encode("hello world");
    // No host bridge → fallback path
    const r = await planPreview("note.txt", "text/plain", bytes);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe("text");
    expect(r?.src).toBe("hello world");
    expect(r?.isText).toBe(true);
  });

  it("text file via extension inference", async () => {
    const bytes = new TextEncoder().encode("# README");
    const r = await planPreview("README.md", null, bytes);
    expect(r?.kind).toBe("text");
  });

  it("image bytes produce an image plan with data URL", async () => {
    // Minimal PNG signature (won't actually render but enough to test the path).
    const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const r = await planPreview("tiny.png", "image/png", bytes);
    expect(r?.kind).toBe("image");
    expect(r?.src.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("audio bytes produce an audio plan", async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33]); // ID3 marker
    const r = await planPreview("song.mp3", "audio/mpeg", bytes);
    expect(r?.kind).toBe("audio");
    expect(r?.src.startsWith("data:audio/mpeg;base64,")).toBe(true);
  });

  it("video bytes produce a video plan", async () => {
    const bytes = new Uint8Array([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70]); // ftyp box
    const r = await planPreview("clip.mp4", "video/mp4", bytes);
    expect(r?.kind).toBe("video");
    expect(r?.src.startsWith("data:video/mp4;base64,")).toBe(true);
  });

  it("binary content without MIME/extension is reported as binary", async () => {
    // No extension, no MIME hint → the JS fallback sniffs for a NUL byte; the
    // first 4 KiB contain one, so the file is classified as binary.
    const bytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
    const r = await planPreview("noext", null, bytes);
    expect(r?.kind).toBe("binary");
    expect(r?.isText).toBe(false);
  });

  it("image MIME produces an image plan even for small JPEG headers (Rust re-checks)", async () => {
    // The Rust path is the production path and re-checks for NUL bytes; the JS
    // fallback trusts the declared MIME. This documents that behaviour.
    const bytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    const r = await planPreview("photo.jpg", "image/jpeg", bytes);
    expect(r?.kind).toBe("image");
  });

  it("empty bytes → empty kind", async () => {
    const r = await planPreview("a.txt", null, new Uint8Array(0));
    expect(r?.kind).toBe("empty");
  });
});
