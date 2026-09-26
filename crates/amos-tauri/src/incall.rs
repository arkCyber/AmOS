//! Real in-call host → WebView bridge (feature `android`).
//!
//! When AmOS is the device's **default phone app (ROLE_DIALER)**, Android binds our
//! `AmosInCallService` (Kotlin, `gen/android/.../glue/AmosInCallService.kt`), which
//! observes every real Telecom `Call`. This module is the Rust side of that bridge:
//!
//! * Kotlin pushes each real call-state change up via the `nativeState` JNI upcall →
//!   we re-emit it as the existing `telephony-event` (`TelephonyCallPayload`), so the
//!   current WebView incoming-call overlay / in-call screen renders the *real* call.
//! * The WebView's answer / hang-up (`telephony_answer` / `telephony_end`) are routed
//!   here when the in-call service is actually bound → we call the Kotlin static
//!   `answerActive()` / `hangUpActive()` on the real call; otherwise `telephony.rs`
//!   falls back to the daemon (mock/demo) path.
//!
//! Honest boundary: this only functions once the user has made AmOS the default phone
//! app (so Android binds `AmosInCallService`). Until then these are no-ops that report
//! "not the default dialer" and the daemon path remains.

use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use jni::objects::{GlobalRef, JObject, JString};
use jni::sys::{jboolean, jobject, jstring};
use jni::{JNIEnv, JavaVM};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::clipboard::require_foreground;
use crate::error::{AmosError, ErrorCode};
use crate::recording;
use crate::telephony::{TelephonyCallPayload, TELEPHONY_EVENT};
use crate::wm::WmState;

/// The process `AppHandle`, set once from `lib.rs::setup` so a JNI-threaded upcall can
/// emit a WebView event. Mirrors `flashlight::install_ui_pusher`.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// The daemon/process `JavaVM`, captured on the first upcall so `telephony_answer` /
/// `telephony_end` can attach and call the Kotlin control statics.
static VM: OnceLock<JavaVM> = OnceLock::new();

/// The `AmosInCallService` class, captured as a global ref on the first `nativeState`
/// upcall (from the receiver's own class — see the upcall).
///
/// A command reaches this module from a tokio worker. Resolving the class *there* would
/// have to go through `JNIEnv::find_class`, which uses the **calling thread's** class
/// loader: the bootstrap one on a worker, so the resolution fails with
/// `ClassNotFoundException`. That failure is not merely a dead command — the pending
/// exception poisons the *next* JNI call on the same pooled thread, and a device round
/// proved the process aborts on it (REQ-A185). The `jni-exception-scan` allowlist recorded
/// this file's `find_class` with the follow-up "capture the jclass at upcall time"; this is
/// that fix (REQ-A1448), and it removes the `find_class` outright.
static CLASS: OnceLock<GlobalRef> = OnceLock::new();

/// The cached glue class, or an error naming the honest boundary.
///
/// A missing class is the same boundary a missing [`VM`] is: nothing has pushed a call
/// state, so no in-call service is bound and Android has not handed us a call. Returning
/// the error — rather than falling back to a resolution that would fail (and poison the
/// thread) — is the whole point of capturing it.
fn cached_class() -> Result<&'static GlobalRef, String> {
    CLASS.get().ok_or_else(|| {
        "the AmosInCallService class has not been captured yet (no call-state upcall has run \
         on a Java thread)"
            .to_string()
    })
}

/// Whether an in-call service instance is currently bound (i.e. we are the active
/// default-dialer and Android handed us a live Telecom call).
pub fn is_default_dialer_bound() -> bool {
    // Ask the Kotlin side whether its service instance is alive.
    call_static_bool("isServiceBound").unwrap_or(false)
}

/// Whether the `RECORD_AUDIO` runtime permission is granted — the capability half of
/// [`crate::recording::capture_facts`]. False when nothing is bound (no service to ask).
pub fn is_mic_granted() -> bool {
    call_static_bool("isMicGranted").unwrap_or(false)
}

// ─── the recording session (REQ-A1579 / F-TEL-038) ────────────────────────────────────────
//
// The Kotlin recorder mints the file and reports `"<id>|<startedAtMs>|<source>"` back through a
// one-shot getter when it stops; Rust files the ledger row. Two pieces of state make that row
// attributable:
//
// * the **peer** of the call being recorded. The upcall carries it, but the payload is emitted
//   and dropped, so it has to be remembered here. Only a *non-empty* peer overwrites: an upcall
//   whose `Details` is null reports `""`, which is "no claim" (the same absent-value rule the
//   payload fields follow), not "the peer is now nobody".
// * the **open session** — the peer of the call a recording is running on, stamped when the
//   device accepted a start. The peer is taken from the session at stop, not from the live
//   [`LAST_PEER`], so a call that began after an empty-peer push cannot be credited with the
//   *previous* call's peer. (The start **time** is not kept here: the glue reports its own, and
//   it is the one that was there when the recorder started.)

/// The peer of the newest real call push, or `""` if none has been seen.
static LAST_PEER: OnceLock<Mutex<String>> = OnceLock::new();

fn last_peer() -> &'static Mutex<String> {
    LAST_PEER.get_or_init(|| Mutex::new(String::new()))
}

/// Remember [peer] unless it is empty. Poison-recovering: a panic elsewhere must not make the
/// peer permanently unreadable (the `SharedStore` rule).
fn remember_peer(peer: &str) {
    if peer.is_empty() {
        return;
    }
    let mut guard = last_peer().lock().unwrap_or_else(|e| e.into_inner());
    *guard = peer.to_string();
}

fn known_peer() -> String {
    last_peer()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|e| e.into_inner().clone())
}

/// The peer of the call a recording is currently running on, or `None` when none is open.
static RECORDING: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn recording_slot() -> &'static Mutex<Option<String>> {
    RECORDING.get_or_init(|| Mutex::new(None))
}

/// Take the open session (leaving the slot empty). Poison-recovering, like [`remember_peer`].
fn take_session() -> Option<String> {
    recording_slot()
        .lock()
        .map(|mut g| g.take())
        .unwrap_or_else(|e| e.into_inner().take())
}

/// Replace the open session with [peer]. Poison-recovering.
fn set_session(peer: String) {
    let mut guard = recording_slot().lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(peer);
}

/// The audio sources [`parse_recording_report`] accepts — the two words
/// `AmosInCallService.beginRecording` records (`voice_call` when the privileged
/// `CAPTURE_AUDIO_OUTPUT` was granted, `voice_communication` otherwise).
const RECORDING_SOURCES: [&str; 2] = ["voice_call", "voice_communication"];

/// A finished recording, as the Kotlin glue reports it (`"<id>|<startedAtMs>|<source>"`).
#[derive(Clone, Debug, PartialEq, Eq)]
struct FinishedRecording {
    id: String,
    started_at_ms: i64,
    source: String,
}

/// Parse the glue's finished-recording report. **Fail-closed**: anything that is not exactly
/// three well-formed fields is an error, never a guessed id or a defaulted source — a malformed
/// report must not file a row pointing at the wrong file.
fn parse_recording_report(report: &str) -> Result<FinishedRecording, String> {
    let mut parts = report.split('|');
    let id = parts.next().unwrap_or_default();
    let started = parts.next().unwrap_or_default();
    let source = parts.next().unwrap_or_default();
    if parts.next().is_some() {
        return Err(format!("recording report has extra fields: {report:?}"));
    }
    if id.is_empty() {
        return Err(format!("recording report has an empty id: {report:?}"));
    }
    let started_at_ms: i64 = started
        .parse()
        .map_err(|_| format!("recording report has a non-numeric start time: {report:?}"))?;
    if started_at_ms < 0 {
        return Err(format!(
            "recording report has a negative start time: {report:?}"
        ));
    }
    if !RECORDING_SOURCES.contains(&source) {
        return Err(format!(
            "recording report has an unknown source: {report:?}"
        ));
    }
    Ok(FinishedRecording {
        id: id.to_string(),
        started_at_ms,
        source: source.to_string(),
    })
}

/// Whole seconds between the reported start and [now], never negative — a clock that moved
/// backwards must not produce a duration underflow.
fn duration_sec_from(started_at_ms: i64, now: i64) -> u32 {
    let ms = now.saturating_sub(started_at_ms).max(0);
    (ms / 1000) as u32
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// File one finished recording into the ledger, given the data root and the measured facts.
///
/// Split out from [`file_finished_recording`] so a host test can drive the whole decision with a
/// tempdir and no JVM. **Fail-closed at every step** — an empty report files nothing; a malformed
/// report, an id unusable as a path, or a missing/empty file are refusals, not rows. The audio
/// file is the ground truth for `file_size_bytes` (measured here, after the recorder released
/// it), and `duration_sec` is derived here from the glue's start time rather than trusted as a
/// field, so one clock decides it.
///
/// If the file exists but the ledger write fails, the file is **left in place** (deleting the
/// user's audio is worse) and the error names the surviving path — "on disk but not in the list"
/// is a fact the caller must be able to report.
fn file_recording_at(data: &Path, report: &str, peer: &str, now: i64) -> Result<(), AmosError> {
    if report.is_empty() {
        // No finished recording to file — the ordinary answer for a failed or absent stop.
        return Ok(());
    }
    let finished = parse_recording_report(report).map_err(|reason| {
        AmosError::new(
            ErrorCode::TelephonyRecordingRefused,
            format!("the recording could not be filed: {reason}"),
        )
    })?;
    let path = recording::recording_path(data, &finished.id).map_err(|e| {
        AmosError::with_cause(
            ErrorCode::TelephonyRecordingRefused,
            format!(
                "the recording id {:?} is not usable as a storage key — not filed",
                finished.id
            ),
            e,
        )
    })?;
    // A failed `metadata` is **not** the same fact as an empty file. ENOENT is a report naming a
    // file the recorder never left behind — "no audio is there" is true — but EACCES / EIO /
    // ENOTDIR is a file this code never managed to look at, and folding those into `0` made the
    // refusal below assert a cause it had not established. The same pair already has two
    // sentences one recorder over (`screen_record.rs::confirm_written`: `None` = "wrote no file",
    // `Some(0)` = "wrote an empty file"), and both siblings in this function (`recording_path`,
    // `add_recording`) name the failure they saw.
    let size = match std::fs::metadata(&path) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => {
            return Err(AmosError::with_cause(
                ErrorCode::TelephonyRecordingRefused,
                format!(
                    "the recorder reported a finished recording but its file at {} could not be read — not filed",
                    path.display()
                ),
                e,
            ))
        }
    };
    if size == 0 {
        return Err(AmosError::new(
            ErrorCode::TelephonyRecordingRefused,
            format!(
                "the recorder reported a finished recording but no audio is at {} — not filed",
                path.display()
            ),
        ));
    }
    let meta = recording::RecordingMeta {
        call_id: finished.id,
        peer: peer.to_string(),
        started_at: finished.started_at_ms / 1000,
        duration_sec: duration_sec_from(finished.started_at_ms, now),
        file_size_bytes: size,
        source: Some(finished.source),
    };
    recording::add_recording(data, meta).map_err(|e| {
        AmosError::with_cause(
            ErrorCode::TelephonyRecordingRefused,
            format!(
                "the recording is on disk at {} but could not be filed in the ledger",
                path.display()
            ),
            e,
        )
    })
}

/// Read the finished-recording report from the glue and file it under [peer].
///
/// Private: [`real_set_recording`] is the only caller, and it supplies the session's peer.
/// A missing `APP` (no setup) or a JVM that has not captured the class is an honest refusal —
/// the same boundary every other call in this module draws.
fn file_finished_recording(peer: &str) -> Result<(), AmosError> {
    let report = call_static_string("recordingResult").map_err(|reason| {
        AmosError::new(
            ErrorCode::TelephonyRecordingRefused,
            format!("the recording could not be filed: {reason}"),
        )
    })?;
    if report.is_empty() {
        return Ok(());
    }
    let app = APP.get().ok_or_else(|| {
        AmosError::new(
            ErrorCode::TelephonyRecordingRefused,
            "the recording could not be filed: no app handle is installed",
        )
    })?;
    let data = recording::app_data_root(app).map_err(|reason| {
        AmosError::new(
            ErrorCode::TelephonyRecordingRefused,
            format!("the recording could not be filed: {reason}"),
        )
    })?;
    file_recording_at(&data, &report, peer, now_ms())
}

/// Hand the seam an `AppHandle` (from `lib.rs::setup`) for live WebView pushes.
pub fn set_app(app: AppHandle) {
    // Exactly-once: a redundant re-attach keeps the first one (REQ-A187 baseline).
    let _ = APP.set(app);
}

