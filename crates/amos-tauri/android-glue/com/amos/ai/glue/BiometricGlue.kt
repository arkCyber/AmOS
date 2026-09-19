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
     * Returns a JSON object: { kind, label, enrolled, hardware_present }.
     */
    @JvmStatic
    fun getAvailability(context: Context): String {
        val biometricManager = BiometricManager.from(context)
        val canAuth = biometricManager.canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG
        )
        val hardwarePresent = when (canAuth) {
            BiometricManager.BIOMETRIC_SUCCESS,
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE,
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> true
            else -> false
        }
        val enrolled = canAuth == BiometricManager.BIOMETRIC_SUCCESS

        // Determine the kind based on available strong biometrics
        val kind = if (enrolled) {
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
                        context.packageManager.hasSystemFeature("android.hardware.biometrics.face") -> "face"
                context.packageManager.hasSystemFeature("android.hardware.fingerprint") -> "fingerprint"
                context.packageManager.hasSystemFeature("android.hardware.biometrics.iris") -> "iris"
                else -> "fingerprint" // default assumption
            }
        } else {
            "none"
        }

        val label = when (kind) {
            "face" -> "面容 ID"
            "fingerprint" -> "指纹"
            "iris" -> "虹膜"
            else -> "生物识别"
        }

        return JSONObject()
            .put("kind", kind)
            .put("label", label)
            .put("enrolled", enrolled)
            .put("hardware_present", hardwarePresent)
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
