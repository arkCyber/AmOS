package com.amos.ai.glue

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference

/**
 * AmOS **SMS runtime-grant** — the Kotlin half of the JS-awaitable permission seam
 * for the real SMS backend (`sms_permission_request`, see
 * `crates/amos-tauri/src/sms_permission.rs`). (REQ-A1577 / F-TEL-037.)
 *
 * `SmsGlue` has always **checked** `READ_SMS` / `SEND_SMS` / `RECEIVE_SMS` and
 * answered `{"error_kind":"permission"}` when one is missing — but nothing in the
 * repository ever **asked** for them. `adb install -g` (the only path
 * `docs/sms.md` ever documented) pre-grants them; a normal install does not, so the
 * inbox reported a permission error forever and `SmsReceiver` never delivered a
 * single broadcast, with no way for the user to fix it from inside AmOS. This object
 * posts the OS dialog.
 *
 * All three are requested **together**: they are one feature (read the inbox, send,
 * observe arrivals), the platform shows a single dialog, and a partial grant leaves
 * the SMS screen in a half-working state no sentence could describe honestly.
 *
 * ```
 * WebView sms_permission_request ─► Rust ─► allGranted() / request()
 *                                            │  (posts on the UI thread)
 *   MainActivity.onRequestPermissionsResult(REQ_SMS)
 *     └► PermissionWire.onResult REQ_SMS ─► onSmsResult(granted) ─► Rust resolves the await
 * ```
 *
 * Contract with Rust (names must not drift; `scripts/jni-contract-scan.mjs` R2
 * checks both directions):
 *   * `external fun bind()`            — Java_com_amos_ai_glue_SmsPermissionGlue_bind
 *   * `external fun onResult(Boolean)` — Java_com_amos_ai_glue_SmsPermissionGlue_onResult
 *   * Rust drives `allGranted(): Boolean` / `request(): Unit` through the stored
 *     instance (global ref).
 *
 * COMPILE/VERIFY path: this file is the tracked template under `android-glue/`
 * (source of truth); copy it to `gen/android/app/src/main/java/com/amos/ai/glue/`
 * when the Tauri-Android project is regenerated, then `./gradlew :app:compileDebugKotlin`
 * type-checks it. Runtime grant behaviour is verified on a real device.
 */
object SmsPermissionGlue {

    private const val TAG = "AmosSmsPermission"

    /**
     * Request code for the SMS grant. Distinct from every other code the glue uses —
     * `RequestCodeTest` holds the whole table and fails if two glues ever claim one number,
     * which is the failure this constant shipped: it was `9005`, the same as
     * `LocationPermissionGlue.REQ_LOCATION`, and since the location branch sits first in
     * `PermissionWire.onResult`'s `when` this glue's own branch was dead (REQ-A1625).
     */
    const val REQ_SMS = 9007

    /** The three permissions the SMS backend needs, requested as one dialog. */
    private val REQUIRED = arrayOf(
        Manifest.permission.READ_SMS,
        Manifest.permission.SEND_SMS,
        Manifest.permission.RECEIVE_SMS,
    )

    /** The Activity used to check + request the grant (held weakly; the generated
     * MainActivity outlives dialogs but must not be leaked). */
    @Volatile
    private var activity: WeakReference<Activity>? = null

    /** Rust `Java_com_amos_ai_glue_SmsPermissionGlue_bind` — hand the singleton to
     * Rust so it can drive `allGranted()` / `request()`. */
    private external fun bind()

    /** Rust `Java_com_amos_ai_glue_SmsPermissionGlue_onResult` — resolve the pending
     * `sms_permission_request` with the OS dialog outcome. */
    private external fun onResult(granted: Boolean)

    /** Remember the Activity (once) and bind the singleton to Rust. Idempotent.
     * Guarded so a build without the `android` native feature (missing JNI symbol)
     * degrades to a log instead of an `UnsatisfiedLinkError` boot crash. */
    fun ensureBound(activity: Activity) {
        if (this.activity == null) {
            this.activity = WeakReference(activity)
            runCatching { bind() }
                .onFailure { Log.w(TAG, "sms permission bind unavailable (missing android native feature?): ${it.message}") }
        }
    }

    /** `true` when **every** required SMS permission is currently held. */
    fun allGranted(): Boolean {
        val act = activity?.get() ?: return false
        return REQUIRED.all {
            ContextCompat.checkSelfPermission(act, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    /** Post the SMS dialog on the UI thread (no-op when the set is already held). */
    fun request() {
        if (allGranted()) return
        val act = activity?.get() ?: return
        act.runOnUiThread {
            try {
                ActivityCompat.requestPermissions(act, REQUIRED, REQ_SMS)
            } catch (t: Throwable) {
                Log.w(TAG, "sms permission request failed: $t")
                onResult(false)
            }
        }
    }

    /** Called from [PermissionWire.onResult] when the OS answers `REQ_SMS`.
     *
     * The verdict is **re-read** from the platform rather than taken from
     * `grantResults`: the array covers the requested permissions in request order,
     * and a mixed grant would otherwise be folded into one bit that is right about
     * none of them. `allGranted()` asks the OS itself, so the answer is the device's. */
    fun onSmsResult() {
        val granted = allGranted()
        Log.i(TAG, "SMS permission set ${if (granted) "granted" else "still incomplete"}")
        if (granted) {
            // The `SMS_RECEIVED` receiver is registered only while `RECEIVE_SMS` is held, and
            // the first `SmsGlue.bind` (from `AmosGlue.onStart`) usually ran before this grant —
            // so it skipped the receiver. Re-attempt it now, on the grant callback, so live
            // refresh starts without an app restart (PH-P2-06). `SmsGlue.bind`'s receiver
            // registration is idempotent. Mirrors `AmosGlue.onCameraPermissionGranted`.
            activity?.get()?.let { act ->
                runCatching { SmsGlue.bind(act.applicationContext) }
                    .onFailure { Log.w(TAG, "SmsGlue re-bind after SMS grant failed: ${it.message}") }
            }
        }
        runCatching { onResult(granted) }
            .onFailure { Log.w(TAG, "sms onResult unavailable (missing android native feature?): ${it.message}") }
    }
}
