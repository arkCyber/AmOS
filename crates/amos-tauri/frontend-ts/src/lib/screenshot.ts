/**
 * screenshot.ts — the shell's system-screenshot front door (REQ-A699).
 *
 * The host command `screenshot_capture` writes a real capture into
 * `~/Pictures/Screenshots` (the directory `lib/media.ts::canonicalPath("screenshots")`
 * resolves, so Photos shows it) and answers with the **absolute path** it wrote, or a
 * typed refusal.
 *
 * Two honest outcomes, no third: a path (a file exists) or `null` (the host refused —
 * an unsupported platform, no home directory, the tool absent, or the tool running and
 * leaving nothing behind). `null` is never turned into a fabricated path here; the menu
 * row that calls this reports the refusal through the diagnostic ledger instead.
 */
import { invoke } from "./backend";

/**
 * Keep a captured **absolute path**, or `null` for anything that is not one.
 *
 * The host answers a non-empty path string on success; a `null`/`undefined` (the bridge
 * swallowing a refusal), an empty string, or a non-string is "no capture" — the
 * conservative reading, so a refusal can never render as a screenshot that does not exist.
 */
export function normalizeCapturePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Capture the screen; resolves to the written file's absolute path, or `null` when the
 * host refused (see the module doc for the two outcomes).
 */
export async function screenshotCapture(): Promise<string | null> {
  const raw = await invoke<string | null>("screenshot_capture");
  return normalizeCapturePath(raw);
}
