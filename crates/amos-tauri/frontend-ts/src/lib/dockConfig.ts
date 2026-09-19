/**
 * Dock configuration and advanced features (P2).
 *
 * Features:
 * - Bounce animation for notifications (CSS-only, see index.css)
 * - Auto-hide in fullscreen mode
 * - Position switching (bottom/left/right)
 *
 * REQ-A414 — the position feature used to be "position the wrapper and nothing else".
 * Every other behaviour of the Dock assumed `bottom`: the wrapper hard-coded
 * `height: DOCK_HEIGHT` (which over-constrains a left/right column — `top` + `bottom` +
 * `height` on one axis makes CSS drop `bottom`), the hide animation was always
 * `translateY`, the magnifier tracked `clientX`, the auto-hide reveal only looked at the
 * bottom 80 px, and the capacity was measured across the width. The helpers below are
 * the one place that answers "which edge?" — `Dock.svelte` interpolates them and the
 * unit tests hold them.
 */

import { DOCK_HEIGHT, DOCK_MIN_WIDTH, TOPBAR_HEIGHT } from "./desktopLayout";

// Dock position options (macOS style)
export type DockPosition = "bottom" | "left" | "right";

/**
 * Get the **edge/alignment** classes for a dock position.
 *
 * The box (height vs. vertical span) is not here — it is [`dockWrapperStyle`], because
 * Tailwind cannot see an interpolated length and mixing the two is how a left/right
 * dock ended up with a hard-coded `height` *and* `top`/`bottom`.
 */
export function dockPositionClass(position: DockPosition): string {
  switch (position) {
    case "bottom":
      return "bottom-0 left-0 right-0 justify-center";
    case "left":
      return "left-0 justify-start";
    case "right":
      return "right-0 justify-end";
  }
}

/** True when the Dock is pinned to a side edge and therefore runs **vertically**. */
export function dockIsVertical(position: DockPosition): boolean {
  return position === "left" || position === "right";
}

/**
 * The Dock **wrapper**'s box, per edge.
 *
 * A bottom Dock is a horizontal bar of `DOCK_HEIGHT`; a side Dock is a vertical column
 * spanning from below the menu bar to the bottom edge. The wrapper is absolutely
 * positioned, so giving a side Dock `top` + `bottom` **and** a fixed `height` leaves one
 * axis over-constrained: CSS keeps `height` and drops `bottom`, and the `flex-col`
 * children then overflow a 68 px-tall strip.
 */
export function dockWrapperStyle(position: DockPosition): string {
  return dockIsVertical(position)
    ? `top:${TOPBAR_HEIGHT}px; bottom:0;`
    : `height:${DOCK_HEIGHT}px;`;
}

/**
 * The Dock panel's minimum box: a wide strip at the bottom, a narrow tall column on a
 * side. The two are different constraints (`min-width` vs. `min-height`) — reusing the
 * bottom's `DOCK_MIN_WIDTH` (320 px) for a side Dock would make the column 320 px wide.
 */
export function dockPanelStyle(position: DockPosition): string {
  return dockIsVertical(position)
    ? `min-height:${DOCK_MIN_WIDTH}px;`
    : `min-width:${DOCK_MIN_WIDTH}px;`;
}

/**
 * The transform that slides the Dock off **its own** edge while auto-hidden.
 *
 * `-100%` is a percentage of the panel's own box, so the axis must match the Dock's:
 * a bottom bar slides down by its height, a side column slides sideways by its (narrow)
 * width — enough to clear the screen edge it hugs.
 */
export function dockHideTransform(position: DockPosition, hidden: boolean): string {
  if (!hidden) return "translate(0, 0)";
  switch (position) {
    case "bottom":
      return "translateY(100%)";
    case "left":
      return "translateX(-100%)";
    case "right":
      return "translateX(100%)";
  }
}

/** The viewport axis the magnifier tracks: `x` along a bottom bar, `y` along a side column. */
export function dockMagnifyAxis(position: DockPosition): "x" | "y" {
  return dockIsVertical(position) ? "y" : "x";
}

/**
 * Is the pointer at the screen edge the Dock hides behind? (Auto-hide uses this to
 * reveal.) The check was bottom-only, so a left/right Dock with auto-hide could never
 * come back: it hid correctly and the one gesture that should restore it was
 * unreachable.
 */
export function dockRevealZone(
  position: DockPosition,
  x: number,
  y: number,
  viewportW: number,
  viewportH: number,
  threshold = 80,
): boolean {
  switch (position) {
    case "bottom":
      return y > viewportH - threshold;
    case "left":
      return x < threshold;
    case "right":
      return x > viewportW - threshold;
  }
}

/**
 * Which measured extent feeds `dockCapacity`: a Dock's **long** edge decides how many
 * icons fit. `dockCapacity` divides a length by the icon pitch, so a side column must be
 * measured by its height — handing it the (narrow) width would pin the capacity at its
 * floor of 3 forever.
 */
export function dockCapacityExtent(
  position: DockPosition,
  width: number,
  height: number,
): number {
  return dockIsVertical(position) ? height : width;
}

/**
 * Check if fullscreen mode is active.
 * Safe under SSR/tests where `document` may not exist.
 */
export function isFullscreen(): boolean {
  return typeof document !== "undefined" && !!document.fullscreenElement;
}

/**
 * Emit a bounce event for a specific app.
 * Components subscribe via `onDockBounce()` and respond with the bounce animation.
 */
export function emitDockBounce(appId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("dock-bounce", {
      detail: { appId },
    })
  );
}

/**
 * Subscribe to dock bounce events.
 * - `appId` of `"*"` listens for any app's bounce event.
 * - `callback` receives the actual appId that bounced.
 *
 * Returns a cleanup function that unsubscribes the listener.
 */
export function onDockBounce(
  appId: string,
  callback: (bouncingAppId: string) => void
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const customEvent = e as CustomEvent<{ appId: string }>;
    const eventAppId = customEvent.detail?.appId;
    if (!eventAppId) return;
    if (appId === "*" || eventAppId === appId) {
      callback(eventAppId);
    }
  };
  window.addEventListener("dock-bounce", handler);
  return () => window.removeEventListener("dock-bounce", handler);
}
