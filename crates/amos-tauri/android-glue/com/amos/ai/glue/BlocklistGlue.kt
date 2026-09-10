// BlocklistGlue.kt — Kotlin half of the AmOS spam blocker.
//
// The rules themselves live in Rust (crates/amos-tauri/src/blocklist.rs, shared
// with the SMS filter). This glue:
//   * tells Rust where to persist the JSON rules (`configure`, called from
//     AmosGlue.onStart and again from the screening service itself, because the
//     system may cold-start our process just to screen one call),
//   * asks Rust whether an incoming call must be rejected
//     (`shouldBlockCall` → `Java_..._BlocklistGlue_shouldBlockCall`),
//   * exposes the Android call-screening *role* state/request so the UI can be
//     honest about whether blocking can actually reject calls yet.
//
// Honest boundary: the SMS side is an AmOS-level filter (the platform's store is
// owned by the default SMS app); the call side uses the platform's official
// CallScreeningService, which **does** reject the call — but only while the
// Call Screening role is granted to AmOS.

package com.amos.ai.glue

import android.app.Activity
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import java.lang.ref.WeakReference

object BlocklistGlue {

    private const val TAG = "BlocklistGlue"

    /**
     * Cached application context (`bind`), so the Rust `blocklist_status` /
     * `blocklist_request_role` commands can reach the role APIs without holding a
     * Context themselves. `null` until `bind` has run.
     */
    @Volatile
    private var appContext: Context? = null

    /**
     * The current foreground Activity (weak, set by `MainActivity.onStart`).
     *
     * Needed because the Call Screening role dialog must be started from a
     * **foreground Activity**: an `applicationContext.startActivity(...)` is
     * silently swallowed by the Android 10+ background-activity-start rules —
     * observed on the API 34 device as "no dialog, role still unheld" while the
     * call returned normally.
     */
    @Volatile
    private var activityRef: WeakReference<Activity>? = null

    /** Remember the foreground Activity so the role dialog can be posted from it. */
    fun attachActivity(activity: Activity) {
        activityRef = WeakReference(activity)
    }

    /** Rust JNI upcall: remember the directory the rules are persisted in. */
    private external fun configure(filesDir: String)

    /** Rust JNI upcall: `true` when this caller must be rejected. */
    private external fun shouldBlockCall(address: String): Boolean

    /** Rust JNI upcall: `true` when at least one rule covers calls. */
    private external fun hasCallRules(): Boolean

    /** Whether requesting the call-screening role is worthwhile (call rules exist). */
    fun needsScreeningRole(context: Context): Boolean {
        if (screeningRoleHeld(context)) return false
        return try {
            hasCallRules()
        } catch (t: Throwable) {
            false
        }
    }

