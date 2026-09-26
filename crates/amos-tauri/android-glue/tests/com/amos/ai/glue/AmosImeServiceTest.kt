package com.amos.ai.glue

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-JVM tests for [forgetChipVisible] (REQ-A1896, F-DEV-162).
 *
 * The 「忘记「X」」 chip is the service's only undo affordance. It must be shown for
 * **exactly** the state the wire calls an undoable pick: a non-empty `undo` code. The
 * bug this pins was a gate that *also* required a non-empty candidate list — but a
 * freshly learned dictionary word is precisely the commit that leaves no 联想
 * (`amos-ime`'s `predictions` says nothing until two words were committed), so the chip
 * vanished at the one moment the user needed it.
 *
 * `null` and `""` both mean "nothing to forget" (a missing answer / a sentence or
 * suggestion pick): the service must not draw a button that does nothing.
 *
 * Run: `scripts/android-glue-nv21-check.sh`.
 */
class AmosImeServiceTest {

    @Test
    fun `a non-empty undo code shows the chip`() {
        assertTrue(forgetChipVisible("zhongguo"))
    }

    @Test
    fun `an empty undo code hides the chip`() {
        assertFalse(forgetChipVisible(""))
    }

    @Test
    fun `a missing undo code hides the chip`() {
        assertFalse(forgetChipVisible(null))
    }
}
