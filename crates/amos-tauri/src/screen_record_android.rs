//! Android backend for the `screen_record_*` commands (feature `android`).
//!
//! The macOS half of screen recording is a **child process** (`ffmpeg -f avfoundation`)
//! that the host spawns, signals and reaps — see [`crate::screen_record`]. Android has no
//! equivalent: a capture is a `MediaProjection` + `MediaRecorder` + `VirtualDisplay`
//! held open by the app, plus a system consent dialog the *user* answers. So there is no
//! session for the host to own, and this module is the thin seam between the host's
//! typed commands and [`ScreenRecordGlue`], which holds the state on the Java side.
//!
//! ```text
//! screen_record_start  ─► start()  ─► ScreenRecordGlue.start(maxSecs, display): String
//! screen_record_stop   ─► stop()   ─► ScreenRecordGlue.stop(): String        (+ statusJson)
//! screen_record_status ─► status() ─► ScreenRecordGlue.statusJson(): String  → ScreenRecordStatus
//! ```
//!
//! The glue answers with **`STATUS_*` words**, not booleans, because the outcomes are not
//! two: `requested` (a consent dialog is up — a session may or may not follow), `already`
//! (one is live), `unavailable` (no Activity has attached the glue yet), `denied` (the
//! platform refused), `unsupported` (this API level cannot project). Folding any of those
//! into `false` would make the host report the wrong refusal to the user, which is why the
//! words are mapped one by one below.
//!
//! ## Honest boundaries
//!
//!   * **One device has run this, and it found the class-loader defect.** The APK was
//!     installed on a live handset (2026-09-26), where `screen_record_status` and
//!     `screen_record_stop` answered 「the screen-capture glue is not reachable: Java
//!     exception was thrown」 — a `ClassNotFoundException` for the glue — while
//!     [`capability`] was still answering `available: true`. Both halves are fixed below
//!     ([`glue_class`] resolves through the app's loader; [`capability`] now asks it), which
//!     is REQ-A1866 ∕ F-AND-016. What a device still has **not** shown is the *capture
//!     itself* — a real `MediaProjection`, a real `.mp4` — and that is the boundary the FMEA
//!     row (F-DEV-141) records.
//!   * **The sealed file's size is confirmed, the way macOS confirms its own.** macOS's stop
//!     stats the file its child wrote ([`crate::screen_record::confirm_written`]) and refuses
//!     a missing or empty one; here the destination is a `content://` row, so the glue stats
//!     the descriptor it handed the `MediaRecorder` and carries the number in its status, and
//!     [`confirm_sealed`] applies the same rule — a `MediaRecorder` that started but wrote no
//!     frames is [`ErrorCode::ScreenRecordConfirmFailed`], not a finished recording. What is
//!     still **not** checked is what macOS does not check either: the host never looks at a
//!     single pixel, so "the frames are the screen" is reported by neither platform.
//!   * **A size the platform would not report is its own refusal.** `Some(0)` is "the recorder
//!     wrote an empty file"; an absent `bytes` field is "this host cannot confirm anything".
//!     The glue keeps them apart ([`ScreenRecordGlue`]'s `UNMEASURED_BYTES`, emitted as an
//!     absent field), and [`confirm_sealed`] refuses each with its own sentence — the same
//!     distinction `confirm_written`'s two arms draw.
//!   * **The `display` argument is ignored**: `MediaProjection` mirrors the default
//!     display, and Android exposes no public way to project another.
#![cfg(feature = "android")]

use jni::objects::{GlobalRef, JClass, JValue, JValueOwned};
use serde::Deserialize;

use crate::error::{AmosError, ErrorCode};
use crate::screen_record::{ScreenRecordCapability, ScreenRecordStatus};

/// The Kotlin glue class, as a **Java name** — every call site goes through
/// [`glue_class`], which resolves it with [`amos_jni::resolve_class`].
///
/// The name is never handed to `JNIEnv::call_static_method(<&str>, …)`, which resolves it
/// with `JNIEnv::find_class`: that uses the **calling thread's** class loader, and every
/// command in this module is `async` (the macOS half spawns a child process, so the shared
/// signature is `async`), so it would run on a tokio worker whose loader is the bootstrap
/// one — `ClassNotFoundException` for `com.amos.ai.glue.*`. `incall.rs` learned the same
/// lesson on the in-call path (REQ-A1448), and this is the device-measured one (REQ-A1866):
/// on the S5 (2026-09-26) `screen_record_status` and `screen_record_stop` both failed with
/// 「the screen-capture glue is not reachable: Java exception was thrown」, while the **sync**
/// commands resolving the same class (`rotation_set`, `nfc_status`) answered — they run on a
/// Java thread, whose loader *is* the app's.
const GLUE_CLASS: &str = "com.amos.ai.glue.ScreenRecordGlue";

/// The words [`ScreenRecordGlue`] answers with. Mirrored by name on the Kotlin side, whose
/// host-JVM test pins that they are distinct.
const STATUS_REQUESTED: &str = "requested";
const STATUS_RECORDING: &str = "recording";
const STATUS_STOPPED: &str = "stopped";
const STATUS_ALREADY: &str = "already";
const STATUS_UNAVAILABLE: &str = "unavailable";
const STATUS_UNSUPPORTED: &str = "unsupported";
const STATUS_DENIED: &str = "denied";
/// The glue's belt-and-braces answer to a duration outside its bounds. Unreachable from
/// this host — [`start`] resolves the request with `screen_record::resolve_max_secs` and
/// refuses out-of-range *before* it reaches the glue — but the glue applies the same rule
/// to a caller that reached it another way, and this is the code that rule maps to. It is
/// the second producer of `ScreenRecordDurationOutOfRange` (the first is the host's own
/// pre-wire refusal), so the frozen wire code is no longer reachable from one side only.
const STATUS_OUT_OF_RANGE: &str = "out_of_range";

/// The glue's `statusJson()` payload, parsed.
#[derive(Debug, Deserialize)]
struct GlueStatus {
    recording: bool,
    stopping: bool,
    #[serde(rename = "startedMs")]
    started_ms: u64,
    #[serde(rename = "maxSecs")]
    max_secs: u32,
    out: String,
    /// The size the glue measured when it released the recorder, or **absent** when the
    /// platform reported none. Absent and `Some(0)` are different facts — `confirm_written`'s
    /// two arms draw the same line on macOS — so this is a `Option` and not a bare `u64`
    /// defaulting to `0` (the fold [`confirm_sealed`] exists to refuse).
    #[serde(default)]
    bytes: Option<u64>,
}

