//! Call recording storage and metadata.
//!
//! Defines the on-device storage path for recorded calls and provides
//! a metadata index (JSON) for the UI to list/playback recordings.
//!
//! Contract:
//! - Recordings live under `<app_data>/recordings/<call_id>.m4a`
//! - Metadata index at `<app_data>/recordings.json`
//! - The actual audio capture belongs to the audio pipeline (future work)
//! - This module only manages the storage directory and metadata ledger
//!
//! **The call id is a path component, and this module is what turns it into one** (REQ-A652).
//! Every entry point that takes an id goes through [`safe_call_id`] *before* the id is joined
//! onto [`recording_dir`], because `Path::join` **replaces** the whole path when the argument is
//! absolute and happily walks out of the directory on `..`. [`remove_recording`] deletes a file,
//! so an unvalidated id was a delete-primitive aimed at any `*.m4a` on the device (measured:
//! `recording_path(data, "/etc/passwd")` answered `/etc/passwd.m4a` and
//! `recording_path(data, "../escape")` left the recordings root). The shape rule is the same one
//! `crate::appstore::validate_appstore_id` applies to an app id — separators, `.`, `..`, and
//! control characters are refused — and the length bound is the telephony seam's own
//! `MAX_TELEPHONY_CALL_ID_BYTES`, re-used rather than re-invented: a storage key longer than its
//! producer's cap is reachable only by a bug.
//!
//! Validating in `add_recording` too is what keeps the ledger *self-consistent*: an id the
//! ledger accepted but `remove_recording` refuses would be a row the user can never delete.
//!
//! **Status (REQ-A480 → REQ-A1334 → REQ-A1579): both halves are wired on Android.** Until
//! REQ-A1334 nothing outside this file referenced any public item, and `rust-unwired-scan`
//! reported the whole module as an orphan, recorded in `scripts/rust-unwired-baseline.json` with
//! the reason it was kept. [`recordings_list`] / [`recording_delete`] /
//! [`recordings_capture_status`] are real commands now — the recordings settings page invokes them
//! — so that orphan entry was removed.
//!
//! The **capture half landed** in REQ-A1579 on the only target that can have it: with AmOS bound
//! as the default dialer, `AmosInCallService.setRecording` drives a real `MediaRecorder`, and
//! `crate::incall` files the finished file here through [`add_recording`]. The Android provider
//! type in `crates/amos-telephony` still refuses `start_recording` by name, but that crate is not
//! linked into the APK — see the module header of `crates/amos-telephony/src/android.rs`.
//!
//! [`recordings_capture_status`] therefore answers from **runtime facts** ([`capture_facts`]) —
//! is this an Android build, is AmOS the bound default dialer, is `RECORD_AUDIO` granted — rather
//! than a compile-time constant. [`add_recording`] once a file exists at [`recording_path`], and
//! [`load_index`] for whatever lists them — and the parser must handle a missing index (it
//! returns an empty `Vec`, not an error) because a device with no recordings is the normal first
//! state, not a failure.
//!
//! The module still does not let a listing imply recording works: an empty list means *no
//! recordings*, which is not the same fact as *recording is impossible here* — the page draws the
//! honest boundary from [`recordings_capture_status`]'s reason, not from the list's length.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{Manager, State};

use crate::error::{AmosError, ErrorCode};

/// Length bound for a call id, **borrowed from the seam that mints and caps it** rather than
/// re-declared here (see the module header).
use crate::telephony::MAX_TELEPHONY_CALL_ID_BYTES;

/// On-device recording root: <app_data>/recordings/
pub fn recording_dir(app_data: &Path) -> PathBuf {
    app_data.join("recordings")
}

/// The one rule that decides whether a call id may become a path component.
///
/// Mirrors [`crate::appstore::validate_appstore_id`]'s refusals, for the same reason: the id is
/// joined onto a directory, and this module's `remove_recording` deletes the result. Errors are
/// `io::ErrorKind::InvalidInput` — the caller handed us something we will not turn into a path —
/// and the command seam above answers them as `String`, the same refusal an `invoke` surfaces for
/// any other failed command.
fn safe_call_id(call_id: &str) -> Result<(), std::io::Error> {
    let bad = |why: String| std::io::Error::new(std::io::ErrorKind::InvalidInput, why);
    if call_id.is_empty() {
        return Err(bad("call id is empty".to_string()));
    }
    if call_id.len() > MAX_TELEPHONY_CALL_ID_BYTES {
        return Err(bad(format!(
            "call id too long: {} bytes (max {MAX_TELEPHONY_CALL_ID_BYTES})",
            call_id.len()
        )));
    }
    if call_id.contains('/')
        || call_id.contains('\\')
        || call_id == "."
        || call_id == ".."
        || call_id.chars().any(|c| c == '\0' || c.is_control())
    {
        return Err(bad(format!(
            "call id is not usable as a path component: {call_id:?}"
        )));
    }
    Ok(())
}

/// Recording file path for a call: `<recording_dir>/<call_id>.m4a`.
///
/// `Err` when `call_id` is not usable as a path component ([`safe_call_id`]) — the answer is a
/// refusal, never a path outside [`recording_dir`].
pub fn recording_path(app_data: &Path, call_id: &str) -> Result<PathBuf, std::io::Error> {
    safe_call_id(call_id)?;
    Ok(recording_dir(app_data).join(format!("{call_id}.m4a")))
}

