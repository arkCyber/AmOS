package com.amos.ai.glue

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.util.Log
import android.view.WindowManager
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * AmOS System UI — **whole-screen video capture**, the Android half of the host's
 * `screen_record_*` commands (`crates/amos-tauri/src/screen_record.rs` /
 * `screen_record_android.rs`).
 *
 * The macOS half is `ffmpeg -f avfoundation`: one child process, SIGINT seals the file.
 * Android has no such tool, so the capture is a `MediaProjection` + `MediaRecorder` +
 * `VirtualDisplay` trio that this object owns for the life of the session — which is why
 * Rust cannot model it as a child and asks this glue instead (see [start] / [stop] / [statusJson]).
 *
 * ```
 * screen_record_start ─► Rust ─► start()  ─► MediaProjectionManager.createScreenCaptureIntent()
 *                                        └► Activity.startActivityForResult(REQ_SCREEN_RECORD)
 *   user consents ─► MainActivity.onActivityResult ─► onConsentResult()
 *                                                     └► foreground service + recorder + mirror
 * screen_record_status ─► statusJson()  (the pill's clock)
 * screen_record_stop   ─► stop()        (seal + publish the MediaStore row)
 * ```
 *
 * Three facts this design refuses to flatten, each of which the macOS path already
 * honours on its side of the wire:
 *
 *   * **A start is a request, not a recording.** The user has to approve a system dialog,
 *     so [start] answers `requested` and the *consent result* is what begins the session.
 *     Reporting `recording` from the mere posting of the dialog would light the top bar's
 *     REC marker for a capture nobody approved — the same defect the macOS path's
 *     spawn-grace check exists to prevent.
 *   * **The generation counter** (copied from [CameraGlue]): a late `MediaProjection`
 *     stop callback or a delayed auto-stop timer from an older session must not tear down
 *     the newer one. Every teardown bumps it; every deferred callback compares it.
 *   * **The duration bound is enforced here, and an out-of-range request is refused.** The
 *     bound is the **host's** decision (`screen_record::resolve_max_secs`, the authority
 *     for [MIN_CAPTURE_SECS] / [MAX_CAPTURE_SECS]); `ffmpeg -t` bounds the macOS child from
 *     inside the tool, `MediaRecorder` has no equivalent, so [scheduleAutoStop] is this
 *     side's `-t` — a recording must not run forever because a `stop` never arrived. A
 *     request *outside* the range is answered [STATUS_OUT_OF_RANGE], not replaced by a
 *     length nobody asked for: a fabricated bound leaves a finished file
 *     indistinguishable from one that was requested, the same silence the host's refusal
 *     exists to break.
 *   * **A sealed capture carries the size it was measured at, and "could not measure" is not
 *     `0`.** `MediaRecorder` has no truthful exit status the way `ffmpeg` does, so the glue
 *     stats the descriptor it handed the recorder ([UNMEASURED_BYTES] when the platform
 *     reports nothing) and [statusJson] carries the number. The host's stop refuses an empty
 *     or unmeasurable file exactly as the macOS path's `confirm_written` refuses the file its
 *     child failed to write — otherwise a `MediaRecorder` that started but produced no frames
 *     would be reported as a finished recording.
 *
 * Honest boundaries (device-verified; the host cannot compile or run any of this):
 *   * **This has been run on one device** (an S5, Android 14, 2026-09-26) — and the run
 *     found **two** real defects, in sequence, both of which made an approved capture write
 *     no file:
 *       1. the foreground-service ordering defect [begin] documents (REQ-A1875): the app died
 *          with `ForegroundServiceDidNotStartInTimeException`. Fixed by requesting the
 *          projection only from the service's own post-`startForeground` callback.
 *       2. the capture-start ordering defect [continueBegin] documents (REQ-A1885): with the
 *          crash gone, `createVirtualDisplay` was reached — and Android 14 refused it, because
 *          `registerCallback` must precede it. Fixed by registering first.
 *
 *     With both fixed the same device ran complete sessions: the consent dialog's 「立即开始」,
 *     `screen capture started -> content://media/external_primary/video/media/…`, the 10 s
 *     ceiling sealing on its own, and a manual `stop()` — each producing a non-empty `Movies/`
 *     file (247,938 B and 806,256 B, `ffprobe`-readable H.264 at 720x1540), with no
 *     `FATAL EXCEPTION` in any of them.
 *     What a *host* build can do is type-check the glue (`scripts/android-glue-nv21-check.sh`);
 *     the Rust side says as much in `screen_record_android`'s own doc comment, and the FMEA
 *     rows are marked device-only.
 *   * **One device is not every device.** The projection path here has one measurement
 *     behind it; a second OEM's `MediaProjection` policy (a vendor that requires the
 *     service to be started *before* the consent dialog, say) is unverified.
 *   * **The recording's pixels are never inspected** — `statusJson` reports that a file
 *     was written and how large it is, never that the frames are the screen. That is the
 *     same limit `crates/amos-tauri/src/screenshot.rs` states for the still capture.
 *   * **The file's duration is not the session's wall-clock length.** `MediaProjection`
 *     hands the encoder a frame when the screen *changes*; a static screen produces almost
 *     none. Measured on the S5, two sessions of similar length: one over a still screen
 *     sealed a valid 247,938-byte file whose `ffprobe` duration was **0.757 s** (14 frames),
 *     one with the screen being dragged around sealed 806,256 bytes at **9.28 s** (129
 *     frames). Neither is a defect — nothing is dropped, the recorder simply had nothing
 *     new to encode — but "10 s of recording" must not be read as "10 s of video".
 *   * **A capture whose process is killed never publishes its file.** `IS_PENDING` is
 *     cleared in [teardown], which a `SIGKILL` cannot reach: the row stays
 *     `.pending-…` in `Movies/`, invisible to the gallery but occupying storage. Seen on
 *     the S5 when an unrelated package install (`installPackageLI`) killed the app
 *     mid-recording. A sweep of stale pending rows at startup would close it; this glue
 *     does not have one.
 *   * **`MediaRecorder` is created with the deprecated no-arg constructor below API 31**
 *     (`MediaRecorder(Context)` only exists from S). Suppressed rather than gated on the
 *     device's API level, because the old constructor is the one that works on the API
 *     range AmOS targets; a device-only check would be the honest way to confirm it.
 */
