package com.amos.ai.glue

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import android.os.Handler
import android.os.Looper

/**
 * Amos flashlight glue — **System UI APK side** handing the real torch (the rear
 * camera's flash unit) to the Rust `FlashlightBridge`.
 *
 * The illumination torch is driven through Android [CameraManager] via
 * `setTorchMode(cameraId, enabled)` (API 23+). Rust ships the provider + bridge
 * (`amos-tauri/src/flashlight.rs`); this object resolves *which* camera carries a
 * usable flash unit and hands it up through the JNI upcalls:
 *
 *   external fun attach(context, cameraId, hasFlash)   // ─►
 *     Java_..._FlashlightGlue_attach  (installs AndroidFlashlightProvider)
 *   external fun onTorchChanged(enabled)                // ─►
 *     Java_..._FlashlightGlue_onTorchChanged (reflect OS-driven state)
 *
 * We also register a [CameraManager.TorchCallback] so OS-driven torch changes
 * (another app toggled, thermal shutdown, capture) keep the Rust mirror honest.
 *
 * Bring-up like `SensorGlue`/`CameraGlue`/`ClipboardGlue`: verified at device
 * time after `tauri android init` once the System UI APK ships
 * `libamos_tauri_lib.so`. Requires the `CAMERA` permission (AmosGlue requests
 * it); call [bind] again after the permission is granted.
 */
object FlashlightGlue {

    /** `CameraManager#setTorchMode`/torch callbacks require API 23+. */
    private const val TORCH_API = 23

    private var boundCameraId: String? = null

    /**
     * Bind the real torch: resolve the rear camera whose flash can act as a torch
     * and hand the *true hardware picture* to the native provider — even when no
     * camera has a flash, so a torch-less device reports honestly (disabled tile)
     * instead of falling back to the desktop Mock that claims a torch. Idempotent.
     * On API < 23 (no torch APIs) or no camera service it stays inert.
     */
    fun bind(context: Context) {
        if (boundCameraId != null) return // already bound the real device picture
        if (Build.VERSION.SDK_INT < TORCH_API) return // no torch APIs on this device
        val app = context.applicationContext
        val cm = app.getSystemService(Context.CAMERA_SERVICE) as? CameraManager ?: return
        val (cameraId, hasFlash) = torchCamera(cm)
        // Always hand the real picture to native — even a torch-less device must
        // not silently fall back to the desktop Mock, which claims a torch. A
        // device with no flash unit reports torch_present=false so the tile is
        // disabled ("no torch") instead of lying.
        boundCameraId = cameraId
        attach(app, cameraId, hasFlash)
        if (cameraId.isNotEmpty()) {
            registerTorchCallback(cm, cameraId)
        }
    }

    /** Push OS-driven torch state (TorchCallback) to Rust so snapshot stays true. */
    private fun registerTorchCallback(cm: CameraManager, id: String) {
        val callback = object : CameraManager.TorchCallback() {
            override fun onTorchModeChanged(cameraId: String, enabled: Boolean) {
                if (cameraId == id) onTorchChanged(enabled)
            }

            override fun onTorchModeUnavailable(cameraId: String) {
                if (cameraId == id) onTorchChanged(false)
            }
        }
        // The callback must be dispatched on a thread with a Looper (main is fine).
        try {
            cm.registerTorchCallback(callback, Handler(Looper.getMainLooper()))
        } catch (_: RuntimeException) {
            // E.g. already-registered or camera service hiccup — the native side
            // still mirrors our own successful setTorchMode requests.
        }
    }

    /**
     * Pick the camera to drive as the torch: prefer the **rear** camera with a
     * flash unit; otherwise fall back to any camera that has a flash. Returns an
     * empty id when no usable torch exists.
     */
    private fun torchCamera(cm: CameraManager): Pair<String, Boolean> {
        val ids = cm.cameraIdList ?: return "" to false
        val rearWithFlash = ids.firstOrNull {
            flashAvailable(cm, it) && facing(cm, it) == CameraCharacteristics.LENS_FACING_BACK
        }
        if (rearWithFlash != null) return rearWithFlash to true
        val anyFlash = ids.firstOrNull { flashAvailable(cm, it) }
        return if (anyFlash != null) anyFlash to true else "" to false
    }

    private fun flashAvailable(cm: CameraManager, id: String): Boolean {
        return try {
            val ch = cm.getCameraCharacteristics(id)
            ch.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) ?: false
        } catch (_: Exception) {
            false
        }
    }

    private fun facing(cm: CameraManager, id: String): Int {
        return try {
            val ch = cm.getCameraCharacteristics(id)
            ch.get(CameraCharacteristics.LENS_FACING) ?: CameraCharacteristics.LENS_FACING_FRONT
        } catch (_: Exception) {
            CameraCharacteristics.LENS_FACING_FRONT
        }
    }

    /** JNI: hand the real torch camera to the native provider (see `flashlight.rs`). */
    private external fun attach(context: Context, cameraId: String, hasFlash: Boolean)

    /** JNI: reflect an OS-driven torch change into the native provider. */
    private external fun onTorchChanged(enabled: Boolean)

    init {
        // The System UI's Rust staticlib exposes the upcalls. Best-effort: on a
        // freshly-generated Tauri project the .so is `libamos_tauri_lib.so`.
        try {
            System.loadLibrary("amos_tauri_lib")
        } catch (_: UnsatisfiedLinkError) {
            // Native lib not on the classpath yet (e.g. a host lint pass) — no-op;
            // the glue simply stays inert until the real APK ships it.
        }
    }
}