/// Can this build record the screen?
///
/// The platform can — Android has `MediaProjection` — so the answer turns on whether a
/// command would actually **reach** the glue. That is two facts and the pre-fix answer read
/// only the first: the JNI binding being installed. The second — the class resolving on the
/// app's loader — can fail on its own, and a device round (2026-09-26) caught exactly that:
/// [`capability`] answered `available: true` while every command answered
/// `ClassNotFoundException` (REQ-A1866 ∕ F-AND-016). A capability that cannot observe the
/// failure it exists to prevent is the defect, so the probe below is the **same**
/// [`glue_boundary`] a command hits — it cannot drift from what the commands will do.
pub fn capability() -> ScreenRecordCapability {
    capability_from_boundary(glue_boundary())
}

/// Fold the glue boundary into a [`ScreenRecordCapability`].
///
/// Pure, so the invariant a UI reads — `available` **iff** `reason` is empty — is pinned
/// without a device. It holds by construction: the two arms are mutually exclusive by shape,
/// not by two hand-written sentences agreeing with each other.
fn capability_from_boundary(boundary: Option<String>) -> ScreenRecordCapability {
    match boundary {
        None => ScreenRecordCapability {
            available: true,
            reason: String::new(),
        },
        Some(reason) => ScreenRecordCapability {
            available: false,
            reason,
        },
    }
}

/// The sentence naming which boundary blocks a recording, or `None` when none does.
///
/// The two boundaries are different facts and a user can act on only one of them: nothing has
/// bound a `Context` yet (the app is still starting — the JNI binding is installed by
/// `MainActivity.onStart`, so this is the ordinary state for the first moments and for a
/// build whose Activity never ran), versus the glue class is absent from the app's loader
/// (this APK cannot record, whatever the user does). Collapsing them into one sentence, or
/// into `available: false`, would tell the user to wait for something that will never come.
fn glue_boundary() -> Option<String> {
    crate::ble::android_jni::with_context_result(|ctx, env| glue_class(env, ctx).map(|_| ())).err()
}

/// The glue class through the **app's** class loader, from the bound `Context`.
///
/// [`amos_jni::resolve_class`] is the one place that does this: it goes
/// `Context#getClassLoader().loadClass(name)` and hands back a global ref, which is what
/// makes the call legal from a tokio worker (see [`GLUE_CLASS`]). `crates/amos-radio` and
/// `crates/amos-jni`'s own doc say the same thing.
fn glue_class(env: &mut jni::JNIEnv<'_>, ctx: &GlobalRef) -> Result<GlobalRef, String> {
    amos_jni::resolve_class(env, ctx.as_ref(), GLUE_CLASS).ok_or_else(|| {
        format!("the screen-capture glue class ({GLUE_CLASS}) is not on the app's class loader")
    })
}

/// `ScreenRecordGlue.<method>() -> String`, or an `Err` when the glue is unreachable.
fn call_glue(method: &str, sig: &str, args: &[JValue<'_, '_>]) -> Result<String, String> {
    crate::ble::android_jni::with_context_result(|ctx, env| {
        let class = glue_class(env, ctx)?;
        let class: &JClass<'_> = class.as_obj().into();
        let value = amos_jni::jni_call!(env, env.call_static_method(class, method, sig, args))
            .map_err(|e| e.to_string())?;
        // The owned object is bound to a local (not passed as a temporary) because
        // `get_string` borrows through the `JString` view it is converted into: a
        // temporary would be freed at the end of that statement (E0716).
        let object = match value {
            JValueOwned::Object(object) => object,
            _ => return Err(format!("{method} answered with a non-object")),
        };
        if object.is_null() {
            return Err(format!("{method} answered null"));
        }
        let text = env
            .get_string((&object).into())
            .map_err(|e| e.to_string())?;
        Ok(String::from(text))
    })
}

/// `ScreenRecordGlue.statusJson()` → the glue's payload.
///
/// A parse failure is an **error**, never a defaulted idle: reporting "not recording" off a
/// payload that could not be read is the "a failed read folded into a valid value" shape
/// (F-AND-007), and on this path it would blank the REC marker over a live capture.
fn read_glue_status() -> Result<GlueStatus, AmosError> {
    let raw = call_glue("statusJson", "()Ljava/lang/String;", &[])
        .map_err(|reason| AmosError::new(ErrorCode::ScreenRecordSpawnFailed, reason))?;
    serde_json::from_str(&raw).map_err(|e| {
        AmosError::new(
            ErrorCode::ScreenRecordSpawnFailed,
            format!("the screen-capture glue sent a status this host cannot read: {e}"),
        )
    })
}

/// The current session's typed status.
fn status() -> Result<ScreenRecordStatus, AmosError> {
    Ok(into_status(read_glue_status()?))
}

/// Fold the glue's payload into the host's status of the session that is **live now**,
/// deriving the elapsed clock here (the glue reports the start instant, not a running total,
/// so the host's own `now` is what the pill counts with).
///
/// Every session field is gated by the *same* predicate — a session being live at all —
/// because [`ScreenRecordGlue.teardown`] deliberately **keeps** `startedMs`, `maxSecs` and
/// `out` after a session ends (its comment names the one reader: the stop command's
/// read-back). A status poll of that glue therefore carries a finished session's fields, and
/// folding any one of them through would describe a session that is over as if it were
/// running — `out` in particular used to survive this fold, answering a destination for a
/// status whose every sibling field said "no session" (REQ-A1621 ∕ F-AND-011). Nothing is
/// lost by keeping this fold to the live session: the finished one has its own, [`into_stopped`].
///
/// The clock is derived for a **sealing** session as well as a recording one, which is what
/// the macOS half's stopping branch does — the frontend draws an elapsed clock for the
/// `stopping` phase, and a fold that answered `0` there would print `0:00` over a session
/// that has been running for minutes.
fn into_status(glue: GlueStatus) -> ScreenRecordStatus {
    if !glue.recording && !glue.stopping {
        return ScreenRecordStatus::idle();
    }
    let out = if glue.out.is_empty() {
        None
    } else {
        Some(glue.out)
    };
    ScreenRecordStatus {
        recording: glue.recording,
        stopping: glue.stopping,
        started_ms: glue.started_ms,
        elapsed_secs: crate::screen_record::now_ms().saturating_sub(glue.started_ms) / 1000,
        max_secs: glue.max_secs,
        out,
    }
}

