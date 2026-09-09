/**
 * Pure helpers for the **always-on native device mic** (`device_mic_*`) — the
 * AAudio seam from `crates/amos-tauri/src/assistant_voice.rs`.
 *
 * Kept DOM/free of the Tauri bridge so the status parser and the backend-label
 * logic are unit-testable headlessly. The actual RPC wrappers live in
 * `./backend` (`deviceMicStart` / `deviceMicStop` / `deviceMicStatus`).
 *
 * Honesty rule: a *real* device mic only exists in an Android build with
 * `amos-audio/aaudio`. On a host build / browser the wrappers degrade to `null`
 * and the label helpers below must never let a UI claim a native mic is there.
 */
import type { DeviceMicStatus } from "./backend";

/** Backends the Rust seam may report (mirrors `PlatformMicKind.label()`). */
export const DEVICE_MIC_BACKENDS = ["aaudio", "tinyalsa", "mock", "none"] as const;
export type DeviceMicBackend = (typeof DEVICE_MIC_BACKENDS)[number];

/**
 * Parse a raw `device_mic_status` payload (serde JSON from Tauri) into the typed
 * status. Returns `null` for anything that is not a well-formed status, so a UI
 * can tell "no status yet / not bridged" from a real, idle device mic.
 */
export function parseDeviceMicStatus(payload: unknown): DeviceMicStatus | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.running !== "boolean") return null;
  if (typeof p.backend !== "string") return null;
  return { running: p.running, backend: p.backend, submitted: Number(p.submitted) || 0 };
}

/**
 * True only for a **native** capture backend. `mock` (an explicitly injected
 * host/dev capture) and `none` (idle) are never a real device mic — a UI must not
 * show a fabricated "listening on the device" for them.
 */
export function isNativeMicBackend(label: string | null | undefined): boolean {
  return label === "aaudio" || label === "tinyalsa";
}
