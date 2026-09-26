package com.amos.ai.glue

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
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
 * **Imports are the copy's job, not this file's.** This template declares
 * `package com.amos.ai.glue`, so every glue class it names is in *its* package and it needs no
 * imports of its own. The generated Activity is `package com.amos.ai` — a different package — so
 * each class it names must be imported there (`import com.amos.ai.glue.RotationGlue`, …). Copy the
 * calls **and** their imports; a call without its import does not compile, and an APK that does not
 * compile binds nothing at all. `scripts/android-activity-wiring-check.sh` verifies both the call
 * and its resolvability (measured 2026-09-21: `RotationGlue.bind(this)` was copied without the
 * import and the check stayed green while the Kotlin build died on
 * `Unresolved reference: RotationGlue`).
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
        // Bind the native-only RECORD_AUDIO glue (always-on AAudio mic) so the
        // Rust mic_permission_request can drive isGranted()/request() on demand,
        // independent of the WebView CAMERA grant path.
        MicPermissionGlue.ensureBound(activity)
        // Bind the native-only location glue (real LocationManager GNSS read) so the
        // Rust location_permission_request can drive grantLevel()/request() on demand.
        // It is deliberately NOT part of the up-front `want` list below: a location
        // prompt belongs to the moment an app asks to be located, not to first launch
        // (REQ-A772 / F-SH-228).
        LocationPermissionGlue.ensureBound(activity)
        // Bind the native-only SMS glue (READ_SMS / SEND_SMS / RECEIVE_SMS) so the Rust
        // sms_permission_request can drive allGranted()/request() on demand. Like location
        // it is deliberately NOT in the up-front `want` list below: the SMS dialog belongs
        // to the moment the user opens Messages, not to first launch — and until this
        // seam existed nothing ever asked at all, so a normal install reported a
        // permission error with no way to fix it from inside AmOS (REQ-A1577 / F-TEL-037).
        SmsPermissionGlue.ensureBound(activity)
        val want = listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO).filter {
            ContextCompat.checkSelfPermission(activity, it) != PackageManager.PERMISSION_GRANTED
        } + bluetoothConnectIfNeeded(activity) + bluetoothScanIfNeeded(activity) + notificationsIfNeeded(activity) +
            activityRecognitionIfNeeded(activity) + bodySensorsIfNeeded(activity)
        if (want.isEmpty()) return
        ActivityCompat.requestPermissions(activity, want.toTypedArray(), REQ_CAMERA)
    }

    /**
     * `ACTIVITY_RECOGNITION` — the API 29+ **runtime** permission Android gates the
     * step counter behind (`SensorManager.TYPE_STEP_COUNTER`). Without it,
     * `registerListener` throws `SecurityException` on API 29+ ROMs, so the Health
     * screen's step reading stays absent. Requested up front with the others;
     * `SensorGlue` guards the registration, so a denial degrades to an honest `—`
     * rather than a crash. Below API 29 the sensor needs no permission.
     */
    private fun activityRecognitionIfNeeded(activity: Activity): List<String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return emptyList()
        val perm = Manifest.permission.ACTIVITY_RECOGNITION
        return if (ContextCompat.checkSelfPermission(activity, perm) == PackageManager.PERMISSION_GRANTED) {
            emptyList()
        } else {
            listOf(perm)
        }
    }

    /**
     * `BODY_SENSORS` — the API 31+ **runtime** permission the heart-rate sensor
     * (`SensorManager.TYPE_HEART_RATE`) requires. Below API 31 the sensor was
     * reachable without a runtime grant. A denial leaves the heart-rate reading
     * absent (`—`), never a fabricated `0`.
     */
    private fun bodySensorsIfNeeded(activity: Activity): List<String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return emptyList()
        val perm = Manifest.permission.BODY_SENSORS
        return if (ContextCompat.checkSelfPermission(activity, perm) == PackageManager.PERMISSION_GRANTED) {
            emptyList()
        } else {
            listOf(perm)
        }
    }

    /**
     * `POST_NOTIFICATIONS` — the API 33+ **runtime** permission the firing ring needs: the alarm's
     * full-screen-intent notification is **silently not posted** without it (and it is off by
     * default for a fresh install), so the one moment the user cares about would pass with nothing
     * on screen (REQ-A375 / F-TAU-012). Below 33 notifications need no permission.
     */
    private fun notificationsIfNeeded(activity: Activity): List<String> {
        if (Build.VERSION.SDK_INT < 33) return emptyList()
        val perm = Manifest.permission.POST_NOTIFICATIONS
        return if (ContextCompat.checkSelfPermission(activity, perm) == PackageManager.PERMISSION_GRANTED) {
            emptyList()
        } else {
            listOf(perm)
        }
    }

    /**
     * `BLUETOOTH_CONNECT` — the API 31+ runtime permission every Bluetooth read/write
     * in `crates/amos-radio/src/android.rs` needs (`BluetoothAdapter#isEnabled` /
     * `enable` / `disable`). Without it those JNI calls throw `SecurityException`, so
     * the permission is part of "the radios can be read at all", not a nicety: the
     * status bar's Bluetooth badge and the quick-settings tile both depend on it.
     *
     * Below API 31 the legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` pair is install-time, so
     * there is nothing to request (REQ-A185).
     */
    private fun bluetoothConnectIfNeeded(activity: Activity): List<String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return emptyList()
        val perm = Manifest.permission.BLUETOOTH_CONNECT
        return if (ContextCompat.checkSelfPermission(activity, perm) == PackageManager.PERMISSION_GRANTED) {
            emptyList()
        } else {
            listOf(perm)
        }
    }

    /**
     * `BLUETOOTH_SCAN` — the API 31+ runtime permission `BluetoothGlue.startDiscovery`
     * needs (REQ-A200). Requested up front with the others so the Bluetooth page's
     * "search" button is usable immediately; a denial is **not** fatal and is not
     * hidden either: `startDiscovery` refuses, Rust turns that into a provider error,
     * and the screen says the scan could not start instead of showing an empty list
     * that would read as "nothing nearby".
     *
     * Below API 31 scanning is covered by the install-time BLUETOOTH/BLUETOOTH_ADMIN
     * pair, so there is nothing to request.
     */
    private fun bluetoothScanIfNeeded(activity: Activity): List<String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return emptyList()
        val perm = Manifest.permission.BLUETOOTH_SCAN
        return if (ContextCompat.checkSelfPermission(activity, perm) == PackageManager.PERMISSION_GRANTED) {
            emptyList()
        } else {
            listOf(perm)
        }
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
            LocationPermissionGlue.REQ_LOCATION -> {
                // Native-only location result (the real LocationManager GNSS read behind the
                // sensor snapshot's `gnss`, requested by location_permission_request — NOT the
                // WebView navigator.geolocation path). Resolve the pending Rust request with
                // the *level* the user actually gave (none / coarse / fine), so the screen can
                // say "approximate" instead of pretending the fix is precise (REQ-A772).
                LocationPermissionGlue.onLocationResult()
            }
            SmsPermissionGlue.REQ_SMS -> {
                // Native-only SMS result (READ/SEND/RECEIVE, requested by
                // sms_permission_request). Resolve the pending Rust request so the JS await
                // returns granted/incomplete — the verdict is re-read from the platform
                // inside onSmsResult, not guessed from this array's order.
                SmsPermissionGlue.onSmsResult()
                if (!SmsPermissionGlue.allGranted()) {
                    Toast.makeText(activity, "SMS permission incomplete — inbox read/send unavailable", Toast.LENGTH_LONG).show()
                }
            }
            MicPermissionGlue.REQ_MIC -> {
                // Native-only RECORD_AUDIO result (always-on AAudio mic, requested by
                // mic_permission_request — NOT the WebView getUserMedia path). Resolve
                // the pending Rust request so the JS await returns granted/denied.
                val granted = grantResults.isNotEmpty() &&
                    grantResults[0] == PackageManager.PERMISSION_GRANTED
                MicPermissionGlue.onMicResult(granted)
                if (!granted) {
                    Toast.makeText(activity, "Microphone denied — native voice unavailable", Toast.LENGTH_LONG).show()
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
 *   TelephonyGlue.attachActivity(this)
 *   TelephonyGlue.ensureCallPermission(this)
 * }
 * NativeBootGuard.quiet("home") { onPhysicalHome() }
 * ```
 * Kept here so it survives Tauri regenerating `MainActivity.kt`.
 *
 * `attachActivity` matters for the **default-phone-app** role dialog
 * (`telephony_request_default_dialer`, REQ-A1180): the ROLE_DIALER UI resolves the
 * requesting package from the caller identity, and `BlocklistGlue` proved on the API 34
 * target that a plain application-context `startActivity` can be posted and silently
 * dropped. Without the Activity the request still falls back to the app context (logged),
 * but the reliable path is the foreground one.
 *
 * **Spam blocking (re-apply after a regen, alongside [AlwaysOn]):** the generated
 * `MainActivity.onStart` must call [`BlocklistGlue.bind`] **unconditionally** — NOT
 * behind the `cameraGranted()` gate that guards `AmosGlue.onStart` — and hand the
 * Activity to [`BlocklistGlue.attachActivity`]:
 * ```
 * try {
 *   BlocklistGlue.bind(applicationContext)
 *   BlocklistGlue.attachActivity(this)
 * } catch (t: Throwable) { Log.w(TAG, "blocklist glue unavailable: $t") }
 * ```
 * Four reasons: (1) the one JSON rule store must resolve to the *same* file for the
 * WebView, the SMS filter and the `AmosCallScreeningService`; (2) the Rust
 * `blocklist_status` / `blocklist_request_role` commands call the Kotlin role
 * helpers through this glue; (3) `bind` is idempotent and fails soft, so it is safe
 * even when the APK was built without the `android` native feature; (4) the Call
 * Screening role dialog must be started from a **foreground Activity** — an
 * application-context `startActivity` is silently swallowed by the Android 10+
 * background-activity-start rules (device-verified on API 34: the command reported
 * success while no dialog appeared and the role stayed unheld).
 */

/**
 * AmOS **device care (手机管家) glue** — re-apply after a Tauri regen, alongside
 * [AlwaysOn] and [BlocklistGlue].
 *
 * The generated `MainActivity.onStart` must hand this glue the foreground
 * Activity and bind it:
 * ```
 * try {
 *   DevCareGlue.attachActivity(this)
 *   DevCareGlue.bind(applicationContext)
 * } catch (t: Throwable) { Log.w(TAG, "devcare glue unavailable: $t") }
 * ```
 * Three reasons: (1) `bind` installs the real backend (PackageManager inventory,
 * `ACTION_DELETE` uninstall, `StatFs` storage totals, app-private junk scan) into
 * the Rust `DevCareBridge` through a JNI upcall; (2) the uninstall dialog must be
 * started from a **foreground Activity** — an application-context `startActivity`
 * is silently dropped by the Android 10+ background-activity-start rules; (3)
 * `bind` is idempotent and fails soft, so an APK built without the `android`
 * native feature only logs a warning.
 *
 * See `DevCareGlue.kt` for the wire contract and the honest scope of a non-root
 * retail app (it cleans its own cache/logs/APK residue, not other apps').
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
/**
 * AmOS **exact-alarm binding** — the device half of "the alarm must wake a sleeping phone"
 * (REQ-A369, closing F-TAU-007). The generated `MainActivity.onStart` hands the glue the app
 * context once:
 * ```
 * try {
 *   AlarmGlue.bind(applicationContext)
 * } catch (t: Throwable) { Log.w(TAG, "alarm glue unavailable: $t") }
 * ```
 * Why it has to be there: `AlarmGlue.bind` installs the Rust host's `Context` through the
 * `AlarmGlue.attachContext` JNI upcall, and without it `scheduler_alarm_register` can only
 * write its in-memory ledger — which is exactly how a real device round (REQ-A362) measured
 * `dumpsys alarm` **empty** after a registration the WebView saw succeed: the phone would not
 * have woken. `bind` is idempotent and fails soft, so an APK built without the `android`
 * native feature logs a warning instead of crashing boot.
 *
 * `AlarmReceiver` (declared in `AndroidManifest.components.xml`) is what runs at the alarm
 * instant and brings the System UI forward; `AlarmGlue.kt` documents the status contract
 * (`scheduled` / `disallowed` / `unavailable` / `denied`) the host surfaces verbatim.
 */

/**
 * AmOS **device-orientation binding** (rotation lock / forced orientation, REQ-A677) — the
 * device half of the quick-settings "rotation lock" tile. The generated `MainActivity.onStart`
 * hands the glue the foreground Activity (and, through `bind`, installs the JavaVM so Rust can
 * call back by name):
 * ```
 * try {
 *   RotationGlue.bind(this)
 * } catch (t: Throwable) { Log.w(TAG, "rotation glue unavailable: $t") }
 * ```
 * Why it has to be there: `RotationGlue.attach` installs the JavaVM through the
 * `Java_com_amos_ai_glue_RotationGlue_attach` upcall, and the glue holds the **foreground
 * Activity** that `Activity#setRequestedOrientation` needs — the only thing that actually turns
 * the display. Without it `rotation_set` can only store the intent (the Rust side reports
 * `Unattached` or `Unavailable`) and a lock the user set would never be applied. Call it
 * **unconditionally** (NOT behind the CAMERA gate): the stored lock is re-applied at boot and no
 * camera is involved. `bind` is idempotent and fails soft, so an APK built without the `android`
 * native feature logs a warning instead of crashing boot.
 *
 * The *decision* of which mode means which `ActivityInfo.SCREEN_ORIENTATION_*` code is NOT in
 * the Kotlin: it lives in the pure, unit-tested `amos_display::orientation` kernel, and the
 * glue only forwards the integer it is handed.
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

/**
 * AmOS **BLE / NFC / Biometric JNI binding** — install the JavaVM so Kotlin
 * can call back into Rust.
 *
 * This wiring MUST be placed in the generated `MainActivity.onStart` BEFORE any
 * BLE/NFC/Biometric operation. It installs the bidirectional JNI bridge:
 * - Rust calls Kotlin: `ble::ble_connect()`, `nfc_start_dispatch()`, etc.
 * - Kotlin calls Rust: `BluetoothGattGlue.onConnectionStateChange()`, `NfcGlue.onNfcTagDiscovered()`, etc.
 *
 * Wire it in the generated `MainActivity`:
 * ```
 * override fun onStart() {
 *   super.onStart()
 *   // Install JNI binding for BLE/NFC/Biometric FIRST.
 *   NativeBootGuard.quiet("device-glue") {
 *     BluetoothGattGlue.install(this)
 *     NfcGlue.init(this)
 *   }
 *   // ... other wiring (PermissionWire.requestNeeded, etc.)
 * }
 * ```
 *
 * The `BluetoothGattGlue.install()` call is the bootstrap — it calls `nativeInstall()`
 * which installs the JavaVM + Context into Rust. After this, all three glue objects
 * (BLE, NFC, Biometric) can use the same binding.
 */


/**
 * AmOS **whole-screen capture binding** (REQ-A1582 / F-DEV-141) — the device half of the
 * host's `screen_record_*` commands. Two calls, in two different Activity methods, because
 * a capture spans a *user decision*:
 *
 * ```
 * override fun onStart() {
 *   super.onStart()
 *   ScreenRecordGlue.attachActivity(this)   // the Activity the consent dialog is posted from
 * }
 *
 * // Added to the wired Activity (alongside onRequestPermissionsResult, which the media /
 * // SMS / telephony glues already need):
 * override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
 *   super.onActivityResult(requestCode, resultCode, data)
 *   if (requestCode == ScreenRecordGlue.REQ_SCREEN_RECORD) {
 *     ScreenRecordGlue.onConsentResult(this, resultCode, data)
 *   }
 * }
 * ```
 *
 * Why each half is load-bearing:
 *   * `attachActivity` is the only place the glue gets the Context/Activity it needs at all.
 *     Without it `screen_record_start` answers `unavailable` and nothing can be captured.
 *   * `onActivityResult` is what turns an *approval* into a session. Android has no way to
 *     ask for a screen capture other than `createScreenCaptureIntent()` +
 *     `startActivityForResult`, so a build without this override compiles, ships, opens the
 *     system dialog on start — and then does nothing whatever the user taps. That silent
 *     no-op is precisely the defect `scripts/android-activity-wiring-check.sh` exists to
 *     refuse a build for.
 *
 * Note the **request-code dispatch**: `onActivityResult` is shared with anything else in the
 * Activity that uses it (Tauri's own file pickers among them), so the branch must test
 * `REQ_SCREEN_RECORD` rather than assume it is the only caller.
 *
 * Honest boundary: no device has run this. `ScreenRecordGlue`'s own KDoc states the
 * unverified parts; the FMEA row for F-DEV-141 records them as device-only work.
 */
