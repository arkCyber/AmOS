/**
 * Tests for filesPreview.ts — pure-JS fallback classifier.
 *
 * The Rust command (files_preview_bytes, in `crates/amos-tauri/src/files.rs`)
 * is the production path; these tests verify the **fallback** path used in the
 * happy-dom test environment where `__TAURI_INTERNALS__` is not present.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  decodeTextSafely,
  mimeFromName,
  planPreview,
  previewBytesLabel,
} from "../filesPreview";

/** Evaluate a Rust byte-count literal (`1_099_511_627_776`, `1024 * 1024 * 2`). */
function evalExpr(expr: string): number {
  return Number(new Function(`return (${expr.replace(/_/g, "")})`)());
}

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

  // The rule lives in three places — Rust `size_label`, this `previewBytesLabel`, and
  // (now delegated to this function) `filesCloud::formatSnapshotSize` — and the doc
  // comments on the two JS copies only *claim* they mirror Rust. This case is the
  // binding: it reads the Rust vectors and runs them through the JS implementation, so
  // a threshold/unit/rounding change on either side is a red here, not two different
  // labels for the same file in two UI surfaces.
  it("reproduces every Rust size_label vector", () => {
    const rust = readFileSync(
      new URL("../../../../../amos-tauri/src/files.rs", import.meta.url),
      "utf8",
    );
    const vectors = [...rust.matchAll(/assert_eq!\(\s*size_label\(([^)]*)\),\s*"([^"]*)"\s*\)/g)].map(
      (m) => ({ bytes: evalExpr(m[1] ?? ""), label: m[2] ?? "" }),
    );
    // Guard the source-reading test against going vacuous: if the vectors move out of
    // the scanned window, fail loudly instead of comparing an empty list.
    expect(vectors.length).toBeGreaterThanOrEqual(11);
    for (const { bytes, label } of vectors) {
      expect(previewBytesLabel(bytes), `size_label(${bytes})`).toBe(label);
    }
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

// The three MIME tables in this module are a *copy* of the Rust classifier's
// `IMAGE_MIMES`/`AUDIO_MIMES`/`VIDEO_MIMES` in `crates/amos-tauri/src/files.rs`. Nothing
// bound them until now: the TS `AUDIO_MIMES` set had silently dropped `audio/mp4` (the MIME
// `amos-media`'s MediaStore mapping emits for `.m4a`/`.m4b`) while keeping a comment that
// claimed the entry was present. Consequence: the same MediaStore `.m4a` classified as
// `audio` on the host path and `binary` on this fallback — one app, two answers. This reads
// both sources and requires the three sets to be equal, so the next drift is a red, not a
// silent "no preview".
describe("MIME tables == amos-tauri files.rs classifier", () => {
  const rust = readFileSync(new URL("../../../../../amos-tauri/src/files.rs", import.meta.url), "utf8");
  const ts = readFileSync(new URL("../filesPreview.ts", import.meta.url), "utf8");

  function rustMimes(name: string): string[] {
    const block = rust.match(new RegExp(`const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`))?.[1] ?? "";
    return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
  }
  function tsMimes(name: string): string[] {
    const block = ts.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))?.[1] ?? "";
    return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
  }

  it("the fallback classifier knows every MIME the Rust path does, and no others", () => {
    for (const name of ["IMAGE_MIMES", "AUDIO_MIMES", "VIDEO_MIMES"]) {
      const r = rustMimes(name);
      const t = tsMimes(name);
      // Non-vacuity: the parser must find the real tables, not two empty strings.
      expect(r.length, `${name} in files.rs`).toBeGreaterThanOrEqual(3);
      expect([...t].sort(), `${name}: TS fallback vs Rust files.rs`).toEqual([...r].sort());
    }
  });

  it("audio/mp4 (MediaStore's .m4a MIME) previews as audio", async () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]); // ftyp box
    const r = await planPreview("Voice_001.m4a", "audio/mp4", bytes);
    expect(r?.kind).toBe("audio");
  });
});

// `planPreview` documented its fallback as firing only "when the host bridge is
// unavailable". That was not true: `invoke` resolves `null` for a **refused** call as well,
// and the code fell through to the shell's own classifier either way — with its own MIME
// tables and none of the host's `PREVIEW_TEXT_MAX` cap. The two are different facts, and a
// present host that produced no plan is not a licence to classify the file in its place
// (F-SH-281). `PlayerApp.svelte`'s resolve path already answers this way for the same
// question ("any bridge / store / blob failure is surfaced honestly as unavailable").
describe("planPreview — a present host that produced no plan (F-SH-281)", () => {
  // This file is a pure (`bun test`) batch: there is no `window` here, which is exactly why
  // the fallback block above passes. A host is installed the way `print.test.ts` does it.
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  /** A host that is *present* for every preview call. `answer` decides what it does. */
  function installHost(answer: () => unknown) {
    (globalThis as unknown as { window: unknown }).window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string) => (cmd === "files_preview_bytes" ? answer() : null),
        listen: async () => () => {},
      },
    };
  }

  const bytes = () => new TextEncoder().encode("hello world");

  it("a host that refused is not answered by the shell's own classifier", async () => {
    installHost(() => {
      throw new Error("ipc down");
    });
    const r = await planPreview("note.txt", "text/plain", bytes());
    expect(r?.kind, "the shell must not classify where the host refused").toBe("unavailable");
    expect(r?.reason).toBe("refused");
    expect(r?.src).toBe("");
    expect(r?.isText).toBe(false);
    expect(r?.mime).toBe("text/plain");
  });

  it("a host that answered `null` to a never-null reply is a wire violation, not a refusal", async () => {
    installHost(() => null);
    const r = await planPreview("note.txt", "text/plain", bytes());
    expect(r?.kind).toBe("unavailable");
    expect(r?.reason, "「answered something unreadable」 ≠ 「refused」").toBe("unreadable");
  });

  it("control: with no bridge at all the shell's classifier still answers", async () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    const r = await planPreview("note.txt", "text/plain", bytes());
    expect(r?.kind, "the documented fallback must survive the guard").toBe("text");
    expect(r?.src).toBe("hello world");
  });

  it("control: a host that does answer has its own plan used, unchanged", async () => {
    installHost(() => ({
      kind: "binary",
      data: "",
      mime: "application/octet-stream",
      isText: false,
      sizeLabel: "1 B",
      error: null,
    }));
    const r = await planPreview("blob.bin", null, new Uint8Array([0]));
    expect(r?.kind).toBe("binary");
    expect(r?.sizeLabel, "the host's label, not the shell's").toBe("1 B");
  });
});