/// Recording metadata (indexed in recordings.json)
///
/// `source` is the audio source the recorder actually used — `"voice_call"` (two-sided, needs the
/// privileged `CAPTURE_AUDIO_OUTPUT`) or `"voice_communication"` (near end only). It is
/// `Option` + `serde(default)` so a ledger row written before REQ-A1579 still parses, and
/// `skip_serializing_if` so a row that has no source does not grow a `null` on every rewrite.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordingMeta {
    pub call_id: String,
    pub peer: String,
    pub started_at: i64,
    pub duration_sec: u32,
    pub file_size_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Load the recording index from <app_data>/recordings.json
pub fn load_index(app_data: &Path) -> Result<Vec<RecordingMeta>, std::io::Error> {
    let path = app_data.join("recordings.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path)?;
    serde_json::from_str(&content)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Save the recording index to <app_data>/recordings.json (atomic **and** durable)
///
/// Temp file + `sync_all` + rename. `sync_all` is not decoration: the index is how the user finds
/// recordings whose audio files are sitting on disk, so an index lost to a power cut is silent
/// data loss that looks like "the recording never happened". `host_fs::write_atomic` and
/// `amos-appstore::atomic` both order the write this way; the fsync is *propagated*, not
/// swallowed, so the caller learns the write may not have landed.
pub fn save_index(app_data: &Path, index: &[RecordingMeta]) -> Result<(), std::io::Error> {
    let path = app_data.join("recordings.json");
    let content = serde_json::to_string_pretty(index)?;

    // Atomic write: tmp file + rename (same pattern as blocklist/sms_trash)
    let tmp = app_data.join("recordings.json.tmp");
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Add a new recording to the index and save atomically.
///
/// The id is validated here too, not only where a path is built: a ledger row whose id
/// [`remove_recording`] would later refuse is a row the user can never delete.
pub fn add_recording(app_data: &Path, meta: RecordingMeta) -> Result<(), std::io::Error> {
    safe_call_id(&meta.call_id)?;
    let mut index = load_index(app_data)?;
    // Deduplicate: if the call_id already exists, replace it
    index.retain(|r| r.call_id != meta.call_id);
    index.push(meta);
    save_index(app_data, &index)
}

/// Remove a recording from the index and delete the file.
///
/// The id is validated **before** anything is written or deleted ([`safe_call_id`]), so a
/// traversal-shaped id cannot reach `std::fs::remove_file` and cannot leave the ledger half
/// updated either.
///
/// **The ledger row is the delete, and it is committed before the audio is touched**
/// (REQ-A1602 / F-TEL-039). The row is what the list shows, so once it is gone the delete has
/// happened *for the user*: the unlink that follows is **best-effort**. Propagating its failure
/// would answer `Err` for a delete that already landed, and the page renders that as
/// 「删除失败，未删除该录音」 over a row that is gone — which then disappears on the next read,
/// a refusal that quietly succeeds. A file we cannot unlink (replaced by a directory, a
/// filesystem error) is orphaned bytes: logged, never a verdict.
///
/// Unlinking *after* the row keeps the failure direction honest the other way too: an audio
/// file removed before a failed `save_index` would leave a row pointing at audio that is gone,
/// which is the state [`add_recording`] exists to prevent.
pub fn remove_recording(app_data: &Path, call_id: &str) -> Result<(), std::io::Error> {
    let file = recording_path(app_data, call_id)?;
    let mut index = load_index(app_data)?;
    index.retain(|r| r.call_id != call_id);
    save_index(app_data, &index)?;

    match std::fs::remove_file(&file) {
        // The expected case for a row whose audio never landed (or already went away).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => {
            tracing::warn!(
                target: "amos::recording",
                error = %e,
                path = %file.display(),
                "recording removed from the ledger but its audio could not be unlinked; the file is now orphaned"
            );
            Ok(())
        }
        Ok(()) => Ok(()),
    }
}

// ─── The command seam (REQ-A1334): the ledger half, wired ────────────────────────────────
//
// Until this round the whole module was an orphan (`rust-unwired-baseline.json`: `recording.rs::*`,
// REQ-A480) — the storage contract existed with no reader at all. The ledger half has a real
// reader now (the recordings settings page); the capture half still has none, and that gap is a
// *fact the UI is told* rather than a blank the UI fills with an implied "recordings exist".

/// Whether this build can capture call audio at all, and if not, why.
///
/// The honest-boundary shape `crate::real_dial::RealDialStatus` uses, for the same reason:
/// capability is a fact a surface must not round up, and the reason is the host's own words so
/// the UI and the provider cannot drift into two stories about why capture is unavailable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RecordingCaptureStatus {
    /// A recording file can be minted *right now* on this build.
    pub available: bool,
    /// Why `available` is false, in the host's own words ("" when available).
    pub reason: String,
}

/// Why capture is unavailable when this is not an Android build (the desktop/host target, where
/// there is no in-call service to record through).
pub const CAPTURE_NO_SEAM_REASON: &str =
    "call recording is only available on Android, where the in-call service can record a call";

/// Why capture is unavailable when AmOS is not the bound default dialer: Android has not handed us
/// an `InCallService`, so there is no call for the recorder to attach to.
pub const CAPTURE_NOT_DIALER_REASON: &str =
    "call recording needs AmOS to be the device's default phone app (ROLE_DIALER), so an in-call \
     service is bound";

/// Why capture is unavailable when `RECORD_AUDIO` has not been granted: the `MediaRecorder` is
/// built on the microphone's permission even when it captures the mixed call stream.
pub const CAPTURE_NO_MIC_REASON: &str =
    "call recording needs the microphone permission (RECORD_AUDIO), which has not been granted";

/// The three runtime facts [`capture_status_for`] folds into a status. A struct rather than three
/// booleans so a caller cannot transpose the arguments, and so a host test can drive every arm
/// without a device.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CaptureFacts {
    /// This build has the in-call seam at all (Android + the compiled glue).
    pub platform_supports_capture: bool,
    /// AmOS is the bound default dialer, so a live call exists to record.
    pub dialer_bound: bool,
    /// `RECORD_AUDIO` — the permission the recorder's `MediaRecorder` is built on.
    pub mic_granted: bool,
}