/// Fold the glue's payload into the answer to `screen_record_stop`: the session **as it
/// ended**, which is what [`stop`]'s own doc promises ("the host then reads the status back
/// for the destination **and the duration**").
///
/// A second fold, rather than [`into_status`], because the glue answers `stopped` only after
/// `teardown` — so by the time the host reads it back there is no live session left, and a
/// fold gated on liveness discards precisely the two fields the glue kept for this read-back:
/// the start instant and the ceiling, so the stop could name *which file* but never *how
/// long*. The macOS half's stop reports both from the session it sealed, and this is that
/// same answer.
///
/// `max_secs` is `0`: the ceiling belonged to the session that just ended, and macOS's stop
/// answer reports `0` for it too.
fn into_stopped(glue: GlueStatus) -> ScreenRecordStatus {
    // With no start instant there is no duration, and `0` is this wire's word for "not
    // known" — `now` would report the age of the Unix epoch as if it were the recording.
    let elapsed_secs = if glue.started_ms == 0 {
        0
    } else {
        crate::screen_record::now_ms().saturating_sub(glue.started_ms) / 1000
    };
    let out = if glue.out.is_empty() {
        None
    } else {
        Some(glue.out)
    };
    ScreenRecordStatus {
        recording: false,
        stopping: false,
        started_ms: glue.started_ms,
        elapsed_secs,
        max_secs: 0,
        out,
    }
}

/// Begin a capture: post the system consent dialog and report the session as it stands.
///
/// A `requested` answer is **not** a failure and **not** a recording: the session exists
/// only once the user approves, and the host's poll (`screen_record_status`) picks it up.
/// The returned status is therefore the glue's current one — almost always idle — which is
/// exactly what is true at that instant.
pub async fn start(max_secs: u32, display: Option<u32>) -> Result<ScreenRecordStatus, AmosError> {
    let display_arg = display.unwrap_or(0).min(i32::MAX as u32) as i32;
    let max_arg = max_secs.min(i32::MAX as u32) as i32;
    let word = call_glue(
        "start",
        "(II)Ljava/lang/String;",
        &[JValue::Int(max_arg), JValue::Int(display_arg)],
    )
    .map_err(|reason| {
        AmosError::new(
            ErrorCode::ScreenRecordUnsupported,
            format!("the screen-capture glue is not reachable: {reason}"),
        )
    })?;
    match word.as_str() {
        STATUS_REQUESTED | STATUS_RECORDING => status(),
        STATUS_ALREADY => Err(AmosError::new(
            ErrorCode::ScreenRecordAlreadyRecording,
            "a screen recording is already in progress; stop it before starting another",
        )),
        STATUS_UNSUPPORTED => Err(AmosError::new(
            ErrorCode::ScreenRecordUnsupported,
            "this Android build cannot capture the screen (MediaProjection is unavailable)",
        )),
        STATUS_UNAVAILABLE => Err(AmosError::new(
            ErrorCode::ScreenRecordUnsupported,
            "the screen-capture glue has no foreground Activity yet (MainActivity has not \
             attached it)",
        )),
        // The glue refuses an out-of-range bound with the same rule (and the same wire
        // code) this host applies before it calls in, so a caller that reached the glue
        // directly gets the host's own refusal rather than a fabricated length.
        STATUS_OUT_OF_RANGE => Err(AmosError::new(
            ErrorCode::ScreenRecordDurationOutOfRange,
            format!(
                "the screen-capture glue refused the requested duration: it must be within \
                 [1, {}] seconds (this host resolves the bound before it calls in, so this \
                 answer means the glue was reached another way)",
                crate::screen_record::MAX_RECORD_SECS
            ),
        )),
        other => Err(AmosError::new(
            ErrorCode::ScreenRecordSpawnFailed,
            format!("the screen-capture glue answered an unknown start result: {other}"),
        )),
    }
}

/// Did the sealed capture actually write a file? The Android half of
/// [`crate::screen_record::confirm_written`].
///
/// macOS's stop stats the file its child wrote; here the destination is a `content://` row,
/// so the glue stats the descriptor it handed the `MediaRecorder` and carries the number in
/// its status. A `MediaRecorder` that started but wrote no frames is exactly the case that
/// used to be reported as success.
///
/// The two failures are kept apart because they are different facts: a measured **empty**
/// file (the recorder ran and produced nothing) and a size the platform would not report at
/// all (this host cannot confirm anything). Both carry
/// [`ErrorCode::ScreenRecordConfirmFailed`], the code macOS's own confirm failure uses.
fn confirm_sealed(glue: &GlueStatus) -> Result<(), AmosError> {
    match glue.bytes {
        Some(0) => Err(AmosError::new(
            ErrorCode::ScreenRecordConfirmFailed,
            "the screen recording was sealed but wrote an empty file (no frames were captured)",
        )),
        None => Err(AmosError::new(
            ErrorCode::ScreenRecordConfirmFailed,
            "the screen recording was sealed but the platform reported no file size, so this \
             host cannot confirm that anything was written",
        )),
        Some(_) => Ok(()),
    }
}

/// Seal the live session.
///
/// The glue's `stop()` is synchronous: by the time it answers `stopped`, the recorder has
/// been released and the MediaStore row published. The host then reads the status back to
/// **confirm the file** and to report the destination and the duration — [`into_stopped`],
/// because the session the glue is describing has already ended by then. A successful publish
/// is not the confirmation: the size the glue measured is ([`confirm_sealed`]).
pub async fn stop() -> Result<ScreenRecordStatus, AmosError> {
    let word = call_glue("stop", "()Ljava/lang/String;", &[]).map_err(|reason| {
        AmosError::new(
            ErrorCode::ScreenRecordStopFailed,
            format!("the screen-capture glue is not reachable: {reason}"),
        )
    })?;
    match stop_refusal(&word) {
        // `stopped` is the one word that is **not** a refusal: the session is sealed, and the
        // host reads the status back to confirm the file wrote and to name it ([`into_stopped`]).
        None => {
            let glue = read_glue_status()?;
            confirm_sealed(&glue)?;
            Ok(into_stopped(glue))
        }
        Some(e) => Err(e),
    }
}

