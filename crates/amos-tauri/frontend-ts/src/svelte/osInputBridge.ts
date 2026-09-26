/**
 * React-free input/event mapping for the pure-Svelte shell: hardware Home/AI →
 * navigation. Pure mappers are headless-testable; `startOsHardwarePoll` /
 * `startOsInputBridge` wire the shell-level listeners.
 *
 * Incoming-call UI itself stays in `svelte/IncomingCall.svelte` (the single
 * telephony subscriber Shell renders), which dispatches on the `TelephonyCall`
 * fields directly (`state` = `Ringing`/`Active`/`Ended`) — this module does not
 * re-classify telephony events.
 */
import { invoke } from "../lib/backend";
import { buttonActionOf, keyActionOf, type HardwareAction } from "../lib/systemButtons";

export type ShellNavAction = "home" | "ai";

/** Fold a parsed hardware/keyboard action into the shell's nav vocabulary. */
function toNav(action: HardwareAction): ShellNavAction | null {
  if (action === "home") return "home";
  if (action === "ai" || action === "voice") return "ai";
  return null;
}

/** Map a hardware-button/name to a shell navigation action (else null). */
export function mapHardwareAction(name: unknown): ShellNavAction | null {
  const n = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (n === "home" || n === "back") return "home";
  // Everything else (voice / ai / ai_assistant / assistant) is the shared mapping.
  return toNav(buttonActionOf(name));
}

/**
 * Map a desktop keyboard key to a shell navigation action: the H/V/A shortcuts
 * from `lib/systemButtons` (`keyActionOf`), falling back to the hardware-button
 * names so a synthesized `keydown` carrying "home"/"ai" still navigates.
 *
 * This is the **pure** mapping only — what a key *means*. Whether the keystroke is
 * ours to act on at all is `admitNavKey` below; the two are deliberately separate so
 * this table stays testable headlessly.
 */
export function mapKeyAction(key: unknown): ShellNavAction | null {
  if (typeof key !== "string") return null;
  return toNav(keyActionOf(key)) ?? mapHardwareAction(key);
}

/** The slice of a `keydown` the admission reads (mirrors `lib/shellModule`'s
 *  `ShortcutEvent`, plus the target so "the user is typing" is decidable without a
 *  live DOM in a test). A real `KeyboardEvent` satisfies it structurally. */
export interface NavKeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  target?: EventTarget | null;
}

/** True when the event target is a text field — a bare-letter shortcut must not fire
 *  while the user is typing. Same rule, verbatim, as `lib/overviewKeys` and
 *  `DesktopStage`'s own keyboard layers. */
function isEditableTarget(t: EventTarget | null | undefined): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return t.isContentEditable;
}

/**
 * Is this `keydown` a shell navigation shortcut?
 *
 * REQ-A1413: the H/V/A shortcuts are **bare letters**, and `keyActionOf` reads the key
 * alone — no modifier, no target, no composition state. So without this admission the
 * bridge navigated from *inside text fields*: typing `a` in any search box / composer /
 * address bar opened the AI app, `h` went home (dismissing the app being typed in), `v`
 * opened AI, and ⌘A / Ctrl+A / ⇧A did the same (`keyActionOf` lowercases the key and
 * ignores modifiers). Measured 2026-09-25 before the fix.
 *
 * The shell's own handler (`Shell.svelte`, the only `shellKeyIntent` caller) never had
 * this bug because every intent it resolves is a **chord** (⌘[ / Escape / ⌘,) — nothing
 * bare-letter-shaped — and it already carries the first three stand-downs below. These
 * are the same stand-downs, plus the two the bare-letter case needs and a chord does
 * not: a held modifier (`⌘A` is select-all, not "AI") and an editable target.
 */
export function admitNavKey(e: NavKeyEvent): boolean {
  // Already handled by an inner consumer, mid-IME-composition, or an auto-repeat.
  if (e.defaultPrevented) return false;
  if (e.isComposing || e.key === "Process") return false;
  if (e.repeat) return false;
  // Strict, like `shortcutMatches`: any modifier the shortcut does not declare means
  // this is somebody else's keystroke. `keyActionOf` lowercases, so ⇧A reports "A".
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  // Never a navigation while the user is typing.
  return !isEditableTarget(e.target);
}

/** Poll cadence for pulling a pending hardware action via invoke. */
export const HARDWARE_POLL_MS = 200;

/**
 * Reliable on-device hardware-button delivery: poll the Rust command
 * `take_pending_hardware_button` (a plain Tauri `invoke`, which every feature uses
 * and which demonstrably works on-device) instead of relying on the Rust→JS event
 * system / `eval` — neither is guaranteed to reach the webview on mobile. One press
 * = one pulled action. Returns a stop function. React-free.
 */
export function startOsHardwarePoll(handlers: {
  onNav?: (a: ShellNavAction) => void;
}): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const name = await invoke<string | null>("take_pending_hardware_button");
    if (stopped || !name) return;
    const a = mapHardwareAction(name);
    if (a) {
      console.info(`[amos][os-input] poll nav=${a} from=${name}`);
      handlers.onNav?.(a);
    }
  };
  const id = window.setInterval(() => {
    void tick();
  }, HARDWARE_POLL_MS);
  return () => {
    stopped = true;
    window.clearInterval(id);
  };
}

/** Start shell-level listeners: hardware-button events + the physical Home key.
 *  Returns a stop function. */
export function startOsInputBridge(handlers: {
  onNav?: (a: ShellNavAction) => void;
}): () => void {
  const onHardware = (e: Event) => {
    const detail = (e as CustomEvent<{ name?: string }>).detail;
    const a = mapHardwareAction(detail?.name);
    // On-device trace (adb logcat): did a hardware-button DOM event reach the
    // shell, and what nav action did it map to? Lets us tell "key never arrived"
    // from "arrived but mapped wrong" without looking at the webview.
    if (a) console.info(`[amos][os-input] hardware nav=${a} from=${detail?.name}`);
    if (a) handlers.onNav?.(a);
  };
  const onKey = (e: KeyboardEvent) => {
    // The mapping says what the key means; `admitNavKey` says whether it is ours at all
    // (not while typing, not a chord, not a composition / repeat / already-handled key).
    if (!admitNavKey(e)) return;
    const a = mapKeyAction(e.key);
    if (a) handlers.onNav?.(a);
  };
  window.addEventListener("hardware-button", onHardware);
  window.addEventListener("keydown", onKey);
  return () => {
    window.removeEventListener("hardware-button", onHardware);
    window.removeEventListener("keydown", onKey);
  };
}
