/**
 * playerPrefs.ts — persisted player session (resume across app switches).
 *
 * The player is a thin screen over a transient DOM element; everything that must
 * survive a remount (which track was active, where in it, volume / mute / repeat /
 * shuffle) is normalized here and stored under one `amos.player` key. All parsing
 * is total: a corrupt/absent/legacy record yields defaults, never a throw.
 *
 * The playhead is persisted *coarsely* (see [`shouldSavePosition`]) so a 4-minute
 * song does not write the store 240 times.
 */
import { readStoreValue, writeStoreValue } from "./amosStore";
import type { RepeatMode } from "./player";

export const PLAYER_PREFS_KEY = "amos.player";

/** Coarse playhead-persist cadence (one write per ~5 s while playing). */
export const POSITION_SAVE_INTERVAL_MS = 5000;

export interface PlayerPrefs {
  /** Last active track id (`<origin>:<native id>`); null when unknown. */
  trackId: string | null;
  /** Playhead seconds at the last save (>= 0). */
  positionSec: number;
  /** Volume 0..1. */
  volume: number;
  muted: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
}

export function defaultPlayerPrefs(): PlayerPrefs {
  return { trackId: null, positionSec: 0, volume: 1, muted: false, repeat: "all", shuffle: false };
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Clamp any input to a usable volume in [0,1] (garbage → 1). */
export function clampVolume(v: unknown): number {
  return Math.max(0, Math.min(1, numOr(v, 1)));
}

/** Clamp any input to a non-negative second count (garbage → 0). */
export function clampPosition(v: unknown): number {
  return Math.max(0, numOr(v, 0));
}

function isRepeat(v: unknown): v is RepeatMode {
  return v === "off" || v === "all" || v === "one";
}

/** Coerce an arbitrary stored value into a valid [`PlayerPrefs`]. Never throws. */
export function normalizePlayerPrefs(raw: unknown): PlayerPrefs {
  const d = defaultPlayerPrefs();
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  return {
    trackId: typeof o.trackId === "string" && o.trackId !== "" ? o.trackId : null,
    positionSec: clampPosition(o.positionSec),
    volume: clampVolume(o.volume),
    muted: o.muted === true,
    repeat: isRepeat(o.repeat) ? o.repeat : d.repeat,
    shuffle: o.shuffle === true,
  };
}

/** Read + normalize the persisted session (defaults when absent/corrupt). */
export function loadPlayerPrefs(): PlayerPrefs {
  return normalizePlayerPrefs(readStoreValue<unknown>(PLAYER_PREFS_KEY, null));
}

/** Persist a session (normalized first, so the store never holds garbage). */
export function savePlayerPrefs(p: PlayerPrefs): void {
  writeStoreValue(PLAYER_PREFS_KEY, normalizePlayerPrefs(p));
}

/**
 * Whether the playhead is due for a throttled persist. A non-finite timestamp
 * (clock glitch) returns true so progress is not silently lost forever.
 */
export function shouldSavePosition(
  lastSavedMs: number,
  nowMs: number,
  interval = POSITION_SAVE_INTERVAL_MS,
): boolean {
  if (!Number.isFinite(lastSavedMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - lastSavedMs >= Math.max(0, interval);
}
