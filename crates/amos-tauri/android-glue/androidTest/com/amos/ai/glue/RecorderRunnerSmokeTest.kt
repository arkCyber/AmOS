package com.amos.ai.glue

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Smoke test: confirms the `androidx.test.runner.AndroidJUnitRunner` is correctly
 * wired to find and execute `@RunWith(AndroidJUnit4::class)` classes on the device.
 * Kept intentionally tiny — the goal is to verify the runner wiring end-to-end
 * (manifest declaration + `compileArmDebugAndroidTestKotlin` + `packageArmDebugAndroidTest`
 * + `connectedArmDebugAndroidTest`) without depending on the audio HAL or the
 * InCallService bound-state.
 *
 * If THIS test passes but the in-call instrumentation tests fail, the runner is
 * fine and the failure is on the audio side — not a missing `<instrumentation>`
 * declaration in the test manifest.
 */
@RunWith(AndroidJUnit4::class)
class RecorderRunnerSmokeTest {
    @Test
    fun theAndroidJUnitRunnerExecutesThis() {
        assertEquals(2, 1 + 1)
        assertTrue(true)
    }
}
