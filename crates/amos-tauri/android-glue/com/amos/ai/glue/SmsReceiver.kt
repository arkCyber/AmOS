// SmsReceiver.kt — manifest-registered SMS_RECEIVED receiver for AmOS.
//
// Why a manifest receiver *and* the dynamic one in `SmsGlue.bind`?
//   * The dynamic receiver only lives while the System UI process runs.
//   * A manifest receiver is delivered by the system even if the process was
//     killed (it starts the process), which is what a real SMS app needs.
// Both funnel into the same Rust upcall, so the UI refresh path is identical.
//
// Registered as `android:permission="android.permission.BROADCAST_SMS"` +
// `exported="true"`: SMS_RECEIVED is a protected broadcast, so requiring the
// sender to hold BROADCAST_SMS keeps third parties from injecting fake messages.

package com.amos.ai.glue

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/** Manifest receiver: forwards `SMS_RECEIVED` into the Rust-backed glue. */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        SmsGlue.onSmsReceived(intent)
    }
}