/// Stamp the platform's own mute / speaker facts onto [payload].
///
/// `known == false` means the Kotlin bridge could not read a `CallAudioState` for this push
/// (the platform's own "no call has audio"). That is **not** the same fact as "the call is
/// unmuted and on the earpiece", so it leaves both fields absent — the wire's "no claim" —
/// rather than writing `false` for a fact nothing measured. Claiming `false` would light the
/// speaker key dark over a call the platform routed to the loudspeaker, which is exactly the
/// failure the absent-value rule exists to prevent (REQ-A1268 / F-TEL-028).
///
/// Pure and per-push: the bridge reads the platform's state each time it pushes, so nothing
/// is remembered here — a remembered fact would outlive the call that made it true.
fn apply_audio_facts(payload: &mut TelephonyCallPayload, muted: bool, speaker: bool, known: bool) {
    if !known {
        return;
    }
    payload.muted = Some(muted);
    payload.speaker = Some(speaker);
}

/// What a `java.lang.String` local ref read back as — **three** answers, because they are
/// three different facts (P1-T2 / REQ-A1871).
///
/// The fold this replaces (`env.get_string(&j).map(…).unwrap_or_default()`) made a failed
/// read indistinguishable from a legitimate empty string **and** left the JVM's pending
/// exception on the thread — the process-abort hazard `amos-jni` exists to prevent (a
/// pending exception makes the *next* JNI call on a pooled thread abort under CheckJNI,
/// REQ-A185). Each caller reads a *different* meaning into `""`, so each one needs the
/// distinction:
///
/// * the upcall's `peer` / `direction` / `state` — `""` is "this push claims nothing";
/// * `call_static_string`'s recording report — `""` is "nothing was recorded, file nothing";
/// * `call_static_toggle`'s answer — `""` is "the glue answered with no word".
#[derive(Clone, Debug, PartialEq, Eq)]
enum StringRead {
    /// The ref was `null` — Kotlin's "no claim" (a `Details`-less upcall).
    Absent,
    /// A real `java.lang.String`, possibly empty.
    Text(String),
    /// `JNIEnv::get_string` itself failed (the ref was not a String, or the VM refused).
    /// `detail` is the JNI error, kept so a surface can name *this* failure instead of the
    /// empty answer it used to be folded into.
    Unreadable(String),
}

fn read_string(env: &mut JNIEnv<'_>, s: jstring) -> StringRead {
    if s.is_null() {
        return StringRead::Absent;
    }
    // SAFETY: `s` is a live java.lang.String local ref for the duration of the call.
    let j = unsafe { JString::from_raw(s) };
    // Through [`amos_jni::jni_call!`]: a failed read must not leave an exception pending on
    // this thread, or the next JNI call on a pooled worker aborts the whole process
    // (REQ-A185). The old `unwrap_or_default()` cleared nothing.
    let read = match amos_jni::jni_call!(env, env.get_string(&j)) {
        Ok(x) => StringRead::Text(x.into()),
        Err(e) => StringRead::Unreadable(e.to_string()),
    };
    read
}

/// Read one upcall field, carrying an unreadable one as the payload's empty "no claim".
///
/// The upcall is a JNI `extern "system"` function and returns nothing, so this boundary
/// cannot refuse. It **logs** the unreadable case rather than silently folding it into the
/// same `""` a legitimate "no claim" carries — the reading that made the fold invisible
/// (P1-T2).
fn read_field(env: &mut JNIEnv<'_>, s: jstring, field: &str) -> String {
    match read_string(env, s) {
        StringRead::Text(v) => v,
        StringRead::Absent => String::new(),
        StringRead::Unreadable(detail) => {
            tracing::warn!(
                target: "amos::telephony",
                field,
                detail = %detail,
                "in-call upcall field could not be read; carried as the empty no-claim value"
            );
            String::new()
        }
    }
}

/// `AmosInCallService.nativeState(direction, state, peer, muted, speaker, known)` — the
/// Kotlin in-call service pushes every real Telecom call-state change here; we forward it to
/// the WebView as `telephony-event` (same payload the daemon Watch emits, so the existing
/// IncomingCall / in-call UI just works for real calls).
///
/// The trailing three arguments are the platform's own audio facts, read by the bridge from
/// `getCallAudioState()` on **this** push — the mute / route the call is actually on, which
/// includes changes the app never asked for (a headset connecting, the system in-call UI).
/// Before them the upcall carried only direction / state / peer, so the one callback that
/// fires exactly when the device's route changes had nowhere to say so and the screen went on
/// showing the user's last command (REQ-A1268 / F-TEL-028).
///
/// # Safety
/// `env`/`this` are the standard JNI instance-method args; the `jstring`s are live
/// local refs valid for the duration of the call.
#[cfg(feature = "android")]
#[no_mangle]
pub unsafe extern "system" fn Java_com_amos_ai_glue_AmosInCallService_nativeState(
    env: *mut jni::sys::JNIEnv,
    this: jobject,
    direction: jstring,
    state: jstring,
    peer: jstring,
    muted: jboolean,
    speaker: jboolean,
    known: jboolean,
) {
    // SAFETY: called from the Java glue with the real `JNIEnv*` of this (already
    // attached) thread; `from_raw` only wraps it for the duration of this function, and
    // the pointer is never used after the env value is dropped. A null/garbage env is
    // rejected by the `Ok(...)` check instead of being dereferenced.
    let Ok(mut env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
        return;
    };
    if let Ok(vm) = env.get_java_vm() {
        // Exactly-once: a redundant re-attach keeps the first one (REQ-A187 baseline).
        let _ = VM.set(vm);
    }
    // Capture the glue class *here*, on a Java thread, so the command path never has to
    // resolve it from a tokio worker (see [`CLASS`]). The receiver's own class is the
    // answer: no `find_class`, so no class-name string that can drift and no bootstrap
    // loader to fail on.
    if CLASS.get().is_none() && !this.is_null() {
        // SAFETY: `this` is the live `AmosInCallService` instance JNI passes to this
        // instance method (the Kotlin declaration is a plain class member, not a
        // `companion object` one); `from_raw` only wraps it for the duration of this block.
        let this = unsafe { JObject::from_raw(this) };
        if let Ok(class) = amos_jni::jni_call!(env, env.get_object_class(&this)) {
            if let Ok(global) = env.new_global_ref(class) {
                let _ = CLASS.set(global);
            }
        }
    }
    let direction = read_field(&mut env, direction, "direction");
    let state = read_field(&mut env, state, "state");
    let peer = read_field(&mut env, peer, "peer");
    // Remember the peer for the recording ledger (REQ-A1579). The payload below is emitted and
    // dropped, so a later `Off` has nothing left to attribute the row to. Only a non-empty peer
    // overwrites: an upcall whose `Details` is null reports `""`, the "no claim" value, not
    // "the peer is now nobody".
    remember_peer(&peer);
    if let Some(app) = APP.get() {
        let mut payload = TelephonyCallPayload {
            id: "real".to_string(),
            peer,
            state,
            direction,
            emergency: false,
            // The upcall says nothing about recording. Claiming `Some("Off")` here reset the
            // UI's recording indicator to Off on *every* state change, including the ones the
            // in-call toggles themselves provoke (`hold`/`speaker`/`mute` all call
            // `onCallStateChanged`), so a user who had just started recording watched it
            // silently clear. Absent is the field's "no claim" value; see
            // `TelephonyCallPayload::recording`.
            recording: None,
            // Mute / speaker are measured by this push — the platform's own facts, threaded
            // through by the Kotlin bridge. They are stamped below rather than defaulted to
            // `None` so the two fields this upcall *did* observe are not left silent.
            muted: None,
            speaker: None,
            // Hold is not part of `CallAudioState`: this upcall measures nothing about it, so
            // an externally-originated hold stays unreported here (docs/telephony.md §12 #28).
            hold: None,
        };
        apply_audio_facts(&mut payload, muted != 0, speaker != 0, known != 0);
        // The UI's in-call screen is driven by this event; a failed emit means the call
        // would sit in the background with no visible state (REQ-A187).
        if let Err(e) = app.emit(TELEPHONY_EVENT, payload) {
            tracing::warn!(
                target: "amos::telephony",
                error = %e,
                "in-call state event not delivered to the UI"
            );
        }
    }
}

/// Call a `public static` boolean method on the Kotlin `AmosInCallService` companion.
fn call_static_bool(method: &str) -> Result<bool, String> {
    let vm = VM
        .get()
        .ok_or_else(|| "in-call JVM not captured yet".to_string())?;
    // The class was resolved at upcall time (a Java thread); a tokio worker cannot resolve
    // it with `find_class` (REQ-A1448). Missing ⇒ nothing is bound, an honest error.
    let class = cached_class()?;
    // Shared helper: attach with a clean exception state (REQ-A186).
    let mut env = amos_jni::attached(vm).map_err(|e| format!("in-call attach failed: {e}"))?;
    let value = amos_jni::jni_call!(env, env.call_static_method(class, method, "()Z", &[]))
        .map_err(|e| e.to_string())?;
    value.z().map_err(|e| e.to_string())
}

/// Call a `public static` String method on the Kotlin `AmosInCallService` companion.
///
/// The recording seam's one-shot report getter ([`file_finished_recording`]) is the only caller.
/// A `java.lang.String` reply is lifted through `read_string`; a `null` ref is the glue's
/// "nothing to report" and becomes `Ok("")`, but a **failed read** is an `Err` — the two are
/// different facts and the caller files nothing for the first (P1-T2 / REQ-A1871).
fn call_static_string(method: &str) -> Result<String, String> {
    let vm = VM
        .get()
        .ok_or_else(|| "in-call JVM not captured yet".to_string())?;
    // Resolved at upcall time; see `call_static_bool` (REQ-A1448).
    let class = cached_class()?;
    let mut env = amos_jni::attached(vm).map_err(|e| format!("in-call attach failed: {e}"))?;
    let value = amos_jni::jni_call!(
        env,
        env.call_static_method(class, method, "()Ljava/lang/String;", &[])
    )
    .map_err(|e| e.to_string())?;
    let raw_obj = value.l().map_err(|e| e.to_string())?;
    let raw_jstring = raw_obj.as_raw() as jni::sys::jstring;
    // A failed read is an **error**, not the empty report: `file_finished_recording` files
    // nothing for an empty report, so folding an unreadable answer into `""` silently dropped
    // the ledger row for an audio file the glue had already minted (P1-T2 / REQ-A1871).
    report_from_read(read_string(&mut env, raw_jstring))
        .map_err(|detail| format!("the {method} answer could not be read from the glue: {detail}"))
}

/// Turn a [read](read_string) answer into the recording report, keeping "the glue reported
/// nothing" (`Absent`, or a real empty String) apart from "the answer could not be read" (an
/// error whose value is the JNI detail).
///
/// Not cosmetic: [`file_finished_recording`] files **nothing** for an empty report, so folding
/// an unreadable answer into `""` silently dropped the ledger row for an audio file the glue had
/// already minted — the file exists but nothing points at it (P1-T2 / REQ-A1871). Pure, so the
/// distinction has a red-first without a JVM.
fn report_from_read(read: StringRead) -> Result<String, String> {
    match read {
        StringRead::Text(s) => Ok(s),
        StringRead::Absent => Ok(String::new()),
        StringRead::Unreadable(detail) => Err(detail),
    }
}

/// Answer the real ringing call. `true` = a bound in-call service answered it.
pub fn real_answer() -> Result<bool, String> {
    call_static_bool("answerActive")
}

/// Hang up the real active call. `true` = a bound in-call service ended it.
pub fn real_hang_up() -> Result<bool, String> {
    call_static_bool("hangUpActive")
}

/// The set of states the Kotlin glue may answer for an in-call **toggle** (recording /
/// mute / loudspeaker / hold).
///
/// The wire shape mirrors the daemon's `TelephonyEvent.recording` field (a String holding one
/// of `Off` / `On` / `Failed`); an unrecognised word is **`Unknown(reason)`** rather than rounded
/// up to a success — the "user thought they were recording but the device refused" failure is the
/// canonical FMEA F-TEL-001 shape, and the surface here must keep it visible to the UI.
///
/// Every toggle that answers in this vocabulary shares the type (a single word↔arm binding with
/// one owner), because the failure each one must not round up is the same failure.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "state", content = "detail")]
pub enum ToggleChange {
    /// Toggle accepted — the new state is on.
    On,
    /// Toggle accepted — the new state is off.
    Off,
    /// The toggle was refused by the device (storage full, permission lost, codec unsupported, a
    /// held call that cannot be held again, …).
    Failed,
    /// The Kotlin glue answered with a word we did not classify — surfaced verbatim.
    Unknown(String),
}

/// The recording seam's historical name for [`ToggleChange`]; kept so existing call sites and
/// tests read the same as before the vocabulary was shared with mute / speaker / hold.
pub type RecordingChange = ToggleChange;

/// Map a [read](read_string) toggle answer onto [`ToggleChange`], keeping the two
/// non-success answers **distinct** (P1-T2 / REQ-A1871).
///
/// The glue answering an empty word and the bridge failing to read the answer are different
/// facts, and only the first is "an empty toggle state". Folding them together told the user
/// the glue had answered nothing when in truth the read failed — a fabricated reason attached
/// to a refusal. Pure, so this distinction has a red-first without a JVM.
fn toggle_change_from_read(read: &StringRead) -> ToggleChange {
    match read {
        StringRead::Text(word) => toggle_change_from_state(word),
        StringRead::Absent => {
            ToggleChange::Unknown("the glue answered with an empty toggle state".to_string())
        }
        StringRead::Unreadable(detail) => ToggleChange::Unknown(format!(
            "the toggle answer could not be read from the glue: {detail}"
        )),
    }
}

