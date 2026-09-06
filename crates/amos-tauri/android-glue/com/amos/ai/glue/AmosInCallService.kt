package com.amos.ai.glue

import android.telecom.Call
import android.telecom.CallAudioState
import android.telecom.InCallService
import android.telecom.VideoProfile
import android.util.Log

/**
 * AmOS System UI — real in-call host (docs/telephony.md §"ROLE_DIALER + InCallService").
 *
 * Android binds this service only once AmOS is the **default phone app**
 * (RoleManager.ROLE_DIALER) — a runtime setting the user can grant on any retail
 * device, no root. It then receives every Telecom `Call` (incoming and outgoing) and
 * exposes real answer / end / mute / speaker / hold against the active call.
 *
 * Stage 1 (this file): the service is bindable + tracks the active Telecom [Call];
 * the in-call UI that renders/mirrors state lives on the WebView side and is wired in
 * Stage 2 (native → Rust event push). Control helpers are callable from the app.
 */
class AmosInCallService : InCallService() {

    private var active: Call? = null

    private val callback = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) = onCallStateChanged()
        override fun onCallDestroyed(call: Call) {
            if (call === active) {
                active = null
            }
            onCallStateChanged()
        }
    }

    override fun onCallAdded(call: Call) {
        Log.i(TAG, "onCallAdded state=${call.state}")
        active = call
        call.registerCallback(callback)
        onCallStateChanged()
    }

    override fun onCallRemoved(call: Call) {
        call.unregisterCallback(callback)
        if (call === active) {
            active = null
        }
        onCallStateChanged()
    }

    override fun onCallAudioStateChanged(state: CallAudioState) {
        onCallStateChanged()
    }

    override fun onCreate() {
        super.onCreate()
        Companion.self = this
    }

    override fun onDestroy() {
        active?.unregisterCallback(callback)
        active = null
        if (Companion.self === this) Companion.self = null
        super.onDestroy()
    }

    /** Push the active call's real state to Rust → WebView (`telephony-event`). */
    private fun onCallStateChanged() {
        val c = active
        val state = when (c?.state) {
            Call.STATE_RINGING -> "Ringing"
            Call.STATE_DIALING -> "Dialing"
            Call.STATE_ACTIVE -> "Active"
            Call.STATE_DISCONNECTED -> "Ended"
            else -> "Unknown"
        }
        val details = c?.details
        // This SDK exposes no readable `Call.Details.direction`; infer it from the
        // state (a ringing call we did not originate is incoming).
        val direction = if (state == "Ringing") "Incoming" else "Outgoing"
        val peer = details?.handle?.schemeSpecificPart ?: ""
        Log.i(TAG, "real call -> state=$state dir=$direction peer=$peer")
        nativeState(direction, state, peer)
    }

    /** JNI upcall: real call-state change → Rust `incall` (see amos-tauri/src/incall.rs). */
    private external fun nativeState(direction: String, state: String, peer: String)

    // ---- real call control (callable by the app while we are default dialer) ----

    fun answerIncoming() {
        val c = active ?: return
        if (c.state == Call.STATE_RINGING) {
            c.answer(VideoProfile.STATE_AUDIO_ONLY)
        }
    }

    fun hangUp() {
        active?.disconnect()
    }

    fun isRinging(): Boolean = active?.state == Call.STATE_RINGING
    fun isActiveCall(): Boolean = active?.state == Call.STATE_ACTIVE

    companion object {
        private const val TAG = "AmosInCall"
        @Volatile
        private var self: AmosInCallService? = null

        /** The currently bound service, if the OS attached us (i.e. we are default dialer). */
        fun bound(): AmosInCallService? = self

        /** Rust `incall` queries whether an in-call service is bound (default-dialer). */
        @JvmStatic
        fun isServiceBound(): Boolean = self != null

        /** Answer the real ringing call (invoked from Rust `telephony_answer`). */
        @JvmStatic
        fun answerActive(): Boolean {
            val s = self ?: return false
            s.answerIncoming()
            return true
        }

        /** Hang up the real active call (invoked from Rust `telephony_end`). */
        @JvmStatic
        fun hangUpActive(): Boolean {
            val s = self ?: return false
            s.hangUp()
            return true
        }
    }
}
