/**
 * filesCompression.ts — Thin UI wrapper over Rust commands.
 *
 * The actual gzip compression + base64 encoding for `.amos-bundle` lives in
 * `crates/amos-tauri/src/files.rs::bundle_export_core` / `bundle_import_core`
 * (real filesystem work, host-side). This module is the **fallback** for when the
 * host bridge is unavailable (browser preview / offline build): it provides a
 * pure-JS gzip path using `CompressionStream` / `DecompressionStream` so the
 * WebView can still export/import bundles in a happy-dom test environment.
 *
 * In production (Tauri runtime), the Rust path is always used.
 */

import {
  filesBundleExport as rustFilesBundleExport,
  filesBundleImport as rustFilesBundleImport,
  type FilesBundleExport,
  type FilesBundleImport,
} from "./backend";
import type { FEntry } from "./files";

/** Magic header for the bundle file.  Must match the Rust side. */
export const BUNDLE_MAGIC = "AmosFilesBundle/1.0";
/** Maximum uncompressed bundle size (matches Rust). */
const MAX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;

/** Whether the Tauri bridge is available — gates which path to take. */
function hostAvailable(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === "object"
    );
  } catch {
    return false;
  }
}

/** The on-disk bundle shape (serialized as the text after the magic line). */
export interface BundleBody {
  version: 1;
  compressed: string; // base64
}

/** Result of `exportBundle` — returns the `.amos-bundle` text + size metadata. */
export interface BundleExportResult {
  /** The `.amos-bundle` file content (magic line + body). */
  text: string;
  /** Raw uncompressed bytes length. */
  originalBytes: number;
  /** Gzip-compressed bytes length. */
  compressedBytes: number;
  /** Number of entries in the bundle. */
  entryCount: number;
  /** Human-readable compression ratio (e.g. `"23%"` or `"105%"` if expanded). */
  ratioLabel: string;
}

/** Result of `importBundle` — discriminated union. */
export type BundleImportResult =
  | { ok: true; entries: FEntry[]; originalBytes: number; compressedBytes: number; entryCount: number }
  | {
      ok: false;
      reason: string;
      compressedBytes?: number;
      uncompressedBytes?: number;
    };

// ---- pure-JS gzip fallback --------------------------------------------------

/** Whether CompressionStream / DecompressionStream is available.  In the Bun test
 *  runtime (v1.2.x) and older browsers, these APIs may be missing; the fallback
 *  returns `null` and the WebView surfaces a clear "no gzip available" error. */
function gzipAvailable(): boolean {
  try {
    return (
      typeof CompressionStream !== "undefined" &&
      typeof DecompressionStream !== "undefined"
    );
  } catch {
    return false;
  }
}

async function gzipCompress(data: Uint8Array): Promise<Uint8Array | null> {
  if (!gzipAvailable()) return null;
  try {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    // `BufferSource` wants an `ArrayBuffer`-backed view while the parameter is the generic
    // `Uint8Array<ArrayBufferLike>` (which admits a `SharedArrayBuffer`): every buffer reaching
    // here comes from `TextEncoder`/`Buffer`, which are `ArrayBuffer`-backed, so the narrowing is
    // asserted at the call rather than copying the bytes (REQ-A412).
    writer.write(data as Uint8Array<ArrayBuffer>);
    writer.close();
    const chunks: Uint8Array[] = [];
    let result = await reader.read();
    while (!result.done) {
      chunks.push(result.value as Uint8Array);
      result = await reader.read();
    }
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  } catch {
    return null;
  }
}

