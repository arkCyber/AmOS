package com.amos.ai.glue

import com.amos.ai.glue.AmosInCallService.Companion.RecordingContract
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Host-JVM tests for the in-call recording **pure** half (`AmosInCallService.RecordingContract`).
 *
 * Honest scope: this exercises only the parts the Kotlin side owns that **do not need**
 * a `Context` or a `MediaRecorder`. The device-touching portion (`beginRecording` /
 * `finishRecording` / `abortRecording`) cannot run on a host JVM — it is pinned instead
 * by `AmosInCallRecordingInstrumentationTest.kt` and by the `setRecording`-words-follow-action
 * source pin in `crates/amos-tauri/src/incall.rs`.
 *
 * What this file guarantees:
 *  * the wire envelope (`<id>|<startedAtMs>|<source>`) is the one Rust's `parse_recording_report`
 *    parses — a drift on either side shows up in this test and in the Rust test at the same time;
 *  * the audio-source word list is the allowlist Rust's `RECORDING_SOURCES` consults;
 *  * the `<filesDir>/recordings/<id>.m4a` path convention matches the live `recording::app_data_root`
 *    contract (`join("files")` on Android);
 *  * the region-blind emergency guard in the device companion returns the same answer on
 *    both the pure-form and the companion-form callsites.
 *
 * Run: `scripts/android-glue-nv21-check.sh` (the same harness
 * `ScreenRecordGlueTest` / `Nv21PackerTest` use; mirrors the glue and runs `armDebugUnitTest`).
 */
class RecordingContractTest {

    @get:Rule
    val tmp: TemporaryFolder = TemporaryFolder()

    // ─── id minting ──────────────────────────────────────────────────────────────

    /** Two ids minted at different wall-clock times are distinct — the ledger de-duplicates
     *  by `call_id`, so a clock that stayed still would collapse two calls into one row. */
    @Test
    fun twoIdsAreDistinctWhenTimesDiffer() {
        val a = RecordingContract.newRecordingId(1_700_000_000_000L)
        val b = RecordingContract.newRecordingId(1_700_000_001_000L)
        assertNotNull(a); assertNotNull(b)
        assertTrue("ids minted at different times must differ: a=$a b=$b", a != b)
    }

    /** The id shape is `<prefix>-<unix_ms>` — the prefix is `"real-"`, the rest is decimal
     *  base 10. So a Rust `parse_recording_report` whose split is `split('|')` will pull the
     *  prefix off as the id verbatim and never see a non-ascii or empty field. */
    @Test
    fun theIdShapeIsPrefixAndDecimalUnixMillis() {
        val id = RecordingContract.newRecordingId(1_700_000_000_000L)
        assertTrue("id must start with `real-`: $id", id.startsWith("real-"))
        val tail = id.removePrefix("real-")
        // Decimal digits only — Rust's `parse::<i64>` would otherwise fail.
        assertTrue("id tail must be decimal: $tail", tail.toLongOrNull() != null)
        assertEquals(1_700_000_000_000L, tail.toLong())
    }

    /** Two ids minted at the same millisecond are still equal — the ledger's dedup rule
     *  will collapse them into one row, and that is what we want for a single recording
     *  crashed-and-restarted within one ms (a benign race, not the multi-call case). */
    @Test
    fun idsFromTheSameMillisecondCollapse() {
        val a = RecordingContract.newRecordingId(1_700_000_000_000L)
        val b = RecordingContract.newRecordingId(1_700_000_000_000L)
        assertEquals(a, b)
    }

    // ─── report envelope ────────────────────────────────────────────────────────

    /** The wire contract (REQ-A1579): three `|`-delimited fields, no extras. Rust
     *  `parse_recording_report` rejects anything with extra fields, so a `|` somewhere in
     *  the recording id would corrupt the parse. The `require` inside `buildReport`
     *  prevents an empty id, but cannot prevent a `|` inside the id (the caller could
     *  in principle pass one) — this pins the test's assumption that the *current*
     *  caller mints safe ids via [RecordingContract.newRecordingId]. */
    @Test
    fun theReportHasExactlyThreeFields() {
        val r = RecordingContract.buildReport("real-1700000000000", 1_700_000_000_000L,
            RecordingContract.SOURCE_VOICE_COMMUNICATION)
        val parts: List<String> = r.split(RecordingContract.REPORT_DELIMITER)
        assertEquals(
            "report must split into exactly three fields: $r",
            3, parts.size,
        )
        // Kotlin/JUnit 4 has no `(expected, actual, message)` overload — use `(message, expected, actual)`
        val expected: List<String> = listOf("real-1700000000000", "1700000000000",
            RecordingContract.SOURCE_VOICE_COMMUNICATION)
        assertEquals("report fields differ", expected, parts)
    }

