/* Voice Memos (语音备忘录) domain kernel — pure + headless-friendly.
 *
 * A memo = METADATA only (title, recorded-at, duration, size, optional
 * transcript). The audio bytes are stored as a BINARY Blob in a MediaStore
 * (IndexedDB in the shell, in-memory in tests) — never base64-inflated into
 * the text KV store. The `amos.vmemos` store persists just the metadata list
 * (small, cross-window, boot-hydrated).
 *
 * Recordings come from MediaRecorder (Opus → already compressed). Demo seeds are
 * tiny regenerable WAV clips (`audio.kind === "seed"`) — nothing is stored for
 * them, so the default store stays nearly empty. A pure WAV generator makes the
 * demos/tests deterministic without any microphone or browser APIs.
 *
 * Trim region (a [startMs, endMs] sub-range of a `recorded` memo's byte stream)
 * is metadata-only too: the bytes are not re-written until the user actually
 * saves the new memo (`trimMemo` keeps the original as-is and appends a sibling
 * memo with a new id). A transcript attached to a memo is the small
 * `{text, recognized, lang, at}` produced by `transcribe_audio`; it lives
 * alongside the metadata because it is cheap and is what the screen renders.
 */
import { localId } from "./localId";

export type MemoAudio =
  /** Regenerate a short WAV on demand — no bytes persisted (demo clips). */
  | { kind: "seed"; seconds: number; toneHz: number }
  /** Audio bytes live in the binary MediaStore under the memo id. */
  | { kind: "recorded" };

/** A transcript attached to a memo (from `transcribe_audio`). Cheap; kept on the
 *  metadata row so the screen renders it without an extra fetch. Only present
 *  when ASR ran successfully; `recognized` reflects whether the daemon actually
 *  found speech. */
export interface MemoTranscript {
  text: string;
  recognized: boolean;
  /** BCP-47 / free-form language tag the daemon reported ("" if unknown). */
  lang: string;
  /** When the transcript was produced (millis). */
  at: number;
}

/** Inclusive [startMs, endMs] range, milliseconds, used by the trimmer. */
export interface MemoRange {
  startMs: number;
  endMs: number;
}

export interface VoiceMemo {
  id: string;
  title: string;
  createdAt: number;
  durationMs: number;
  audio: MemoAudio;
  /** Approx audio payload bytes (display + accounting; the bytes are binary). */
  sizeBytes: number;
  mime: string;
  /** Optional attached transcript (ASR). */
  transcript?: MemoTranscript;
  /** Stable parent id when this memo was created by trimming `parentId`. The
   *  field is optional; it does not affect playback or export. */
  trimOf?: string;
}

function readAudio(v: unknown): MemoAudio | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  if (a.kind === "recorded") return { kind: "recorded" };
  if (a.kind === "seed") {
    const seconds = Number(a.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const toneHz = Number(a.toneHz);
    return { kind: "seed", seconds, toneHz: Number.isFinite(toneHz) ? toneHz : 440 };
  }
  return null;
}

function readTranscript(v: unknown): MemoTranscript | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  if (typeof t.text !== "string") return null;
  return {
    text: t.text,
    recognized: !!t.recognized,
    lang: typeof t.lang === "string" ? t.lang : "",
    at: typeof t.at === "number" && Number.isFinite(t.at) && t.at >= 0 ? t.at : 0,
  };
}

/** Metadata for a recorded memo (its bytes live in the binary MediaStore). */
export function memoForRecording(input: {
  id: string;
  title: string;
  createdAt: number;
  durationMs: number;
  sizeBytes: number;
  mime: string;
}): VoiceMemo {
  return { ...input, audio: { kind: "recorded" } };
}
export const VMEMOS_KEY = "amos.vmemos";
export const VMEMO_CAP = 24;

/**
 * A new memo id.
 *
 * REQ-A402: was `${now.toString(36)}-${seq}` with a **per-process** counter — no entropy.
 * Two contexts that agree on a millisecond mint the same string (measured: two processes
 * with a frozen clock both produced `loyw3v28-1`), and a repeated memo id is **DROPPED**
 * by `normalizeVoiceMemos` — the recording disappears from the library while its bytes
 * stay behind. `localId` adds a zero-padded crypto tail, so same-millisecond mints in two
 * windows no longer collapse.
 */
