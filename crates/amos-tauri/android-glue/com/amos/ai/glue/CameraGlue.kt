package com.amos.ai.glue

import android.content.Context
import android.Manifest
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface

/**
 * Amos camera producer glue — **System UI APK side**.
 *
 * Opens one physical camera (default rear) as a preview capture session into an
 * NV21 `ImageReader` and hands every frame to the AmOS native runtime via the
 * JNI upcall [recordFrame] (Rust: `amos-tauri/src/android_glue.rs` → the shared
 * `LiveSensorProvider` bus that `SensorHost` reads). The Rust side must first
 * advertise the camera (`SensorHost::set_cameras`) with the same id/size so
 * reads line up. Requires `CAMERA` granted before [attach].
 *
 * Bring-up skeleton: sizes from a `CameraCharacteristics` walk on device; exact
 * threading/tuning verified at device time (docs/android-glue.md).
 */
object CameraGlue : ImageReader.OnImageAvailableListener {

    private const val NV21 = 1 // amos_sensor::PixelFormat::Nv21
    private const val PREVIEW_FPS = 30

    // Every one of these is written on the caller's thread (`attach`/`detach` run from
    // `AmosGlue.onStart`, i.e. the main thread) and read on the `amos-camera` handler
    // thread — `reader` and `generation` by the guards in [onImageAvailable] and the
    // `CameraDevice` callbacks. Without `@Volatile` there is no happens-before edge
    // between the write in [teardown] and the read in the callback, so the reader-
    // identity guard can observe a **stale** `reader` (the one being torn down), take it
    // for current, and read a plane whose native memory `close()` already released —
    // exactly the use-after-free REQ-A45 fixed, reintroduced through the guard instead of
    // around it (REQ-A776). `volatile` gives visibility, not atomicity; that is enough
    // here because `generation` is only ever written from the caller's thread.
    @Volatile private var manager: CameraManager? = null
    @Volatile private var camera: CameraDevice? = null
    @Volatile private var session: CameraCaptureSession? = null
    @Volatile private var reader: ImageReader? = null
    @Volatile private var thread: HandlerThread? = null
    @Volatile private var handler: Handler? = null
    @Volatile private var cameraNumber: Int = 0

    /**
     * Capture epoch. Bumped on every teardown so a camera/session callback from an
     * older open cannot write state into a newer one (e.g. a late `onDisconnected`
     * of a released device nulling the freshly-opened camera).
     *
     * `@Volatile` for the same reason as [reader]: `teardown` bumps this on the main
     * thread while the `CameraDevice`/`CameraCaptureSession` callbacks compare it on
     * the handler thread, and an unseen bump lets a callback for the old epoch pass
     * its `gen == generation` check and close/write into the new session.
     */
    @Volatile private var generation: Long = 0

    /** Frames dropped by the per-frame guard. Every increment is logged (see below). */
    private val droppedFrames = java.util.concurrent.atomic.AtomicLong(0)

    /** Is a capture session currently open? */
    fun isCapturing() = camera != null

    /**
     * How many frames have been dropped by the per-frame guard so far.
     *
     * Honest boundary (REQ-A776): **nothing calls this**. There is no JNI entry point,
     * no `amos_*` command, and no Kotlin caller — `grep -rn droppedFrameCount` finds
     * this definition and nothing else. REQ-A45's device acceptance protocol names it
     * as an acceptance criterion, so as written that criterion was never obtainable.
     * It is kept because the counter is real and the per-drop log lines now carry the
     * running total (from which a device run can derive it); claim nothing more.
     */
    fun droppedFrameCount(): Long = droppedFrames.get()

