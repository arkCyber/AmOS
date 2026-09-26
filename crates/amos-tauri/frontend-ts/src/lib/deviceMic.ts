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

/**
 * The labels `DeviceMicStatus.backend` can carry: the `PlatformMicKind` labels a
 * live `PlatformMic` reports (`"aaudio"` / `"tinyalsa"` / `"mock"`), plus the idle
 * marker {@link IDLE_MIC_BACKEND}. This is deliberately **not** the full
 * `PlatformMicKind::label()` codomain (`crates/amos-audio/src/source.rs`) — that
 * also has `"host"`, which this status never carries: a host build has no native
 * mic, so `PlatformMic::open_device()` fails before any worker exists, and a mock
 * is built with its own `"mock"` label. Bound to that Rust file by
 * `src/__tests__/declaredMirrors.test.ts` (REQ-A718).
 */
export const DEVICE_MIC_BACKENDS = ["aaudio", "tinyalsa", "mock", "none"] as const;
export type DeviceMicBackend = (typeof DEVICE_MIC_BACKENDS)[number];

/** The idle marker: `DeviceMicStatus.backend` when no worker is running. */
export const IDLE_MIC_BACKEND = "none";

/**
 * The labels `PlatformMicKind::is_native()` accepts — a real device capture
 * (AAudio or TinyALSA). `"mock"` (an explicitly injected host/dev capture) and
 * {@link IDLE_MIC_BACKEND} are never a real device mic. Held to the Rust
 * predicate by `src/__tests__/declaredMirrors.test.ts`.
 */
export const NATIVE_MIC_BACKENDS = ["aaudio", "tinyalsa"] as const;

/**
 * True only for a **native** capture backend — the labels {@link NATIVE_MIC_BACKENDS}
 * names, which the binding test holds to Rust's `PlatformMicKind::is_native()`. A UI
 * must not show a fabricated "listening on the device" for `mock` (an injected
 * host/dev capture) or the idle marker. Because the pair is bound rather than
 * re-spelled, a Rust label rename cannot silently stop a live mic from being
 * recognised (which would leave the always-on indicator off while the mic runs).
 */
export function isNativeMicBackend(label: string | null | undefined): boolean {
  return label != null && (NATIVE_MIC_BACKENDS as readonly string[]).includes(label);
}
