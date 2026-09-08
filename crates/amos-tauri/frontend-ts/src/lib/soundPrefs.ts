/**
 * Persistent sound-preferences ledger for the Settings「声音与触感」page.
 *
 * The OS ships no audio assets, so these are UI preferences (whether the system
 * should play notification chimes / use haptics); the audible preview itself is
 * synthesized by lib/notifyTone.playNotifyTone (asset-free, safe anywhere).
 * Kept as a small pure ledger (mirroring lib/display / lib/lock patterns) so the
 * page reads/writes one durable key with a corruption-guard normalize.
 */

export const SOUND_KEY = "amos.sound";

export interface SoundPrefs {
  /** Play the synthesized notification chime. */
  notify: boolean;
  /** Request haptic feedback (when the host supports it). */
  haptics: boolean;
}

export function defaultSound(): SoundPrefs {
  return { notify: true, haptics: true };
}

/** Corruption guard: keeps only the known boolean keys (defaults true). */
export function normalizeSound(raw: unknown): SoundPrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultSound();
  const o = raw as Record<string, unknown>;
  return {
    notify: typeof o.notify === "boolean" ? o.notify : true,
    haptics: typeof o.haptics === "boolean" ? o.haptics : true,
  };
}

/** Pure: flip one sound preference (immutable). */
export function flipSound(s: SoundPrefs, key: keyof SoundPrefs): SoundPrefs {
  return { ...s, [key]: !s[key] };
}
