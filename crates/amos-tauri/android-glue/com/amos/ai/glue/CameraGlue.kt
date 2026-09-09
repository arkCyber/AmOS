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

    /** Is a capture session currently open? */
    fun isCapturing() = camera != null

    /**
     * Open [cameraNumber] at the nearest supported preview size ≤ [targetW]×[targetH]
     * (or the largest offered if none is smaller), pushing NV21 frames via
     * [recordFrame]. Idempotent — a second call closes the previous session first.
     */
    fun attach(context: Context, cameraNumber: Int = 0, targetW: Int = 640, targetH: Int = 480) {
        val cm = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager ?: return
        if (camera != null) detach()
        this.cameraNumber = cameraNumber
        manager = cm
        val id = cameraNumber.toString()
        val (w, h) = pickSize(cm, id, targetW, targetH) ?: (targetW to targetH)

        thread = HandlerThread("amos-camera").also { it.start() }
        handler = Handler(thread!!.looper)
        reader = ImageReader.newInstance(w, h, ImageFormat.YUV_420_888, 2).also {
            it.setOnImageAvailableListener(this, handler)
        }

        val granted = context.checkSelfPermission(Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) return // caller must request CAMERA first

        // Advertise the NV21 preview config we are about to push so the host's
        // snapshot lists this camera and reads can serve it. Guarded: missing
        // `android` native feature must never crash the camera producer.
        try {
            advertiseCamera(cameraNumber, w, h, PREVIEW_FPS)
        } catch (t: Throwable) {
            Log.w(TAG, "camera advertise unavailable: ${t.javaClass.simpleName}")
        }

        try {
            cm.openCamera(id, stateCallback, handler)
        } catch (e: Exception) {
            // The camera can be unavailable for many reasons — disabled by a device
            // policy (ServiceSpecificException "disabled by policy"), in use by
            // another client, or no grant at open time. A peripheral video producer
            // must never crash the System UI on boot, so we release any half-built
            // capture resources, report the camera off, and move on.
            detach()
            Log.w(TAG, "camera attach skipped: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    private const val TAG = "AmosGlue"

    /** Close the capture session, reader, and camera (frees the sensor). */
    fun detach() {
        session?.close()
        session = null
        camera?.close()
        camera = null
        reader?.close()
        reader = null
        thread?.quitSafely()
        thread = null
        handler = null
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
        val image = reader.acquireLatestImage() ?: return
        try {
            // A peripheral video producer must never crash the System UI: some
            // HAL/configs deliver plane buffers that are not Java-accessible
            // ("buffer is inaccessible") or transiently invalid — drop the frame
            // instead of throwing. image is always closed in finally.
            val nv21 = try {
                Nv21.packYuv420ToNv21(image)
            } catch (t: Throwable) {
                Log.w(TAG, "frame encode dropped: ${t.javaClass.simpleName}: ${t.message}")
                null
            }
            if (nv21 == null) return
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

    private val stateCallback = object : CameraDevice.StateCallback() {
        override fun onOpened(camera: CameraDevice) {
            this@CameraGlue.camera = camera
            startCapture(camera)
        }

        override fun onDisconnected(camera: CameraDevice) {
            camera.close()
            this@CameraGlue.camera = null
        }

        override fun onError(camera: CameraDevice, error: Int) {
            camera.close()
            this@CameraGlue.camera = null
        }
    }

    private fun startCapture(camera: CameraDevice) {
        val r = reader ?: return
        val target: Surface = r.surface
        val request = camera
            .createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
            .apply { addTarget(target) }
            .build()
        camera.createCaptureSession(
            listOf(target),
            object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(s: CameraCaptureSession) {
                    this@CameraGlue.session = s
                    try {
                        s.setRepeatingRequest(request, null, handler)
                    } catch (_: IllegalStateException) {
                        // Session already closed (stop/start race) — ignore.
                    }
                }

                override fun onConfigureFailed(s: CameraCaptureSession) {
                    s.close()
                }
            },
            handler,
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

