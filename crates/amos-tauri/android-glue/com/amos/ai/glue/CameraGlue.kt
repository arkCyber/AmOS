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

        try {
            cm.openCamera(id, stateCallback, handler)
        } catch (_: SecurityException) {
            // No CAMERA grant at open time; retry after the permission flow.
        }
    }

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

    override fun onImageAvailable(reader: ImageReader) {
        val image = reader.acquireLatestImage() ?: return
        try {
            val nv21 = Nv21.packYuv420ToNv21(image) ?: return
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
        val target = Surface(r.surface)
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
                ?: return null
            val sizes = configs.getOutputSizes(ImageFormat.YUV_420_888) ?: return null
            sizes
                .filter { it.width <= targetW && it.height <= targetH }
                .maxByOrNull { it.width * it.height }
                ?: sizes.maxByOrNull { it.width * it.height }
                ?.let { Pair(it.width, it.height) }
        } catch (_: Exception) {
            null
        }
    }
}

