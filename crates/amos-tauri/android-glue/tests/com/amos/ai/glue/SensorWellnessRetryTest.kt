package com.amos.ai.glue

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-JVM tests for the wellness-registration **rule** (REQ-A1863).
 *
 * `SensorGlue.registerWellness` needs a real `SensorManager` and a real runtime grant, so it
 * cannot run here — what *can* be pinned is the rule its two flags obey, which `attach()`
 * consults on every call: **only an accepted registration latches**. A refusal (the
 * `ACTIVITY_RECOGNITION` / `BODY_SENSORS` grant is not held yet, so `registerListener` throws
 * `SecurityException` — or answers `false`) must leave the flag clear, because the glue's only
 * retry is a *second* `attach()` from `AmosGlue.onStart` once the user taps Allow.
 *
 * The claim is not hypothetical: on a S5 / Android 14 the same process logged no
 * `STEP_COUNTER (0x13)` registration while the grant was pending, and **still none after it was
 * granted**; a fresh process, with the grant held at boot, registered 0x13 immediately. That is
 * the device half — the red-first wiring assertion (`attach()` neither short-circuits on
 * `attached` nor hides the attempt, and `detach()` clears both flags) lives in
 * `sensor_host::tests::the_glue_retries_its_wellness_registration_on_a_later_attach`, which
 * reads this file's source.
 *
 * Run: `make android-glue-check` (mirrors the glue and runs this source set on the host JVM,
 * the same harness `Nv21PackerTest` / `ScreenRecordGlueTest` use).
 */
class SensorWellnessRetryTest {

    @Test
    fun aRefusedRegistrationDoesNotLatch() {
        // The defect: `attach()` used to set `attached = true` whatever the wellness
        // registration did, so the refusal was indistinguishable from success and the
        // post-grant `attach()` skipped the retry.
        assertFalse(
            "a refusal (grant not held yet) must not latch, or the next attach has no retry to make",
            wellnessRegistered(previous = false, attempt = false),
        )
    }

    @Test
    fun anAcceptedRegistrationLatches() {
        // Positive control: without this, "never latch" would pass every test here and the
        // glue would re-register the listener on every attach forever.
        assertTrue(wellnessRegistered(previous = false, attempt = true))
        assertTrue("re-registering an already-live listener is still registered", wellnessRegistered(previous = true, attempt = true))
    }

    @Test
    fun aSensorThePlatformDoesNotExposeChangesNothing() {
        // `null` is "no such sensor", not "refused": nothing was attempted, so the flag must
        // survive untouched — a device with no step counter must not have its heart-rate
        // bookkeeping disturbed by the step-counter attempt, and vice versa.
        assertTrue(wellnessRegistered(previous = true, attempt = null))
        assertFalse(wellnessRegistered(previous = false, attempt = null))
    }

    @Test
    fun aWithdrawnGrantIsRetriedOnTheNextAttach() {
        // A permission revoked while the app is backgrounded arrives as another refusal on the
        // next attach; the flag must follow reality in *both* directions.
        assertFalse(wellnessRegistered(previous = true, attempt = false))
    }

    @Test
    fun theDeviceSequenceEndsRegistered() {
        // The exact sequence the device showed: attach with the grant still pending (refused),
        // then the post-grant attach. The second attempt is what must win.
        val firstAttach = wellnessRegistered(previous = false, attempt = false)
        assertTrue(
            "after the user grants the permission, the retry must register the step counter",
            wellnessRegistered(previous = firstAttach, attempt = true),
        )
    }
}
