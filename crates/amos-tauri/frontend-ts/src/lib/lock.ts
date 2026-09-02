export interface LockCfg {
  enabled: boolean;
  pin?: string;
}

export const LOCK_KEY = "amos.lock";

/** Lock-screen passcode policy (4–6 digits). */
export const PIN_MIN = 4;
export const PIN_MAX = 6;

/** Keep only digits, capped (default 6). */
export function sanitizePin(raw: string, max = PIN_MAX): string {
  return raw.replace(/\D/g, "").slice(0, max);
}

/** A typed PIN is acceptable only when it meets the 4–6 digit policy. */
export function validPin(raw: string): boolean {
  const n = sanitizePin(raw).length;
  return n >= PIN_MIN && n <= PIN_MAX;
}

/**
 * Build the config to persist from the toggle + entered digits + previous pin.
 *
 * Policy (aerospace-grade): the lock is only ever *enabled* with a usable
 * 4–6 digit passcode. Enabling without one (empty or too-short input and no
 * previous pin) is refused rather than producing an unlockable-less enabled
 * lock. Empty input keeps the previous valid pin.
 */
export function makeLock(enabled: boolean, pinRaw: string, prev: LockCfg): LockCfg {
  if (!enabled) return { enabled: false };
  const typed = sanitizePin(pinRaw);
  if (typed) {
    if (!validPin(typed)) {
      // Invalid new/changed pin: refuse the enable/change (keep current state).
      return prev.enabled && prev.pin ? { enabled: true, pin: prev.pin } : { enabled: false };
    }
    return { enabled: true, pin: typed };
  }
  // Nothing typed: reuse the previous pin if there was a valid one.
  if (prev.enabled && prev.pin) return { enabled: true, pin: prev.pin };
  // Enabling with no pin and no previous pin would leave the lock un-unlockable.
  return { enabled: false };
}