async function gzipDecompress(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    // Same narrowing as `gzipCompress` (see the comment there).
    writer.write(data as Uint8Array<ArrayBuffer>);
    writer.close();
    const chunks: Uint8Array[] = [];
    let result = await reader.read();
    while (!result.done) {
      chunks.push(result.value as Uint8Array);
      result = await reader.read();
    }
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64.replace(/\s/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ---- JS fallback (only used when the host bridge is unavailable) -----------

async function exportBundleFallback(entries: FEntry[]): Promise<BundleExportResult | null> {
  let json: string;
  try {
    json = JSON.stringify(entries);
  } catch {
    return null;
  }
  const raw = new TextEncoder().encode(json);
  const compressed = await gzipCompress(raw);
  if (!compressed) return null;
  const b64 = bytesToBase64(compressed);
  const text = `${BUNDLE_MAGIC}\n${b64}`;
  return {
    text,
    originalBytes: raw.byteLength,
    compressedBytes: compressed.byteLength,
    entryCount: entries.length,
    // Ratio: compress or expand depending on data.
    ratioLabel: raw.byteLength > 0
      ? `${Math.round(100 * compressed.byteLength / raw.byteLength)}%`
      : "100%",
  };
}

async function importBundleFallback(
  raw: string,
  normalize: (raw: unknown) => FEntry[],
): Promise<BundleImportResult> {
  const lines = raw.split("\n");
  if (lines.length < 2) return { ok: false, reason: "invalid bundle (too short)" };
  const magic = lines[0]?.trim() ?? "";
  if (magic !== BUNDLE_MAGIC) {
    return { ok: false, reason: `unrecognised bundle format "${magic}"` };
  }
  const b64 = lines.slice(1).join("").trim();
  if (!b64) return { ok: false, reason: "bundle body is empty" };
  const compressed = base64ToBytes(b64);
  if (!compressed) return { ok: false, reason: "bundle body is not valid base64" };
  const compressedBytes = compressed.byteLength;
  const decompressed = await gzipDecompress(compressed);
  if (!decompressed) {
    return { ok: false, reason: "bundle body is not valid gzip data", compressedBytes };
  }
  if (decompressed.byteLength > MAX_UNCOMPRESSED_BYTES) {
    return {
      ok: false,
      reason: `bundle too large (${decompressed.byteLength} bytes, max ${MAX_UNCOMPRESSED_BYTES})`,
      compressedBytes,
      uncompressedBytes: decompressed.byteLength,
    };
  }
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(decompressed);
  } catch {
    return {
      ok: false,
      reason: "bundle decompressed to invalid UTF-8 text",
      compressedBytes,
      uncompressedBytes: decompressed.byteLength,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      ok: false,
      reason: "bundle decompressed to invalid JSON",
      compressedBytes,
      uncompressedBytes: decompressed.byteLength,
    };
  }
  const entries = normalize(parsed);
  return {
    ok: true,
    entries,
    originalBytes: decompressed.byteLength,
    compressedBytes,
    entryCount: entries.length,
  };
}

// ---- public API -------------------------------------------------------------

/**
 * Export `entries` as a `.amos-bundle` text.  Prefers the Rust command
 * (`files_bundle_export`) when the host bridge is present; falls back to the
 * pure-JS gzip path otherwise.
 */
export async function exportBundle(entries: FEntry[]): Promise<BundleExportResult | null> {
  if (hostAvailable()) {
    const r: FilesBundleExport | null = await rustFilesBundleExport(entries);
    if (r) {
      return {
        text: r.text,
        originalBytes: r.originalBytes,
        compressedBytes: r.compressedBytes,
        entryCount: r.entryCount,
        // Carry the host's ratio through. This field was **dropped** here, so every consumer that
        // renders `ratioLabel` read `undefined` whenever the Rust path answered (the JS fallback
        // below always set it) — a silent difference between the two paths, caught by `typecheck`
        // (REQ-A412).
        ratioLabel: r.ratioLabel,
      };
    }
    // Bridge responded null → fall back to JS path (defensive).
  }
  return exportBundleFallback(entries);
}

/**
 * Import an `.amos-bundle` text.  Prefers the Rust command when available.
 * The `normalize` argument is the `normalizeFiles` function from `lib/files.ts`;
 * it tolerates corrupted/legacy entries.
 */
export async function importBundle(
  raw: string,
  normalize: (raw: unknown) => FEntry[],
): Promise<BundleImportResult> {
  if (hostAvailable()) {
    const r: FilesBundleImport | null = await rustFilesBundleImport(raw);
    if (r) {
      if (r.tag === "Ok") {
        return {
          ok: true,
          entries: normalize(r.data.entries),
          originalBytes: r.data.originalBytes,
          compressedBytes: r.data.compressedBytes,
          entryCount: r.data.entryCount,
        };
      }
      return {
        ok: false,
        reason: r.data.reason,
        compressedBytes: r.data.compressedBytes ?? undefined,
        uncompressedBytes: r.data.uncompressedBytes ?? undefined,
      };
    }
  }
  return importBundleFallback(raw, normalize);
}
