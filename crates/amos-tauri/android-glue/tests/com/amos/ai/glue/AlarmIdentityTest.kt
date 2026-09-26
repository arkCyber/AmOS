package com.amos.ai.glue

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-JVM tests for the alarm **identity** rule (REQ-A373, F-TAU-011).
 *
 * `PendingIntent` equality ignores intent extras, so when the request code
 * (`REQUEST_BASE + id.hashCode()`) was the only discriminator, two alarms whose ids merely
 * *hash* alike were the **same** pending alarm: arming the second silently replaced the first's id
 * extra and cancelling either cancelled both — the wrong alarm rings, or a real one stops ringing.
 * [AlarmGlue.alarmIdentity] (the per-id data URI that `AlarmGlue.pending` now sets) is what keeps
 * them apart, and it is pure string work, so it can be pinned here — no Android types, no device.
 *
 * Run: `scripts/android-glue-nv21-check.sh` (mirrors the glue and runs this source set on the host
 * JVM), like `Nv21PackerTest`.
 */
class AlarmIdentityTest {

    /** The textbook Java `String.hashCode` collision: both `"Aa"` and `"BB"` hash to 2112. */
    private val colliding = listOf("Aa", "BB")

    @Test
    fun collidingHashCodesStillGetDistinctIdentities() {
        // The premise, measured here rather than assumed: if this ever stops holding, the test
        // below would pass for the wrong reason.
        assertEquals(colliding[0].hashCode().toLong(), colliding[1].hashCode().toLong())
        assertNotEquals(
            "ids that hash alike must not share a PendingIntent identity",
            AlarmGlue.alarmIdentity(colliding[0]),
            AlarmGlue.alarmIdentity(colliding[1]),
        )
    }

    @Test
    fun theIdentityIsStablePerId() {
        assertEquals(AlarmGlue.alarmIdentity("alarm:abc"), AlarmGlue.alarmIdentity("alarm:abc"))
        assertNotEquals(AlarmGlue.alarmIdentity("alarm:abc"), AlarmGlue.alarmIdentity("alarm:abd"))
    }

    @Test
    fun theIdentityIsAWellFormedUriCarryingTheId() {
        val uri = AlarmGlue.alarmIdentity("alarm:2026-09-17T07:30")
        assertTrue("expected a scheme-prefixed URI, got $uri", uri.startsWith("amos-alarm://"))
        assertTrue("the id must appear in the URI: $uri", uri.contains("2026-09-17T07:30"))
    }

    /**
     * REQ-A1447 / F-TAU-025 — the SAME collision, one layer over.
     *
     * The firing notification's identity is its **(tag, id)** pair, and the previous code used
     * a constant tag with `requestCode(id)` as the id — the exact `String.hashCode` discriminator
     * [alarmIdentity] exists to replace. Two hash-colliding alarms therefore posted under one
     * identity, and the second silently replaced the first's ring. `notifyTag` carries the full
     * id, so distinctness is structural; this pins it (and re-measures the collision premise).
     */
    @Test
    fun collidingHashCodesStillGetDistinctNotificationTags() {
        assertEquals(colliding[0].hashCode().toLong(), colliding[1].hashCode().toLong())
        assertNotEquals(
            "ids that hash alike must not share a notification identity",
            AlarmGlue.notifyTag(colliding[0]),
            AlarmGlue.notifyTag(colliding[1]),
        )
    }

    @Test
    fun theNotificationTagIsStablePerIdAndCarriesTheId() {
        assertEquals(AlarmGlue.notifyTag("alarm:abc"), AlarmGlue.notifyTag("alarm:abc"))
        assertNotEquals(AlarmGlue.notifyTag("alarm:abc"), AlarmGlue.notifyTag("alarm:abd"))
        assertTrue(
            "the id must appear in the tag: ${AlarmGlue.notifyTag("alarm:abc")}",
            AlarmGlue.notifyTag("alarm:abc").contains("alarm:abc"),
        )
    }
}
