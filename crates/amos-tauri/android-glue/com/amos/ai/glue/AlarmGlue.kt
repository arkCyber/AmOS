package com.amos.ai.glue

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.text.format.DateFormat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference
import java.util.Date

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
    /** Scheme of the per-alarm identity URI (see [alarmIdentity]). */
    private const val ALARM_SCHEME = "amos-alarm"
    /** Notification channel for a firing alarm (created on demand, idempotent). */
    private const val ALARM_CHANNEL = "amos-alarm-firing"
    /** Notification tag; the id is the notification's own id, so two alarms do not overwrite each other. */
    private const val ALARM_NOTIFY_TAG = "amos.alarm"
    /** Intent extra carrying the alarm's instant (epoch ms), so the ring can say when it was set for. */
    const val EXTRA_AT_MS = "amos.alarm.atMs"

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
     * Status words for the **firing** path (see [notifyAlarm]); mirrored by the tests in
     * `android-glue/tests/.../AlarmNotifyStatusTest.kt`.
     */
    const val NOTIFY_POSTED = "posted"
    /** Notifications are switched off for this app (the 33+ runtime permission, or the user's toggle). */
    const val NOTIFY_DENIED = "notify-denied"
    /** No notification service on this device. */
    const val NOTIFY_UNAVAILABLE = "notify-unavailable"

    /**
     * The decision behind [notifyAlarm], isolated so it is testable on the host JVM (no Android
     * types): posting needs a notification service, the user's toggle, and — from API 33 — the
     * runtime `POST_NOTIFICATIONS` grant, which is **off by default for a fresh install**.
     */
    internal fun notifyStatus(apiLevel: Int, servicePresent: Boolean, enabled: Boolean, granted: Boolean): String = when {
        !servicePresent -> NOTIFY_UNAVAILABLE
        apiLevel >= 33 && !granted -> NOTIFY_DENIED
        !enabled -> NOTIFY_DENIED
        else -> NOTIFY_POSTED
    }

    /**
     * Post the **firing notification with a full-screen intent** — the platform-sanctioned way to
     * put an alarm in front of the user when the app is in the background; a plain `startActivity`
     * from a receiver is dropped on Android 10+ (F-TAU-012).
     *
     * **Additive by construction**: this does not replace [AlarmReceiver]'s foreground attempt or
     * the WebView's ring — if nothing can be posted (no service, notifications off, the 33+ runtime
     * permission not granted — which is the default for a fresh install) it returns a status word
     * and the alarm still rings whenever the app gets to run. That is why it is safe to ship before
     * a device round can confirm it: the failure mode is "no visible ring", never "no alarm".
     *
     * The copy is **the OS's own**: the title is the app label and the text is the alarm instant
     * formatted with the device locale, so nothing here hard-codes a language.
     */
    fun notifyAlarm(context: Context, id: String, atMs: Long): String {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE)
            as? NotificationManager
        val status = notifyStatus(
            apiLevel = Build.VERSION.SDK_INT,
            servicePresent = manager != null,
            enabled = NotificationManagerCompat.from(context).areNotificationsEnabled(),
            granted = Build.VERSION.SDK_INT < 33 ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED,
        )
        if (status != NOTIFY_POSTED) {
            Log.w(TAG, "alarm $id fired but its notification was not posted: $status")
            return status
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Idempotent: an existing channel keeps its settings (the user's choices win). The name
            // and description are the OS's own app label, so no language is hard-coded here.
            val label = context.applicationInfo.loadLabel(context.packageManager)
            manager?.createNotificationChannel(
                NotificationChannel(ALARM_CHANNEL, label, NotificationManager.IMPORTANCE_HIGH)
                    .apply { setDescription(label.toString()) },
            )
        }
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: return NOTIFY_UNAVAILABLE
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        launch.putExtra(EXTRA_ID, id)
        val show = PendingIntent.getActivity(
            context,
            requestCode(id),
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val time = DateFormat.getTimeFormat(context).format(Date(atMs))
        val notification = NotificationCompat.Builder(context, ALARM_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(context.applicationInfo.loadLabel(context.packageManager))
            .setContentText(time)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(true)
            .setContentIntent(show)
            .setFullScreenIntent(show, true)
            .build()
        return try {
            // One notification id per alarm: two alarms cannot overwrite each other's ring.
            NotificationManagerCompat.from(context).notify(ALARM_NOTIFY_TAG, requestCode(id), notification)
            Log.i(TAG, "posted the firing notification for $id (full-screen intent)")
            NOTIFY_POSTED
        } catch (e: SecurityException) {
            Log.w(TAG, "notify denied for $id: ${e.message}")
            NOTIFY_DENIED
        }
    }

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
     * The foreground Activity the settings screen must be posted from — a **weak** reference: the
     * glue outlives any Activity (it is attached from `MainActivity.onStart` and the process keeps
     * it), and holding it strongly would leak the Activity across a rotation.
     *
     * **`@Volatile` is load-bearing**: it is written on the main thread (attach) and read on a
     * Rust/JNI worker thread (the settings command), so without it the reader may keep seeing
     * `null` and answer `false` for an Activity that is right there (REQ-A374).
     */
    @Volatile
    private var activity: WeakReference<Activity>? = null

    /** Hand the glue the current foreground Activity (from `MainActivity.onStart`, like the role/
     *  uninstall dialogs in `BlocklistGlue`/`DevCareGlue`). Idempotent. */
    fun attachActivity(activity: Activity) {
        this.activity = WeakReference(activity)
    }

    /**
     * Open the per-app **Alarms & reminders** screen (API 31+) so the user can grant exact alarms.
     *
     * It **must** be posted from a foreground Activity: an application-context `startActivity` is
     * silently dropped by the Android 10+ background-activity-start rules — this repository already
     * paid for that lesson once (the Call Screening role dialog reported success while no dialog
     * appeared, device-verified on API 34), and the same rule applies here. So this returns `false`
     * when no Activity is attached (or the platform refuses) rather than reporting a screen that
     * never opened; the caller can then say "could not open it" honestly.
     */
    fun openExactAlarmSettings(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
        val target = activity?.get() ?: return false
        return try {
            val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
                .setData(Uri.fromParts("package", target.packageName, null))
            target.startActivity(intent)
            true
        } catch (t: Throwable) {
            Log.w(TAG, "could not open exact-alarm settings: ${t.message}")
            false
        }
    }

    private fun requestCode(id: String): Int = REQUEST_BASE + id.hashCode()

    /**
     * **The identity of one alarm's `PendingIntent`.**
     *
     * `PendingIntent` equality ignores extras, so two alarms whose ids merely *hash* alike
     * (`REQUEST_BASE + id.hashCode()`) would be the **same** PendingIntent: scheduling the second
     * would silently overwrite the first's id extra, and cancelling either would cancel both —
     * i.e. the wrong alarm rings (or a real one stops ringing). Java's `String.hashCode` makes
     * that collision easy to construct (`"Aa"` and `"BB"` are the textbook pair), so the request
     * code cannot be the identity: the intent also carries a per-id **data URI**, which does take
     * part in `PendingIntent` equality.
     *
     * Kept as a pure function (no Android types) so the host-JVM test in
     * `android-glue/tests/.../AlarmIdentityTest.kt` can pin it — including that colliding-hashCode
     * ids stay distinct.
     */
    internal fun alarmIdentity(id: String): String = "$ALARM_SCHEME://$id"

    private fun pending(context: Context, id: String, atMs: Long): PendingIntent {
        val target = Intent(context, AlarmReceiver::class.java)
            .setAction(ACTION_EXACT)
            .setData(Uri.parse(alarmIdentity(id)))
            .putExtra(EXTRA_ID, id)
            .putExtra(EXTRA_AT_MS, atMs)
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
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pending(context, id, atMs))
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, atMs, pending(context, id, atMs))
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
        // The instant is *not* part of the PendingIntent's identity (extras never are — that is
        // exactly the defect F-TAU-011 fixed, where the request code had to stop being the
        // identity), so cancelling does not need to know when the alarm was set for.
        am.cancel(pending(context, id, atMs = 0L))
        Log.i(TAG, "cancelled exact alarm $id")
        return STATUS_CANCELLED
    }
}