// `StaticFieldLeak` is on this object because its `context` field (the *application*
// Context) is what Lint walks up to — see that field's KDoc for why it is not a leak.
@SuppressLint("StaticFieldLeak")
object ScreenRecordGlue {

    private const val TAG = "AmosScreenRecord"

    /**
     * The consent dialog's request code. Distinct from every other code in the glue
     * (`REQ_CAMERA` 9001, `REQ_MEDIA` 9003, `REQ_LOCATION` 9005, `REQ_SMS` 9007) — the
     * Activity's `onActivityResult` dispatches on it, and `RequestCodeTest` fails if two
     * glues ever claim the same number (REQ-A1625).
     */
    const val REQ_SCREEN_RECORD = 9006

    /** The consent dialog was posted; no session exists until the user answers. */
    const val STATUS_REQUESTED = "requested"
    /** A session is live. */
    const val STATUS_RECORDING = "recording"
    /** No Activity has been handed to the glue yet (boot ordering). */
    const val STATUS_UNAVAILABLE = "unavailable"
    /** The user declined the capture dialog, or the platform refused to project. */
    const val STATUS_DENIED = "denied"
    /** A session is already live (or a dialog is already up). */
    const val STATUS_ALREADY = "already"
    /** This device/API level cannot project at all. */
    const val STATUS_UNSUPPORTED = "unsupported"
    /** A live session was sealed and its file published. */
    const val STATUS_STOPPED = "stopped"
    /** The requested duration is outside [MIN_CAPTURE_SECS]..[MAX_CAPTURE_SECS]. */
    const val STATUS_OUT_OF_RANGE = "out_of_range"

