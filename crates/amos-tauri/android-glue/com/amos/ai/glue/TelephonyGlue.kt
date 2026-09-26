package com.amos.ai.glue

import android.Manifest
import android.app.Activity
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.telecom.TelecomManager
import android.telephony.TelephonyManager
import android.util.Log
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference

/**
 * AmOS System UI — real outbound dialing glue (host side of docs/telephony.md §2).
 *
 * Real calls must be placed from the process holding the app `Context` (this APK),
 * *not* the headless `amos-ai` daemon. This facade hands the app `Context` to Rust so
 * the `real_dial` command can fire `Intent(ACTION_CALL, tel:…)` through Android
 * Telecom, and requests the runtime `CALL_PHONE` grant that makes that possible.
 *
 * It is also the home of the **default-phone-app (ROLE_DIALER)** seam: the whole
 * real in-call bridge — answering, hanging up, mute / speaker / hold / DTMF /
 * recording (`AmosInCallService.kt` + `crates/amos-tauri/src/incall.rs`) — only exists
 * while AmOS holds that role, and until this round nothing in any layer could ask
 * whether it is held or post the system dialog that grants it (REQ-A1180). The sibling
 * role ROLE_CALL_SCREENING has had both since `BlocklistGlue`; the dialer role is the
 * precondition for the larger feature and had neither.
 *
 * Wire from the generated `MainActivity`:
 *   onStart → [bind] + [ensureCallPermission]
 * (bind is safe to call before the grant; it only stores the context. If the user
 * dials without granting CALL_PHONE the native side returns an explicit error.)
 */
object TelephonyGlue {

    private const val REQ_CALL = 7001
    private const val TAG = "TelephonyGlue"

    /** The app context, kept on the Kotlin side too (the role APIs need it). */
    @Volatile
    private var appContext: Context? = null

    /** The foreground Activity, when one was handed to us (the role dialog needs it). */
    private var activityRef: WeakReference<Activity>? = null

    /** JNI: hand the app context to Rust (`amos-tauri::real_dial` stores a global ref). */
    external fun nativeAttach(context: Context)

    /** Store the app context so `real_dial` can place calls. Idempotent. */
    fun bind(context: Context) {
        appContext = context.applicationContext
        nativeAttach(context.applicationContext)
    }

    /**
     * Hand the glue the **foreground** Activity.
     *
     * The ROLE_DIALER dialog resolves the requesting package from the caller identity, and a
     * plain application-context `startActivity` is what `BlocklistGlue` proved can be silently
     * dropped on Android 10+ (the command answered success while no dialog appeared). The
     * Activity is held weakly: the WebView shell outlives every Activity instance.
     */
    fun attachActivity(activity: Activity) {
        activityRef = WeakReference(activity)
    }

    // ---- default phone app (ROLE_DIALER) ----

    /**
     * Rust `telephony_default_dialer_status` → is this device even a phone?
     *
     * `false` is the honest answer on a tablet / a device without telephony, where the role
     * cannot be granted at all — the UI must say that rather than show a dead button.
     */
    @JvmStatic
    fun dialerRoleSupportedBound(): Boolean {
        val ctx = appContext ?: return false
        return ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
    }

    /**
     * Rust `telephony_default_dialer_status` → can a request be **delivered**?
     *
     * `false` means the glue was never bound (a build without the `android` native feature, or
     * `bind` has not run yet), so the status command reports "we could not ask" instead of
     * claiming a verdict the host does not have.
     */
    @JvmStatic
    fun dialerRoleReady(): Boolean = appContext != null

    /**
     * Whether AmOS is currently the device's default phone app.
     *
     * API 29+ answers through `RoleManager` (the same authority the user grants in Settings);
     * below that the role API does not exist, so the legacy `TelecomManager` answers — its
     * `defaultDialerPackage` is the pre-29 spelling of exactly this question. Both are the
     * *platform's* answer, never inferred from whether an in-call service happens to be bound:
     * the service is bound only while there is a call, so asking it would say "not the dialer"
     * on a correctly configured phone between calls.
     */
    @JvmStatic
    fun dialerRoleHeldBound(): Boolean {
        val ctx = appContext ?: return false
        return dialerRoleHeld(ctx)
    }

