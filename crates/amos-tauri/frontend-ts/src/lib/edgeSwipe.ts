/**
 * Edge-swipe gesture decisions for the System UI shell (pure, testable).
 *
 * Two OS-style gestures on the home screen:
 *  - pull DOWN from the very top edge  → open the notification center (quick
 *    settings: flashlight, airplane mode, wifi/bt/dark/DND/location toggles);
 *  - pull UP from the bottom edge      → open Recents (recent apps).
 *
 * The home *body* (below the reserved top status edge) additionally accepts a
 * downward swipe to open Spotlight (iPhone "swipe down on Home to search") —
 * see `homeDownToSpotlight`.
 *
 * Only a drag that *starts* in the thin top/bottom edge zone (outside normal
 * scroll/content) counts, so it never fights the app-grid scroll. The panel is
 * fired once per gesture once the finger crosses a vertical threshold toward the
 * gesture's direction (down for top edge, up for bottom edge).
 */

export type Edge = "top" | "bottom";

/** Height of the top "status" edge zone where a downward pull is captured. */
export const EDGE_TOP_PX = 64;
/** Height of the bottom edge zone (home-indicator / dock area) for an upward pull. */
export const EDGE_BOTTOM_PX = 96;
/** Vertical travel required (px) before the edge gesture fires. */
export const EDGE_THRESHOLD_PX = 52;

/** Which edge (if any) a touch at vertical offset `y` within height `h` belongs to. */
export function edgeAtY(y: number, h: number): Edge | null {
  if (y < 0 || h <= 0 || y >= h) return null;
  if (y <= EDGE_TOP_PX) return "top";
  if (y >= h - EDGE_BOTTOM_PX) return "bottom";
  return null;
}

/**
 * Whether a drag that started at `startY` (px) and is now at `y` has crossed the
 * threshold toward its edge's gesture. Top edge = dragging DOWN (y grows); bottom
 * edge = dragging UP (y shrinks). Any off-direction / tiny movement is false.
 */
export function pastEdgeThreshold(edge: Edge, startY: number, y: number): boolean {
  if (edge === "top") return y - startY >= EDGE_THRESHOLD_PX;
  return startY - y >= EDGE_THRESHOLD_PX;
}

/**
 * Home-body downward swipe → Spotlight (iPhone "swipe down on Home to search").
 * Only a downward drag that *starts* in the home body counts: below the reserved
 * top status edge (so it never steals the top-edge → Notification Center pull)
 * and above the bottom zone (so it never conflicts with the dock / an up-swipe
 * toward Recents). The vertical travel must still cross the edge threshold.
 */
export function homeDownToSpotlight(startY: number, y: number, height: number): boolean {
  if (height <= 0 || startY <= EDGE_TOP_PX || startY >= height - EDGE_BOTTOM_PX) return false;
  return y - startY >= EDGE_THRESHOLD_PX;
}
