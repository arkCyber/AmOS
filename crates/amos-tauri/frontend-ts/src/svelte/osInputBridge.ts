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
 */
export function mapKeyAction(key: unknown): ShellNavAction | null {
  if (typeof key !== "string") return null;
  return toNav(keyActionOf(key)) ?? mapHardwareAction(key);
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
