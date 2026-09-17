/**
 * mediaExport.ts — the **write** half of the media domain, wired to a screen.
 *
 * `lib/media.ts` has been able to *read* the user's real collections for a while, and
 * `media_save` existed for the other direction — but nothing ever called it (recorded in
 * `scripts/unwired-baseline.json` as `mediaSave` + `mediaGrantWrite`). This module is that
 * consumer: it copies **our own** capture (a photo or a recorded video) into the
 * user-visible `DCIM/Camera`, which is where a camera app's output belongs on Android and
 * the only way the system gallery (or any other app) can see it.
 *
 * Three deliberate properties:
 *
 * 1. **Explicit, never automatic.** Copying into the shared collection is a real side
 *    effect on the user's storage — it happens when they ask for it, not on every shutter.
 *    (The camera's *own* album is a separate, always-on store: `lib/photos.ts` /
 *    `lib/cameraCapture.ts`.)
 * 2. **The claim follows the write.** Four outcomes are distinguished
 *    ([`ExportOutcome`]) and the caller renders each one; a bridge that answered `null`
 *    (no host) or rejected (unauthorized, ceiling, …) is **never** reported as saved.
 * 3. **Nothing is sent that we cannot name.** The file name is derived from the capture's
 *    timestamp (so exports sort chronologically and never collide within a second) and the
 *    MIME's extension — the domain's own collections are keyed by (name, kind), and the
 *    Photos/player screens classify by extension.
 */

import { amosWarn } from "./debugLog";
import { mediaGrantWrite, mediaSave } from "./media";
import type { MediaKind, StandardDir } from "./media";

/** Where a camera capture belongs in the user-visible layout (`DCIM/Camera`). */
export const CAMERA_EXPORT_DIR: StandardDir = "camera";

/** Where a voice memo belongs in the user-visible layout (`Recordings`). */
export const RECORDING_EXPORT_DIR: StandardDir = "recordings";

/** How an export ended. Every value is a *different* thing to tell the user. */
export type ExportOutcome =
  /** The host confirmed the write. */
  | "saved"
  /** No Tauri bridge: this surface cannot reach the user's storage at all. */
  | "offline"
  /** The host refused it — unauthorized, above the save ceiling, backend error. */
  | "refused"
  /** We refused to send it: there were no bytes to write. */
  | "invalid";

/** MIME → file extension for the kinds we export (anything else → `bin`). */
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  // Voice memos (REQ-A313): a recording exported as `.bin` is a file the user
  // cannot find, play or hand to another app, so the audio MIMEs a recorder can
  // produce are mapped explicitly.
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/opus": "opus",
  "audio/flac": "flac",
  "audio/amr": "amr",
};

/**
 * Deterministic export name: `Amos-YYYYMMDD-HHMMSS.<ext>`.
 *
 * Total for any input (a non-finite/unusable timestamp becomes the epoch, an unknown MIME
 * becomes `.bin`), so a capture can always be named — a nameless save is a save the user
 * cannot find.
 */
export function exportNameFor(ts: number, mime: string | null | undefined): string {
  const d = new Date(Number.isFinite(ts) ? ts : 0);
  const p = (n: number) => String(n).padStart(2, "0");
  // An invalid date (never produced by `Date.now()`) still yields digits, not "NaN".
  const safe = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);
  const stamp =
    `${safe(d.getFullYear(), 1970)}${p(safe(d.getMonth(), 0) + 1)}${p(safe(d.getDate(), 1))}` +
    `-${p(safe(d.getHours(), 0))}${p(safe(d.getMinutes(), 0))}${p(safe(d.getSeconds(), 0))}`;
  const essence = (mime ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  return `Amos-${stamp}.${EXT_BY_MIME[essence] ?? "bin"}`;
}

/**
 * Decode a `data:` URL's base64 payload into bytes.
 *
 * The camera keeps its own album as data URLs (`lib/photos.ts`), so exporting a photo means
 * going through here. `null` — not a fabricated buffer — when the string is not a base64
 * data URL or its payload is corrupt: an export of guessed bytes would write a broken file
 * into the user's gallery.
 */
export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const match = /^data:[^;,]*;base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  try {
    const binary = atob(match[1] ?? "");
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null; // a corrupt payload is "no bytes"
  }
}

/**
 * Read a Blob into bytes, or `null` when it cannot be read.
 *
 * Used to hand a recorded voice memo (an IndexedDB Blob, `lib/mediaStore.ts`) to
 * [`exportToSharedCollection`]. A failed read is `null` — "no bytes" — never a
 * zero-length buffer: writing an empty file into the user's storage would claim a
 * recording that is not there.
 */
export async function blobBytes(blob: Blob): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null; // the Blob seam failed: hand the caller "no bytes"
  }
}

/**
 * Copy `bytes` into the user's shared collection as `name`.
 *
 * Order matters: the **write grant is declared first** (the host's policy mirror of
 * Android's runtime permission — the device-side consent is the Kotlin glue's business),
 * then the bytes go over. A refusal from either step is reported as such, and the host's own
 * reason is logged (it is English and may name a host path; the user gets a localized line).
 */
export async function exportToSharedCollection(
  kind: MediaKind,
  name: string,
  bytes: Uint8Array,
  dir: StandardDir = CAMERA_EXPORT_DIR,
): Promise<ExportOutcome> {
  if (bytes.length === 0 || name === "") return "invalid";
  try {
    await mediaGrantWrite(dir);
    const saved = await mediaSave(dir, kind, name, bytes);
    // `mediaSave` resolves `null` **only** when there is no bridge (see `lib/media.ts`);
    // with a host present a failure *rejects*, so this cannot mask a refusal as a success.
    return saved ? "saved" : "offline";
  } catch (e) {
    amosWarn("media", "export to the shared collection was refused", { dir, name, error: String(e) });
    return "refused";
  }
}