    /**
     * The duration bounds. The **authority is the Rust pair**
     * (`screen_record::MIN_RECORD_SECS` / `MAX_RECORD_SECS`, resolved by
     * `screen_record::resolve_max_secs`), not these lines: the host refuses an out-of-range
     * request by name (`ScreenRecordDurationOutOfRange`) before it calls in, and
     * `screen_record_android::start` maps [STATUS_OUT_OF_RANGE] to that same code. The pair
     * is pinned from both sides — a host-JVM test below and a Rust test in
     * `screen_record_android` that reads this file — so neither number can drift alone.
     */
    const val MIN_CAPTURE_SECS = 1
    const val MAX_CAPTURE_SECS = 30 * 60

    /**
     * The size the platform would not report. Distinct from `0`, which is a real measurement
     * ("the file was written and holds no bytes"): folding them together would make a capture
     * nobody could confirm indistinguishable from one that was confirmed empty, and the host's
     * stop refuses each for its own reason — see [bytesField] and [ScreenRecordGlue.stop].
     */
    const val UNMEASURED_BYTES = -1L

    /** The MediaStore collection the finished file lands in — `Movies` (mirrors Rust's
     * `SCREEN_RECORDING_REL_DIR`, whose Android kind is Video). */
    private const val COLLECTION_DIR = "Movies"

    /** Bitrate for a screen capture. Modest on purpose: a mirrored UI is mostly static,
     * and an OS whose capture path competes with the foreground app should not pick a
     * bitrate that starves it. */
    private const val VIDEO_BITRATE = 6_000_000

    private const val FRAME_RATE = 30

    /**
     * The **application** Context, for the foreground service + MediaStore.
     *
     * The leak Lint guards against is an *Activity* Context outliving a configuration
     * change; the value bound here is `activity.applicationContext`, whose lifetime is the
     * process's own, so holding it for the life of this `object` leaks nothing. The Activity
     * — the one that would leak — is held weakly just below. The suppression sits on the
     * `object` because that is the static holder Lint names; it covers this field.
     */
    @Volatile
    private var context: Context? = null

    /**
     * The Activity the consent dialog is posted from — **weak**, like
     * `RotationGlue.activity`: the glue (an `object`) outlives any Activity instance and a
     * strong reference would leak it across a configuration change.
     */
    @Volatile
    private var activity: WeakReference<Activity>? = null

    /**
     * Capture epoch. Bumped on every teardown so a deferred callback from an older session
     * cannot write into (or tear down) a newer one — the discipline
     * [CameraGlue.generation] documents, for the same reason: the `MediaProjection` stop
     * callback, the auto-stop timer and [stop] all run on different threads and can
     * interleave.
     */
    @Volatile
    private var generation: Long = 0

    @Volatile
    private var recorder: MediaRecorder? = null

    @Volatile
    private var projection: MediaProjection? = null

    @Volatile
    private var virtualDisplay: VirtualDisplay? = null

    /** The MediaStore row the finished file is published to (cleared of `IS_PENDING` at stop). */
    @Volatile
    private var outUri: Uri? = null

    /** Kept open for the whole recording; `MediaRecorder` writes through its descriptor. */
    @Volatile
    private var outFd: ParcelFileDescriptor? = null

    /** A human-readable destination, for the host's `out` field. */
    @Volatile
    private var outLabel: String = ""

    /**
     * The size measured when the last session sealed, or [UNMEASURED_BYTES] when the platform
     * reported none. **Kept** across [teardown] for the same reason `outLabel` is: the host's
     * stop reads it back through [statusJson] to confirm the file before it reports success,
     * and a finished session is still a fact worth reporting.
     */
    @Volatile
    private var lastBytes: Long = UNMEASURED_BYTES

    @Volatile
    private var startedMs: Long = 0

    @Volatile
    private var maxSecs: Int = 0

    @Volatile
    private var stopping: Boolean = false

    /** A consent dialog is up (between [start] and its result). Guards double-posting. */
    @Volatile
    private var pending: Boolean = false

