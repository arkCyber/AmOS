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

/** Corruption / back-compat guard for a stored playlist. Drops entries without a
 * usable id+title, back-fills ids, and de-duplicates collisions. */
export function normalizeTracks(list: unknown): Track[] {
  if (!Array.isArray(list)) return [];
  const out: Track[] = [];
  const seen = new Set<string>();
  let seq = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.title !== "string" || o.title.trim() === "") continue;
    let id = typeof o.id === "string" && o.id ? o.id : `t-${seq++}`;
    let k = 1;
    while (seen.has(id)) id = `${id}-${k++}`;
    seen.add(id);
    const t: Track = { id, title: o.title, artist: typeof o.artist === "string" ? o.artist : "" };
    out.push(t);
  }
  return out;
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

export type RepeatMode = "off" | "all" | "one";

/** Next/prev index honouring the repeat mode:
 * - "one": stay on the current track (repeat single),
 * - "off": stop at either end (no wrap),
 * - "all": wrap around the playlist.
 */
export function nextIndex(index: number, total: number, delta: number, mode: RepeatMode): number {
  if (total <= 0) return 0;
  if (mode === "one") return index;
  if (mode === "off") {
    const x = index + delta;
    return Math.max(0, Math.min(total - 1, x));
  }
  return stepIndex(index, total, delta);
}

/** Playback progress as a 0..1 fraction (bounded for safety). */
export function pctProgress(sec: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, sec / total));
}

/** Convert a 0..1 click fraction into a seeked second (bounded, clamped). */
export function seekSeconds(pct: number, total: number): number {
  if (total <= 0) return 0;
  const c = Math.max(0, Math.min(1, pct));
  return Math.min(total, Math.floor(c * total));
}

/** Short neutral lyric lines for the demo player (no copyrighted material). */
export const DEMO_LYRICS = [
  "灯光在夜色里流动",
  "窗外的风带起回忆",
  "听见心跳的节拍",
  "我们走向下个路口",
  "这首歌还没有结束",
];

/** Which lyric line is active at `sec` (evenly spread across `total`, clamped). */
export function lyricIndex(sec: number, total: number, lines: number): number {
  if (lines <= 0) return 0;
  const c = Math.max(0, Math.min(1, total <= 0 ? 0 : sec / total));
  return Math.min(lines - 1, Math.floor(c * lines));
}

/** Remove a track by id (non-mutating); missing ids return an unchanged copy. */
export function removeTrack(list: Track[], id: string): Track[] {
  return list.filter((t) => t.id !== id);
}

/** Recompute the current index after `removedIndex` is removed from a playlist
 * that now has `newLength` entries. Keeps the same track playing when possible:
 * - a track after the removed one stays put,
 * - a track before it shifts one slot left,
 * - removing the *currently playing* one lands on whatever now occupies that slot
 *   (falling back to the new last entry / 0). Never out of range, never NaN.
 */
export function nextIndexAfterRemoval(current: number, removedIndex: number, newLength: number): number {
  if (newLength <= 0) return 0;
  let next = current;
  if (removedIndex >= 0 && removedIndex < current) next = current - 1;
  else if (removedIndex === current) next = current; // next track slides into this slot
  if (next < 0) next = 0;
  if (next > newLength - 1) next = newLength - 1;
  return next;
}
