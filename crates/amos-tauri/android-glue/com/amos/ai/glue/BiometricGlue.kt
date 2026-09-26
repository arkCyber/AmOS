package com.amos.ai.glue

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import org.json.JSONObject
import java.util.concurrent.Executor

/**
 * Biometric authentication glue — **System UI APK side**.
 *
 * Wraps `BiometricPrompt` (Android API 23+) for fingerprint / face / iris auth.
 * All operations are driven from the WebView via JNI upcalls from
 * `crates/amos-tauri/src/ble.rs`. Async auth results are forwarded back to Rust
 * as JSON strings via `onBiometricResult(String)`.
 *
 * ## Thread safety
 * BiometricPrompt callbacks fire on the main executor; all mutable state is
 * guarded by `synchronized`.
 */
object BiometricGlue {

    /*
     * KOTLIN → RUST CONTRACT (why the members below carry `@JvmStatic`):
     *
     * `crates/amos-tauri/src/ble.rs` reaches them through `JNIEnv::call_static_method`, and a
     * Kotlin `object`'s member is an **instance** method on `INSTANCE` unless it is annotated.
     * Without `@JvmStatic` the JVM raises `java.lang.NoSuchMethodError: no static method …` at the
     * first call — which neither compiler can see. REQ-A376 found this the hard way in
     * `AlarmGlue.kt` (every alarm registration failed on device); REQ-A412 found the same defect
     * in **every** Rust-callable member of this file (`jni-contract-scan`, 17 call sites across
     * BLE-GATT/NFC/biometric). Keep `@JvmStatic` on anything Rust calls by name.
     */

    private const val TAG = "AmosGlue.Biometric"

    init {
        try {
            System.loadLibrary("amos_tauri_lib")
        } catch (_: UnsatisfiedLinkError) {
            Log.w(TAG, "amos_tauri_lib not loaded — JNI callbacks unavailable")
        }
    }

    // ── Availability ────────────────────────────────────────────────────────────

    /**
     * Check biometric hardware and enrollment status.
     * Returns a JSON object: { state, can_authenticate, kind, label, enrolled, hardware_present }.
     *
     * ## Why `state` and not two booleans (REQ-A779 / F-AND-008)
     *
     * This function used to answer with `hardware_present` / `enrolled`, computed by a
     * `when (canAuth)` — and the two answers that matter were **exchanged**:
     *
     * ```
     * BiometricManager.BIOMETRIC_SUCCESS,
     * BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE,      // 12 — the phone has NO sensor
     * BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> true
     * else -> false                                      // 11 NONE_ENROLLED landed here
     * ```
     *
     * `BIOMETRIC_ERROR_NO_HARDWARE` (12) was on the arm that reports the sensor as **present**,
     * and `BIOMETRIC_ERROR_NONE_ENROLLED` (11) fell into `else`. The screen derives its two
     * sentences from those two booleans, so a phone *without* a sensor was told
     * "设备有生物识别硬件，但还没有登记任何生物特征" — enrol a fingerprint it cannot have — while
     * the one phone the enrollment sentence was written for was told "此设备没有生物识别".
     *
     * A boolean pair cannot say "we could not ask", so the three codes that answer *nothing*
     * about the hardware (`BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED` 15, `BIOMETRIC_STATUS_
     * UNKNOWN` -1, `BIOMETRIC_ERROR_UNSUPPORTED` -2) were silently folded into "no sensor" too.
     *
     * The state vocabulary is exhaustive by construction: every androidx code this build knows
     * gets its own arm, anything this build has never seen falls to `unknown` (never to
     * `no-hardware`), and `can_authenticate` carries the raw code so the Rust side and the
     * screen never have to trust this translation. Values below are dumped from the linked
     * artifact with `javap -constants androidx.biometric.BiometricManager` — not from memory.
     * `state` spellings are a cross-language contract: they are mirrored by `BiometricState` in
     * `crates/amos-tauri/src/ble.rs` and by the TS union in `src/lib/biometric.ts`, and
     * `scripts/biometric-glue-const-scan.mjs` fails the build if the three drift apart.
     */
    @JvmStatic
    fun getAvailability(context: Context): String {
        val biometricManager = BiometricManager.from(context)
        val canAuth = biometricManager.canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG
        )

        val state = when (canAuth) {
            BiometricManager.BIOMETRIC_SUCCESS -> "enrolled"
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "not-enrolled"
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "hw-unavailable"
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "no-hardware"
            // SECURITY_UPDATE_REQUIRED / STATUS_UNKNOWN / ERROR_UNSUPPORTED and any code a
            // future androidx adds: this says nothing about whether a sensor exists, and the
            // one answer we must never invent is "no sensor".
            else -> "unknown"
        }

        // Null — not false — when the code did not answer the question. `hardware_present` is
        // the field the UI's "does this device have biometrics at all?" sentence reads, so a
        // guess here is a false statement to the user.
        val hardwarePresent: Boolean? = when (state) {
            "enrolled", "not-enrolled", "hw-unavailable" -> true
            "no-hardware" -> false
            else -> null
        }
        val enrolled = state == "enrolled"

