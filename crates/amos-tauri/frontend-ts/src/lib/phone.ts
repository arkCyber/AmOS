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
 * The dial string a search/text query really is, or `null` when it is not a number.
 *
 * Used by Spotlight's "fill the dialler" action: only a query that **looks like** a
 * dialable number offers it (digits with `+ * #` and the usual separators, at least two
 * digits), so a search for "买牛奶" never pretends to be a phone number. The result is
 * the string with separators removed (what a dialler sends), capped at `MAX_DIAL_LEN`.
 */
export function dialableQuery(q: string): string | null {
  const raw = q.trim();
  if (raw === "") return null;
  if (!/^\+?[0-9*#()\-.\s]+$/.test(raw)) return null;
  const digits = raw.replace(/[^0-9*#+]/g, "");
  if ((digits.match(/[0-9]/g) ?? []).length < 2) return null;
  return digits.slice(0, MAX_DIAL_LEN);
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
