export interface Track {
  id: string;
  title: string;
  artist: string;
}

export const MUSIC_KEY = "amos.music";

export function seedTracks(): Track[] {
  return [
    { id: "m1", title: "晨光", artist: "Amos 合成器" },
    { id: "m2", title: "星河", artist: "Amos 合成器" },
    { id: "m3", title: "晚风", artist: "Amos 合成器" },
  ];
}

/** Wrap an index into [0, n). Returns 0 for an empty/non-positive collection
 * (never NaN). */
export function wrap(i: number, n: number): number {
  if (!(n > 0)) return 0;
  return ((i % n) + n) % n;
}

/** Next/prev playlist index (wraps). */
export function stepIndex(index: number, total: number, delta: number): number {
  return wrap(index + delta, total);
}
