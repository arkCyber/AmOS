export const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

export function pushKey(number: string, k: string): string {
  return number + k;
}
export function backspace(number: string): string {
  return number.slice(0, -1);
}
export function clearDial(number: string): string {
  return number.slice(0, 0);
}
