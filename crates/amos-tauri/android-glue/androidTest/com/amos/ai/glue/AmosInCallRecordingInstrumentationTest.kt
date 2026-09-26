package com.amos.ai.glue

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.amos.ai.glue.AmosInCallService.Companion.RecordingContract
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.File

/**
 * Device-instrumentation test for the **real** in-call recording path
 * (`crates/amos-tauri/android-glue/.../AmosInCallService.kt`, REQ-A1579 / F-TEL-038).
 *
 * Host-JVM coverage (`RecordingContractTest`) pins the *pure* half (id minting, report
 * envelope, source-from-permission mapping, file-name shape). What this file pins is the
 * *device half* the host JVM cannot:
 *
 *   1. a real `MediaRecorder.start()`/`stop()` round-trip produces a non-empty `.m4a`
 *      file at `<filesDir>/recordings/<id>.m4a`,
 *   2. the file's first 12 bytes are a valid `ftyp` MPEG-4 box header (sanity check that
 *      the device-side HAL did not leave the file half-written),
 *   3. `RecordingContract.audioSourceName(VOICE_CALL|VOICE_COMMUNICATION)` returns the
 *      exact wire word Rust's `parse_recording_report` accepts,
 *   4. `RecordingContract.buildReport` round-trips through the same shape on a device.
 *
 * What this file does **not** pin — by design:
 *
 *   * the `InCallService` companion statics (`setRecording`, `recordingResult`, etc.). They
 *     require a bound `InCallService` (i.e. AmOS must already be the default phone app) and
 *     a live `Call`; exercising that path needs the user to grant `ROLE_DIALER` and place
 *     a real call. The Kotlin source-pin `setRecording_drives_a_real_recorder_and_only_answers_after_it_acted`
 *     covers the static surface on every CI run; this file covers the device half that
 *     source-pin cannot (the actual file produced, the actual recorder).
 *
 * Run:
 *   bash scripts/android-glue-mirror.sh   # mirror this file into the gen project
 *   cargo tauri android build --debug     # build the APK
 *   adb install -r -g crates/amos-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
 *   adb -s <device> shell pm grant com.amos.ai android.permission.RECORD_AUDIO
 *   ./gradlew -p crates/amos-tauri/gen/android :app:connectedArmDebugAndroidTest
 *
 * The `--rerun-tasks` flag is what makes the test compile-fresh; without it Gradle
 * happily reports `UP-TO-DATE` for `compileArmDebugAndroidTestKotlin` even after a source
 * change, and a real compile failure would be silent (same class of defect REQ-A185 hit
 * on the host-JVM side).
 */
@RunWith(AndroidJUnit4::class)
class AmosInCallRecordingInstrumentationTest {

    @get:Rule
    val tmp: TemporaryFolder = TemporaryFolder()

    private lateinit var appCtx: Context

    @Before
    fun setUp() {
        appCtx = ApplicationProvider.getApplicationContext()
        // `RECORD_AUDIO` is the permission `MediaRecorder` with `VOICE_COMMUNICATION` needs.
        // The test APK is built with `android.permission.RECORD_AUDIO` declared (see the
        // app manifest); we surface a clean refusal here if the runtime grant is missing
        // rather than a stack trace, so the failure mode is the test's own.
        val granted = appCtx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        assertTrue(
            "RECORD_AUDIO must be granted for this test; run `adb shell pm grant " +
                appCtx.packageName + " android.permission.RECORD_AUDIO`",
            granted,
        )
    }

    @After
    fun tearDown() {
        // Nothing to clean up: every `MediaRecorder` we open is closed in the test body
        // (the `try/finally` pattern), and the temporary folder is per-test.
    }

    /** A real `MediaRecorder` cycle — `prepare()`/`start()`/`stop()` — produces a non-empty
     *  `.m4a` file at `<filesDir>/recordings/<id>.m4a`, with a valid MP4 container header.
     *  This is the *one* fact the host-JVM test cannot pin: that the device-side HAL
     *  actually wrote the file we asked it to write.
     *
     *  We do NOT go through `AmosInCallService.beginRecording()` — that one touches the
     *  service-instance state machine, which is only legal while the service is bound.
     *  Instead we drive the same `MediaRecorder` configuration the live service uses,
     *  which is what the source-pin (`setRecording_drives_a_real_recorder...`) verifies
     *  the live service sets up.
     *
     *  The recorder holds the mic briefly; on a device with another app already on
     *  the audio HAL the second `start()` is rejected (the failure mode measured on
     *  S5 / API 34 with the camera foreground). We catch `RuntimeException` so a
     *  device-level refusal surfaces as an honest failure rather than a crash. */
    @Test
    fun mediaRecorderWritesAMpeg4FileToTheRecordingsRoot() {
        val fakeFilesDir = tmp.newFolder("fake-files")
        val recordingsRoot = RecordingContract.recordingsRoot(fakeFilesDir)
        val id = RecordingContract.newRecordingId(1_700_000_000_000L)
        val file = File(recordingsRoot, RecordingContract.fileName(id))

        val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(appCtx)
        } else {
            MediaRecorder()
        }
        try {
            // The exact configuration the live `AmosInCallService.beginRecording()` uses,
            // minus the per-call VOICE_CALL vs VOICE_COMMUNICATION choice — this test
            // always uses MIC (the only source a debuggable retail build has access to).
            rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setAudioSamplingRate(44100)
            rec.setAudioEncodingBitRate(96000)
            rec.setAudioChannels(1)
            rec.setOutputFile(file.absolutePath)
            rec.prepare()
            rec.start()
            // Hold the recorder for ~250 ms (a real buffer is committed to disk; the
            // pre-fix code stopped after `prepare()` and produced a zero-byte file the
            // ledger then refused to file — `metadata.len() == 0`, REQ-A1579). Keep the
            // window short: a foreground app holding the audio HAL longer than this
            // kills the second `start()` with `RuntimeException`.
            Thread.sleep(250L)
            rec.stop()
            rec.release()
        } catch (e: RuntimeException) {
            try { rec.release() } catch (_: Exception) {}
            // Surface the refusal with a useful message — the host sees *which*
            // exception came from the HAL (e.g. `MediaRecorder.start()` failure
            // when the camera holds the mic), not a process-crash stack trace
            // that says nothing about the audio HAL.
            fail("MediaRecorder.start/stop threw ${e.javaClass.simpleName}: ${e.message}")
        } catch (e: Exception) {
            try { rec.release() } catch (_: Exception) {}
            fail("MediaRecorder.start/stop threw: ${e.javaClass.simpleName}: ${e.message}")
        }

