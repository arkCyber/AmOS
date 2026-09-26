package com.amos.ai.glue

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.telecom.Call
import android.telecom.CallAudioState
import android.telecom.InCallService
import android.telecom.VideoProfile
import android.util.Log
import java.io.File

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

    /** The call the controls act on and the push describes; the newest live one. */
    private var active: Call? = null

    /**
     * Every call Telecom currently has up, oldest first. `active` is the last of these, so a
     * call that arrives while another is live (call waiting, a second VoIP leg) does not
     * *evict* the first: `active` moving to the newcomer used to mean the older call left the
     * wire entirely, and when the newcomer was the one to end its own `onCallRemoved` nulled
     * the slot while the older call was still up — the push then reported **nothing at all**
     * (`onCallStateChanged`'s `?: return`), so the screen showed no call, no peer and no
     * controls for a call the user was still on. Dropping a call re-picks `active` from what
     * is left (REQ-A1269 / F-TEL-028).
     */
    private val liveCalls = linkedSetOf<Call>()

    /**
     * Each live call's direction, latched **once** from the first state we ever observed for
     * it — per call, not per service, so the answer survives another call coming and going.
     *
     * Android only exposes an authoritative `Call.Details#getCallDirection()` from API 29 (`Q`);
     * below that version the side has to be remembered, and it must be *remembered* rather than
     * re-derived: a call is `Ringing` only while it waits to be answered, so re-deriving from
     * the state would flip an answered **incoming** call to `Outgoing` the moment it becomes
     * `Active` — and the WebView's incoming-call overlay drops every non-`Incoming` event, so
     * the call would silently vanish from the screen it is being held on (docs/telephony.md
     * §12 #25; the device-side twin of the daemon-side defect §12 #13 fixed).
     */
    private val latchedDirections = mutableMapOf<Call, String>()

    // ---- call recording state (REQ-A1579 / F-TEL-038) ----
    //
    // The live `MediaRecorder`, if a recording is in progress. `null` means "not recording",
    // which is the ordinary state — the service is bound for the whole default-dialer tenure,
    // much longer than any call.
    private var recorder: MediaRecorder? = null

    /** The ledger id minted at [beginRecording]; `null` while nothing is recording. */
    private var recordingId: String? = null

    /** Which audio source the live recording is actually on: `voice_call` or `voice_communication`. */
    private var recordingSource: String? = null

    /** Wall-clock ms when the live recording started; `0` while nothing is recording. */
    private var recordingStartedAtMs: Long = 0L

    /** The file the live recording writes to; deleted by [abortRecording] on a failed stop. */
    private var recordingFile: File? = null

    /**
     * The call the live recording belongs to; `null` while nothing is recording.
     *
     * The recorder is a service-wide object while the service outlives every call, so "a
     * recording is live" and "a call is live" are two different facts. Binding the recording to
     * the call it was started on is what lets [forget] resolve it when **that** call leaves,
     * instead of letting it capture into a call it was never started on — or, once the last call
     * is gone, with no call at all (see [forget]).
     */
    private var recordingCall: Call? = null

    /**
     * The `"<id>|<startedAtMs>|<source>"` report of the last *finished* recording, read once by
     * Rust through [takeFinishedReport]. Kept as a string rather than three fields so a single
     * JNI getter carries it (no new `external fun`) and Rust can fail closed on a malformed one.
     */
    private var finishedReport: String? = null

    private val callback = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) = onCallStateChanged()
        override fun onCallDestroyed(call: Call) {
            forget(call)
            onCallStateChanged()
        }
    }

    override fun onCallAdded(call: Call) {
        Log.i(TAG, "onCallAdded state=${call.state}")
        liveCalls.add(call)
        // Latch the side now, while the first state still tells the truth (a call that
        // arrives `Ringing` was not placed by us; anything else was). See [latchedDirections].
        latchedDirections[call] = if (call.state == Call.STATE_RINGING) "Incoming" else "Outgoing"
        active = call
        call.registerCallback(callback)
        onCallStateChanged()
    }

    override fun onCallRemoved(call: Call) {
        call.unregisterCallback(callback)
        forget(call)
        onCallStateChanged()
    }

    /**
     * Drop [call] from the tracking and, if it was the one on screen, hand `active` to a call
     * that is still live — the newest that remains, the same rule [onCallAdded] uses. A call
     * that leaves must never leave the slot *empty* while others are up: `active == null`
     * means "no call", and reporting that while the user is still on one is the same lie as
     * reporting a phantom call.
     */
    private fun forget(call: Call) {
        liveCalls.remove(call)
        latchedDirections.remove(call)
        if (call === active) {
            active = liveCalls.lastOrNull()
        }
        // A recording belongs to the call it was started on, and the service outlives every call:
        // without this, hanging up mid-recording left the `MediaRecorder` capturing the microphone
        // for the whole default-dialer tenure, writing into a file no ledger row would ever point
        // at — and every later `setRecording(true)` refused on the "already recording" arm, so
        // recording could not be started again until the service was destroyed. `onDestroy`'s
        // rule, owed on the ordinary departure too: no call, no recording. Aborted rather than
        // finalized because nothing reads the finished report once the `Off` path (which needs a
        // live call) can no longer run, and a report nobody reads is a file on disk with no row —
        // the same "no file, no row" rule [abortRecording] states.
        if (call === recordingCall) abortRecording()
    }

    /**
     * The platform's own audio facts changed — this is the *one* callback that fires exactly
     * when the device's mute or route changes, including changes nobody in this app asked for
     * (a Bluetooth headset connecting or dropping, a wired headset, the system in-call UI).
     *
     * Ignoring [state] and merely re-pushing the call state left the WebView showing only the
     * last command *the user* issued, so the screen went on asserting a route the call was not
     * on: the speaker key lit over a call playing through the earpiece, or dark over one on
     * the loudspeaker. [state] is threaded into the push so the event this change provokes
     * carries the value the platform just reported; see [onCallStateChanged] for the wire and
     * REQ-A1268 / F-TEL-028 for the audit.
     */
    override fun onCallAudioStateChanged(state: CallAudioState) {
        onCallStateChanged(state)
    }

    override fun onCreate() {
        super.onCreate()
        Companion.self = this
    }

    override fun onDestroy() {
        // A destroyed service cannot report a finished recording (no `self` to read the report
        // from), so release the recorder here rather than leak it and leave a partial file — the
        // same "no file, no row" rule [abortRecording] exists for.
        abortRecording()
        // Every live call holds this same callback; unregistering only [active] would leave the
        // rest registered against a service that is going away.
        for (c in liveCalls) {
            c.unregisterCallback(callback)
        }
        liveCalls.clear()
        latchedDirections.clear()
        active = null
        if (Companion.self === this) Companion.self = null
        super.onDestroy()
    }

    /**
     * The direction to report for [c] in [state].
     *
     * Ordered by authority: an API-29+ `Call.Details#getCallDirection()` is the platform's own answer;
     * below that, the side latched at [onCallAdded]; and only if neither exists (an SDK < 29
     * call we somehow never saw added while `Ringing`) fall back to the state — the *last*
     * resort, because it is the one answer that changes as a call is answered.
     */
    private fun callDirection(c: Call?, state: String): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && c != null) {
            when (c.details?.callDirection) {
                Call.Details.DIRECTION_INCOMING -> return "Incoming"
                Call.Details.DIRECTION_OUTGOING -> return "Outgoing"
                // `DIRECTION_UNKNOWN`, and a call whose `Details` is null, both fall through
                // to the latched answer below rather than being decided here.
                else -> Unit
            }
        }
        c?.let { latchedDirections[it]?.let { side -> return side } }
        return if (state == "Ringing") "Incoming" else "Outgoing"
    }

    /**
     * Push the active call's real state — and the platform's own audio facts — to Rust →
     * WebView (`telephony-event`).
     *
     * [audio] defaults to this service's current `getCallAudioState()`, which is the same
     * object [onCallAudioStateChanged] is handed; the callback passes its own copy so the push
     * that change *provokes* carries the value the platform just reported. One reading, taken
     * at push time, beats remembering one: a fact cached across pushes would describe the call
     * that is gone (REQ-A1268 / F-TEL-028).
     */
    private fun onCallStateChanged(audio: CallAudioState? = getCallAudioState()) {
        // No active call == nothing to report, so nothing is reported.
        //
        // This runs with `active == null` on real paths: `onCallRemoved` / `onCallDestroyed`
        // call [forget], which leaves the slot empty once the *last* live call is gone, and
        // then call here — and `onCallAudioStateChanged` can fire while nothing is up. The
        // `else -> "Unknown"` arm below is the word for a call that *is*
        // up in a state we do not classify (`STATE_HOLDING`); a `null` call fell into that
        // same arm and was therefore reported to the WebView as a live call, `direction:
        // "Outgoing"` (the latch is cleared by then), `peer: ""`. The shell's subscriber
        // keeps the last word it hears, so after **every** real call the phantom record
        // outlived the `Ended` that preceded it — and re-adopting it (`PhoneApp`'s
        // `adoptLiveCall` reads exactly that record) drew a talking screen for a call that
        // does not exist, with a hang-up that disconnects nothing. The departing call is
        // already announced by the `onStateChanged(DISCONNECTED)` → `Ended` push; a call
        // that was never observed leaving is a call this service cannot describe, and
        // `Unknown` is not the word for "no call" (docs/telephony.md §12 #33, REQ-A1233).
        val c = active ?: return
        val state = when (c.state) {
            Call.STATE_RINGING -> "Ringing"
            Call.STATE_DIALING -> "Dialing"
            Call.STATE_ACTIVE -> "Active"
            Call.STATE_DISCONNECTED -> "Ended"
            else -> "Unknown"
        }
        val details = c.details
        val direction = callDirection(c, state)
        val peer = details?.handle?.schemeSpecificPart ?: ""
        Log.i(TAG, "real call -> state=$state dir=$direction peer=$peer")
        // `audio == null` is the platform's "no call has audio" and goes up as `known = false`
        // — the wire's "no claim", which Rust keeps as an absent field. Sending `false`/`false`
        // instead would *claim* the call is unmuted and on the earpiece, i.e. assert two facts
        // this push never measured (`TelephonyCallPayload::muted`).
        nativeState(
            direction,
            state,
            peer,
            audio?.isMuted == true,
            audio?.route == CallAudioState.ROUTE_SPEAKER,
            audio != null,
        )
    }

    /**
     * JNI upcall: real call-state change → Rust `incall` (see amos-tauri/src/incall.rs).
     *
     * The trailing three are the platform's own audio facts (`muted`, `speaker`, and whether
     * `getCallAudioState()` answered at all) — the mute / route a call is *actually* on,
     * which includes changes nobody in this app asked for. They are booleans rather than an
     * enum because JNI's `Z` is the type the platform's own `CallAudioState` exposes.
     */
    private external fun nativeState(
        direction: String,
        state: String,
        peer: String,
        muted: Boolean,
        speaker: Boolean,
        known: Boolean,
    )

    // ---- real call control (callable by the app while we are default dialer) ----

    /**
     * Answer [active] if it is ringing; `true` **only** when Telecom was actually asked to
     * answer.
     *
     * This service is bound for as long as the user has made AmOS the default phone app —
     * far longer than any one call — so "a service is bound" and "a real call owns this
     * command" are two different facts. Reporting `true` for the first made Rust's route
     * (`crates/amos-tauri/src/telephony.rs::real_call_route`) report the second: every
     * daemon-owned call was handed to this no-op and the command returned `Ok(())`
     * (REQ-A1236 / F-TEL-025). The null / not-ringing arms therefore answer `false`, which
     * the route reads as "nothing real owns this command" and the daemon gets it.
     */
    fun answerIncoming(): Boolean {
        val c = active ?: return false
        if (c.state != Call.STATE_RINGING) return false
        c.answer(VideoProfile.STATE_AUDIO_ONLY)
        return true
    }

    /** Hang up [active]; `true` only when a call was actually disconnected. See [answerIncoming]. */
    fun hangUp(): Boolean {
        val c = active ?: return false
        c.disconnect()
        return true
    }

    fun isRinging(): Boolean = active?.state == Call.STATE_RINGING
    fun isActiveCall(): Boolean = active?.state == Call.STATE_ACTIVE

    // ---- call recording (REQ-A1579 / F-TEL-038) ----
    //
    // The recording helpers split cleanly across two halves. The **device** half
    // (`beginRecording` / `finishRecording` / `abortRecording`) needs a `Context`, the
    // `MediaRecorder` HAL and a live `InCallService` — exercised in the device
    // instrumentation tests (see `android-glue/tests/.../AmosInCallRecordingInstrumentationTest.kt`).
    // The **pure** half — id minting, file-name shape, the `CAPTURE_AUDIO_OUTPUT →
    // VOICE_CALL/VOICE_COMMUNICATION` rule, the report envelope, and the `<filesDir>/recordings`
    // path — is host-JVM testable and lives in `RecordingContract`. The two halves are pinned
    // independently on either side of the JNI boundary: the *cross-language* contract
    // (what Rust sees, what Kotlin answers) is pinned by the `include_str!` source
    // pins in `crates/amos-tauri/src/incall.rs`; the *Kotlin-internal* contract is
    // pinned by `RecordingContractTest.kt` on a host JVM.

    /** `<filesDir>/recordings` (instance form): the live service's own [filesDir].
     *
     * Delegates to `RecordingContract.recordingsRoot` so there is exactly one
     * implementation of the directory rule. See the KDoc on that method for the
     * `filesDir`-vs-`dataDir` rationale (REQ-A1579). */
    private fun recordingsRoot(): File = RecordingContract.recordingsRoot(filesDir)

    /**
     * Start a real `MediaRecorder` on the active call.
     *
     * **Audio source, best-effort** (the honest Android boundary): `VOICE_CALL` — the mixed,
     * two-sided call stream — is gated by `CAPTURE_AUDIO_OUTPUT`, a `signature|privileged`
     * permission only a platform-signed build (AmOS as the OS vendor) can hold. When it *is*
     * granted the recording is two-sided; otherwise the fallback is `VOICE_COMMUNICATION`, which
     * needs only `RECORD_AUDIO` and captures the **near end** (this device's microphone). The
     * source actually used is recorded so the list can say which — never claim the far end was
     * captured when it was not.
     *
     * The id is minted here, not passed in from Rust: the wire's call id is the constant
     * `"real"`, but the ledger key must be unique per call or two recordings would overwrite one
     * file and `add_recording` would dedupe them into a single row.
     *
     * `recorder`/`recordingId`/`recordingFile` are assigned **before** `prepare()`/`start()` so
     * that a throw anywhere below lets [abortRecording] release the recorder and delete the
     * half-written file — the caller does exactly that.
     */
    @SuppressLint("Deprecation") // MediaRecorder(Context) needs API 31; the no-arg ctor is the API 26–30 path
    private fun beginRecording() {
        val id = RecordingContract.newRecordingId()
        val file = File(recordingsRoot(), "$id.m4a")
        val source = if (
            checkSelfPermission(Manifest.permission.CAPTURE_AUDIO_OUTPUT) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            MediaRecorder.AudioSource.VOICE_CALL
        } else {
            MediaRecorder.AudioSource.VOICE_COMMUNICATION
        }
        val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(applicationContext)
        } else {
            MediaRecorder()
        }
        recorder = rec
        recordingId = id
        recordingFile = file
        // Latched with the rest of the live state, and *before* `prepare()`/`start()` for the same
        // reason: a throw below must leave [forget] able to tell which call to resolve, and
        // [abortRecording] clears it.
        recordingCall = active
        recordingSource = RecordingContract.audioSourceName(source)
        rec.setAudioSource(source)
        rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        rec.setAudioSamplingRate(44100)
        rec.setAudioEncodingBitRate(96000)
        rec.setAudioChannels(1)
        rec.setOutputFile(file.absolutePath)
        rec.prepare()
        rec.start()
        recordingStartedAtMs = System.currentTimeMillis()
        Log.i(TAG, "recording started id=$id source=$recordingSource")
    }

    /**
     * Stop the live recorder, release it, and latch the report Rust reads to file the ledger row.
     *
     * A `stop()` that throws is **not** swallowed here: it propagates to [setRecording], whose
     * catch runs [abortRecording] (releasing the recorder and deleting the partial file) and
     * answers `"Failed"`. Latching a report for a file that failed to finalize would file a row
     * pointing at half a container.
     */
    private fun finishRecording() {
        val rec = recorder ?: throw IllegalStateException("no recorder to stop")
        rec.stop()
        rec.release()
        recorder = null
        val id = recordingId
        val src = recordingSource
        val startedAt = recordingStartedAtMs
        if (id != null && src != null && startedAt > 0L) {
            // The wire contract (REQ-A1579): three `|`-separated fields, names pinned by Rust
            // `parse_recording_report`. `RecordingContract.buildReport` is the single source of
            // this shape so a Kotlin/Rust drift shows up in `RecordingContractTest` and in Rust
            // `the_finished_report_parses_exactly_three_well_formed_fields` at the same time.
            finishedReport = RecordingContract.buildReport(id, startedAt, src)
            Log.i(TAG, "recording finished id=$id")
        }
        recordingId = null
        recordingSource = null
        recordingFile = null
        recordingCall = null
        recordingStartedAtMs = 0L
    }

    /**
     * Release the recorder and delete a partial file. Safe to call when nothing is recording and
     * safe to call twice — every step tolerates an absent resource.
     */
    private fun abortRecording() {
        val rec = recorder
        recorder = null
        runCatching { rec?.release() }
        val file = recordingFile
        recordingFile = null
        if (file != null) runCatching { file.delete() }
        recordingId = null
        recordingSource = null
        recordingCall = null
        recordingStartedAtMs = 0L
    }

    /** Read the finished report and clear it — one-shot, so a second read cannot re-file a row. */
    private fun takeFinishedReport(): String {
        val report = finishedReport ?: return ""
        finishedReport = null
        return report
    }

    companion object {
        private const val TAG = "AmosInCall"
        @Volatile
        private var self: AmosInCallService? = null

        /** The currently bound service, if the OS attached us (i.e. we are default dialer). */
        fun bound(): AmosInCallService? = self

        /** Rust `incall` queries whether an in-call service is bound (default-dialer). */
        @JvmStatic
        fun isServiceBound(): Boolean = self != null

        /**
         * Pure recording helpers — host-JVM testable, no `Context` / no `MediaRecorder`.
         *
         * Why a separate object rather than free functions in the service body: every piece of
         * the in-call recording surface the Kotlin side owns crosses either a context boundary
         * (`MediaRecorder`, the `Context.checkSelfPermission` lookup, the `<filesDir>/recordings`
         * path) or a `companion object` boundary (the JNI calls from Rust). Anything inside
         * this object is **portable across both** — exercised on a host JVM by
         * `RecordingContractTest.kt` and on a device by `AmosInCallRecordingInstrumentationTest.kt`.
         *
         * The cross-language half of the contract — the `On` / `Off` / `Failed` words, the
         * source spelling, the `<id>|<startedAtMs>|<source>` envelope — is the same one Rust
         * pins in `incall.rs` via `include_str!`, so the host-JVM test here covers what the
         * cross-language pin cannot (the *internal* shape) and the cross-language pin covers
         * what this test cannot (Kotlin's words matching Rust's parser).
         */
        object RecordingContract {

            /**
             * Mint a unique ledger id. The shape is `"real-<unix_ms>"` — the `real-` prefix
             * collides with nothing else in the ledger (the daemon path uses `tel_<seq>`;
             * see `crates/amos-tauri/src/telephony.rs`) and `add_recording` would otherwise
             * deduplicate two recordings of two different calls into one row.
             *
             * Pure (no I/O): testable on the host JVM.
             */
            fun newRecordingId(now: Long = System.currentTimeMillis()): String =
                "real-$now"

            /**
             * The wire report's envelope (REQ-A1579). Three `|`-separated fields: the id
             * minted by [newRecordingId], the wall-clock start (`System.currentTimeMillis()`
             * taken at `prepare()`/`start()` time), and the audio source the recorder
             * actually used. Rust parses this verbatim and **fails closed** on any drift
             * (`parse_recording_report` rejects extra fields, empty ids, negative starts,
             * unknown sources).
             *
             * Pinned on the Rust side by `the_finished_report_parses_exactly_three_well_formed_fields`
             * and `the_recording_words_follow_the_device_action_never_the_argument`.
             */
            const val REPORT_DELIMITER: String = "|"

            fun buildReport(id: String, startedAtMs: Long, source: String): String {
                require(id.isNotEmpty()) { "recording id must not be empty" }
                require(startedAtMs >= 0L) { "recording start must not be negative" }
                require(source in ALLOWED_SOURCES) {
                    "recording source must be one of $ALLOWED_SOURCES, got $source"
                }
                return "$id$REPORT_DELIMITER$startedAtMs$REPORT_DELIMITER$source"
            }

            /**
             * The two audio source words the recorder actually used, exact strings, **also the
             * only words Rust's `RECORDING_SOURCES` allows in `incall.rs::parse_recording_report`**.
             * A drift here is red on both sides: the host test fails for unknown sources, and
             * the Rust side fails to file the row.
             */
            const val SOURCE_VOICE_CALL: String = "voice_call"
            const val SOURCE_VOICE_COMMUNICATION: String = "voice_communication"
            val ALLOWED_SOURCES: Set<String> =
                setOf(SOURCE_VOICE_CALL, SOURCE_VOICE_COMMUNICATION)

            /**
             * Translate a [MediaRecorder.AudioSource] integer to the wire word. The mapping is
             * **total** by assertion — anything that is not `VOICE_CALL` falls through to
             * `voice_communication` and we refuse to record from any other source. This pins
             * the source-on-the-wire claim and matches the Rust `parse_recording_report`'s
             * allowlist.
             */
            fun audioSourceName(source: Int): String = when (source) {
                MediaRecorder.AudioSource.VOICE_CALL -> SOURCE_VOICE_CALL
                else -> SOURCE_VOICE_COMMUNICATION
            }

            /**
             * The file name a recording will get — `<id>.m4a` inside `<filesDir>/recordings/`.
             * Centralised so the host-JVM test can pin the suffix (Rust reads it back via
             * `recording_path`, which is allowed to invent its own suffix but currently agrees
             * with this one).
             */
            fun fileName(id: String): String = "$id.m4a"

            /**
             * The static form of `AmosInCallService.recordingsRoot(File)`: returns
             * `<filesDir>/recordings`, creating it if absent. The host-JVM test reaches
             * it through this `object` without needing an `AmosInCallService` instance
             * (an `InCallService` subclass needs a real `Context`). Mirrors
             * `recording::app_data_root`'s `<app_data>/files/recordings` contract.
             */
            fun recordingsRoot(filesDir: File): File {
                val dir = File(filesDir, "recordings")
                if (!dir.exists()) dir.mkdirs()
                return dir
            }

            /**
             * The region-blind emergency guard — exposed as a `@JvmStatic` companion method
             * of the same name on `AmosInCallService` (`isEmergency(peer)`) and as the
             * `RecordingContract.isEmergency(peer)` pure form here. The companion
             * instance-method [AmosInCallService.Companion.is_emergency] (kept for its
             * `setRecording` callsite) delegates here so the two cannot drift — pinned by
             * `RecordingContractTest.the_recording_emergency_guard_matches_the_companion_form`.
             *
             * Why this list lives on the device even though the Rust `EmergencyMap` already
             * has one: the Kotlin `setRecording` runs on a hot UI thread where a JNI seam
             * to consult `amos-telephony` would be too expensive. The list is small, stable,
             * and the Rust region maps are *supersets* of it (see the source-pin comment on
             * the inline `is_emergency` predicate below).
             */
            fun isEmergency(peer: String?): Boolean {
                if (peer.isNullOrBlank()) return false
                val digits = peer.filter { it.isDigit() }
                return when {
                    digits == "110" -> true        // Mainland China police
                    digits == "112" -> true        // Mainland China unified emergency
                    digits == "119" -> true        // Mainland China fire
                    digits == "120" -> true        // Mainland China ambulance
                    digits == "122" -> true        // Mainland China traffic
                    digits == "911" -> true        // North America / international
                    digits == "999" -> true        // UK / HK
                    digits == "000" -> true        // Australia
                    digits == "118" -> true        // Japan coast guard
                    digits == "108" -> true        // India
                    else -> false
                }
            }
        }

        /**
         * Answer the real ringing call (invoked from Rust `telephony_answer`).
         *
         * Answers `true` **only when a ringing call was actually answered** — never merely
         * because the service is bound. Rust reads `true` as "the real call was answered"
         * (see `crates/amos-tauri/src/incall.rs::real_answer`); returning it for a bound
         * service with nothing up is how a daemon-owned call was reported answered while it
         * never left the daemon (REQ-A1236 / F-TEL-025).
         */
        @JvmStatic
        fun answerActive(): Boolean {
            val s = self ?: return false
            return s.answerIncoming()
        }

        /**
         * Hang up the real active call (invoked from Rust `telephony_end`).
         *
         * Same rule as [answerActive]: `true` means a real call was disconnected, not that a
         * service exists to hang one up (REQ-A1236 / F-TEL-025).
         */
        @JvmStatic
        fun hangUpActive(): Boolean {
            val s = self ?: return false
            return s.hangUp()
        }

        /**
         * Toggle call recording (invoked from Rust `real_set_recording`).
         *
         * The wire contract is `(Z)Ljava/lang/String;` — one boolean (`true` to start,
         * `false` to stop), one answer that is one of the [`RecordingState`][docs/telephony.md
         * §10.5] words `On` / `Off` / `Failed`. An unrecognised word reaches Rust as
         * `RecordingChange::Unknown(...)`; this is intentional — a future OEM that adds a
         * new state will surface visibly rather than be silently coerced.
         *
         * **The word may only follow the device action** (REQ-A1579 / F-TEL-038). `On` is
         * answered *after* `MediaRecorder.start()` returned and `Off` *after* `stop()` +
         * `release()` returned — never from the `active` argument, which is exactly the defect
         * REQ-A1239 / F-TEL-026 removed (`return if (active) "On" else "Off"` lit the red dot
         * over a call nothing was recording). The six refusals are: no bound service, no active
         * call, an emergency line, already-recording / not-recording (the two intents are not
         * interchangeable), a constructor/`setAudioSource` failure, and a `start()`/`stop()`
         * throw. A throw aborts first ([abortRecording] deletes the partial file), so a `Failed`
         * never leaves a row Rust could file.
         *
         * Rust maps `Failed` to `ErrorCode::TelephonyRecordingRefused`; the in-call screen
         * renders its `phone.recordUnavailable` line. The strings are the same ones
         * `crates/amos-telephony`'s `RecordingState` enum uses.
         */
        @JvmStatic
        fun setRecording(active: Boolean): String {
            val s = self ?: return "Failed"
            val c = s.active ?: return "Failed"
            // Emergency numbers (110/112/911/etc.) are unconditionally refused at this
            // seam (see crates/amos-telephony's `EmergencyMap` for the canonical list). The
            // guard lives in `RecordingContract.isEmergency` (host-JVM testable) and is
            // called *before* the recorder is touched, so a `Failed` here never leaves a
            // row Rust could file. The companion's own `is_emergency` is the same predicate
            // reached via the instance — kept so a `private`-scope reads from the same
            // place on both sides (`RecordingContractTest.the_recording_emergency_guard_matches_the_companion_form`).
            if (is_emergency(c.details?.handle?.schemeSpecificPart)) {
                return "Failed"
            }
            // The two intents are not interchangeable: starting over a live recording would
            // capture twice into one file, and stopping with none live has nothing to stop.
            if (active && s.recorder != null) return "Failed"
            if (!active && s.recorder == null) return "Failed"
            return try {
                if (active) s.beginRecording() else s.finishRecording()
                // Reached only once the device acted: `On` names a live recorder, `Off` a file
                // that finalized.
                if (active) "On" else "Off"
            } catch (e: Exception) {
                Log.w(TAG, "recording toggle failed", e)
                s.abortRecording()
                "Failed"
            }
        }

        /**
         * The report of the last finished recording, one-shot: `"<id>|<startedAtMs>|<source>"`,
         * or `""` when there is none / it was already read.
         *
         * A getter rather than a new `nativeState`-style upcall on purpose — Rust reads it in the
         * same call that observed `"Off"`, so a report from a *previous* call can never be
         * misattributed, and no `external fun` is added (the JNI arity pin is untouched). Rust
         * fails closed on anything that is not exactly three well-formed fields.
         */
        @JvmStatic
        fun recordingResult(): String = self?.takeFinishedReport() ?: ""

        /**
         * Whether `RECORD_AUDIO` is granted, for the runtime capture-capability answer
         * (`crates/amos-tauri/src/recording.rs::capture_facts`).
         *
         * `checkSelfPermission` on the bound service — **not** `MicPermissionGlue.isGranted()`,
         * whose `WeakReference<Activity>` can legitimately be null while the service is bound and
         * would then report a false negative.
         */
        @JvmStatic
        fun isMicGranted(): Boolean {
            val s = self ?: return false
            return s.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        }

        /**
         * Mute / unmute the **local microphone** of the active call (invoked from Rust
         * `telephony_set_muted` when AmOS is the default dialer).
         *
         * Wire contract `(Z)Ljava/lang/String;`, the same `On`/`Off`/`Failed` vocabulary
         * [setRecording] uses; the instance method behind it is the platform's
         * `InCallService#setMuted(boolean)`.
         *
         * A **bound service is not a call** — [holdActive]'s rule, applied here too. `self` is
         * set in `onCreate` and cleared in `onDestroy`, so its lifetime is the whole
         * default-dialer tenure, and `is_default_dialer_bound()` — the gate Rust's
         * `telephony_set_muted` routes on — is exactly `self != null`. "Bound with no call" is
         * therefore the ordinary state between calls, not an edge: answering `On`/`Off` from
         * `active` alone would report the *request* as the *state* of a call that is not there
         * (the shape REQ-A1239 / F-TEL-026 removed from `setRecording`). With no call there is
         * no microphone to mute, so that case refuses (`Failed`) instead (REQ-A1267 /
         * F-TEL-027).
         *
         * Deliberately **not** emergency-guarded, unlike [setRecording]: muting one's own
         * microphone is the owner's decision, where *recording* an emergency line is
         * forbidden. `docs/telephony.md` §6 calls this asymmetry intentional.
         */
        @JvmStatic
        fun muteActive(active: Boolean): String {
            val s = self ?: return "Failed"
            // The service outlives every call: ask for the call, not for its own existence.
            if (s.active == null) return "Failed"
            return try {
                s.setMuted(active)
                if (active) "On" else "Off"
            } catch (e: Exception) {
                Log.w(TAG, "setMuted failed", e)
                "Failed"
            }
        }

        /**
         * Route the call audio to the loudspeaker (`true`) or the earpiece (`false`), invoked
         * from Rust `telephony_set_speaker`. Uses the platform's `InCallService#setAudioRoute`.
         *
         * Honest boundary: this reports whether the *request* was handed to Telecom, not that
         * the route physically switched — a device whose active audio device cannot be the
         * loudspeaker may still be on the earpiece. The same boundary `setRecording` states.
         *
         * The request also needs a route to belong to: a bound service with no call is the
         * ordinary between-calls state ([muteActive] and [holdActive] carry the full reason),
         * and answering `On`/`Off` there reports a per-call route that no call ever had —
         * `Failed` is the honest word (REQ-A1267 / F-TEL-027).
         */
        @JvmStatic
        fun speakerActive(active: Boolean): String {
            val s = self ?: return "Failed"
            // Same rule as [muteActive]: no call, no route to change.
            if (s.active == null) return "Failed"
            return try {
                s.setAudioRoute(
                    if (active) CallAudioState.ROUTE_SPEAKER else CallAudioState.ROUTE_EARPIECE,
                )
                if (active) "On" else "Off"
            } catch (e: Exception) {
                Log.w(TAG, "setAudioRoute failed", e)
                "Failed"
            }
        }

        /**
         * Put the active call on hold (`true`) or take it off hold (`false`), invoked from Rust
         * `telephony_set_hold`. `Call#hold()` throws `IllegalStateException` when the call is not
         * in a holdable state, which surfaces here as `Failed` rather than a silent no-op.
         */
        @JvmStatic
        fun holdActive(active: Boolean): String {
            val s = self ?: return "Failed"
            val c = s.active ?: return "Failed"
            return try {
                if (active) c.hold() else c.unhold()
                if (active) "On" else "Off"
            } catch (e: Exception) {
                Log.w(TAG, "hold/unhold failed", e)
                "Failed"
            }
        }

        /**
         * Send one DTMF tone to the active call (invoked from Rust `telephony_play_dtmf`), so a
         * caller navigating an IVR actually reaches it.
         *
         * Returns `true` only when Telecom accepted the tone; `false` when nothing is bound, the
         * tone is not a DTMF digit, or the platform refused. The tone is stopped after
         * [DTMF_TONE_MS] — `Call#playDtmfTone` sustains until stopped, so a tone with no stop
         * would hang up the far end's IVR on a held key.
         */
        @JvmStatic
        fun playDtmf(tone: String): Boolean {
            val s = self ?: return false
            val c = s.active ?: return false
            val digit = tone.firstOrNull() ?: return false
            if (!DTMF_ALPHABET.contains(digit)) return false
            return try {
                c.playDtmfTone(digit)
                Handler(Looper.getMainLooper()).postDelayed(
                    { runCatching { c.stopDtmfTone() } },
                    DTMF_TONE_MS,
                )
                true
            } catch (e: Exception) {
                Log.w(TAG, "playDtmfTone failed", e)
                false
            }
        }

        /** The DTMF alphabet `Call#playDtmfTone` accepts (`A`-`D` are the network control tones). */
        private const val DTMF_ALPHABET = "0123456789*#ABCD"

        /** How long a DTMF tone is held before it is stopped (~a real dialer's keypress). */
        private const val DTMF_TONE_MS = 180L

        /**
         * The emergency-line guard `amos-telephony` enforces — but **not** "the same" list. This
         * one is region-*blind* (it runs wherever the phone is, without asking the SIM who the
         * carrier is), so its relationship to the host's two tables is:
         *
         *   * a region's set (`EmergencyMap::for_region`) is a **subset** of the words below, and
         *   * the host's unknown-jurisdiction fallback (`EmergencyMap::common_global`) is a
         *     **superset** of them, because that fallback is the map consulted when nobody knows
         *     the region — and a word this list calls an emergency that the fallback does not is
         *     an emergency call dialled on the ordinary path, where recording is **legal**.
         *
         * `108` (India) is below and in **no** Rust region, which is exactly why only the fallback
         * can be a superset of this list.
         *
         * Bound by `amos-telephony`'s `the_host_copy_recognizes_every_canonical_emergency_code`,
         * which reads these arms out of comment-stripped source: change a word here and it is red
         * (REQ-A820 / F-TEL-006). Keep the direction — the device *refusing* to record an
         * emergency is the safety property, so the host must never be narrower than this list.
         * Kept as a small local predicate rather than crossing a JNI seam, because
         * `setRecording` is called from a Kotlin/Java thread on a hot UI path.
         *
         * `RecordingContract.isEmergency(peer)` is the host-JVM test entry-point; the
         * instance form [is_emergency] is what the live `setRecording` body calls. They MUST
         * agree — pinned by `RecordingContractTest.the_recording_emergency_guard_matches_the_companion_form`.
         */
        private fun is_emergency(peer: String?): Boolean = RecordingContract.isEmergency(peer)
    }
}
