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

    private var manager: CameraManager? = null
    private var camera: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var cameraNumber: Int = 0

    /**
     * Capture epoch. Bumped on every teardown so a camera/session callback from an
     * older open cannot write state into a newer one (e.g. a late `onDisconnected`
     * of a released device nulling the freshly-opened camera).
     */
    private var generation: Long = 0

    /** Frames dropped by the per-frame guard (readable for bring-up triage). */
    private val droppedFrames = java.util.concurrent.atomic.AtomicLong(0)

    /** Is a capture session currently open? */
    fun isCapturing() = camera != null

    /** How many frames have been dropped by the per-frame guard so far. */
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
                droppedFrames.incrementAndGet()
                Log.w(TAG, "frame encode dropped: ${t.javaClass.simpleName}: ${t.message}")
                null
            }
            if (nv21 == null) {
                droppedFrames.incrementAndGet()
                return
            }
            recordFrame(
                cameraNumber,
                image.width,
                image.height,
                NV21,
                PREVIEW_FPS,
                nv21,
            )
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
            if (gen != generation || reader == null) {
                camera.close()
                return
            }
            this@CameraGlue.camera = camera
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
}

