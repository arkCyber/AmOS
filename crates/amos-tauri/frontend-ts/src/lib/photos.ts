export interface Photo {
  id: string;
  ts: number;
  /** Real image data URL when captured by the camera (video frame -> canvas). */
  data?: string;
  a?: string; // gradient start (demo/gradient tiles only)
  b?: string; // gradient end
  emoji?: string; // demo/gradient tile glyph
  /** Favourite (heart): kept when persisted; absent = not favourited. */
  fav?: boolean;
}

export const PHOTOS_KEY = "amos.photos";

export const PALETTE: [string, string][] = [
  ["#f94144", "#f3722c"],
  ["#f8961e", "#f9c74f"],
  ["#90be6d", "#43aa8b"],
  ["#4d908e", "#577590"],
  ["#9b5de5", "#f15bb5"],
  ["#00bbf9", "#00f5d4"],
  ["#277da1", "#43aa8b"],
  ["#f15bb5", "#fee440"],
];
export const EMOJIS = ["🌅", "🏔️", "🌌", "🌸", "🏙️", "🌊", "🌵", "🎈"];

/** Deterministic seed (indexed through palette/emoji) — test-friendly. */
export function seedPhotos(count: number, now: number): Photo[] {
  return Array.from({ length: count }, (_, i) => {
    const pal = PALETTE[i % PALETTE.length];
    const emoji = EMOJIS[i % EMOJIS.length];
    return {
      id: `seed-${i}`,
      a: pal?.[0],
      b: pal?.[1],
      emoji,
      ts: now - i * 86400000,
    };
  });
}

/** A random demo/gradient photo (fallback when no camera is available). */
export function newPhoto(id: string, now: number): Photo {
  const pal = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  return {
    id,
    a: pal?.[0],
    b: pal?.[1],
    emoji,
    ts: now,
  };
}

/** A real camera capture (video frame -> JPEG data URL). */
export function newCapturePhoto(id: string, now: number, data: string): Photo {
  return { id, data, ts: now };
}

/** True when the photo is a real captured image (has pixel data). */
export function isRealPhoto(p: Photo): boolean {
  return !!p.data;
}

/** Process-local counter so back-filled photo ids stay unique/deterministic. */
let photoSeq = 0;

/**
 * Corruption / back-compat guard: coerce any stored array into a valid `Photo[]`.
 * Drops entries that aren't objects with any recognisable content (id / emoji /
 * gradient / data), back-fills missing ids, and de-duplicates id collisions —
 * so a corrupted `amos.photos` can never break grids / viewer navigation.
 */
export function normalizePhotos(list: unknown): Photo[] {
  if (!Array.isArray(list)) return [];
  const out: Photo[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const hasEmoji = typeof o.emoji === "string";
    const hasData = typeof o.data === "string";
    const hasPal = typeof o.a === "string" && typeof o.b === "string";
    const hasId = typeof o.id === "string" && o.id !== "";
    if (!hasId && !hasEmoji && !hasData && !hasPal) continue; // nothing recognisable
    let id = hasId ? (o.id as string) : `n-${Date.now().toString(36)}-${photoSeq++}`;
    let k = 1;
    while (seen.has(id)) id = `${id}-${k++}`;
    seen.add(id);
    const p: Photo = {
      id,
      ts: typeof o.ts === "number" && Number.isFinite(o.ts) ? o.ts : 0,
    };
    if (typeof o.data === "string") p.data = o.data;
    if (typeof o.a === "string") p.a = o.a;
    if (typeof o.b === "string") p.b = o.b;
    if (typeof o.emoji === "string") p.emoji = o.emoji;
    if (typeof o.fav === "boolean") p.fav = o.fav;
    out.push(p);
  }
  return out;
}

export function removePhoto(list: Photo[], id: string): Photo[] {
  return list.filter((p) => p.id !== id);
}

/** Toggle the favourite heart on one photo (new array; no-op if id missing). */
export function toggleFav(list: Photo[], id: string): Photo[] {
  if (!list.some((p) => p.id === id)) return list;
  return list.map((p) => (p.id === id ? { ...p, fav: !p.fav } : p));
}

/** Only the favourited photos. */
export function favsOf(list: Photo[]): Photo[] {
  return list.filter((p) => p.fav);
}

/** Human-readable caption copied when a user "shares" a photo (pure, so it's
 * headlessly testable). Real captures include their timestamp; gradient tiles
 * carry their emoji. */
export function shareCaption(p: Photo, tsText: string): string {
  const head = p.data ? `📷 ${tsText}` : `${p.emoji ?? "🖼"} ${tsText}`;
  return `${head}\n— shared from Amos`;
}

/** Remove every photo whose id is in `ids` (batch delete). Empty set is a
 * no-op returning the input unchanged. */
export function removePhotos(list: Photo[], ids: ReadonlySet<string>): Photo[] {
  if (ids.size === 0) return list;
  return list.filter((p) => !ids.has(p.id));
}

/** The photo at `delta` steps (wraps around) from `id`, or null when the list
 * has fewer than two photos or `id` is absent. */
export function neighborOf(list: Photo[], id: string, delta: 1 | -1): Photo | null {
  if (list.length < 2) return null;
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const n = list.length;
  return list[(((i + delta) % n) + n) % n] ?? null;
}
