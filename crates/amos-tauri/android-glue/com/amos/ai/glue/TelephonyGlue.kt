package com.amos.ai.glue

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * AmOS System UI — real outbound dialing glue (host side of docs/telephony.md §2).
 *
 * Real calls must be placed from the process holding the app `Context` (this APK),
 * *not* the headless `amos-ai` daemon. This facade hands the app `Context` to Rust so
 * the `real_dial` command can fire `Intent(ACTION_CALL, tel:…)` through Android
 * Telecom, and requests the runtime `CALL_PHONE` grant that makes that possible.
 *
 * Wire from the generated `MainActivity`:
 *   onStart → [bind] + [ensureCallPermission]
 * (bind is safe to call before the grant; it only stores the context. If the user
 * dials without granting CALL_PHONE the native side returns an explicit error.)
 */
object TelephonyGlue {

    private const val REQ_CALL = 7001

    /** JNI: hand the app context to Rust (`amos-tauri::real_dial` stores a global ref). */
    external fun nativeAttach(context: Context)

    /** Store the app context so `real_dial` can place calls. Idempotent. */
    fun bind(context: Context) {
        nativeAttach(context.applicationContext)
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