    /**
     * The main-thread `Handler` every platform callback is posted to.
     *
     * A **lazy** property, not a `val` initialised at object construction: the object is
     * touched by the host-JVM unit tests (`android-glue/tests`), which have no `Looper` —
     * a constructor-time `Looper.getMainLooper()` would make those tests fail to load the
     * class at all, i.e. the pure half would be untestable.
     */
    private val main: Handler
        get() = Handler(Looper.getMainLooper())

    /**
     * Hand the glue the foreground Activity (called from the generated `MainActivity.onStart`,
     * like [RotationGlue.attachActivity]). Idempotent, and the only place the Context comes
     * from — nothing here is reachable before it runs, which is what [STATUS_UNAVAILABLE]
     * reports.
     */
    fun attachActivity(activity: Activity) {
        this.activity = WeakReference(activity)
        this.context = activity.applicationContext
    }

    // ── the three calls Rust makes (all @JvmStatic: `call_static_method`) ──────────

    /**
     * Post the system capture-consent dialog and answer with a `STATUS_*` word.
     *
     * Never answers [STATUS_RECORDING]: consent is asynchronous, so a live session is
     * established in [onConsentResult], and the host polls [statusJson] for it. A
     * synchronous "recording" here would be the same lie the macOS start-refusal exists
     * to avoid.
     *
     * [display] is accepted for wire symmetry with the macOS `-D <display>` argument and
     * is **ignored**: `MediaProjection` mirrors the default display, and Android offers no
     * public way to choose another. Silently recording display 0 while the user asked for
     * display 1 would be the dishonest option, so this is stated rather than hidden — and
     * the host passes `None` on every platform today.
     */
    @JvmStatic
    fun start(maxSecs: Int, display: Int): String {
        // Refused first, and by name — before the Activity or the consent dialog is
        // touched, because a request that can never be honoured should not reach the user.
        // This is the **same rule** the host applies (`resolve_max_secs` refuses outside the
        // bounds with `ScreenRecordDurationOutOfRange`), not a second opinion: the previous
        // shape answered a *fabricated* bound (`<= 0 -> 60`) whose file is indistinguishable
        // from one that was asked for. Unreachable from the host, which resolves before it
        // calls in; this is the belt-and-braces for anything that reaches the glue another way.
        if (!isDurationInRange(maxSecs)) {
            Log.w(TAG, "refused an out-of-range duration: ${maxSecs}s")
            return STATUS_OUT_OF_RANGE
        }
        val act = activity?.get() ?: return STATUS_UNAVAILABLE
        synchronized(this) {
            if (recorder != null || pending) return STATUS_ALREADY
            pending = true
            this.maxSecs = maxSecs
        }
        val manager = act.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
            as? MediaProjectionManager
            ?: run {
                synchronized(this) { pending = false }
                return STATUS_UNSUPPORTED
            }
        act.runOnUiThread {
            try {
                act.startActivityForResult(
                    manager.createScreenCaptureIntent(),
                    REQ_SCREEN_RECORD,
                )
            } catch (t: Throwable) {
                // Posting the dialog failed (a locked-down device policy is the realistic
                // cause). Clearing `pending` is what lets the user try again; answering
                // `denied` would be a claim about a dialog nobody saw.
                Log.w(TAG, "could not post the capture-consent dialog: ${t.message}")
                synchronized(this) { pending = false }
            }
        }
        Log.i(TAG, "capture consent requested (max ${maxSecs}s; display arg $display ignored)")
        return STATUS_REQUESTED
    }

    /**
     * Seal and publish the live session; answer with a `STATUS_*` word.
     *
     * The stop is **synchronous on the caller's thread** (the recorder is flushed and the
     * MediaStore row released here) so the host's confirm — "the file exists and is
     * non-empty" — reads a file that is already finished, exactly as the macOS stop waits
     * for the recorder to exit before checking the size.
     */
    @JvmStatic
    fun stop(): String {
        val rec = recorder ?: return if (pending) STATUS_REQUESTED else STATUS_UNAVAILABLE
        synchronized(this) { stopping = true }
        return try {
            teardown(rec, publish = true)
            STATUS_STOPPED
        } catch (t: Throwable) {
            Log.w(TAG, "stop failed: ${t.message}")
            STATUS_DENIED
        }
    }

