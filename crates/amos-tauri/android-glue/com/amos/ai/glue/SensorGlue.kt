package com.amos.ai.glue

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock

/**
 * Amos sensor producer glue — **System UI APK side**.
 *
 * Registers a [SensorEventListener] for the accelerometer + gyroscope and hands
 * every sample to the AmOS native runtime via the JNI upcall [recordImu] (the
 * Rust side lives in `amos-tauri/src/android_glue.rs` and pushes into the shared
 * `LiveSensorProvider` bus that `SensorHost` reads).
 *
 * Owns *no* state beyond what a sample needs: each event is pushed straight to
 * native, so AmOS's `SensorHost.snapshot()` returns the latest motion without
 * this object being polled. Companion-native contract:
 *
 *   native fun recordImu(tsMs: Long, ax: Float, ay: Float, az: Float,
 *                        gx: Float, gy: Float, gz: Float, tempC: Float)
 *
 * This is a bring-up skeleton: verified at device time after `tauri android
 * init` + a `CAMERA`/`BODY_SENSORS` permission grant (see docs/android-glue.md).
 */
object SensorGlue : SensorEventListener {

    // Optional accelerometer/gyroscope register knobs.
    private const val SAMPLING_PERIOD_US = SensorManager.SENSOR_DELAY_NORMAL

    private var sensorManager: SensorManager? = null
    private var attached = false

    /** Bind to the app `Context`, register the motion sensors. Idempotent. */
    fun attach(context: Context) {
        if (attached) return
        val sm = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
        sensorManager = sm
        sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let {
            sm.registerListener(this, it, SAMPLING_PERIOD_US)
        }
        sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let {
            sm.registerListener(this, it, SAMPLING_PERIOD_US)
        }
        attached = true
    }

    /** Release the listeners (System UI teardown / when the user revokes). */
    fun detach() {
        sensorManager?.unregisterListener(this)
        sensorManager = null
        attached = false
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        // Not needed for the always-on motion feed.
    }

    override fun onSensorChanged(event: SensorEvent) {
        val tsMs = SystemClock.elapsedRealtime()
        when (event.sensor?.type) {
            Sensor.TYPE_ACCELEROMETER -> {
                if (event.values.size >= 3) {
                    cacheAccel(event.values[0], event.values[1], event.values[2])
                    recordImu(
                        tsMs,
                        event.values[0], event.values[1], event.values[2],
                        0f, 0f, 0f,
                        DEFAULT_DIE_TEMP_C,
                    )
                }
            }
            Sensor.TYPE_GYROSCOPE -> {
                if (event.values.size >= 3) {
                    // Pair with the most recent accelerometer reading so every sample
                    // is a (accel, gyro) tuple; the bus keeps only the newest sample.
                    recordImu(
                        tsMs,
                        lastAccelX, lastAccelY, lastAccelZ,
                        event.values[0], event.values[1], event.values[2],
                        DEFAULT_DIE_TEMP_C,
                    )
                }
            }
        }
    }

    private var lastAccelX = 0f
    private var lastAccelY = 0f
    private var lastAccelZ = 0f

    // Keep a tiny mirror of the last accel so gyro events can pair with it.
    private fun cacheAccel(x: Float, y: Float, z: Float) {
        lastAccelX = x
        lastAccelY = y
        lastAccelZ = z
    }

    private val DEFAULT_DIE_TEMP_C = 25.0f

    /** JNI upcall into the AmOS native runtime (see android_glue.rs). */
    external fun recordImu(
        tsMs: Long,
        ax: Float, ay: Float, az: Float,
        gx: Float, gy: Float, gz: Float,
        tempC: Float,
    )

    init {
        // The System UI's Rust staticlib exposes the upcalls below. Best-effort:
        // on a freshly-generated Tauri project the .so is `libamos_tauri_lib.so`.
        try {
            System.loadLibrary("amos_tauri_lib")
        } catch (_: UnsatisfiedLinkError) {
            // Native lib not on the classpath yet (e.g. a host lint pass) — no-op;
            // recordImu simply never fires until the real APK ships it.
        }
    }
}
