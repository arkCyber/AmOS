/**
 * Pure helpers for the **always-on native device mic** (`device_mic_*`) — the
 * AAudio seam from `crates/amos-tauri/src/assistant_voice.rs`.
 *
 * Kept DOM/free of the Tauri bridge so the backend-label logic is unit-testable
 * headlessly. The typed status comes straight from `./backend`
 * (`deviceMicStatus`, already deserialized from the wire by Tauri) — there is no
 * second parser to keep in sync.
 *
 * Honesty rule: a *real* device mic only exists in an Android build with
 * `amos-audio/aaudio`. On a host build / browser the wrappers degrade to `null`
 * and the label helpers below must never let a UI claim a native mic is there.
 */

/** Backends the Rust seam may report (mirrors `PlatformMicKind.label()`). */
export const DEVICE_MIC_BACKENDS = ["aaudio", "tinyalsa", "mock", "none"] as const;
export type DeviceMicBackend = (typeof DEVICE_MIC_BACKENDS)[number];

/**
 * True only for a **native** capture backend. `mock` (an explicitly injected
 * host/dev capture) and `none` (idle) are never a real device mic — a UI must not
 * show a fabricated "listening on the device" for them.
 */
export function isNativeMicBackend(label: string | null | undefined): boolean {
  return label === "aaudio" || label === "tinyalsa";
}
