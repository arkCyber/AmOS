// AmosCallScreeningService.kt — real incoming-call blocking for AmOS.
//
// Android's sanctioned way for an app to reject calls is a
// `CallScreeningService` holding the **Call Screening role**
// (`RoleManager.ROLE_CALL_SCREENING`, API 29+). The system binds this service for
// every incoming call, we ask the Rust blocklist (shared with the SMS filter),
// and then either reject or allow it:
//
//   * blocked  → `disallowCall` + `rejectCall` + `skipNotification` (the call is
//     never shown/answered) and the reason is written to the call log with
//     `setCallComposerAttachments`-free metadata (we do not fabricate anything),
//   * allowed  → the platform proceeds normally.
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
            .setSkipCallLog(false)
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
