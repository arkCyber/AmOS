/* Voice Memos (语音备忘录) domain kernel — pure + headless-friendly.
 *
 * A memo = METADATA only (title, recorded-at, duration, size). The audio is
 * stored as a BINARY Blob in a MediaStore (IndexedDB in the shell, in-memory in
 * tests) — never base64-inflated into the text KV store. The `amos.*` store
 * persists just the metadata list (small, cross-window, boot-hydrated).
 *
 * Recordings come from MediaRecorder (Opus → already compressed). Demo seeds are
 * tiny regenerable WAV clips (`audio.kind === "seed"`) — nothing is stored for
 * them, so the default store stays nearly empty. A pure WAV generator makes the
 * demos/tests deterministic without any microphone or browser APIs.
 */

export type MemoAudio =
  /** Regenerate a short WAV on demand — no bytes persisted (demo clips). */
  | { kind: "seed"; seconds: number; toneHz: number }
  /** Audio bytes live in the binary MediaStore under the memo id. */
  | { kind: "recorded" };

export interface VoiceMemo {
  id: string;
  title: string;
  createdAt: number;
  durationMs: number;
  audio: MemoAudio;
  /** Approx audio payload bytes (display + accounting; the bytes are binary). */
  sizeBytes: number;
  mime: string;
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

let seq = 0;
export function makeVoiceId(now: number): string {
  seq += 1;
  return `${now.toString(36)}-${seq}`;
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
 *  de-dups ids and caps the list. */
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
    out.push({
      id: o.id,
      title: o.title,
      createdAt,
      durationMs,
      audio,
      sizeBytes: typeof o.sizeBytes === "number" && Number.isFinite(o.sizeBytes) ? o.sizeBytes : 0,
      mime: typeof o.mime === "string" ? o.mime : "audio/wav",
    });
  }
  return out.length > VMEMO_CAP ? out.slice(out.length - VMEMO_CAP) : out;
}

/* ---- pure WAV generator (demo seeds + headless tests) ---- */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[b2 & 63] : "=";
  }
  return out;
}

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

/** Encode WAV bytes as a playable `data:audio/wav;base64,…` URL. */
export function wavBytesToDataUrl(bytes: Uint8Array): string {
  return `data:audio/wav;base64,${toBase64(bytes)}`;
}

/** Convenience: a demo/short clip ready to play. */
export function buildWavDataUrl(seconds: number, toneHz = 440): { src: string; bytes: number; mime: string } {
  const bytes = buildWavBytes({ seconds, sampleRate: 8000, toneHz, amplitude: 0.3 });
  return { src: wavBytesToDataUrl(bytes), bytes: bytes.length, mime: "audio/wav" };
}

/** Demo clips so the app isn't empty on first launch. Seeds are tiny regenerable
 *  WAV clips (`audio.kind: "seed"`) — NO bytes are stored, so the default KV
 *  store stays nearly empty; playback synthesizes them on demand. */
export function seedVoiceMemos(now: number): VoiceMemo[] {
  const clipBytes = (seconds: number, toneHz: number) =>
    buildWavBytes({ seconds, sampleRate: 8000, toneHz, amplitude: 0.3 }).length;
  return [
    {
      id: makeVoiceId(now),
      title: defaultRecordingTitle(now - 60_000),
      createdAt: now - 60_000,
      durationMs: 3_000,
      audio: { kind: "seed", seconds: 3, toneHz: 330 },
      sizeBytes: clipBytes(3, 330),
      mime: "audio/wav",
    },
    {
      id: makeVoiceId(now),
      title: defaultRecordingTitle(now - 120_000),
      createdAt: now - 120_000,
      durationMs: 1_500,
      audio: { kind: "seed", seconds: 1.5, toneHz: 494 },
      sizeBytes: clipBytes(1.5, 494),
      mime: "audio/wav",
    },
  ];
}
