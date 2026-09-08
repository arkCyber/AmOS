package com.amos.ai.glue

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * AmOS System UI — **AlarmManager exact-wake binding** (device step, §9 ③).
 *
 * Mirrors the Rust `scheduler_alarm_register/cancel` commands (`amos-tauri`):
 * this schedules a real Android `AlarmManager.setExactAndAllowWhileIdle` so an
 * alarm can wake the device even when it is dozing / the process is backgrounded.
 * When the alarm fires, [AlarmReceiver] brings the System UI to the foreground;
 * the WebView's existing notifier (`alarmNotify`) then shows the ring.
 *
 * Structural delivery only — compile/verify at Android-project / device time
 * (kept under `android-glue` exactly like `MainActivity.Wiring.kt`). Wire:
 *   - From the Rust host after each successful `scheduler_alarm_register`, call
 *     `AlarmGlue.schedule(ctx, id, atMs)` (thread-safety: post to the main thread
 *     or a Handler).
 *   - From `scheduler_alarm_cancel`, call `AlarmGlue.cancel(ctx, id)`.
 *   - Declare `AlarmReceiver` in the manifest and grant
 *     `SCHEDULE_EXACT_ALARM` (Android 12+) + `POST_NOTIFICATIONS`.
 */
object AlarmGlue {

    private const val TAG = "AlarmGlue"
    /** Broadcast action for an exact-alarm firing. */
    const val ACTION_EXACT = "com.amos.systemui.EXACT_ALARM"
    /** Intent extra carrying the alarm id the WebView knows. */
    const val EXTRA_ID = "amos.alarm.id"

    private const val REQUEST_BASE = 0x414c // "AL"

    private fun requestCode(id: String): Int = REQUEST_BASE + id.hashCode()

    private fun pending(context: Context, id: String): PendingIntent {
        val target = Intent(context, AlarmReceiver::class.java)
            .setAction(ACTION_EXACT)
            .putExtra(EXTRA_ID, id)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, requestCode(id), target, flags)
    }

    /** Schedule an exact wake at `atMs` (epoch ms) for alarm `id`. */
    fun schedule(context: Context, id: String, atMs: Long) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
            Log.w(TAG, "exact alarms disallowed (SCHEDULE_EXACT_ALARM) — skip $id")
            return
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pending(context, id))
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, atMs, pending(context, id))
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "setExact denied for $id: ${e.message}")
        }
    }

    /** Cancel a previously scheduled exact alarm for `id`. */
    fun cancel(context: Context, id: String) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        am.cancel(pending(context, id))
    }
}
