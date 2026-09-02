/** Pure helpers for UI time/status so they can be unit-tested. */
export function fmtClock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Cosmetic battery % (mirrors the legacy status bar countdown). */
export function batteryPercent(d: Date): number {
  return 100 - d.getSeconds();
}
