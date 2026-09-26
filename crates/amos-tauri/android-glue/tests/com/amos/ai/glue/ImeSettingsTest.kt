package com.amos.ai.glue

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-JVM tests for the system-IME entry point's wire (REQ-A1904, F-AND-022).
 *
 * The Android half ([ImeSettingsGlue]) reads `InputMethodManager` and cannot run on a
 * host JVM; the *wire* it writes can, and the Rust reader
 * (`crates/amos-tauri/src/ime.rs::parse_platform_ime_facts`) is the authority on the
 * other side. So the contract is pinned from both ends, like `ImeWireTest`: the exact
 * bytes asserted here are the ones the Rust test parses.
 *
 * The load-bearing cases are the two failure ones. A read that did not reach the
 * platform must write **no fact lines** — if `unavailable` came out with
 * `ours_enabled\t0`, the Rust reader would report the platform's sentence "not enabled"
 * for a question nobody answered (the `nfc_status` family, REQ-A775 / F-AND-007), and a
 * tab or newline inside an exception message would decode as a fact the platform never
 * stated.
 *
 * Run: `scripts/android-glue-nv21-check.sh` (mirrors the glue and runs this source set
 * on the host JVM), like `ImeWireTest`.
 */
class ImeSettingsTest {

    /** The exact bytes `ime.rs::parse_platform_ime_facts` is pinned against — ours enabled *and* selected. */
    private val selectedAnswer =
        "state\tok\n" +
            "current\tcom.amos.ai/.glue.AmosImeService\n" +
            "ours_enabled\t1\n" +
            "ours_selected\t1\n"

    @Test
    fun aSuccessfulReadWritesEveryFactLine() {
        val wire =
            ImeSettings.ok(
                currentId = "com.amos.ai/.glue.AmosImeService",
                oursEnabled = true,
                oursSelected = true,
            )
        assertEquals(selectedAnswer, wire)
    }

    /** Enabled but not in force — the ordinary state for a user who enabled it and stayed on Gboard. */
    @Test
    fun aSuccessfulReadReportsEnabledAndSelectedSeparately() {
        val wire =
            ImeSettings.ok(
                currentId = "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME",
                oursEnabled = true,
                oursSelected = false,
            )
        assertTrue(wire.contains("ours_enabled\t1\n"))
        assertTrue(wire.contains("ours_selected\t0\n"))
        assertTrue(wire.contains("current\tcom.google.android.inputmethod.latin/"))
    }

    /**
     * "No keyboard is selected" is a measurement, not a missing answer: `current` is
     * written even when it is empty, so the reader can tell it apart from `unavailable`.
     */
    @Test
    fun anEmptyCurrentIdIsStillAWrittenFact() {
        val wire = ImeSettings.ok(currentId = "", oursEnabled = false, oursSelected = false)
        assertEquals("state\tok\ncurrent\t\nours_enabled\t0\nours_selected\t0\n", wire)
    }

    @Test
    fun anUnansweredReadWritesNoFactLines() {
        val wire = ImeSettings.unavailable("SecurityException: no access")
        assertEquals("state\tunavailable\nwhy\tSecurityException: no access\n", wire)
        assertEquals(listOf("state", "why"), wire.records().map { it.substringBefore('\t') })
    }

    /**
     * An exception message is arbitrary text. A newline in it would end the record and
     * the rest would decode as **another record** — `why\tboom\nours_enabled\t1` claims
     * the keyboard is enabled. So the assertion is at record level, not on the substring:
     * the words may appear (they are inside `why`), but they may not *be* a record.
     */
    @Test
    fun aMultiLineReasonCannotForgeAFactLine() {
        val wire = ImeSettings.unavailable("boom\nours_enabled\t1\ttabhere")
        assertEquals(listOf("state", "why"), wire.records().map { it.substringBefore('\t') })
        assertTrue("the whole message stays on the why line", wire.records()[1].contains("boom"))
        assertTrue(wire.endsWith("\n"))
    }

    /** The records of a wire, in order — the unit a forgered line would have to join. */
    private fun String.records() = split("\n").filter { it.isNotEmpty() }
}
