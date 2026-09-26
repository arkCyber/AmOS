package com.amos.ai.glue

import android.app.Activity
import android.util.Log
import java.lang.ref.WeakReference

/**
 * AmOS System UI — **device-orientation binding** (rotation lock / forced orientation).
 *
 * The touch shell's quick-settings "rotation lock" tile reaches the Rust
 * `rotation_set` command (`crates/amos-tauri/src/rotation.rs`), which decides the
 * Android requested-orientation code in the pure `amos_display::orientation` kernel
 * and hands it down here. This glue forwards the code to
 * `Activity#setRequestedOrientation` — the only thing that actually turns the
 * display — and answers with a `STATUS_*` word so the host can tell the user what
 * happened instead of assuming success.
 *
 * The decision of *which mode means which code* is **not** here: the code is a
 * parameter (`SCREEN_ORIENTATION_UNSPECIFIED` = -1 for auto, `…_LOCKED` = 14, …),
 * so there is exactly one place — the tested Rust kernel — that owns the mapping.
 *
 * Thread-safety: [setOrientation] is called from a Rust/JNI worker thread.
 * `Activity#setRequestedOrientation` is a Binder call into the system
 * `ActivityTaskManagerService`; it does not touch the View hierarchy, so it is safe
 * off the main thread (the documented main-thread guidance is about `View`
 * mutation, not this service call). The `WeakReference` is `@Volatile` for the same
 * reason `AlarmGlue.activity` is: written on the main thread (attach), read on the
 * JNI worker thread.
 */
object RotationGlue {

    private const val TAG = "RotationGlue"

    /**
     * Status strings the Rust host maps to a typed outcome and surfaces to the
     * WebView — mirrored by `rotation::rotation_outcome_from_status`, which has a
     * unit test pinning every spelling (keep the two in sync).
     */
    const val STATUS_APPLIED = "applied"
    /** No foreground Activity has been handed to the glue yet (boot ordering). */
    const val STATUS_UNAVAILABLE = "unavailable"
    /** The platform refused the request (a fixed-orientation Activity, a system policy). */
    const val STATUS_DENIED = "denied"

    /**
     * The foreground Activity whose orientation is set — a **weak** reference: the
     * glue outlives any Activity (it is attached from `MainActivity.onStart`), and
     * holding it strongly would leak the Activity.
     */
    @Volatile
    private var activity: WeakReference<Activity>? = null

    /**
     * Hand the glue the current foreground Activity (called from
     * `MainActivity.onStart`, like `AlarmGlue.attachActivity`). Idempotent.
     */
    fun attachActivity(activity: Activity) {
        this.activity = WeakReference(activity)
    }

    /**
     * Hand the Rust host the JVM through the `attach` JNI upcall so `rotation_set`
     * can call [setOrientation] by name. Fails soft: an APK built **without** the
     * `android` native feature has no `attach` symbol, and that must degrade to a
     * warning instead of crashing boot — the Rust side then simply reports
     * `Unattached` and the stored intent is all there is.
     *
     * Called unconditionally from `MainActivity.onStart`
     * (`MainActivity.Wiring.kt`; required by `scripts/android-activity-wiring-check.sh`).
     */
    fun bind(activity: Activity) {
        attachActivity(activity)
        try {
            attach()
            Log.i(TAG, "rotation native binding attached (JavaVM handed to the host)")
        } catch (t: Throwable) {
            Log.w(TAG, "rotation native attach unavailable (missing android feature?): $t")
        }
    }

    /** JNI upcall → `Java_com_amos_ai_glue_RotationGlue_attach` (Rust `rotation`). */
    private external fun attach()

    /**
     * Apply one Android requested-orientation code (`ActivityInfo.SCREEN_ORIENTATION_*`)
     * to the foreground Activity and answer with a `STATUS_*` word.
     *
     * Returns [STATUS_UNAVAILABLE] when no Activity is attached (the honest "could not
     * apply" — the WebView then says so rather than implying the display turned), and
     * [STATUS_DENIED] when the platform refuses; it never reports a position it did
     * not reach.
     */
    @JvmStatic
    fun setOrientation(code: Int): String {
        val target = activity?.get() ?: return STATUS_UNAVAILABLE
        return try {
            target.requestedOrientation = code
            Log.i(TAG, "requested orientation $code")
            STATUS_APPLIED
        } catch (t: Throwable) {
            Log.w(TAG, "could not set requested orientation $code: ${t.message}")
            STATUS_DENIED
        }
    }
}
