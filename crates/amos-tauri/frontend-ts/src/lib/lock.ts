export interface LockCfg {
  enabled: boolean;
  pin?: string;
}

export const LOCK_KEY = "amos.lock";

/** Keep only digits, capped (default 6). */
export function sanitizePin(raw: string, max = 6): string {
  return raw.replace(/\D/g, "").slice(0, max);
}

/** Build the config to persist from the toggle + entered digits + previous pin. */
export function makeLock(enabled: boolean, pinRaw: string, prev: LockCfg): LockCfg {
  if (!enabled) return { enabled: false };
  const pin = sanitizePin(pinRaw);
  return { enabled: true, pin: pin || prev.pin };
}
