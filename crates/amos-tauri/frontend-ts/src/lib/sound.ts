/**
 * Notification sound / vibration policy (the "策略位" behind the quick toggles) —
 * the **single owner** of the durable `amos.sound` key.
 *
 * Two persisted policy bits: whether audible alerts ("ring") and haptics
 * ("vibrate") are allowed for notifications. Both default ON. Do-Not-Disturb is a
 * higher-level gate: when active, both are muted regardless of the persisted bits
 * (see `effectiveAlert`).
 *
 * `normalizeSound` is deliberately **migration-tolerant**: the Settings
 * 「声音与触感」page once persisted `{notify, haptics}` under this same key, so a
 * legacy record is read through (`notify → ring`, `haptics → vibrate`) instead of
 * being silently reset to defaults. There is exactly one schema now; both the
 * Settings page and the status bar / arrival path go through this module.
 *
 * The policy also carries `volume` — the loudness of the chime *we synthesize
 * ourselves* (lib/notifyTone), 0..1. It is honored at every play site of that
 * tone; it is not a claim about any system audio stream.
 */
import { readStoreValue, writeStoreValue } from "./amosStore";

/** Shared-store key under which the sound policy is persisted. */
export const SOUND_KEY = "amos.sound";

/** The two alert policy bits plus the synthesized-chime loudness. */
export interface SoundPolicy {
  /** Audible (ring) notifications allowed. */
  ring: boolean;
  /** Haptic (vibrate) notifications allowed. */
  vibrate: boolean;
  /** Chime loudness 0..1 (1 = the historical default envelope). */
  volume: number;
}

/**
 * Clamp to the 0..1 loudness unit. Anything unreadable falls back to 1 — the
 * historical default envelope — so a corrupt store can never silence alerts.
 */
function clampVolume(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 1;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

/**
 * Keep only well-formed policy bits; anything else falls back to ON. A legacy
 * `{notify, haptics}` record (written by the older Settings sound page under the
 * same key) is read through, so a user's choice survives the schema unification.
 * A record without `volume` (every pre-REQ-A205 store) reads back at the default
 * loudness 1 — byte-identical audible behaviour.
 */
export function normalizeSound(raw: unknown): SoundPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ring: true, vibrate: true, volume: 1 };
  }
  const o = raw as Record<string, unknown>;
  return {
    ring: typeof o.ring === "boolean" ? o.ring : typeof o.notify === "boolean" ? o.notify : true,
    vibrate:
      typeof o.vibrate === "boolean" ? o.vibrate : typeof o.haptics === "boolean" ? o.haptics : true,
    volume: clampVolume(o.volume),
  };
}

/** Default policy: both alerts allowed, default loudness. */
export const DEFAULT_SOUND: SoundPolicy = { ring: true, vibrate: true, volume: 1 };

/** Load the policy from the (durable) shared store. */
export function loadSound(): SoundPolicy {
  return normalizeSound(readStoreValue<unknown>(SOUND_KEY, DEFAULT_SOUND));
}

/** Persist the policy to the (durable) shared store. */
export function saveSound(policy: SoundPolicy): void {
  writeStoreValue(SOUND_KEY, normalizeSound(policy));
}

/**
 * Pure: flip one alert *bit* (immutable) — the Settings page's switch. The
 * loudness is not a bit; it has its own setter below.
 */
export function flipSound(policy: SoundPolicy, key: "ring" | "vibrate"): SoundPolicy {
  const base = normalizeSound(policy);
  return { ...base, [key]: !base[key] };
}

/**
 * Pure: set the chime loudness (clamped to 0..1). Unreadable input is ignored —
 * the normalized policy is returned unchanged rather than "fixed" silently.
 */
export function setSoundVolume(policy: SoundPolicy, volume: unknown): SoundPolicy {
  const base = normalizeSound(policy);
  if (typeof volume !== "number" || !Number.isFinite(volume)) return base;
  return { ...base, volume: clampVolume(volume) };
}

/** Effective alerts under DND: DND mutes both ring and vibration (loudness is untouched — a muted policy rings nothing to scale). */
export function effectiveAlert(policy: SoundPolicy, dnd: boolean): SoundPolicy {
  return dnd ? { ring: false, vibrate: false, volume: normalizeSound(policy).volume } : normalizeSound(policy);
}

/**
 * Pure gate for a haptic "notification arrived" pulse: vibrate only when the
 * unread count actually grew AND vibration is allowed by the effective policy.
 */
export function shouldVibrateOnArrival(
  previousUnread: number,
  currentUnread: number,
  effective: SoundPolicy,
): boolean {
  return currentUnread > previousUnread && normalizeSound(effective).vibrate;
}

/**
 * Pure gate for an audible "notification arrived" ring: ring only when the
 * unread count actually grew AND audible alerts are allowed by the effective
 * policy.
 */
export function shouldRingOnArrival(
  previousUnread: number,
  currentUnread: number,
  effective: SoundPolicy,
): boolean {
  return currentUnread > previousUnread && normalizeSound(effective).ring;
}

