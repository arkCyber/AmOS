/**
 * screenRecord.ts — the shell's system-screen-recording front door (REQ-A1580).
 *
 * The host side is `crates/amos-tauri/src/screen_record.rs`: four registered commands
 * (`screen_record_start` / `_stop` / `_status` / `_capability`) that record the whole
 * screen to a real `.mov` under `~/Movies`. Until this module existed
 * **nothing on any screen called them** — `tauri-command-scan` reported all four as
 * "registered but no screen calls it", i.e. the host could record and there was no way
 * for a user to ask it to. This is that way, and it is the same seam `lib/screenshot.ts`
 * is for the still capture.
 *
 * Three facts a caller must not flatten, because the host distinguishes them:
 *
 *   * {@link screenRecordCapability} is the **only** thing that may say recording is
 *     impossible here — it is a runtime fact (`available` + the host's own `reason`), not
 *     a compile-time constant the UI is allowed to re-derive. `null` means the host did
 *     **not answer** (no bridge, or the command failed), which is *not* "unavailable".
 *   * {@link screenRecordStatus} answers `null` for "the host did not answer", never for
 *     "idle". A missing answer folded into `idle` would draw a stopped recorder over a
 *     session that is still running — see {@link recordingPhase}, which keeps the three
 *     read states (`unknown` / `idle` / `recording`) distinct for exactly that reason.
 *   * `stop` **seals** the file: the host signals the tool, waits, and checks the file
 *     landed non-empty. A refused stop resolves `null` and the session is untouched.
 *
 * `start` / `stop` are **foreground-gated by the host** (`require_screen_record_foreground`
 * → `clipboard::require_foreground`): only the window the user is looking at may begin or
 * end a capture of the whole screen, so a call from a background window resolves `null`
 * with code `amos.screenrecord.foreground_required` on the diagnostic ledger. That is a
 * real refusal, not a bug, and a surface must report it rather than pretend it worked.
 *
 * Kept DOM-free so the pure classifier/formatter are unit-testable headlessly; the typed
 * payloads come straight from `./backend` (already deserialized by Tauri), so there is no
 * second parser.
 */
import { invoke } from "./backend";
import { formatDuration } from "./recordings";

/** `screen_record::ScreenRecordCapability` — the honest answer to "can this build record?". */
export type ScreenRecordCapability = {
  /** A recording can be started *right now* on this build. */
  available: boolean;
  /** Why `available` is false, in the host's own words ("" when available). */
  reason: string;
};

/** `screen_record::ScreenRecordStatus` — the host's answer about the current session. */
export type ScreenRecordStatus = {
  /** A recording child is running and writing frames. */
  recording: boolean;
  /** A stop is in flight: the file is being sealed. */
  stopping: boolean;
  /** When the session started (ms since the Unix epoch); `0` when no session has begun.
   *  A `screen_record_stop` answer carries the finished session's start instant. */
  started_ms: number;
  /** Whole seconds since `started_ms`; `0` when no session has begun (and when a finished
   *  session reported no start instant — `0` is the wire's "not known", never `now`). */
  elapsed_secs: number;
  /** The session's duration ceiling (seconds); `0` when no session has begun, and for a
   *  `screen_record_stop` answer, whose session has already ended. */
  max_secs: number;
  /** The file being written — or, in a `screen_record_stop` answer, the file it wrote. */
  out: string | null;
};

/** Whether this build can record the screen, and if not, why. `null` = the host did not answer. */
export async function screenRecordCapability(): Promise<ScreenRecordCapability | null> {
  return invoke<ScreenRecordCapability>("screen_record_capability");
}

/** The current session (live, sealing or idle). `null` = the host did not answer. */
export async function screenRecordStatus(): Promise<ScreenRecordStatus | null> {
  return invoke<ScreenRecordStatus>("screen_record_status");
}

/**
 * Begin a recording. `maxSecs` is a *request* the host **checks, not shortens**: a value
 * outside its `[MIN_RECORD_SECS, MAX_RECORD_SECS]` bounds is refused with
 * `amos.screenrecord.duration_out_of_range` rather than clamped, so a caller that asked
 * for an hour never receives a 30-minute file it would read as complete. Omit it for the
 * host's own ceiling. `display` is the optional index on a multi-display host.
 * `null` = refused (a bound out of range, unsupported platform, a second start while one
 * is running, or a background caller — see the module doc).
 */
export async function screenRecordStart(opts?: {
  maxSecs?: number;
  display?: number;
}): Promise<ScreenRecordStatus | null> {
  const args: Record<string, unknown> = {};
  // Only send a bound the caller actually set: `undefined` and `0` are different
  // requests (the host's `resolve_max_secs` reads a missing bound as "use the default"
  // and a zero as an out-of-range request to refuse), so an absent option must not
  // travel as a zero.
  if (opts?.maxSecs !== undefined) args.maxSecs = opts.maxSecs;
  if (opts?.display !== undefined) args.display = opts.display;
  return invoke<ScreenRecordStatus>("screen_record_start", args);
}

/** Signal the running recording to seal, and answer the sealed file. `null` = refused / none running. */
export async function screenRecordStop(): Promise<ScreenRecordStatus | null> {
  return invoke<ScreenRecordStatus>("screen_record_stop");
}

// ─── Pure reading (DOM-free, unit-tested) ─────────────────────────────────────────────────

/**
 * The three states a status read can be in, **all distinct**.
 *
 * `"unknown"` is `null` — the host did not answer. It is not `"idle"`: a UI that drew
 * "not recording" from a missing answer would contradict the host if a session were in
 * fact running (REQ-A1580; the `capability-fact-vs-observation-fact` family). `"stopping"`
 * is the short window where `stop` has been sent and the file is being sealed — worth its
 * own word so the control can say "finishing…" instead of lying in either direction.
 */
export type RecordingPhase = "unknown" | "idle" | "recording" | "stopping";

/** Classify a status read for a surface, keeping "the host did not answer" separate from "idle". */
export function recordingPhase(status: ScreenRecordStatus | null): RecordingPhase {
  if (status === null) return "unknown";
  if (status.recording) return "recording";
  if (status.stopping) return "stopping";
  return "idle";
}

/**
 * The elapsed-clock text for a session, or `""` when there is no live clock to draw.
 *
 * Only a live or sealing session has a meaningful elapsed time; an idle read (or no read
 * at all) yields `""` so a surface renders its idle label rather than a `0:00` that would
 * read as a just-started recording.
 */
export function recordingClock(status: ScreenRecordStatus | null): string {
  const phase = recordingPhase(status);
  if (phase !== "recording" && phase !== "stopping") return "";
  return formatDuration(status?.elapsed_secs ?? 0);
}

/**
 * The i18n key for a phase's label. Every phase maps to a sentence a surface can show; the
 * keys live under `cc.record.*` so the Control Center and any sibling surface stay in step.
 */
export function recordingLabelKey(phase: RecordingPhase): string {
  switch (phase) {
    case "recording":
      return "cc.record.recording";
    case "stopping":
      return "cc.record.stopping";
    case "idle":
      return "cc.record.idle";
    case "unknown":
      return "cc.record.unknown";
  }
}
