/**
 * Lightweight namespaced debug logger for on-device diagnosis.
 *
 * On the Android WebView (Tauri), `console.*` output surfaces in adb logcat, so
 * these helpers are the primary instrument for "why is X not rendering on the
 * device" questions that can't be reproduced in the browser.
 *
 * Usage:
 *   import { amosLog, amosWarn } from "../lib/debugLog";
 *   amosLog("shell", "show home", { locked, active, layout });
 *
 * All helpers no-op in headless/bun test environments unless explicitly enabled
 * (the guard reads a module flag, set once at import time, so SSR/tests that
 * never touch the browser still work without stubbing console).
 */

const PREFIX = "[amos]";

/** Opt out of noisy per-render logs (kept on by default for device debugging). */
const ENABLED =
  typeof window === "undefined" ||
  !window.localStorage ||
  window.localStorage.getItem("amos.debug.log") !== "0";

function tag(area: string): string {
  return `${PREFIX}[${area}]`;
}

/** Tagged info log: amosLog("dock", "mounted", { page: 8, dock: 5 }). */
export function amosLog(area: string, msg: string, data?: unknown): void {
  if (!ENABLED) return;
  if (data === undefined) console.info(`${tag(area)} ${msg}`);
  else console.info(`${tag(area)} ${msg}`, data);
}

/** Tagged warning log (dock-empty, hidden-state surprises, etc.). */
export function amosWarn(area: string, msg: string, data?: unknown): void {
  if (!ENABLED) return;
  if (data === undefined) console.warn(`${tag(area)} ${msg}`);
  else console.warn(`${tag(area)} ${msg}`, data);
}
