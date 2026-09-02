/**
 * Wallpaper + "background display method" (show faint/clear) — pure resolution
 * so it can be unit-tested and shared between Settings and the Backdrop layer.
 */
export type WallpaperChoice = string; // preset id or custom URL
export type BgModeId = "ghost" | "soft" | "muted" | "vivid";

export const WALLPAPER_FILES: Record<string, string> = {
  dark: "wallpaper-dark.png",
  light: "wallpaper-light.png",
  landscape: "wallpaper-landscape.png",
  dawn: "wallpaper-dawn.png",
  abyss: "wallpaper-abyss.png",
};

/** Built-in wallpapers (id → i18n key). */
export const WALLPAPER_PRESETS = ["auto", "dark", "light", "landscape", "dawn", "abyss"] as const;

/**
 * A "custom wallpaper" is only accepted from safe image sources: http(s),
 * blob, or a data:-URL of an image type. Everything else (`file:`,
 * `javascript:`, `data:text/html`, …) is rejected so an injected value can never
 * become a script surface or a local-file read.
 */
export function isCustomWallpaper(w: string): boolean {
  return /^(https?:|blob:|data:image\/)/.test(w);
}

/** Which image file to show for a theme + user choice. Returns a URL or custom src. */
export function resolveWallpaper(dark: boolean, choice: string | undefined): string {
  if (choice && isCustomWallpaper(choice)) return choice;
  const id = choice && WALLPAPER_FILES[choice] ? choice : dark ? "dark" : "light";
  return WALLPAPER_FILES[id];
}

/** Display methods: alpha / blur / saturation / brightness CSS for the layer. */
export interface BgStyle {
  alpha: number;
  blur: number;
  sat: number;
  bright: number;
}
export const BACKGROUND_MODES: { id: BgModeId; style: BgStyle }[] = [
  { id: "ghost", style: { alpha: 0.58, blur: 9, sat: 0.92, bright: 1.02 } },
  { id: "soft", style: { alpha: 0.8, blur: 3, sat: 1.0, bright: 1.05 } },
  { id: "muted", style: { alpha: 0.42, blur: 14, sat: 0.6, bright: 0.96 } },
  { id: "vivid", style: { alpha: 0.95, blur: 0, sat: 1.08, bright: 1.0 } },
];
export const DEFAULT_BG_MODE: BgModeId = "ghost";

export function isBgMode(id: string | undefined): id is BgModeId {
  return BACKGROUND_MODES.some((m) => m.id === id);
}
export function bgMode(id: string | undefined): BgStyle {
  const m = BACKGROUND_MODES.find((x) => x.id === id);
  return m ? m.style : BACKGROUND_MODES[0].style;
}