    /**
     * Open [cameraNumber] at the nearest supported preview size ≤ [targetW]×[targetH]
     * (or the largest offered if none is smaller), pushing NV21 frames via
     * [recordFrame].
     *
     * **Idempotent**: `MainActivity.onStart` runs on every foreground, and this is
     * called from `AmosGlue.onStart`. Rebuilding a *live* session here would tear the
     * `ImageReader` down while its own callback thread still holds images from it —
     * the use-after-free that surfaced as `IllegalStateException: buffer is
     * inaccessible`. So a call for the camera already capturing is a no-op.
     */
    fun attach(context: Context, cameraNumber: Int = 0, targetW: Int = 640, targetH: Int = 480) {
        val cm = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager ?: return
        if (camera != null && this.cameraNumber == cameraNumber) return
        teardown()

        // Check the grant *before* allocating the handler thread / ImageReader: the
        // old early `return` leaked both on every `onStart` before the grant (and
        // the leaked reader kept its own listener firing from a second thread).
        if (context.checkSelfPermission(Manifest.permission.CAMERA) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            Log.i(TAG, "camera attach skipped: CAMERA not granted")
            return
        }

        this.cameraNumber = cameraNumber
        manager = cm
        val gen = generation
        val id = cameraNumber.toString()
        val (w, h) = pickSize(cm, id, targetW, targetH) ?: (targetW to targetH)

        thread = HandlerThread("amos-camera").also { it.start() }
        handler = Handler(thread!!.looper)
        reader = ImageReader.newInstance(w, h, ImageFormat.YUV_420_888, 2).also {
            it.setOnImageAvailableListener(this, handler)
        }

        // Advertise the NV21 preview config we are about to push so the host's
        // snapshot lists this camera and reads can serve it. Guarded: missing
        // `android` native feature must never crash the camera producer.
        try {
            advertiseCamera(cameraNumber, w, h, PREVIEW_FPS)
        } catch (t: Throwable) {
            Log.w(TAG, "camera advertise unavailable: ${t.javaClass.simpleName}")
        }

        try {
            cm.openCamera(id, openCallback(gen), handler)
        } catch (e: Exception) {
            // The camera can be unavailable for many reasons — disabled by a device
            // policy (ServiceSpecificException "disabled by policy"), in use by
            // another client, or no grant at open time. A peripheral video producer
            // must never crash the System UI on boot, so we release any half-built
            // capture resources, report the camera off, and move on.
            teardown()
            Log.w(TAG, "camera attach skipped: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    private const val TAG = "AmosGlue"

    /** Close the capture session, reader, and camera (frees the sensor). */
    fun detach() = teardown()

    /**
     * Tear down all capture resources, **serialized onto the camera handler thread**.
     *
     * Closing an `ImageReader` frees the native memory behind any image the producer
     * still holds, so the close must never run concurrently with [onImageAvailable]:
     * that race is exactly what threw `IllegalStateException: buffer is inaccessible`
     * (the plane `ByteBuffer`'s `MemoryRef` is freed while the callback reads it).
     * We therefore (1) clear the fields first, so a queued callback immediately sees
     * a stale reader and bails, then (2) post the close onto the same looper and
     * `quitSafely()`, which drains already-posted work before the thread exits.
     */
    private fun teardown() {
        val h = handler
        val t = thread
        val s = session
        val c = camera
        val r = reader
        generation++ // any callback captured for the old epoch is now stale
        handler = null
        thread = null
        session = null
        camera = null
        reader = null
        val close = Runnable {
            s?.close()
            c?.close()
            r?.close()
        }
        if (h != null) {
            if (!h.post(close)) close.run() // looper already dead -> no callback in flight
            t?.quitSafely()
        } else {
            close.run()
        }
    }

    /** JNI upcall into the AmOS native runtime. `format` = NV21 (see [NV21]). */
    external fun recordFrame(
        cameraId: Int,
        width: Int,
        height: Int,
        format: Int,
        fps: Int,
        bytes: ByteArray,
    )

    /**
     * Advertise the NV21 preview config this producer will push, so the host lists
     * the camera as available. Rust: `Java_com_amos_ai_glue_CameraGlue_advertiseCamera`
     * (see android_glue.rs).
     */
    external fun advertiseCamera(cameraId: Int, width: Int, height: Int, fps: Int)

    override fun onImageAvailable(reader: ImageReader) {
        // A superseded/closed reader can still deliver a queued callback (see
        // [teardown]): its images' native memory has already been freed, so reading
        // a plane would throw "buffer is inaccessible". Recognize the stale reader
        // by identity, release the image it handed us, and bail.
        if (reader !== this.reader) {
            reader.acquireLatestImage()?.close()
            return
        }
        val image = reader.acquireLatestImage() ?: return
        try {
            // Defense in depth: a peripheral video producer must never crash the
            // System UI, so a transiently invalid frame is dropped (and counted)
            // instead of throwing. `image` is always closed in `finally`.
            val nv21 = try {
                Nv21.packYuv420ToNv21(image)
            } catch (t: Throwable) {
                // Carry the running total in the line. `droppedFrameCount()` has no
                // caller anywhere (see its doc), so the log *is* the drop accounting a
                // device run can read; incrementing once into a local keeps the counter
                // and the printed n in step (REQ-A776).
                val n = droppedFrames.incrementAndGet()
                Log.w(TAG, "frame encode dropped (n=$n): ${t.javaClass.simpleName}: ${t.message}")
                null
            }
            if (nv21 == null) {
                // A `null` return is a *structural* refusal by the packer (non-positive
                // or odd geometry, no planes, unknown format) rather than a throw — so
                // this branch used to bump the counter and log **nothing**: a drop the
                // device log could not see at all. Same accounting as the catch above.
                val n = droppedFrames.incrementAndGet()
                Log.w(TAG, "frame encode dropped (n=$n): unusable YUV_420_888 geometry")
                return
            }
            // This upcall runs on the `amos-camera` handler thread, outside any Java
            // caller that could catch for us. `advertiseCamera` (in [attach]) and the
            // packer path above are both guarded, but this was the one native entry in
            // the file wrapped only in `try { … } finally`: a JNI failure here — an
            // `UnsatisfiedLinkError` on a build whose classpath has no `libamos_tauri_lib`,
            // a pending exception, an OOM inside the native decode — escaped
            // `onImageAvailable` and killed the thread. That is precisely the
            // "a peripheral video producer must never crash the System UI" invariant this
            // file states for the packer, broken by its own outlier (REQ-A1446/F-TAU-024).
            try {
                recordFrame(
                    cameraNumber,
                    image.width,
                    image.height,
                    NV21,
                    PREVIEW_FPS,
                    nv21,
                )
            } catch (t: Throwable) {
                val n = droppedFrames.incrementAndGet()
                Log.w(TAG, "frame upcall dropped (n=$n): ${t.javaClass.simpleName}: ${t.message}")
            }
        } finally {
            image.close()
        }
    }
    // ---- Camera2 wiring ------------------------------------------------

    /**
     * Per-open state callback for epoch [gen]. Every branch re-checks the epoch, so a
     * device released by a later `teardown()` can never write into the new open.
     */
    private fun openCallback(gen: Long) = object : CameraDevice.StateCallback() {
        override fun onOpened(camera: CameraDevice) {
            // Torn down (or superseded) while the device was still opening, or no
            // reader to capture into: close it rather than leaking an open camera.
            val r = this@CameraGlue.reader
            if (gen != generation || r == null) {
                camera.close()
                return
            }
            this@CameraGlue.camera = camera
            // Positive evidence that the producer actually opened. Until this line
            // existed the only camera lines were *negative* ("attach skipped: ..."), so
            // a device run could never distinguish "the camera opened and stayed up"
            // from "attach was never reached at all" — the vacuous-green shape. The
            // acceptance driver (scripts/android-camera-bringup.sh) refuses to pass a
            // run with no such evidence; the sibling MediaStore glue logs
            // `media backend attached` for the same reason (REQ-A776).
            Log.i(TAG, "camera attached: id=${this@CameraGlue.cameraNumber} ${r.width}x${r.height}")
            startCapture(camera, gen)
        }

        override fun onDisconnected(camera: CameraDevice) {
            camera.close()
            if (gen == generation) this@CameraGlue.camera = null
        }

        override fun onError(camera: CameraDevice, error: Int) {
            camera.close()
            if (gen == generation) this@CameraGlue.camera = null
        }
    }

    private fun startCapture(camera: CameraDevice, gen: Long) {
        val r = reader ?: return
        val h = handler ?: return
        val target: Surface = r.surface
        val request = camera
            .createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
            .apply { addTarget(target) }
            .build()
        camera.createCaptureSession(
            listOf(target),
            object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(s: CameraCaptureSession) {
                    if (gen != generation) {
                        s.close()
                        return
                    }
                    this@CameraGlue.session = s
                    try {
                        s.setRepeatingRequest(request, null, h)
                    } catch (_: IllegalStateException) {
                        // Session already closed (stop/start race) — ignore.
                    }
                }

                override fun onConfigureFailed(s: CameraCaptureSession) {
                    s.close()
                }
            },
            h,
        )
    }

    private fun pickSize(
        cm: CameraManager,
        id: String,
        targetW: Int,
        targetH: Int,
    ): Pair<Int, Int>? {
        return try {
            val ch: CameraCharacteristics = cm.getCameraCharacteristics(id)
            val configs = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            if (configs == null) {
                null
            } else {
                val sizes = configs.getOutputSizes(ImageFormat.YUV_420_888)
                if (sizes == null) {
                    null
                } else {
                    val fit = sizes.filter { it.width <= targetW && it.height <= targetH }
                    val chosen = fit.maxByOrNull { it.width.toLong() * it.height.toLong() }
                        ?: sizes.maxByOrNull { it.width.toLong() * it.height.toLong() }
                    if (chosen != null) Pair(chosen.width, chosen.height) else null
                }
            }
        } catch (_: Exception) {
            null
        }
    }

    init {
        // Best-effort, the same shape as the sibling glues (SensorGlue, ClipboardGlue, …):
        // a host lint pass has no `.so` on the classpath and a device build ships
        // `libamos_tauri_lib.so`. Loading here rather than depending on `AmosGlue` having
        // initialised a *sibling* class first makes this class self-sufficient —
        // `recordFrame` fires on the `amos-camera` thread, where an unresolved symbol is
        // the fatal escape the guard in [onImageAvailable] now catches (REQ-A1446/F-TAU-024).
        try {
            System.loadLibrary("amos_tauri_lib")
        } catch (_: UnsatisfiedLinkError) {
            // Native lib not on the classpath yet: the frame upcall stays inert and every
            // attempt is counted as a drop (see the guard in [onImageAvailable]).
        }
    }
}

