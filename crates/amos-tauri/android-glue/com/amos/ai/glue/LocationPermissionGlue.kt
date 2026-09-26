package com.amos.ai.glue

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference

/**
 * AmOS **native-only location-grant seam** — the Kotlin half of the JS-awaitable
 * permission seam for the real `LocationManager` GNSS read (`location_permission_request`
 * / `location_permission_state`, see `crates/amos-tauri/src/location_permission.rs`).
 *
 * Why a seam of its own (REQ-A772 / F-SH-228): `crates/amos-sensor/src/android.rs`
 * reads the fix through `LocationManager#getLastKnownLocation("gps")`, which is a
 * **dangerous** (runtime) permission. Unlike the WebView `navigator.geolocation`
 * path — whose prompt the generated `RustWebChromeClient` handles — a native
 * `LocationManager` read triggers **no dialog at all**: if the grant is missing the
 * call simply throws `SecurityException`, which the Rust side used to fold into
 * "no fix yet". So without this glue the user is shown "searching for a location"
 * forever, and nothing on screen ever says otherwise. This is the same shape as
 * `MicPermissionGlue`, and for the same reason.
 *
 * The grant is **three-state**, not a boolean, because Android 12+ lets the user
 * answer "approximate":
 *   * `GRANT_NONE`   (0) — nothing granted; every location call throws.
 *   * `GRANT_COARSE` (1) — `ACCESS_COARSE_LOCATION` only: a real fix, but approximate.
 *   * `GRANT_FINE`   (2) — `ACCESS_FINE_LOCATION`: the precise providers.
 * A boolean would have reported the approximate grant as "granted", and the UI would
 * then have shown an accuracy the receiver never promised.
 *
 * ```
 * WebView location_permission_request ─► Rust ─► isGranted/request
 *                                            │  (posts on the UI thread)
 *   MainActivity.onRequestPermissionsResult(REQ_LOCATION)
 *     └► PermissionWire.onResult REQ_LOCATION ─► onResult(level) ─► Rust resolves the await
 * ```
 *
 * Contract with Rust (names must not drift):
 *   * `external fun bind()`             — Java_com_amos_ai_glue_LocationPermissionGlue_bind
 *   * `external fun onResult(Int)`      — Java_com_amos_ai_glue_LocationPermissionGlue_onResult
 *   * Rust drives `grantLevel(): Int` / `request(): Unit` through the stored instance
 *     (global ref).
 *
 * COMPILE/VERIFY path: this file is the tracked template under `android-glue/`
 * (source of truth); copy it to `gen/android/app/src/main/java/com/amos/ai/glue/`
 * when the Tauri-Android project is regenerated, then `./gradlew :app:compileDebugKotlin`
 * type-checks it. Runtime grant behaviour is verified on a real device.
 */
object LocationPermissionGlue {

    private const val TAG = "AmosLocationPermission"

    /** Distinct request code for the location grant (never overlaps REQ_CAMERA/REQ_MEDIA/REQ_MIC). */
    const val REQ_LOCATION = 9005

    /** No location grant — every `LocationManager` call throws `SecurityException`. */
    const val GRANT_NONE = 0
    /** `ACCESS_COARSE_LOCATION` only — a real but approximate fix. */
    const val GRANT_COARSE = 1
    /** `ACCESS_FINE_LOCATION` — the precise providers. */
    const val GRANT_FINE = 2

    /** The Activity used to check + request the permission (held weakly; the
     * generated MainActivity outlives dialogs but must not be leaked). */
    @Volatile
    private var activity: WeakReference<Activity>? = null

    /** Rust `Java_com_amos_ai_glue_LocationPermissionGlue_bind` — hand the singleton to
     * Rust so it can drive `grantLevel()` / `request()`. */
    private external fun bind()

    /** Rust `Java_com_amos_ai_glue_LocationPermissionGlue_onResult` — resolve the pending
     * `location_permission_request` with the OS dialog outcome (a `GRANT_*` level). */
    private external fun onResult(level: Int)

    /** Remember the Activity (once) and bind the singleton to Rust. Idempotent.
     * Guarded so a build without the `android` native feature (missing JNI symbol)
     * degrades to a log instead of an `UnsatisfiedLinkError` boot crash. */
    fun ensureBound(activity: Activity) {
        if (this.activity == null) {
            this.activity = WeakReference(activity)
            runCatching { bind() }
                .onFailure { Log.w(TAG, "location bind unavailable (missing android native feature?): ${it.message}") }
        }
    }

    /**
     * The current grant, as one of the three [`GRANT_*`][GRANT_NONE] levels.
     *
     * Order matters: `ACCESS_FINE_LOCATION` implies coarse on Android, so it is
     * checked **first** — checking coarse first would report a precise grant as
     * approximate.
     */
    fun grantLevel(): Int {
        val act = activity?.get() ?: return GRANT_NONE
        if (holds(act, Manifest.permission.ACCESS_FINE_LOCATION)) return GRANT_FINE
        if (holds(act, Manifest.permission.ACCESS_COARSE_LOCATION)) return GRANT_COARSE
        return GRANT_NONE
    }

    /** Whether the app currently holds [permission]. */
    private fun holds(act: Activity, permission: String): Boolean =
        ContextCompat.checkSelfPermission(act, permission) == PackageManager.PERMISSION_GRANTED

    /**
     * Post the OS location dialog on the UI thread (no-op when the grant is already held).
     *
     * Both permissions are requested **together**: that is what makes Android show the
     * precise/approximate choice, and a request for fine alone would silently drop the
     * approximate answer the user is entitled to give.
     */
    fun request() {
        if (grantLevel() != GRANT_NONE) return
        val act = activity?.get() ?: return
        act.runOnUiThread {
            try {
                ActivityCompat.requestPermissions(
                    act,
                    arrayOf(
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION,
                    ),
                    REQ_LOCATION,
                )
            } catch (t: Throwable) {
                Log.w(TAG, "location permission request failed: $t")
                onResult(GRANT_NONE)
            }
        }
    }

    /**
     * Called from [PermissionWire.onResult] when the OS answers `REQ_LOCATION`.
     *
     * The level is read back from the **live grant**, not from `grantResults`: the
     * result array reports what the dialog returned, but on Android 12+ the user may
     * have chosen "approximate only", and `grantResults` for the fine entry is denied
     * in exactly that case. Reading the authoritative state means the resolver can
     * never be less accurate than the device.
     */
    fun onLocationResult() {
        val level = grantLevel()
        Log.i(TAG, "location grant => $level (0 none / 1 coarse / 2 fine)")
        runCatching { onResult(level) }
            .onFailure { Log.w(TAG, "location onResult unavailable (missing android native feature?): ${it.message}") }
    }
}
