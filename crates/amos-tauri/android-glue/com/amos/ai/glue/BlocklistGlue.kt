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

object BlocklistGlue {

    private const val TAG = "BlocklistGlue"

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

    /** Point Rust at `<filesDir>/blocklist.json` (idempotent, cheap). */
    fun bind(context: Context) {
        try {
            configure(context.applicationContext.filesDir.absolutePath)
        } catch (t: Throwable) {
            // Missing native feature must never crash the telephony path.
            Log.w(TAG, "blocklist configure unavailable: ${t.javaClass.simpleName}")
        }
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
        return rm.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING)
    }

    /** Request the role from an Activity (no-op when already held/unsupported). */
    fun requestScreeningRole(activity: Activity): Boolean {
        val intent = screeningRoleIntent(activity) ?: return false
        return try {
            activity.startActivity(intent)
            true
        } catch (t: Throwable) {
            Log.w(TAG, "role request failed: ${t.javaClass.simpleName}")
            false
        }
    }
}