    /** Both audio source words serialise as themselves — and an unknown one is refused
     *  (`require` in `buildReport`). The Rust side's allowlist (`RECORDING_SOURCES`) does the
     *  same refusal on the receiving end; this is the producer-side mirror. */
    @Test
    fun onlyAllowedSourcesAreAccepted() {
        for (src in RecordingContract.ALLOWED_SOURCES) {
            val r = RecordingContract.buildReport("real-1", 1L, src)
            // The round-trip is the same string.
            assertTrue("allowed source must survive build: $r", r.endsWith(src))
        }
        try {
            RecordingContract.buildReport("real-1", 1L, "voice_unknown")
            fail("an unknown source must be refused, not passed through")
        } catch (e: IllegalArgumentException) {
            // the message names the allowed set so an operator can see what is expected
            assertTrue(e.message!!.contains("voice_call"))
            assertTrue(e.message!!.contains("voice_communication"))
        }
    }

    /** An empty id is refused — Rust's `parse_recording_report` would refuse it too, but
     *  refusing here means the failure message names the *producer* (this call), not the
     *  consumer, so a future bug is local. */
    @Test
    fun anEmptyIdIsRefusedAtBuildTime() {
        try {
            RecordingContract.buildReport("", 1L, RecordingContract.SOURCE_VOICE_CALL)
            fail("an empty id must be refused")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("id must not be empty"))
        }
    }

    /** A negative start time is refused at build time (Rust's parser refuses it too, with
     *  the same `started_at_ms < 0` check). */
    @Test
    fun aNegativeStartIsRefusedAtBuildTime() {
        try {
            RecordingContract.buildReport("real-1", -1L, RecordingContract.SOURCE_VOICE_CALL)
            fail("a negative start must be refused")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("start must not be negative"))
        }
    }

    // ─── source integer → wire word ─────────────────────────────────────────────

    /** The `MediaRecorder.AudioSource.VOICE_CALL` integer must serialise to the wire word
     *  `"voice_call"` — anything else is an unreachable intent (the device either gets the
     *  privileged permission or falls back). The default-arm lands on `voice_communication`,
     *  *not* an empty string, because empty source would refuse Rust's parse. */
    @Test
    fun theVoiceCallIntegerMapsToItsOwnWireWord() {
        // VOICE_CALL = 4 in android.media.MediaRecorder.AudioSource (public constant
        // available on all supported API levels). The test asserts the integer explicitly so
        // a future SDK rename that moved the constant surfaces visibly here.
        val voiceCall = 4 // android.media.MediaRecorder.AudioSource.VOICE_CALL
        assertEquals(RecordingContract.SOURCE_VOICE_CALL,
            RecordingContract.audioSourceName(voiceCall))
    }

    /** Anything that is not VOICE_CALL falls through to VOICE_COMMUNICATION — the doc
     *  contract says we never open a recorder on a source other than these two. */
    @Test
    fun anyOtherAudioSourceIntegerMapsToVoiceCommunication() {
        val others: Array<Int> = arrayOf(0, 1, 2, 3, 5, 6, 7, 100)
        for (src in others) {
            assertEquals("src=$src must fall back to voice_communication",
                RecordingContract.SOURCE_VOICE_COMMUNICATION,
                RecordingContract.audioSourceName(src))
        }
    }

    // ─── the two allowed source words are exactly two (Rust `RECORDING_SOURCES`) ─

    /** This is the same allowlist Rust has in `crates/amos-tauri/src/incall.rs`:
     *  `const RECORDING_SOURCES: [&str; 2] = ["voice_call", "voice_communication"];`
     *  Drift here is *double* red: the Kotlin-side test fails **and** the Rust-side
     *  `parse_recording_report`-related pin cannot file the row. */
    @Test
    fun theAllowedSourcesAreExactlyTheTwoRustKnows() {
        assertEquals(
            setOf("voice_call", "voice_communication").toList().sorted(),
            RecordingContract.ALLOWED_SOURCES.toList().sorted(),
        )
        assertEquals(2, RecordingContract.ALLOWED_SOURCES.size)
    }

    // ─── file naming + path convention ─────────────────────────────────────────

    /** The file name a recording lands on. The Rust side reads it back via
     *  `recording::recording_path(data, id)` which assembles `<app_data>/recordings/<id>.m4a`,
     *  and the `join("files")` Android dir convention makes those two roots the same
     *  directory. The suffix must match exactly — `.m4a` not `.mp4` or `.aac`. */
    @Test
    fun theRecordingFileIsAnM4aWithTheIdAsStem() {
        assertEquals("real-1700000000000.m4a", RecordingContract.fileName("real-1700000000000"))
        assertEquals("real-1.m4a", RecordingContract.fileName("real-1"))
    }

    /** The `recordingsRoot(filesDir)` helper creates the directory if it is missing and
     *  places it directly under the supplied `filesDir` (the live service's own `filesDir`),
     *  not under `dataDir` — and that **is** the cross-language half of the contract: Rust
     *  joins `"files"` onto its `app_data_dir()` on Android (`recording.rs::app_data_root`)
     *  so the two resolve to the same directory. A drift (e.g. passing `dataDir` here) would
     *  leave audio where no ledger row ever points. */
    @Test
    fun recordingsRootSitsAtFilesDirRecordingsNotDataDirRecordings() {
        val filesDir = tmp.newFolder("fake-files")
        val root = RecordingContract.recordingsRoot(filesDir)

        assertTrue("recordings root must exist after the call", root.exists())
        assertTrue(root.isDirectory)
        // The root sits directly under `filesDir`, **not** a sibling: cross-language contract.
        assertEquals(File(filesDir, "recordings"), root)

        // Calling it again is idempotent.
        val again = RecordingContract.recordingsRoot(filesDir)
        assertEquals(root, again)
        assertTrue(again.exists())
    }

    // ─── emergency guard: region-blind, digits-only ─────────────────────────────

    /** The region-blind emergency list — pinned on the Rust side by
     *  `the_host_copy_recognizes_every_canonical_emergency_code`. A drift here is red
     *  on both ends: the Kotlin side refuses a non-emergency, the Rust side refuses the
     *  same word (by way of `EmergencyMap::for_region` which is a superset). */
    @Test
    fun isEmergencyAcceptsExactlyTheCanonicalList() {
        val cases: Map<String?, Boolean> = mapOf(
            // True for every canonical emergency word — keep this list in lockstep with
            // `EmergencyMap::common_global` and the comments on `is_emergency`.
            "110" to true,  // Mainland China police
            "112" to true,  // Mainland China unified emergency
            "119" to true,  // Mainland China fire
            "120" to true,  // Mainland China ambulance
            "122" to true,  // Mainland China traffic
            "911" to true,  // North America / international
            "999" to true,  // UK / HK
            "000" to true,  // Australia
            "118" to true,  // Japan coast guard
            "108" to true,  // India
            // `tel:` URI scheme — Android's `Call.Details.handle` may carry the raw
            // `tel:`-prefixed form; the digits-extraction rule below handles both.
            "tel:110" to true,
            "tel:911" to true,
            // Non-emergency numbers.
            "10086" to false,  // China Mobile service line
            "+8613800138000" to false,
            "13800138000" to false,
            "86110" to false,  // the *prefix* +86 stripped — never an emergency on its own
            // Junk / empty.
            "" to false,
            null to false,
        )
        for ((input, expected) in cases) {
            assertEquals("peer=$input", expected, RecordingContract.isEmergency(input))
        }
    }

    /** Digits are extracted from non-numeric noise (`tel:`, but NOT the `+86` country-code
     *  prefix — `Details.handle.schemeSpecificPart` carries just the national portion).
     *  The pure-form predicate considers only the digit-only tail — that is also the
     *  cross-language half of the contract: the Rust `is_emergency` (in `amos-telephony`)
     *  uses the same digit-extraction rule. */
    @Test
    fun isEmergencyExtractsDigitsFromNonNumericNoise() {
        assertTrue("tel:110 must be classified as emergency",
            RecordingContract.isEmergency("tel:110"))
        assertFalse("13800138000 must not be an emergency",
            RecordingContract.isEmergency("13800138000"))
        assertFalse("+8613800138000 must not be an emergency",
            RecordingContract.isEmergency("+8613800138000"))
        // `+86 110` would resolve as digits `86110` (no country-code stripping), so
        // it does NOT match the bare `110`. The Rust `EmergencyMap` carries the same
        // rule — a `+86 110` is a plain Chinese national call routed through the
        // ordinary SIM path.
        assertFalse("a +86-prefixed emergency is a national call, not an emergency",
            RecordingContract.isEmergency("+86110"))
    }

    /** The pure-form `RecordingContract.isEmergency` and the companion-internal
     *  `is_emergency` MUST return the same answer for every input. The companion's private
     *  `is_emergency` is a one-line delegate to the contract form (so a future fix in
     *  one place cannot leave the other behind), but this test pins the agreement. */
    @Test
    fun the_recording_emergency_guard_matches_the_companion_form() {
        // Reach the private companion form via reflection (it is `private` on purpose —
        // the only *intended* caller is `setRecording` in the same companion; this test
        // pins the contract).
        val m = AmosInCallService.Companion::class.java.getDeclaredMethod(
            "is_emergency", String::class.java
        ).apply { isAccessible = true }
        val companionForm = { peer: String? -> m.invoke(AmosInCallService, peer) as Boolean }

        val cases = listOf(
            "110", "112", "911", "119", "120", "122", "999", "000", "118", "108",
            "10086", "+86110", "tel:110", "+8613800138000", "13800138000", "", null,
        )
        for (peer in cases) {
            assertEquals(
                "guard mismatch for peer=$peer",
                RecordingContract.isEmergency(peer),
                companionForm(peer),
            )
        }
    }
}