    /**
     * Ask the system for the Call Screening role if call rules exist and the role
     * is not held yet. Started from the application context (the role dialog is a
     * system Activity), so a cold start that never shows the UI still works.
     */
    fun requestScreeningRoleIfNeeded(context: Context): Boolean {
        if (!needsScreeningRole(context)) return false
        val intent = screeningRoleIntent(context) ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.applicationContext.startActivity(intent)
            true
        } catch (t: Throwable) {
            Log.w(TAG, "role request failed: ${t.javaClass.simpleName}")
            false
        }
    }

    /**
     * Point Rust at `<filesDir>/blocklist.json` (idempotent, cheap) and cache the
     * context for the JNI-invoked role helpers below.
     *
     * **Path contract**: this directory must stay identical to what the Rust
     * `setup` configures (`lib.rs`). On Android Tauri's `app_data_dir()` is
     * `Context.getDataDir()` (…/<pkg>), so `lib.rs` appends `files` on Android to
     * land here. If the two ever diverge the UI and the call-screening service
     * silently keep two different rule stores.
     */
    fun bind(context: Context) {
        val ctx = context.applicationContext
        appContext = ctx
        try {
            configure(ctx.filesDir.absolutePath)
        } catch (t: Throwable) {
            // Missing native feature must never crash the telephony path.
            Log.w(TAG, "blocklist configure unavailable: ${t.javaClass.simpleName}")
        }
    }

    /**
     * Rust `blocklist_status`: does this platform support the role at all?
     * (`RoleManager.ROLE_CALL_SCREENING` is API 29+.)
     */
    @JvmStatic
    fun screeningRoleSupported(): Boolean = Build.VERSION.SDK_INT >= 29

    /**
     * Rust `blocklist_status`: does AmOS hold the Call Screening role right now?
     * `false` when the glue was never bound (no context) — callers must not read
     * that as "granted but off".
     */
    @JvmStatic
    fun screeningRoleHeldBound(): Boolean {
        val ctx = appContext ?: return false
        return screeningRoleHeld(ctx)
    }

    /**
     * Rust `blocklist_request_role`: post the system role dialog from the
     * **foreground Activity** (reliable). Returns `true` when the dialog was posted
     * or the role is already held.
     *
     * The previous implementation always used `applicationContext.startActivity`,
     * which the Android 10+ background-activity-start rules can silently drop — on
     * the API 34 device that meant "command returned true, no dialog, role still
     * unheld" (a dishonest success). With no attached Activity we fall back to the
     * application context (still the only option when the UI was never shown).
     */
    @JvmStatic
    fun requestScreeningRoleBound(): Boolean {
        val ctx = appContext ?: return false
        if (screeningRoleHeld(ctx)) return true
        val activity = activityRef?.get()
        // Diagnostic: which path the request took (the app-context fallback is the
        // one the platform can silently drop).
        Log.i(TAG, "requestScreeningRoleBound: activity=${activity != null}")
        if (activity != null && !activity.isFinishing) {
            return requestScreeningRole(activity)
        }
        return requestScreeningRoleIfNeeded(ctx)
    }

    /**
     * Whether an incoming call from [address] must be rejected. Fails **open**
     * (allow the call) if the native side is unavailable: a missing rule engine
     * must not silently block every call.
     */
    fun mustRejectCall(address: String?): Boolean = try {
        shouldBlockCall(address ?: "")
    } catch (t: Throwable) {
        Log.w(TAG, "blocklist check unavailable: ${t.javaClass.simpleName}")
        false
    }

    /** `true` when AmOS holds the call-screening role (required to reject calls). */
    fun screeningRoleHeld(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 29) return false // RoleManager is API 29+
        val rm = context.getSystemService(RoleManager::class.java) ?: return false
        return rm.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)
    }

    /** Intent that asks the user to grant the call-screening role (API 29+). */
    fun screeningRoleIntent(context: Context): android.content.Intent? {
        if (Build.VERSION.SDK_INT < 29) return null
        val rm = context.getSystemService(RoleManager::class.java) ?: return null
        if (rm.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)) return null
        // `createRequestRoleIntent` only carries the role *name*. Some builds (the
        // API 34 MediaTek S5 target here) read the requesting package from
        // `Intent.EXTRA_PACKAGE_NAME` and abort immediately with
        // "Package name cannot be null or empty: null" when it is missing — the
        // dialog flashes for ~100 ms and the role is never granted. Supplying the
        // extra is harmless on builds that derive the caller from the launch info.
        return rm.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING)
            .putExtra(Intent.EXTRA_PACKAGE_NAME, context.packageName)
    }

    /** Request the role from an Activity (no-op when already held/unsupported). */
    fun requestScreeningRole(activity: Activity): Boolean {
        val intent = screeningRoleIntent(activity) ?: return false
        return try {
            // `startActivityForResult` — NOT plain `startActivity`: the role UI
            // resolves the requesting package from the caller identity, which a
            // plain start does not establish. Device-observed on the API 34 target:
            // PermissionController logged "Package name cannot be null or empty"
            // and closed the dialog ~100 ms after it opened.
            activity.startActivityForResult(intent, ROLE_REQUEST_CODE)
            true
        } catch (t: Throwable) {
            Log.w(TAG, "role request failed: ${t.javaClass.simpleName}")
            false
        }
    }

    /** Request code for the Call Screening role dialog (informational only). */
    const val ROLE_REQUEST_CODE = 9002
}
