package com.amos.ai.glue

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
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
 * REQ-A369 closed the seam this file used to *describe* while nothing called it: a
 * real device round (REQ-A362) measured `dumpsys alarm` **empty** after a
 * registration the WebView saw succeed ⇒ the host had only written its in-memory
 * ledger, so a sleeping phone was never woken. Two things were missing, both here
 * now:
 *   1. [bind] hands the Rust host a `Context` through a JNI upcall
 *      (`Java_com_amos_ai_glue_AlarmGlue_attachContext`) — the host cannot reach
 *      `AlarmManager` without one;
 *   2. [schedule]/[cancel] **return a status string** instead of `Unit`, so the
 *      host can tell the caller what really happened. A refusal is a fact, not a
 *      log line: `setExactAndAllowWhileIdle` throws `SecurityException` on API 31+
 *      unless exact alarms are allowed for this app, and "scheduled" would be a lie.
 *
 * Thread-safety: both entry points are called from Rust threads through JNI; the
 * `AlarmManager` calls are thread-safe, and so is `Log`.
 */
object AlarmGlue {

    private const val TAG = "AlarmGlue"
    /** Broadcast action for an exact-alarm firing. */
    const val ACTION_EXACT = "com.amos.systemui.EXACT_ALARM"
    /** Intent extra carrying the alarm id the WebView knows. */
    const val EXTRA_ID = "amos.alarm.id"

    private const val REQUEST_BASE = 0x414c // "AL"

    /**
     * Status strings the Rust host maps to a typed device outcome and surfaces to the
     * WebView — mirrored by `alarm_sched::device_arm_from_status`, which has a unit
     * test pinning every spelling (keep the two in sync).
     */
    const val STATUS_SCHEDULED = "scheduled"
    const val STATUS_CANCELLED = "cancelled"
    /** The user (or the OS) has not allowed this app to schedule exact alarms (API 31+). */
    const val STATUS_DISALLOWED = "disallowed"
    /** No `AlarmManager` service on this device. */
    const val STATUS_UNAVAILABLE = "unavailable"
    /** `setExact…` threw `SecurityException` even though `canScheduleExactAlarms()` said yes. */
    const val STATUS_DENIED = "denied"

    /**
     * Hand the Rust host the app `Context` so `scheduler_alarm_register/_cancel` can
     * reach `AlarmManager` (the host keeps a `GlobalRef`; see `alarm_sched.rs`).
     *
     * Idempotent and fails soft, like the other glues: an APK built **without** the
     * `android` native feature has no `attachContext` symbol, and that must degrade to
     * a warning instead of crashing boot. Called from `MainActivity.onStart`
     * (`MainActivity.Wiring.kt`; required by `scripts/android-activity-wiring-check.sh`).
     */
    fun bind(context: Context) {
        val app = context.applicationContext ?: context
        try {
            attachContext(app)
            Log.i(TAG, "alarm native binding attached (context handed to the host)")
        } catch (t: Throwable) {
            Log.w(TAG, "alarm native attach unavailable (missing android feature?): $t")
        }
    }

    /** JNI upcall → `Java_com_amos_ai_glue_AlarmGlue_attachContext` (Rust `alarm_sched`). */
    private external fun attachContext(context: Context)

    /** Android 12+ can refuse exact alarms per app; below API 31 they are always allowed. */
    fun canScheduleExact(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return false
        return am.canScheduleExactAlarms()
    }

    /**
     * Open the per-app **Alarms & reminders** screen (API 31+) so the user can grant
     * exact alarms. Returns whether a screen was actually started — the host then
     * reports "could not open it" instead of claiming a dialog appeared.
     */
    fun openExactAlarmSettings(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
        return try {
            val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
                .setData(Uri.fromParts("package", context.packageName, null))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        } catch (t: Throwable) {
            Log.w(TAG, "could not open exact-alarm settings: ${t.message}")
            false
        }
    }

    private fun requestCode(id: String): Int = REQUEST_BASE + id.hashCode()

    private fun pending(context: Context, id: String): PendingIntent {
        val target = Intent(context, AlarmReceiver::class.java)
            .setAction(ACTION_EXACT)
            .putExtra(EXTRA_ID, id)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, requestCode(id), target, flags)
    }

    /**
     * Schedule an exact wake at `atMs` (epoch ms) for alarm `id`.
     *
     * Returns one of the `STATUS_*` strings: the host must be able to say *"this alarm
     * will not wake the phone"* instead of reporting a success that is only true while
     * our process happens to be alive.
     */
    fun schedule(context: Context, id: String, atMs: Long): String {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
            ?: return STATUS_UNAVAILABLE
        if (!canScheduleExact(context)) {
            Log.w(TAG, "exact alarms not allowed for this app — $id not scheduled")
            return STATUS_DISALLOWED
        }
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pending(context, id))
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, atMs, pending(context, id))
            }
            Log.i(TAG, "scheduled exact alarm $id at $atMs")
            STATUS_SCHEDULED
        } catch (e: SecurityException) {
            Log.w(TAG, "setExact denied for $id: ${e.message}")
            STATUS_DENIED
        }
    }

    /** Cancel a previously scheduled exact alarm for `id`. Returns a `STATUS_*` string. */
    fun cancel(context: Context, id: String): String {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
            ?: return STATUS_UNAVAILABLE
        am.cancel(pending(context, id))
        Log.i(TAG, "cancelled exact alarm $id")
        return STATUS_CANCELLED
    }
}

