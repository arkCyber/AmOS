export interface Photo {
  id: string;
  ts: number;
  /** Real image data URL when captured by the camera (video frame -> canvas). */
  data?: string;
  a?: string; // gradient start (demo/gradient tiles only)
  b?: string; // gradient end
  emoji?: string; // demo/gradient tile glyph
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

/** A random demo/gradient photo (fallback when no camera is available). */
export function newPhoto(id: string, now: number): Photo {
  const i = Math.floor(Math.random() * PALETTE.length);
  return {
    id,
    a: PALETTE[i][0],
    b: PALETTE[i][1],
    emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)],
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

export function removePhoto(list: Photo[], id: string): Photo[] {
  return list.filter((p) => p.id !== id);
}