/// Fold [`CaptureFacts`] into a [`RecordingCaptureStatus`]. Pure, so every arm the UI can read is
/// testable without a device.
///
/// The invariant a caller relies on and a test pins: `available == true` **iff** `reason` is
/// empty. It holds **by construction** — the reason is one of the three named constants or `""`,
/// and each constant is selected exactly when the fact it names is false, so no arm can return
/// "available" with a reason or "unavailable" with an empty one.
///
/// The three reasons are ordered concrete-to-general: a build with no seam is unavailable *for that
/// reason* even if a (nonexistent) dialer were somehow bound, because the seam is the more
/// fundamental fact.
pub fn capture_status_for(facts: CaptureFacts) -> RecordingCaptureStatus {
    let reason = if !facts.platform_supports_capture {
        CAPTURE_NO_SEAM_REASON
    } else if !facts.dialer_bound {
        CAPTURE_NOT_DIALER_REASON
    } else if !facts.mic_granted {
        CAPTURE_NO_MIC_REASON
    } else {
        ""
    };
    RecordingCaptureStatus {
        available: reason.is_empty(),
        reason: reason.to_string(),
    }
}

/// Read the three runtime facts for [`capture_status_for`] on this target.
///
/// On Android these come from the live glue (`crate::incall`): a bound service and a granted
/// microphone are both process facts the Kotlin side answers. On every other target all three are
/// false — the honest "there is no seam here", never a fabricated `true`.
///
/// **"Is a call in progress" is deliberately not one of them.** Capability is not opportunity: a
/// recording cannot *start* between calls either, but folding the call state in would make the
/// settings page's honest sentence flicker as calls come and go, and the in-call record button is
/// only reachable during a call anyway.
#[cfg(feature = "android")]
pub fn capture_facts() -> CaptureFacts {
    CaptureFacts {
        platform_supports_capture: true,
        dialer_bound: crate::incall::is_default_dialer_bound(),
        mic_granted: crate::incall::is_mic_granted(),
    }
}

/// Non-Android: no in-call seam exists, so capture is honestly unavailable (see
/// [`CAPTURE_NO_SEAM_REASON`]).
#[cfg(not(feature = "android"))]
pub fn capture_facts() -> CaptureFacts {
    CaptureFacts {
        platform_supports_capture: false,
        dialer_bound: false,
        mic_granted: false,
    }
}

/// Resolve the app-data root the ledger lives under.
///
/// **No fallback to the cache dir, on purpose.** `devcare_device.rs` accepts the cache dir for a
/// self-check *report*, but a recording is user data: landing one in a directory the OS may evict
/// would be a ledger row pointing at audio that was silently deleted. A missing app-data dir is
/// answered as a refusal, not rerouted somewhere it could vanish.
///
/// On Android the Kotlin glue persists under `Context.getFilesDir()`, while Tauri's
/// `app_data_dir()` resolves to `Context.getDataDir()` (the package dir, one level up). The two
/// must be aligned or the recorder writes where the ledger never looks — the blocklist / SMS-trash
/// / IME precedent (`crates/amos-tauri/src/lib.rs`) joins `"files"` here to land on the same
/// directory the glue writes to.
pub fn app_data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory to store recordings in: {e}"))?;
    #[cfg(feature = "android")]
    let base = base.join("files");
    Ok(base)
}

/// The stable `code` strings the recordings commands answer with (`error.rs`,
/// `ErrorCode::as_str`), named here so a caller branches on a constant rather than a re-spelled
/// literal.
pub mod codes {
    use crate::error::ErrorCode;

    /// A read driven by a window the user is not looking at (F-SH-657).
    pub const FOREGROUND_REQUIRED: &str = ErrorCode::RecordingsForegroundRequired.as_str();
    /// The ledger itself could not be read — a different fact from a foreground refusal.
    pub const READ_FAILED: &str = ErrorCode::RecordingsReadFailed.as_str();
}

/// Map a ledger read failure to its typed envelope (`amos.recordings.read_failed`).
fn read_failed(message: impl Into<String>) -> AmosError {
    AmosError::new(ErrorCode::RecordingsReadFailed, message)
}

