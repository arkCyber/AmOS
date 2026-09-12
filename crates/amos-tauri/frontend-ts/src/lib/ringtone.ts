/**
 * Ringtone layer for Clock alarms.
 *
 * The alarm's chosen "tone" has historically been an emoji token (🔔 ⏰ 📯 🎶)
 * persisted in `amos.alarms` — a *label* the reducer cycles, with no sound behind
 * it. This module makes that token audible:
 *
 *  - `RINGTONE_BY_TOKEN` maps each emoji token to a stable synth id + the file
 *    name it would be stored under in the default ringtone directory.
 *  - `RINGTONE_DIR` is the reserved **default ringtone storage directory**
 *    (`frontend-ts/public/sounds/ringtones/`). It ships empty with a README so
 *    real per-tone audio files can be dropped in (operators/admins), but the OS
 *    plays every tone today WITHOUT any bundled file — each id is synthesized
 *    from scratch by `makeToneSamples()` via the Web Audio API (asset-free, same
 *    philosophy as `notifyTone`/incoming-call ring). Files, when added later, are
 *    purely optional overrides.
 *  - `makeToneSamples(token, rate)` is PURE (no AudioContext) so it is
 *    unit-testable headlessly: it returns a mono Float32Array of a short, looping
 *    motif that is audibly distinct per token.
 */
export const RINGTONE_DIR = "sounds/ringtones";

/** Stable ids — each is a distinct synthesis motif and a file name. */
export type RingtoneId = "bell" | "alarm" | "bugle" | "melody";

/** The emoji tokens the alarm reducer persists → a real ringtone id + file. */
export const RINGTONE_BY_TOKEN: Readonly<Record<string, { id: RingtoneId; file: string }>> = {
  "🔔": { id: "bell", file: "bell.mp3" },
  "⏰": { id: "alarm", file: "alarm.mp3" },
  "📯": { id: "bugle", file: "bugle.mp3" },
  "🎶": { id: "melody", file: "melody.mp3" },
};

/** Ringtone id → file name in `RINGTONE_DIR` (MP3 — small & universally decoded
 *  by the WebView/`<audio>`; the `.wav` sources stay in the dir for editing). */
export const RINGTONE_FILE_BY_ID: Readonly<Record<RingtoneId, string>> = {
  bell: "bell.mp3",
  alarm: "alarm.mp3",
  bugle: "bugle.mp3",
  melody: "melody.mp3",
};

/** Resolve the emoji token an alarm stores to a synth id (fallback: bell). */
export function ringtoneIdFor(toneToken?: string): RingtoneId {
  return RINGTONE_BY_TOKEN[toneToken ?? ""]?.id ?? "bell";
}

/** Relative URL a real ringtone file WOULD live at under the default dir. */
export function ringtoneFileUrl(id: RingtoneId): string {
  return `${RINGTONE_DIR}/${RINGTONE_FILE_BY_ID[id]}`;
}

/* -------------------------------------------------------------------------- *
 *  Synthesis — pure, deterministic, asset-free. Produces one short "motif" that
 *  the player loops. Each id is a distinct note sequence so tones differ.
 * -------------------------------------------------------------------------- */

/** A single note event (frequency, start offset within the motif, duration). */
interface Note {
  f: number;
  at: number; // seconds from motif start
  dur: number; // seconds (sustain before natural decay)
}

const SEMI = 2 ** (1 / 12);
/** NOTE: `n` semitones above A4 (440 Hz). */
const N = (n: number) => 440 * SEMI ** n;

/** Note motifs (A4-based). Each returns a list of (freq, beatStart, beatDur). */
const MOTIFS: Record<RingtoneId, Note[]> = {
  // "Ding-dong": a bright bell arpeggio, sparse.
  bell: [
    { f: N(12), at: 0.0, dur: 0.7 }, // C5
    { f: N(16), at: 0.0, dur: 0.7 }, // E5  (chord top)
    { f: N(19), at: 0.55, dur: 0.8 }, // G5
    { f: N(24), at: 0.55, dur: 0.8 }, // C6
  ],
  // Urgent two-tone "beep-beep-beep", alternating an octave.
  alarm: [
    { f: N(9), at: 0.0, dur: 0.22 },
    { f: N(9), at: 0.3, dur: 0.22 },
    { f: N(9), at: 0.6, dur: 0.22 },
    { f: N(21), at: 0.9, dur: 0.22 },
    { f: N(9), at: 1.2, dur: 0.22 },
    { f: N(21), at: 1.5, dur: 0.22 },
    { f: N(9), at: 1.8, dur: 0.3 },
  ],
  // Military "charge" fanfare.
  bugle: [
    { f: N(-2), at: 0.0, dur: 0.5 }, // G4
    { f: N(5), at: 0.55, dur: 0.5 }, // C5
    { f: N(9), at: 1.1, dur: 0.5 }, // D5
    { f: N(12), at: 1.65, dur: 0.6 }, // E5
  ],
  // A short melodic run (classic ring melody).
  melody: [
    { f: N(0), at: 0.0, dur: 0.28 },
    { f: N(4), at: 0.33, dur: 0.28 },
    { f: N(7), at: 0.66, dur: 0.28 },
    { f: N(12), at: 1.0, dur: 0.5 },
    { f: N(7), at: 1.55, dur: 0.4 },
  ],
};

/** Length of the longest motif (seconds) + a little loop padding. */
const MOTIF_SECONDS = 2.2;

/**
 * Synthesize one looping motif for a token as mono samples in [-1, 1].
 * Pure: never touches AudioContext, so it is headless-testable. Non-finite
 * inputs are guarded (silence) and output is clamped.
 */
export function makeToneSamples(token: string | undefined, rate = 16_000): Float32Array {
  const id = ringtoneIdFor(token);
  const notes = MOTIFS[id];
  const total = Math.max(1, Math.floor(MOTIF_SECONDS * rate));
  const out = new Float32Array(total);
  for (const note of notes) {
    if (!Number.isFinite(note.f) || note.f <= 0) continue;
    const start = Math.max(0, Math.floor(note.at * rate));
    const len = Math.max(1, Math.floor(note.dur * rate));
    const n = Math.min(len, total - start);
    if (n <= 0) continue;
    const freq = note.f;
    // Phase-continuous sine + fast attack + exponential decay for a bell-like
    // body; decaying per note avoids clicks and keeps each note audible.
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const env = Math.min(1, t / 0.008) * Math.exp(-3.2 * t);
      const sample = Math.sin(2 * Math.PI * freq * t) * env * 0.5;
      const j = start + i;
      out[j] = Math.max(-1, Math.min(1, (out[j] ?? 0) + sample));
    }
  }
  return out;
}

