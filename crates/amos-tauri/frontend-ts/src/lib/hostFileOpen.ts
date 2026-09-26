/**
 * hostFileOpen.ts — "the user opened a file in the host-filesystem browser" as one decision.
 *
 * `FilesApp.svelte`'s host browser sent **every** entry through `hostFsReadText`. That is a
 * *text* reader and it says so: `host_fs_read_text` refuses any payload that is not valid
 * UTF-8 (`amos.host_fs.read_not_utf8`), and the view translates that refusal into a sentence
 * about the file. So tapping a photo, a PDF, an MP3 or an archive in the only filesystem a
 * user can actually browse produced 「不是合法的 UTF-8」 — the app's reading strategy
 * presented as a property of the file. Meanwhile the app already owned the right reader
 * (`hostFsReadBytes` — with its own Rust base64 round-trip test) and the right renderer
 * (`filesPreview.ts::planPreview` → `files_preview_bytes` → the preview panel's `<img>` /
 * `<audio>` / `<video>` branches), with nothing between them (REQ-A971 / F-SH-307).
 *
 * This module is that wire. Two decisions in it are deliberate:
 *
 * 1. **The routing is the host's verdict on the bytes, not a guess from the name.** Text is
 *    tried first and the fallback fires only on a *stated* `read_not_utf8`. A name-first rule
 *    ("`.png` ⇒ bytes") would render a text file that happens to be named `.png` as a broken
 *    image; the refusal-based rule opens it as text, which is what it is. The price is one
 *    capped read of a file the host then refuses, and the gain is that no second MIME table
 *    has to stay in agreement with `files.rs`.
 *
 * 2. **`planPreview` is called with a `null` MIME on purpose.** The extension table that
 *    classifies the file must be the host's (`files.rs::mime_from_ext`) — it is the one the
 *    preview command actually runs, and the TypeScript twin (`mimeFromName`) is a separate
 *    hand-maintained table that nothing binds to it. This only works because
 *    `preview_core`/`files_preview_bytes` now reads a blank MIME (what `backend.ts` sends for
 *    `null`) as *absent* rather than as a MIME type called "". Replacing the `null` below with
 *    `mimeFromName(name)` would paper over that again and re-create the drift (REQ-A971).
 *
 * The three outcomes are kept apart rather than folded into one "it didn't open" for the
 * reason `filesPreview.ts` gives for its own refusals: *read*, *refused*, and *could not be
 * read* are three different facts, and the view already owns a sentence for each.
 */

import { base64ToBytes, hostFsReadBytes, hostFsReadText } from "./hostFs";
import { planPreview, previewUnavailablePlan, type PreviewPlan } from "./filesPreview";

/**
 * The one refusal that licenses the bytes reader, spelled once.
 *
 * Deliberately **not** exported. An exported constant would be referenced only by this module
 * and its test, which is the shape `unwired-scan` (rightly) reports as a dead export; and the
 * risk it would guard against — the literal drifting away from the host's vocabulary — is
 * covered from the other side instead: `hostFileOpen.test.ts` sweeps **every** code in
 * `HOST_FS_CODES` and asserts that exactly one of them licenses the fallback. That binds both
 * directions (the right code kept, no second code gained) without a test-only export.
 */
const READ_NOT_UTF8 = "amos.host_fs.read_not_utf8";

export type HostOpenOutcome =
  /** The file is text: the caller shows it in the `<pre>` it already has. */
  | { kind: "text"; path: string; body: string; truncated: boolean }
  /**
   * The file is not text: the caller routes `plan` to the preview panel.
   *
   * `sourceTruncated` is the **host read**'s truncation flag (the file was larger than the
   * read cap), which is a different fact from the notice `plan.error` carries (the preview
   * command's own cap). Structured rather than appended to `plan.error` because that field
   * holds host-authored sentences and this one has to be translated by the view.
   */
  | { kind: "preview"; plan: PreviewPlan; sourceTruncated: boolean }
  /** The host refused the read. `code`/`isOffline` go to the view's own error mapping. */
  | { kind: "error"; code: string; isOffline: boolean };

/**
 * Open `path` (displayed as `name`): text when the host says so, a preview plan when it
 * does not, a typed error when the read itself failed.
 */
export async function openHostFile(name: string, path: string): Promise<HostOpenOutcome> {
  const text = await hostFsReadText(path);
  if (text.ok) {
    return {
      kind: "text",
      path: text.value.path,
      body: text.value.body,
      truncated: text.value.truncated,
    };
  }
  // **Only** `read_not_utf8` means "this needs the bytes reader". Every other refusal — a
  // missing file, an escape, a too-large file, no host at all — is a real failure and must
  // reach the view as one; falling back here for all of them would swallow the distinction
  // this repo has had to re-learn in `print.ts`, `playerApp` and F-SH-281.
  if (text.code !== READ_NOT_UTF8) {
    return { kind: "error", code: text.code, isOffline: text.isOffline === true };
  }

  const raw = await hostFsReadBytes(path);
  if (!raw.ok) {
    return { kind: "error", code: raw.code, isOffline: raw.isOffline === true };
  }
  const bytes = base64ToBytes(raw.value.body);
  if (bytes === null) {
    // The host *answered*, and its answer is not base64. That is a wire violation rather
    // than a refusal — the F-SH-281 distinction — and naming it as a refusal would blame
    // the file for the transport.
    return { kind: "preview", plan: previewUnavailablePlan(null, "unreadable"), sourceTruncated: false };
  }
  const plan = await planPreview(name, null, bytes);
  return {
    kind: "preview",
    // `planPreview` returns `null` only for `bytes === null`, which cannot happen here;
    // treating a `null` as "unreadable" keeps that assumption from becoming a crash if the
    // module's contract ever widens.
    plan: plan ?? previewUnavailablePlan(null, "unreadable"),
    sourceTruncated: raw.value.truncated,
  };
}
