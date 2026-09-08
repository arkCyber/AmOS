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

/** Batch-set the favourite flag on every photo whose id is in `ids` (like the
 * iOS "Favourite" action in multi-select). New array; returns the input when the
 * set is empty. */
export function setFavs(list: Photo[], ids: ReadonlySet<string>, on: boolean): Photo[] {
  if (ids.size === 0) return list;
  return list.map((p) => {
    if (!ids.has(p.id)) return p;
    const next: Photo = { ...p };
    if (on) next.fav = true;
    else delete next.fav; // clearing → drop the key (invariant: absent = not fav)
    return next;
  });
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

/* ---- iOS "Days" library grouping ------------------------------------------
 * iOS Photos organises the Library as a set of "Days"; the wall is a newest-first
 * list of photos interrupted by section headers that read "Today", "Yesterday",
 * or a concrete date. These helpers compute that grouping in the *viewer's local
 * calendar timezone* — pure + headlessly testable (single source of truth the
 * screen renders). ------------------------------------------------------------------ */

/** Local calendar key (YYYY-MM-DD) for a timestamp, in the current timezone. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Whole-day distance from the local day of `now` to the local day of `ts`:
 * 0 = today, 1 = yesterday, 2+ = earlier (negative for the future). Determined
 * from local midnights so a DST shift cannot push "today" off by one. */
export function dayIndex(ts: number, now: number): number {
  const a = new Date(now);
  a.setHours(0, 0, 0, 0);
  const b = new Date(ts);
  b.setHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

/** Injectable strings/formatting for a section header, so the pure code never
 * touches `Intl`/`t()` directly (test-friendly and locale-driven by the caller). */
export interface DaySectionText {
  today: string;
  yesterday: string;
  /** Format a concrete older date, e.g. `(ts) => new Date(ts).toLocaleDateString()`. */
  date(ts: number): string;
}

export interface DaySection<I> {
  /** Calendar key (YYYY-MM-DD), stable for reactivity keys. */
  key: string;
  /** `dayIndex` of this section (0 today …). */
  day: number;
  /** Header text: Today / Yesterday / concrete date. */
  label: string;
  items: I[];
}

/** One day's header label from its index. */
export function dayLabel(day: number, ts: number, tx: DaySectionText): string {
  if (day === 0) return tx.today;
  if (day === 1) return tx.yesterday;
  return tx.date(ts);
}

/**
 * Bucket newest-first `items` (each carrying a `ts`) into local-day sections,
 * ordered newest day first (today first, then older). Order within a day is the
 * input order (the caller is responsible for it already being newest-first, so
 * the wall stays visually chronological). Pure.
 */
export function groupDays<I extends { ts: number }>(
  items: readonly I[],
  now: number,
  tx: DaySectionText,
): DaySection<I>[] {
  const map = new Map<string, DaySection<I>>();
  for (const it of items) {
    const key = dayKey(it.ts);
    const e = map.get(key);
    if (e) e.items.push(it);
    else {
      const day = dayIndex(it.ts, now);
      map.set(key, { key, day, label: dayLabel(day, it.ts, tx), items: [it] });
    }
  }
  return [...map.values()].sort((a, b) => a.day - b.day);
}
