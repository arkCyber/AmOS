package com.amos.ai.glue

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * AmOS System UI — the **foreground service a live screen capture requires**.
 *
 * Why this class exists at all: `MediaProjectionManager#getMediaProjection` is only
 * allowed while a foreground service of type `mediaProjection` is running. That is
 * not a soft guideline — on Android 10+ there is no projection without it, and on
 * Android 14+ (API 34) starting the service itself throws `SecurityException` unless
 * `FOREGROUND_SERVICE_MEDIA_PROJECTION` is declared. So the service is part of the
 * capture path, not decoration: [ScreenRecordGlue] starts it *before* asking the OS
 * for the projection and stops it when the recording ends.
 *
 * The notification is also the platform's own honesty requirement — Android says a
 * capture of the whole screen must be visible to the user, which is the same rule
 * the top bar's `ScreenRecordIndicator.svelte` implements on the AmOS side. Its tap
 * target is the System UI itself (there is no per-session screen to deep-link to).
 *
 * The notification copy is a **literal**, not an `R.string`: the generated project's
 * `res/values/strings.xml` is git-ignored (machine-owned `gen/`), so a resource would
 * be a tracked file's dependency on an untracked one — the drift this repo's glue
 * discipline exists to prevent. Every other glue surface (`Toast.makeText` in
 * `MainActivity.Wiring.kt`) does the same. Honest boundary: the marker therefore reads
 * in English on a Chinese-language device; the in-app REC indicator, which *is*
 * localized, is the user-facing surface.
 *
 * `START_NOT_STICKY`: if the process is killed mid-capture the recording is over —
 * restarting the service would re-post a notification for a session that no longer
 * exists. `ScreenRecordGlue` owns the real state; this class only holds the process
 * in the foreground and shows the marker.
 *
 * **`startForeground` is a synchronisation point, not just bookkeeping.** The platform
 * only grants a projection while a service of this type is *actually* in the foreground,
 * and `startForegroundService` is asynchronous — so asking for the projection right after
 * calling it is a race the platform wins. Measured on the S5 (Android 14, REQ-A1875): the
 * eager request answered
 *
 * ```
 * Media projections require a foreground service of type
 * ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
 * ```
 *
 * and the resulting teardown stopped a service that had never foregrounded, which the
 * platform reports as a **fatal** exception:
 *
 * ```
 * android.app.RemoteServiceException$ForegroundServiceDidNotStartInTimeException:
 * Context.startForegroundService() did not then call Service.startForeground()
 * ```
 *
 * — the app died and no file was written. [start] therefore takes a callback that
 * [onStartCommand] invokes *after* `startForeground` returns, and [ScreenRecordGlue]
 * requests the projection from there. The same contract is why [stop] cannot simply call
 * `stopService` when the service has not foregrounded yet: it flags the request, and
 * [onStartCommand] foregrounds and then retires the service, because stopping a
 * `startForegroundService`-started service before `startForeground` *is* the fatal crash
 * above.
 */