    /**
     * The session, as JSON the host parses into `ScreenRecordStatus`.
     *
     * A JSON object rather than a delimited line: the destination is a free-text path, and
     * joining it to other fields with a separator would corrupt the record the moment a
     * path contained that separator (the shape F-SH-781 is about).
     */
    @JvmStatic
    fun statusJson(): String {
        val rec = recorder
        val live = rec != null && !stopping
        val json = JSONObject()
            .put("recording", live)
            .put("stopping", rec != null && stopping)
            .put("startedMs", startedMs)
            .put("maxSecs", maxSecs)
            .put("out", outLabel)
        // Absent — never `0` — when the platform reported no size: a measured-empty file and
        // an unmeasurable one are different facts, and only the first says the recorder ran.
        bytesField(lastBytes)?.let { json.put("bytes", it) }
        return json.toString()
    }

    /** Whether a capture is live (used by the wiring's own logging, not by the host). */
    fun isRecording(): Boolean = recorder != null && !stopping

    // ── the Activity-result half ────────────────────────────────────────────────

    /**
     * Called from the generated `MainActivity.onActivityResult` when the OS answers
     * [REQ_SCREEN_RECORD]. Begin the session on approval; clear the pending flag on a
     * refusal so the user can ask again.
     */
    fun onConsentResult(activity: Activity, resultCode: Int, data: Intent?) {
        if (resultCode != Activity.RESULT_OK || data == null) {
            Log.i(TAG, "capture consent declined (resultCode $resultCode)")
            synchronized(this) { pending = false }
            return
        }
        val gen = ++generation
        try {
            begin(activity, resultCode, data, gen)
        } catch (t: Throwable) {
            // Only the foreground service's own start can throw here — everything that
            // builds the session runs later, from the service's foreground callback, and
            // reports its failures through [onServiceForeground].
            Log.w(TAG, "could not start the capture service: ${t.message}")
            abort(gen)
            synchronized(this) { pending = false }
        }
    }

    /**
     * Arm the foreground service and hand it the rest of the session to run once it is up.
     *
     * The split is the defect this method's previous shape was (REQ-A1875): `begin` used to
     * call `ScreenRecordService.start(activity)` and then immediately
     * `getMediaProjection`. But `startForegroundService` is asynchronous — the service's
     * `startForeground` is queued behind the very main-thread work `begin` was doing — and
     * the platform refuses a projection while no `mediaProjection` service is **in the
     * foreground**. Measured on the S5 (Android 14):
     *
     * ```
     * W/AmosScreenRecord: could not begin the capture: Media projections require a
     *     foreground service of type ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
     * I/AmosScreenRecord: abandoned capture generation 1
     * I/AmosScreenRecordSvc: screen-record foreground service started
     * I/AmosScreenRecordSvc: screen-record foreground service stopped
     * E/AndroidRuntime: FATAL EXCEPTION: main
     *     ForegroundServiceDidNotStartInTimeException: Context.startForegroundService()
     *     did not then call Service.startForeground()
     * ```
     *
     * The refusal was survivable; what killed the app was the consequence — [abort] stopped a
     * service that had not foregrounded yet.
     *
     * So the wait is now a **fact handed back by the service**, not a delay: [continueBegin]
     * runs from `ScreenRecordService.onStartCommand`, one line after `startForeground`
     * returned. The waiter holds only the consent result (a small `Intent`), never the
     * Activity — that is re-read from the weak field when the callback fires, so a service
     * that never comes up cannot pin an Activity in a static field.
     */
    private fun begin(activity: Activity, resultCode: Int, data: Intent, gen: Long) {
        // A throw from `startForegroundService` itself (a build without
        // FOREGROUND_SERVICE_MEDIA_PROJECTION, a device policy) propagates to
        // [onConsentResult]'s catch: nothing was created, so it is a clean refusal.
        ScreenRecordService.start(activity) { onServiceForeground(resultCode, data, gen) }
    }

