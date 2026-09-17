package com.amos.ai.glue

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Host-JVM tests for the alarm **firing** decision (REQ-A375, F-TAU-012).
 *
 * A full-screen-intent notification is what can put the ring in front of the user while the app is
 * in the background, and its failure mode is *silent* — so the gate in front of it is pinned here:
 * no service ⇒ unavailable; API 33+ without the runtime grant ⇒ denied (that is the **default**
 * for a fresh install); the user's own toggle off ⇒ denied; otherwise posted. Below API 33 the
 * runtime permission does not exist, so only the toggle decides.
 *
 * Run: `scripts/android-glue-nv21-check.sh` — no Android types, no device.
 */
class AlarmNotifyStatusTest {

    @Test
    fun aMissingNotificationServiceIsUnavailable() {
        assertEquals(AlarmGlue.NOTIFY_UNAVAILABLE, AlarmGlue.notifyStatus(34, servicePresent = false, enabled = true, granted = true))
    }

    @Test
    fun api33NeedsTheRuntimeGrantEvenWhenTheToggleIsOn() {
        // The default for a fresh install: notifications enabled but the permission not granted.
        assertEquals(AlarmGlue.NOTIFY_DENIED, AlarmGlue.notifyStatus(34, servicePresent = true, enabled = true, granted = false))
    }

    @Test
    fun theUsersOwnToggleOffIsDenied() {
        assertEquals(AlarmGlue.NOTIFY_DENIED, AlarmGlue.notifyStatus(34, servicePresent = true, enabled = false, granted = true))
        assertEquals(AlarmGlue.NOTIFY_DENIED, AlarmGlue.notifyStatus(30, servicePresent = true, enabled = false, granted = false))
    }

    @Test
    fun belowApi33TheRuntimePermissionDoesNotExist() {
        // API 30: `granted` is irrelevant (there is no such permission) — only the toggle decides.
        assertEquals(AlarmGlue.NOTIFY_POSTED, AlarmGlue.notifyStatus(30, servicePresent = true, enabled = true, granted = false))
    }

    @Test
    fun everythingInPlacePosts() {
        assertEquals(AlarmGlue.NOTIFY_POSTED, AlarmGlue.notifyStatus(34, servicePresent = true, enabled = true, granted = true))
    }
}
