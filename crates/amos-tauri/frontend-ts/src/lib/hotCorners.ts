/**
 * hotCorners.ts — macOS-style Hot Corners configuration and detection logic.
 *
 * Pure functions for hot zone detection, modifier matching, and configuration
 * management. The listener component (HotCornersListener.svelte) consumes these.
 *
 * **Aerospace-grade design**:
 * - Pure functions (testable without DOM)
 * - No polling (event-driven mousemove)
 * - Debounced via delay timers
 * - Modifier key support for accidental-activation prevention
 */

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type HotCornerAction =
  | "mission-control"
  | "launchpad"
  | "desktop"
  | "lock-screen"
  | "notification-center"
  | "disabled";

export interface HotCornerConfig {
  corner: Corner;
  action: HotCornerAction;
  /** Optional modifier key that must be held (prevents accidental triggers). */
  modifier?: "shift" | "control" | "alt" | "meta";
  /** Hover delay in milliseconds before action triggers (default 500). */
  delay: number;
}

export const HOT_CORNER_KEY = "amos.hotcorners";

/** Default configuration: top-left = Mission Control, bottom-left = Launchpad. */
export const DEFAULT_HOT_CORNERS: HotCornerConfig[] = [
  { corner: "top-left", action: "mission-control", delay: 500 },
  { corner: "top-right", action: "disabled", delay: 500 },
  { corner: "bottom-left", action: "launchpad", delay: 500 },
  { corner: "bottom-right", action: "disabled", delay: 500 },
];

/**
 * Check if mouse coordinates are within the hot zone for a given corner.
 *
 * @param x Mouse X coordinate (relative to viewport)
 * @param y Mouse Y coordinate (relative to viewport)
 * @param screenW Viewport width (window.innerWidth)
 * @param screenH Viewport height (window.innerHeight)
 * @param corner Which corner to check
 * @param zoneSize Size of the hot zone in pixels (default 15×15)
 * @returns true if (x,y) is inside the hot zone
 */
export function isInHotZone(
  x: number,
  y: number,
  screenW: number,
  screenH: number,
  corner: Corner,
  zoneSize = 15,
): boolean {
  switch (corner) {
    case "top-left":
      return x <= zoneSize && y <= zoneSize;
    case "top-right":
      return x >= screenW - zoneSize && y <= zoneSize;
    case "bottom-left":
      return x <= zoneSize && y >= screenH - zoneSize;
    case "bottom-right":
      return x >= screenW - zoneSize && y >= screenH - zoneSize;
  }
}

/**
 * Check if the required modifier key (if any) is pressed.
 *
 * @param e Mouse event
 * @param required Required modifier key, or undefined for no requirement
 * @returns true if the modifier matches (or no modifier is required)
 */
export function modifierMatches(
  e: MouseEvent,
  required?: "shift" | "control" | "alt" | "meta",
): boolean {
  if (!required) return true;
  switch (required) {
    case "shift":
      return e.shiftKey;
    case "control":
      return e.ctrlKey;
    case "alt":
      return e.altKey;
    case "meta":
      return e.metaKey;
  }
}

/**
 * Normalize hot corners configuration from stored data.
 * Tolerates malformed data by falling back to defaults.
 */
export function normalizeHotCorners(raw: unknown): HotCornerConfig[] {
  if (!Array.isArray(raw)) return DEFAULT_HOT_CORNERS;
  const out: HotCornerConfig[] = [];
  const seenCorners = new Set<Corner>();

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;

    const corner = o.corner as Corner;
    if (!["top-left", "top-right", "bottom-left", "bottom-right"].includes(corner)) continue;
    if (seenCorners.has(corner)) continue; // duplicate corner

    const action = o.action as HotCornerAction;
    if (
      ![
        "mission-control",
        "launchpad",
        "desktop",
        "lock-screen",
        "notification-center",
        "disabled",
      ].includes(action)
    )
      continue;

    const modifier = o.modifier as HotCornerConfig["modifier"] | undefined;
    if (modifier && !["shift", "control", "alt", "meta"].includes(modifier)) continue;

    const delay =
      typeof o.delay === "number" && Number.isFinite(o.delay) && o.delay >= 0 ? o.delay : 500;

    out.push({ corner, action, modifier, delay });
    seenCorners.add(corner);
  }

  // Back-fill missing corners with defaults
  for (const def of DEFAULT_HOT_CORNERS) {
    if (!seenCorners.has(def.corner)) out.push(def);
  }

  return out;
}