/// Map the Kotlin `AmosInCallService` toggle answer (an `On` / `Off` / `Failed` string) onto the
/// typed [`ToggleChange`].
///
/// Pure, and pinned on both sides: `AmosInCallService.kt` spells these words; an unrecognised
/// word becomes `Unknown(...)` rather than rounded up — the same rule `alarm_sched.rs`'s
/// `device_outcome_from_status` follows for the parallel alarm glue.
pub fn toggle_change_from_state(state: &str) -> ToggleChange {
    match state {
        "On" => ToggleChange::On,
        "Off" => ToggleChange::Off,
        "Failed" => ToggleChange::Failed,
        "" => ToggleChange::Unknown("the glue answered with an empty toggle state".to_string()),
        other => ToggleChange::Unknown(other.to_string()),
    }
}

/// Map the Kotlin `AmosInCallService.setRecording(...)` answer onto [`ToggleChange`].
///
/// Kept as a named function because the recording path's word↔arm binding is pinned to the
/// Kotlin source by name (`the_recording_words_are_pinned_to_the_kotlin_source`); it now shares
/// the one parser above rather than carrying a second copy of the vocabulary.
pub fn recording_change_from_state(state: &str) -> RecordingChange {
    toggle_change_from_state(state)
}

/// Foreground-gated recording toggle — **the only public entry point a command may use**.
///
/// Two refusals sit in front of the device call, in this order, because each guards a
/// different failure:
/// * **F-TEL-001** — only the window the user is actually looking at may flip the record
///   button. A background app (or a hostile script in a background WebView) toggling call
///   recording is the privacy failure the repo gates every read path against, so the same
///   [`require_foreground`] rule `clipboard_read` uses applies here.
/// * **"not the default dialer"** — until the user grants AmOS `ROLE_DIALER`, Android has not
///   bound `AmosInCallService` and there is nothing to toggle. This is reported honestly
///   instead of letting the JNI call fail with a lower-level attach error or, worse,
///   reporting a recording that never started.
pub fn set_recording_for_window(
    active: bool,
    wm: &WmState,
    caller: &str,
) -> Result<RecordingChange, AmosError> {
    require_foreground(wm, caller).map_err(|e| {
        AmosError::with_cause(
            ErrorCode::TelephonyRecordingRefused,
            format!(
                "recording toggle denied: {e} (only the in-call window may record a call; \
                 F-TEL-001)"
            ),
            e,
        )
    })?;
    if !is_default_dialer_bound() {
        return Err(AmosError::new(
            ErrorCode::TelephonyRecordingRefused,
            "recording cannot be toggled: AmOS is not the default dialer, so no in-call \
             service is bound",
        ));
    }
    real_set_recording(active)
}

/// Call one of the Kotlin companion's `(Z)Ljava/lang/String;` toggle statics and map the answer
/// through [`toggle_change_from_state`].
///
/// One implementation for every in-call toggle (recording / mute / loudspeaker / hold): the JNI
/// dance and the "an unclassified word is `Unknown`, never rounded up to a success" rule are
/// identical, and a toggle differs only in which member to name, which typed error a failure
/// carries, and the human `label` a `tracing` consumer / the UI's cause chain reads.
///
/// Honest boundary (all four toggles): this only functions once the user has made AmOS the
/// default phone app (so Android binds `AmosInCallService`). Until then the answer is an honest
/// error — the same shape `real_answer` / `real_hang_up` follow — never a fabricated state.
fn call_static_toggle(
    method: &str,
    active: bool,
    code: ErrorCode,
    label: &str,
) -> Result<ToggleChange, AmosError> {
    let vm = VM.get().ok_or_else(|| {
        AmosError::new(
            code,
            format!("in-call JVM not captured yet (AmOS is not the default dialer) [{label}]"),
        )
    })?;
    // The class was resolved at upcall time (a Java thread); a tokio worker cannot resolve
    // it with `find_class` (REQ-A1448). Missing ⇒ nothing is bound, an honest error.
    let class =
        cached_class().map_err(|reason| AmosError::new(code, format!("{label}: {reason}")))?;
    let mut env = amos_jni::attached(vm)
        .map_err(|e| AmosError::with_cause(code, format!("{label}: in-call attach failed"), e))?;
    // The Kotlin glue is `(Z)Ljava/lang/String;` — a single boolean arg, one String answer.
    // `Z` is the JNI type code for `boolean`; we pass `1u8` for `true`, `0u8` for `false`
    // because `jboolean` is an unsigned byte in the JNI ABI.
    let arg = jni::objects::JValue::Bool(if active { 1u8 } else { 0u8 });
    let value = amos_jni::jni_call!(
        env,
        env.call_static_method(class, method, "(Z)Ljava/lang/String;", &[arg])
    )
    .map_err(|e| AmosError::with_cause(code, format!("{label}: the {method} call failed"), e))?;
    // The glue answers a `java.lang.String`; we extract it through the same `read_string` path
    // the upcall uses. The reply's *kind* is then decided by `toggle_change_from_read`, which
    // keeps "the glue answered no word" (`Absent`) apart from "the read failed" (`Unreadable`).
    let raw_obj = value.l().map_err(|e| {
        AmosError::with_cause(
            code,
            format!("{label}: the {method} reply was not a java.lang.String"),
            e,
        )
    })?;
    // `raw_obj` is a `JObject<'_>` local ref. `read_string` takes a raw `jstring`, so we lift
    // through `as_raw()` (which yields the underlying `jobject`); a null object is filtered
    // by `read_string` so a `null` glue answer maps to an empty string the same way it does on
    // the upcall path.
    let raw_jstring = raw_obj.as_raw() as jni::sys::jstring;
    let state = read_string(&mut env, raw_jstring);
    Ok(toggle_change_from_read(&state))
}

/// Toggle recording on the real active call.
///
/// `true` means start, `false` means stop. The answer is a typed [`RecordingChange`] —
/// *not* a bare `bool`, because a "set true, get false" reply means the device refused the
/// toggle and the UI must say so (the user-facing button is now off but they pressed "record").
///
/// A **successful** toggle also opens / closes the Rust-side session (REQ-A1579): a `On` stamps
/// the peer the call is on, so the ledger row written at `Off` names *this* call's peer rather
/// than whoever the sticky [`LAST_PEER`] happens to hold; an `Off` drains the glue's one-shot
/// report and files it. A refusal (`Failed` / `Unknown`) touches neither — nothing was recorded,
/// so there is nothing to attribute and nothing to file.
///
/// This is the ungated JNI primitive: callers that can see the window manager must go through
/// [`set_recording_for_window`] instead, which enforces the foreground rule.
pub fn real_set_recording(active: bool) -> Result<RecordingChange, AmosError> {
    let change = call_static_toggle(
        "setRecording",
        active,
        ErrorCode::TelephonyRecordingRefused,
        "in-call recording",
    )?;
    match (&change, active) {
        (RecordingChange::On, true) => set_session(known_peer()),
        (RecordingChange::Off, false) => {
            let peer = take_session().unwrap_or_else(known_peer);
            file_finished_recording(&peer)?;
        }
        // A refused / unclassified word or a mismatched direction: the device did not act, so
        // there is no session to open and no report to file. Filing anyway would credit a row to
        // a toggle that never happened.
        _ => {}
    }
    Ok(change)
}

/// Mute (`true`) or unmute (`false`) the real call's local microphone.
///
/// This is the in-call **mute** bridge the mute refusal comment used to describe as
/// missing (P3): with a bound `AmosInCallService` the platform's own
/// `InCallService#setMuted(boolean)` performs it. Unlike recording there is no foreground
/// gate — silencing one's own microphone is not a privacy leak, and it is allowed on an
/// emergency line (docs/telephony.md §6).
pub fn real_set_muted(active: bool) -> Result<ToggleChange, AmosError> {
    call_static_toggle(
        "muteActive",
        active,
        ErrorCode::TelephonyMuteRefused,
        "in-call mute",
    )
}

/// Route the real call's audio to the loudspeaker (`true`) or the earpiece (`false`).
pub fn real_set_speaker(active: bool) -> Result<ToggleChange, AmosError> {
    call_static_toggle(
        "speakerActive",
        active,
        ErrorCode::TelephonySpeakerRefused,
        "in-call speaker",
    )
}

/// Put the real call on hold (`true`) or take it off hold (`false`).
pub fn real_set_hold(active: bool) -> Result<ToggleChange, AmosError> {
    call_static_toggle(
        "holdActive",
        active,
        ErrorCode::TelephonyHoldRefused,
        "in-call hold",
    )
}