export function makeVoiceId(): string {
  return localId("vm");
}

/* ---- formatting ---- */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
/** "3:07" / "1:02:05" — a compact elapsed-time label. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(sec)}`;
  return `${m}:${pad2(sec)}`;
}
/** Recording clock while capturing: "mm:ss" (or "hh:mm:ss"). */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
  return `${pad2(m)}:${pad2(sec)}`;
}
/** Date/time shown on a memo row: "2026/09/04 · 14:03" (locale-neutral). */
export function fmtStamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} · ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** Default new-recording title: a clock like "14:03:05" (iOS shows the time). */
export function defaultRecordingTitle(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/* ---- CRUD (immutable) ---- */
export function prependMemo(list: VoiceMemo[], m: VoiceMemo): VoiceMemo[] {
  return [m, ...list].slice(0, VMEMO_CAP);
}
export function renameMemo(list: VoiceMemo[], id: string, title: string): VoiceMemo[] {
  const v = title.trim();
  if (!v) return list;
  return list.map((m) => (m.id === id && m.title !== v ? { ...m, title: v } : m));
}
export function removeMemo(list: VoiceMemo[], id: string): VoiceMemo[] {
  return list.filter((m) => m.id !== id);
}

/** Corruption guard: keeps well-formed entries (id/title/numeric ts + a src),
 *  de-dups ids and caps the list. Optional `transcript` is preserved when it
 *  validates (`text` is a string); an invalid transcript is dropped, not promoted
 *  into a "transcribing…" placeholder. */
export function normalizeVoiceMemos(v: unknown): VoiceMemo[] {
  if (!Array.isArray(v)) return [];
  const out: VoiceMemo[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id) continue;
    if (seen.has(o.id)) continue;
    if (typeof o.title !== "string") continue;
    const createdAt = typeof o.createdAt === "number" && Number.isFinite(o.createdAt) ? o.createdAt : 0;
    const durationMs = typeof o.durationMs === "number" && Number.isFinite(o.durationMs) && o.durationMs >= 0 ? o.durationMs : 0;
    const audio = readAudio(o.audio);
    if (!audio) continue; // no playable audio → drop
    seen.add(o.id);
    const m: VoiceMemo = {
      id: o.id,
      title: o.title,
      createdAt,
      durationMs,
      audio,
      sizeBytes: typeof o.sizeBytes === "number" && Number.isFinite(o.sizeBytes) ? o.sizeBytes : 0,
      mime: typeof o.mime === "string" ? o.mime : "audio/wav",
    };
    if ("transcript" in o) {
      const tx = readTranscript(o.transcript);
      if (tx) m.transcript = tx;
      // else: a bad transcript is **dropped**, not kept as null — the screen
      // branches on "transcript is present" and a sentinel would silently render.
    }
    if (typeof o.trimOf === "string" && o.trimOf && o.trimOf !== o.id) {
      m.trimOf = o.trimOf;
    }
    out.push(m);
  }
  return out.length > VMEMO_CAP ? out.slice(out.length - VMEMO_CAP) : out;
}

/* ---- pure WAV generator (demo seeds + headless tests) ---- */

/** Build a mono 16-bit PCM WAV as a byte array. `toneHz` adds a soft sine so demo
 *  clips are audible; `amplitude` 0..1. Pure + deterministic. */
export function buildWavBytes(opts: {
  seconds: number;
  sampleRate?: number;
  toneHz?: number;
  amplitude?: number;
}): Uint8Array {
  const rate = Math.min(48000, Math.max(8000, Math.floor(opts.sampleRate ?? 8000)));
  const samples = Math.max(1, Math.floor(rate * opts.seconds));
  const toneHz = opts.toneHz ?? 0;
  const amp = Math.max(0, Math.min(0.9, opts.amplitude ?? 0.35));
  const data = new Uint8Array(44 + samples * 2);
  const dv = new DataView(data.buffer);
  // RIFF header
  data.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  dv.setUint32(4, 36 + samples * 2, true);
  data.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  data.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits
  data.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  dv.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const v = toneHz > 0 ? Math.sin(2 * Math.PI * toneHz * t) * amp : 0;
    const int = (v < 0 ? v * 0x8000 : v * 0x7fff) | 0;
    dv.setInt16(44 + i * 2, int, true);
  }
  return data;
}

