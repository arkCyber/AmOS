package com.amos.ai.glue

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Receives the exact-alarm broadcast scheduled by [AlarmGlue], asks the System UI to come forward
 * so the WebView notifier can show the ring, and says honestly whether that request could be made.
 *
 * **Production boundary (measured rule, not a guess).** A broadcast receiver runs in the
 * background, and on Android 10+ a background app may not start an activity: the platform drops
 * the call and only logs it. This repository already paid for that lesson once — the Call
 * Screening role dialog "reported success while no dialog appeared" on API 34 — so this receiver
 * no longer *claims* the UI came up: it logs what it attempted, and the alarm's **visible** ring on
 * a killed/backgrounded app still needs the documented production path (a full-screen-intent
 * notification, which needs `POST_NOTIFICATIONS` + `USE_FULL_SCREEN_INTENT` + a channel — see
 * `docs/native-alarm-bridge.md` §"真机验收清单" and `F-TAU-012`). The alarm itself still fires and
 * the app's process is started, which is what the in-process ledger/WebView notifier needs.
 *
 * Declared in the manifest (an in-package broadcast, so not exported):
 * ```xml
 * <receiver android:name="com.amos.ai.glue.AlarmReceiver"
 *           android:exported="false" android:enabled="true" />
 * ```
 */
class AlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context?, intent: Intent?) {
        val ctx = context ?: return
        // Only our own exact-alarm broadcast: an app-internal sender could otherwise craft an
        // intent that foregrounds the UI with an arbitrary id.
        if (intent?.action != AlarmGlue.ACTION_EXACT) return
        val id = intent.getStringExtra(AlarmGlue.EXTRA_ID) ?: return
        Log.i(TAG, "exact alarm fired: $id")
        // Ask the System UI to come forward. Subject to the background-activity-start rules above:
        // when the platform refuses, the log is the only evidence (and the acceptance step in the
        // docs greps for it) — the alarm has still fired, and the ring is drawn as soon as the
        // WebView runs.
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
            Log.i(TAG, "asked the System UI to foreground for $id (subject to background-start rules)")
        } catch (e: Exception) {
            Log.w(TAG, "could not foreground System UI: ${e.message}")
        }
        // The platform-sanctioned half (REQ-A375): a full-screen-intent notification can put the
        // ring in front of the user even when the background-activity-start rule above drops the
        // startActivity. Additive on purpose — a refusal here (notifications off, the 33+ runtime
        // permission not granted) leaves the alarm itself intact, and the status word is logged.
        val atMs = intent.getLongExtra(AlarmGlue.EXTRA_AT_MS, System.currentTimeMillis())
        val notify = AlarmGlue.notifyAlarm(ctx, id, atMs)
        if (notify != AlarmGlue.NOTIFY_POSTED) {
            Log.w(TAG, "no full-screen ring for $id: $notify")
        }
    }

    private companion object {
        const val TAG = "AlarmReceiver"
    }
}
