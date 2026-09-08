package com.amos.ai.glue

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.util.Log
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray

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
    private const val REQ_MEDIA = 9003
    private const val TAG = "AmosMediaWire"

    /** Request CAMERA (and RECORD_AUDIO) if not already granted. Idempotent. */
    fun requestNeeded(activity: Activity) {
        val want = listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO).filter {
            ContextCompat.checkSelfPermission(activity, it) != PackageManager.PERMISSION_GRANTED
        }
        if (want.isEmpty()) return
        ActivityCompat.requestPermissions(activity, want.toTypedArray(), REQ_CAMERA)
    }

    /** Request the media read permission(s) (per API level) if not granted. */
    fun requestMedia(activity: Activity) {
        MediaPermissions.request(activity, REQ_MEDIA)
    }

    /** If read access is already held (e.g. pre-granted), attach MediaStore now —
     * a dialog-less path so a granted app picks up the real backend without waiting
     * for a grant callback. Logs (never throws) on native attach failure. */
    fun ensureAttached(activity: Activity) {
        if (!MediaPermissions.hasReadAccess(activity)) return
        runCatching {
            val glue = MediaStoreGlue(activity.applicationContext)
            glue.attach()
            Log.i(TAG, "media backend attached (MediaStore)")
            // Self-check (no UI needed): list DCIM/Camera through the SAME query
            // media_list uses and log the count, so a device log confirms the path.
            val arr = JSONArray(glue.listCollection("camera"))
            Log.i(TAG, "self-check media_list(camera) => ${arr.length()} items")
        }.onFailure { Log.w(TAG, "media attach failed: ${it.message}") }
    }

    /** Forward the OS result into [AmosGlue] + the WebView media grant readiness. */
    fun onResult(activity: Activity, requestCode: Int, grantResults: IntArray) {
        when (requestCode) {
            REQ_CAMERA -> {
                val cameraGranted = grantResults.isNotEmpty() &&
                    grantResults[0] == PackageManager.PERMISSION_GRANTED
                if (cameraGranted) {
                    AmosGlue.onCameraPermissionGranted(activity.applicationContext)
                } else {
                    Toast.makeText(activity, "Camera denied — Magnifier runs in demo mode", Toast.LENGTH_LONG).show()
                }
            }
            REQ_MEDIA -> {
                val granted = grantResults.isNotEmpty() &&
                    grantResults.all { it == PackageManager.PERMISSION_GRANTED }
                if (granted) {
                    // Hand this MediaStoreGlue instance to the native media backend
                    // (JNI attach) so media_* commands read the real external storage.
                    runCatching { MediaStoreGlue(activity.applicationContext).attach() }
                        .onFailure { Log.w(TAG, "media attach failed: ${it.message}") }
                } else {
                    Toast.makeText(activity, "Media access denied — external collections unavailable", Toast.LENGTH_LONG).show()
                }
            }
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

/**
 * Isolate native binds so a missing `android` native feature degrades to a log
 * instead of a boot crash (`UnsatisfiedLinkError` is a Throwable, not an
 * Exception — plain `catch(Exception)` would NOT stop it).
 */
object NativeBootGuard {
    private const val TAG = "NativeBootGuard"

    /** Run [block], logging (never throwing) if a native symbol is unavailable. */
    fun quiet(name: String, block: () -> Unit) {
        try {
            block()
        } catch (t: Throwable) {
            Log.w(TAG, "$name unavailable (missing android native feature?): $t")
        }
    }
}

/**
 * Boot-guard usage (apply in the generated `MainActivity`, e.g. `onStart`):
 * ```
 * NativeBootGuard.quiet("telephony") {
 *   TelephonyGlue.bind(applicationContext)
 *   TelephonyGlue.ensureCallPermission(this)
 * }
 * NativeBootGuard.quiet("home") { onPhysicalHome() }
 * ```
 * Kept here so it survives Tauri regenerating `MainActivity.kt`.
 */

/**
 * AmOS **always-on / 常驻·永亮 display** helper — keeps the System UI visible on a
 * real handset "forever" (a wall-mount / showcase build, USB-connected S5…).
 *
 * Two layers keep the UI on the screen; this glue is the native half:
 *  1. **Never physically sleep** — `FLAG_KEEP_SCREEN_ON` holds the display awake
 *     while this Activity is the foreground window, *independent* of the Android
 *     screen-off timeout and of the "Stay awake while charging" developer setting.
 *  2. AmOS's own idle → auto-lock watcher is a *frontend* concern (`lib/display.ts`
 *     `amos.displayAutoOffSec`); default is now OFF — see `osAutoOff.ts`. This
 *     object is intentionally NOT that (the JS lock is a UI state, not a power call).
 *
 * Why it lives here and not inline in the generated Activity: Tauri regenerates
 * `MainActivity.kt` under `gen/android` (gitignored) on `cargo tauri android init`,
 * so anything written only there is silently lost. `android-glue` is the tracked
 * source of truth — keeping the helper here means re-wiring after a regen is one
 * call. Wire it in the generated `MainActivity`:
 * ```
 * class MainActivity : TauriActivity() {
 *   override fun onCreate(savedInstanceState: Bundle?) {
 *     super.onCreate(savedInstanceState)
 *     AlwaysOn.apply(this)   // never sleep while AmOS is foreground
 *   }
 * }
 * ```
 */
object AlwaysOn {

  private const val TAG = "AmosAlwaysOn"

  /**
   * Hold the physical display on while AmOS is foreground. Pure window flag — no
   * `WAKE_LOCK` permission, no foreground-service hack, auto-released by Android
   * the moment the Activity leaves the foreground (safe: no leaked wakelock). The
   * generated Activity just calls this in `onCreate` / `onStart`.
   */
  fun apply(activity: Activity) {
    try {
      activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      Log.i(TAG, "FLAG_KEEP_SCREEN_ON set — display will not sleep while AmOS is foreground")
    } catch (t: Throwable) {
      Log.w(TAG, "keep-screen-on failed: ${t.javaClass.simpleName}: ${t.message}")
    }
  }
}