    /**
     * The session proper, run once the foreground service is up. Everything from here on
     * assumes the platform will grant a projection, because the precondition is now true
     * rather than hoped for.
     */
    private fun onServiceForeground(resultCode: Int, data: Intent, gen: Long) {
        val act = activity?.get()
        if (act == null) {
            // The Activity went away between consent and the service coming up. Nothing was
            // built, so this is a clean refusal — but the service is up and must be retired.
            Log.w(TAG, "the Activity is gone before the foreground service was up")
            abort(gen)
            synchronized(this) { pending = false }
            return
        }
        try {
            continueBegin(act, resultCode, data, gen)
        } catch (t: Throwable) {
            Log.w(TAG, "could not begin the capture: ${t.message}")
            // A half-built session (a projection with no recorder, an open descriptor with
            // no row) must not be left behind: `abort` releases whatever `continueBegin`
            // managed to create before it threw.
            abort(gen)
            synchronized(this) { pending = false }
        }
    }

    private fun continueBegin(activity: Activity, resultCode: Int, data: Intent, gen: Long) {
        val manager = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
            as? MediaProjectionManager
            ?: throw IllegalStateException("no MediaProjectionManager")
        val proj = manager.getMediaProjection(resultCode, data)
            ?: throw IllegalStateException("the platform returned no projection")
        // Published to the field **as each handle is acquired**, so a throw on any later
        // step leaves something [abort] can release: a projection with no recorder, or an
        // open descriptor with no row, would otherwise survive the refusal holding the
        // screen or a file handle.
        synchronized(this) { projection = proj }

        val size = screenSize(activity)
        val (uri, fd) = createDestination(activity, size)
        synchronized(this) {
            outUri = uri
            outFd = fd
        }

        val rec = newRecorder(activity)
        synchronized(this) { recorder = rec }
        rec.setVideoSource(MediaRecorder.VideoSource.SURFACE)
        rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        rec.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
        rec.setVideoSize(size.x, size.y)
        rec.setVideoFrameRate(FRAME_RATE)
        rec.setVideoEncodingBitRate(VIDEO_BITRATE)
        rec.setOutputFile(fd.fileDescriptor)
        rec.prepare()

        // The callback is registered **before** the capture starts, because Android 14 (API 34)
        // refuses the other order outright: `createVirtualDisplay` throws
        // `IllegalStateException("Must register a callback before starting capture, to manage
        // resources in response to MediaProjection states.")`, so an approved capture wrote no
        // file at all (F-AND-020 ∕ REQ-A1885, measured on the S5 the same day as REQ-A1875).
        //
        // The user can end the capture from the system UI; that arrives here, not through our
        // own `stop`. Guarded by the generation so a late callback for a finished session
        // cannot tear down the one that replaced it.
        proj.registerCallback(
            object : MediaProjection.Callback() {
                override fun onStop() {
                    if (generation == gen && recorder != null) {
                        Log.i(TAG, "the platform ended the capture")
                        runCatching { teardown(recorder, publish = true) }
                    }
                }
            },
            main,
        )

        val display = proj.createVirtualDisplay(
            "amos-screen-record",
            size.x,
            size.y,
            activity.resources.displayMetrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            rec.surface,
            null,
            main,
        )
        synchronized(this) { virtualDisplay = display }
        rec.start()

        // Only now is the session real: the handles above are published, and this is what
        // flips `pending` to a live recording. Until this line a throw is a refusal.
        synchronized(this) {
            outLabel = uri.toString()
            startedMs = System.currentTimeMillis()
            stopping = false
            pending = false
        }
        scheduleAutoStop(gen)
        Log.i(TAG, "screen capture started -> $uri (max ${maxSecs}s)")
    }