/// The refusal a `stop()` answer word means, or `None` for [`STATUS_STOPPED`].
///
/// Pure over the word, so every answer the glue can carry is pinned without a device — the
/// same reason [`into_status`] and [`into_stopped`] are pure.
///
/// Spelled out arm by arm rather than folded into a catch-all, because that is the rule this
/// module's own doc states ("the words are mapped one by one") and [`start`] already follows:
/// `stop` answered `_`, so a word the glue never sends — or one of the words that only
/// `start` can produce — was reported as 「no screen recording is in progress」, a cause this
/// call never established (REQ-A1685).
fn stop_refusal(word: &str) -> Option<AmosError> {
    match word {
        STATUS_STOPPED => None,
        // The glue's `stop()` answers `unavailable` when there is **no recorder and nothing
        // pending** — its "nothing is running" word, not the constant's KDoc meaning ("no
        // Activity attached", which is the `start()` path; a genuinely unreachable glue never
        // gets this far, because `call_glue` refuses first).
        STATUS_UNAVAILABLE => Some(AmosError::new(
            ErrorCode::ScreenRecordNotRecording,
            "no screen recording is in progress",
        )),
        STATUS_DENIED => Some(AmosError::new(
            ErrorCode::ScreenRecordStopFailed,
            "the platform refused to seal the screen recording",
        )),
        STATUS_REQUESTED => Some(AmosError::new(
            ErrorCode::ScreenRecordNotRecording,
            "the screen-capture consent dialog is still open; there is nothing to stop",
        )),
        other => Some(AmosError::new(
            ErrorCode::ScreenRecordStopFailed,
            format!("the screen-capture glue answered an unexpected stop result: {other}"),
        )),
    }
}

