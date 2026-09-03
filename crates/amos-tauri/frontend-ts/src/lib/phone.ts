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
