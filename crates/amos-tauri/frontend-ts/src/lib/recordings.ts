/**
 * recordings.ts — the typed seam for the call-recording ledger
 * (`crates/amos-tauri/src/recording.rs`, REQ-A1334 / REQ-A1579).
 *
 * Both halves are wired on Android now: the **ledger** is a real list / delete over
 * `<app_data>/recordings.json`, and the **capture** runs a real `MediaRecorder` in the in-call
 * service (`AmosInCallService.setRecording` → `crate::incall`, REQ-A1579). Three consequences a
 * caller must not flatten:
 *
 *   - {@link recordingsList} answers `[]` for "no recordings" and `null` for "the read failed".
 *     An empty list is the *normal first state*, not an error, exactly as the Rust side promises.
 *   - {@link recordingDelete} answers the **surviving ledger**, not a bare success flag. A refused
 *     delete resolves `null`; a successful one resolves the list the row is gone from. The two can
 *     never be confused, which is why the command does not return `()` (a `Result<(), _>`
 *     serializes its *success* as `null` too).
 *   - {@link recordingsCaptureStatus} is the **only** thing that may say capture is unavailable, and
 *     it now answers from runtime facts (Android build / bound default dialer / granted
 *     `RECORD_AUDIO`), not a compile-time constant. A surface must never infer "you cannot record"
 *     from an empty list — "no recordings" and "recording is impossible here and now" are
 *     different facts.
 *
 * Keep DOM-free so the pure formatters are unit-testable headlessly; the typed payloads come
 * straight from `./backend` (already deserialized by Tauri), so there is no second parser.
 */
import { invoke } from "./backend";

/**
 * One ledger row. Field names are the wire's `snake_case`, not camelCase: Tauri serializes a
 * Rust struct's fields as written, so this type mirrors `recording::RecordingMeta` exactly.
 */
export type RecordingMeta = {
  call_id: string;
  peer: string;
  /** Unix seconds when the call began. */
  started_at: number;
  duration_sec: number;
  file_size_bytes: number;
  /**
   * The audio source the recorder actually used: `"voice_call"` (two-sided — needs the privileged
   * `CAPTURE_AUDIO_OUTPUT`, so only a platform-signed build) or `"voice_communication"` (near end
   * only — this device's microphone). Absent on rows written before REQ-A1579.
   */
  source?: string;
};

/** `recording::RecordingCaptureStatus` — the honest answer to "can this build record at all?". */
export type RecordingCaptureStatus = {
  available: boolean;
  /** Why `available` is false, in the host's own words ("" when available). */
  reason: string;
};

/** The ledger (metadata only). `null` = the read failed; `[]` = no recordings yet. */
export async function recordingsList(): Promise<RecordingMeta[] | null> {
  return invoke<RecordingMeta[]>("recordings_list");
}

/**
 * Delete one recording. `null` = the delete was refused (a bad id, or a failed write); otherwise
 * the surviving ledger, so a caller repaints from the host's post-state rather than its own guess.
 */
export async function recordingDelete(callId: string): Promise<RecordingMeta[] | null> {
  return invoke<RecordingMeta[]>("recording_delete", { callId });
}

/** Whether this build can capture call audio, and if not, why. `null` = the host did not answer. */
export async function recordingsCaptureStatus(): Promise<RecordingCaptureStatus | null> {
  return invoke<RecordingCaptureStatus>("recordings_capture_status");
}

// ─── Pure formatting (DOM-free, unit-tested) ─────────────────────────────────────────────

/** `mm:ss`, or `h:mm:ss` past an hour. Negative / non-finite → `"0:00"` (never a bogus time). */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** A compact byte count (`512 B` / `1.5 KB` / `2.0 MB`). Non-finite / negative → `"0 B"`. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.floor(n)} B`;
  const units = ["KB", "MB", "GB"] as const;
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * Newest first (by `started_at`), ties broken by `call_id` so the order is deterministic. The
 * ledger's stored order is write order, which is not a display order — a re-recorded call moves to
 * the end regardless of when it happened.
 */
export function sortRecordings(list: readonly RecordingMeta[]): RecordingMeta[] {
  return [...list].sort((a, b) => {
    if (b.started_at !== a.started_at) return b.started_at - a.started_at;
    return a.call_id < b.call_id ? -1 : a.call_id > b.call_id ? 1 : 0;
  });
}