/// The host's answer about the current session (live, sealing or idle).
pub async fn screen_status() -> Result<ScreenRecordStatus, AmosError> {
    status()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fold is pure, so the three read states a UI distinguishes can be pinned without
    /// a device — the same reason the macOS side keeps its own pure parts separate.
    #[test]
    fn a_live_session_keeps_its_clock_and_destination() {
        let status = into_status(GlueStatus {
            recording: true,
            stopping: false,
            started_ms: 1_000,
            max_secs: 60,
            out: "content://media/external/video/media/42".to_string(),
            bytes: None,
        });
        assert!(status.recording && !status.stopping);
        assert_eq!(status.max_secs, 60);
        assert_eq!(status.started_ms, 1_000);
        assert!(status.out.is_some());
    }

    #[test]
    fn a_sealing_session_is_not_reported_as_idle() {
        let status = into_status(GlueStatus {
            recording: false,
            stopping: true,
            started_ms: 1_000,
            max_secs: 60,
            out: "content://media/external/video/media/42".to_string(),
            bytes: None,
        });
        assert!(!status.recording && status.stopping);
        // A UI must be able to say "finishing…" rather than showing a stopped recorder.
        assert_eq!(status.started_ms, 1_000);
    }

    /// The glue **keeps** `startedMs` / `maxSecs` / `out` after a session ends
    /// (`ScreenRecordGlue.teardown` says so in those words: it keeps them for the *stop*
    /// command's read-back). A status **poll** describes the session that is live now, so a
    /// glue that has finished one must still read as `idle()` — otherwise the poll answers a
    /// destination for a status whose every sibling field says "no session" (REQ-A1621).
    #[test]
    fn a_finished_session_is_idle_to_a_status_poll() {
        let status = into_status(GlueStatus {
            recording: false,
            stopping: false,
            started_ms: 1_000,
            max_secs: 60,
            out: "content://media/external/video/media/42".to_string(),
            bytes: None,
        });
        // Negative control: the pre-fix shape returned this with `out: Some(..)`.
        assert_eq!(status, ScreenRecordStatus::idle());
    }

    /// The clock is derived from the glue's start instant and the host's own `now`, so a
    /// session that began five seconds ago reads `5` — and that holds for a **sealing**
    /// session exactly as for a recording one, which is what the macOS half's stopping branch
    /// does. The pre-fix fold derived it for `recording` only, so a sealing session answered
    /// `0` and the frontend's `recordingClock` (which draws for the `stopping` phase) printed
    /// `0:00` over a session that had been running for minutes (REQ-A1621 ∕ F-AND-011).
    #[test]
    fn the_clock_a_session_reports_comes_from_its_start_instant_in_either_live_shape() {
        let started = crate::screen_record::now_ms() - 5_000;
        for (recording, stopping) in [(true, false), (false, true)] {
            let status = into_status(GlueStatus {
                recording,
                stopping,
                started_ms: started,
                max_secs: 60,
                out: "content://media/external/video/media/42".to_string(),
                bytes: None,
            });
            assert_eq!(
                status.elapsed_secs, 5,
                "recording={recording} stopping={stopping}"
            );
            assert_eq!(status.max_secs, 60);
            assert!(status.out.is_some());
        }
    }

    /// `stop`'s answer is the session **as it ended** — the file it wrote *and* how long it
    /// ran — where the pre-fix fold answered the glue's post-teardown payload as if it were
    /// idle, so the duration this command's own doc promises was structurally always `0`
    /// (REQ-A1621 ∕ F-AND-011).
    #[test]
    fn a_stop_reads_back_the_finished_session_but_a_status_poll_does_not() {
        let glue = |started_ms: u64| GlueStatus {
            recording: false,
            stopping: false,
            started_ms,
            max_secs: 30,
            out: "content://media/external/video/media/42".to_string(),
            bytes: None,
        };

        // The same glue payload the stop reads back, through the two folds.
        let stopped = into_stopped(glue(crate::screen_record::now_ms() - 7_000));
        assert!(!stopped.recording && !stopped.stopping);
        assert_eq!(stopped.elapsed_secs, 7);
        assert!(
            stopped.started_ms > 0,
            "the stop must carry the session's start instant"
        );
        assert_eq!(
            stopped.out.as_deref(),
            Some("content://media/external/video/media/42")
        );
        // The ceiling belonged to the session that just ended (macOS's stop reports `0` too).
        assert_eq!(stopped.max_secs, 0);

        // Negative control: with no start instant there is no duration to report. `0` is the
        // wire's "not known", never `now` — which would print the age of the epoch, i.e. a
        // recording that ran for 56 years.
        assert_eq!(into_stopped(glue(0)).elapsed_secs, 0);

        // And the poll of the very same finished glue says "no session" (see the sibling
        // test above): the two folds disagree on purpose, because they answer different
        // questions — "what is happening" vs "what did the stop just seal".
        assert_eq!(into_status(glue(1_000)), ScreenRecordStatus::idle());
    }

    #[test]
    fn an_idle_glue_reports_nothing() {
        let status = into_status(GlueStatus {
            recording: false,
            stopping: false,
            started_ms: 0,
            max_secs: 0,
            out: String::new(),
            bytes: None,
        });
        assert_eq!(status, ScreenRecordStatus::idle());
        // The positive control for `out`: an empty destination is `None`, not `Some("")`.
        assert!(status.out.is_none());
    }

    /// Every answer the glue can give to `stop()` has its own refusal, and `stopped` — the
    /// only word that is not one — is the one that answers `None`.
    ///
    /// The pre-fix `_` arm folded the whole remainder into 「no screen recording is in
    /// progress」: a word the glue never sends (or one only `start()` can produce) was
    /// described as a cause the call never established, where `start()`'s sibling match names
    /// the unknown case. This is device-only, so it is pinned here, purely (REQ-A1685).
    #[test]
    fn every_stop_answer_word_has_its_own_refusal() {
        // The positive control: the success word is not a refusal at all. Without this, an
        // implementation that refused *everything* would pass the assertions below.
        assert!(stop_refusal(STATUS_STOPPED).is_none());

        // The words the glue's `stop()` can actually return, each with its own sentence and
        // its own code — the consent dialog being open is not "the platform refused", and
        // "nothing is running" is not either.
        let unavailable = stop_refusal(STATUS_UNAVAILABLE).expect("a refusal");
        assert_eq!(unavailable.code, ErrorCode::ScreenRecordNotRecording);
        let denied = stop_refusal(STATUS_DENIED).expect("a refusal");
        assert_eq!(denied.code, ErrorCode::ScreenRecordStopFailed);
        let requested = stop_refusal(STATUS_REQUESTED).expect("a refusal");
        assert_eq!(requested.code, ErrorCode::ScreenRecordNotRecording);
        assert_ne!(requested.message, unavailable.message, "两条都不是同一句");

        // A word this path never sends is **named**, not described as "nothing is
        // recording". The negative control is the pre-fix fold: this word used to read as
        // the same sentence as `unavailable`.
        let unknown = stop_refusal("something_else").expect("a refusal");
        assert_eq!(unknown.code, ErrorCode::ScreenRecordStopFailed);
        assert!(
            unknown.message.contains("something_else"),
            "the unexpected word must be named, not folded into a cause: {}",
            unknown.message
        );
        assert_ne!(
            unknown.message, unavailable.message,
            "an unexpected word is not the same fact as \"nothing is running\""
        );
    }

    /// The Android half of macOS's `confirm_written`: a seal is not a success until the file
    /// it produced is confirmed to hold something.
    ///
    /// The gap this closes was declared in this module's own doc and in
    /// `docs/screen-recording.md` §7: the glue's successful publish was the *entire*
    /// confirmation, so a `MediaRecorder` that started but wrote no frames was reported as a
    /// finished recording — the destination named and the duration counted, with an empty
    /// file behind them.
    ///
    /// A size the platform would **not** report is its own refusal, distinct from a measured
    /// empty file: `Some(0)` says "the recorder ran and produced nothing", an absent field
    /// says "this host cannot confirm anything". Folding the two (a bare `u64` defaulting to
    /// `0`) would report an unmeasurable capture as a measured-empty one.
    #[test]
    fn a_sealed_capture_must_report_a_non_empty_file() {
        // The positive control first: a real measurement is a success, so an implementation
        // that refused *everything* could not pass the refusals below.
        let good = GlueStatus {
            recording: false,
            stopping: false,
            started_ms: 1_000,
            max_secs: 0,
            out: "content://media/external/video/media/42".to_string(),
            bytes: Some(262_144),
        };
        assert!(confirm_sealed(&good).is_ok());

        // A measured empty file — the recorder ran, wrote nothing.
        let empty = GlueStatus {
            bytes: Some(0),
            ..good_glue()
        };
        let empty_err = confirm_sealed(&empty).expect_err("a zero-byte capture must be refused");
        assert_eq!(empty_err.code, ErrorCode::ScreenRecordConfirmFailed);
        assert!(
            empty_err.message.contains("empty"),
            "an empty capture must be named as such, not as 'could not measure': {}",
            empty_err.message
        );

        // A size the platform never reported — this host cannot confirm anything at all.
        let absent = GlueStatus {
            bytes: None,
            ..good_glue()
        };
        let absent_err =
            confirm_sealed(&absent).expect_err("an unmeasured capture must be refused");
        assert_eq!(absent_err.code, ErrorCode::ScreenRecordConfirmFailed);
        assert!(
            absent_err.message.contains("no file size"),
            "an unmeasured capture must be named as a missing measurement: {}",
            absent_err.message
        );

        // The two refusals are different facts, so they must not share a sentence.
        assert_ne!(
            empty_err.message, absent_err.message,
            "a measured-empty file and an unmeasurable one are not the same refusal"
        );
    }

    /// The confirmation above is only real if the glue actually **measures** the sealed file;
    /// otherwise `bytes` is a field nothing produces and `confirm_sealed` refuses every
    /// capture. Pinned at the Kotlin source, the way the service and duration pins are,
    /// because the measurement is device-only work a host cannot run.
    #[test]
    fn the_glue_measures_the_sealed_file() {
        const GLUE: &str = include_str!("../android-glue/com/amos/ai/glue/ScreenRecordGlue.kt");

        // The sentinel that keeps "could not measure" apart from a measured `0`.
        assert!(
            GLUE.contains("const val UNMEASURED_BYTES = -1L"),
            "the glue needs a sentinel distinct from a measured empty file"
        );
        // The pure rule that turns the sentinel into the wire's absent field.
        assert!(
            GLUE.contains(
                "fun bytesField(measured: Long): Long? = if (measured >= 0) measured else null"
            ),
            "the glue must fold the sentinel into an absent field, keeping a measured 0"
        );
        // It reads the descriptor's size — the measurement itself.
        assert!(
            GLUE.contains("fd?.statSize"),
            "the glue must stat the descriptor it handed the recorder"
        );
        // And the measured value reaches the wire, gated so an unmeasured one stays absent.
        assert!(
            GLUE.contains("bytesField(lastBytes)?.let { json.put(\"bytes\", it) }"),
            "an unmeasured size must be an absent field, never `0`"
        );

        // The measurement must happen **after** the recorder is released (which flushes the
        // container trailer) and **before** the descriptor is closed — a stat of a closed
        // descriptor, or of a half-written container, would measure the wrong file.
        let teardown = GLUE
            .split("private fun teardown(")
            .nth(1)
            .expect("teardown must still exist as the one end-of-session path");
        let teardown = teardown
            .split("private fun ")
            .next()
            .expect("a teardown body");
        let release = teardown
            .find("rec?.release()")
            .expect("teardown must release the recorder");
        let measure = teardown
            .find("statSize")
            .expect("teardown must measure the sealed file");
        let close = teardown
            .find("fd?.close()")
            .expect("teardown must close the descriptor");
        assert!(
            release < measure && measure < close,
            "the size must be measured after release and before close"
        );
    }

    /// A glue payload that confirms as a non-empty capture, for the field overrides above.
    fn good_glue() -> GlueStatus {
        GlueStatus {
            recording: false,
            stopping: false,
            started_ms: 1_000,
            max_secs: 0,
            out: "content://media/external/video/media/42".to_string(),
            bytes: Some(262_144),
        }
    }

    /// A live whole-screen capture legally requires a foreground service on Android, and
    /// `ScreenRecordGlue.begin` starts one. Nothing stopped it: `teardown` — the one
    /// chokepoint **every** end path reaches (`stop()`, the auto-stop timer, the platform's
    /// own `MediaProjection.Callback.onStop`, and the refusal path `abort`) — never called
    /// `ScreenRecordService.stop`. A started service keeps running, so its ongoing
    /// "Recording screen" notification went on claiming a capture that had ended (or, after
    /// a refused start, had never begun) for the life of the process — while the service's
    /// own doc says the glue "[starts] it before asking the OS for the projection and stops
    /// it when the recording ends" and `stop(Context)`'s doc names its caller. A doc that
    /// describes a caller no code implements is the tell (REQ-A1631 ∕ F-AND-013).
    ///
    /// Pinned at the Kotlin **source**, the way the SMS verdict pin is
    /// (`crates/amos-tauri/src/sms.rs::sms_send_reports_a_real_verdict_not_an_ok_flag`),
    /// because this is device-only work a host cannot run.
    #[test]
    fn a_finished_capture_stops_its_foreground_service() {
        const GLUE: &str = include_str!("../android-glue/com/amos/ai/glue/ScreenRecordGlue.kt");
        const SERVICE: &str =
            include_str!("../android-glue/com/amos/ai/glue/ScreenRecordService.kt");

        // The service is not decoration — it is what a projection is allowed under, so the
        // glue must bring it up.
        assert!(
            GLUE.contains("ScreenRecordService.start("),
            "the glue must start the foreground service before it asks for the projection"
        );

        // …and it must be taken down when the session ends, or the platform marker
        // outlives the recording.
        assert!(
            GLUE.contains("ScreenRecordService.stop("),
            "a session that ends must stop its foreground service: an ongoing \
             \"Recording screen\" notification over a finished capture is a false claim, \
             and the process stays pinned in the foreground"
        );

        // The stop must live in `teardown`, the single chokepoint every end path reaches —
        // not an ad-hoc branch one of them would miss.
        let teardown = GLUE
            .split("private fun teardown(")
            .nth(1)
            .expect("teardown must still exist as the one end-of-session path");
        let teardown = teardown
            .split("private fun ")
            .next()
            .expect("a teardown body");
        assert!(
            teardown.contains("ScreenRecordService.stop("),
            "the teardown chokepoint must stop the service, so every end path does"
        );

        // The callee must still exist, or the call above names nothing.
        assert!(
            SERVICE.contains("fun stop(context: Context)"),
            "ScreenRecordService must expose stop(Context) for the glue to call"
        );
    }

    /// The projection may only be requested **while a service of type `mediaProjection` is
    /// actually in the foreground**, and `startForegroundService` is asynchronous — so asking
    /// immediately after calling it is a race the platform wins. Measured on the S5 (Android
    /// 14, F-AND-019 ∕ REQ-A1875), the eager request answered
    ///
    /// ```text
    /// W/AmosScreenRecord: could not begin the capture: Media projections require a
    ///     foreground service of type ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
    /// I/AmosScreenRecord: abandoned capture generation 1
    /// I/AmosScreenRecordSvc: screen-record foreground service started
    /// I/AmosScreenRecordSvc: screen-record foreground service stopped
    /// E/AndroidRuntime: FATAL EXCEPTION: main
    ///     android.app.RemoteServiceException$ForegroundServiceDidNotStartInTimeException:
    ///     Context.startForegroundService() did not then call Service.startForeground()
    /// ```
    ///
    /// — the app died and no file was written. What killed it was the *consequence*: the
    /// refusal path stopped a service that had never foregrounded, which the platform reports
    /// as fatal. The fix is an ordering fact rather than a delay to tune, so it is pinned here
    /// as text on both Kotlin sources — the way the service pin above is, because a host
    /// cannot run any of this.
    #[test]
    fn the_projection_is_only_requested_from_the_services_foreground_callback() {
        const GLUE: &str = include_str!("../android-glue/com/amos/ai/glue/ScreenRecordGlue.kt");
        const SERVICE: &str =
            include_str!("../android-glue/com/amos/ai/glue/ScreenRecordService.kt");

        // The glue hands the session to the service instead of continuing inline.
        assert!(
            GLUE.contains("ScreenRecordService.start(activity) { onServiceForeground("),
            "the session must begin from the service's foreground callback, not inline after \
             startForegroundService returned"
        );

        // `begin` runs before the service is up, so it must not touch the projection at all…
        let begin = GLUE
            .split("private fun begin(")
            .nth(1)
            .expect("begin must still exist");
        let begin = begin
            .split("private fun onServiceForeground(")
            .next()
            .expect("a begin body");
        // Positive control for the split above: this *is* begin's body, so the absence asserted
        // below is an absence from the right slice rather than from an empty one.
        assert!(
            begin.contains("ScreenRecordService.start(activity)"),
            "the begin slice must be begin's own body"
        );
        assert!(
            !begin.contains("getMediaProjection") && !begin.contains("createDestination"),
            "begin runs while no mediaProjection service is in the foreground, so it must not \
             request the projection or open a destination — that is exactly the refusal and \
             the fatal teardown this fix removes"
        );

        // …and `continueBegin`, reached only from that callback, is where the session lives.
        let continuation = GLUE
            .split("private fun continueBegin(")
            .nth(1)
            .expect("continueBegin must exist as the session's real body");
        let continuation = continuation
            .split("private fun ")
            .next()
            .expect("a continueBegin body");
        assert!(
            continuation.contains("getMediaProjection(resultCode, data)"),
            "the projection request must live in the post-foreground continuation"
        );

        // The service fires the waiter *after* `startForeground` returns — that ordering is
        // the whole fix.
        let on_start = SERVICE
            .split("override fun onStartCommand(")
            .nth(1)
            .expect("onStartCommand must still exist");
        let on_start = on_start
            .split("override fun onDestroy(")
            .next()
            .expect("an onStartCommand body");
        let foreground_at = on_start
            .find("startForeground(NOTIFICATION_ID")
            .expect("onStartCommand must call startForeground");
        let waiter_at = on_start
            .find("ready?.invoke()")
            .expect("onStartCommand must invoke the session callback");
        assert!(
            foreground_at < waiter_at,
            "the session callback must run after startForeground, or the platform refuses the \
             very projection it was called to request"
        );

        // A service started with `startForegroundService` must call `startForeground` even
        // when its session is abandoned — a `stopService` before that is the fatal exception
        // above. So `stop` defers to `onStartCommand` instead.
        let stop = SERVICE
            .split("fun stop(context: Context)")
            .nth(1)
            .expect("stop must still exist");
        let stop = stop
            .split("private fun ensureChannel")
            .next()
            .expect("a stop body");
        assert!(
            stop.contains("stopBeforeForeground = true") && stop.contains("if (deferred)"),
            "stop must defer to the service's own foreground step when it has not run yet, \
             instead of a stopService the platform answers with a fatal exception"
        );
        assert!(
            on_start.contains("stopSelf()"),
            "onStartCommand must retire an abandoned service *after* it foregrounds"
        );
        // The service's start must hand back the moment its precondition holds.
        assert!(
            SERVICE.contains("fun start(context: Context, onReady: () -> Unit)"),
            "the service's start must expose the foreground moment to its caller"
        );
    }

    /// A `MediaProjection.Callback` must be registered **before** the virtual display is
    /// created — Android 14 (API 34) enforces it, and refusing is not survivable silently:
    /// `createVirtualDisplay` throws
    /// `IllegalStateException("Must register a callback before starting capture, to manage
    /// resources in response to MediaProjection states.")`, which [onServiceForeground]'s
    /// catch turns into a refusal, so the user's approved capture wrote **no file at all**.
    ///
    /// Measured on the S5 (Android 14, 2026-09-26) *after* the REQ-A1875 foreground-ordering
    /// fix — that fix removed the crash, and this is the next refusal the now-reachable path
    /// walked into:
    ///
    /// ```
    /// I/AmosScreenRecordSvc: screen-record foreground service started
    /// W/AmosScreenRecord: could not begin the capture: Must register a callback before
    ///     starting capture, to manage resources in response to MediaProjection states.
    /// W/AmosScreenRecord: recorder stop: null
    /// I/AmosScreenRecord: abandoned capture generation 1
    /// I/AmosScreenRecordSvc: screen-record foreground service stopped
    /// ```
    ///
    /// The order is a fact about the platform contract, so it is pinned at the source, the
    /// same way the service-ordering pin above is — a host cannot run any of this.
    #[test]
    fn the_projection_callback_is_registered_before_the_capture_starts() {
        const GLUE: &str = include_str!("../android-glue/com/amos/ai/glue/ScreenRecordGlue.kt");

        let body = GLUE
            .split("private fun continueBegin(")
            .nth(1)
            .expect("continueBegin must exist as the session's real body");
        let body = body
            .split("private fun ")
            .next()
            .expect("a continueBegin body");
        // Positive control for the slice: it must be the session body, so the order asserted
        // below is a fact about the right function rather than about an empty string.
        assert!(
            body.contains("getMediaProjection(resultCode, data)"),
            "the slice must be continueBegin's own body"
        );

        let callback_at = body
            .find("registerCallback(")
            .expect("the session must register a MediaProjection.Callback");
        let capture_at = body
            .find("createVirtualDisplay(")
            .expect("the session must create the virtual display");
        let start_at = body
            .find("rec.start()")
            .expect("the session must start the recorder");

        assert!(
            callback_at < capture_at,
            "the callback must be registered before createVirtualDisplay — Android 14 refuses \
             the capture outright otherwise (F-AND-020)"
        );
        assert!(
            callback_at < start_at,
            "the callback must be registered before the recorder starts: the platform's own \
             stop callback is what releases the capture when the user ends it from system UI"
        );
    }

    /// The glue's duration bound is a **mirror whose authority is the Rust pair**, and its
    /// own host-JVM test cannot check that: that test compares the glue to itself — its
    /// KDoc even said "mirrors the host" while every assertion read only the glue's own
    /// numbers, and its "the glue's own default (60s) standing in for the host's `None`"
    /// was simply false about this host (`None` is `MAX_RECORD_SECS`, not 60).
    ///
    /// It had drifted, and nothing went red: it named `screen_record::clamp_max_secs` after
    /// that function had been renamed and reversed (`resolve_max_secs`, now *refusing*
    /// out-of-range rather than clamping), and it answered a **fabricated** 60s default for
    /// a non-positive request — a finished file indistinguishable from one that was asked
    /// for. The tell is the family rule: a mirror that names an authority but never reads
    /// it is authenticating its own spelling (F-DEV-… ∕ REQ-…).
    ///
    /// Read at the Kotlin **source**, the way the service pin above does, because this is
    /// device-only work a host cannot run: the bounds and the refusal word are the whole
    /// cross-wire contract, and they are text. Pinning it here means changing either side's
    /// number or word alone goes red on a host.
    #[test]
    fn the_glues_duration_bound_is_the_hosts_bound() {
        const GLUE: &str = include_str!("../android-glue/com/amos/ai/glue/ScreenRecordGlue.kt");

        // The authority's numbers — the ones the Kotlin constants below must restate.
        assert_eq!(crate::screen_record::MIN_RECORD_SECS, 1);
        assert_eq!(crate::screen_record::MAX_RECORD_SECS, 30 * 60);

        // The glue restates those numbers as its own named constants…
        assert!(
            GLUE.contains("const val MIN_CAPTURE_SECS = 1"),
            "the glue's floor must be the host's MIN_RECORD_SECS"
        );
        assert!(
            GLUE.contains("const val MAX_CAPTURE_SECS = 30 * 60"),
            "the glue's ceiling must be the host's MAX_RECORD_SECS"
        );
        // …and names the authority, instead of authenticating only its own spelling.
        assert!(
            GLUE.contains("MIN_RECORD_SECS") && GLUE.contains("MAX_RECORD_SECS"),
            "the glue's constants must name the Rust authority they mirror"
        );

        // The refusal is a word on the wire; both sides must spell it identically, or the
        // host folds the glue's refusal into its named "unknown word" arm (a cause neither
        // side established) instead of reporting the out-of-range duration.
        assert!(
            GLUE.contains(&format!("STATUS_OUT_OF_RANGE = \"{STATUS_OUT_OF_RANGE}\"")),
            "the glue must spell the out-of-range word exactly as the host matches it"
        );

        // It is applied in `start`, before the Activity or the consent dialog is touched —
        // a request that can never be honoured must not reach the user.
        let start = GLUE
            .split("fun start(maxSecs: Int, display: Int): String {")
            .nth(1)
            .expect("start must still exist");
        let start = start
            .split("val act = activity?.get()")
            .next()
            .expect("a start body");
        assert!(
            start.contains("isDurationInRange(maxSecs)") && start.contains("STATUS_OUT_OF_RANGE"),
            "the duration rule must be enforced in start, before the consent dialog"
        );
        // The rule is a pure predicate [start] calls — one home, host-JVM testable — and it
        // reads the bounds rather than restating them anywhere else.
        assert!(
            GLUE.contains("fun isDurationInRange(requested: Int): Boolean")
                && GLUE.contains("requested in MIN_CAPTURE_SECS..MAX_CAPTURE_SECS"),
            "the duration rule must have exactly one home, over the named bounds"
        );

        // And the duration rule has **one home**: the bespoke clamp was a second decision
        // point that silently replaced a request — the shape this fix removes — and its
        // doc named the renamed function.
        assert!(
            !GLUE.contains("clampMaxSecs") && !GLUE.contains("clamp_max_secs"),
            "the glue must not keep a second, silently-substituting duration rule"
        );
    }

    /// The glue class must be resolved through the **app's** class loader rather than by name
    /// on the command thread, and [`capability`] must ask the same question the commands do.
    ///
    /// Both are one defect (`docs/FMEA.md` F-AND-016): the declarations said the right thing
    /// while the enforcement could not observe the failure. The commands resolved the class by
    /// name, and — the half that survived even after that was fixed — [`capability`] answered
    /// `available: true` off the JNI binding alone. On a real handset (2026-09-26) every one of
    /// `screen_record_status` / `stop` / `start` answered 「the screen-capture glue is not
    /// reachable: Java exception was thrown」 while the capability advertised a working button.
    ///
    /// Pinned at the Rust **source**, the way this module's Kotlin pins are, because the
    /// failure is invisible on a host: there is no class loader here to be the wrong one, so a
    /// unit test cannot run the resolution at all.
    #[test]
    fn the_glue_class_is_resolved_on_the_apps_loader_and_the_capability_asks_the_same_question() {
        const SOURCE: &str = include_str!("screen_record_android.rs");

        // ── arm 1: the class is resolved, not looked up by name ─────────────────────────
        // `call_static_method(<&str class name>, …)` **is** a `find_class`, and `find_class`
        // uses the calling thread's loader — the bootstrap one on the tokio worker these
        // `async` commands run on. The needle is assembled from two pieces so that this
        // assertion's own text cannot be what satisfies it.
        let by_name = concat!("call_static_method(", "GLUE_CLASS");
        assert!(
            !SOURCE.contains(by_name),
            "the glue class must not be resolved by name on the command thread (REQ-A1866)"
        );
        let resolver = concat!("amos_jni::resolve_class(env, ctx.as_ref(), ", "GLUE_CLASS)");
        assert!(
            SOURCE.contains(resolver),
            "the glue class must go through the app's loader (crates/amos-jni::resolve_class)"
        );

        // ── arm 2: the capability is the same probe the commands hit ────────────────────
        // The pre-fix fold: a capability reading only the JNI binding, so it advertised a
        // button that could not work. Assembled for the same reason as the needle above.
        let folded = concat!(
            "let reachable = crate::ble::android_jni::BINDING.get()",
            ".is_some();"
        );
        assert!(
            !SOURCE.contains(folded),
            "capability() must not answer from the JNI binding alone (REQ-A1866 ∕ F-AND-016)"
        );
        let probe = concat!("capability_from_", "boundary(glue_boundary())");
        assert!(
            SOURCE.contains(probe),
            "capability() must ask the same boundary the commands hit, so it cannot drift from them"
        );

        // ── the pure fold both arms rest on ────────────────────────────────────────────
        // The positive control first: an implementation that refused everything would pass
        // the negative arm below without it.
        let yes = capability_from_boundary(None);
        assert!(yes.available, "a clear boundary means available");
        assert!(yes.reason.is_empty(), "and the invariant's other half");
        let no = capability_from_boundary(Some("the reason".to_string()));
        assert!(!no.available);
        assert_eq!(no.reason, "the reason");
    }
}
