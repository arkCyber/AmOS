/**
 * Call-ringtone vocabulary + synthesis for the「来电铃声与振动」settings page.
 *
 * Why this module exists (REQ-A993 / F-SH-314): that page wrote its own
 * `{selected, vibrate}` blob under an invented `amos.ringtone` key that **nothing
 * read** — the ringer played a fixed `sounds/phone/incoming.mp3`, no code ever
 * vibrated for a call, and the preview played the *notification* chime. Yet the
 * page's own copy promised all three (`ringtone.selectHint`「来电时播放的铃声」,
 * `ringtone.vibrateHint`「来电时同时振动」, `ringtone.previewDesc`「播放当前选择的
 * 铃声」), and its file header even claimed the bits belonged to `lib/sound`'s
 * `amos.sound` — the one policy the alert path actually honours. A switch whose
 * own label describes an effect that no code produces is a defect, not a gap.
 *
 * Ownership split (the header's intent, made real): the **haptic bit** is
 * `lib/sound`'s (`amos.sound.vibrate`) so the page's toggle and 声音与触感's haptics
 * toggle are one truth source; the **tone id** has no home in that policy, so it
 * lives here under its own durable key.
 *
 * Synthesis is asset-free, the same philosophy as `lib/ringtone` for alarms: all
 * five ids are generated from `makeCallRingSamples()` (pure, no AudioContext), so
 * every selectable tone is actually audible today and a bundled file is not
 * required for any of them.
 */

/** The durable key holding the chosen call-ringtone id (legacy records read through). */
export const RINGTONE_KEY = "amos.ringtone";

/** The selectable call ringtones, in the order the settings page lists them. */
export const CALL_RINGTONE_IDS = ["classic", "modern", "piano", "guitar", "bell"] as const;

export type CallRingtoneId = (typeof CALL_RINGTONE_IDS)[number];

/** What an unreadable/unknown selection falls back to. */
const DEFAULT_CALL_RINGTONE: CallRingtoneId = "classic";

function isCallRingtoneId(v: unknown): v is CallRingtoneId {
  return typeof v === "string" && (CALL_RINGTONE_IDS as readonly string[]).includes(v);
}

/** Whitelist a stored id; anything else (junk, an id we no longer ship) → default. */
export function normalizeCallRingtoneId(raw: unknown): CallRingtoneId {
  return isCallRingtoneId(raw) ? raw : DEFAULT_CALL_RINGTONE;
}

/** The page's persisted choice: the tone id plus whether the phone buzzes on ring. */
export interface CallRingtonePrefs {
  selected: CallRingtoneId;
  vibrate: boolean;
}

/**
 * Read the stored blob tolerantly. The value was written as a JSON *string* by the
 * original page, so both a string and an already-parsed object are accepted — a
 * user's existing choice survives.
 *
 * `vibrateFallback` comes from the alert policy (`lib/sound`), which owns the
 * haptic bit; a legacy `vibrate` left in the old blob is read through once so a
 * user who had turned it off does not silently get it back.
 */
export function normalizeRingtonePrefs(
  raw: unknown,
  vibrateFallback: boolean,
): CallRingtonePrefs {
  const fields = parseStoredFields(raw);
  return {
    selected: normalizeCallRingtoneId(fields?.selected),
    vibrate: typeof fields?.vibrate === "boolean" ? fields.vibrate : vibrateFallback,
  };
}

/** Parse a stored blob tolerantly into a plain object, or `null` if unreadable. */
function parseStoredFields(raw: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* corrupt blob — every field falls back */
  }
  return null;
}

/**
 * Does the stored record still carry the retired `vibrate` field?
 *
 * That field has exactly one legitimate reader — the read-through in
 * `normalizeRingtonePrefs` — and it must be read **once**, at the one-time
 * migration the 「来电铃声与振动」page performs. Left in place afterwards it keeps
 * winning over the live policy (`amos.sound.vibrate`), so a user who turns the
 * toggle on is still handed `vibrate:false` and the phone never buzzes. The page
 * uses this to decide the retired record must be rewritten without the field.
 */
export function hasLegacyVibrate(raw: unknown): boolean {
  const fields = parseStoredFields(raw);
  return typeof fields?.vibrate === "boolean";
}

/* -------------------------------------------------------------------------- *
 *  Synthesis — pure, deterministic, asset-free (mirrors lib/ringtone motifs).
 * -------------------------------------------------------------------------- */

/** A single note event (frequency, start offset within the motif, duration). */
interface Note {
  f: number;
  at: number; // seconds from motif start
  dur: number; // seconds (sustain before natural decay)
}

const SEMI = 2 ** (1 / 12);
/** `n` semitones above A4 (440 Hz). */
const N = (n: number) => 440 * SEMI ** n;