/** Demo clips so the app isn't empty on first launch. Seeds are tiny regenerable
 *  WAV clips (`audio.kind: "seed"`) — NO bytes are stored, so the default KV
 *  store stays nearly empty; playback synthesizes them on demand. */
export function seedVoiceMemos(now: number): VoiceMemo[] {
  const clipBytes = (seconds: number, toneHz: number) =>
    buildWavBytes({ seconds, sampleRate: 8000, toneHz, amplitude: 0.3 }).length;
  return [
    {
      id: makeVoiceId(),
      title: defaultRecordingTitle(now - 60_000),
      createdAt: now - 60_000,
      durationMs: 3_000,
      audio: { kind: "seed", seconds: 3, toneHz: 330 },
      sizeBytes: clipBytes(3, 330),
      mime: "audio/wav",
    },
    {
      id: makeVoiceId(),
      title: defaultRecordingTitle(now - 120_000),
      createdAt: now - 120_000,
      durationMs: 1_500,
      audio: { kind: "seed", seconds: 1.5, toneHz: 494 },
      sizeBytes: clipBytes(1.5, 494),
      mime: "audio/wav",
    },
  ];
}

/* ---- playback progress (pure) ---- */

/** Clamp `currentMs` to [0, durationMs], then return the percent [0, 100].
 *  Zero-duration recording ⇒ 0 (never NaN); `currentMs > duration` ⇒ 100. */
export function progressPercent(currentMs: number, durationMs: number): number {
  const total = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const cur = Number.isFinite(currentMs) ? Math.max(0, currentMs) : 0;
  if (total === 0) return 0;
  const pct = (cur * 100) / total;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

/** Seek target inside the memo's own timeline (the HTMLAudioElement, not the
 *  wall clock). `sec` is clamped to [0, durationSec]. */
export function clampSeekSeconds(sec: number, durationSec: number): number {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const s = Number.isFinite(sec) ? sec : 0;
  if (dur === 0) return 0;
  if (s < 0) return 0;
  if (s > dur) return dur;
  return s;
}

/* ---- trim region (pure) ---- */

/** Clamp a half-open trim region to a memo's duration: `0 ≤ start ≤ end ≤
 *  durationMs`. Negative or NaN bounds collapse to 0 / duration; `start > end`
 *  is swapped so the tr UI can be sloppy in either handle without breaking the
 *  invariant. Returns the same shape the screen stores (`startMs`, `endMs`)
 *  with `endMs − startMs ≥ 0`. */
export function clampTrimRange(
  startMs: number,
  endMs: number,
  durationMs: number,
): MemoRange {
  const dur = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  // Swap FIRST, THEN clamp — so a reversed UI drag is corrected before bounds check.
  let s = Number.isFinite(startMs) ? startMs : 0;
  let e = Number.isFinite(endMs) ? endMs : 0;
  if (s > e) {
    const tmp = s;
    s = e;
    e = tmp;
  }
  return { startMs: Math.min(Math.max(0, s), dur), endMs: Math.min(Math.max(0, e), dur) };
}

/** A no-op iff `start === 0` and `end === duration`. */
export function isFullRange(r: MemoRange, durationMs: number): boolean {
  return r.startMs <= 0 && r.endMs >= durationMs;
}

/** Trim a memo's audio duration down to the selected window (pure).
 *  Returns `durationMs` clamped to `endMs − startMs`. */
export function trimmedDurationMs(r: MemoRange): number {
  return Math.max(0, r.endMs - r.startMs);
}

/** Build the metadata for a NEW memo (sibling row in the library) carrying the
 *  same bytes under a fresh id + a `[startMs, endMs]` window. The trim itself —
 *  cutting bytes — happens once the user **saves**; this only shapes metadata,
 *  mirroring how `memoForRecording` is a metadata-only builder. The original
 *  memo is left alone so it can be re-edited or undone. */
export function trimMemo(
  src: VoiceMemo,
  range: MemoRange,
  now: number,
): { ok: true; memo: VoiceMemo } | { ok: false; reason: string } {
  if (src.audio.kind !== "recorded") {
    // Demo seeds have no bytes to cut; refusing early keeps the UI honest.
    return { ok: false, reason: "seed" };
  }
  const r = clampTrimRange(range.startMs, range.endMs, src.durationMs);
  if (r.endMs - r.startMs < 1) return { ok: false, reason: "empty" };
  // Reuse a proportional slice of the size as an estimate. The actual re-encoded
  // size will be set by the byte-side step (out of scope for pure helpers), so
  // this stays an **estimate** for display only.
  const ratio = src.durationMs > 0 ? (r.endMs - r.startMs) / src.durationMs : 0;
  return {
    ok: true,
    memo: {
      id: makeVoiceId(),
      title: defaultRecordingTitle(now),
      createdAt: now,
      durationMs: r.endMs - r.startMs,
      audio: { kind: "recorded" },
      sizeBytes: Math.max(1, Math.round(src.sizeBytes * ratio)),
      mime: src.mime,
      trimOf: src.id,
    },
  };
}

/* ---- transcript (pure) ---- */

/** ASR state machine for one memo. Used by the UI to render "transcribing…",
 *  "recognized …", "no speech", and to disable the button while a request is
 *  in flight. Pure: the network call lives in the UI; this just maps intents. */
export type AsrState =
  | { kind: "idle" }
  | { kind: "transcribing" }
  | { kind: "done"; transcript: MemoTranscript }
  | { kind: "empty" }
  | { kind: "error"; message: string };

/** Parse a daemon reply (`{ text: string, recognized: boolean }` plus optional
 *  `lang`) into a {@link MemoTranscript}. `null` when the payload is structurally
 *  not one — never a half-built row. Mirrors `parseTranscribe`'s discipline but
 *  is local to this module so the screen does not have to import the ASR helper
 *  for a single row. */
export function readTranscribeReply(
  v: unknown,
  at: number,
): MemoTranscript | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (typeof p.text !== "string") return null;
  return {
    text: p.text,
    recognized: !!p.recognized,
    lang: typeof p.lang === "string" ? p.lang : "",
    at: Number.isFinite(at) && at >= 0 ? at : 0,
  };
}

