// AmosCallScreeningService.kt — real incoming-call blocking for AmOS.
//
// Android's sanctioned way for an app to reject calls is a
// `CallScreeningService` holding the **Call Screening role**
// (`RoleManager.ROLE_CALL_SCREENING`, API 29+). The system binds this service for
// every incoming call, we ask the Rust blocklist (shared with the SMS filter),
// and then either reject or allow it:
//
//   * blocked  → `disallowCall` + `rejectCall` + `skipNotification` + `skipCallLog`
//     (the call is never shown, never answered, and leaves **no** entry in the
//     platform call log — the same rule the SMS side applies when it hides a
//     blocked sender's thread from the list),
//   * allowed  → the platform proceeds normally (and is logged normally).
//
// We do **not** record a block reason anywhere: `CallScreeningService.CallResponse`
// has no field for one, and there is no sanctioned way to annotate the platform's
// call log. An earlier version of this comment claimed the reason was written
// there — no line ever did it.
//
// The rules live in Rust; this service only asks. That keeps one source of truth
// for "is this number blocked" across SMS and calls.

package com.amos.ai.glue

import android.telecom.Call
import android.telecom.CallScreeningService
import android.util.Log

class AmosCallScreeningService : CallScreeningService() {

    override fun onScreenCall(details: Call.Details) {
        val number = details.handle?.schemeSpecificPart
        // Rules are persisted by Rust; a cold-started process needs the path.
        BlocklistGlue.bind(this)
        val reject = BlocklistGlue.mustRejectCall(number)
        val response = CallResponse.Builder()
            .setDisallowCall(reject)
            .setRejectCall(reject)
            .setSkipCallLog(reject)
            .setSkipNotification(reject)
            .build()
        if (reject) {
            Log.i(TAG, "incoming call rejected by AmOS blocklist")
        }
        respondToCall(details, response)
    }

    private companion object {
        const val TAG = "AmosCallScreen"
    }
}
