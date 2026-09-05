package com.amos.ai.glue

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * Amos System UI **glue facade** — attach/detach the Kotlin sensor & camera
 * producers and coordinate the runtime-permission flow.
 *
 * Boot contract (Rust side, `amos-tauri`): the native System UI core is what
 * binds the *read side* first — it calls `SensorHost::bind_android(vm, env,
 * context)` (+ `radio::from_android`) so GNSS/radios are live. This Kotlin facade
 * then supplies the *producer side*: [attach] starts the always-on motion feed
 * ([SensorGlue]) and the NV21 camera preview ([CameraGlue]), whose listeners
 * push straight into the same bus via the native upcalls
 * (`recordImu`/`recordFrame` in `amos-tauri/src/android_glue.rs`).
 *
 * Invoke from the Tauri-generated `MainActivity`/lifecycle so listeners stop with
 * the app and the camera/sensor hardware is released.
 */
object AmosGlue {

    private const val REQ_SENSORS = 5001

    private val REQUIRED = arrayOf(
        android.Manifest.permission.CAMERA,
        // BODY_SENSORS is only on API 31+; guard it out on older devices.
    )

    /** Request CAMERA (+ BODY_SENSORS where present) from [activity]. */
    fun ensurePermissions(activity: Activity) {
        val missing = REQUIRED.filter {
            ContextCompat.checkSelfPermission(activity, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) return
        ActivityCompat.requestPermissions(activity, missing.toTypedArray(), REQ_SENSORS)
    }

    /**
     * Start the producers. Call after permissions are granted (see
     * [ensurePermissions]); this is a skeleton — wire it to the Activity's
     * `onStart`/post-permission callback at device bring-up.
     */
    fun onStart(context: Context) {
        // GNSS/radios already bound on the Rust side (SensorHost::bind_android).
        SensorGlue.attach(context.applicationContext)
        CameraGlue.attach(context.applicationContext)
    }

    /** Stop the producers and release the camera/sensor hardware. */
    fun onStop(context: Context) {
        SensorGlue.detach()
        CameraGlue.detach()
    }
}
