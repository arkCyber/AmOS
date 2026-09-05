/**
 * Global clipboard bridge: typed wrappers for the Tauri `clipboard_*` commands
 * (crates/amos-tauri/src/clipboard.rs) — a multi-format, OS-style system clipboard
 * shared across windows and the Android container.
 *
 * Copy is allowed from any window; paste/browse/clear is **foreground-only** on the
 * Rust side (the window manager must show the caller focused), so a background app
 * can never silently drain another window's clipboard.
 *
 * Reuses `backend.ts`'s bridge: outside Tauri every call degrades to `null`/`[]`
 * so a surface can show a "not connected" state instead of throwing.
 */
import { invoke, subscribe } from "./backend";

/** One copied representation. Wire shape mirrors `ClipboardPayload` (serde tag). */
export type ClipboardPayload =
  | { kind: "text"; text: string }
  | { kind: "html"; html: string; plain: string }
  | { kind: "image"; mime: string; data_b64: string }
  | { kind: "uris"; uris: string[]; text: string };

/** A single immutable snapshot of one copy op in the shared buffer. */
export interface ClipboardEntry {
  seq: number;
  source: string;
  owner: string;
  timestamp_ms: number;
  payload: ClipboardPayload;
}

/** Copy multi-format content into the system clipboard; returns the stored entry. */
export function clipboardWrite(
  payload: ClipboardPayload,
  source?: string,
): Promise<ClipboardEntry | null> {
  return invoke<ClipboardEntry>("clipboard_write", source ? { payload, source } : { payload });
}

/** Paste the newest entry (or a specific one by `seq`). Foreground-only. */
export function clipboardRead(seq?: number): Promise<ClipboardEntry | null> {
  return invoke<ClipboardEntry>("clipboard_read", seq === undefined ? {} : { seq });
}

/** Browse the clipboard history (newest first). Foreground-only. */
export function clipboardHistory(limit?: number): Promise<ClipboardEntry[] | null> {
  return invoke<ClipboardEntry[]>("clipboard_history", limit === undefined ? {} : { limit });
}

/** Clear the whole clipboard history; returns how many entries were removed. Foreground-only. */
export function clipboardClear(): Promise<number | null> {
  return invoke<number>("clipboard_clear");
}

/** Non-sensitive event notice broadcast on every write (full content is *not*
 * included, so a background window can't learn it by subscribing — interested
 * windows fetch the payload via the foreground-gated `clipboardRead(seq)`). */
export interface ClipboardNotice {
  seq: number;
  timestamp_ms: number;
  source: string;
}

/**
 * Subscribe to new clipboard writes. The handler receives a metadata-only
 * [ClipboardNotice] (never the content); to actually read an entry call
 * `clipboardRead(notice.seq)` — that is foreground-gated on the Rust side.
 */
export function onClipboardChanged(
  onNotice: (notice: ClipboardNotice) => void,
): Promise<() => void> {
  return subscribe("clipboard-changed", (payload) => onNotice(payload as ClipboardNotice));
}

// ---- Pure helpers (render/preview; never touch the bridge) ----

/** The plain-text rendering of an entry, or `""` for binary-only (image) payloads. */
export function entryText(e: ClipboardEntry): string {
  switch (e.payload.kind) {
    case "text":
      return e.payload.text;
    case "html":
      return e.payload.plain;
    case "uris":
      return e.payload.text || e.payload.uris.join("\n");
    case "image":
      return "";
  }
}

/** Short one-line preview for history pickers. */
export function previewClipboard(e: ClipboardEntry): string {
  if (e.payload.kind === "image") return `[image · ${e.payload.mime}]`;
  const t = entryText(e).replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : "[empty]";
}

/** Copy the current web document selection + clipboard text out via the bridge. */
export async function copySelection(text: string): Promise<boolean> {
  const e = await clipboardWrite({ kind: "text", text });
  return e !== null;
}
