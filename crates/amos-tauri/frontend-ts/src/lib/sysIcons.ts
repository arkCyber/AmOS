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

import type { BatteryTone } from "./batteryStatus";

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
  | "x"
  | "play"
  | "pause"
  | "skipBack"
  | "skipForward"
  | "repeat"
  | "messageCircle"
  | "musicNote"
  | "headphones"
  | "trash"
  | "send"
  | "reply"
  | "phone"
  | "mic"
  | "micOff"
  | "record"
  | "stop"
  | "delete"
  | "check"
  | "rotateCcw"
  | "dialpad"
  | "archive"
  | "shuffle"
  | "volume"
  | "volumeX"
  | "maximize"
  | "film";

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
  play:
    '<path d="M8 5.7v12.6a.6.6 0 0 0 .92.5l10-6.3a.6.6 0 0 0 0-1L8.92 5.2a.6.6 0 0 0-.92.5Z" fill="currentColor" stroke="none"/>',
  pause:
    '<path d="M7 5.4h3.4v13.2H7zM13.6 5.4H17v13.2h-3.4z" fill="currentColor" stroke="none"/>',
  skipBack:
    '<path d="M6 5.4h2.3v13.2H6z" fill="currentColor" stroke="none"/>' +
    '<path d="M18 5.6v12.8a.55.55 0 0 1-.87.46L9.4 12.5a.6.6 0 0 1 0-.97l7.73-6.38a.55.55 0 0 1 .87.46Z" fill="currentColor" stroke="none"/>',
  skipForward:
    '<path d="M15.7 5.4H18v13.2h-2.3z" fill="currentColor" stroke="none"/>' +
    '<path d="M6 5.6v12.8a.55.55 0 0 0 .87.46l7.73-6.38a.6.6 0 0 0 0-.97L6.87 5.14A.55.55 0 0 0 6 5.6Z" fill="currentColor" stroke="none"/>',
  repeat:
    '<path d="m17 2 4 4-4 4"/>' +
    '<path d="M3 11v-1a4 4 0 0 1 4-4h14"/>' +
    '<path d="m7 22-4-4 4-4"/>' +
    '<path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  messageCircle: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  musicNote: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  headphones:
    '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z"/>' +
    '<path d="M21 14h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-5Z"/>' +
    '<path d="M3 14v-3a9 9 0 0 1 18 0v3"/>',
  trash:
    '<path d="M3 6h18"/>' +
    '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
    '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
    '<path d="M10 11v6M14 11v6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  reply: '<path d="M9 14 4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  phone:
    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  mic:
    '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>' +
    '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  micOff:
    '<path d="m1 1 22 22"/>' +
    '<path d="M9 9v3a3 3 0 0 0 5.12 2.12"/>' +
    '<path d="M15 9.34V5a3 3 0 0 0-5.94-.6"/>' +
    '<path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>' +
    '<path d="M12 19v3"/>',
  record: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.6" fill="currentColor" stroke="none"/>',
  delete:
    '<path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z"/>' +
    '<path d="m18 9-6 6M12 9l6 6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  rotateCcw:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>' +
    '<path d="M3 3v5h5"/>',
  dialpad:
    '<circle cx="6.6" cy="5.4" r="1.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="5.4" r="1.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="17.4" cy="5.4" r="1.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="6.6" cy="12" r="1.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="17.4" cy="12" r="1.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="6.6" cy="18.6" r="1.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="18.6" r="1.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="17.4" cy="18.6" r="1.3" fill="currentColor" stroke="none"/>',
  archive:
    '<rect x="2" y="3.5" width="20" height="5" rx="1.2"/>' +
    '<path d="M4 8.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.5"/>' +
    '<path d="M10 12.5h4"/>',
  shuffle:
    '<path d="M16 3h5v5"/>' +
    '<path d="M4 20 21 3"/>' +
    '<path d="M21 16v5h-5"/>' +
    '<path d="m15 15 6 6"/>' +
    '<path d="m4 4 5 5"/>',
  volume:
    '<path d="M11 5 6 9H2v6h4l5 4z"/>' +
    '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>' +
    '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  volumeX:
    '<path d="M11 5 6 9H2v6h4l5 4z"/>' +
    '<path d="m22 9-6 6"/>' +
    '<path d="m16 9 6 6"/>',
  maximize:
    '<path d="M8 3H5a2 2 0 0 0-2 2v3"/>' +
    '<path d="M21 8V5a2 2 0 0 0-2-2h-3"/>' +
    '<path d="M3 16v3a2 2 0 0 0 2 2h3"/>' +
    '<path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  film:
    '<rect x="2" y="3" width="20" height="18" rx="2"/>' +
    '<path d="M7 3v18M17 3v18M2 9h5M2 15h5M17 9h5M17 15h5"/>',
};

/** Render a named icon as an SVG markup string. */
export function iconSvg(name: SysIconName, cls = "h-3.5 w-3.5"): string {
  return svgStroke(INNER[name], cls);
}

/**
 * Battery glyph whose inner fill tracks the live percentage. The numeric % is
 * rendered separately by the caller (the icon itself is aria-hidden).
 *
 * `tone` maps onto the iOS colouring so a REAL reading is legible at a glance:
 * charging → green, critical (≤10%, draining) → red, low (≤20%, draining) →
 * amber, ok → the neutral `currentColor`, and unknown → an empty outline (the
 * caller passes 0). Callers that don't care (the legacy cosmetic React bar)
 * omit `tone` and keep the neutral currentColor fill, so this stays backward
 * compatible.
 */
export function batterySvg(
  percent: number,
  cls = "h-3 w-3",
  tone: BatteryTone = "ok",
): string {
  const p = Math.max(0, Math.min(100, percent));
  const OUTER =
    '<rect x="1.2" y="7.6" width="17.6" height="8.8" rx="2.6"/>' +
    '<rect x="19" y="9.8" width="3" height="4.4" rx="1.4"/>';
  const fill =
    tone === "charging"
      ? "#34c759"
      : tone === "critical"
        ? "#ff3b30"
        : tone === "low"
          ? "#ffcc00"
          : tone === "unknown"
            ? "none"
            : "currentColor";
  const drawFill = p > 0 && tone !== "unknown";
  const fillW = 14.4 * (p / 100);
  const FILL = drawFill
    ? `<rect x="2.6" y="9" width="${Math.max(fillW, 1.4).toFixed(2)}" height="6" rx="1.6" fill="${fill}" stroke="none"/>`
    : "";
  return svgStroke(OUTER + FILL, cls);
}
