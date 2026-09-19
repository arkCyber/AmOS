/**
 * filesPreview.ts — Thin UI wrapper over the Rust preview command.
 *
 * The real work (MIME classification, safe text decode, media data-URL assembly,
 * size capping) lives in `crates/amos-tauri/src/files.rs::preview_core`. This
 * module is the **renderer-facing glue**: it calls `files_preview_bytes`, then
 * maps the structured reply into the kind of plan the Svelte surface needs.
 *
 * The pure-JS fallback path (`planPreviewLocal`) only fires when the host
 * bridge is unavailable (browser preview / happy-dom test environment).
 */

import {
  filesPreviewBytes as rustFilesPreview,
  type FilesPreviewResult,
} from "./backend";

export type PreviewKind = "text" | "image" | "audio" | "video" | "binary" | "empty";

/** A renderer's view of a preview: kind + source + size. */
export interface PreviewPlan {
  kind: PreviewKind;
  /** For text: the decoded string body. For media: a `data:<mime>;base64,…` URL. */
  src: string;
  /** Bytes of the source (when known). */
  bytes: number;
  /** True only for plain-text files. */
  isText: boolean;
  /** Truncation notice (null when not truncated). */
  error: string | null;
  /** Human-readable size label from the Rust command. */
  sizeLabel: string;
  /** MIME the renderer should declare. */
  mime: string | null;
}

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

/** Convert a Rust reply into the Svelte-friendly plan. */
function toPlan(r: FilesPreviewResult): PreviewPlan {
  return {
    kind: r.kind as PreviewKind,
    src: r.data,
    bytes: 0,
    isText: r.isText,
    error: r.error,
    sizeLabel: r.sizeLabel,
    mime: r.mime,
  };
}

/**
 * Get a preview plan for `name` + `mime` + `bytes`.  Prefers the Rust command;
 * falls back to a small pure-JS classifier (text-only) when the bridge is
 * missing.
 */
export async function planPreview(
  name: string,
  mime: string | null,
  bytes: Uint8Array | null,
): Promise<PreviewPlan | null> {
  if (bytes === null) {
    return { kind: "binary", src: "", bytes: 0, isText: false, error: null, sizeLabel: "—", mime };
  }
  if (hostAvailable()) {
    const r = await rustFilesPreview(name, mime, bytes);
    if (r) return toPlan(r);
  }
  return planPreviewLocal(name, mime, bytes);
}

// ---- JS fallback (only used when the host bridge is unavailable) -----------

const TEXT_PREFIXES = ["text/", "application/json", "application/xml", "application/javascript"];
const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  // `.tiff` / `.tif` files
  "image/tiff",
  "image/tif",
]);
const AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/ogg",
  "audio/aac",
  "audio/flac",
  "audio/webm",
  "audio/x-m4a",
  // NOTE: `audio/mp4` is NOT a standard IANA MIME type; `.m4a` is `audio/x-m4a`.
  // Adding it here is harmless (files declared with it render as audio) but non-standard.
]);
const VIDEO_MIMES = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/x-msvideo", // `.avi`
]);

export function mimeFromName(name: string): string | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || dot === lower.length - 1) return null;
  const ext = lower.slice(dot + 1);
  switch (ext) {
    case "txt":
    case "md":
    case "log":
    case "csv":
    case "tsv":
      return "text/plain";
    case "json":
      return "application/json";
    case "xml":
      return "application/xml";
    case "js":
    case "mjs":
    case "cjs":
    case "ts":
      return "application/javascript";
    case "html":
    case "htm":
      return "text/html";
    case "css":
      return "text/css";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "tiff":
    case "tif":
      return "image/tiff";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "m4a":
      return "audio/x-m4a";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "avi":
      return "video/x-msvideo";
    default:
      return null;
  }
}

/**
 * Lightweight UTF-8 sanity check for the JS fallback path.
 *
 * Sniffs the first `maxBytes` (default 4096) for NUL bytes; if none, returns
 * the **full** decoded text. The full decode happens because the fallback
 * path is only used in tests / browser preview — the Rust command is the
 * production path and it caps appropriately. The NUL sniff is the only
 * memory-bound guard; callers should not rely on this for large inputs.
 */
export function decodeTextSafely(
  bytes: Uint8Array,
  maxBytes = 4096,
): { ok: boolean; text: string; lossy: boolean } {
  if (bytes.length === 0) return { ok: true, text: "", lossy: false };
  const sniffLen = Math.min(bytes.length, maxBytes);
  for (let i = 0; i < sniffLen; i++) {
    if (bytes[i] === 0) return { ok: false, text: "", lossy: false };
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const text = decoder.decode(bytes);
    return { ok: true, text, lossy: text.includes("\uFFFD") };
  } catch {
    return { ok: false, text: "", lossy: false };
  }
}

function planPreviewLocal(name: string, mime: string | null, bytes: Uint8Array): PreviewPlan | null {
  if (bytes.length === 0) {
    return { kind: "empty", src: "", bytes: 0, isText: true, error: null, sizeLabel: "0 B", mime };
  }
  const m = mime ?? mimeFromName(name);
  if (m && IMAGE_MIMES.has(m)) {
    return { kind: "image", src: bytesToDataUrl(bytes, m), bytes: bytes.length, isText: false, error: null, sizeLabel: previewBytesLabel(bytes.length), mime: m };
  }
  if (m && AUDIO_MIMES.has(m)) {
    return { kind: "audio", src: bytesToDataUrl(bytes, m), bytes: bytes.length, isText: false, error: null, sizeLabel: previewBytesLabel(bytes.length), mime: m };
  }
  if (m && VIDEO_MIMES.has(m)) {
    return { kind: "video", src: bytesToDataUrl(bytes, m), bytes: bytes.length, isText: false, error: null, sizeLabel: previewBytesLabel(bytes.length), mime: m };
  }
  const looksText = m ? m.startsWith("text/") || TEXT_PREFIXES.some((p) => m === p) : decodeTextSafely(bytes).ok;
  // Only decode as text when the MIME is text-like OR absent (let the sniffer decide).
  // Use explicit parens — `&&` binds tighter than `||` so the bug avoided here is
  // `(A && B && C) || (D && E)` being misread as `A && B && C || D && E`.
  if (looksText && (!m || m.startsWith("text/") || TEXT_PREFIXES.some((p) => m === p))) {
    const dec = decodeTextSafely(bytes);
    if (dec.ok) {
      return { kind: "text", src: dec.text, bytes: bytes.length, isText: true, error: null, sizeLabel: previewBytesLabel(bytes.length), mime: m ?? "text/plain" };
    }
  }
  return { kind: "binary", src: "", bytes: bytes.length, isText: false, error: null, sizeLabel: previewBytesLabel(bytes.length), mime: m };
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return `data:${mime};base64,${btoa(bin)}`;
}

export function previewBytesLabel(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  // Prefer integer form for exact boundaries ("1 KB"); fall back to one decimal
  // for fractional values below 100 ("1.5 KB"); round large numbers to avoid
  // trailing decimals ("256 KB").  This mirrors the Rust `size_label` function.
  const s =
    Number.isInteger(v)
      ? String(v)
      : v >= 100
      ? String(Math.round(v))
      : v.toFixed(1);
  return `${s} ${units[u]}`;
}