class ScreenRecordService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel(this)
        startForeground(NOTIFICATION_ID, notification(this))
        Log.i(TAG, "screen-record foreground service started")
        // Take the waiter and the abandoned flag together, then act outside the lock: the
        // callback runs `ScreenRecordGlue`'s projection setup, which calls back into [stop]
        // on its failure path — that must not re-enter this monitor.
        val ready: (() -> Unit)?
        val abandoned: Boolean
        synchronized(LOCK) {
            foregrounded = true
            abandoned = stopBeforeForeground
            stopBeforeForeground = false
            ready = onForeground
            onForeground = null
        }
        if (abandoned) {
            // The session was abandoned before this point (the projection request failed).
            // The platform's contract is satisfied by the `startForeground` above; only now
            // may the service retire itself. `stopSelf` here is the honest twin of [stop]'s
            // deferred branch.
            Log.i(TAG, "foreground service retired before its session began")
            stopSelf()
            return START_NOT_STICKY
        }
        ready?.invoke()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        // Nothing may outlive the service: a callback left armed would hold the glue's
        // session-start closure (and, through it, the consent Intent) with no one to run it.
        synchronized(LOCK) {
            onForeground = null
            stopBeforeForeground = false
            foregrounded = false
        }
        Log.i(TAG, "screen-record foreground service stopped")
        super.onDestroy()
    }

    companion object {
        private const val TAG = "AmosScreenRecordSvc"

        /** Distinct from every other notification id in the glue (the alarm ring is 9001). */
        const val NOTIFICATION_ID = 9016
        const val CHANNEL_ID = "amos.screen_record"

        /** Guards the three fields below; they are read from the main thread and from
         * [stop]'s callers (which include the glue's teardown path). */
        private val LOCK = Any()

        /** The session to begin once `startForeground` has run, or `null` when none is
         * waiting. Non-null *is* "a start is in flight but has not foregrounded yet". */
        private var onForeground: (() -> Unit)? = null

        /** A [stop] arrived before this service foregrounded; [onStartCommand] honours it. */
        private var stopBeforeForeground = false

        /** `startForeground` has run for the service instance currently up. */
        private var foregrounded = false

        /**
         * Bring the service up and hand back a callback — [onReady] — that fires from
         * [onStartCommand] **after** `startForeground`, so the caller can request a
         * projection that the platform will actually grant.
         *
         * Why a callback rather than "start, then ask": `startForegroundService` is
         * asynchronous (it posts to ActivityManager and returns), so between it and
         * `startForeground` the app has *no* foreground service of this type and
         * `getMediaProjection` is refused. Waiting is not a delay to tune — [onReady]
         * fires exactly once, at the moment the precondition is met, and is dropped if the
         * service is torn down first.
         *
         * A throw from `startForegroundService` (a build without
         * `FOREGROUND_SERVICE_MEDIA_PROJECTION`, a platform policy refusal) is
         * **propagated** after the waiter is cleared: the caller treats it as "no
         * projection is possible", so the session is refused rather than started without
         * the marker the platform insists on.
         */
        fun start(context: Context, onReady: () -> Unit) {
            synchronized(LOCK) {
                onForeground = onReady
                stopBeforeForeground = false
                foregrounded = false
            }
            try {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, ScreenRecordService::class.java),
                )
            } catch (t: Throwable) {
                synchronized(LOCK) { onForeground = null }
                throw t
            }
        }

        /**
         * Retire the service at the end of a session. Idempotent.
         *
         * **If the service has not foregrounded yet, it must not be stopped here.** The
         * platform requires that a service started with `startForegroundService` call
         * `startForeground` before it stops; a `stopService` on one that never did is
         * reported as `ForegroundServiceDidNotStartInTimeException`, which is fatal to the
         * process (measured on the S5, REQ-A1875). So the request is remembered and
         * [onStartCommand] foregrounds and then retires — the platform contract is honoured
         * even for a session that is being abandoned.
         */
        fun stop(context: Context) {
            val deferred = synchronized(LOCK) {
                val armed = onForeground
                onForeground = null
                if (armed != null && !foregrounded) {
                    stopBeforeForeground = true
                    true
                } else {
                    false
                }
            }
            if (deferred) {
                Log.i(TAG, "service stop deferred until it has foregrounded")
                return
            }
            runCatching { context.stopService(Intent(context, ScreenRecordService::class.java)) }
        }

        /**
         * Create the low-importance channel once. IMPORTANCE_LOW: the marker must be
         * visible, but a screen capture is not an alert and must not buzz or pop.
         *
         * No API-level guard: `minSdk` is 26 (O), so notification channels always exist —
         * an `SDK_INT < O` branch would be dead code (Lint's `ObsoleteSdkInt`).
         */
        private fun ensureChannel(context: Context) {
            val manager =
                context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                    ?: return
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Screen recording",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply { description = "Shown while AmOS is recording the screen" },
            )
        }

        /** The ongoing "recording the screen" marker. */
        private fun notification(context: Context): Notification {
            val open =
                context.packageManager.getLaunchIntentForPackage(context.packageName)
                    ?.let { PendingIntent.getActivity(context, 0, it, PENDING_FLAGS) }
            return NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.presence_video_online)
                .setContentTitle("Recording screen")
                .setContentText("AmOS is capturing the screen")
                .setOngoing(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .apply { if (open != null) setContentIntent(open) }
                .build()
        }

        /** `FLAG_IMMUTABLE` unconditionally: it exists from API 23 and `minSdk` is 26. */
        private val PENDING_FLAGS
            get() = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    }
}
