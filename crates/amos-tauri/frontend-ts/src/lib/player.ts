/**
 * player.ts — pure model for the local **Media Player** (PlayerApp.svelte).
 *
 * The player plays LOCAL audio + video. It has no playback logic of its own here
 * (the DOM owns the actual `<audio>`/`<video>`); this module is the deterministic,
 * offline-testable core: what counts as a playable local file, how the standard
 * `media_*` collections / the app's own voice memos + camera captures become a
 * single queue, and the transport math (repeat / shuffle / seek / labels).
 *
 * Sources are unified behind one [`PlayerTrack`] so the screen renders one
 * playlist regardless of origin:
 *   - `file`    → a `MediaItem` from the `media_*` bridge (bytes via `media_load`)
 *   - `memo`    → a voice memo (synthesized WAV seed, or bytes in the media store)
 *   - `capture` → a recorded camera video (bytes in the media store)
 *   - `demo`    → a synthesized demo clip, used only when the library is empty
 *
 * Everything here is pure and total: no throws, no NaN, no unbounded index.
 * Repeat/seek helpers are re-exported from `lib/music.ts` so both players share
 * one implementation (no drift).
 */
import { canonicalPath } from "./media";
import type { MediaItem } from "./media";
import { fmtDuration as fmtMsDuration, fmtStamp } from "./voiceMemos";
import type { VoiceMemo } from "./voiceMemos";
import { resLabelOf } from "./cameraCapture";
import type { VideoCapture } from "./cameraCapture";
import { pctProgress, seekSeconds, wrap } from "./music";
import type { RepeatMode } from "./music";

export type { RepeatMode };
export { pctProgress, seekSeconds };

/** The two families of playable media the player handles. */
export type PlayableKind = "audio" | "video";

/** Where a queued track came from (drives its badge + byte resolution). */
export type TrackOrigin = "file" | "memo" | "capture" | "demo";

/** Extension → MIME for audio the app is willing to hand to an `<audio>`. */
const AUDIO_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  weba: "audio/webm",
  amr: "audio/amr",
  "3ga": "audio/mp4",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  mka: "audio/x-matroska",
};

/** Extension → MIME for video the app is willing to hand to a `<video>`. */
const VIDEO_EXT: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  ts: "video/mp2t",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  wmv: "video/x-ms-wmv",
  ogv: "video/ogg",
};

/**
 * Upper bound on how many bytes the player will buffer into memory for one item.
 * A blob is materialized in the WebView, so an unbounded read is a real OOM
 * hazard (Power-of-10: bounded resources). Media larger than this is surfaced as
 * an honest "too large to buffer" state instead of an unbounded allocation.
 * Streaming (a range-capable asset protocol) is the documented upgrade path.
 */
export const MAX_PLAY_BYTES = 256 * 1024 * 1024; // 256 MiB

