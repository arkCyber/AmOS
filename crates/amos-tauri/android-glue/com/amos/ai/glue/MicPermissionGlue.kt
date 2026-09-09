package com.amos.ai.glue

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference

/**
 * AmOS **native-only `RECORD_AUDIO` grant** — the Kotlin half of the JS-awaitable
 * permission seam for the always-on AAudio mic (`device_mic_start` /
 * `mic_permission_request`, see `crates/amos-tauri/src/mic_permission.rs`).
 *
 * Unlike the WebView `getUserMedia` path (which asks for `RECORD_AUDIO` bundled
 * with `CAMERA` via [PermissionWire.requestNeeded]), a native AAudio capture never
 * triggers a WebView permission request, so if the OS grant is missing there is no
 * dialog. This object lets the Rust side request **`RECORD_AUDIO` alone**:
 *
 * ```
 * WebView mic_permission_request ─► Rust ─► isGranted() / request()
 *                                            │  (posts on the UI thread)
 *   MainActivity.onRequestPermissionsResult(REQ_MIC)
 *     └► PermissionWire.onResult REQ_MIC ─► onResult(granted) ─► Rust resolves the await
 * ```
 *
 * Contract with Rust (names must not drift):
 *   * `external fun bind()`            — Java_com_amos_ai_glue_MicPermissionGlue_bind
 *   * `external fun onResult(Boolean)` — Java_com_amos_ai_glue_MicPermissionGlue_onResult
 *   * Rust drives `isGranted(): Boolean` / `request(): Unit` through the stored
 *     instance (global ref).
 *
 * COMPILE/VERIFY path: this file is the tracked template under `android-glue/`
 * (source of truth); copy it to `gen/android/app/src/main/java/com/amos/ai/glue/`
 * when the Tauri-Android project is regenerated, then `./gradlew :app:compileDebugKotlin`
 * type-checks it. Runtime grant behaviour is verified on a real device.
 */
object MicPermissionGlue {

    private const val TAG = "AmosMicPermission"
    /** Distinct request code for the mic-only grant (never overlaps REQ_CAMERA/REQ_MEDIA). */
    const val REQ_MIC = 9004

    /** The Activity used to check + request the permission (held weakly; the
     * generated MainActivity outlives dialogs but must not be leaked). */
    @Volatile
    private var activity: WeakReference<Activity>? = null

    /** Rust `Java_com_amos_ai_glue_MicPermissionGlue_bind` — hand the singleton to
     * Rust so it can drive `isGranted()` / `request()`. */
    private external fun bind()

    /** Rust `Java_com_amos_ai_glue_MicPermissionGlue_onResult` — resolve the pending
     * `mic_permission_request` with the OS dialog outcome. */
    private external fun onResult(granted: Boolean)

    /** Remember the Activity (once) and bind the singleton to Rust. Idempotent.
     * Guarded so a build without the `android` native feature (missing JNI symbol)
     * degrades to a log instead of an `UnsatisfiedLinkError` boot crash. */
    fun ensureBound(activity: Activity) {
        if (this.activity == null) {
            this.activity = WeakReference(activity)
            runCatching { bind() }
                .onFailure { Log.w(TAG, "mic bind unavailable (missing android native feature?): ${it.message}") }
        }
    }

    /** True when `RECORD_AUDIO` is currently held by this app. */
    fun isGranted(): Boolean {
        val act = activity?.get() ?: return false
        return ContextCompat.checkSelfPermission(act, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
    }

    /** Post the mic-only OS dialog on the UI thread (no-op when already granted). */
    fun request() {
        if (isGranted()) return
        val act = activity?.get() ?: return
        act.runOnUiThread {
            try {
                ActivityCompat.requestPermissions(act, arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
            } catch (t: Throwable) {
                Log.w(TAG, "mic permission request failed: $t")
                onResult(false)
            }
        }
    }

    /** Called from [PermissionWire.onResult] when the OS answers `REQ_MIC`. */
    fun onMicResult(granted: Boolean) {
        Log.i(TAG, "RECORD_AUDIO ${if (granted) "granted" else "denied"}")
        runCatching { onResult(granted) }
            .onFailure { Log.w(TAG, "mic onResult unavailable (missing android native feature?): ${it.message}") }
    }
}