    /**
     * This side's `-V`: the macOS child is bounded by the tool's own duration flag, but a
     * `MediaRecorder` runs until something stops it. Without this, a session whose `stop`
     * never arrives (the process kept alive by the foreground service, a lost WebView)
     * would fill the user's storage with no ceiling.
     *
     * `maxSecs` is only ever set by [start], which refuses anything outside
     * [MIN_CAPTURE_SECS]..[MAX_CAPTURE_SECS] — so the `<= 0` guard below is unreachable and
     * is kept as defence in depth, not as the enforcement point. The enforcement point is
     * the refusal in [start]; without it this early return was a silent "no ceiling".
     */
    private fun scheduleAutoStop(gen: Long) {
        val bound = maxSecs
        if (bound <= 0) return
        main.postDelayed({
            // Only the session this timer was armed for.
            if (generation == gen && recorder != null && !stopping) {
                Log.i(TAG, "capture reached its ${bound}s ceiling; sealing")
                runCatching { teardown(recorder, publish = true) }
            }
        }, bound * 1000L)
    }

    /**
     * Release everything a session holds, in the order the platform requires: the recorder
     * is stopped **first** (so the file is written and its trailer flushed), then the
     * virtual display torn down, then the projection released, then the MediaStore row
     * published. Bumping [generation] first is what makes any callback still in flight for
     * this session a no-op.
     */
    private fun teardown(rec: MediaRecorder?, publish: Boolean) {
        generation += 1
        val fd = outFd
        val uri = outUri
        try {
            runCatching { rec?.stop() }.onFailure { Log.w(TAG, "recorder stop: ${it.message}") }
        } finally {
            runCatching { rec?.release() }
            runCatching { virtualDisplay?.release() }
            runCatching { projection?.stop() }
        }
        // Measured **after** the recorder is released (which is what flushes the container
        // trailer) and **before** the descriptor is closed — the same order the macOS stop
        // uses when it stats the file its child just wrote. A platform that reports nothing
        // answers `-1`, which is kept distinct from a measured `0`.
        val measured = runCatching { fd?.statSize ?: UNMEASURED_BYTES }
            .getOrDefault(UNMEASURED_BYTES)
        runCatching { fd?.close() }
        if (publish && uri != null) publishRow(uri)
        // The foreground service is part of the capture path, not decoration: it is what
        // a projection is legally allowed under, and it shows the marker the platform
        // insists on. Left running it holds the process up and its ongoing "Recording
        // screen" notification claims a capture that has ended (or never began) — so it
        // is stopped here, the one chokepoint `stop()`, the auto-stop timer, the
        // platform's own `onStop` and the refusal path `abort` all reach (REQ-A1631).
        runCatching { context?.let { ScreenRecordService.stop(it) } }
        synchronized(this) {
            recorder = null
            projection = null
            virtualDisplay = null
            outUri = null
            outFd = null
            stopping = false
            pending = false
            // `outLabel`, `startedMs`, `maxSecs` and `lastBytes` are **kept**: the host's stop
            // command reads them back through [statusJson] to build the session's final answer
            // (which file, how long, confirmed non-empty), and a finished session is still a
            // fact worth reporting. Only the live handles are cleared.
            lastBytes = measured
        }
    }

    /** Release a half-built session without publishing anything (the row is deleted). */
    private fun abort(gen: Long) {
        val rec = recorder
        val uri = outUri
        runCatching { teardown(rec, publish = false) }
        if (uri != null) {
            runCatching { context?.contentResolver?.delete(uri, null, null) }
        }
        synchronized(this) { pending = false }
        Log.i(TAG, "abandoned capture generation $gen")
    }

    // ── MediaStore + size helpers ───────────────────────────────────────────────

