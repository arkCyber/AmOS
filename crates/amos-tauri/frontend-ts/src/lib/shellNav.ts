/**
 * shellNav.ts — who is allowed to navigate **a window**: the rule, once.
 *
 * REQ-A429. `Shell.svelte` mounts the shell-level navigation watchers in every window it
 * renders — wake-home (`osWakeHome` → `goHome`), idle auto-off (`osAutoOff` → `lock`) and
 * the hardware/gesture nav keys (`osInputBridge` / `osHardwarePoll` → `goHome` / `ai`). On a
 * phone that is exactly right: there is **one** window and the surfaces (home / lock / an
 * app / the library) are its modes, so navigating it is navigating the shell.
 *
 * On a desktop it stopped being right when REQ-A416 made every `wm_open` window render
 * **its own app**: such a window is not a mode of the desktop, it *is* one app. Measured on
 * this machine (2026-09-18), a plain focus change — ⌘M hid a sibling window — made the
 * Settings window call `goHome()`, which re-rendered the **desktop shell inside an app
 * window** (the REQ-A416 defect, reached through a watcher this time) and flipped its title
 * bar back to the label-derived English name (the REQ-A427/A428 symptom, via another path).
 *
 * So the rule is one predicate, and both the "is this the shell's window" decision and the
 * tests read it — the alternative (each watcher growing its own `if`) is how two answers to
 * one question start.
 */
import type { FormFactor } from "./wm";

/**
 * Does the window described by (`form`, `isAppSurface`) own shell navigation?
 *
 * `form` is the host's class for this device (`null` while the snapshot has not arrived —
 * treated as a touch class, the conservative choice: touch behaviour is today's behaviour,
 * and a wake needs ≥ `WAKE_HOME_MIN_MS` of absence, far longer than that round trip).
 * `isAppSurface` is `surface().kind === "app"` — on a desktop that is true **only** in an
 * app window, because `Shell.svelte` sends app surfaces to `DesktopAppWindow` there.
 */
export function windowOwnsShellNav(
  form: FormFactor | null | undefined,
  isAppSurface: boolean,
): boolean {
  return !(form === "desktop" && isAppSurface);
}
