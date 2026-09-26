/**
 * webmanDownloads.ts — the WebMan browser's **real** download pipeline bridge.
 *
 * ## Why this module exists
 *
 * Before it, "download" in WebMan was a UI fiction: the panel registered a row
 * and a `setTimeout` walked its progress bar to 25%. Nothing was fetched. The
 * Rust core now owns a real pipeline (`crates/amos-tauri/src/webman_download.rs`):
 * a streaming HTTP GET to a real file on disk, a persistent RFC 6265 cookie jar,
 * progress events and cancellation. This module is the typed WebView side of
 * that wire — `webman_download_start` / `_cancel`, `webman_cookies_list` /
 * `_clear`, and the [`DOWNLOAD_PROGRESS_EVENT`] subscription.
 *
 * ## Honest boundary
 *
 * The pipeline downloads a **URL you hand it**. It does not yet intercept a
 * download started by a link *inside* the `<iframe>` — that is still the host
 * WebView's, and closing it is the child-webview work, not something this
 * module can fake. Likewise the jar here is the pipeline's; cookies a page sets
 * live in the WebView's own store, not this one.
 *
 * ## Events
 *
 * The host emits one [`DownloadProgressEvent`] per notable step (throttled to
 * ~10/s) plus a terminal one whose `status` is `completed` / `failed` /
 * `canceled`. Payloads cross a process boundary, so [`asProgressEvent`]
 * validates before the UI trusts them — same posture as every other bridge.
 */

import { invoke, subscribe } from "./backend";

/** Tauri channel the host emits download progress on (mirrors `EVENT_PROGRESS`). */
export const DOWNLOAD_PROGRESS_EVENT = "webman-download-progress";

/** Returned by `webman_download_start` before the transfer finishes. */
export interface DownloadStarted {
  id: string;
  url: string;
  filename: string;
  /**
   * Where the transfer is landing. Desktop / non-Android: an absolute file path.
   * Android: the MediaStore `content://` URI (or the app-private staging path
   * while a `MediaStoreSink` file is still being adopted).
   */
  location: string;
}

/** One progress / terminal event. Mirrors the Rust struct's camelCase serde. */
export interface DownloadProgressEvent {
  id: string;
  url: string;
  filename: string;
  /** Same meaning as [`DownloadStarted::location`]. */
  location: string;
  received: number;
  /** `null` when the server sent no `Content-Length` (chunked body). */
  total: number | null;
  status: DownloadStatus;
  /** Present only when `status === "failed"`. */
  error: string | null;
}

/** One cookie in the jar. */
export interface CookieRecord {
  name: string;
  value: string;
  /** Empty for a host-only cookie. */
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
}

/**
 * Mirrors `DownloadStatus` in `webman_download.rs` (serde `lowercase`). The array is the
 * one declaration; {@link DownloadStatus} derives from it.
 */
export const STATUSES = [
  "pending",
  "downloading",
  "completed",
  "failed",
  "canceled",
] as const;
export type DownloadStatus = (typeof STATUSES)[number];

/**
 * Start a real download. `id` is optional: pass the row id the UI already
 * stored and the host will emit progress under that same id, so the store row
 * and the transfer line up. Resolves `null` off-bridge or on refusal (a
 * non-http(s) URL is refused host-side).
 */
export async function startDownload(
  url: string,
  filename?: string,
  id?: string,
): Promise<DownloadStarted | null> {
  return invoke<DownloadStarted>("webman_download_start", {
    url,
    filename: filename ?? null,
    id: id ?? null,
  });
}

/**
 * Ask the host to stop a transfer. `true` when it took the cancel, `false` when it has
 * no such transfer (the id is unknown / already finished), and `null` when the host did
 * not answer.
 *
 * REQ-A1343 / F-SH-608: this used to be `… ?? false`. The Rust command answers `false`
 * for an id it does not hold (`webman_download_cancel`; the cancel flag only exists for
 * the life of the transfer — inserted in `begin`, `take_cancel`ed when the job ends), so
 * `false` is a **fact**: that transfer is not running. But `invoke` resolves `null` both
 * for "the command failed" and for "there is no bridge" (see {@link listCookies}), and
 * `?? false` folded that third fact — **we could not ask** — into the same value. The
 * component's entire reading of `false` (paint the row failed, offer 重试; or drop the
 * row) is a claim about the host, and it was being made without an answer.
 */
export async function cancelDownload(id: string): Promise<boolean | null> {
  return invoke<boolean>("webman_download_cancel", { id });
}

/**
 * The jar's live cookies (host-only cookies carry an empty `domain`), or `null`
 * when the host did not answer.
 *
 * REQ-A1318 / F-SH-591: this used to be `… ?? []`. `invoke` resolves `null` for
 * "no host / the call failed" and never rejects, so the `?? []` folded **two
 * different facts** into one value: a jar that is genuinely empty, and a bridge
 * that never replied. The site-data panel renders `[]` as 「没有站点数据」 — a
 * claim about the jar — so an unbridged / broken host told the user their
 * cookies were gone. It is the same shape as REQ-A1193's `null` sentinel. The
 * Rust command returns `Vec<CookieRecord>` and cannot answer `null`, so `null`
 * here is unambiguous: **we could not ask**.
 */
export async function listCookies(): Promise<CookieRecord[] | null> {
  return invoke<CookieRecord[]>("webman_cookies_list");
}

/**
 * Empty the jar; resolves how many live cookies were dropped, or `null` when the
 * host did not answer (see {@link listCookies} for why `0` is not a substitute —
 * 「清掉了 0 条」 and 「没能清」 are different sentences).
 */
export async function clearCookies(): Promise<number | null> {
  return invoke<number>("webman_cookies_clear");
}

/**
 * Subscribe to progress events; resolves an unsubscribe, or `null` when the subscription was
 * not established (REQ-A838). A transfer whose progress bar is frozen is not the same as one
 * that is not progressing, and only the `null` distinguishes them.
 */
export async function onDownloadProgress(
  handler: (event: DownloadProgressEvent) => void,
): Promise<(() => void) | null> {
  return subscribe(DOWNLOAD_PROGRESS_EVENT, (payload) => {
    const event = asProgressEvent(payload);
    if (event) handler(event);
  });
}

/**
 * Narrow an untrusted event payload to a [`DownloadProgressEvent`], or `null`.
 *
 * The payload crossed a process boundary, so every field is checked before the
 * UI reads it: a malformed `status` would otherwise reach the store and become a
 * row that vanishes on the next load (the same class of bug `updateDownload`'s
 * validation exists to stop).
 */
export function asProgressEvent(payload: unknown): DownloadProgressEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.id !== "string" || p.id === "") return null;
  if (typeof p.url !== "string" || typeof p.filename !== "string") return null;
  if (typeof p.location !== "string") return null;
  if (typeof p.status !== "string" || !STATUSES.includes(p.status as DownloadStatus)) return null;

  const received = finiteOrNull(p.received);
  if (received === null || received < 0) return null;
  const total = p.total === null || p.total === undefined ? null : finiteOrNull(p.total);
  if (total !== null && total < 0) return null;

  return {
    id: p.id,
    url: p.url,
    filename: p.filename,
    location: p.location,
    received,
    total,
    status: p.status as DownloadStatus,
    error: typeof p.error === "string" ? p.error : null,
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
