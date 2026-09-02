/**
 * System hardware buttons (Home / Voice / AI) — pure parsing so the top-level
 * wiring is unit-testable. Mirrors the Rust `HardwareButton` payloads, which are
 * serialized as lowercase strings on the `hardware-button` event: "home", "voice",
 * "ai_assistant" (plus "ai"/"assistant" accepted for convenience).
 */
export type HardwareAction = "home" | "voice" | "ai" | null;

/** Map a `hardware-button` payload to a frontend action (null when unknown). */
export function buttonActionOf(payload: unknown): HardwareAction {
  if (typeof payload !== "string") return null;
  const s = payload.trim().toLowerCase();
  if (s === "home") return "home";
  if (s === "voice") return "voice";
  if (s === "ai" || s === "ai_assistant" || s === "assistant") return "ai";
  return null;
}

/** Map a desktop keyboard key to an action (H = home, V = voice, A = AI). */
export function keyActionOf(key: string): HardwareAction {
  switch (key.toLowerCase()) {
    case "h":
      return "home";
    case "v":
      return "voice";
    case "a":
      return "ai";
    default:
      return null;
  }
}
