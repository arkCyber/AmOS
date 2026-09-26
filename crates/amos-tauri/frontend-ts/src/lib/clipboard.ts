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
 *
 * REQ-A559: the event side is an **opt-in**. `onClipboardChanged` registers the listener and
 * then calls `clipboard_subscribe`, which is what moves the host off its unbounded global
 * `emit` and onto the rate-limited per-window `emit_to` (F-CLB-002). Until a window opts in,
 * the throttle the host documents is not actually applied to anyone.
 */
import { invoke, subscribe } from "./backend";
import { amosWarn } from "./debugLog";

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

/**
 * Copy `text` to the **webview's own** clipboard (`navigator.clipboard`) and report whether it
 * landed — the question `clipboardWrite` above answers for the host clipboard, asked of the API
 * the plain-`text` share paths use.
 *
 * The guard is the whole point. `navigator.clipboard?.writeText(text)` **short-circuits to
 * `undefined`** when `navigator.clipboard` is absent — the case `PhotosApp` names as "the normal
 * case in a WebView without a secure context" — so no exception is raised, no rejection is
 * delivered, and a `try/catch` wrapped around the optional call can never fire for it. Three
 * call sites wrote `try { await navigator.clipboard?.writeText(x); claimSuccess(); } catch {}`
 * and so reported 「✓」 (or a success line) while nothing at all was on the clipboard. Reading
 * the API's presence first is what makes the answer mean something.
 *
 * `false` means nothing was copied and the caller must say so: the claim follows the effect
 * (REQ-A352 / REQ-A355). Distinct from [`clipboardWrite`], which writes the shell's shared
 * clipboard; this is the webview fallback those same screens use for text.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // unavailable, blocked (insecure context), or denied
  }
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
 * Opt **this window** in to `clipboard-changed` notices (REQ-A559).
 *
 * The host's event bus has two delivery modes (see `clipboard.rs::broadcast_changed`): with no
 * subscriber it falls back to a global `emit` to **every** window, and the per-window throttle
 * that bounds a flood (F-CLB-002) is not in force; once a window opts in, delivery becomes
 * `emit_to` for subscribers only, rate-limited to `CLIPBOARD_EVENTS_PER_SEC`. This command was
 * declared on the host but never registered — so no window could opt in and the bounded path was
 * unreachable. The window label is injected by Tauri (never an argument), and the call is
 * idempotent; the returned id identifies the subscription for the process lifetime.
 */
export function clipboardSubscribe(): Promise<number | null> {
  return invoke<number>("clipboard_subscribe");
}

/**
 * Subscribe to new clipboard writes. The handler receives a metadata-only
 * [ClipboardNotice] (never the content); to actually read an entry call
 * `clipboardRead(notice.seq)` — that is foreground-gated on the Rust side.
 *
 * REQ-A559: listens **first**, then opts in with [`clipboardSubscribe`]. That order leaves no
 * gap — before the opt-in the host's global `emit` still reaches this window, after it the
 * per-window `emit_to` does — and it is what puts the F-CLB-002 throttle in force for the shell.
 *
 * REQ-A838: but the order only leaves no gap **if the listen was established**, and the opt-in
 * must therefore not happen without it. Opting in moves the host *off* the global broadcast that
 * currently reaches this window and onto `emit_to`-for-subscribers-only; if our own listener was
 * refused, that turns a working delivery path into a silent one — no clipboard notice ever
 * arrives, and the window looks exactly as subscribed as a quiet one. So a refused listen means
 * *no* opt-in, and the caller gets `null` rather than a no-op unsubscribe that appears to work.
 */
export async function onClipboardChanged(
  onNotice: (notice: ClipboardNotice) => void,
): Promise<(() => void) | null> {
  const un = await subscribe("clipboard-changed", (payload) =>
    onNotice(payload as ClipboardNotice),
  );
  // Nothing is listening: leave the host on the global path, which still reaches us.
  if (un === null) {
    amosWarn(
      "clipboard",
      "clipboard-changed was not subscribed, so this window stays on the global broadcast " +
        "path (the per-window opt-in was skipped)",
    );
    return null;
  }
  await clipboardSubscribe();
  return un;
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
