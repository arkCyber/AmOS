/**
 * Notification sound / vibration policy (the "策略位" behind the quick toggles).
 *
 * Two persisted policy bits under `amos.sound`: whether audible alerts ("ring")
 * and haptics ("vibrate") are allowed for notifications. Both default ON. Do-Not-
 * Disturb is a higher-level gate: when it is active, both are muted regardless
 * of the persisted bits (see `effectiveAlert`).
 */
import { readStoreValue, writeStoreValue } from "./amosStore";

/** Shared-store key under which the sound policy is persisted. */
export const SOUND_KEY = "amos.sound";

/** The two alert policy bits. */
export interface SoundPolicy {
  /** Audible (ring) notifications allowed. */
  ring: boolean;
  /** Haptic (vibrate) notifications allowed. */
  vibrate: boolean;
}

/** Keep only well-formed policy bits; anything else falls back to ON. */
export function normalizeSound(raw: unknown): SoundPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ring: true, vibrate: true };
  }
  const o = raw as Record<string, unknown>;
  return {
    ring: typeof o.ring === "boolean" ? o.ring : true,
    vibrate: typeof o.vibrate === "boolean" ? o.vibrate : true,
  };
}

/** Default policy: both alerts allowed. */
export const DEFAULT_SOUND: SoundPolicy = { ring: true, vibrate: true };

/** Load the policy from the (durable) shared store. */
export function loadSound(): SoundPolicy {
  return normalizeSound(readStoreValue<unknown>(SOUND_KEY, {}));
}

/** Persist the policy to the (durable) shared store. */
export function saveSound(policy: SoundPolicy): void {
  writeStoreValue(SOUND_KEY, normalizeSound(policy));
}

/** Effective alerts under DND: DND mutes both ring and vibration. */
export function effectiveAlert(policy: SoundPolicy, dnd: boolean): SoundPolicy {
  return dnd ? { ring: false, vibrate: false } : normalizeSound(policy);
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