/// The foreground rule for the recording **ledger** — the family
/// [`crate::clipboard::require_foreground`] already guards for `clipboard_read`,
/// `device_mic_start`, the in-call recording toggle, the SMS reads
/// (`sms::require_sms_foreground`) and the mail reads (`mail::require_mail_foreground`).
///
/// The ledger names *who* the user recorded, when, and for how long — a disclosure no less than
/// a mailbox's subject line. Without this, any window's WebView (including a page AmOS loads)
/// could reach `recordings_list` with one `invoke` and enumerate the user's recorded calls; the
/// frontend's capability ledger is a `$state` in the very JS context doing the reaching, so it
/// can never be the guard. The caller's label is injected by Tauri (not an argument), so a
/// caller cannot claim to be another window.
///
/// Named and compiled on **every** target (not behind `#[cfg(feature = "android")]`) for the
/// same reason the clipboard gate is: a host test can pin both directions, and the device is
/// what is pending, not the rule.
pub fn require_recordings_foreground(
    wm: &crate::wm::WmState,
    caller: &str,
) -> Result<(), AmosError> {
    crate::clipboard::require_foreground(wm, caller).map_err(|e| {
        // The rule is `clipboard::require_foreground`'s alone, and its words (the caller's
        // label and the focused one) ride along as the cause so an operator can read which
        // window *did* have the read.
        AmosError::with_cause(
            ErrorCode::RecordingsForegroundRequired,
            format!(
                "recordings read refused: {e} (only the window the user is looking at may read \
                 the recording ledger; F-SH-657)"
            ),
            e,
        )
    })
}

/// Tauri command: the recordings ledger (metadata only).
///
/// A device with no recordings is the **normal first state**, not a failure: [`load_index`]
/// answers an empty `Vec` for a missing index, so this returns `Ok([])` rather than an error the
/// page would have to tell apart from a real read failure.
///
/// Reading the ledger is a disclosure, so only the window the user is looking at may do it
/// ([`require_recordings_foreground`]); the refusal is its own typed code, distinct from the
/// index read failing — "this window may not read right now" and "the ledger could not be read"
/// are different facts and only the code can carry the difference to a caller.
#[tauri::command]
pub fn recordings_list(
    app: tauri::AppHandle,
    wm: State<'_, crate::wm::WmState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<RecordingMeta>, AmosError> {
    require_recordings_foreground(wm.inner(), window.label())?;
    let data = app_data_root(&app).map_err(read_failed)?;
    load_index(&data).map_err(|e| read_failed(format!("could not read the recording index: {e}")))
}

/// Tauri command: delete one recording — its ledger row and, if present, its audio file — and
/// answer the **surviving ledger**.
///
/// It returns the list, not `()`, on purpose. `tauri`'s `invoke` resolves `null` for a failed
/// command, and a `Result<(), _>` also serializes its *success* as `null` — so a void delete would
/// make "deleted" and "refused" the same value at the wire, and a page that repainted on it would
/// report a refusal as a deletion. The post-state is also the authoritative thing the caller wants:
/// the row is gone from *this* list rather than from a list it assumed.
///
/// The call id reaches [`remove_recording`], which validates it ([`safe_call_id`]) **before**
/// anything is written or deleted: an id shaped like a path is refused rather than turned into a
/// delete primitive aimed outside the recordings root.
#[tauri::command]
pub fn recording_delete(
    app: tauri::AppHandle,
    call_id: String,
) -> Result<Vec<RecordingMeta>, String> {
    let data = app_data_root(&app)?;
    remove_recording(&data, &call_id)
        .map_err(|e| format!("could not delete the recording: {e}"))?;
    load_index(&data).map_err(|e| format!("could not read the recording index: {e}"))
}

