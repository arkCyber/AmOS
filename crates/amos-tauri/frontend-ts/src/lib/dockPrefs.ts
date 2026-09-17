/**
 * Dock preferences and settings (P4).
 *
 * Features:
 * - Position (bottom/left/right)
 * - Auto-hide toggle
 * - Magnification scale
 * - Icon size
 */

import type { DockPosition } from "./dockConfig";

export type { DockPosition };

export interface DockPrefs {
  position: DockPosition;
  autoHide: boolean;
  magnification: number; // 1.0 - 2.0
  iconSize: number; // 32 - 64 (px)
}

export const DEFAULT_DOCK_PREFS: DockPrefs = {
  position: "bottom",
  autoHide: false,
  magnification: 1.5,
  iconSize: 48,
};

/**
 * Store key for dock preferences in amosStore.
 */
export const DOCK_PREFS_KEY = "dock.prefs.v1";

/**
 * Validate and normalize dock preferences.
 */
export function normalizeDockPrefs(raw: unknown): DockPrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DOCK_PREFS };
  const obj = raw as Record<string, unknown>;

  const position = ["bottom", "left", "right"].includes(obj.position as string)
    ? (obj.position as DockPosition)
    : DEFAULT_DOCK_PREFS.position;

  const autoHide = typeof obj.autoHide === "boolean" ? obj.autoHide : DEFAULT_DOCK_PREFS.autoHide;

  const magnification =
    typeof obj.magnification === "number" &&
    obj.magnification >= 1.0 &&
    obj.magnification <= 2.0
      ? obj.magnification
      : DEFAULT_DOCK_PREFS.magnification;

  const iconSize =
    typeof obj.iconSize === "number" && obj.iconSize >= 32 && obj.iconSize <= 64
      ? obj.iconSize
      : DEFAULT_DOCK_PREFS.iconSize;

  return { position, autoHide, magnification, iconSize };
}