/** Lowercased file extension of `name` ("" when there is none). */
export function extOf(name: string): string {
  const slash = name.lastIndexOf("/");
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** `name` without its final extension (kept whole when there is none). */
export function stripExt(name: string): string {
  const slash = name.lastIndexOf("/");
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Classify a local file by MIME first, extension second. Returns `null` for
 * anything that is not an audio/video file (images, PDFs, unknown) — those are
 * never queued, so the playlist can't contain an unplayable row.
 */
export function kindFromName(name: string, mime?: string | null): PlayableKind | null {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  const e = extOf(name);
  if (e in VIDEO_EXT) return "video";
  if (e in AUDIO_EXT) return "audio";
  return null;
}

/** The best MIME to tag a blob with (specific MIME kept; else from extension). */
export function mimeForPlayable(name: string, mime?: string | null): string {
  const m = (mime ?? "").toLowerCase();
  if (typeof mime === "string" && (m.startsWith("audio/") || m.startsWith("video/"))) return mime;
  const e = extOf(name);
  return AUDIO_EXT[e] ?? VIDEO_EXT[e] ?? "application/octet-stream";
}

/** Whether a known size exceeds the in-memory buffer ceiling. */
export function isTooLarge(sizeBytes: number | null | undefined, max = MAX_PLAY_BYTES): boolean {
  return typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes > max;
}

/** One queued, playable track (origin-agnostic view for the playlist). */
export interface PlayerTrack {
  /** Stable dedupe key (`<origin>:<native id>`). */
  id: string;
  title: string;
  origin: TrackOrigin;
  kind: PlayableKind;
  /** Language-neutral detail line (folder path / codec / pixel label). */
  subtitle: string;
  sizeBytes: number | null;
  /** Newest-first ordering key (epoch ms; 0 = unknown). */
  ts: number;
  source: TrackSource;
}

/** The origin-specific payload (resolved to bytes by the screen, not here). */
export type TrackSource =
  | { kind: "file"; item: MediaItem }
  | { kind: "memo"; memo: VoiceMemo }
  | { kind: "capture"; capture: VideoCapture }
  | { kind: "demo"; seconds: number; toneHz: number };

/** Promote a `media_*` item into a track; `null` when it isn't audio/video. */
export function trackFromItem(item: MediaItem): PlayerTrack | null {
  const kind = kindFromName(item.name, item.mime);
  if (!kind) return null;
  return {
    id: `file:${item.uri || item.id}`,
    title: stripExt(item.name) || item.name,
    origin: "file",
    kind,
    subtitle: canonicalPath(item.collection),
    sizeBytes: item.size_bytes,
    ts: item.ts,
    source: { kind: "file", item },
  };
}

/** Promote a voice memo (always audio) into a track. */
export function trackFromMemo(memo: VoiceMemo): PlayerTrack {
  return {
    id: `memo:${memo.id}`,
    title: memo.title,
    origin: "memo",
    kind: "audio",
    subtitle: memo.mime,
    sizeBytes: memo.sizeBytes,
    ts: memo.createdAt,
    source: { kind: "memo", memo },
  };
}

/** Promote a camera video capture into a track. */
export function trackFromCapture(capture: VideoCapture): PlayerTrack {
  const det = [resLabelOf(capture), fmtMsDuration(capture.durationMs)].filter((s) => s).join(" · ");
  return {
    id: `capture:${capture.id}`,
    title: fmtStamp(capture.ts),
    origin: "capture",
    kind: "video",
    subtitle: det || capture.mime,
    sizeBytes: null,
    ts: capture.ts,
    source: { kind: "capture", capture },
  };
}

/** A demo (synthesized WAV) clip so the player is usable with no local media. */
function demoTrack(id: string, title: string, seconds: number, toneHz: number): PlayerTrack {
  return {
    id: `demo:${id}`,
    title,
    origin: "demo",
    kind: "audio",
    subtitle: `${seconds}s · ${toneHz}Hz`,
    sizeBytes: null,
    ts: 0,
    source: { kind: "demo", seconds, toneHz },
  };
}

/** Deterministic demo clips (used ONLY as an empty-library fallback). */
export function demoTracks(): PlayerTrack[] {
  return [
    demoTrack("a", "晨光 (示例)", 6, 330),
    demoTrack("b", "星河 (示例)", 8, 440),
    demoTrack("c", "晚风 (示例)", 5, 262),
  ];
}

/** Concatenate source groups, dropping later duplicates by track id (stable). */
export function mergeTracks(...groups: PlayerTrack[][]): PlayerTrack[] {
  const out: PlayerTrack[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const t of g) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/** Clamp to [0,1); protects the shuffle index math from a misbehaving RNG. */
function unit(rng: () => number): number {
  const v = rng();
  if (!Number.isFinite(v)) return 0;
  return Math.min(0.9999999, Math.max(0, v));
}

/**
 * The play order as track indices. Identity when not shuffled; a Fisher–Yates
 * permutation when shuffled. `rng` is injectable so tests are deterministic.
 */
export function buildOrder(total: number, shuffle: boolean, rng: () => number = Math.random): number[] {
  const n = Math.max(0, Math.floor(total));
  const base = Array.from({ length: n }, (_, i) => i);
  if (!shuffle || n < 2) return base;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(unit(rng) * (i + 1));
    const a = base[i];
    const b = base[j];
    if (a === undefined || b === undefined) continue; // unreachable; keeps types total
    base[i] = b;
    base[j] = a;
  }
  return base;
}

/** Position of `trackIndex` within `order`, or -1 when absent. */
export function posOfTrack(order: readonly number[], trackIndex: number): number {
  return order.indexOf(trackIndex);
}

/**
 * Index of the track with `id` in a rescan result, or -1 when it is gone.
 * Used to keep the same track playing across a refresh (null/absent id → -1).
 */
export function indexOfTrackId(tracks: readonly { id: string }[], id: string | null): number {
  if (!id) return -1;
  return tracks.findIndex((t) => t.id === id);
}

/**
 * Step within the play order honouring the repeat mode. Returns the new position
 * and whether playback should stop (only possible at an end with mode `"off"`).
 * `"one"` stays put (caller restarts the same track) — callers wanting a manual
 * skip should pass `"all"`-like wrapping instead. Total for any input.
 */
export function stepOrderPos(
  pos: number,
  orderLen: number,
  delta: number,
  mode: RepeatMode,
): { pos: number; stop: boolean } {
  const n = Math.max(0, Math.floor(orderLen));
  if (n <= 0) return { pos: 0, stop: true };
  const p = Math.max(0, Math.min(n - 1, Math.floor(pos)));
  if (mode === "one") return { pos: p, stop: false };
  if (mode === "off") {
    const x = p + delta;
    if (x < 0 || x >= n) return { pos: Math.max(0, Math.min(n - 1, x)), stop: true };
    return { pos: x, stop: false };
  }
  return { pos: wrap(p + delta, n), stop: false };
}

/** The repeat mode to use for an explicit user skip (repeat-one ≠ "stuck"). */
export function skipMode(mode: RepeatMode): RepeatMode {
  return mode === "one" ? "all" : mode;
}

/** Selectable playback speeds (×), ascending; 1 is the neutral default. */
export const PLAYBACK_RATES: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * Next playback rate in [`PLAYBACK_RATES`], wrapping in either direction.
 * An unknown/absent current rate restarts from 1× so the button always works.
 */
export function cyclePlaybackRate(current: number, step = 1): number {
  const list = PLAYBACK_RATES;
  const found = list.indexOf(current);
  const base = found >= 0 ? found : Math.max(0, list.indexOf(1));
  const n = list.length;
  const next = (((base + step) % n) + n) % n;
  return list[next] ?? 1;
}

/** Compact speed label ("1×", "1.25×", "0.5×"); garbage → "1×". */
export function formatRate(rate: number): string {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return `${r}×`;
}

/**
 * Where to resume a saved playhead once the real duration is known. A position
 * at/after `total - 3s` snaps to 0 (a "finished" track must not resume at its
 * last second), and the value is clamped to the media length.
 */
export function resumePosition(saved: number, total: number): number {
  const s = Number.isFinite(saved) ? Math.max(0, saved) : 0;
  if (!Number.isFinite(total) || total <= 0) return s;
  if (s >= total - 3) return 0;
  return Math.min(s, total);
}

/** "3:07" / "1:02:05" from a whole number of seconds (never negative/NaN). */
export function fmtSeconds(totalSec: number): string {
  const s0 = Number.isFinite(totalSec) ? Math.max(0, Math.floor(totalSec)) : 0;
  const h = Math.floor(s0 / 3600);
  const m = Math.floor((s0 % 3600) / 60);
  const s = s0 % 60;
  const p = (x: number) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

/** Track index at `pos` in the play order (0 when the order is empty). */
export function currentTrackIndex(order: readonly number[], pos: number): number {
  if (order.length === 0) return 0;
  const p = Math.max(0, Math.min(order.length - 1, Math.floor(pos)));
  return order[p] ?? 0;
}