        // The file must exist, be non-empty, and start with the MPEG-4 `ftyp` box header.
        assertTrue("file must exist at ${file.absolutePath}", file.exists())
        assertTrue("file must be non-empty (got ${file.length()} bytes)",
            file.length() > 0L)
        // `ftyp` box header: 4 bytes size, "ftyp", 4 bytes major-brand. For an MPEG-4
        // container the major brand is one of "isom", "mp42", "M4A ", "M4V ", etc.
        val header = ByteArray(12)
        val n = file.inputStream().use { it.read(header) }
        assertTrue("file must have at least a 12-byte header (read $n)", n == 12)
        val brand = String(header, 4, 4)
        assertTrue(
            "header must carry the `ftyp` box at offset 4 (got `${String(header, 4, 4)}`)",
            brand == "ftyp",
        )
        val major = String(header, 8, 4)
        assertTrue(
            "MPEG-4 major brand must be one of isom/mp42/M4A /M4V  (got `$major`)",
            major in setOf("isom", "mp42", "M4A ", "M4V ", "dash", "avc1"),
        )
    }

    /** The wire words for the two audio sources match Rust's allowlist
     *  (`crates/amos-tauri/src/incall.rs::RECORDING_SOURCES`). Pinned here on the device
     *  side as well as the host JVM (`RecordingContractTest`) so a future SDK rename of
     *  the constant surfaces visibly from both angles. */
    @Test
    fun theAudioSourceWordsAreExactlyWhatRustKnows() {
        // VOICE_CALL is `4` since API 7; VOICE_COMMUNICATION is `7` since API 11.
        // The test asserts the integers explicitly so a future SDK move surfaces visibly.
        val voiceCall = 4
        val voiceComm = 7
        assertEquals(RecordingContract.SOURCE_VOICE_CALL,
            RecordingContract.audioSourceName(voiceCall))
        assertEquals(RecordingContract.SOURCE_VOICE_COMMUNICATION,
            RecordingContract.audioSourceName(voiceComm))
        // The "anything else" arm lands on the same word the Kotlin fallback uses — this
        // matches `AmosInCallService.beginRecording()`'s `else` branch and the Rust
        // `parse_recording_report`'s allowlist.
        assertEquals(RecordingContract.SOURCE_VOICE_COMMUNICATION,
            RecordingContract.audioSourceName(0))
        assertEquals(RecordingContract.SOURCE_VOICE_COMMUNICATION,
            RecordingContract.audioSourceName(Int.MAX_VALUE))
    }

    /** The `<id>|<startedAtMs>|<source>` envelope round-trips: a value Rust parses on
     *  a real device is the same value Kotlin produces on a real device. This is the
     *  cross-language half of the contract that the host JVM cannot pin against a real
     *  `parse_recording_report` (which is Rust-side). */
    @Test
    fun theReportEnvelopeRoundTripsOnADevice() {
        val r = RecordingContract.buildReport(
            "real-1700000000000",
            1_700_000_000_000L,
            RecordingContract.SOURCE_VOICE_COMMUNICATION,
        )
        val parts = r.split(RecordingContract.REPORT_DELIMITER)
        assertEquals(3, parts.size)
        assertEquals("real-1700000000000", parts[0])
        assertEquals("1700000000000", parts[1])
        assertEquals(RecordingContract.SOURCE_VOICE_COMMUNICATION, parts[2])
    }

    /** `<filesDir>/recordings/` is the directory the ledger and the Tauri `app_data_root`
     *  both expect. The Kotlin instance `recordingsRoot()` reaches the same directory
     *  via `Context.getFilesDir()`; this test pins the static-form (`RecordingContract`)
     *  to the live `Context.getFilesDir()`-derived directory, so a future drift surfaces
     *  here. */
    @Test
    fun recordingsRootMatchesContextGetFilesDir() {
        // `<filesDir>/recordings/`. The mirror on the host JVM checks the directory rule
        // for arbitrary `File`s; this one checks it for *the live* `Context.getFilesDir()`,
        // which is what the running service sees.
        val recordings = RecordingContract.recordingsRoot(appCtx.filesDir)
        val expected = File(appCtx.filesDir, "recordings")
        assertEquals(expected, recordings)
        assertTrue("the live filesDir/recordings must be reachable from the test",
            recordings.exists())
        assertTrue(recordings.isDirectory)
    }
}
