package com.amos.ai.glue

import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The glue's runtime-grant **request codes** must be distinct across the whole package
 * (REQ-A1625 ∕ F-AND-012).
 *
 * `MainActivity.onRequestPermissionsResult` hands the raw `requestCode` to
 * `PermissionWire.onResult`, whose `when` decides which glue the OS just answered. A code
 * claimed by two glues therefore does not run both: `when` takes the **first** matching
 * branch and the later one is dead code. That is what happened here — `SmsPermissionGlue`
 * documented `REQ_SMS` as "distinct … (never overlaps REQ_CAMERA/REQ_MEDIA/REQ_MIC/
 * REQ_LOCATION)" and `ScreenRecordGlue` listed the codes as a non-overlapping table, while
 * `REQ_SMS` and `LocationPermissionGlue.REQ_LOCATION` were **both `9005`**. The location
 * branch comes first, so `SmsPermissionGlue.onSmsResult()` was unreachable: an SMS grant
 * resolved the *location* glue and the pending `sms_permission_request` await never settled.
 *
 * The Kotlin compiler only *warns* about this (`Duplicate label in when`), and only when
 * both constants sit in one `when` — a warning is a weak contract for a number two files
 * have to agree on. `scripts/android-glue-nv21-check.sh` turns our glue's warnings into
 * errors, and that is how this was found; this test makes it a hard failure that also runs
 * in the APK's own test task.
 *
 * Scope: only the codes the glue exposes publicly can be named here (a `private const val`
 * is invisible across objects). The private ones — `PermissionWire.REQ_CAMERA` (9001) /
 * `REQ_MEDIA` (9003), `AmosGlue.REQ_SENSORS` (5001), `TelephonyGlue.REQ_CALL` (7001) — are
 * the compiler's duplicate-label diagnostic's job, and under the harness that is an error.
 * The three `900x` camera/media codes are listed here as values so that a *new* glue taking
 * one of them collides against this table rather than silently beside it.
 */
class RequestCodeTest {

    @Test
    fun everyGlueRequestCodeIsDistinct() {
        // `PermissionWire`'s two codes are private (the Activity reaches them through
        // `PermissionWire` itself), so they are spelled here as the values the harness's
        // warning gate would otherwise be the only thing holding.
        val codes = listOf(
            "PermissionWire.REQ_CAMERA" to 9001,
            "PermissionWire.REQ_MEDIA" to 9003,
            "MicPermissionGlue.REQ_MIC" to MicPermissionGlue.REQ_MIC,
            "LocationPermissionGlue.REQ_LOCATION" to LocationPermissionGlue.REQ_LOCATION,
            "SmsPermissionGlue.REQ_SMS" to SmsPermissionGlue.REQ_SMS,
            "ScreenRecordGlue.REQ_SCREEN_RECORD" to ScreenRecordGlue.REQ_SCREEN_RECORD,
            "TelephonyGlue.REQ_DIALER_ROLE" to TelephonyGlue.REQ_DIALER_ROLE,
            // The `onActivityResult` codes share that one method too, so they are held to
            // the same distinctness as the permission codes.
            "BlocklistGlue.ROLE_REQUEST_CODE" to BlocklistGlue.ROLE_REQUEST_CODE,
        )

        val seen = mutableMapOf<Int, String>()
        for ((name, code) in codes) {
            val prior = seen.put(code, name)
            assertNull(
                "request code $code is claimed by both $prior and $name — the Activity's " +
                    "`when` dispatches on this number, so whichever comes second never runs",
                prior,
            )
        }
    }
}