    /**
     * A `MediaRecorder` for the caller's Context.
     *
     * `MediaRecorder(Context)` only exists from API 31 (S); below it the deprecated no-arg
     * constructor is the one that works across the API range AmOS targets, so the choice is
     * made by API level rather than by suppressing the warning globally. Deprecation is the
     * one notice the glue's warning gate allows, and this comment is why.
     */
    @Suppress("DEPRECATION")
    private fun newRecorder(context: Context): MediaRecorder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            MediaRecorder()
        }

    /**
     * The display's real pixel size, whatever the rotation.
     *
     * `getRealSize` is deprecated in API 30 — `currentWindowMetrics` replaces it — but
     * `minSdk` is 26, so the already-deprecated branch is the only one that runs below R
     * and both are needed. The suppression sits on the *function* because a Kotlin
     * `@Suppress` on a statement suppresses nothing (it must annotate a declaration).
     */
    @Suppress("DEPRECATION")
    private fun screenSize(context: Context): Point {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = wm.currentWindowMetrics.bounds
            return Point(bounds.width(), bounds.height())
        }
        val point = Point()
        wm.defaultDisplay.getRealSize(point)
        return point
    }

    /**
     * Insert the destination row and open its descriptor. `RELATIVE_PATH` + `IS_PENDING`
     * are the API 29+ shape (`MediaStoreGlue` uses the same pair); below that the file is
     * addressed by an absolute path and no pending flag exists.
     *
     * `Recycle`: the returned descriptor is deliberately **not** closed here — it is handed
     * to `MediaRecorder` and stays open for the whole recording, then closed in `teardown`
     * alongside the recorder. Lint sees the `openFileDescriptor` and assumes the caller of
     * this method is its last user; the ownership actually escapes in the return value.
     */
    @SuppressLint("Recycle")
    private fun createDestination(context: Context, size: Point): Pair<Uri, ParcelFileDescriptor> {
        val resolver = context.contentResolver
        val name = fileName(System.currentTimeMillis())
        val collection =
            if (Build.VERSION.SDK_INT >= 29) {
                MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, "video/mp4")
            put(MediaStore.MediaColumns.WIDTH, size.x)
            put(MediaStore.MediaColumns.HEIGHT, size.y)
            if (Build.VERSION.SDK_INT >= 29) {
                put(MediaStore.MediaColumns.RELATIVE_PATH, COLLECTION_DIR)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
        }
        val uri = resolver.insert(collection, values)
            ?: throw IllegalStateException("MediaStore refused a row in $COLLECTION_DIR")
        val fd = resolver.openFileDescriptor(uri, "w")
            ?: throw IllegalStateException("MediaStore row $uri has no writable descriptor")
        return uri to fd
    }

    /** Clear `IS_PENDING`, which is what makes the finished file visible to the Files app. */
    private fun publishRow(uri: Uri) {
        if (Build.VERSION.SDK_INT >= 29) {
            runCatching {
                context?.contentResolver?.update(
                    uri,
                    ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) },
                    null,
                    null,
                )
            }
        }
    }

    // ── pure helpers (host-JVM tested, see android-glue/tests) ────────────────────

    /**
     * The capture's file name — the same shape the macOS path writes
     * (`crates/amos-tauri/src/screen_record.rs::filename_from_parts`), with `.mp4` in place
     * of `.mov`. Pure and `Locale`-independent for the digits, so the host-JVM test pins it.
     */
    fun fileName(epochMs: Long): String {
        val stamp = SimpleDateFormat("yyyy-MM-dd 'at' HH.mm.ss", Locale.US).format(Date(epochMs))
        return "Screen Recording $stamp.mp4"
    }

    /**
     * Whether a requested duration may be honoured — the rule [start] refuses on, in one
     * home so the glue does not make a second, silently-substituting decision of its own.
     *
     * The bounds are the **host's** ([MIN_CAPTURE_SECS]); the authority is
     * `screen_record::resolve_max_secs`, which refuses outside the same closed interval
     * before it ever calls in. Pure and `Locale`-independent, so the host-JVM test pins
     * the rule without a device; the cross-check that the constants restate the Rust pair
     * lives in `screen_record_android::the_glues_duration_bound_is_the_hosts_bound`, which
     * reads this file.
     */
    fun isDurationInRange(requested: Int): Boolean =
        requested in MIN_CAPTURE_SECS..MAX_CAPTURE_SECS

    /**
     * The `bytes` field [statusJson] carries: the measured size, or `null` when the platform
     * reported none ([UNMEASURED_BYTES]). Pure and Android-free, so the host-JVM test pins the
     * rule — above all that a measured `0` is **kept**, because "the recorder wrote an empty
     * file" is exactly the fact the host's stop refuses, and a `null` there would be reported
     * as "nobody could measure this" instead. A `null` is also what the host refuses in its own
     * sentence; only the message differs.
     */
    fun bytesField(measured: Long): Long? = if (measured >= 0) measured else null
}
