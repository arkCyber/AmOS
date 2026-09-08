package com.amos.ai.glue

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Receives the exact-alarm broadcast scheduled by [AlarmGlue] and brings the
 * AmOS System UI to the foreground so the WebView notifier can show the ring.
 * The actual ringing/screen animation stays in the WebView (already built); this
 * receiver is only the "wake from a dead/dozing process" device side.
 *
 * Structural delivery only — compile/verify at Android-project / device time.
 * Declare in the manifest (exported=false is fine for an in-package broadcast):
 * ```xml
 * <receiver android:name="com.amos.ai.glue.AlarmReceiver"
 *           android:exported="false" android:enabled="true" />
 * ```
 */
class AlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context?, intent: Intent?) {
        val ctx = context ?: return
        val id = intent?.getStringExtra(AlarmGlue.EXTRA_ID) ?: return
        Log.i(TAG, "exact alarm fired: $id")
        // Bring the System UI activity to the front so its WebView runs the notifier.
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: run {
            Log.w(TAG, "no launcher intent for package — cannot foreground")
            return
        }
        launch.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
        )
        launch.putExtra(AlarmGlue.EXTRA_ID, id)
        try {
            ctx.startActivity(launch)
        } catch (e: Exception) {
            Log.w(TAG, "could not foreground System UI: ${e.message}")
        }
    }

    private companion object {
        const val TAG = "AlarmReceiver"
    }
}
