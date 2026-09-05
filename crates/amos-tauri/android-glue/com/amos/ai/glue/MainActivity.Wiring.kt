package com.amos.ai.glue

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * AmOS System UI — **wiring template** for the generated Tauri-Android Activity.
 *
 * This is the missing link between the [AmosGlue] facade and the generated
 * `MainActivity` (docs/REAL_DEVICE_SYSTEM_UI_AUDIT.md § "Runtime permission
 * wiring"). Tauri v2 generates the Activity but does not automatically request
 * the runtime `CAMERA` grant nor grant the WebView media (`getUserMedia`) the
 * Magnifier/Camera rely on. Copy the two calls below into the generated
 * Activity's `onStart` / `onRequestPermissionsResult`, and attach [mediaChrome]
 * (or subclass it) as the Activity's [WebView] `WebChromeClient`.
 *
 * Order of operations on a real device:
 *   1. `onStart`  → [requestNeeded] asks the OS for CAMERA (dialog).
 *   2. user grants → `onRequestPermissionsResult` → [AmosGlue.onCameraPermissionGranted]
 *      rebinds the torch, and the WebView can now be granted video capture.
 *   3. A `getUserMedia` call → the Activity's `WebChromeClient.onPermissionRequest`
 *      → [mediaChrome] grants `RESOURCE_VIDEO_CAPTURE` (because CAMERA is held).
 *
 * Structural delivery only — verify/compile at device time once the Tauri-Android
 * project exists (this module is kept under android-glue for that reason).
 */

object PermissionWire {

    private const val REQ_CAMERA = 9001

    /** Request CAMERA (and RECORD_AUDIO) if not already granted. Idempotent. */
    fun requestNeeded(activity: Activity) {
        val want = listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO).filter {
            ContextCompat.checkSelfPermission(activity, it) != PackageManager.PERMISSION_GRANTED
        }
        if (want.isEmpty()) return
        ActivityCompat.requestPermissions(activity, want.toTypedArray(), REQ_CAMERA)
    }

    /** Forward the OS result into [AmosGlue] + the WebView media grant readiness. */
    fun onResult(activity: Activity, requestCode: Int, grantResults: IntArray) {
        if (requestCode != REQ_CAMERA) return
        val cameraGranted = grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (cameraGranted) {
            AmosGlue.onCameraPermissionGranted(activity.applicationContext)
        } else {
            Toast.makeText(activity, "Camera denied — Magnifier runs in demo mode", Toast.LENGTH_LONG).show()
        }
    }

    /**
     * WebChromeClient that lets the WebView camera (getUserMedia) through once the
     * OS CAMERA grant is held. Attach via the Activity's webView.setWebChromeClient.
     * Attaching it is enough for iOS-like previews; without it getUserMedia is denied.
     */
    val mediaChrome: WebChromeClient
        get() = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val needsCamera = request.resources.any {
                    it == PermissionRequest.RESOURCE_VIDEO_CAPTURE ||
                        it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                }
                if (needsCamera) {
                    // We only hand over resources the OS permission layer already granted.
                    request.grant(request.resources)
                } else {
                    request.deny()
                }
            }
        }
}
