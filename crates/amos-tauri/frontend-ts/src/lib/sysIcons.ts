/**
 * sysIcons.ts — small shared vector-icon set in the iOS / SF Symbols spirit.
 *
 * WHY: the UI previously used Emoji / unicode text glyphs (📶 🅱 ✈️ 🔦 🌒 …) for
 * every system icon. Emoji render inconsistently across hosts and can't be tinted
 * with the app accent. These return **raw `<svg>…</svg>` markup strings** so the
 * same single source is consumed by BOTH frameworks, following the established
 * pattern in `lib/appIcon.ts` (Svelte renders via `{@html}`, React via
 * `dangerouslySetInnerHTML`). Icons inherit `currentColor`, so a host <span>
 * can style them (e.g. dim with `opacity-*`).
 *
 * Stroke geometry is adapted from the MIT-licensed Feather/Lucide icon sets so
 * line weight/round-caps stay crisp at tiny status-bar sizes.
 */

export type SysIconName =
  | "wifi"
  | "bluetooth"
  | "airplane"
  | "moon"
  | "mutedBell"
  | "flashlight"
  | "location"
  | "appearance"
  | "search"
  | "pencil"
  | "lock"
  | "recents"
  | "x";

/** Radio quick-setting kind → status icon (mirrors `lib/settings` RadioKind). */
const RADIO_TO_ICON: Record<string, SysIconName> = {
  airplane: "airplane",
  wifi: "wifi",
  bluetooth: "bluetooth",
};

/** Map a radio kind from `radioIcons()` to its vector glyph name. */
export function radioIcon(kind: string): SysIconName {
  return RADIO_TO_ICON[kind] ?? "wifi";
}

/**
 * Map a quick-settings key (`lib/settings` QuickKey) to its Control-Center icon.
 * `darkmode` (appearance half-disc) is kept visually distinct from `dnd` (moon).
 */
export function quickIcon(key: string): SysIconName {
  switch (key) {
    case "airplane":
      return "airplane";
    case "wifi":
      return "wifi";
    case "bluetooth":
      return "bluetooth";
    case "darkmode":
      return "appearance";
    case "dnd":
      return "moon";
    case "location":
      return "location";
    default:
      return "wifi";
  }
}

/** Common stroke attributes tuned for a 24-viewBox, ~1em inline glyph. */
function svgStroke(inner: string, cls: string): string {
  return (
    `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true" ` +
    `fill="none" stroke="currentColor" stroke-width="1.9" ` +
    `stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
  );
}

const INNER: Record<SysIconName, string> = {
  wifi:
    '<path d="M5 12.55a11 11 0 0 1 14.08 0"/>' +
    '<path d="M1.42 9a16 16 0 0 1 21.16 0"/>' +
    '<path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>' +
    '<path d="M12 20h.01"/>',
  bluetooth: '<path d="m7 7 10 10-5 5V2l5 5L7 17"/>',
  airplane:
    '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  moon: '<path d="M12 3a6 6 0 1 0 9 9 9 9 0 0 1-9-9Z"/>',
  mutedBell:
    '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/>' +
    '<path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 1.7-3.34"/>' +
    '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>' +
    '<path d="m2 2 20 20"/>',
  // A compact diagonal torch (tilted handle + lit bulb) shown when the torch is on.
  flashlight:
    '<g transform="rotate(-45 12 12)">' +
    '<rect x="4" y="10" width="11" height="4" rx="2"/>' +
    '<circle cx="18" cy="12" r="2.2" fill="currentColor" stroke="none"/>' +
    "</g>",
  location:
    '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>' +
    '<circle cx="12" cy="10" r="3"/>',
  appearance:
    '<circle cx="12" cy="12" r="9"/>' +
    '<path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="7.5"/><path d="m20.5 20.5-4.3-4.3"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  lock: '<rect x="3.5" y="11" width="17" height="10" rx="2.5"/><path d="M7.5 11V7a4.5 4.5 0 0 1 9 0v4"/>',
  recents:
    '<rect x="8.5" y="8.5" width="13" height="13" rx="2.2"/>' +
    '<path d="M5.5 15H4.2A2.2 2.2 0 0 1 2 12.8V4.2A2.2 2.2 0 0 1 4.2 2h8.6A2.2 2.2 0 0 1 15 4.2v1.3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
};

/** Render a named icon as an SVG markup string. */
export function iconSvg(name: SysIconName, cls = "h-3.5 w-3.5"): string {
  return svgStroke(INNER[name], cls);
}

/**
 * Battery glyph whose inner fill tracks the live percentage. The numeric % is
 * rendered separately by the caller (the icon itself is aria-hidden).
 */
export function batterySvg(percent: number, cls = "h-3 w-3"): string {
  const p = Math.max(0, Math.min(100, percent));
  const OUTER =
    '<rect x="1.2" y="7.6" width="17.6" height="8.8" rx="2.6"/>' +
    '<rect x="19" y="9.8" width="3" height="4.4" rx="1.4"/>';
  const fillW = 14.4 * (p / 100);
  const FILL =
    p > 0
      ? `<rect x="2.6" y="9" width="${Math.max(fillW, 1.4).toFixed(2)}" height="6" rx="1.6" fill="currentColor" stroke="none"/>`
      : "";
  return svgStroke(OUTER + FILL, cls);
}
