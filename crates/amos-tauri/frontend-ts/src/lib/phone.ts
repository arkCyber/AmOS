export const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

/** E.164 dial strings can be up to 15 digits; leave headroom for "+<cc>". */
export const MAX_DIAL_LEN = 18;

/** Append a key, but never grow beyond MAX_DIAL_LEN (mirrors a real dialer). */
export function pushKey(number: string, k: string): string {
  if (number.length >= MAX_DIAL_LEN) return number;
  return number + k;
}
export function backspace(number: string): string {
  return number.slice(0, -1);
}
export function clearDial(number: string): string {
  return number.slice(0, 0);
}

/**
 * Format an elapsed call duration in seconds as `m:ss` (or `h:mm:ss` past an hour).
 * Pure + deterministic so the in-call timer is unit-testable offline.
 */
export function fmtCallDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${m}:${pad(sec)}`;
}