        // Determine the kind from the system feature flags. Only meaningful once something is
        // enrolled; the previous `else -> "fingerprint" // default assumption` named a sensor
        // the device may not have, and that string is what the user sees ("指纹").
        val kind = if (enrolled) {
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
                        context.packageManager.hasSystemFeature("android.hardware.biometrics.face") -> "face"
                context.packageManager.hasSystemFeature("android.hardware.fingerprint") -> "fingerprint"
                context.packageManager.hasSystemFeature("android.hardware.biometrics.iris") -> "iris"
                // Enrolled with no feature flag we recognise: say so generically rather than
                // pick one. The label below is what the screen prints.
                else -> "biometric"
            }
        } else {
            "none"
        }

        val label = when (kind) {
            "face" -> "面容 ID"
            "fingerprint" -> "指纹"
            "iris" -> "虹膜"
            "biometric" -> "生物识别"
            else -> "生物识别"
        }

        return JSONObject()
            .put("state", state)
            .put("can_authenticate", canAuth)
            .put("kind", kind)
            .put("label", label)
            .put("enrolled", enrolled)
            .put("hardware_present", hardwarePresent ?: JSONObject.NULL)
            .toString()
    }

    // ── Authentication ─────────────────────────────────────────────────────────

    /**
     * Prompt for biometric authentication.
     * `allowDeviceCredential` = allow PIN/pattern/password as fallback.
     * Returns result via callback `onBiometricResult(resultJson)`.
     *
     * IMPORTANT: Must be called as a direct result of a user gesture (button tap).
     */
    @Suppress("UNUSED_PARAMETER")
    @JvmStatic
    fun authenticate(
        context: Context,
        reason: String,
        allowDeviceCredential: Boolean,
    ) {
        val executor: Executor = ContextCompat.getMainExecutor(context)

        // We need a FragmentActivity for BiometricPrompt — cast if possible.
        val activity = context as? FragmentActivity
        if (activity == null) {
            sendResult(JSONObject()
                .put("ok", false)
                .put("result", "cancelled")
                .put("error", "no FragmentActivity available for biometric prompt")
                .toString())
            return
        }

        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                Log.i(TAG, "auth error: $errorCode $errString")
                val resultJson = when (errorCode) {
                    BiometricPrompt.ERROR_USER_CANCELED,
                    BiometricPrompt.ERROR_NEGATIVE_BUTTON -> {
                        JSONObject()
                            .put("ok", false)
                            .put("result", "cancelled")
                            .put("error", errString.toString())
                            .toString()
                    }
                    BiometricPrompt.ERROR_NO_BIOMETRICS,
                    BiometricPrompt.ERROR_HW_NOT_PRESENT -> {
                        JSONObject()
                            .put("ok", false)
                            .put("result", "fallback")
                            .put("error", errString.toString())
                            .toString()
                    }
                    BiometricPrompt.ERROR_HW_UNAVAILABLE -> {
                        // Retryable — hardware is temporarily unavailable (e.g. camera in use).
                        JSONObject()
                            .put("ok", false)
                            .put("result", "unavailable")
                            .put("error", errString.toString())
                            .toString()
                    }
                    else -> {
                        JSONObject()
                            .put("ok", false)
                            .put("result", "cancelled")
                            .put("error", errString.toString())
                            .toString()
                    }
                }
                sendResult(resultJson)
            }

            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                Log.i(TAG, "auth succeeded")
                sendResult(
                    JSONObject()
                        .put("ok", true)
                        .put("result", "authenticated")
                        .put("error", JSONObject.NULL)
                        .toString()
                )
            }

            override fun onAuthenticationFailed() {
                Log.w(TAG, "auth failed (user can retry)")
                // Don't send result — user can retry; only error/success are terminal.
            }
        }

        val authenticators = if (allowDeviceCredential) {
            BiometricManager.Authenticators.BIOMETRIC_STRONG or
                    BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            BiometricManager.Authenticators.BIOMETRIC_STRONG
        }

        try {
            val promptInfo = BiometricPrompt.PromptInfo.Builder()
                .setTitle("身份验证")
                .setSubtitle(reason)
                .setAllowedAuthenticators(authenticators)
                .build()

            val biometricPrompt = BiometricPrompt(activity, executor, callback)
            biometricPrompt.authenticate(promptInfo)
        } catch (e: Exception) {
            Log.e(TAG, "auth prompt failed", e)
            sendResult(
                JSONObject()
                    .put("ok", false)
                    .put("result", "cancelled")
                    .put("error", e.message ?: "unknown error")
                    .toString()
            )
        }
    }

    private fun sendResult(resultJson: String) {
        try {
            onBiometricResult(resultJson)
        } catch (_: UnsatisfiedLinkError) {
            // Rust side not yet loaded — result dropped
        }
    }

    // ── JNI upcall stubs (Rust → Kotlin) ──────────────────────────────────────

    external fun onBiometricResult(resultJson: String)
}
