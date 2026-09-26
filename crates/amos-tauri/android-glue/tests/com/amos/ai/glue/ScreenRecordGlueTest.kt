package com.amos.ai.glue

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-JVM tests for the screen-capture glue's **pure** half (F-DEV-141).
 *
 * Everything else in `ScreenRecordGlue` needs a device — a `MediaProjection`, a real
 * display, a user approving a system dialog. What *can* be pinned on a host JVM is the
 * part the other side of the JNI boundary also computes: the destination file's name and
 * the duration rule.
 *
 * Those two are exactly where the two sides can drift — `screen_record.rs` has its own
 * `filename_from_parts` and its own duration rule — so this test pins the glue's **own**
 * behaviour, and the cross-language halves are pinned by tests that read the authority:
 * `ScreenRecordGlue.kt`'s constants name `MIN_RECORD_SECS`/`MAX_RECORD_SECS` and
 * `screen_record_android::the_glues_duration_bound_is_the_hosts_bound` reads this glue's
 * source. This test alone cannot see the Rust side, and does not claim to.
 *
 * Run: `scripts/android-glue-nv21-check.sh` mirrors the glue and runs this source set on
 * the host JVM (the same harness `Nv21PackerTest`/`AlarmIdentityTest` use).
 */
class ScreenRecordGlueTest {

    @Test
    fun theFileNameMatchesTheMacosRecordingShapeWithAnMp4Suffix() {
        // 2026-09-20T14:03:05Z is not asserted as a wall-clock value (the host's timezone
        // decides it); the *shape* is, because that is what the two platforms must agree on.
        val name = ScreenRecordGlue.fileName(1_789_891_385_000L)
        assertTrue("expected the `Screen Recording …` prefix, got $name", name.startsWith("Screen Recording "))
        assertTrue("expected a `.mp4` suffix, got $name", name.endsWith(".mp4"))
        val rest = name.removePrefix("Screen Recording ").removeSuffix(".mp4")
        val (date, time) = rest.split(" at ").let { it[0] to it[1] }
        assertEquals("YYYY-MM-DD", 10, date.length)
        assertEquals("HH.MM.SS", 8, time.length)
        assertEquals(2, date.count { it == '-' })
        assertEquals(2, time.count { it == '.' })
    }

    @Test
    fun twoInstantsInDifferentSecondsNeverShareAName() {
        // The collision rule the host also applies (it probes the directory): a name that
        // ignored the seconds would make two recordings in one minute indistinguishable.
        assertTrue(ScreenRecordGlue.fileName(1_789_891_385_000L) != ScreenRecordGlue.fileName(1_789_891_386_000L))
    }

    @Test
    fun anOutOfRangeDurationIsRefusedNotReplaced() {
        // The glue applies the **host's** rule — the authority is `screen_record`'s
        // `MIN_RECORD_SECS` / `MAX_RECORD_SECS` as resolved by `resolve_max_secs`, and the
        // cross-check that these constants restate that pair lives on the Rust side
        // (`screen_record_android::the_glues_duration_bound_is_the_hosts_bound`, which reads
        // this file). What this test pins is the rule itself, and the one thing it must not
        // do: **replace** a request with a length nobody asked for. The previous shape
        // answered a fabricated 60s for a non-positive request, and such a file is
        // indistinguishable from one that was requested.
        assertEquals(1, ScreenRecordGlue.MIN_CAPTURE_SECS)
        assertEquals(1800, ScreenRecordGlue.MAX_CAPTURE_SECS)

        // Out of range on both sides → refused, never rounded to a boundary.
        assertFalse("0 must not become a length", ScreenRecordGlue.isDurationInRange(0))
        assertFalse("-5 must not become a length", ScreenRecordGlue.isDurationInRange(-5))
        assertFalse(
            "one second past the ceiling must not be shortened",
            ScreenRecordGlue.isDurationInRange(30 * 60 + 1),
        )
        assertFalse(
            "an absurd bound must not be shortened",
            ScreenRecordGlue.isDurationInRange(Int.MAX_VALUE),
        )

        // A closed interval: both boundaries are legal requests, so a UI's "30 minutes"
        // option is not turned back by an off-by-one.
        assertTrue(ScreenRecordGlue.isDurationInRange(1))
        assertTrue(ScreenRecordGlue.isDurationInRange(1800))
        assertTrue(ScreenRecordGlue.isDurationInRange(12))
    }

    @Test
    fun anUnmeasuredSizeIsAbsentNotZero() {
        // The glue measures the sealed file so the host's stop can confirm it (the Android
        // half of macOS's `confirm_written`). What this test pins is the **distinction** the
        // JSON has to carry: `0` is a measurement ("the recorder wrote an empty file") and is
        // exactly what the host refuses as an empty capture, while no measurement at all is
        // an *absent* field, refused as "nobody could measure this". Folding the two would
        // report a capture that produced no frames as one this host simply could not see.
        assertEquals(ScreenRecordGlue.UNMEASURED_BYTES, -1L)
        assertTrue("an unmeasured size must be absent, never 0", ScreenRecordGlue.bytesField(ScreenRecordGlue.UNMEASURED_BYTES) == null)
        assertEquals(
            "a measured empty file must survive as 0",
            0L,
            ScreenRecordGlue.bytesField(0L),
        )
        assertEquals(262_144L, ScreenRecordGlue.bytesField(262_144L))
    }

    @Test
    fun theStatusWordsTheHostDispatchesOnAreDistinct() {
        // Rust matches these spellings by name; duplicates would collapse two outcomes
        // ("already recording" vs "declined") into one answer at the host.
        val words = listOf(
            ScreenRecordGlue.STATUS_REQUESTED,
            ScreenRecordGlue.STATUS_RECORDING,
            ScreenRecordGlue.STATUS_UNAVAILABLE,
            ScreenRecordGlue.STATUS_DENIED,
            ScreenRecordGlue.STATUS_ALREADY,
            ScreenRecordGlue.STATUS_UNSUPPORTED,
            ScreenRecordGlue.STATUS_STOPPED,
        )
        assertEquals(words.size, words.toSet().size)
    }
}
