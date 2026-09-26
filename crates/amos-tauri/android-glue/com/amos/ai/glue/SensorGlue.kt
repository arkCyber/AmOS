package com.amos.ai.glue

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import android.util.Log

/**
 * Amos sensor producer glue — **System UI APK side**.
 *
 * Registers a [SensorEventListener] for the accelerometer + gyroscope and hands
 * every sample to the AmOS native runtime via the JNI upcall [recordImu] (the
 * Rust side lives in `amos-tauri/src/android_glue.rs` and pushes into the shared
 * `LiveSensorProvider` bus that `SensorHost` reads). It also registers the
 * wellness pair — a step counter and a heart-rate sensor, both optional — which
 * cross the same seam through [recordVitals].
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

    // Whether each wellness listener is currently registered. `detach()` clears both, so a
    // re-attach re-registers; a **refused** registration leaves its flag `false`, which is
    // what makes the next attach retry it (see [registerWellness] / [wellnessRegistered]).
    private var stepCounterRegistered = false
    private var heartRateRegistered = false

    /**
     * Bind to the app `Context` and register the sensors. The motion pair (accelerometer /
     * gyroscope) is bound once; the wellness pair is attempted on **every** call (see
     * [registerWellness]).
     */
    fun attach(context: Context) {
        val sm = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
        if (!attached) {
            sensorManager = sm
            sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let {
                sm.registerListener(this, it, SAMPLING_PERIOD_US)
            }
            sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let {
                sm.registerListener(this, it, SAMPLING_PERIOD_US)
            }
            attached = true
            // Hand the app Context to Rust so the host can build the real GNSS provider
            // (LocationManager) for its snapshot. Guarded: if the APK was built without
            // the `android` native feature the symbol is missing and must not crash boot.
            try {
                attachContext(context)
            } catch (t: Throwable) {
                Log.w("AmosGlue", "sensor attachContext unavailable: ${t.javaClass.simpleName}")
            }
        }
        // Deliberately **outside** the `attached` guard. The wellness pair's runtime grant
        // usually arrives *after* the first attach — `MainActivity.onStart` calls
        // `AmosGlue.onStart` before the permission dialog is answered — so the retry is the
        // *second* `AmosGlue.onStart`, fired from `onRequestPermissionsResult` once the user
        // taps Allow. A guard that skipped it left the step counter unregistered for the rest
        // of the session: the counter was never enabled, so no vitals sample ever reached the
        // Health screen, which drew 「—」 with every permission showing as granted (REQ-A1863).
        registerWellness(sm)
    }

    /**
     * Attempt both optional wellness registrations, keeping each flag truthful.
     *
     * A device may expose neither, one, or both sensors. `TYPE_STEP_COUNTER` requires the
     * `ACTIVITY_RECOGNITION` runtime grant on API 29+ and `TYPE_HEART_RATE` requires
     * `BODY_SENSORS` on API 31+; `registerListener` refuses a sensor whose permission is not
     * held with a `SecurityException`, and may also answer `false`. Both are refusals that
     * must not latch — see [wellnessRegistered].
     */
    private fun registerWellness(sm: SensorManager) {
        stepCounterRegistered = wellnessRegistered(
            stepCounterRegistered,
            attemptWellness(sm, Sensor.TYPE_STEP_COUNTER, "step counter not registered (ACTIVITY_RECOGNITION?)"),
        )
        heartRateRegistered = wellnessRegistered(
            heartRateRegistered,
            attemptWellness(sm, Sensor.TYPE_HEART_RATE, "heart rate not registered (BODY_SENSORS?)"),
        )
    }

    /**
     * Try to register one optional wellness sensor: `null` when the platform exposes no such
     * sensor (nothing was attempted), otherwise whether the registration was accepted.
     */
    private fun attemptWellness(sm: SensorManager, sensorType: Int, what: String): Boolean? {
        val sensor = sm.getDefaultSensor(sensorType) ?: return null
        return try {
            // Idempotent for a listener already on this sensor: the platform replaces the
            // registration instead of delivering the sample twice.
            sm.registerListener(this, sensor, SAMPLING_PERIOD_US)
        } catch (t: SecurityException) {
            Log.w("AmosGlue", "$what: ${t.javaClass.simpleName}")
            false
        }
    }

    /**
     * Release the listeners (System UI teardown / when the user revokes) **and drop the
     * samples they pushed**, so a later re-attach never serves a stale pre-detach reading
     * as the current one ([clearSamples] clears the shared bus and announces it, which is
     * what lets the WebView drop its own last-sample copies — REQ-A1800). (REQ-A1804)
     */
    fun detach() {
        sensorManager?.unregisterListener(this)
        sensorManager = null
        attached = false
        // The listeners are gone, so the bookkeeping must go with them: a stale `true` would
        // make the next `attach()` believe a dead listener is live and skip the very
        // re-registration that brings the step counter back (REQ-A1863).
        stepCounterRegistered = false
        heartRateRegistered = false
        // Best-effort, the same shape as [pushVitalsSample]: the listeners are already
        // released, so a missing native symbol must not throw out of a lifecycle callback.
        try {
            clearSamples()
        } catch (t: Throwable) {
            Log.w("AmosGlue", "sensor clearSamples unavailable: ${t.javaClass.simpleName}")
        }
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
                    // Pair with the most recent *gyro* reading, mirroring the gyro
                    // branch below. On a device with no gyroscope no gyro event ever
                    // arrives, so `lastGyro*` are still the NaN sentinel and Rust
                    // decodes the rate as absent — it must **not** be a hardcoded
                    // zero triple, which put the measurement "not rotating" on the
                    // wire for a rate nothing measured (REQ-A1872 / F-SEN-008).
                    recordImu(
                        tsMs,
                        event.values[0], event.values[1], event.values[2],
                        lastGyroX, lastGyroY, lastGyroZ,
                        NO_DIE_TEMP_C,
                    )
                }
            }
            Sensor.TYPE_GYROSCOPE -> {
                if (event.values.size >= 3) {
                    lastGyroX = event.values[0]
                    lastGyroY = event.values[1]
                    lastGyroZ = event.values[2]
                    // Pair with the most recent accelerometer reading so every sample
                    // is a (accel, gyro) tuple; the bus keeps only the newest sample.
                    recordImu(
                        tsMs,
                        lastAccelX, lastAccelY, lastAccelZ,
                        event.values[0], event.values[1], event.values[2],
                        NO_DIE_TEMP_C,
                    )
                }
            }
            Sensor.TYPE_STEP_COUNTER -> {
                if (event.values.isNotEmpty()) {
                    lastStepsTotal = event.values[0]
                    pushVitalsSample(tsMs)
                }
            }
            Sensor.TYPE_HEART_RATE -> {
                if (event.values.isNotEmpty()) {
                    // A heart-rate sensor reports "no contact" through its accuracy,
                    // not through a zero reading. Treating that as a value would draw
                    // a real-looking 0 bpm; send NaN so the reading becomes absent.
                    val noContact = event.accuracy == SensorManager.SENSOR_STATUS_NO_CONTACT ||
                        event.accuracy == SensorManager.SENSOR_STATUS_UNRELIABLE
                    lastHeartRate = if (noContact) Float.NaN else event.values[0]
                    pushVitalsSample(tsMs)
                }
            }
        }
    }

    private var lastAccelX = 0f
    private var lastAccelY = 0f
    private var lastAccelZ = 0f

    // Mirror of the most recent gyro reading, so accel events can pair with it.
    // `NaN` means "no reading": on a device with no gyroscope (the field S5 —
    // `dumpsys sensorservice` says `geomag fusion (no gyro)`) these stay NaN
    // forever, which is exactly the "no angular rate" sentinel Rust decodes to
    // absent. They are set together — a mixed triple would not decode as the
    // sentinel (REQ-A1872 / F-SEN-008).
    private var lastGyroX = Float.NaN
    private var lastGyroY = Float.NaN
    private var lastGyroZ = Float.NaN

    // Mirror of the most recent wellness readings. `NaN` means "no reading" — the
    // wire sentinel that must reach Rust as absent, never as 0.
    private var lastStepsTotal = Float.NaN
    private var lastHeartRate = Float.NaN

    // Keep a tiny mirror of the last accel so gyro events can pair with it.
    private fun cacheAccel(x: Float, y: Float, z: Float) {
        lastAccelX = x
        lastAccelY = y
        lastAccelZ = z
    }

    /**
     * Hand the most recent wellness readings to native, pairing steps with the last
     * heart rate (and vice versa) so each push carries both. Called from the step
     * and heart-rate listeners; a push with neither reading is skipped by Rust.
     */
    private fun pushVitalsSample(tsMs: Long) {
        try {
            recordVitals(tsMs, lastStepsTotal, lastHeartRate)
        } catch (t: Throwable) {
            Log.w("AmosGlue", "sensor recordVitals unavailable: ${t.javaClass.simpleName}")
        }
    }

    // The glue reads only `TYPE_ACCELEROMETER` / `TYPE_GYROSCOPE`, and Android
    // exposes no die-temperature sensor behind either — so there is no
    // temperature to report, and this says so with the same `Float.NaN` "no
    // reading" sentinel the wellness readings below use. Rust decodes it to
    // `None` (never to a fabricated value); the die temperature is an *optional*
    // scalar, so an absent one does not cost the sample its accel/gyro.
    //
    // This was a hardcoded `25.0f`, which put a *plausible* measurement on screen
    // for a temperature nothing ever measured.
    private val NO_DIE_TEMP_C = Float.NaN

    /**
     * Hand the app `Context` to the AmOS native runtime so the System UI host can
     * build the real GNSS provider (LocationManager) for its sensor snapshot.
     * Rust: `Java_com_amos_ai_glue_SensorGlue_attachContext` (see sensor_host.rs).
     */
    external fun attachContext(context: Context)

    /**
     * JNI upcall for one wellness sample. Rust:
     * `Java_com_amos_ai_glue_SensorGlue_recordVitals` `(JFF)V`. `stepsTotal` is the
     * cumulative since-boot count (Android `TYPE_STEP_COUNTER` semantics); either
     * scalar may be `Float.NaN` to mean "no reading". Prefer [pushVitalsSample].
     */
    external fun recordVitals(tsMs: Long, stepsTotal: Float, heartRateBpm: Float)

    /**
     * JNI upcall: drop every sample this glue pushed (IMU / camera frames / vitals) from
     * the shared bus. Rust: `Java_com_amos_ai_glue_SensorGlue_clearSamples` `()V`. Called
     * from [detach]; prefer that over calling this directly.
     */
    external fun clearSamples()

    /** JNI upcall into the AmOS native runtime (see android_glue.rs). */
    external fun recordImu(
        tsMs: Long,
        ax: Float, ay: Float, az: Float,
        gx: Float, gy: Float, gz: Float,
        tempC: Float,
    )

    // ---------------------------------------------------------------------
    // Bounded upcalls (Gap 3). The producer validates *before* it crosses the
    // JNI seam: a payload that is not finite, or a frame larger than
    // [MAX_FRAME_BYTES], is dropped here with a log rather than handed to a
    // native symbol that would have to reject it. The Rust half
    // (`Java_com_amos_ai_glue_SensorGlue_nativeOnImu` / `_nativeOnCamera` in
    // sensor_host.rs) is the same ceiling a second time — defense in depth.
    // ---------------------------------------------------------------------

    /**
     * Push one already-fused IMU sample (accel + gyro, body frame) through the
     * bounded upcall [nativeOnImu]. A non-finite **axis** is refused here: a
     * `NaN` would propagate downstream and corrupt every derived orientation /
     * power window, so the whole sample is dropped (the bus keeps its previous
     * good value). The die temperature is *optional* though — `tempC` may be the
     * [NO_DIE_TEMP_C] sentinel, which must cost the sample nothing: Rust decodes
     * a non-finite scalar to `None` (see `android_glue::die_temp_c`) rather than
     * a fabricated value, and the axes are a complete measurement without it.
     * Only the six motion components gate the sample. Returns whether the sample
     * was handed to native.
     */
    fun pushImuSample(
        tsMs: Long,
        ax: Float, ay: Float, az: Float,
        gx: Float, gy: Float, gz: Float,
        tempC: Float,
    ): Boolean {
        if (!isFinite(ax) || !isFinite(ay) || !isFinite(az) ||
            !isFinite(gx) || !isFinite(gy) || !isFinite(gz)
        ) {
            Log.w("AmosGlue", "sensor IMU sample rejected: non-finite axis")
            return false
        }
        return try {
            nativeOnImu(tsMs, ax, ay, az, gx, gy, gz, tempC)
            true
        } catch (t: Throwable) {
            Log.w("AmosGlue", "sensor nativeOnImu unavailable: ${t.javaClass.simpleName}")
            false
        }
    }

    /**
     * Push one camera frame through the bounded upcall [nativeOnCamera]. The
     * payload is size-checked against [MAX_FRAME_BYTES] **before** the upcall:
     * an oversize buffer is refused with a log, never copied across the seam.
     * `format` is the native code (`0` = RGBA8, `1` = NV21). Returns whether the
     * frame was handed to native.
     */
    fun pushCameraFrame(
        cameraId: Int,
        width: Int,
        height: Int,
        format: Int,
        fps: Int,
        bytes: ByteArray,
    ): Boolean {
        if (width <= 0 || height <= 0 || fps <= 0) {
            Log.w("AmosGlue", "sensor camera frame rejected: bad dims ${width}x${height}@${fps}")
            return false
        }
        if (bytes.size > MAX_FRAME_BYTES) {
            Log.w("AmosGlue", "sensor camera frame rejected: ${bytes.size} bytes > $MAX_FRAME_BYTES")
            return false
        }
        return try {
            nativeOnCamera(cameraId, width, height, format, fps, bytes)
            true
        } catch (t: Throwable) {
            Log.w("AmosGlue", "sensor nativeOnCamera unavailable: ${t.javaClass.simpleName}")
            false
        }
    }

    private fun isFinite(v: Float): Boolean = !v.isNaN() && !v.isInfinite()

    /**
     * The single frame-size ceiling shared with Rust (`amos_sensor::sim::
     * GLUE_MAX_FRAME_BYTES` and `sensor_host::MAX_FRAME_BYTES`): a 4 MP RGBA
     * frame. Keeping the number identical on both sides of the seam means an
     * oversize frame is refused here *and* cannot slip past the native check.
     */
    private val MAX_FRAME_BYTES = 16 * 1024 * 1024

    /**
     * Bounded IMU upcall. Rust: `Java_com_amos_ai_glue_SensorGlue_nativeOnImu`
     * `(JFFFFFFFF)V`. Prefer [pushImuSample], which validates first.
     */
    external fun nativeOnImu(
        tsMs: Long,
        ax: Float, ay: Float, az: Float,
        gx: Float, gy: Float, gz: Float,
        tempC: Float,
    )

    /**
     * Bounded camera upcall. Rust: `Java_com_amos_ai_glue_SensorGlue_nativeOnCamera`
     * `(IIIII[B)V`. Prefer [pushCameraFrame], which size-checks first.
     */
    external fun nativeOnCamera(
        cameraId: Int,
        width: Int,
        height: Int,
        format: Int,
        fps: Int,
        bytes: ByteArray,
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

/**
 * The registration flag for one optional wellness sensor after one attempt.
 *
 * `attempt` is what the platform answered: `null` when it exposes no such sensor (nothing
 * was tried, so the flag cannot change), `true` when the registration was accepted, `false`
 * when it was refused — a `SecurityException` because `ACTIVITY_RECOGNITION` /
 * `BODY_SENSORS` is not held yet, or `registerListener` answering `false`.
 *
 * **Only `true` latches.** A refusal that latched is the defect this exists to prevent: the
 * grant normally arrives after the first `attach()`, and the glue's only retry is a second
 * `attach()` from `AmosGlue.onStart`. With the refusal latched there is nothing left to
 * retry, so the step counter stayed unregistered until the process restarted — the counter
 * never emitted, and the Health screen held 「—」 for steps while every permission showed as
 * granted (REQ-A1863).
 *
 * Pure and free of `SensorManager` so the rule is pinned on a host JVM: a device test could
 * only observe one device's grant timing, while the rule holds for every attempt.
 */
internal fun wellnessRegistered(previous: Boolean, attempt: Boolean?): Boolean = attempt ?: previous