/// Send one DTMF tone to the real active call (`true` = Telecom accepted it).
///
/// Without a bound in-call service there is **no** DTMF path at all: the daemon (mock) transport
/// has no audio, so a tone cannot reach the call. The caller must therefore treat `Err` as "the
/// tone did not go out" rather than pretending an IVR heard it.
///
/// The alphabet and its validator live in [`crate::telephony`] rather than here, because the
/// `telephony_play_dtmf` command must refuse a malformed tone on **every** build — this module
/// is `#[cfg(feature = "android")]`, so a copy here would leave the desktop build validating
/// nothing.
pub fn real_play_dtmf(tone: &str) -> Result<bool, AmosError> {
    if !crate::telephony::is_dtmf_tone(tone) {
        return Err(AmosError::new(
            ErrorCode::TelephonyDtmfRefused,
            format!("in-call DTMF: {tone:?} is not a single DTMF tone character"),
        ));
    }
    let vm = VM.get().ok_or_else(|| {
        AmosError::new(
            ErrorCode::TelephonyDtmfRefused,
            "in-call JVM not captured yet (AmOS is not the default dialer)",
        )
    })?;
    let mut env = amos_jni::attached(vm).map_err(|e| {
        AmosError::with_cause(
            ErrorCode::TelephonyDtmfRefused,
            "in-call DTMF: attach failed",
            e,
        )
    })?;
    // Resolved at upcall time; see `call_static_bool` (REQ-A1448).
    let class = cached_class().map_err(|reason| {
        AmosError::new(
            ErrorCode::TelephonyDtmfRefused,
            format!("in-call DTMF: {reason}"),
        )
    })?;
    let jarg = env.new_string(tone).map_err(|e| {
        AmosError::with_cause(
            ErrorCode::TelephonyDtmfRefused,
            "in-call DTMF: new_string failed",
            e,
        )
    })?;
    // The Kotlin glue is `(Ljava/lang/String;)Z` — one tone string in, one boolean answer.
    let value = amos_jni::jni_call!(
        env,
        env.call_static_method(
            class,
            "playDtmf",
            "(Ljava/lang/String;)Z",
            &[jni::objects::JValue::Object(&jarg)],
        )
    )
    .map_err(|e| {
        AmosError::with_cause(
            ErrorCode::TelephonyDtmfRefused,
            "in-call DTMF: the playDtmf call failed",
            e,
        )
    })?;
    value.z().map_err(|e| {
        AmosError::with_cause(
            ErrorCode::TelephonyDtmfRefused,
            "in-call DTMF: the playDtmf reply was not a boolean",
            e,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The JNI trampolines themselves need a real JVM to exercise, but the payload
    // shape and the `TelephonyCallPayload` fields the bridge hands the WebView
    // are pure logic and must hold their guarantees without one. The on-device
    // `VM`/`APP` OnceLocks are process-global and a parallel test could
    // legitimately populate them (the `lib.rs` setup does so on Android), so the
    // JVM-not-captured assertion is **not** a unit test — it is a property the
    // code holds in isolation, observed in a freshly-spawned process. Skipping it
    // here is intentional; the device-side `scripts/android-glue-check` gate is
    // where that scenario lives.

    #[test]
    fn empty_direction_is_preserved_and_forwarded_as_is() {
        // `read_string` returns `""` for a null jstring — the payload carries that
        // empty string through (the frontend classifies it via its own state
        // machine), rather than silently turning it into "Outgoing".
        let payload = TelephonyCallPayload {
            id: "real".to_string(),
            peer: String::new(),
            state: String::new(),
            direction: String::new(),
            emergency: false,
            recording: Some("Off".to_string()),
            muted: None,
            speaker: None,
            hold: None,
        };
        assert_eq!(payload.direction, "");
        assert_eq!(payload.state, "");
        assert_eq!(payload.peer, "");
        assert_eq!(
            payload.recording.as_deref(),
            Some("Off"),
            "recording defaults to Off"
        );
        assert!(!payload.emergency);
    }

    #[test]
    fn payload_round_trips_through_serde() {
        // The Tauri event bus serializes via serde_json; a malformed payload that
        // doesn't serialize would fail silently at emit time and leave the UI
        // frozen. Verify the public wire shape.
        let p = TelephonyCallPayload {
            id: "real".into(),
            peer: "+8613800138000".into(),
            state: "Active".into(),
            direction: "Outgoing".into(),
            emergency: false,
            recording: Some("On".into()),
            muted: None,
            speaker: None,
            hold: None,
        };
        let j = serde_json::to_string(&p).expect("serialize");
        // Every field the WebView's `IncomingCall` overlay reads must be present.
        for needle in [
            "\"id\":\"real\"",
            "\"peer\":\"+8613800138000\"",
            "\"state\":\"Active\"",
            "\"direction\":\"Outgoing\"",
            "\"emergency\":false",
            "\"recording\":\"On\"",
        ] {
            assert!(j.contains(needle), "missing {needle} in payload: {j}");
        }
    }

    #[test]
    fn payload_emergency_round_trip_is_honest() {
        // The Kotlin in-call service may flag emergency lines; the bridge must
        // carry that bit through unchanged (it is used by the UI to suppress the
        // record button on emergency calls).
        let p = TelephonyCallPayload {
            id: "real".into(),
            peer: "110".into(),
            state: "Active".into(),
            direction: "Incoming".into(),
            emergency: true,
            recording: Some("Off".into()),
            muted: None,
            speaker: None,
            hold: None,
        };
        let j = serde_json::to_string(&p).expect("serialize");
        assert!(j.contains("\"emergency\":true"));
    }

    // ---- RecordingChange / setRecording (REQ-A540) --------------------------

    /// The Kotlin glue's `RecordingState` words are a Kotlin↔Rust contract: `AmosInCallService.kt`
    /// spells `On` / `Off` / `Failed`, `recording_change_from_state` maps them, and a drift on
    /// either side would silently round a refusal into a success — the F-TEL-001 shape.
    #[test]
    fn recording_change_from_state_parses_the_glue_recording_words() {
        assert_eq!(recording_change_from_state("On"), RecordingChange::On);
        assert_eq!(recording_change_from_state("Off"), RecordingChange::Off);
        assert_eq!(
            recording_change_from_state("Failed"),
            RecordingChange::Failed
        );
        // Empty / unknown words must NOT be rounded up.
        assert_eq!(
            recording_change_from_state(""),
            RecordingChange::Unknown("the glue answered with an empty toggle state".to_string())
        );
        assert_eq!(
            recording_change_from_state("Recording"),
            RecordingChange::Unknown("Recording".to_string())
        );
        // The confusion this whole function exists to prevent.
        assert_ne!(recording_change_from_state("Failed"), RecordingChange::On);
    }

    /// The serialized shape the WebView reads (a tagged `state` + an optional `detail`
    /// string). A `RecordingChange::On` serialises as `{"state":"on"}` — the camel/snake
    /// boundary is exactly the place a frontend/backend mismatch would hide a refusal.
    #[test]
    fn recording_change_serializes_with_tagged_state_field() {
        let j_on = serde_json::to_value(&RecordingChange::On).expect("On");
        assert_eq!(j_on["state"], "on");
        assert!(j_on.get("detail").is_none() || j_on["detail"].is_null());

        let j_off = serde_json::to_value(&RecordingChange::Off).expect("Off");
        assert_eq!(j_off["state"], "off");

        let j_failed = serde_json::to_value(&RecordingChange::Failed).expect("Failed");
        assert_eq!(j_failed["state"], "failed");

        let j_unknown =
            serde_json::to_value(&RecordingChange::Unknown("codec-unsupported".to_string()))
                .expect("Unknown");
        assert_eq!(j_unknown["state"], "unknown");
        assert_eq!(j_unknown["detail"], "codec-unsupported");
    }

    /// The empty answer is the canonical negative control (TODO 1.3): a JNI stub that returns
    /// `""` must surface as `Unknown("…empty…")`, never as `Off`/`On`. If this ever rounded up,
    /// the "recording is off" claim would be a fabrication.
    #[test]
    fn empty_string_recording_state_is_unknown_not_a_success() {
        let change = recording_change_from_state("");
        match &change {
            RecordingChange::Unknown(reason) => {
                assert!(
                    reason.contains("empty"),
                    "reason names the empty answer: {reason}"
                );
            }
            other => panic!("empty must be Unknown, got {other:?}"),
        }
        assert_ne!(change, RecordingChange::On);
        assert_ne!(change, RecordingChange::Off);
    }

    /// P1-T2 (REQ-A1871): the glue answering **an empty word** and the bridge **failing to read
    /// the answer** are different facts. Before the fix both became
    /// `Unknown("the glue answered with an empty toggle state")`, so a failed JNI read was
    /// reported to the user as the glue having answered nothing — a fabricated reason attached
    /// to a refusal. The two non-success answers must stay distinct.
    #[test]
    fn an_unreadable_toggle_answer_is_not_reported_as_an_empty_word() {
        let unreadable = StringRead::Unreadable("JNIEnv::get_string failed".to_string());
        let change = toggle_change_from_read(&unreadable);
        match &change {
            ToggleChange::Unknown(reason) => {
                assert!(
                    !reason.contains("empty toggle state"),
                    "a failed read must not be reported as the glue answering nothing: {reason}"
                );
                assert!(
                    reason.contains("could not be read"),
                    "the reason names the read failure: {reason}"
                );
            }
            other => panic!("an unreadable answer must be Unknown, got {other:?}"),
        }
        assert_ne!(change, ToggleChange::On);
        assert_ne!(change, ToggleChange::Off);
        assert_ne!(
            toggle_change_from_read(&StringRead::Absent),
            change,
            "the empty answer and the failed read are different facts"
        );
    }

    /// Positive control for the arm above: the glue *answering an empty word* (`Absent`, i.e. a
    /// null ref) keeps its own reason, and a classified word still maps as before — the fix must
    /// not swallow the legitimate empty answer into the read-failure branch.
    #[test]
    fn an_absent_toggle_answer_keeps_the_empty_state_reason() {
        match toggle_change_from_read(&StringRead::Absent) {
            ToggleChange::Unknown(reason) => {
                assert!(
                    reason.contains("empty toggle state"),
                    "the empty answer keeps its own reason: {reason}"
                );
            }
            other => panic!("absent must be Unknown, got {other:?}"),
        }
        assert_eq!(
            toggle_change_from_read(&StringRead::Text("On".into())),
            ToggleChange::On
        );
        assert_eq!(
            toggle_change_from_read(&StringRead::Text("Failed".into())),
            ToggleChange::Failed
        );
    }

    /// P1-T2 (REQ-A1871), second consequence: an **unreadable** recording report is an error,
    /// not the empty report. `file_finished_recording` files nothing for `""`, so folding the
    /// failed read into `""` dropped the ledger row for an audio file the glue had already
    /// minted — the recording existed on disk with nothing pointing at it.
    #[test]
    fn an_unreadable_recording_report_is_an_error_not_an_empty_report() {
        let err = report_from_read(StringRead::Unreadable(
            "JNIEnv::get_string failed".to_string(),
        ))
        .expect_err("a failed read must not become the empty report");
        assert!(
            err.contains("get_string"),
            "the error carries the JNI detail: {err}"
        );
        // The legitimate "nothing to report" answers stay `Ok("")` — the fix must not turn a
        // null or an empty report into a refusal.
        assert_eq!(
            report_from_read(StringRead::Absent).expect("absent is nothing to report"),
            ""
        );
        assert_eq!(
            report_from_read(StringRead::Text(String::new())).expect("empty is nothing to report"),
            ""
        );
        assert_eq!(
            report_from_read(StringRead::Text("abc|123|voice_call".into()))
                .expect("a report is read as-is"),
            "abc|123|voice_call"
        );
        assert_ne!(
            report_from_read(StringRead::Unreadable("boom".into())),
            report_from_read(StringRead::Absent),
            "a failed read and 'nothing to report' are different facts"
        );
    }

    /// The **clearing** half of P1-T2 has no JVM-free test (the guarantee is "the read is
    /// wrapped in `amos-jni`'s clearing macro"), so pin the source: `read_string` must lift the
    /// string through `amos_jni::jni_call!`. Without it a failed `get_string` leaves an
    /// exception pending, and the next JNI call on the pooled thread aborts the process
    /// (REQ-A185). The old `unwrap_or_default()` form cleared nothing.
    #[test]
    fn read_string_lifts_through_the_clearing_macro() {
        const SRC: &str = include_str!("incall.rs");
        let body = fn_body(SRC, "fn read_string(");
        // Strip `//` comments before judging: this function's own doc line names the old
        // `unwrap_or_default()` form, so reading raw text would let a comment decide the
        // verdict (the verdict-gate-corpus hazard, REQ-A1707).
        let code: String = body
            .lines()
            .map(|l| l.split("//").next().unwrap_or(l))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            code.contains("jni_call!(env, env.get_string(&j))"),
            "read_string must route get_string through the clearing macro:\n{code}"
        );
        assert!(
            !code.contains("unwrap_or_default()"),
            "the fold that discarded the failure must not come back:\n{code}"
        );
    }

    /// Extract a function body from Rust source by brace counting from its signature. Test-only;
    /// the same shape `sms.rs` uses to pin its command bodies.
    fn fn_body<'a>(src: &'a str, signature: &str) -> &'a str {
        let start = src
            .find(signature)
            .unwrap_or_else(|| panic!("signature not found: {signature}"));
        let rest = &src[start..];
        let open = rest.find('{').expect("no body brace");
        let mut depth = 0usize;
        for (i, ch) in rest[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &rest[open..open + i + 1];
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces after: {signature}");
    }

    /// F-TEL-001: a **background** window may not toggle recording. The window manager's focus
    /// check is the first thing `set_recording_for_window` does, so the refusal names the gate —
    /// proof the device seam was never reached.
    #[test]
    fn set_recording_from_a_background_window_is_denied() {
        let wm = WmState::new(); // the launcher ("main") owns focus
        let err = set_recording_for_window(true, &wm, "settings")
            .expect_err("a background window must not toggle recording");
        // The refusal is a typed envelope, not a bare string: the code is the
        // stable contract the UI branches on, the message keeps the F-TEL-001 story.
        assert_eq!(err.code, ErrorCode::TelephonyRecordingRefused);
        assert!(
            err.message.contains("recording toggle denied"),
            "{}",
            err.message
        );
        assert!(
            err.message.contains("not the foreground window"),
            "{}",
            err.message
        );
        assert!(
            err.message.contains("F-TEL-001"),
            "the refusal names the failure mode: {}",
            err.message
        );
        // The underlying `require_foreground` reason rides along as the cause.
        assert!(
            err.to_string().contains("not the foreground window"),
            "the cause chain preserves the gate's reason: {err}"
        );
    }

    /// The same call from the **focused** window passes the gate and then hits the honest
    /// "not the default dialer" boundary — i.e. the gate is not the thing that answered.
    #[test]
    fn set_recording_from_the_foreground_window_passes_the_gate() {
        let wm = WmState::new();
        let err = set_recording_for_window(true, &wm, "main")
            .expect_err("no in-call service is bound in a test process");
        assert!(
            !err.message.contains("not the foreground window"),
            "the foreground gate must have been satisfied: {}",
            err.message
        );
        assert!(err.message.contains("default dialer"), "{}", err.message);
        assert_eq!(err.code, ErrorCode::TelephonyRecordingRefused);
    }

    /// The payload's `recording` field is the string the UI reads verbatim; its default is
    /// `"Off"` (a call is not recorded until it is), and only the three glue words are legal.
    #[test]
    fn payload_recording_round_trip_is_honest() {
        let p = TelephonyCallPayload {
            id: "real".into(),
            peer: String::new(),
            state: "Active".into(),
            direction: String::new(),
            emergency: false,
            recording: Some("Off".into()),
            muted: None,
            speaker: None,
            hold: None,
        };
        assert_eq!(
            p.recording.as_deref(),
            Some("Off"),
            "recording defaults to Off, never On"
        );
        let j = serde_json::to_string(&p).expect("serialize");
        assert!(j.contains("\"recording\":\"Off\""));
    }

    /// The body of `sig` in comment-stripped Kotlin, up to (not including) the first `close`.
    ///
    /// Shared by the recording pins below; the instance helpers close at four spaces
    /// (`"\n    }"`), the companion statics at eight (`"\n        }"`).
    fn kotlin_body<'a>(code: &'a str, sig: &str, close: &str) -> &'a str {
        let start = code.find(sig).unwrap_or_else(|| {
            panic!("the Kotlin seam Rust calls across JNI must not drift: {sig}")
        }) + sig.len();
        let end = start
            + code[start..]
                .find(close)
                .unwrap_or_else(|| panic!("{sig}'s body must still close at its own indent"));
        &code[start..end]
    }

    /// The Kotlin recording words are a cross-language contract with no compiler, and the fact
    /// this pin must protect is **when** a word may be answered.
    ///
    /// Two prior rounds fixed two different defects here, and this pin has to keep both shut:
    ///
    /// * measured 2026-09-21 (F-TAU-022 / REQ-A822): the body was `return if (active) "On" else
    ///   "Off"`, so *swapping* the two words inverted the button while every literal stayed in the
    ///   file — a presence check could not fail.
    /// * measured 2026-09-23 (REQ-A1239 / F-TEL-026): the arm itself was the defect. The word was
    ///   read off the `active` **argument** and the platform was never touched, so the in-call
    ///   screen lit its red "recording" dot over a call nothing recorded.
    ///
    /// REQ-A1579 put a real `MediaRecorder` behind the word, which is what makes the *order*
    /// the load-bearing fact: `On` is only honest *after* `beginRecording()` returned and `Off`
    /// only after `finishRecording()` returned. Asserting the words' polarity would no longer
    /// catch the old defect — a `return if (active) "On" else "Off"` placed above the device call
    /// spells the same two words in the same order. So this asserts the order instead, plus the
    /// six refusals and the emergency guard the no-record rule for 110/112/911 lives in.
    #[test]
    fn the_recording_words_follow_the_device_action_never_the_argument() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let code = strip_kotlin_comments(KOTLIN);
        let body = kotlin_body(
            &code,
            "fun setRecording(active: Boolean): String {",
            "\n        }",
        );

        // (1) each word answers strictly after the device action that earns it. A word hoisted
        // above its action is the fabrication both prior rounds removed.
        let begin = body
            .find("s.beginRecording()")
            .expect("setRecording must actually start the recorder");
        let on = body
            .find("\"On\"")
            .expect("`On` must still be the start answer");
        assert!(
            begin < on,
            "`On` must follow `beginRecording()`, never precede it — a word answered from the \
             argument is the F-TEL-026 defect. Body: {body}"
        );
        let finish = body
            .find("s.finishRecording()")
            .expect("setRecording must actually stop the recorder");
        let off = body
            .find("\"Off\"")
            .expect("`Off` must still be the stop answer");
        assert!(
            finish < off,
            "`Off` must follow `finishRecording()`, never precede it. Body: {body}"
        );

        // (2) exactly six refusals: no bound service, no active call, an emergency line, start
        // over a live recording, stop with none live, and a throw from the device (the catch).
        // A missing one lets a request be reported as an achieved state.
        assert_eq!(
            body.matches("\"Failed\"").count(),
            6,
            "read the whole body: six refusals are expected, found {} — a missing one reports the \
             request as the state. Body: {body}",
            body.matches("\"Failed\"").count()
        );

        // (3) the emergency guard stays, and stays *before* anything that touches the recorder:
        // it is the only caller of `is_emergency` (dropping it orphans a declaration the glue's
        // `-Werror` build rejects), and F-TEL-001's hard no-record rule for 110/112/911 lives in
        // that call.
        let guard = body
            .find("is_emergency(c.details?.handle?.schemeSpecificPart)")
            .expect("the emergency guard must stay, and stay the only caller of `is_emergency`");
        assert!(
            guard < begin,
            "the emergency guard must run before the recorder is touched: no file may be minted \
             for an emergency line. Body: {body}"
        );

        // (4) every word the body can answer, run through the Rust mapper that consumes it: the
        // glue's vocabulary and the host's must be one set, and an unclassified word must NOT
        // read as a state.
        for (word, expected) in [
            ("On", RecordingChange::On),
            ("Off", RecordingChange::Off),
            ("Failed", RecordingChange::Failed),
        ] {
            let mapped = recording_change_from_state(word);
            assert_eq!(
                mapped, expected,
                "the glue answers {word:?}, which the host reads as {mapped:?}"
            );
        }
    }

    /// The recording seam's Kotlin half must actually drive a recorder, and Rust must only ever
    /// read a report about a file that was really written.
    ///
    /// A "recording" that answers `On` without a `MediaRecorder` behind it is the whole defect
    /// REQ-A1579 closes, so this pins the device calls — construction, source, codec, container,
    /// `prepare`/`start`/`stop`/`release` — and the **path convention**: `filesDir`, never
    /// `dataDir`, because Rust joins `files` onto `app_data_dir()` and two different roots would
    /// put the audio where no ledger row points (`crates/amos-tauri/src/lib.rs`).
    #[test]
    fn set_recording_drives_a_real_recorder_and_only_answers_after_it_acted() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let code = strip_kotlin_comments(KOTLIN);

        let begin = kotlin_body(&code, "private fun beginRecording() {", "\n    }");
        for needle in [
            "MediaRecorder",
            "setAudioSource",
            "setOutputFormat",
            "MediaRecorder.OutputFormat.MPEG_4",
            "setAudioEncoder",
            "MediaRecorder.AudioEncoder.AAC",
            ".prepare()",
            ".start()",
        ] {
            assert!(
                begin.contains(needle),
                "beginRecording must drive a real recorder ({needle} missing): {begin}"
            );
        }

        let finish = kotlin_body(&code, "private fun finishRecording() {", "\n    }");
        for needle in ["rec.stop()", "rec.release()"] {
            assert!(
                finish.contains(needle),
                "finishRecording must finalize and release the recorder ({needle} missing): \
                 {finish}"
            );
        }

        // Release is not optional: a leaked MediaRecorder holds the audio path for the rest of
        // the call, and the abort path is the one a throw lands on.
        let abort = kotlin_body(&code, "private fun abortRecording() {", "\n    }");
        assert!(
            abort.contains("rec?.release()"),
            "abortRecording must release the recorder on the failure path: {abort}"
        );

        // The path convention, both halves: the right root, and not the wrong one. The rule moved
        // into `RecordingContract.recordingsRoot` when the pure half was extracted (the instance
        // form is now a one-line delegate and cannot carry the literals), so it is read there —
        // and the delegate is pinned too, or a service that stopped using the shared rule would
        // leave the literals below green while writing to a root of its own.
        assert!(
            code.contains(
                "private fun recordingsRoot(): File = RecordingContract.recordingsRoot(filesDir)"
            ),
            "the service must delegate the recordings root to the one shared rule, not re-spell it"
        );
        let root = kotlin_body(
            &code,
            "fun recordingsRoot(filesDir: File): File {",
            "\n            }",
        );
        assert!(
            root.contains("File(filesDir, \"recordings\")"),
            "the recorder must write under `filesDir`, the root Rust joins `files` onto: {root}"
        );
        assert!(
            !root.contains("dataDir"),
            "`dataDir` is a different root from the one the ledger reads — the audio would be \
             written where no row points: {root}"
        );

        // And the words stay attached to those actions.
        let set = kotlin_body(
            &code,
            "fun setRecording(active: Boolean): String {",
            "\n        }",
        );
        for needle in ["s.beginRecording()", "s.finishRecording()"] {
            assert!(
                set.contains(needle),
                "setRecording must call {needle} — a word with no action behind it is the \
                 F-TEL-026 defect: {set}"
            );
        }

        // `isMicGranted` is the runtime half of `recording::capture_facts`; it must ask the
        // *service's own* permission state (a `MicPermissionGlue` WeakReference can be null while
        // the service is bound and would answer a false negative).
        let mic = kotlin_body(&code, "fun isMicGranted(): Boolean {", "\n        }");
        assert!(
            mic.contains("checkSelfPermission(Manifest.permission.RECORD_AUDIO)"),
            "isMicGranted must read RECORD_AUDIO off the bound service: {mic}"
        );
    }

    /// The audio source is the honest Android boundary: `VOICE_CALL` needs the *privileged*
    /// `CAPTURE_AUDIO_OUTPUT` (platform-signed builds only), so the seam must check for it at
    /// runtime and fall back to `VOICE_COMMUNICATION` — and it must check **first**, because a
    /// fallback chosen before the check is a fallback that never prefers the two-sided source.
    #[test]
    fn the_recording_source_prefers_voice_call_and_falls_back() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let code = strip_kotlin_comments(KOTLIN);
        let begin = kotlin_body(&code, "private fun beginRecording() {", "\n    }");

        let check = begin
            .find("checkSelfPermission(Manifest.permission.CAPTURE_AUDIO_OUTPUT)")
            .expect("the source choice must consult the privileged permission at runtime");
        let two_sided = begin
            .find("MediaRecorder.AudioSource.VOICE_CALL")
            .expect("the preferred source must be the mixed call stream");
        let fallback = begin
            .find("MediaRecorder.AudioSource.VOICE_COMMUNICATION")
            .expect("the near-end fallback must remain");
        assert!(
            check < two_sided && two_sided < fallback,
            "the privileged check must precede the preference, which must precede the fallback \
             (got check {check}, voice_call {two_sided}, voice_communication {fallback})"
        );

        // The source actually used is named on the wire and in the ledger, in the two words
        // `recording.rs`'s parser accepts — never a claim the far end was captured when it was
        // not. The integer→word rule moved into `RecordingContract.audioSourceName` when the pure
        // half was extracted (the instance body now names only the two integers), so the words are
        // read there — and the call site is pinned too, or a service that stopped consulting the
        // shared rule would leave the mapping below green while naming its own source.
        assert!(
            begin.contains("RecordingContract.audioSourceName(source)"),
            "beginRecording must name the source through the one shared rule, not re-spell it: \
             {begin}"
        );
        let name = kotlin_body(
            &code,
            "fun audioSourceName(source: Int): String = when (source) {",
            "\n            }",
        );
        assert!(
            name.contains("MediaRecorder.AudioSource.VOICE_CALL -> SOURCE_VOICE_CALL"),
            "VOICE_CALL must map to the two-sided word, not the fallback: {name}"
        );
        assert!(
            name.contains("else -> SOURCE_VOICE_COMMUNICATION"),
            "every other source must fall back to the near-end word: {name}"
        );
        // And the words those arms name are the two `recording.rs`'s parser accepts.
        for (word, const_name) in [
            ("voice_call", "SOURCE_VOICE_CALL"),
            ("voice_communication", "SOURCE_VOICE_COMMUNICATION"),
        ] {
            assert!(
                code.contains(&format!("const val {const_name}: String = \"{word}\"")),
                "the {word} word must be pinned as {const_name} — it is what the ledger reads"
            );
        }
    }

    /// The finished-recording report is the hand-off between the two halves, and it is **one
    /// shot**: Rust files a ledger row the moment it reads one, so a report that could be read
    /// twice would file two rows for one file (or re-credit a row to a later call).
    #[test]
    fn the_finished_report_is_one_shot_and_carries_id_start_and_source() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let code = strip_kotlin_comments(KOTLIN);

        // The latch: three fields, pipe-joined, and `id` names the file (`recordingId` is what
        // `beginRecording` built the path from). The envelope moved into
        // `RecordingContract.buildReport` when the pure half was extracted, so the shape is read
        // there — and the call site is pinned too, or a service that stopped using the shared rule
        // could emit a report the body below no longer describes.
        let finish = kotlin_body(&code, "private fun finishRecording() {", "\n    }");
        assert!(
            finish.contains("RecordingContract.buildReport(id, startedAt, src)"),
            "finishRecording must hand up the report through the one shared rule: {finish}"
        );
        let report = kotlin_body(
            &code,
            "fun buildReport(id: String, startedAtMs: Long, source: String): String {",
            "\n            }",
        );
        assert!(
            report.contains("\"$id$REPORT_DELIMITER$startedAtMs$REPORT_DELIMITER$source\""),
            "the report must be the three pipe-joined fields Rust parses: {report}"
        );

        // The start time is measured on the device, where the recorder actually started.
        let begin = kotlin_body(&code, "private fun beginRecording() {", "\n    }");
        assert!(
            begin.contains("System.currentTimeMillis()"),
            "beginRecording must stamp the start time from the device clock: {begin}"
        );

        // The one-shot read: the field is cleared, and an absent report answers `""` rather than
        // a stale one.
        let take = kotlin_body(
            &code,
            "private fun takeFinishedReport(): String {",
            "\n    }",
        );
        assert!(
            take.contains("finishedReport = null"),
            "reading the report must clear it, or the same file is filed twice: {take}"
        );

        // The getter Rust calls, and its descriptor: `()Ljava/lang/String;` — one String out, no
        // arguments (Rust's `call_static_string` is pinned to exactly that).
        let getter = kotlin_body(&code, "fun recordingResult(): String", "\n        }");
        assert!(
            getter.contains("takeFinishedReport()"),
            "recordingResult must hand up the one-shot latch: {getter}"
        );
        assert!(
            code.contains("@JvmStatic\n        fun recordingResult(): String"),
            "recordingResult must stay a @JvmStatic companion member Rust can call"
        );
    }

    /// The recorder is a **service-wide** object while the service outlives every call: "a
    /// recording is live" and "a call is live" are two different facts. A recording therefore has
    /// to remember *which* call it was started on, and that call's departure has to resolve it —
    /// otherwise hanging up mid-recording leaves the `MediaRecorder` capturing the microphone for
    /// the whole default-dialer tenure, writing into a file no ledger row will ever point at, and
    /// every later `setRecording(true)` refuses on the already-recording arm (so recording stays
    /// broken until the process dies).
    ///
    /// This is the ordinary-departure twin of `onDestroy`'s existing `abortRecording()`. The
    /// abort — not a finalize — is deliberate: the `Off` path (Rust's `real_set_recording(false)`)
    /// needs a live call and can no longer run, so there is no reader for a finished report, and a
    /// report nobody reads is an orphan file. Pinning the *wiring* (assign ↔ compare ↔ clear) is
    /// the point; `RecordingContract` cannot hold it because it is all instance state.
    #[test]
    fn a_recordings_own_call_resolves_it_on_departure() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let code = strip_kotlin_comments(KOTLIN);

        // The latch exists and is instance state (not a companion member: it holds a `Call`).
        assert!(
            code.contains("private var recordingCall: Call? = null"),
            "the live recording must remember the call it was started on"
        );

        // Assigned in `beginRecording`, and *before* `prepare()`/`start()` so a throw below still
        // leaves `forget` able to resolve the call. Order is measured, not assumed.
        let begin = kotlin_body(&code, "private fun beginRecording() {", "\n    }");
        let latch = begin.find("recordingCall = active").unwrap_or_else(|| {
            panic!("beginRecording must latch the recording to the active call whose start it is: {begin}")
        });
        let prepare = begin
            .find("rec.prepare()")
            .unwrap_or_else(|| panic!("beginRecording must still prepare the recorder: {begin}"));
        assert!(
            latch < prepare,
            "the recording must be latched to its call before prepare()/start(), so a throw below \
             leaves forget able to resolve it (latch {latch}, prepare {prepare})"
        );

        // The departure rule: a call that left mid-recording resolves *its* recording. The body is
        // read (not merely a presence check) so a `forget` that resolved a *different* call — or
        // resolved unconditionally, cutting a second call's recording — would fail here.
        let forget = kotlin_body(&code, "private fun forget(call: Call) {", "\n    }");
        assert!(
            forget.contains("if (call === recordingCall) abortRecording()"),
            "forget must resolve the recording of the departing call, and only that one: {forget}"
        );

        // Cleared on both exits, so a stale `recordingCall` cannot resolve a *later* call's
        // recording (a new recording always re-latches, but a cleared slot is what makes the
        // `forget` comparison safe when nothing is recording).
        for sig in [
            "private fun finishRecording() {",
            "private fun abortRecording() {",
        ] {
            let f = kotlin_body(&code, sig, "\n    }");
            assert!(
                f.contains("recordingCall = null"),
                "{sig} must clear the call latch, or a departed call's recording slot outlives it: {f}"
            );
        }
    }

    /// F-TEL-001 mitigation: the toggle UI must read the **result** of the toggle, not the
    /// user-intent boolean. Pin the rule that `real_set_recording(true)` returning an `Off`
    /// must NOT be coerced into `On` anywhere in the bridge — `recording_change_from_state`
    /// is the only conversion point and it preserves the distinction.
    #[test]
    fn refused_recording_toggle_is_not_rounded_up() {
        // Glue answers "Off" even though the user pressed "record" (toggle denied).
        let refused = recording_change_from_state("Off");
        assert_eq!(refused, RecordingChange::Off);
        // …which is **not** equal to On, so any consumer that reads the field sees the truth.
        assert_ne!(refused, RecordingChange::On);
        // And "Failed" must reach the UI verbatim so the banner can say "could not start".
        let failed = recording_change_from_state("Failed");
        assert_eq!(failed, RecordingChange::Failed);
    }

    /// Every in-call **toggle** the Rust seam calls answers in the same words, and *which* word
    /// answers for `active = true` is the contract. A swap leaves both literals spelled in the
    /// file, so a presence check cannot fail — that is exactly why this reads the direction out
    /// of comment-stripped source and runs each word through the Rust mapper that consumes it.
    ///
    /// The generalisation of [`the_recording_words_follow_the_device_action_never_the_argument`]
    /// to every in-call toggle the Rust seam calls: all four answer with the same `On` / `Off` /
    /// `Failed` vocabulary through [`toggle_change_from_state`], so all four must share one
    /// word↔arm binding.
    ///
    /// `setRecording` joined this list in REQ-A1579: with a real `MediaRecorder` behind the word
    /// it now has an arm to bind, exactly like its three siblings. The *order* of that arm
    /// relative to the device call is a separate question, pinned by the recording test above —
    /// this one only asks which word answers for which direction.
    #[test]
    fn every_toggle_word_is_pinned_to_the_kotlin_source_in_the_on_direction() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let code = strip_kotlin_comments(KOTLIN);
        for method in ["muteActive", "speakerActive", "holdActive", "setRecording"] {
            let sig = format!("fun {method}(active: Boolean): String {{");
            let start = code.find(&sig).unwrap_or_else(|| {
                panic!("the Kotlin companion method Rust calls across the JNI seam must not drift: {sig}")
            }) + sig.len();
            let end = start
                + code[start..].find("\n        }").unwrap_or_else(|| {
                    panic!("{method}'s body must still close at companion indent")
                });
            let body = &code[start..end];

            // `speakerActive` also writes `if (active) CallAudioState…`; anchoring on the
            // quote keeps this on the toggle arm rather than that route selection.
            const ANCHOR: &str = "if (active) \"";
            let at = body.find(ANCHOR).unwrap_or_else(|| {
                panic!("{method} must still answer `if (active) \"…\" else \"…\"`")
            });
            let rest = &body[at + ANCHOR.len()..];
            let on_word = &rest[..rest.find('"').expect("the on-word needs a closing quote")];
            const ELSE: &str = "else \"";
            let else_at = rest
                .find(ELSE)
                .unwrap_or_else(|| panic!("{method} must still have an `else \"…\"` branch"))
                + ELSE.len();
            let after = &rest[else_at..];
            let off_word = &after[..after.find('"').expect("the off-word needs a closing quote")];

            assert_eq!(
                toggle_change_from_state(on_word),
                ToggleChange::On,
                "{method} answers {on_word:?} for `active = true`; a swap inverts the control \
                 while every literal stays in the file"
            );
            assert_eq!(
                toggle_change_from_state(off_word),
                ToggleChange::Off,
                "{method} answers {off_word:?} for `active = false`"
            );
        }
    }

    /// A **bound service is not a call** — the toggle siblings must ask for a call, not for
    /// their own existence.
    ///
    /// `muteActive` / `speakerActive` answer `On` / `Off` read off their `active` argument. That
    /// word is a *state of a call* only if a call exists, and `self` is set in `onCreate` and
    /// cleared in `onDestroy` — its lifetime is the whole default-dialer tenure. The gate Rust
    /// routes on, `is_default_dialer_bound()`, is exactly `self != null`, so "bound with no
    /// call" is the ordinary between-calls state and the in-call screen can be up over a call
    /// the *daemon* owns (docs/telephony.md §12 #28's reachability note). Answering a per-call
    /// mute / route state there is the F-TEL-001 shape — the surface reports an outcome nothing
    /// achieved — and it is the same premise REQ-A1236 / F-TEL-025 removed from
    /// `answerActive` / `hangUpActive` and REQ-A1239 / F-TEL-026 removed from `setRecording`.
    /// The third sibling `holdActive` already asks (`val c = s.active ?: return "Failed"`);
    /// these two did not, which is why the guard is pinned here (REQ-A1267 / F-TEL-027).
    ///
    /// Pin the **guard's presence and its answer**, not its spelling or its position: the two
    /// observable facts are that the body asks about `s.active` at all and that it answers
    /// `Failed` twice — once for a null `self`, once for a null `active`. Dropping either
    /// refusal reddens the count; a re-spelling (`?:`, braces) keeps it green.
    #[test]
    fn mute_and_speaker_require_a_call_not_merely_a_bound_service() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let code = strip_kotlin_comments(KOTLIN);
        for method in ["muteActive", "speakerActive"] {
            let sig = format!("fun {method}(active: Boolean): String {{");
            let start = code.find(&sig).unwrap_or_else(|| {
                panic!("the Kotlin companion method Rust calls across the JNI seam must not drift: {sig}")
            }) + sig.len();
            let end = start
                + code[start..].find("\n        }").unwrap_or_else(|| {
                    panic!("{method}'s body must still close at companion indent")
                });
            let body = &code[start..end];

            assert!(
                body.contains("s.active"),
                "{method} must ask whether a call is up, not whether the service exists: a bound \
                 in-call service outlives every call, so `self != null` says nothing about a call \
                 being there. Body: {body}"
            );
            assert_eq!(
                body.matches("return \"Failed\"").count(),
                2,
                "{method} must refuse in two cases — no bound service, and no active call. One \
                 refusal means the requested state is reported as the achieved one. Body: {body}"
            );
        }
    }

    /// `answerActive()` / `hangUpActive()` must answer `true` **only** when a real call was
    /// acted on — never merely because the service is bound.
    ///
    /// The two facts are different, and the whole device is the witness: Android keeps
    /// `AmosInCallService` bound for as long as AmOS is the default phone app, which outlives
    /// any one call, so the service can be bound with nothing up. `telephony.rs::real_call_route`
    /// gate on `is_default_dialer_bound()` and read `Ok(true)` as "the real call was answered /
    /// disconnected"; answering it for a bound-but-idle service made every *daemon-owned* call
    /// (the in-call UI the user is actually looking at) get handed to this no-op and the command
    /// return `Ok(())` — the call never left the daemon, and the UI reported it answered or
    /// ended (REQ-A1236 / F-TEL-025).
    ///
    /// The question a pin here has to answer is therefore the *polarity* of the two statics:
    /// "did I act?" is what must reach Rust, not "do I exist?". A presence check on `return
    /// false` cannot fail — the old shape (`s.answerIncoming(); return true`) contains a
    /// `return true` and no `return false` at all, while a check for the refusals alone stays
    /// green the moment someone re-adds the unconditional `return true` below them.
    #[test]
    fn the_answer_and_hangup_prove_a_call_was_acted_on_not_that_a_service_exists() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let code = strip_kotlin_comments(KOTLIN);

        // A method body read out of comment-stripped source, closed at its own indent. The
        // instance helpers close at four spaces, the companion statics at eight.
        fn body_at<'a>(code: &'a str, sig: &str, close: &str) -> &'a str {
            let start = code.find(sig).unwrap_or_else(|| {
                panic!("the Kotlin seam Rust calls across JNI must not drift: {sig}")
            }) + sig.len();
            let end = start
                + code[start..]
                    .find(close)
                    .unwrap_or_else(|| panic!("{sig}'s body must still close at its own indent"));
            &code[start..end]
        }

        // (1) the instance helpers answer `false` on the null path, before touching the call.
        let answer_body = body_at(&code, "fun answerIncoming(): Boolean {", "\n    }");
        assert!(
            answer_body.contains("val c = active ?: return false"),
            "answerIncoming must answer `false` when nothing is up (it currently returns the \
             no-op as a success): {answer_body}"
        );
        assert!(
            answer_body.contains("if (c.state != Call.STATE_RINGING) return false"),
            "a call that is not ringing cannot be answered, so that arm must answer `false` \
             rather than let the caller report an answer that did not happen"
        );
        assert!(
            answer_body
                .find("c.answer(VideoProfile.STATE_AUDIO_ONLY)")
                .unwrap_or(usize::MAX)
                < answer_body.rfind("return true").unwrap_or(usize::MAX),
            "`true` may only follow the one branch that really called `answer()`"
        );
        let hang_body = body_at(&code, "fun hangUp(): Boolean {", "\n    }");
        assert!(
            hang_body.contains("val c = active ?: return false"),
            "hangUp must answer `false` when there is no call to disconnect: {hang_body}"
        );
        assert!(
            hang_body.find("c.disconnect()").unwrap_or(usize::MAX)
                < hang_body.rfind("return true").unwrap_or(usize::MAX),
            "`true` may only follow the `disconnect()` that really ended a call"
        );

        // (2) the statics hand that answer up verbatim. The failure this pins is not a missing
        //     word but an extra one: `return true` in place of the delegation is exactly the
        //     old defect, and every literal of the fixed body is still present in it.
        for (sig, call) in [
            ("fun answerActive(): Boolean {", "return s.answerIncoming()"),
            ("fun hangUpActive(): Boolean {", "return s.hangUp()"),
        ] {
            let body = body_at(&code, sig, "\n        }");
            assert!(
                body.contains(call),
                "{sig} must answer what the instance method did, not that the service exists: \
                 {body}"
            );
            assert!(
                !body.contains("return true"),
                "{sig} must not answer `true` unconditionally — Rust reads that as \"the real \
                 call was acted on\", and a bound-but-idle service would then own a daemon \
                 call's answer/hang-up (REQ-A1236): {body}"
            );
        }
    }

    /// The DTMF alphabet is a three-way contract with a compiler on neither seam: the command
    /// seam (`telephony::DTMF_TONES`), the device (`AmosInCallService.DTMF_ALPHABET`) and the
    /// keypad. A drift on the Kotlin side lets a tone the host validated be dropped on the
    /// device (or a tone the device accepts be refused at the seam) with nothing to say so.
    #[test]
    fn the_dtmf_alphabet_is_pinned_to_the_kotlin_source() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let code = strip_kotlin_comments(KOTLIN);
        const SIG: &str = "private const val DTMF_ALPHABET = \"";
        let start = code
            .find(SIG)
            .expect("the Kotlin DTMF alphabet must stay a companion constant")
            + SIG.len();
        let end = start
            + code[start..]
                .find('"')
                .expect("the alphabet needs a closing quote");
        assert_eq!(
            &code[start..end],
            crate::telephony::DTMF_TONES,
            "the device's DTMF alphabet and the command seam's must be one set"
        );
    }

    /// The call's **direction** is latched once, from the state the call is first seen in, and
    /// the host must not re-derive it from a changing state. A call stops being `Ringing` the
    /// moment it is answered, so deriving would flip an answered *incoming* call to `Outgoing`
    /// — and the WebView's incoming overlay drops every non-`Incoming` event, so the call would
    /// vanish from the screen it is being held on (docs/telephony.md §12 #23).
    #[test]
    fn the_call_direction_is_latched_once_and_prefers_the_platform_answer() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let code = strip_kotlin_comments(KOTLIN);

        // (1) written where the call first arrives, from its state at that moment.
        assert!(
            code.contains(
                "latchedDirections[call] = if (call.state == Call.STATE_RINGING) \"Incoming\" else \"Outgoing\""
            ),
            "the side must be latched where the call first arrives, while `Ringing` still means \
             what it says"
        );
        // (2) an API-29+ `Details#getCallDirection()` is the platform's own answer, so it
        //     outranks the latch; the latch outranks the state, which is the only answer that
        //     changes as a call is answered. The order is the contract, so it is asserted as an
        //     order. (The API is *`getCallDirection`*, not `getDirection` — the glue gate caught
        //     the wrong spelling here; see docs/telephony.md §12 #25.)
        let dir = code
            .find("private fun callDirection(")
            .expect("the direction resolver must stay a named function");
        let body = &code[dir..];
        let platform_at = body
            .find("c.details?.callDirection")
            .expect("the platform's own answer must be consulted first");
        let latch_at = body
            .find("latchedDirections[it]?.let")
            .expect("the latched side must be the fallback");
        let state_at = body
            .find("if (state == \"Ringing\")")
            .expect("the state fallback must remain, last");
        assert!(
            platform_at < latch_at && latch_at < state_at,
            "authority order must be platform > latch > state (got platform {platform_at}, latch \
             {latch_at}, state {state_at})"
        );
        // (3) and the reporter must actually use it rather than the raw state.
        assert!(
            code.contains("val direction = callDirection(c, state)"),
            "onCallStateChanged must report the resolved direction, not the raw state"
        );
    }

    /// Dropping one live call must not empty the slot while another is still up.
    ///
    /// The service used to hold a single `active` slot: a second call (call waiting, a second
    /// VoIP leg) overwrote it, so the first call left the wire entirely; and when the *newer*
    /// call ended, `onCallRemoved` nulled the slot while the older one was still live —
    /// `onCallStateChanged`'s `?: return` then pushed **nothing at all**, and the screen showed
    /// no call, no peer and no controls for a call the user was still on. The direction latch
    /// was one field too, so the surviving call's side had to be re-derived — wrong below API 29
    /// (`minSdk = 26`, where `Details#getCallDirection()` does not exist).
    ///
    /// This pins the shape that fixes both: membership in an insertion-ordered set, a per-call
    /// latch, and a departure that **re-picks** `active` from what remains rather than nulling
    /// it. It asserts the re-fill exists and is ordered — a mere presence check on
    /// `liveCalls.lastOrNull()` would pass for a `forget` that never sets `active` at all.
    #[test]
    fn dropping_a_call_refills_the_slot_instead_of_emptying_it() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let code = strip_kotlin_comments(KOTLIN);

        // (1) membership is kept, and keyed per call so it is insertion-ordered (newest last).
        assert!(
            code.contains("private val liveCalls = linkedSetOf<Call>()"),
            "the live calls must be kept in an insertion-ordered set so `lastOrNull()` is the \
             newest"
        );
        assert!(
            code.contains("private val latchedDirections = mutableMapOf<Call, String>()"),
            "the direction latch must be per call, not one field for the service"
        );
        assert!(
            !code.contains("private var latchedDirection:"),
            "a single `latchedDirection` field cannot answer for two live calls"
        );

        // (2) the re-fill is the *shape* of the departure: `forget` drops the call from both
        //     trackers, and only then re-picks `active` — the order matters, because picking
        //     before removing would hand `active` back to the call that just left.
        let start = code
            .find("private fun forget(call: Call)")
            .expect("the departure must go through one named helper");
        let body = &code[start..];
        let end = body.find("\n    }").expect("forget must still close");
        let body = &body[..end];
        let rm_live = body
            .find("liveCalls.remove(call)")
            .expect("the departure must drop the call from the live set");
        let rm_dir = body
            .find("latchedDirections.remove(call)")
            .expect("the departure must drop the call's latched side");
        let refill = body
            .find("active = liveCalls.lastOrNull()")
            .expect("a departure must re-pick the newest remaining call, not null the slot");
        assert!(
            rm_live < refill && rm_dir < refill,
            "the call must be removed before the slot is re-picked (got live {rm_live}, dir \
             {rm_dir}, refill {refill})"
        );
        assert!(
            !body.contains("active = null"),
            "`forget` must never null the slot — that is the bug (REQ-A1269)"
        );

        // (3) both departure paths and the teardown route through it, and the teardown drops
        //     *every* live call's callback rather than the active one's alone.
        assert!(
            code.contains("override fun onCallRemoved(call: Call) {\n        call.unregisterCallback(callback)\n        forget(call)"),
            "onCallRemoved must unregister and then forget"
        );
        let destroyed = code
            .find("override fun onCallDestroyed(call: Call) {")
            .expect("the destroyed callback must stay");
        let dbody = &code[destroyed..];
        let dend = dbody
            .find("\n        }")
            .expect("onCallDestroyed must still close");
        assert!(
            dbody[..dend].contains("forget(call)"),
            "onCallDestroyed must forget the call too, or a destroyed call keeps the slot"
        );
        let destroy = code
            .find("override fun onDestroy() {")
            .expect("onDestroy must stay");
        let destbody = &code[destroy..];
        assert!(
            destbody.contains("for (c in liveCalls) {"),
            "onDestroy must unregister every live call's callback, not just the active one"
        );
        assert!(
            destbody.contains("liveCalls.clear()")
                && destbody.contains("latchedDirections.clear()"),
            "onDestroy must drop both trackers"
        );
    }

    /// The bridge must not report a call state when there is no call.
    ///
    /// `onCallStateChanged` is reached with `active == null` on real paths — `onCallRemoved` /
    /// `onCallDestroyed` call `forget`, which leaves the slot empty once the *last* live call is
    /// gone — and `onCallAudioStateChanged` can
    /// fire with nothing up. The state `when`'s `else -> "Unknown"` arm is the word for a call
    /// that *is* up in a state we do not classify (`STATE_HOLDING`). A `null` call fell into
    /// that arm too, so it was pushed to the WebView as `{state: "Unknown", direction:
    /// "Outgoing", peer: ""}` — the shell's subscriber keeps the last word it hears, so this
    /// tail *outlived* the `Ended` for the departing call and re-adoption drew a talking
    /// screen for a call that does not exist, whose hang-up disconnects nothing
    /// (docs/telephony.md §12 #33, REQ-A1233).
    ///
    /// A presence pin would not do: `"Unknown"` must *stay* (it is the honest word for a held
    /// call) — the question is **which subject** may reach it. So this asserts the order: the
    /// no-call return precedes the mapping, and the mapping's subject is the non-null `c.state`.
    #[test]
    fn the_no_call_tail_never_reaches_the_state_mapping() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let code = strip_kotlin_comments(KOTLIN);

        let start = code
            .find("private fun onCallStateChanged(")
            .expect("the reporter must stay a named function");
        let body = &code[start..];
        let end = body
            .find("\n    }")
            .expect("onCallStateChanged must still close");
        let body = &body[..end];

        // (1) the no-call guard, and it must come before the state is decided.
        const GUARD: &str = "val c = active ?: return";
        let guard_at = body
            .find(GUARD)
            .expect("a `null` active call must return, not fall into the state mapping");
        let when_at = body
            .find("val state = when (")
            .expect("the state mapping must stay a `when`");
        assert!(
            guard_at < when_at,
            "the no-call return must precede the state mapping (got guard {guard_at}, when {when_at})"
        );

        // (2) the subject is non-null, so no `null` can reach the `else` arm.
        assert!(
            body.contains("val state = when (c.state)"),
            "the mapping's subject must be the non-null `c.state`, not `c?.state` — a nullable \
             subject is what let 'no call' answer with a live-call word"
        );
        assert!(
            !body.contains("when (c?.state)"),
            "a nullable subject lets `null` fall into `else -> \"Unknown\"` again"
        );

        // (3) and the else arm is still the honest word for an unclassified **live** state.
        assert!(
            body.contains("else -> \"Unknown\""),
            "`Unknown` must remain the word for a call that is up in a state we do not classify"
        );
    }

    /// A payload carrying nothing but the call's identity — the fields a real upcall fills in.
    fn audio_only_payload() -> TelephonyCallPayload {
        TelephonyCallPayload {
            id: "real".into(),
            peer: "10086".into(),
            state: "Active".into(),
            direction: "Outgoing".into(),
            emergency: false,
            recording: None,
            muted: None,
            speaker: None,
            hold: None,
        }
    }

    /// A push that could not read the platform's audio state must leave both fields **absent** —
    /// the wire's "no claim" — rather than send `false`, which *claims* an unmuted earpiece call.
    ///
    /// This is the whole reason the bridge sends a third `known` flag: `CallAudioState` is null
    /// exactly when no call has audio, and "I could not read it" is a different fact from "I read
    /// it, and it is off". Both fields must disappear from the JSON, because the frontend adopts a
    /// toggle only when `typeof c.muted === "boolean"` (REQ-A1268 / F-TEL-028).
    #[test]
    fn an_unread_audio_state_is_no_claim_not_a_default() {
        let mut p = audio_only_payload();
        apply_audio_facts(&mut p, false, false, false);
        assert_eq!(p.muted, None, "an unread state must not claim `false`");
        assert_eq!(p.speaker, None, "an unread state must not claim a route");
        let j = serde_json::to_string(&p).expect("serialize");
        assert!(
            !j.contains("\"muted\""),
            "an absent claim must not appear on the wire: {j}"
        );
        assert!(
            !j.contains("\"speaker\""),
            "an absent claim must not appear on the wire: {j}"
        );
    }

    /// Both leaves, in opposite directions, so swapping the two fields reddens this — and `hold`
    /// stays absent, because a `CallAudioState` says nothing about it.
    #[test]
    fn a_read_audio_state_stamps_exactly_the_two_facts_it_measured() {
        let mut p = audio_only_payload();
        apply_audio_facts(&mut p, true, false, true);
        assert_eq!(p.muted, Some(true));
        assert_eq!(
            p.speaker,
            Some(false),
            "mute must not leak into the route field"
        );
        assert_eq!(p.hold, None, "this push measured no hold");
        let j = serde_json::to_string(&p).expect("serialize");
        assert!(j.contains("\"muted\":true"), "{j}");
        assert!(j.contains("\"speaker\":false"), "{j}");
        assert!(
            !j.contains("\"hold\""),
            "a measured push must still not claim hold: {j}"
        );

        let mut q = audio_only_payload();
        apply_audio_facts(&mut q, false, true, true);
        assert_eq!(
            q.muted,
            Some(false),
            "the route must not leak into the mute field"
        );
        assert_eq!(q.speaker, Some(true));
    }

    /// The platform's own audio facts are a fact the app can be wrong about in a way no other
    /// instrument catches: the in-call screen shows the *user's last command*, so a route the
    /// platform changed on its own (a headset connecting, the system in-call UI) leaves the screen
    /// lit for a route the call is not on.
    ///
    /// `onCallAudioStateChanged` is the one callback that fires exactly when that happens. Before
    /// this round it ignored its `state` argument and merely re-pushed the call state — so the pin's
    /// load-bearing question is not "is an audio symbol mentioned somewhere" (a presence check
    /// cannot fail here) but "does the callback hand its argument *on*" (REQ-A1268 / F-TEL-028).
    #[test]
    fn the_platform_audio_facts_ride_on_every_state_push() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let code = strip_kotlin_comments(KOTLIN);

        // (1) the audio change is threaded into the push, not discarded with the argument.
        const CB: &str = "override fun onCallAudioStateChanged(state: CallAudioState) {";
        let cb_at = code
            .find(CB)
            .expect("the audio callback must stay declared as-is");
        let cb_rest = &code[cb_at + CB.len()..];
        let cb_end = cb_rest
            .find("\n    }")
            .expect("onCallAudioStateChanged must close");
        let cb_body = &cb_rest[..cb_end];
        assert!(
            cb_body.contains("onCallStateChanged(state)"),
            "the audio callback must hand the platform's own CallAudioState to the push. Calling \
             `onCallStateChanged()` discards it, which is the defect: the event then describes the \
             app's last command rather than the route the call is on. Body: {cb_body}"
        );

        // (2) every *other* push (call added / removed / state changed) reads the platform's answer.
        assert!(
            code.contains(
                "private fun onCallStateChanged(audio: CallAudioState? = getCallAudioState())"
            ),
            "a push with no argument from the platform must read the platform's own audio state, \
             not skip the facts"
        );

        // (3) the three wire flags are derived from that state, and `known` is the *readability* of
        // it — a constant `true` would report a null state as "unmuted, on the earpiece".
        const PUSH: &str = "private fun onCallStateChanged(";
        let push_at = code
            .find(PUSH)
            .expect("the reporter must stay a named function");
        let push_rest = &code[push_at..];
        let push_end = push_rest
            .find("\n    }")
            .expect("onCallStateChanged must close");
        let push_body = &push_rest[..push_end];
        for needle in [
            "audio?.isMuted == true",
            "audio?.route == CallAudioState.ROUTE_SPEAKER",
            "audio != null",
            "nativeState(",
        ] {
            assert!(
                push_body.contains(needle),
                "the push must derive `{needle}` from the platform's state and pass it up. \
                 Body: {push_body}"
            );
        }
    }

    /// JNI resolves `nativeState` by **name**, not by signature.
    ///
    /// A Kotlin declaration with six parameters and a Rust export with three compiles on both
    /// sides, links, and then reads whatever happens to be in the registers on the device — the
    /// `jni-contract-scan` pairing checks the two *names* and says nothing about their arity. This
    /// pin is the only place the two spellings are compared (REQ-A1268 / F-TEL-028).
    #[test]
    fn the_push_arity_agrees_across_the_jni_boundary() {
        const KOTLIN: &str = include_str!("../android-glue/com/amos/ai/glue/AmosInCallService.kt");
        let kt = strip_kotlin_comments(KOTLIN);
        const KD: &str = "private external fun nativeState(";
        let kd_at = kt.find(KD).expect("the Kotlin JNI declaration must stay");
        let kd_end = kd_at
            + kt[kd_at..]
                .find(')')
                .expect("the Kotlin declaration must close");
        let kd = &kt[kd_at..kd_end];
        assert_eq!(
            kd.matches(": Boolean").count(),
            3,
            "the Kotlin declaration must carry the platform's three audio flags. Decl: {kd}"
        );
        assert_eq!(
            kd.matches(": String").count(),
            3,
            "the Kotlin declaration must keep direction / state / peer. Decl: {kd}"
        );

        // Read this module's own source. The signature is above every comment that names it, so
        // the parameter list can be taken verbatim without stripping prose first.
        const RUST: &str = include_str!("incall.rs");
        const RD: &str = "fn Java_com_amos_ai_glue_AmosInCallService_nativeState(";
        let rd_at = RUST.find(RD).expect("the Rust export must stay");
        let rd_end = rd_at + RUST[rd_at..].find(')').expect("the Rust export must close");
        let rd = &RUST[rd_at..rd_end];
        assert_eq!(
            rd.matches(": jboolean").count(),
            3,
            "the Rust export must take the same three audio flags as Kotlin. Export: {rd}"
        );
        assert_eq!(
            rd.matches(": jstring").count(),
            3,
            "the Rust export must take the same three strings as Kotlin. Export: {rd}"
        );
    }

    // ---- the recording ledger hand-off (REQ-A1579 / F-TEL-038) --------------

    /// The report is the cross-language hand-off with no compiler on either seam, and Rust files
    /// a ledger row the moment it reads one — so anything that is not exactly three well-formed
    /// fields must be **refused**, never guessed at. A malformed report that produced a row would
    /// point the ledger at an id or a source nothing measured.
    #[test]
    fn the_finished_report_parses_exactly_three_well_formed_fields() {
        let ok = parse_recording_report("real-1700000000000|1700000000000|voice_call").unwrap();
        assert_eq!(ok.id, "real-1700000000000");
        assert_eq!(ok.started_at_ms, 1_700_000_000_000);
        assert_eq!(ok.source, "voice_call");
        // A start of 0 is legal (a clock with no epoch) — the refusal is only for a *negative*.
        assert!(parse_recording_report("id|0|voice_communication").is_ok());

        for bad in [
            "",
            "onlyanid",
            "id|123",
            "id|123|voice_call|extra",
            "||voice_call",
            "id|notanumber|voice_call",
            "id|-5|voice_call",
            "id|123|unknown_source",
            "id|123|",
        ] {
            assert!(
                parse_recording_report(bad).is_err(),
                "report {bad:?} must be refused, not guessed at"
            );
        }
    }

    /// Whole seconds, never negative — a stop that lands before its recorded start (a clock that
    /// moved backwards) must not underflow a `u32` into a huge duration.
    #[test]
    fn duration_seconds_never_underflow_when_the_clock_moves_backwards() {
        assert_eq!(duration_sec_from(1_000, 500), 0);
        assert_eq!(duration_sec_from(1_000, 1_000), 0);
        assert_eq!(duration_sec_from(1_000, 4_500), 3);
    }

    /// The open session is one-shot: taking it leaves the slot empty, so a second `Off` cannot
    /// re-attribute a row to a call that already ended.
    #[test]
    fn the_recording_session_is_one_shot_and_remembers_the_peer() {
        set_session("13800138000".to_string());
        assert_eq!(take_session().as_deref(), Some("13800138000"));
        assert_eq!(take_session(), None, "a second take finds the slot empty");
    }

    /// An upcall whose `Details` is null reports `""` — the wire's "no claim", not "the peer is
    /// nobody" — so it must not erase the peer a later ledger row needs.
    #[test]
    fn an_empty_peer_push_does_not_clear_the_known_peer() {
        remember_peer("13800138000");
        remember_peer("");
        assert_eq!(known_peer(), "13800138000");
        remember_peer("10086");
        assert_eq!(known_peer(), "10086");
    }

    /// No report at all is the ordinary answer for a failed or absent stop: nothing is filed, and
    /// that is a success rather than an error.
    #[test]
    fn an_empty_report_files_nothing() {
        let temp = tempfile::tempdir().unwrap();
        assert!(file_recording_at(temp.path(), "", "13800138000", 1_700_000_000_000).is_ok());
        assert!(recording::load_index(temp.path()).unwrap().is_empty());
    }

    /// A report naming a file that is not there — or is empty — is a **refusal**, not a row: the
    /// ledger must never claim audio the user cannot play.
    #[test]
    fn a_report_with_no_audio_is_refused_and_files_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let err = file_recording_at(
            temp.path(),
            "real-1|1700000000000|voice_call",
            "13800138000",
            1_700_000_000_000,
        )
        .expect_err("a report with no file must not produce a row");
        assert_eq!(err.code, ErrorCode::TelephonyRecordingRefused);
        assert!(
            err.message.contains("no audio"),
            "the refusal must name the missing file: {}",
            err.message
        );
        assert!(recording::load_index(temp.path()).unwrap().is_empty());

        // …and a file that exists but is empty is the same fact.
        let dir = recording::recording_dir(temp.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("real-1.m4a"), b"").unwrap();
        let err = file_recording_at(
            temp.path(),
            "real-1|1700000000000|voice_call",
            "13800138000",
            1_700_000_000_000,
        )
        .expect_err("a zero-length file is not a recording");
        assert_eq!(err.code, ErrorCode::TelephonyRecordingRefused);
        assert!(recording::load_index(temp.path()).unwrap().is_empty());
    }

    /// A file this code could not **look at** is not the same fact as a file that is not there.
    /// Folding the `metadata` failure into `0` made the refusal assert "no audio is at <path>"
    /// about a path it never managed to read — a cause it had not established. The same pair is
    /// answered with two sentences one recorder over (`screen_record.rs::confirm_written`:
    /// `None` = "wrote no file", `Some(0)` = "wrote an empty file").
    #[test]
    fn a_recording_that_cannot_be_read_is_not_reported_as_missing_audio() {
        let temp = tempfile::tempdir().unwrap();
        // `recordings` exists as a *file*, so `<root>/recordings/real-1.m4a` is ENOTDIR: the
        // report names a path that cannot be inspected at all. Deliberately not ENOENT, which
        // is the honest "there is no audio there" case the sibling test above covers.
        std::fs::write(recording::recording_dir(temp.path()), b"not a directory").unwrap();

        let err = file_recording_at(
            temp.path(),
            "real-1|1700000000000|voice_call",
            "13800138000",
            1_700_000_000_000,
        )
        .expect_err("a path that cannot be inspected must not produce a row");
        assert_eq!(err.code, ErrorCode::TelephonyRecordingRefused);
        assert!(
            !err.message.contains("no audio"),
            "a file we could not read is not a file that is not there: {}",
            err.message
        );
        assert!(
            err.message.contains("could not be read"),
            "the refusal must name the failure it saw: {}",
            err.message
        );
        assert_eq!(
            err.cause.len(),
            1,
            "the io error that stopped the read is carried as the cause"
        );
        assert!(recording::load_index(temp.path()).unwrap().is_empty());
    }

    /// The happy path: the row carries the **measured** size (from the file the recorder released)
    /// and the **device's** start time, with the duration derived from one clock.
    #[test]
    fn a_finished_recording_is_filed_with_its_measured_size_and_device_start() {
        let temp = tempfile::tempdir().unwrap();
        let dir = recording::recording_dir(temp.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("real-1.m4a"), b"0123456789").unwrap();

        let start = 1_700_000_000_000i64;
        file_recording_at(
            temp.path(),
            &format!("real-1|{start}|voice_call"),
            "13800138000",
            start + 90_500,
        )
        .unwrap();

        let index = recording::load_index(temp.path()).unwrap();
        assert_eq!(index.len(), 1);
        let row = &index[0];
        assert_eq!(row.call_id, "real-1");
        assert_eq!(row.peer, "13800138000");
        assert_eq!(row.started_at, start / 1000);
        assert_eq!(row.duration_sec, 90);
        assert_eq!(row.file_size_bytes, 10);
        assert_eq!(row.source.as_deref(), Some("voice_call"));
    }

    /// The id in a report reaches `recording_path`, so a traversal-shaped id must be refused
    /// **before** any row exists — the same rule `recording.rs` applies to every entry point.
    #[test]
    fn a_report_id_unusable_as_a_path_is_refused_and_writes_no_row() {
        let temp = tempfile::tempdir().unwrap();
        let err = file_recording_at(
            temp.path(),
            "../escape|1700000000000|voice_call",
            "13800138000",
            1_700_000_000_000,
        )
        .expect_err("a traversal id must not be filed");
        assert_eq!(err.code, ErrorCode::TelephonyRecordingRefused);
        assert!(
            !temp.path().join("recordings.json").exists(),
            "a refused id must write no ledger at all"
        );
    }

    /// Strip Kotlin block and line comments, leaving string literals intact — so the file's own
    /// prose (which exists to *describe* the rule) cannot answer a question about the code.
    ///
    /// A `//` inside a string literal is not a comment; that is what makes this a character
    /// machine rather than a `find("//")`. This is the fourth copy of this helper in the repo
    /// (`alarm_device_binding_e2e.rs`, `rotation.rs`, `amos-telephony/src/number.rs`); there is no
    /// `tests/common`, and the two `amos-tauri` copies cannot share one without making this
    /// module's tests depend on another module's test-only items.
    fn strip_kotlin_comments(src: &str) -> String {
        let chars: Vec<char> = src.chars().collect();
        let mut out = String::with_capacity(src.len());
        let mut i = 0usize;
        let mut block_depth = 0usize;
        while i < chars.len() {
            let c = chars[i];
            if block_depth > 0 {
                if c == '/' && chars.get(i + 1) == Some(&'*') {
                    block_depth += 1;
                    i += 2;
                } else if c == '*' && chars.get(i + 1) == Some(&'/') {
                    block_depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
                continue;
            }
            if c == '/' && chars.get(i + 1) == Some(&'/') {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            if c == '/' && chars.get(i + 1) == Some(&'*') {
                block_depth = 1;
                i += 2;
                continue;
            }
            if c == '"' {
                out.push(c);
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        out.push(chars[i]);
                        i += 1;
                    }
                    out.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() {
                    out.push(chars[i]);
                    i += 1;
                }
                continue;
            }
            out.push(c);
            i += 1;
        }
        out
    }

    /// The stripper is two-sided here too: a prose `return "On"` must go, the real one must
    /// survive, and a `//` inside a string literal must not be taken for a comment.
    #[test]
    fn strip_kotlin_comments_keeps_returns_and_drops_prose() {
        let src = "\
    /** Toggles and returns \"On\" on success, \"Failed\" otherwise. */\n\
    // return \"On\"\n\
    return if (active) \"On\" else \"Off\"\n\
    val odd = \"a//b\"\n";
        let code = strip_kotlin_comments(src);
        assert_eq!(
            code.matches("\"On\"").count(),
            1,
            "only the real return may still spell the word: {code:?}"
        );
        assert!(
            code.contains("val odd = \"a//b\""),
            "a `//` inside a string literal is not a comment: {code:?}"
        );
    }
}
