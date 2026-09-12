/* Video capture + capture library (pure-ish seam over the Web platform).
 *
 * Photos store images as data-URLs in a text KV store; video bytes are too big
 * for that, so they live in the binary MediaStore (IndexedDB in the shell, an
 * in-memory fallback headless) under stable ids. The text KV store keeps only a
 * small metadata list (`amos.captures`) so the library is cheap to read. All of
 * the hard parts are injectable (MediaRecorder / a MediaStore), which keeps the
 * headless tests honest without driving real hardware. */

import { readStoreValue, writeStoreValueChecked } from "./amosStore";
import { defaultMediaStore, type MediaStore } from "./mediaStore";

export class RecordingUnavailableError extends Error {}

/** Metadata for one recorded video (bytes live in the MediaStore). */
export interface VideoCapture {
  id: string;
  ts: number;
  /** MediaRecorder mime (e.g. video/webm). */
  mime: string;
  /** Recorded length in ms. */
  durationMs: number;
  /** Favourite (heart) — shown in the Photos gallery. */
  fav?: boolean;
  /** Recorded pixel size (from the source video track), when known. */
  w?: number;
  h?: number;
}

/** A short, human label for a capture's pixel height (e.g. 480→SD, 720→HD…). */
export function resLabelOf(c: { w?: number; h?: number }): string | null {
  const h = c.h ?? 0;
  if (h <= 0) return null;
  if (h <= 480) return "SD";
  if (h <= 720) return "HD";
  if (h <= 1080) return "FHD";
  return `${h}p`;
}

export const CAPTURES_KEY = "amos.captures";
const MEDIA_PREFIX = "video-";

export function mediaId(captureId: string): string {
  return `${MEDIA_PREFIX}${captureId}`;
}

/** Toggle a capture's favourite flag and persist the metadata list. Returns whether
 *  the flag really landed — a rejected write leaves the stored row untouched, so the
 *  caller must not show a heart the library does not have. */
export function toggleCaptureFav(id: string): { ok: boolean; list: VideoCapture[] } {
  const next = normalizeCaptures(readStoreValue<unknown>(CAPTURES_KEY, [])).map((c) =>
    c.id === id ? { ...c, fav: !c.fav } : c,
  );
  return { ok: writeStoreValueChecked(CAPTURES_KEY, next), list: next };
}

/** Coerce any stored value into a valid `VideoCapture[]` (defensive). */
export function normalizeCaptures(raw: unknown): VideoCapture[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (x): x is VideoCapture =>
      !!x &&
      typeof x === "object" &&
      typeof (x as VideoCapture).id === "string" &&
      typeof (x as VideoCapture).mime === "string",
  );
}

export function listCaptures(): VideoCapture[] {
  return normalizeCaptures(readStoreValue<unknown>(CAPTURES_KEY, []));
}

/**
 * Persist a finished capture's metadata + move its bytes into the MediaStore.
 *
 * Returns whether the capture is **really in the library**: a video whose metadata
 * write was rejected (full/unavailable storage) would never be listed, so the bytes
 * are removed again (best effort) and the caller must not claim it was saved.
 */
export async function persistVideoCapture(
  meta: VideoCapture,
  blob: Blob,
  store: MediaStore = defaultMediaStore(),
): Promise<boolean> {
  await store.put(mediaId(meta.id), blob);
  const next = [
    meta,
    ...normalizeCaptures(readStoreValue<unknown>(CAPTURES_KEY, [])),
  ].slice(0, 100);
  if (writeStoreValueChecked(CAPTURES_KEY, next)) return true;
  // The library index could not be written, so the capture is invisible: don't leak
  // its bytes as an orphaned blob.
  try {
    await store.del(mediaId(meta.id));
  } catch {
    /* best-effort cleanup — the index is authoritative either way */
  }
  return false;
}

/** Remove a capture's metadata + bytes (library delete). Returns whether the row is
 *  really gone: the bytes are only deleted once the index no longer lists them, so a
 *  rejected write cannot leave a listed-but-unplayable video. */
export async function removeVideoCapture(
  id: string,
  store: MediaStore = defaultMediaStore(),
): Promise<boolean> {
  const next = normalizeCaptures(readStoreValue<unknown>(CAPTURES_KEY, [])).filter(
    (c) => c.id !== id,
  );
  if (!writeStoreValueChecked(CAPTURES_KEY, next)) return false;
  await store.del(mediaId(id));
  return true;
}

/** Fetch the bytes for a capture (for playback). */
export async function captureBlob(
  id: string,
  store: MediaStore = defaultMediaStore(),
): Promise<Blob | null> {
  return store.get(mediaId(id));
}

function pickVideoMime(): string | undefined {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  for (const c of candidates) {
    try {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* ignore unsupported */
    }
  }
  return undefined;
}

export interface ActiveVideoRecording {
  /** Stop and resolve the final bytes + metadata (tracks released). */
  stop: () => Promise<{ capture: VideoCapture; blob: Blob }>;
  /** Abort without keeping anything. */
  cancel: () => void;
}

/** Start recording video from the current camera stream. */
export async function startVideoRecording(
  stream: MediaStream,
  id: string,
): Promise<ActiveVideoRecording> {
  if (typeof MediaRecorder === "undefined") {
    throw new RecordingUnavailableError("video capture unavailable");
  }
  const mime = pickVideoMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const started = Date.now();
  rec.start();
  const stop = () =>
    new Promise<{ capture: VideoCapture; blob: Blob }>((resolve) => {
      rec.onstop = () => {
        const type = rec.mimeType || mime || "video/webm";
        resolve({
          blob: new Blob(chunks, { type }),
          capture: { id, ts: started, mime: type, durationMs: Date.now() - started },
        });
      };
      if (rec.state !== "inactive") rec.stop();
    });
  const cancel = () => {
    try {
      if (rec.state !== "inactive") rec.stop();
    } catch {
      /* ignore */
    }
  };
  return { stop, cancel };
}

/** UID for a fresh capture (kept small & unique). */
export function newCaptureId(): string {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
