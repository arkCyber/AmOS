/**
 * Biometric authentication — Face ID / Touch ID (iOS) / fingerprint / face unlock (Android).
 *
 * **Platform support**:
 *  * Android: `BiometricPrompt` (API 23+), supports fingerprint / face / iris.
 *  * iOS: `LocalAuthentication` LAContext via WebView native bridge.
 *  * Host / desktop: not available.
 *
 * **Design**: the biometric prompt is a **modal overlay** that must appear in
 * response to a user gesture (button tap). Do not trigger authentication
 * silently without a user action — platforms block it and it fails silently.
 *
 * **Honest semantics**:
 *  * `available` means the hardware is present AND enrolled (at least one
 *    biometric is registered). `available: false` does NOT say why.
 *  * Authentication resolves **only** on user completion (success, cancel,
 *    fallback, or error). The platform never resolves without a user action.
 *  * `fallback: true` means the user chose the PIN/password fallback — the
 *    caller must handle that as "authenticated" or "user wants a fallback".
 */
import { invoke, bridged } from "./backend";

/** The biometric types the platform may offer. */
export type BiometricKind = "none" | "fingerprint" | "face" | "iris" | "biometric";

/**
 * What the device can say about its biometric sensor.
 *
 * The spellings are a **cross-language contract**, not local vocabulary: they are emitted by
 * `BiometricGlue.getAvailability()` (Kotlin), re-checked by `BiometricDeviceState` in
 * `crates/amos-tauri/src/ble.rs`, and switched on here. `declaredMirrors.test.ts` and
 * `scripts/biometric-glue-const-scan.mjs` fail if the three drift apart.
 *
 * `unknown` and `unavailable` both mean **"no answer"** and are the reason this is a union
 * rather than two booleans: a screen showing "此设备没有生物识别" for either of them would be
 * inventing a fact about the user's hardware. `unavailable` is Rust-side only (JNI failure,
 * unbound Context, host build) and the glue never emits it.
 */
export type BiometricStateWire =
  | "enrolled"
  | "not-enrolled"
  | "hw-unavailable"
  | "no-hardware"
  | "unknown"
  | "unavailable";

/** Whether biometric authentication is available at all.
 *  Returns `null` when the bridge is unavailable (host). */
export interface BiometricAvailability {
  /** What the device said. Derive readiness from this, not from the booleans below. */
  state: BiometricStateWire;
  /** The raw `BiometricManager.canAuthenticate` result, or `null` when never reached. */
  can_authenticate: number | null;
  /** The strongest biometric type enrolled (most secure). */
  kind: BiometricKind;
  /** Human-readable label for the enrolled biometric (e.g. "指纹", "面容 ID"). */
  label: string;
  /** Whether any biometric is enrolled. **Mirrors** `state === "enrolled"`. */
  enrolled: boolean;
  /** `true` the sensor is there, `false` the device says there is none, `null` **no answer**
   *  — never render `null` as either. **Mirrors** `state`, and the Rust side derives both
   *  from the same place so they cannot disagree. */
  hardware_present: boolean | null;
  /** The host's own words when `state === "unavailable"`. `null` otherwise. */
  detail?: string | null;
}

/** Outcome of a biometric authentication attempt. */
export type BiometricResult =
  | { ok: true; result: "authenticated" | "fallback" | "cancelled" | "unavailable" }
  | { ok: false; error: string };

/** Whether biometric authentication is available at all.
 *  Returns `null` when the bridge is unavailable (host). */
export async function biometricAvailable(): Promise<BiometricAvailability | null> {
  return invoke<BiometricAvailability>("biometric_available");
}

/**
 * Prompt for biometric authentication.
 *
 * **Requirements**:
 *  * Must be called as a **direct result of a user gesture** (button tap, menu item).
 *    Platforms block authentication triggered by timers, network responses, or
 *    long-running tasks. This is a platform restriction, not a bug.
 *  * `reason` is shown in the system prompt and must describe the specific action
 *    ("解锁应用" / "授权支付" / "确认身份").
 *
 * **Returns**:
 *  * `{ ok: true, result: "authenticated" }` — user verified, proceed.
 *  * `{ ok: true, result: "cancelled" }` — user dismissed the prompt.
 *  * `{ ok: true, result: "fallback" }` — user chose device PIN/password.
 *  * `{ ok: false, error: "not_enrolled" }` — no biometric enrolled; guide user to Settings.
 *  * `{ ok: false, error: "locked_out" }` — too many failures; device requires PIN.
 *  * `{ ok: false, error: string }` — other platform error.
 */
export async function biometricAuthenticate(
  reason: string,
  allowDeviceCredential = false,
): Promise<BiometricResult> {
  if (!bridged()) {
    return { ok: false, error: "not bridged" };
  }
  const r = await invoke<BiometricResult>("biometric_authenticate", {
    reason,
    allowDeviceCredential,
  });
  return r ?? { ok: false, error: "not bridged" };
}

/**
 * Whether the availability says a biometric is ready to use.
 *
 * Reads `state` alone (REQ-A779). The old form was
 * `enrolled && hardware_present`, which said `false` for "no sensor" and "we could not ask"
 * alike — so the settings screen printed the same sentence for a phone with no fingerprint
 * reader and for a device where the JNI call had thrown.
 */
export function biometricReady(avail: BiometricAvailability | null): boolean {
  return avail?.state === "enrolled";
}

/**
 * Whether the user must enroll before biometric can work.
 *
 * `state === "not-enrolled"` is the **only** state where "enrol a biometric" is true advice:
 * the sensor is known to be there and known to be empty. The old form (`hardware_present &&
 * !enrolled`) also covered the state where we had no answer, which is how a phone with no
 * sensor came to be told to enrol a fingerprint.
 */
export function biometricNeedsEnrollment(avail: BiometricAvailability | null): boolean {
  return avail?.state === "not-enrolled";
}

/** Whether the sensor is there but momentarily unusable (another app holds it, etc.). */
export function biometricHwUnavailable(avail: BiometricAvailability | null): boolean {
  return avail?.state === "hw-unavailable";
}

/**
 * Whether we have **no answer** about the hardware — the platform declined to say, the
 * question never reached it, or there is no bridge at all (`null`, e.g. a plain browser).
 *
 * `null` counts as unknown rather than falling through to a hardware sentence: "there is no
 * bridge" is *our* ignorance, and the desktop copy used to read as the device's own claim
 * (REQ-A779). The caller renders this with a sentence that claims nothing.
 */
export function biometricUnknown(avail: BiometricAvailability | null): boolean {
  return (
    avail === null || avail.state === "unknown" || avail.state === "unavailable"
  );
}

/** Whether the device reports no biometric sensor at all. */
export function biometricNoHardware(avail: BiometricAvailability | null): boolean {
  return avail?.state === "no-hardware";
}