/** One looping motif per id — deliberately distinct so a pick is audible. */
const MOTIFS: Record<CallRingtoneId, Note[]> = {
  // Two-tone "ring-ring" bursts, the traditional line cadence.
  classic: [
    { f: N(-4), at: 0.0, dur: 0.4 },
    { f: N(-3), at: 0.0, dur: 0.4 },
    { f: N(-4), at: 0.5, dur: 0.4 },
    { f: N(-3), at: 0.5, dur: 0.4 },
    { f: N(-4), at: 1.4, dur: 0.4 },
    { f: N(-3), at: 1.4, dur: 0.4 },
    { f: N(-4), at: 1.9, dur: 0.4 },
    { f: N(-3), at: 1.9, dur: 0.4 },
  ],
  // Bright rising arpeggio, twice.
  modern: [
    { f: N(16), at: 0.0, dur: 0.22 },
    { f: N(19), at: 0.25, dur: 0.22 },
    { f: N(23), at: 0.5, dur: 0.22 },
    { f: N(28), at: 0.75, dur: 0.4 },
    { f: N(16), at: 1.4, dur: 0.22 },
    { f: N(19), at: 1.65, dur: 0.22 },
    { f: N(23), at: 1.9, dur: 0.22 },
    { f: N(28), at: 2.15, dur: 0.4 },
  ],
  // A struck triad, then a two-note answer.
  piano: [
    { f: N(3), at: 0.0, dur: 0.9 },
    { f: N(7), at: 0.0, dur: 0.9 },
    { f: N(10), at: 0.0, dur: 0.9 },
    { f: N(7), at: 1.0, dur: 0.5 },
    { f: N(12), at: 1.5, dur: 0.8 },
  ],
  // Staggered "strum" of an open chord, twice.
  guitar: [
    { f: N(-7), at: 0.0, dur: 0.7 },
    { f: N(-2), at: 0.07, dur: 0.7 },
    { f: N(3), at: 0.14, dur: 0.7 },
    { f: N(7), at: 0.21, dur: 0.7 },
    { f: N(-7), at: 1.3, dur: 0.7 },
    { f: N(-2), at: 1.37, dur: 0.7 },
    { f: N(3), at: 1.44, dur: 0.7 },
    { f: N(7), at: 1.51, dur: 0.7 },
  ],
  // "Ding-dong" doorbell.
  bell: [
    { f: N(16), at: 0.0, dur: 0.8 },
    { f: N(12), at: 0.7, dur: 1.0 },
  ],
};

/** Loop length (seconds) — covers the longest motif with padding. */
const MOTIF_SECONDS = 2.6;

/**
 * Synthesize one looping motif as mono samples in [-1, 1]. Pure: never touches
 * AudioContext, so it is headless-testable. Unknown ids fall back to the default
 * motif; output is clamped so a corrupt rate can never produce non-finite audio.
 */
export function makeCallRingSamples(id: unknown, rate = 16_000): Float32Array {
  const notes = MOTIFS[normalizeCallRingtoneId(id)];
  const r = Number.isFinite(rate) && rate > 0 ? Math.floor(rate) : 16_000;
  const total = Math.max(1, Math.floor(MOTIF_SECONDS * r));
  const out = new Float32Array(total);
  for (const note of notes) {
    const start = Math.max(0, Math.floor(note.at * r));
    const len = Math.max(1, Math.floor(note.dur * r));
    const n = Math.min(len, total - start);
    if (n <= 0) continue;
    for (let i = 0; i < n; i++) {
      const t = i / r;
      const env = Math.min(1, t / 0.008) * Math.exp(-3.2 * t);
      const sample = Math.sin(2 * Math.PI * note.f * t) * env * 0.5;
      const j = start + i;
      out[j] = Math.max(-1, Math.min(1, (out[j] ?? 0) + sample));
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 *  The one decision the ringer asks for.
 * -------------------------------------------------------------------------- */

/** What an incoming call should actually do, decided in one pure place. */
export interface IncomingRingPlan {
  /** The tone to loop. */
  id: CallRingtoneId;
  /** Whether to buzz while it rings. */
  vibrate: boolean;
  /** The samples to play (already synthesized, so the player is I/O only). */
  samples: Float32Array;
}

/**
 * Decide how to ring an incoming call: which tone, and whether to buzz.
 *
 * `rawPrefs` is the durable `amos.ringtone` value, `policyVibrate` the haptic bit
 * from the alert policy (`lib/sound`). Both are untrusted input, so a corrupt store
 * still yields a ringing phone rather than an exception.
 */
export function incomingRingPlan(
  rawPrefs: unknown,
  policyVibrate: boolean,
  rate = 16_000,
): IncomingRingPlan {
  const prefs = normalizeRingtonePrefs(rawPrefs, policyVibrate);
  return {
    id: prefs.selected,
    vibrate: prefs.vibrate,
    samples: makeCallRingSamples(prefs.selected, rate),
  };
}