/// Tauri command: can this build capture call audio right now, and if not, why not?
///
/// Cheap and pure (reads the runtime facts, no I/O), so a page may ask it on open and draw the
/// honest "capture not available on this build" line from the answer instead of inferring it from
/// an empty list — an empty list means "no recordings", not "recording is impossible".
///
/// **Deliberately zero-parameter and outside the foreground gate.** It answers a *capability*
/// (can this build tap call audio?) and carries no user data — the same boundary the mail reads
/// draw around `mail_mailboxes`. Adding a window/caller argument would drag it behind
/// [`require_recordings_foreground`] for no privacy gain, and the source pin
/// `the_ledger_read_propagates_the_foreground_gate` holds it outside.
#[tauri::command]
pub fn recordings_capture_status() -> RecordingCaptureStatus {
    capture_status_for(capture_facts())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_path_uses_call_id() {
        let app_data = PathBuf::from("/data/app");
        let path = recording_path(&app_data, "tel_001").expect("a plain id is usable");
        assert_eq!(path, PathBuf::from("/data/app/recordings/tel_001.m4a"));
    }

    // ─── the call id is a path component (REQ-A652) ───────────────────────
    //
    // `Path::join` replaces the whole path for an absolute argument and walks out of the
    // directory on `..`; `remove_recording` deletes the result. These cases are the reason
    // `safe_call_id` exists, and each one was measured against the pre-fix code (see the
    // module header).

    #[test]
    fn a_call_id_that_is_a_path_is_refused() {
        let app_data = PathBuf::from("/data/app");
        for evil in [
            "",
            ".",
            "..",
            "/etc/passwd",
            "../escape",
            "../../etc/passwd",
            "a/b",
            "a\\b",
            "good/../bad",
            "good/..",
            "tel_0001\u{0}",
            "tel_0001\nmore",
        ] {
            assert!(
                recording_path(&app_data, evil).is_err(),
                "id {evil:?} must not become a path"
            );
        }
    }

    #[test]
    fn an_oversized_call_id_is_refused_at_the_producers_own_bound() {
        let app_data = PathBuf::from("/data/app");
        let ok = "t".repeat(MAX_TELEPHONY_CALL_ID_BYTES);
        assert!(
            recording_path(&app_data, &ok).is_ok(),
            "the seam's own cap must be accepted"
        );
        let too_long = "t".repeat(MAX_TELEPHONY_CALL_ID_BYTES + 1);
        assert!(
            recording_path(&app_data, &too_long).is_err(),
            "one byte over the telephony cap must be refused"
        );
    }

    #[test]
    fn an_accepted_id_always_stays_inside_the_recordings_root() {
        let app_data = PathBuf::from("/data/app");
        let root = recording_dir(&app_data);
        for id in ["tel_0000000000000001", "a", "a-b_c.d", "..hidden", "...."] {
            let p = recording_path(&app_data, id).expect("plain ids are usable");
            assert_eq!(
                p.parent(),
                Some(root.as_path()),
                "id {id:?} must resolve to a direct child of the recordings root"
            );
        }
    }

    /// The **behavioural** negative control, in two halves so the deletion itself is the
    /// measurement rather than a side effect of the refusal assertion.
    ///
    /// Half 1: the call is refused.
    #[test]
    fn remove_recording_refuses_a_traversal_id() {
        let temp = tempfile::tempdir().unwrap();
        // The real precondition: the recordings root exists (it does as soon as anything was
        // ever stored). Without it the traversal resolves to `NotFound` by accident and the
        // escape would look impossible.
        std::fs::create_dir_all(recording_dir(temp.path())).unwrap();
        let err =
            remove_recording(temp.path(), "../victim").expect_err("a traversal id must be refused");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    }

    /// Half 2: nothing outside the recordings root is touched. This one deliberately does **not**
    /// assert on the `Result` — under the pre-fix code the call *succeeds* and deletes the file,
    /// so asserting the file survives is what makes the defect visible (measured: with the
    /// judgement removed, this fails with "the outside file must survive").
    #[test]
    fn a_refused_removal_deletes_nothing_outside_the_recordings_root() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(recording_dir(temp.path())).unwrap();
        let victim = temp.path().join("victim.m4a");
        std::fs::write(&victim, b"not yours to delete").unwrap();

        let _ = remove_recording(temp.path(), "../victim");

        assert!(
            victim.exists(),
            "the outside file must survive: a recording id may not delete anything outside \
             <app_data>/recordings/"
        );
    }

    /// The absolute-id shape needs no `recordings/` directory at all: `Path::join` **replaces**
    /// the base for an absolute argument, so the pre-fix code aimed straight at the caller's path.
    #[test]
    fn an_absolute_id_cannot_aim_the_delete_anywhere() {
        let temp = tempfile::tempdir().unwrap();
        let victim = temp.path().join("elsewhere.m4a");
        std::fs::write(&victim, b"nor this").unwrap();
        let absolute = victim.with_extension("").to_string_lossy().into_owned();

        let _ = remove_recording(temp.path(), &absolute);

        assert!(
            victim.exists(),
            "an absolute id must not aim the delete at {absolute:?}"
        );
    }

    #[test]
    fn add_recording_refuses_a_traversal_id_and_writes_no_row() {
        let temp = tempfile::tempdir().unwrap();
        let meta = RecordingMeta {
            call_id: "../escape".into(),
            peer: "13800138000".into(),
            started_at: 1726560000,
            duration_sec: 60,
            file_size_bytes: 512000,
            source: None,
        };
        assert!(add_recording(temp.path(), meta).is_err());
        // Nothing was written at all — not an empty ledger, not a stray row.
        assert!(!temp.path().join("recordings.json").exists());
        assert!(load_index(temp.path()).unwrap().is_empty());
    }

    /// `save_index` must not leave the staging file behind on success, and the ledger it
    /// publishes must be re-readable (the fsync is inside this path).
    #[test]
    fn save_index_leaves_no_staging_file_and_stays_readable() {
        let temp = tempfile::tempdir().unwrap();
        let meta = RecordingMeta {
            call_id: "tel_001".into(),
            peer: "13800138000".into(),
            started_at: 1726560000,
            duration_sec: 60,
            file_size_bytes: 512000,
            source: None,
        };
        add_recording(temp.path(), meta.clone()).unwrap();
        assert!(
            !temp.path().join("recordings.json.tmp").exists(),
            "a completed write leaves no staging file"
        );
        assert_eq!(load_index(temp.path()).unwrap(), vec![meta]);
    }

    #[test]
    fn recording_dir_is_under_app_data() {
        let app_data = PathBuf::from("/data/app");
        let dir = recording_dir(&app_data);
        assert_eq!(dir, PathBuf::from("/data/app/recordings"));
    }

    #[test]
    fn empty_index_loads_as_empty_vec() {
        let temp = tempfile::tempdir().unwrap();
        let index = load_index(temp.path()).unwrap();
        assert!(index.is_empty());
    }

    #[test]
    fn roundtrip_preserves_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let meta = vec![RecordingMeta {
            call_id: "tel_001".into(),
            peer: "13800138000".into(),
            started_at: 1726560000,
            duration_sec: 120,
            file_size_bytes: 1024000,
            source: None,
        }];
        save_index(temp.path(), &meta).unwrap();
        let loaded = load_index(temp.path()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].call_id, "tel_001");
        assert_eq!(loaded[0].duration_sec, 120);
    }

    #[test]
    fn add_recording_creates_index_if_missing() {
        let temp = tempfile::tempdir().unwrap();
        let meta = RecordingMeta {
            call_id: "tel_001".into(),
            peer: "13800138000".into(),
            started_at: 1726560000,
            duration_sec: 60,
            file_size_bytes: 512000,
            source: None,
        };
        add_recording(temp.path(), meta.clone()).unwrap();
        let loaded = load_index(temp.path()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0], meta);
    }

    #[test]
    fn add_recording_deduplicates_by_call_id() {
        let temp = tempfile::tempdir().unwrap();
        let meta1 = RecordingMeta {
            call_id: "tel_001".into(),
            peer: "13800138000".into(),
            started_at: 1726560000,
            duration_sec: 60,
            file_size_bytes: 512000,
            source: None,
        };
        let meta2 = RecordingMeta {
            call_id: "tel_001".into(),
            peer: "13800138000".into(),
            started_at: 1726560120,
            duration_sec: 90,
            file_size_bytes: 768000,
            source: None,
        };
        add_recording(temp.path(), meta1).unwrap();
        add_recording(temp.path(), meta2.clone()).unwrap();
        let loaded = load_index(temp.path()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0], meta2); // Second write wins
    }

    #[test]
    fn remove_recording_updates_index_and_deletes_file() {
        let temp = tempfile::tempdir().unwrap();
        let rec_dir = recording_dir(temp.path());
        std::fs::create_dir_all(&rec_dir).unwrap();

        let meta = RecordingMeta {
            call_id: "tel_001".into(),
            peer: "13800138000".into(),
            started_at: 1726560000,
            duration_sec: 60,
            file_size_bytes: 512000,
            source: None,
        };
        add_recording(temp.path(), meta).unwrap();

        // Create a dummy file
        let file = recording_path(temp.path(), "tel_001").expect("a plain id is usable");
        std::fs::write(&file, b"audio data").unwrap();
        assert!(file.exists());

        // Remove it
        remove_recording(temp.path(), "tel_001").unwrap();
        let loaded = load_index(temp.path()).unwrap();
        assert!(loaded.is_empty());
        assert!(!file.exists());
    }

    /// The ledger row is the delete. A recording whose audio **cannot** be unlinked is still a
    /// recording the user deleted.
    ///
    /// Filing the row's removal and *then* answering `Err` because the audio would not unlink
    /// makes the page print 「删除失败，未删除该录音」 over a row that is already gone — and the
    /// row then vanishes on the next read, i.e. a refusal that quietly succeeds
    /// (REQ-A1602 / F-TEL-039). The unlink is best-effort: the orphaned bytes stay, and the
    /// fact is logged, but they must not un-delete the row.
    ///
    /// The stand-in for a real unlink failure is a **directory** at the recording's path: it
    /// exists (so the old `exists()` guard passed) and `remove_file` cannot remove it. That is
    /// deterministic and hermetic, where a locked/in-use file or a filesystem error is neither.
    #[test]
    fn a_recording_whose_audio_cannot_be_unlinked_is_still_deleted() {
        let temp = tempfile::tempdir().unwrap();
        let meta = RecordingMeta {
            call_id: "tel_001".into(),
            peer: "13800138000".into(),
            started_at: 1726560000,
            duration_sec: 60,
            file_size_bytes: 512000,
            source: None,
        };
        add_recording(temp.path(), meta).unwrap();
        let path = recording_path(temp.path(), "tel_001").expect("a plain id is usable");
        std::fs::create_dir_all(&path).unwrap();

        remove_recording(temp.path(), "tel_001")
            .expect("the row is gone from the ledger, so the delete happened");

        let loaded = load_index(temp.path()).unwrap();
        assert!(
            loaded.iter().all(|r| r.call_id != "tel_001"),
            "the row must be gone — the ledger is the delete: {loaded:?}"
        );
        assert!(
            path.exists(),
            "the path that could not be unlinked is left as it was, not claimed away"
        );
    }

    // ─── the capture-status seam (REQ-A1334 → REQ-A1579) ─────────────────────
    //
    // The status is what keeps a listing UI from implying audio exists. Its whole
    // job is to be *not roundable up*: whenever a fact the recorder needs is
    // missing, `available` must be false and the reason must name that fact.

    /// No seam at all (the desktop/host target): unavailable, and the reason names the missing
    /// seam rather than the dialer or the microphone — that is the more fundamental fact.
    #[test]
    fn an_unwired_capture_reports_unavailable_with_the_seams_own_reason() {
        let s = capture_status_for(CaptureFacts {
            platform_supports_capture: false,
            dialer_bound: false,
            mic_granted: false,
        });
        assert!(
            !s.available,
            "a build with no seam must not claim capture works"
        );
        assert_eq!(s.reason, CAPTURE_NO_SEAM_REASON);
        assert!(
            s.reason.contains("Android"),
            "the reason must name where capture lives: {}",
            s.reason
        );
    }

    /// Each missing fact names **its own** constant — so the page's sentence and the reason the
    /// code produces cannot tell two different stories about why capture is off. The seam case is
    /// separated because a build with no seam is unavailable *for that reason* even with a
    /// (nonexistent) dialer bound: the seam is checked first.
    #[test]
    fn each_missing_fact_names_its_own_reason() {
        let cases = [
            (
                CaptureFacts {
                    platform_supports_capture: true,
                    dialer_bound: false,
                    mic_granted: false,
                },
                CAPTURE_NOT_DIALER_REASON,
            ),
            (
                CaptureFacts {
                    platform_supports_capture: true,
                    dialer_bound: true,
                    mic_granted: false,
                },
                CAPTURE_NO_MIC_REASON,
            ),
            (
                CaptureFacts {
                    platform_supports_capture: false,
                    dialer_bound: true,
                    mic_granted: true,
                },
                CAPTURE_NO_SEAM_REASON,
            ),
        ];
        for (facts, expected) in cases {
            let s = capture_status_for(facts);
            assert!(
                !s.available,
                "a missing fact must not claim capture works: {facts:?}"
            );
            assert_eq!(
                s.reason, expected,
                "the reason must name the missing fact: {facts:?}"
            );
        }
    }

    /// Every fact present ⇒ available **and** an empty reason. The positive control: without it a
    /// `capture_status_for` that always refuses would pass every other assertion here.
    #[test]
    fn all_facts_present_reports_available_with_no_reason() {
        let s = capture_status_for(CaptureFacts {
            platform_supports_capture: true,
            dialer_bound: true,
            mic_granted: true,
        });
        assert!(
            s.available,
            "a bound dialer with the mic granted must report capture works"
        );
        assert!(
            s.reason.is_empty(),
            "an available status carries no reason: {}",
            s.reason
        );
    }

    /// The invariant a caller relies on — `available == reason.is_empty()` — across **every** one
    /// of the eight combinations, so no arm can be added that returns "available" with a reason or
    /// "unavailable" with an empty one.
    #[test]
    fn the_two_halves_of_the_status_never_disagree() {
        for bits in 0u8..8 {
            let facts = CaptureFacts {
                platform_supports_capture: bits & 0b100 != 0,
                dialer_bound: bits & 0b010 != 0,
                mic_granted: bits & 0b001 != 0,
            };
            let s = capture_status_for(facts);
            assert_eq!(
                s.available,
                s.reason.is_empty(),
                "available and reason must be complements (facts={facts:?}): {s:?}"
            );
        }
    }

    /// The shipped command must be exactly the fold of the shipped runtime facts — so the page's
    /// answer cannot drift from the facts the recorder itself checks.
    ///
    /// On the host test target the facts are all false (no seam), so the status is honestly
    /// unavailable; the assertion is written against `capture_facts()` rather than a hardcoded
    /// reason so it holds under both `--features android` and the default build.
    #[test]
    fn the_shipped_status_is_folded_from_the_runtime_facts() {
        let facts = capture_facts();
        assert_eq!(
            recordings_capture_status(),
            capture_status_for(facts),
            "the command must answer the fold of the runtime facts, not a second opinion"
        );
        // A host test process has no bound in-call service, so capture is honestly off there —
        // what must hold is that the *surface* is told so, never a fabricated "available".
        let status = recordings_capture_status();
        assert!(
            !status.available,
            "no in-call service is bound in a test process; if this fires, capture landed and \
             the settings page's copy needs updating too"
        );
    }

    /// The delete command must answer the **surviving ledger**, never a bare `Ok(())`: a
    /// `Result<(), _>` serializes its success as `null`, which is exactly the value `invoke`
    /// resolves for a *refused* command — so a void delete would make "deleted" and "refused"
    /// the same value at the wire. This is a source pin because the difference is in the
    /// signature, not in any behaviour a test with an `AppHandle` could reach here.
    #[test]
    fn the_delete_command_answers_the_surviving_ledger_not_a_bare_ok() {
        const SRC: &str = include_str!("recording.rs");
        let start = SRC
            .find("pub fn recording_delete(")
            .expect("the delete command still exists");
        let sig = &SRC[start..start + 220];
        assert!(
            sig.contains("Vec<RecordingMeta>"),
            "recording_delete must return the surviving ledger, not `()`: {sig}"
        );
    }

    #[test]
    fn remove_recording_succeeds_if_file_missing() {
        let temp = tempfile::tempdir().unwrap();
        let meta = RecordingMeta {
            call_id: "tel_001".into(),
            peer: "13800138000".into(),
            started_at: 1726560000,
            duration_sec: 60,
            file_size_bytes: 512000,
            source: None,
        };
        add_recording(temp.path(), meta).unwrap();
        // File was never created, but remove should still work
        remove_recording(temp.path(), "tel_001").unwrap();
        let loaded = load_index(temp.path()).unwrap();
        assert!(loaded.is_empty());
    }

    // ─── the foreground gate (F-SH-657) ──────────────────────────────────────
    //
    // The ledger names the user's recorded calls, so reading it is a disclosure. These are the
    // family's other half: `recordings_list` was the last provider-backed private read that no
    // caller check guarded (the SMS / mail / clipboard / mic / in-call families already do).

    /// The focused window may read. `WmState::new()` seeds the launcher (`"main"`) focused —
    /// the phone/tablet shell's single window, which is where the settings page runs there.
    #[test]
    fn the_focused_window_may_read_recordings() {
        let wm = crate::wm::WmState::new();
        assert_eq!(crate::clipboard::foreground_label(&wm).unwrap(), "main");
        assert!(
            require_recordings_foreground(&wm, "main").is_ok(),
            "the window the user is looking at must be able to read the ledger"
        );
    }

    /// Any other window is refused — and the refusal is honest about *which* fact it is. The
    /// code is its own (`foreground_required`), **not** the read-failure one: "this window may
    /// not read right now" is a different fact from "the ledger is unreadable", and only the
    /// code can carry that distinction to a caller.
    #[test]
    fn a_background_window_is_refused_a_read() {
        let wm = crate::wm::WmState::new();
        let err = require_recordings_foreground(&wm, "settings").unwrap_err();
        assert_eq!(err.code(), "amos.recordings.foreground_required");
        assert_eq!(err.code(), codes::FOREGROUND_REQUIRED);
        assert_ne!(
            err.code(),
            codes::READ_FAILED,
            "a foreground refusal must not be reported as the ledger failing to read"
        );
        // The cause chain keeps `require_foreground`'s own words: both labels, so an operator
        // can read which window *did* have the read.
        let text = err.to_string();
        assert!(
            text.contains("settings") && text.contains("main"),
            "the refusal must name the caller and the window that does have the read: got \
             `{text}`"
        );
    }

    /// The read failure is its own code. Mapping it to `foreground_required` folds two different
    /// facts into one — "this window may not read right now" and "the ledger is unreadable" — and
    /// the frontend branches on the code to tell them apart (a foreground refusal is *owed* and
    /// paid back when the window returns to focus; a read failure is not). The first version of
    /// this round made exactly that fold; this pins it shut.
    #[test]
    fn a_ledger_read_failure_is_not_a_foreground_refusal() {
        let err = read_failed("no app-data dir");
        assert_eq!(err.code(), "amos.recordings.read_failed");
        assert_eq!(err.code(), codes::READ_FAILED);
        assert_ne!(
            err.code(),
            codes::FOREGROUND_REQUIRED,
            "the ledger failing to read must not be reported as a foreground refusal — the caller \
             would then draw it as 'return to this window and it will work'"
        );
    }

    /// The statement in `body` that calls the gate, trimmed (the clipboard twin's first
    /// version asked only whether the *name* appeared — a discarded `Result` denies nothing,
    /// so a `let _ = …` left it green).
    fn gate_statement<'a>(body: &'a str, fname: &str) -> &'a str {
        let at = body
            .find("require_recordings_foreground(")
            .unwrap_or_else(|| {
                panic!(
                "{fname} must gate its read through require_recordings_foreground — a background \
                 window draining the user's recording ledger is the F-SH-657 privacy failure"
            )
            });
        let tail = &body[at..];
        let semi = tail.find(';').unwrap_or(tail.len());
        tail[..semi].trim()
    }

    /// The body of the `#[tauri::command] pub … fn <fname>` in this file, up to its matching
    /// closing brace. Brace-counted (not "next `\n}`") so a nested block cannot cut it short.
    fn command_body<'a>(src: &'a str, fname: &str) -> &'a str {
        let needle = format!("fn {fname}(");
        let start = src
            .find(&needle)
            .unwrap_or_else(|| panic!("{fname} not found in recording.rs"));
        let open = src[start..]
            .find('{')
            .map(|o| start + o)
            .unwrap_or_else(|| panic!("{fname} has no body"));
        let mut depth = 0usize;
        for (i, ch) in src[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &src[open..open + i + 1];
                    }
                }
                _ => {}
            }
        }
        panic!("{fname}'s body never closed");
    }

    /// Source-level pin: the one command that hands back the recording ledger calls the gate,
    /// and the call **is** the statement (propagated with `?`), not a value dropped on the
    /// floor. Deleting the gate from `recordings_list` makes this fail.
    #[test]
    fn the_ledger_read_propagates_the_foreground_gate() {
        const SRC: &str = include_str!("recording.rs");
        let stmt = gate_statement(command_body(SRC, "recordings_list"), "recordings_list");
        assert!(
            stmt.starts_with("require_recordings_foreground("),
            "recordings_list's gate must *be* the statement, not a value handed to something \
             else (a discarded `Result` denies nothing): got `{stmt}`"
        );
        assert!(
            stmt.ends_with(")?"),
            "recordings_list must propagate the gate's refusal with `?`: got `{stmt}`"
        );
        // The contrast that makes it meaningful. `recordings_capture_status` answers a
        // *capability* (can this build tap call audio?), carries no user data, and reads only a
        // constant — the same boundary the mail reads draw around `mail_mailboxes`. The delete
        // verb is deliberately *not* gated either: deleting a recording from a background window
        // is not a disclosure of the ledger, which is the attack this rule is about. Gating it
        // would be a different decision (an action rule).
        for fname in ["recordings_capture_status", "recording_delete"] {
            assert!(
                !command_body(SRC, fname).contains("require_recordings_foreground("),
                "{fname} must not carry the *read* gate — the rule here is about disclosure"
            );
        }
    }
}