/** Attached-transcript update — returns a NEW memo (immutable) with `tx`
 *  stamped on. `null` ⇒ strip the transcript (e.g. user cleared it). */
export function attachTranscript(m: VoiceMemo, tx: MemoTranscript | null): VoiceMemo {
  if (tx === null) {
    if (!("transcript" in m)) return m;
    const { transcript: _drop, ...rest } = m;
    return rest as VoiceMemo;
  }
  return { ...m, transcript: tx };
}

/** Build the `atos` outcome line the UI should render after a transcribe call:
 *  - shape 4 of "voice reply didn't look like a payload" → `error("shape")`
 *  - `recognized: true` → `done(transcript)`
 *  - `recognized: false` and empty text → `empty`
 *  - everything else → `done(transcript)` (the daemon will surface "no speech"
 *    via `recognized=false`; callers branch on `recognized`). */
export function classifyTranscribe(
  payload: unknown,
  at: number,
): AsrState {
  const tx = readTranscribeReply(payload, at);
  if (!tx) return { kind: "error", message: "shape" };
  if (!tx.recognized && tx.text.length === 0) return { kind: "empty" };
  return { kind: "done", transcript: tx };
}

/** Translate an arbitrary exception (from `transcribe_audio`'s catch arm) into
 *  a typed `AsrState`. We refuse to render "transcribing…" forever — a rejected
 *  call is `error("host")`, no host is `error("offline")`, a malformed reply is
 *  `error("shape")`. Mirrors the `ExportOutcome` discipline used by mediaExport. */
export function classifyTranscribeError(e: unknown): AsrState {
  const raw = typeof e === "string"
    ? e
    : typeof e === "object" && e !== null
      ? (e as Record<string, unknown>).message
        ? String((e as Record<string, unknown>).message ?? "")
        : "unknown"
      : "unknown";
  if (/no bridge|not bridged/i.test(raw)) return { kind: "error", message: "offline" };
  if (raw === "unknown") return { kind: "error", message: "unknown" };
  return { kind: "error", message: "host" };
}
