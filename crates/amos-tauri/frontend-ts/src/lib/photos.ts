export interface Photo {
  id: string;
  a: string; // gradient start
  b: string; // gradient end
  emoji: string;
  ts: number;
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
  return Array.from({ length: count }, (_, i) => ({
    id: `seed-${i}`,
    a: PALETTE[i % PALETTE.length][0],
    b: PALETTE[i % PALETTE.length][1],
    emoji: EMOJIS[i % EMOJIS.length],
    ts: now - i * 86400000,
  }));
}

/** A random new photo (as a real capture or the demo fallback). */
export function newPhoto(id: string, now: number): Photo {
  const i = Math.floor(Math.random() * PALETTE.length);
  return { id, a: PALETTE[i][0], b: PALETTE[i][1], emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)], ts: now };
}

export function removePhoto(list: Photo[], id: string): Photo[] {
  return list.filter((p) => p.id !== id);
}
