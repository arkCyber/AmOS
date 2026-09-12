/**
 * Host-side **screen-state reporting** for the pure-Svelte shell.
 *
 * The System UI owns the display; the headless daemon owns the energy decision
 * and learns the truth from the shared file named by `AMOS_SCREEN_STATE_PATH`
 * (`amos-display` host contract, see `docs/display-idle.md`). So *every* screen-off
 * path must report `off` and every wake/unlock must report `on`: a lock that only
 * changes the local Svelte surface — without telling the daemon — leaves
 * `screen_on = true` forever, so the energy governor never defers background
 * inference and never freezes apps as documented.
 *
 * All calls degrade to `null` outside Tauri (no bridge), never throwing, so the
 * shell keeps working in a browser/host build with no display seam.
 */
import { getScreenState, setScreenState } from "../lib/display";

/** Report the display is off (manual lock from the NC, or idle auto-sleep). */
export function reportScreenOff(): void {
  void setScreenState(false);
}

/** Report the display is on (wake / unlock). */
export function reportScreenOn(): void {
  void setScreenState(true);
}

/**
 * One-shot **boot re-assert**: a previous run may have left `off` on disk, which
 * would make the daemon defer as if the display were still dark. When the shell
 * starts *unlocked* we clear it. Reads first, so an already-consistent `on` (or a
 * missing bridge) writes nothing — no state churn on every launch.
 *
 * Returns the resulting value (`null` when not bridged / when it started locked)
 * so callers and tests can observe the outcome.
 */
export async function reassertScreenOnUnlocked(
  startedLocked: boolean,
): Promise<boolean | null> {
  if (startedLocked) return null;
  const current = await getScreenState();
  if (current === false) return setScreenState(true);
  return current;
}
