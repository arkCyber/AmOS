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
export type BiometricKind = "none" | "fingerprint" | "face" | "iris";

/** Whether biometric authentication is available at all.
 *  Returns `null` when the bridge is unavailable (host). */
export interface BiometricAvailability {
  /** The strongest biometric type enrolled (most secure). */
  kind: BiometricKind;
  /** Human-readable label for the enrolled biometric (e.g. "指纹", "面容 ID"). */
  label: string;
  /** Whether any biometric is enrolled. */
  enrolled: boolean;
  /** Whether the device has biometric hardware at all. */
  hardware_present: boolean;
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

/** Derive a human-readable label for the enrolled biometric kind. */
export function biometricLabel(kind: BiometricKind): string {
  switch (kind) {
    case "face":
      return "面容 ID";
    case "fingerprint":
      return "指纹";
    case "iris":
      return "虹膜";
    case "none":
    default:
      return "生物识别";
  }
}

/** Whether the availability says a biometric is ready to use. */
export function biometricReady(avail: BiometricAvailability | null): boolean {
  return (avail?.enrolled ?? false) && (avail?.hardware_present ?? false);
}

/** Whether the user must enroll before biometric can work. */
export function biometricNeedsEnrollment(avail: BiometricAvailability | null): boolean {
  return (avail?.hardware_present ?? false) && !(avail?.enrolled ?? false);
}
