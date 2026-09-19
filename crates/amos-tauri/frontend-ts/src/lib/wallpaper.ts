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
  // id is always a known built-in key (choice validated above, or dark/light).
  return WALLPAPER_FILES[id] ?? "wallpaper-dark.png";
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

/**
 * 桌面背景 fallback 颜色 —— 当壁纸图尚未加载、或加载失败时显示的纯色。
 *
 * 设计意图：**不**用纯黑（`#000` / `#1a1a1a`），而是用 macOS 风格的中性灰，
 * 因为 macOS 真机的 `NSColor.windowBackgroundColor` 在 dark mode 下也是
 * `#1e1e1e` 附近、不是死黑（Apple 的 Human Interface Guidelines 明确
 * 「avoid pure black」—— OLED 上会出 letterboxing artifacts，也会让
 * 用户的壁纸看起来像被裁了）。
 *
 * 这是**唯一真源**：DesktopShell 容器 / Backdrop / 任何需要 fallback 的地方
 * 都必须 import 这个函数，不许写第二份（与 `lib/desktopLayout.ts::TOPBAR_HEIGHT`
 * 的「唯一真源」纪律同源 —— `src/__tests__/wallpaper.test.ts` 的两条结构性负控
 * 钉此）。
 *
 * 返回值是 hex 字面值，**不带** `rgb(...)` 包装 —— 调用方按需用：
 *   - 容器背景：直接写 `style="background: <color>;"`
 *   - Backdrop：在 `background-image` 之前写 `<color>` 作 fallback
 */
export function wallpaperFallbackColor(dark: boolean): string {
  // macOS dark: NSColor.windowBackgroundColor ≈ #1e1e1e（macOS 14 实测）
  // macOS light: NSColor.windowBackgroundColor ≈ #ececec（macOS 14 实测）
  // 这两个值与 Apple 官方 Color and Typography 文档一致（HIG §Color）
  return dark ? "#1e1e1e" : "#ececec";
}

export function isBgMode(id: string | undefined): id is BgModeId {
  return BACKGROUND_MODES.some((m) => m.id === id);
}
export function bgMode(id: string | undefined): BgStyle {
  const m = BACKGROUND_MODES.find((x) => x.id === id);
  if (m) return m.style;
  const fallback = BACKGROUND_MODES[0];
  return fallback
    ? fallback.style
    : { alpha: 0.58, blur: 9, sat: 0.92, bright: 1.02 }; // ghost default if list empty
}