    /** Whether [context]'s package is the default dialer (API-level aware). */
    fun dialerRoleHeld(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val rm = context.getSystemService(RoleManager::class.java) ?: return false
            rm.isRoleHeld(RoleManager.ROLE_DIALER)
        } else {
            val tm = context.getSystemService(TelecomManager::class.java) ?: return false
            tm.defaultDialerPackage == context.packageName
        }
    }

    /**
     * Rust `telephony_request_default_dialer`: post the system dialog that grants ROLE_DIALER.
     *
     * Returns `true` when the dialog was posted **or** the role is already held — never "the user
     * accepted", which only a later status read can answer. Falls back to the application context
     * when no Activity was attached (the dialog may still appear, since the caller is the
     * foreground app; the fallback is logged so a silent no-op is visible in logcat).
     */
    @JvmStatic
    fun requestDialerRoleBound(): Boolean {
        val ctx = appContext ?: return false
        if (dialerRoleHeld(ctx)) return true
        val activity = activityRef?.get()
        val from: Context = if (activity != null && !activity.isFinishing) activity else ctx
        Log.i(TAG, "requestDialerRoleBound: activity=${activity != null}")
        val intent = dialerRoleIntent(from) ?: return false
        return try {
            // `startActivityForResult` when we have an Activity, for the same reason
            // `BlocklistGlue` does: the role UI resolves the requesting package from the
            // caller identity, which a plain start does not establish.
            if (from is Activity) {
                from.startActivityForResult(intent, REQ_DIALER_ROLE)
            } else {
                from.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            true
        } catch (t: Throwable) {
            Log.w(TAG, "dialer role request failed: ${t.javaClass.simpleName}")
            false
        }
    }

    /** The intent that asks the user to make this package the default phone app. */
    fun dialerRoleIntent(context: Context): Intent? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val rm = context.getSystemService(RoleManager::class.java) ?: return null
            if (rm.isRoleHeld(RoleManager.ROLE_DIALER)) return null
            // Same build quirk `BlocklistGlue` documents: some OEM builds read the requesting
            // package from `Intent.EXTRA_PACKAGE_NAME` and abort when it is missing.
            rm.createRequestRoleIntent(RoleManager.ROLE_DIALER)
                .putExtra(Intent.EXTRA_PACKAGE_NAME, context.packageName)
        } else {
            val tm = context.getSystemService(TelecomManager::class.java) ?: return null
            if (tm.defaultDialerPackage == context.packageName) return null
            Intent(TelecomManager.ACTION_CHANGE_DEFAULT_DIALER)
                .putExtra(TelecomManager.EXTRA_CHANGE_DEFAULT_DIALER_PACKAGE_NAME, context.packageName)
        }
    }

    /** Request code for the ROLE_DIALER dialog (informational only). */
    const val REQ_DIALER_ROLE = 7002

    // ---- cellular signal (the honest "bars" tile) ----

    /**
     * Rust `cellular_signal` → is this device a phone at all?
     *
     * `false` on a tablet / a Wi-Fi-only device, where no SIM could ever exist — the
     * UI then hides the tile rather than drawing bars that can never fill. This is the
     * same `FEATURE_TELEPHONY` fact `dialerRoleSupportedBound` answers, kept as its own
     * probe so the cellular seam does not depend on the dialer role's wording.
     */
    @JvmStatic
    fun cellularSupportedBound(): Boolean {
        val ctx = appContext ?: return false
        return ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
    }

    /**
     * Rust `cellular_signal` → is a SIM present and ready?
     *
     * `SIM_STATE_READY` is the platform's own "a SIM is loaded and usable" verdict; an
     * ABSENT / PIN-locked / errored SIM answers `false`, so the tile says "no service"
     * instead of showing a radio that has nothing to attach to. `getSimState` needs no
     * permission.
     */
    @JvmStatic
    fun cellularPresentBound(): Boolean {
        val ctx = appContext ?: return false
        val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return false
        return tm.simState == TelephonyManager.SIM_STATE_READY
    }

    /**
     * Rust `cellular_signal` → the real signal level, `1..=4`, or `-1` when unreadable.
     *
     * `TelephonyManager#getSignalStrength` is API 28+, so below that there is no reading
     * to return (the host maps `-1` to "no usable signal", the same line it draws for a
     * reported 0). `READ_PHONE_STATE` is a *runtime* permission: without the grant the
     * call throws `SecurityException`, which is caught into `-1` rather than crashing —
     * an honest "we could not read it" that never impersonates a strong signal.
     */
    @JvmStatic
    fun cellularSignalLevelBound(): Int {
        val ctx = appContext ?: return -1
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return -1
        val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return -1
        return try {
            tm.signalStrength?.level ?: -1
        } catch (t: Throwable) {
            Log.i(TAG, "cellular signal unreadable: ${t.javaClass.simpleName}")
            -1
        }
    }

    /**
     * Whether the runtime `CALL_PHONE` grant is held right now (REQ-A1626).
     *
     * `bind` is unconditional at `onStart`/`nativeAttach`, so a phone whose user **denied**
     * `CALL_PHONE` still has a bound context — without this probe the host reports "a real
     * call can be fired right now" and routes a dial into an `ACTION_CALL` the platform
     * rejects. This is what lets the native side answer honestly instead.
     *
     * `false` when no context was handed over either: with no Context nothing can dial, so
     * "cannot fire a real call" is both the truthful and the safe direction — the same one
     * [ensureCallPermission] asks the user to change.
     */
    @JvmStatic
    fun callPermissionGrantedBound(): Boolean {
        val ctx = appContext ?: return false
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.CALL_PHONE) ==
            PackageManager.PERMISSION_GRANTED
    }

    /** Ask for CALL_PHONE (dangerous) if not already granted. Idempotent. */
    fun ensureCallPermission(activity: Activity) {
        val granted = ContextCompat.checkSelfPermission(activity, Manifest.permission.CALL_PHONE) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.CALL_PHONE),
                REQ_CALL,
            )
        }
    }

    /** Forward a permission result into a toast (bind is already unconditional in onStart). */
    fun onResult(activity: Activity, requestCode: Int, grantResults: IntArray) {
        if (requestCode != REQ_CALL) return
        val granted = grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        Toast.makeText(
            activity,
            if (granted) "电话权限已开启 — 可拨打真实电话"
            else "电话权限被拒绝 — 拨号仅演示/回退",
            Toast.LENGTH_LONG,
        ).show()
    }
}
