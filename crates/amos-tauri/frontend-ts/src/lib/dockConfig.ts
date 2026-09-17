/**
 * Dock configuration and advanced features (P2).
 *
 * Features:
 * - Bounce animation for notifications (CSS-only, see index.css)
 * - Auto-hide in fullscreen mode
 * - Position switching (bottom/left/right)
 */

// Dock position options (macOS style)
export type DockPosition = "bottom" | "left" | "right";

/**
 * Get CSS class for dock position
 */
export function dockPositionClass(position: DockPosition): string {
  switch (position) {
    case "bottom":
      return "bottom-0 left-0 right-0 justify-center";
    case "left":
      return "left-0 top-[24px] bottom-0 justify-start";
    case "right":
      return "right-0 top-[24px] bottom-0 justify-end";
  }
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
