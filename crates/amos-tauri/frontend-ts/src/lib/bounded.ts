/**
 * Keep only the `max` most-recent items (drop the oldest head), returning a new
 * array. Never mutates the input. Used to bound long-running in-memory lists
 * (chat transcripts, translation segments) so they cannot grow without limit —
 * a deterministic-memory requirement for long-lived sessions.
 */
export function capTail<T>(list: readonly T[], max: number): T[] {
  if (max <= 0) return [];
  return list.length > max ? list.slice(list.length - max) : [...list];
}
