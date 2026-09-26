//! SMS bridge — exposes the real-SMS domain (`amos-sms`) to the WebView.
//!
//! Same shape as the radio/flashlight bridges, with three production concerns
//! made explicit:
//!
//! * **No UI-thread blocking.** Reading SMS means `ContentResolver`/JNI work on
//!   device. Tauri runs *synchronous* commands on the main thread, so every
//!   command here is `async` and the provider call is moved to the blocking pool
//!   (`tauri::async_runtime::spawn_blocking`) with a hard [`SMS_TIMEOUT`] — a
//!   wedged platform call surfaces as an honest timeout instead of a frozen UI
//!   (an error for a read; `unconfirmed` for a send, which may still go out).
//! * **Honest state.** `sms_status` reports which backend is in effect so the UI
//!   can tell the device inbox apart from the host mock (which is *not* an empty
//!   inbox); permission denial is an error, never an empty list.
//! * **Audited sends.** `sms_send` validates at the boundary and logs the
//!   outcome with a **masked** address (never the body — privacy is preserved).
//!
//! On the desktop/CI host the provider is `MockSms::new()` — an empty, honest
//! inbox (no real SMS on a host, never faked). On a real device the Kotlin
//! `SmsGlue` installs `AndroidSmsProvider` (see `docs/sms.md`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::Duration;

use amos_sms::{
    normalize_address, segment_count, validate_text, MockSms, PreviewOverride, SmsFolder,
    SmsMessage, SmsProvider, SmsSendOutcome, SmsThread, SmsTrash, TrashEntry, DEFAULT_TRASH_CAP,
};
use serde::Serialize;
use tauri::State;

use crate::error::{AmosError, ErrorCode};

/// Wire vocabulary for the SMS module. The UI i18n layer branches on these;
/// renaming a variant is a wire break. Kept alongside the constants so the
/// code names match the typed envelopes below without grepping.
pub mod codes {
    use crate::error::ErrorCode;
    /// Caller passed a blank `thread_id` / `message_id` / `address` to an SMS command.
    pub const BLANK_ID: &str = ErrorCode::SmsBlankId.as_str();
    /// Caller passed a thread / message / address id that is over [`super::MAX_SMS_ID_BYTES`].
    pub const ID_TOO_LONG: &str = ErrorCode::SmsIdTooLong.as_str();
    /// Caller passed an unknown folder name (`inbox` | `sent` | `draft` only).
    pub const UNKNOWN_FOLDER: &str = ErrorCode::SmsUnknownFolder.as_str();
    /// Caller asked for messages from a sender the blocklist has blocked for SMS.
    pub const BLOCKED_SENDER: &str = ErrorCode::SmsBlockedSender.as_str();
    /// The `sms_send` text body exceeds [`super::MAX_SMS_TEXT_BYTES`].
    pub const TEXT_TOO_LONG: &str = ErrorCode::SmsTextTooLong.as_str();
    /// SMS provider rejected the read / send (SmsError kind); the user-visible
    /// reason lives in `message` and the SmsError kind in `cause[0]`.
    pub const PROVIDER_REJECTED: &str = ErrorCode::SmsProviderRejected.as_str();
    /// A read carrying the user's messages came from a window the user is not looking at.
    pub const FOREGROUND_REQUIRED: &str = ErrorCode::SmsForegroundRequired.as_str();
}

/// Hard cap on one provider call. The blocking task itself cannot be cancelled,
/// but the caller is released with an honest timeout instead of hanging — a
/// [`amos_sms::SmsError::TimedOut`], which a *read* surfaces as an error and a
/// *send* answers as `unconfirmed` (the message may still go out; REQ-A1759).
const SMS_TIMEOUT: Duration = Duration::from_secs(8);

/// Maximum bytes in an SMS `thread_id` / `message_id` / `address` string the
/// WebView hands in via `sms_*` commands.
///
/// Real platform ids are short hashes / addresses (`thread_<digits>`, an E.164
/// phone number). The 256-byte cap mirrors `MAX_MAIL_NAME_BYTES` — well above
/// any legitimate value, and tight enough that a paste-sized caller cannot
/// inflate the provider's lookup keys.
pub const MAX_SMS_ID_BYTES: usize = 256;

/// Maximum bytes in an `sms_send` `text` payload.
///
/// The SMS engine already enforces [`amos_sms::validate::MAX_TEXT_CHARS`] (1600
/// chars ≈ 10 GSM-7 segments); the bridge-level guard is a defence-in-depth
/// ceiling so a JSON failure (e.g. an over-cap text deserialised as empty
/// after a JS bug) cannot bypass the engine's check by a path where the
/// underlying library is rebuilt without the validation crate.
///
/// A backstop must never be **tighter** than the gate it backs up, so the ceiling
/// is the byte-image of the engine's char limit: a legal body occupies at most four
/// UTF-8 bytes per char. The former `4 << 10` (4096) was *below* that image for
/// every non-ASCII body — 1600 Chinese characters are 4800 bytes, i.e. an SMS the
/// engine accepts was refused at the bridge (audit P1-S1). Raising the ceiling
/// cannot weaken validation: [`checked_send`] runs `validate_text` on every call,
/// immediately after this guard.
pub const MAX_SMS_TEXT_BYTES: usize = amos_sms::validate::MAX_TEXT_CHARS * 4;

/// Bridge state managed by Tauri.
pub struct SmsBridge {
    provider: Arc<dyn SmsProvider>,
}

impl SmsBridge {
    /// Desktop/CI boot: an empty (honest) mock inbox — no real SMS is claimed.
    pub fn boot() -> Self {
        Self {
            provider: Arc::new(MockSms::new()),
        }
    }

    /// Build over any provider (used by device bring-up / tests).
    pub fn with_provider(provider: Box<dyn SmsProvider>) -> Self {
        Self {
            provider: Arc::from(provider),
        }
    }
}

impl Default for SmsBridge {
    fn default() -> Self {
        Self::boot()
    }
}

/// Serializable mirror of an SMS thread.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SmsThreadOut {
    pub id: String,
    pub address: String,
    pub display_name: String,
    pub last_text: String,
    pub last_ts_ms: i64,
    pub unread: u32,
}

impl From<&SmsThread> for SmsThreadOut {
    fn from(t: &SmsThread) -> Self {
        Self {
            id: t.id.clone(),
            address: t.address.clone(),
            display_name: t.display_name.clone(),
            last_text: t.last_text.clone(),
            last_ts_ms: t.last_ts_ms,
            unread: t.unread,
        }
    }
}

/// Serializable mirror of one SMS message.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SmsMessageOut {
    pub thread_id: String,
    pub id: String,
    pub from_me: bool,
    pub text: String,
    pub ts_ms: i64,
    pub read: bool,
}

impl From<&SmsMessage> for SmsMessageOut {
    fn from(m: &SmsMessage) -> Self {
        Self {
            thread_id: m.thread_id.clone(),
            id: m.id.clone(),
            from_me: m.from_me,
            text: m.text.clone(),
            ts_ms: m.ts_ms,
            read: m.read,
        }
    }
}

/// Serializable folder counts (tabs/badges).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SmsFolderCountsOut {
    pub inbox: u32,
    pub sent: u32,
    pub draft: u32,
}

impl From<&amos_sms::SmsFolderCounts> for SmsFolderCountsOut {
    fn from(c: &amos_sms::SmsFolderCounts) -> Self {
        Self {
            inbox: c.inbox,
            sent: c.sent,
            draft: c.draft,
        }
    }
}

/// Serializable backend status so the UI can distinguish the device inbox from
/// the host mock without guessing (and without doing any I/O).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SmsStatusOut {
    /// Backend id: `"mock"` (host/offline) or `"android-sms"` (device).
    pub provider: String,
    /// `true` only for a real device backend.
    pub device: bool,
}

/// The provider in effect: the installed on-device backend when present
/// (feature `android`), else the host mock held by the bridge.
fn active_arc(state: &SmsBridge) -> Arc<dyn SmsProvider> {
    #[cfg(feature = "android")]
    {
        if let Some(p) = device::DEVICE.get() {
            return Arc::clone(p);
        }
    }
    Arc::clone(&state.provider)
}

/// Run one provider call on the blocking pool under a hard timeout.
///
/// Provider reads/sends are blocking (ContentResolver/JNI); running them on the
/// async runtime would stall other commands, and running them on the main thread
/// (which is where Tauri executes *sync* commands) would freeze the UI.
async fn blocking<T, F>(f: F) -> Result<T, amos_sms::SmsError>
where
    F: FnOnce() -> Result<T, amos_sms::SmsError> + Send + 'static,
    T: Send + 'static,
{
    blocking_with(SMS_TIMEOUT, f).await
}

/// [`blocking`] with an explicit timeout (so tests can use a short one).
async fn blocking_with<T, F>(timeout: Duration, f: F) -> Result<T, amos_sms::SmsError>
where
    F: FnOnce() -> Result<T, amos_sms::SmsError> + Send + 'static,
    T: Send + 'static,
{
    use amos_sms::SmsError;
    match tokio::time::timeout(timeout, tauri::async_runtime::spawn_blocking(f)).await {
        Ok(Ok(result)) => result,
        Ok(Err(join_err)) => Err(SmsError::Failed(format!(
            "SMS worker did not complete: {join_err}"
        ))),
        // A caller-side timeout is an *absent* verdict, not a failure of the
        // operation: the blocking task keeps running (it cannot be cancelled), so
        // for a send the radio may still take the message. Kept a distinct variant
        // so `sms_send` can answer honestly instead of claiming a refusal
        // (REQ-A1759/F-TEL-045).
        Err(_) => Err(SmsError::TimedOut(format!(
            "no verdict within {}s",
            timeout.as_secs()
        ))),
    }
}

/// Fold a failed provider call into the *send* command's answer.
///
/// [`SmsError::TimedOut`] is a caller-side timeout — the provider never named a
/// verdict — so the honest answer is the glue's own `unconfirmed` ("no verdict
/// within our window; keep the text, it may still go out"), **not** an error the
/// UI renders as 「发送失败」. The whole send path is built so "a missing verdict
/// is a question, a refusal is a fact" (REQ-A1620/F-TEL-040); a timeout is the one
/// place the fold could still happen. Every other failure *is* a named refusal and
/// stays a typed error (REQ-A1759/F-TEL-045).
fn send_outcome_from_failure(e: amos_sms::SmsError) -> Result<SmsSendOutcome, AmosError> {
    match e {
        amos_sms::SmsError::TimedOut(why) => Ok(SmsSendOutcome::Unconfirmed(why)),
        other => Err(AmosError::with_cause(
            ErrorCode::SmsProviderRejected,
            codes::PROVIDER_REJECTED,
            other,
        )),
    }
}

/// Mask an address for audit logs: keep at most the last 4 digits.
fn mask_address(address: &str) -> String {
    let digits: Vec<char> = address.chars().filter(char::is_ascii_digit).collect();
    let tail: String = digits[digits.len().saturating_sub(4)..].iter().collect();
    format!("***{tail}")
}

/// Validate a send before dispatch (fast, no I/O); returns the normalized
/// address and segment count for the audit trail.
fn checked_send(address: &str, text: &str) -> Result<(String, usize), AmosError> {
    let addr = normalize_address(address).map_err(|e| {
        AmosError::with_cause(ErrorCode::SmsProviderRejected, codes::PROVIDER_REJECTED, e)
    })?;
    validate_text(text).map_err(|e| {
        AmosError::with_cause(ErrorCode::SmsProviderRejected, codes::PROVIDER_REJECTED, e)
    })?;
    Ok((addr, segment_count(text)))
}

/// Bound a thread_id / message_id / address string at the command seam so a
/// paste-sized caller cannot inflate the SMS provider's lookup keys (the keys
/// are reused on every list / read command — a 1 MiB id would slow every
/// subsequent operation).
fn check_sms_id(s: &str) -> Result<(), AmosError> {
    if s.is_empty() {
        return Err(AmosError::new(ErrorCode::SmsBlankId, "sms id is empty"));
    }
    if s.len() > MAX_SMS_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::SmsIdTooLong,
            format!(
                "sms id too long: {} bytes (max {MAX_SMS_ID_BYTES})",
                s.len()
            ),
        ));
    }
    Ok(())
}

/// Which backend backs SMS right now (no I/O — safe to call at any time).
#[tauri::command]
pub fn sms_status(state: State<'_, SmsBridge>) -> SmsStatusOut {
    status_of(active_arc(&state).as_ref())
}

// ---- Display-path balance redaction (REQ-A41) ------------------------------
//
// The UI funnels through exactly these two mappings, so masking here (and only
// here) guarantees that no balance amount reaches any consumer of the commands
// while the platform SMS store keeps the original text. The rewrite is
// idempotent (domain rule) and audit-logged by count only — never by content.

/// Serializable mirror of one thread with its preview redacted.
fn redact_thread(t: &SmsThread) -> SmsThreadOut {
    let mut out = SmsThreadOut::from(t);
    out.last_text = amos_sms::redact_for(&t.address, &t.last_text).into_owned();
    out
}

/// Map threads to mirrors; returns how many previews actually changed.
fn redact_threads(threads: &[SmsThread]) -> (Vec<SmsThreadOut>, usize) {
    let mut masked = 0;
    let out = threads
        .iter()
        .map(|t| {
            let o = redact_thread(t);
            if o.last_text != t.last_text {
                masked += 1;
            }
            o
        })
        .collect();
    (out, masked)
}

/// Map messages to mirrors with the sender context applied (bank senders get
/// the stricter rule set); returns how many bodies actually changed. An
/// absent/unknown sender degrades to the content-only rule — masking never
/// depends on the sender being known.
fn redact_messages(msgs: &[SmsMessage], sender: Option<&str>) -> (Vec<SmsMessageOut>, usize) {
    let sender = sender.unwrap_or("");
    let mut masked = 0;
    let out = msgs
        .iter()
        .map(|m| {
            let mut o = SmsMessageOut::from(m);
            let redacted = amos_sms::redact_for(sender, &m.text).into_owned();
            if redacted != m.text {
                masked += 1;
            }
            o.text = redacted;
            o
        })
        .collect();
    (out, masked)
}

// ---- View-layer trash (REQ-A42) ---------------------------------------------
//
// The system SMS store belongs to the platform's default SMS app; AmOS cannot
// delete rows from it (docs/sms.md §boundary). What we can do *honestly*: hide
// a message from every AmOS surface and keep it restorable — the trash. Rules
// this bridge keeps:
//
// * ids + timestamps only (`amos_sms::SmsTrash`); message bodies are never
//   copied out of the platform store into AmOS storage.
// * The list is bounded (FIFO eviction of the *oldest* entry → that message
//   becomes visible again; churn is logged, never silent).
// * Every mutation persists atomically (temp + rename) next to the blocklist
//   file; a corrupt file is logged and the trash starts empty.
// * A trashed message must not leak through a thread preview: when the trashed
//   row *was* the thread's latest, a replacement preview is computed once (from
//   the newest still-visible row) and stamped with the thread's `last_ts_ms`,
//   so it auto-expires the moment any newer message arrives.

/// File name inside the app data dir (next to `blocklist.json`).
pub const TRASH_FILE: &str = "sms-trash.json";

/// Serializable mirror of one trash entry for the UI (ids + times, no content:
/// restoring is the only way the text is shown again).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TrashOut {
    pub thread_id: String,
    pub message_id: String,
    pub ts_ms: i64,
    pub trashed_ms: i64,
}

impl From<&TrashEntry> for TrashOut {
    fn from(e: &TrashEntry) -> Self {
        Self {
            thread_id: e.thread_id.clone(),
            message_id: e.message_id.clone(),
            ts_ms: e.ts_ms,
            trashed_ms: e.trashed_ms,
        }
    }
}

/// Outcome of one trash request — the **three honest states** the UI renders
/// (docs/sms.md §13): the row is hidden now, the provider refused (blocked sender
/// / storage error), or the id is no longer in the folder the user was looking at
/// (their list went stale). Refusals are **not** errors: nothing is broken and
/// nothing was stored, so the UI must be able to say which of the three happened.
///
/// Wire shape (snake_case; the only key Tauri does not touch is the *value*):
/// `{"trashed":true}` · `{"trashed":false,"reason":"…"}` ·
/// `{"trashed":false,"not_found":true}`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum TrashAddOut {
    /// Hidden from every AmOS surface from now on (the platform store is untouched).
    Trashed { trashed: bool },
    /// The provider refused; `reason` is the domain's own message (for the UI/log).
    Refused { trashed: bool, reason: String },
    /// The message id was not in the folder read — the list the user tapped is stale.
    NotFound { trashed: bool, not_found: bool },
}

impl TrashAddOut {
    fn trashed() -> Self {
        Self::Trashed { trashed: true }
    }
    fn refused(reason: String) -> Self {
        Self::Refused {
            trashed: false,
            reason,
        }
    }
    fn not_found() -> Self {
        Self::NotFound {
            trashed: false,
            not_found: true,
        }
    }
}

/// Why trashing changed nothing. Kept apart from [`TrashOut`] so the *command* can
/// answer the three-state contract above, while the core stays a pure function
/// whose success value is the stored entry (the bridge's tests assert on it).
#[derive(Clone, Debug, PartialEq)]
enum TrashReject {
    /// The id is not in the folder read (the user's list went stale).
    NotFound,
    /// The provider/domain refused — a human-readable reason for the UI and logs.
    Refused(String),
}

/// Map a core outcome to the wire contract (pure, so it is directly testable).
fn trash_outcome(result: Result<TrashOut, TrashReject>) -> TrashAddOut {
    match result {
        Ok(_) => TrashAddOut::trashed(),
        Err(TrashReject::NotFound) => TrashAddOut::not_found(),
        Err(TrashReject::Refused(reason)) => TrashAddOut::refused(reason),
    }
}

/// Process-global trash state (shared by the four `sms_trash_*` commands and
/// the two read commands that must honor it).
pub struct SmsTrashState {
    inner: RwLock<SmsTrash>,
    path: Mutex<Option<PathBuf>>,
}

impl SmsTrashState {
    /// Empty state with no persistence yet (tests / before `configure`).
    pub fn empty() -> Self {
        Self {
            inner: RwLock::new(SmsTrash::new()),
            path: Mutex::new(None),
        }
    }

    /// Point the state at a file and load it (once per path). Three outcomes, not two:
    /// an **absent** file is simply "no trash yet" (a silent first run); a file that is
    /// **present but unreadable** (corrupt / truncated / non-UTF-8 / permission) is
    /// **moved aside** as `<name>.corrupt-<nonce>` before the empty trash takes its
    /// place, so the next [`Self::persist`] — a whole-file tmp+rename — writes a *fresh*
    /// file beside it instead of over the operator's only copy of trashed messages
    /// (REQ-A1929).
    pub fn configure(&self, path: PathBuf) {
        let mut slot = match self.path.lock() {
            Ok(p) => p,
            Err(poisoned) => poisoned.into_inner(),
        };
        if slot.as_deref() == Some(path.as_path()) {
            return;
        }
        *slot = Some(path.clone());
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            // No file yet is the ordinary first run, not an incident.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                keep_trash_aside(&path, &format!("could not be read: {e}"));
                return;
            }
        };
        match SmsTrash::from_json(&text, DEFAULT_TRASH_CAP) {
            Ok(loaded) => {
                keep_trash_aside(&path, "NC-2 TEMP: over-broad"); // NC-2 TEMP
                if let Ok(mut t) = self.inner.write() {
                    *t = loaded;
                }
                tracing::info!(
                    target: "amos::sms",
                    path = %path.display(),
                    "sms trash loaded"
                );
            }
            Err(e) => keep_trash_aside(&path, &format!("is unreadable: {e}")),
        }
    }

    /// The configured file, if any.
    pub fn path(&self) -> Option<PathBuf> {
        self.path
            .lock()
            .map(|p| p.clone())
            .unwrap_or_else(|p| p.into_inner().clone())
    }

    /// Read-only view of the trash.
    pub fn read(&self) -> RwLockReadGuard<'_, SmsTrash> {
        self.inner.read().unwrap_or_else(|p| p.into_inner())
    }

    /// Mutable view of the trash (callers persist afterwards).
    pub fn write(&self) -> RwLockWriteGuard<'_, SmsTrash> {
        self.inner.write().unwrap_or_else(|p| p.into_inner())
    }

    /// Restore one message (drop its trash entry + preview) and persist.
    pub fn restore(&self, thread_id: &str, message_id: &str) -> bool {
        let removed = self.write().restore(thread_id, message_id);
        if removed {
            self.persist();
        }
        removed
    }

    /// Drop everything and persist; returns the purged count.
    pub fn purge(&self) -> usize {
        let n = self.write().purge();
        if n > 0 {
            self.persist();
        }
        n
    }

    /// The trash list (newest first), mapped for the UI.
    pub fn list(&self) -> Vec<TrashOut> {
        self.read().entries().iter().map(TrashOut::from).collect()
    }

    /// Write the trash atomically (temp file + rename). Best-effort: failures
    /// are logged, never fatal (a full disk must not break messaging).
    pub fn persist(&self) {
        let Some(path) = self.path() else {
            return; // no file configured (tests / host before setup)
        };
        if let Some(dir) = path.parent() {
            // Name the directory failure itself: the write below will fail too, and its
            // error would not tell the operator that it was the mkdir that was refused.
            if let Err(e) = std::fs::create_dir_all(dir) {
                tracing::warn!(
                    target: "amos::sms",
                    dir = %dir.display(),
                    error = %e,
                    "sms trash directory could not be created"
                );
            }
        }
        let payload = self.read().to_json();
        let tmp = path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, payload.as_bytes()) {
            tracing::warn!(target: "amos::sms", error = %e, "sms trash write failed");
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, &path) {
            tracing::warn!(target: "amos::sms", error = %e, "sms trash rename failed");
        }
    }
}

impl Default for SmsTrashState {
    fn default() -> Self {
        Self::empty()
    }
}

/// Move a trash file that **exists but cannot be read back** out of the way, so the next
/// [`SmsTrashState::persist`] writes a fresh file beside it rather than over the only copy
/// of the user's trashed messages.
///
/// `rename` is a directory operation, so it still succeeds when the file's *contents* are
/// unreadable. Answers `None` when there is nothing to move (no regular file) or the rename
/// was refused (read-only directory) — the caller says which in its warning.
fn preserve_unreadable_state(path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let kept = path.with_extension(format!("corrupt-{nonce}"));
    std::fs::rename(path, &kept).ok().map(|()| kept)
}

/// Log a trash file that is present but unusable, keeping its bytes aside. The two
/// warnings name *which* happened: kept under a `corrupt-*` sibling, or could not be moved.
fn keep_trash_aside(path: &Path, reason: &str) {
    match preserve_unreadable_state(path) {
        Some(kept) => tracing::warn!(
            target: "amos::sms",
            path = %path.display(),
            kept = %kept.display(),
            "sms trash {reason}; kept beside the original and starting empty"
        ),
        None => tracing::warn!(
            target: "amos::sms",
            path = %path.display(),
            "sms trash {reason}; could not be moved aside, starting empty"
        ),
    }
}

static TRASH_SHARED: OnceLock<Arc<SmsTrashState>> = OnceLock::new();

/// The process-global trash state (created on first use).
pub fn trash_shared() -> Arc<SmsTrashState> {
    Arc::clone(TRASH_SHARED.get_or_init(|| Arc::new(SmsTrashState::empty())))
}

/// Resolve the persistence file from an app data dir.
pub fn trash_file_in(data_dir: &Path) -> PathBuf {
    data_dir.join(TRASH_FILE)
}

/// Wall-clock now in epoch ms (the default `trashed_ms` when the UI omits it).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Trash one message — the command core, pure over `provider` + `trash` so
/// tests can drive it without a Tauri runtime.
///
/// Reads the thread once to (a) verify the message exists (a trash entry for a
/// row we never saw would be fabricated state) and (b) compute the replacement
/// preview when the trashed row was the thread's latest — otherwise the
/// "deleted" text would keep leaking through the thread list. At most a few
/// bounded provider reads per user action, never per snapshot.
fn trash_message(
    trash: &SmsTrashState,
    provider: &dyn SmsProvider,
    thread_id: &str,
    message_id: &str,
    folder: Option<SmsFolder>,
    trashed_ms: i64,
) -> Result<TrashOut, TrashReject> {
    let msgs = provider
        .messages(thread_id, folder)
        .map_err(|e| TrashReject::Refused(e.to_string()))?;
    let m = msgs
        .iter()
        .find(|m| m.id == message_id)
        .ok_or(TrashReject::NotFound)?
        .clone();
    // "Latest" means latest *still visible* row: a second trash in the same
    // thread must refresh the preview even though the provider's newest row is
    // already trashed (computed before the insert, against the current set).
    let was_latest = {
        let t = trash.read();
        msgs.iter()
            .filter(|x| !t.contains(thread_id, &x.id))
            .map(|x| x.ts_ms)
            .max()
            == Some(m.ts_ms)
    };
    let added = trash
        .write()
        .add(thread_id, &m.id, m.ts_ms, trashed_ms)
        .map_err(|e| TrashReject::Refused(e.to_string()))?;
    if added.newly {
        tracing::info!(
            target: "amos::sms",
            thread = %thread_id,
            msg_id = %m.id,
            trashed_count = trash.read().len(),
            "message moved to the trash (hidden from AmOS; platform store untouched)"
        );
    }
    // The churn the module promises to log, never silent: at the cap a new trash
    // pushes the oldest entry out, which makes that message visible again. The
    // count above cannot show this (it is pinned at the cap), so the evicted
    // entry `add` now returns is what makes the churn observable.
    if let Some(ev) = added.evicted {
        tracing::warn!(
            target: "amos::sms",
            evicted_thread = %ev.thread_id,
            evicted_msg_id = %ev.message_id,
            "trash cap reached — the oldest trashed message was evicted and is visible again"
        );
    }
    // Preview bookkeeping (only matters when the trashed row was the latest).
    if was_latest {
        update_thread_preview(trash, provider, thread_id, folder, &m);
    }
    trash.persist();
    let entry = trash
        .read()
        .entries()
        .iter()
        .find(|e| e.thread_id == thread_id && e.message_id == message_id)
        .map(TrashOut::from);
    entry.ok_or(TrashReject::Refused(
        "trash entry vanished unexpectedly".to_string(),
    ))
}

/// Recompute the preview override for `thread_id` after trashing `trashed`
/// (the row that *was* the thread's latest): hide the thread when nothing
/// visible remains, else point the preview at the newest still-visible row
/// (display-redacted per REQ-A41) and drop its unread badge if the trashed row
/// was unread. The override is stamped with the thread's live `last_ts_ms`, so
/// any newer message makes it stale — and stale overrides are ignored, which
/// is exactly the "a fresh message owns the preview again" behavior.
fn update_thread_preview(
    trash: &SmsTrashState,
    provider: &dyn SmsProvider,
    thread_id: &str,
    folder: Option<SmsFolder>,
    trashed: &SmsMessage,
) {
    // The thread's rows minus everything trashed for this thread.
    let visible = {
        let t = trash.read();
        match provider.messages(thread_id, folder) {
            Ok(msgs) => msgs
                .into_iter()
                .filter(|m| !t.contains(thread_id, &m.id))
                .collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!(
                    target: "amos::sms",
                    thread = %thread_id,
                    error = %e,
                    "trash preview recompute could not read the thread"
                );
                return;
            }
        }
    };
    // Provider-side thread metadata (address for redaction, live last_ts_ms
    // stamp, unread): found in one folder's snapshot (bounded search).
    let meta = SmsFolder::ALL.iter().find_map(|f| {
        provider
            .snapshot(*f)
            .ok()
            .and_then(|list| list.iter().find(|t| t.id == thread_id).cloned())
    });
    let Some(meta) = meta else {
        // Transient: no snapshot carries the thread right now. Storing no
        // override is safer than storing a wrong one.
        tracing::warn!(
            target: "amos::sms",
            thread = %thread_id,
            "trash preview recompute found no thread snapshot — no override stored"
        );
        return;
    };
    let override_ = match visible.last() {
        None => PreviewOverride {
            thread_id: thread_id.to_string(),
            at_last_ts_ms: meta.last_ts_ms,
            last_text: String::new(),
            last_ts_ms: 0,
            unread: 0,
            hidden: true,
        },
        Some(last) => PreviewOverride {
            thread_id: thread_id.to_string(),
            at_last_ts_ms: meta.last_ts_ms,
            last_text: amos_sms::redact_for(&meta.address, &last.text).into_owned(),
            last_ts_ms: last.ts_ms,
            // An unread incoming row that just got trashed keeps no badge.
            unread: meta
                .unread
                .saturating_sub(u32::from(!trashed.from_me && !trashed.read)),
            hidden: false,
        },
    };
    trash.write().set_preview(override_);
}

/// Apply the trash to a thread list: swap in fresh overrides (and drop threads
/// whose every message is trashed). Returns the visible threads and how many
/// were hidden — the count feeds the audit log, mirroring `filter_threads`.
fn apply_trash(threads: Vec<SmsThread>, trash: &SmsTrash) -> (Vec<SmsThread>, usize) {
    let mut hidden = 0;
    let out = threads
        .into_iter()
        .filter_map(|t| match trash.preview(&t.id, t.last_ts_ms) {
            Some(p) if p.hidden => {
                hidden += 1;
                None
            }
            Some(p) => Some(SmsThread {
                last_text: p.last_text.clone(),
                last_ts_ms: p.last_ts_ms,
                unread: p.unread,
                ..t
            }),
            None => Some(t),
        })
        .collect();
    (out, hidden)
}

/// Trash a message (hide it from every AmOS surface; restorable). `folder`
/// scopes the read exactly like `sms_messages`; an omitted `trashed_ms` uses
/// the bridge clock. The platform SMS store is never written.
///
/// Answers the **three-state contract** documented in docs/sms.md §13
/// ([`TrashAddOut`]): `{"trashed":true}` / `{"trashed":false,"reason":…}` /
/// `{"trashed":false,"not_found":true}`. Blank ids stay a hard `Err` (a malformed
/// request is not a user-visible outcome); storage/worker failures are `Err` too.
#[tauri::command]
pub async fn sms_trash_add(
    state: State<'_, SmsBridge>,
    thread_id: String,
    message_id: String,
    folder: Option<String>,
    trashed_ms: Option<i64>,
) -> Result<TrashAddOut, AmosError> {
    if thread_id.trim().is_empty() || message_id.trim().is_empty() {
        return Err(AmosError::new(
            ErrorCode::SmsBlankId,
            "invalid SMS payload: blank thread/message id",
        ));
    }
    check_sms_id(&thread_id)?;
    check_sms_id(&message_id)?;
    let folder = match folder.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(name) => Some(amos_sms::SmsFolder::from_wire(name).map_err(|e| {
            AmosError::with_cause(ErrorCode::SmsUnknownFolder, codes::UNKNOWN_FOLDER, e)
        })?),
    };
    let provider = active_arc(&state);
    let trash = trash_shared();
    let at = trashed_ms.unwrap_or_else(now_ms);
    blocking(move || {
        // Refusals are outcomes, not errors: the UI must be able to tell "the
        // provider refused" from "your list was stale" (docs/sms.md §13).
        Ok(trash_outcome(trash_message(
            &trash,
            provider.as_ref(),
            &thread_id,
            &message_id,
            folder,
            at,
        )))
    })
    .await
    .map_err(|e| AmosError::with_cause(ErrorCode::SmsProviderRejected, codes::PROVIDER_REJECTED, e))
}

/// The trash list, newest first (ids + times only — no content).
#[tauri::command]
pub fn sms_trash_list() -> Vec<TrashOut> {
    trash_shared().list()
}

/// Undo a trash: the message shows in AmOS again. `true` when it was trashed.
///
/// `async` + [`blocking`] even though the mutation itself is in-memory: `restore`
/// **persists** (a temp-file write + rename), and a *sync* command runs on the
/// main thread — a slow or full disk would freeze the UI mid-frame. The worker
/// error is mapped like the other trash commands' (docs/sms.md §13).
#[tauri::command]
pub async fn sms_trash_restore(thread_id: String, message_id: String) -> Result<bool, AmosError> {
    // The bridge ID check is a **boundary** guard (empty / over-cap) — its
    // `Err` is not propagated because the underlying `restore` keys by raw
    // string, so an out-of-range id is a **no-op match** there and a quiet
    // "false" would silently mask a UI/JSON bug. Log the validation failure so
    // it is visible (the operator-level audit pattern, like the mkdir/cleanup
    // sites already acknowledged in the discard baseline).
    if let Err(e) = check_sms_id(&thread_id) {
        tracing::warn!(
            target: "amos::sms",
            thread = %thread_id,
            error = %e,
            "sms_trash_restore called with an invalid thread_id"
        );
    }
    if let Err(e) = check_sms_id(&message_id) {
        tracing::warn!(
            target: "amos::sms",
            msg_id = %message_id,
            error = %e,
            "sms_trash_restore called with an invalid message_id"
        );
    }
    blocking(move || {
        let ok = trash_shared().restore(&thread_id, &message_id);
        if ok {
            tracing::info!(
                target: "amos::sms",
                thread = %thread_id,
                msg_id = %message_id,
                "message restored from the trash"
            );
        }
        Ok(ok)
    })
    .await
    .map_err(|e| AmosError::with_cause(ErrorCode::SmsProviderRejected, codes::PROVIDER_REJECTED, e))
}

/// Empty the trash; returns how many entries were purged.
#[tauri::command]
pub async fn sms_trash_purge() -> Result<usize, AmosError> {
    blocking(move || {
        let n = trash_shared().purge();
        if n > 0 {
            tracing::info!(target: "amos::sms", purged = n, "sms trash purged");
        }
        Ok(n)
    })
    .await
    .map_err(|e| AmosError::with_cause(ErrorCode::SmsProviderRejected, codes::PROVIDER_REJECTED, e))
}

/// The foreground rule for every SMS read that hands back the user's messages — **the only
/// entry point a read command may use** (F-SH-654).
///
/// The user's messages are a disclosure, so they follow the same rule `clipboard_read`, the
/// in-call recording toggle and `device_mic_start` follow: only the window the user is
/// actually looking at may read them. Without this, any window's WebView could reach
/// `sms_snapshot` / `sms_messages` / `sms_counts` with an `invoke` and drain the inbox — the
/// frontend's capability ledger is a `$state` in the very JS context that would be doing the
/// reaching, so it can never be the guard. The caller's label is injected by Tauri (not an
/// argument), so a caller cannot claim to be another window.
///
/// Named and compiled on **every** target (not behind `#[cfg(feature = "android")]`) for the
/// same reason [`crate::clipboard::require_foreground`] is: a host test can pin both
/// directions, and the device is what is pending, not the rule.
pub fn require_sms_foreground(wm: &crate::wm::WmState, caller: &str) -> Result<(), AmosError> {
    crate::clipboard::require_foreground(wm, caller).map_err(|e| {
        // Same shape as the mic gate (`assistant_voice::require_mic_foreground`): the rule is
        // `clipboard::require_foreground`'s alone, and its words (the caller's label and the
        // focused one) ride along as the cause so an operator can read which window did have
        // the read.
        AmosError::with_cause(
            ErrorCode::SmsForegroundRequired,
            format!(
                "sms read refused: {e} (only the window the user is looking at may read \
                 messages; F-SH-654)"
            ),
            e,
        )
    })
}

/// Read one folder's threads (newest first), with **blocked senders removed**.
/// `Err` (permission denied / unavailable / unknown folder) is honest and must
/// never be shown as "no messages"; an `Ok` empty list means that folder is
/// empty (or fully filtered — [`filter_threads`] reports the hidden count).
#[tauri::command]
pub async fn sms_snapshot(
    state: State<'_, SmsBridge>,
    wm: State<'_, crate::wm::WmState>,
    window: tauri::WebviewWindow,
    folder: String,
) -> Result<Vec<SmsThreadOut>, AmosError> {
    // Before the provider is even asked: reading the inbox is a disclosure, so only the
    // window the user is looking at may do it (F-SH-654).
    require_sms_foreground(wm.inner(), window.label())?;
    let folder = amos_sms::SmsFolder::from_wire(&folder).map_err(|e| {
        AmosError::with_cause(ErrorCode::SmsUnknownFolder, codes::UNKNOWN_FOLDER, e)
    })?;
    let provider = active_arc(&state);
    let threads = blocking(move || provider.snapshot(folder))
        .await
        .map_err(|e| {
            AmosError::with_cause(ErrorCode::SmsProviderRejected, codes::PROVIDER_REJECTED, e)
        })?;
    let (kept, hidden) = crate::blocklist::filter_threads(threads, &crate::blocklist::shared());
    if hidden > 0 {
        tracing::info!(target: "amos::sms", hidden, "blocked senders filtered from the list");
    }
    // REQ-A42: a trashed message must not leak through the preview. Fresh
    // overrides replace the preview; threads whose every message is trashed
    // disappear (count logged, like the blocklist filter).
    let (kept, trash_hidden) = {
        let trash = trash_shared();
        let t = trash.read();
        apply_trash(kept, &t)
    };
    if trash_hidden > 0 {
        tracing::info!(
            target: "amos::sms",
            hidden = trash_hidden,
            "fully-trashed threads hidden from the list"
        );
    }
    // Display-path redaction (REQ-A41): thread previews must not carry balance
    // amounts; counts/unread still reflect the provider store, never the mask.
    let (out, masked) = redact_threads(&kept);
    if masked > 0 {
        tracing::info!(
            target: "amos::sms",
            threads = masked,
            "balance amounts masked in thread previews"
        );
    }
    Ok(out)
}

/// Distinct thread counts per folder (inbox / sent / draft).
///
/// When the blocklist can hide an SMS thread the badges are **derived from the
/// same filtered snapshots the thread list uses**, so a folder can never claim a
/// thread that `sms_snapshot` hides (blocking a sender — or merely switching on
/// unknown-number blocking — would otherwise leave the inbox badge one too
/// high). When nothing can be hidden the provider's cheap `counts()` is
/// authoritative and no extra read happens.
#[tauri::command]
pub async fn sms_counts(
    state: State<'_, SmsBridge>,
    wm: State<'_, crate::wm::WmState>,
    window: tauri::WebviewWindow,
) -> Result<SmsFolderCountsOut, AmosError> {
    // The counts are the inbox's size and per-folder shape — a fact about the user's
    // messages, so the same foreground rule as the list itself (F-SH-654).
    require_sms_foreground(wm.inner(), window.label())?;
    let provider = active_arc(&state);
    let rules = crate::blocklist::shared();
    let trash = trash_shared();
    // The gate is "can anything hide a thread": blocklist rules/switch, or a
    // non-empty trash — otherwise badges would count what the list hides.
    let filter = rules.filters_sms() || !trash.read().is_empty();
    blocking(move || {
        if filter {
            let t = trash.read();
            filtered_counts(provider.as_ref(), &rules, &t)
        } else {
            provider.counts()
        }
    })
    .await
    .map(|c| SmsFolderCountsOut::from(&c))
    .map_err(|e| AmosError::with_cause(ErrorCode::SmsProviderRejected, codes::PROVIDER_REJECTED, e))
}

/// Per-folder thread counts with blocked senders *and* trashed-hidden threads
/// removed (see [`sms_counts`]).
///
/// Pure so it is unit-testable: it reuses [`crate::blocklist::filter_threads`]
/// and [`apply_trash`] on each folder's snapshot, making the badges agree with
/// the visible list by construction rather than by assumption.
fn filtered_counts(
    p: &dyn SmsProvider,
    rules: &crate::blocklist::BlocklistState,
    trash: &amos_sms::SmsTrash,
) -> Result<amos_sms::SmsFolderCounts, amos_sms::SmsError> {
    let mut out = amos_sms::SmsFolderCounts::default();
    for folder in amos_sms::SmsFolder::ALL {
        let (kept, _) = crate::blocklist::filter_threads(p.snapshot(folder)?, rules);
        let (kept, _) = apply_trash(kept, trash);
        let n = u32::try_from(kept.len()).unwrap_or(u32::MAX);
        match folder {
            amos_sms::SmsFolder::Inbox => out.inbox = n,
            amos_sms::SmsFolder::Sent => out.sent = n,
            amos_sms::SmsFolder::Draft => out.draft = n,
        }
    }
    Ok(out)
}

/// The address a thread read must be judged against: the party the provider lists for
/// `thread_id`, falling back to the caller's `address` field **only** when no snapshot lists
/// the thread. `None` when neither is available.
///
/// The doc on [`sms_messages`] promises a blocked sender's content is refused "even if a
/// caller asks for the thread id directly" — which can only hold if the command finds the
/// address itself; the caller's field is a convenience, not the authority (P1-B2 / REQ-A1836). A snapshot
/// that errors is not a match: the caller's field, if given, is still judged.
fn thread_read_address(
    p: &dyn SmsProvider,
    thread_id: &str,
    provided: Option<&str>,
) -> Option<String> {
    SmsFolder::ALL
        .iter()
        .filter_map(|f| p.snapshot(*f).ok())
        .flatten()
        .find(|t| t.id == thread_id)
        .map(|t| t.address)
        .or_else(|| {
            provided
                .map(str::to_string)
                .filter(|a| !a.trim().is_empty())
        })
}

/// The blocklist verdict for a thread read, judged on [`thread_read_address`].
fn blocked_thread_read(
    p: &dyn SmsProvider,
    rules: &crate::blocklist::BlocklistState,
    thread_id: &str,
    provided: Option<&str>,
) -> Option<amos_blocklist::BlockReason> {
    thread_read_address(p, thread_id, provided)
        .and_then(|addr| rules.check(&addr, amos_blocklist::Channel::Sms))
}

/// Read one thread's messages (chronological). An empty/absent `folder` means
/// "the whole conversation"; otherwise only that folder's rows.
///
/// The read is judged on the address the **thread** belongs to (found from the provider's
/// snapshot), so a blocked sender's content is refused with an honest error **even when the
/// caller sends only the thread id** — the optional `address` is a fallback for a thread no
/// snapshot lists, not the authority the decision rests on (P1-B2 / REQ-A1836).
#[tauri::command]
pub async fn sms_messages(
    state: State<'_, SmsBridge>,
    wm: State<'_, crate::wm::WmState>,
    window: tauri::WebviewWindow,
    thread_id: String,
    folder: Option<String>,
    address: Option<String>,
) -> Result<Vec<SmsMessageOut>, AmosError> {
    // A thread's messages are the most specific disclosure of the three, so the gate comes
    // first — before the id checks, which describe a malformed request, not a refused one.
    require_sms_foreground(wm.inner(), window.label())?;
    if thread_id.trim().is_empty() {
        return Err(AmosError::new(
            ErrorCode::SmsBlankId,
            "invalid SMS payload: blank thread id",
        ));
    }
    check_sms_id(&thread_id)?;
    if let Some(addr) = address.as_deref().filter(|a| !a.trim().is_empty()) {
        check_sms_id(addr)?;
    }
    let provider = active_arc(&state);
    // Judge the party the **thread** belongs to, not the address the caller happened to send:
    // a caller who sends only the thread id must not read a blocked sender's messages (P1-B2 / REQ-A1836).
    if let Some(reason) = blocked_thread_read(
        provider.as_ref(),
        &crate::blocklist::shared(),
        &thread_id,
        address.as_deref(),
    ) {
        return Err(AmosError::new(
            ErrorCode::SmsBlockedSender,
            format!("blocked by rule: {reason:?}"),
        ));
    }
    let folder = match folder.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(name) => Some(amos_sms::SmsFolder::from_wire(name).map_err(|e| {
            AmosError::with_cause(ErrorCode::SmsUnknownFolder, codes::UNKNOWN_FOLDER, e)
        })?),
    };
    let msgs = blocking(move || provider.messages(&thread_id, folder))
        .await
        .map_err(|e| {
            AmosError::with_cause(ErrorCode::SmsProviderRejected, codes::PROVIDER_REJECTED, e)
        })?;
    // REQ-A42: trashed messages are hidden from the thread read (ids only —
    // the platform store keeps them; restoring brings them back).
    let (visible, trashed) = {
        let trash = trash_shared();
        let t = trash.read();
        amos_sms::filter_messages(&msgs, &t)
    };
    let visible: Vec<SmsMessage> = visible.into_iter().cloned().collect();
    if trashed > 0 {
        tracing::info!(
            target: "amos::sms",
            messages = trashed,
            "trashed messages hidden from the thread read"
        );
    }
    // REQ-A41: balances are masked on the way to the UI — a display-path
    // rewrite only; the platform SMS store keeps the original text.
    let (out, masked) = redact_messages(&visible, address.as_deref());
    if masked > 0 {
        tracing::info!(
            target: "amos::sms",
            messages = masked,
            "balance amounts masked in message bodies"
        );
    }
    Ok(out)
}

/// Send a text (real `SmsManager` on device; the mock never claims delivery).
///
/// Returns the platform's verdict as a wire string: `"sent"` only when the
/// radio confirmed it took the message, `"unconfirmed"` when the platform gave
/// no verdict within its window — including our own [`SMS_TIMEOUT`] expiring
/// first (keep the text; it may still go out) — or an
/// `Err` when the send was refused. A bridge that cannot name a verdict must
/// never be read as success — on Android `SmsManager` returns without throwing
/// even when the radio cannot send.
#[tauri::command]
pub async fn sms_send(
    state: State<'_, SmsBridge>,
    address: String,
    text: String,
) -> Result<String, AmosError> {
    check_sms_id(&address)?;
    // Defence-in-depth upper bound — `validate_text` will reject with a
    // user-facing reason, but a megabyte-sized body still costs a JSON round
    // trip per call before the engine sees it.
    if text.len() > MAX_SMS_TEXT_BYTES {
        return Err(AmosError::new(
            ErrorCode::SmsTextTooLong,
            format!(
                "sms_send text too long: {} bytes (max {MAX_SMS_TEXT_BYTES})",
                text.len()
            ),
        ));
    }
    let (addr, segments) = checked_send(&address, &text)?;
    let masked = mask_address(&addr);
    let provider = active_arc(&state);
    let send_addr = addr.clone();
    let outcome = match blocking(move || provider.send(&send_addr, &text)).await {
        Ok(outcome) => outcome,
        Err(e) => {
            tracing::warn!(
                target: "amos::sms",
                to = %masked,
                segments,
                kind = e.kind(),
                "SMS send call returned no verdict from the provider"
            );
            // A caller-side timeout becomes an `unconfirmed` outcome (logged by the
            // shared verdict line below); a genuine refusal stays a typed error.
            match send_outcome_from_failure(e) {
                Ok(outcome) => outcome,
                Err(err) => return Err(err),
            }
        }
    };
    let detail = match &outcome {
        SmsSendOutcome::Sent => String::new(),
        SmsSendOutcome::Unconfirmed(why) => why.clone(),
    };
    tracing::info!(
        target: "amos::sms",
        to = %masked,
        segments,
        verdict = outcome.wire(),
        detail = %detail,
        "SMS send verdict from the provider"
    );
    Ok(outcome.wire().to_string())
}

/// Mapping helpers kept pure so they are unit-testable without a Tauri runtime.
fn status_of(p: &dyn SmsProvider) -> SmsStatusOut {
    let name = p.name();
    SmsStatusOut {
        provider: name.to_string(),
        device: name != amos_sms::MOCK_PROVIDER,
    }
}

/// Event emitted when the device reports a new SMS (the inbox changed). The
/// frontend refreshes on it instead of polling; the payload carries the sender
/// only when the platform provided it (empty string otherwise — never invented).
pub const SMS_RECEIVED_EVENT: &str = "sms-received";

/// Payload of [`SMS_RECEIVED_EVENT`].
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SmsIncomingOut {
    /// Sender address when known, else `""` (we never guess it).
    pub address: String,
}

/// Build the incoming payload (pure: trims, never fabricates an address).
#[cfg(any(feature = "android", test))]
fn incoming_payload(address: &str) -> SmsIncomingOut {
    SmsIncomingOut {
        address: address.trim().to_string(),
    }
}

/// Must the device-signalled incoming SMS be suppressed (no AmOS notification,
/// no inbox refresh)?
///
/// Judged on the address the device reported, **including an empty/withheld
/// one**: `blocklist::check` answers `BlockReason::Unknown` for an unparseable
/// address exactly when the unknown-number switch is on, so a hidden number with
/// `block_unknown` is suppressed like any other unknown sender. Gating the
/// verdict on a non-empty address would hide the thread from the list while the
/// arrival still notified (P1-B1 / REQ-A1836).
#[cfg(any(feature = "android", test))]
fn incoming_is_suppressed(rules: &crate::blocklist::BlocklistState, address: &str) -> bool {
    rules.blocks_sms(address)
}

/// On-device push: the Kotlin `SmsGlue` registers a `SMS_RECEIVED` receiver and
/// upcalls here, so received messages reach the UI live instead of on a manual
/// refresh. Compile-checked under `--features android`; exercised at device time.
#[cfg(feature = "android")]
mod events {
    use super::*;
    use jni::objects::JString;
    use jni::sys::{jobject, jstring};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};

    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// Install the emitter (called once from `lib.rs::setup`).
    pub fn install(app: AppHandle) {
        // Exactly-once: a redundant re-attach keeps the first one (REQ-A187 baseline).
        let _ = APP.set(app);
    }

    /// `SmsGlue.onIncoming(address)` — JNI `(JNIEnv*, jobject, String)`.
    ///
    /// # Safety
    /// `env`/`this`/`address` are the standard JNI args of the instance-method
    /// call on the main thread; `address` is valid for the duration of the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_SmsGlue_onIncoming(
        env: *mut jni::sys::JNIEnv,
        _this: jobject,
        address: jstring,
    ) {
        let Some(app) = APP.get() else {
            return; // no UI attached → nothing to notify (honest no-op)
        };
        if env.is_null() || address.is_null() {
            return;
        }
        // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
        let Ok(mut env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
            return;
        };
        // SAFETY: `address` is a live local ref for the duration of this call.
        let jstr = unsafe { JString::from_raw(address) };
        let addr: String = env.get_string(&jstr).map(|s| s.into()).unwrap_or_default();
        let payload = incoming_payload(&addr);
        // A blocked sender must not raise an AmOS notification or refresh the
        // Messages screen. (The message row itself is owned by the platform's
        // default SMS app; we cannot delete it — see docs/sms.md.)
        if incoming_is_suppressed(&crate::blocklist::shared(), &payload.address) {
            tracing::info!(
                target: "amos::sms",
                from = %mask_address(&payload.address),
                "incoming SMS from a blocked sender ignored"
            );
            return;
        }
        tracing::info!(
            target: "amos::sms",
            from = %if payload.address.is_empty() { "<unknown>".to_string() } else { mask_address(&payload.address) },
            "incoming SMS signalled by the device"
        );
        // The inbox refresh depends on this event reaching the WebView; a failed emit
        // means a new message is in the store but the UI still shows the old inbox
        // (REQ-A187).
        if let Err(e) = app.emit(SMS_RECEIVED_EVENT, payload) {
            tracing::warn!(
                target: "amos::sms",
                error = %e,
                "incoming SMS not delivered to the UI (it is in the store)"
            );
        }
    }
}

#[cfg(feature = "android")]
pub use events::install as install_events;

/// Test-only mapping helper (the commands map inline through [`blocking`]).
#[cfg(test)]
fn snapshot_of(
    p: &dyn SmsProvider,
    folder: amos_sms::SmsFolder,
) -> Result<Vec<SmsThreadOut>, String> {
    p.snapshot(folder)
        .map(|v| v.iter().map(SmsThreadOut::from).collect())
        .map_err(|e| e.to_string())
}

/// On-device SMS attach (feature `android`): the Kotlin `SmsGlue` instance
/// (which owns the Context / ContentResolver) is handed to Rust over JNI,
/// wrapped in a real `amos_sms::AndroidSmsProvider`, and installed into a
/// process global the commands consult — mirroring the media/flashlight device
/// seam. Compile-checked under `--features android`; exercised at device time.
#[cfg(feature = "android")]
mod device {
    use super::*;
    use jni::objects::JObject;
    use jni::sys::jobject;
    use std::sync::{Arc, OnceLock};

    /// The real Android SMS provider, installed exactly-once at attach.
    pub(crate) static DEVICE: OnceLock<Arc<dyn SmsProvider>> = OnceLock::new();

    fn install(vm: jni::JavaVM, env: &jni::JNIEnv<'_>, glue: JObject<'_>) {
        use amos_sms::AndroidSmsProvider;
        if let Ok(p) = AndroidSmsProvider::new(vm, env, glue) {
            // Exactly-once: a redundant re-attach keeps the first one (REQ-A187 baseline).
            let _ = DEVICE.set(Arc::new(p)); // first attach wins (exactly-once)
        }
    }

    /// `SmsGlue.attach()` — JNI `(JNIEnv*, jobject)`; `this` is the Kotlin
    /// `SmsGlue` instance holding the app Context / ContentResolver.
    ///
    /// # Safety
    /// `env`/`this` are the standard JNI arguments of a native call on the main
    /// thread; `this` is valid for the duration of the call.
    #[no_mangle]
    pub unsafe extern "system" fn Java_com_amos_ai_glue_SmsGlue_attach(
        env: *mut jni::sys::JNIEnv,
        this: jobject,
    ) {
        if env.is_null() || this.is_null() {
            return; // nothing valid → honest no-op (mock stays active)
        }
        // SAFETY: `env` is the JVM-supplied JNIEnv* for this native call.
        let Ok(env) = (unsafe { jni::JNIEnv::from_raw(env) }) else {
            return;
        };
        let Ok(vm) = env.get_java_vm() else {
            return;
        };
        // SAFETY: `this` is a live local ref for the duration of this call.
        let glue = unsafe { JObject::from_raw(this) };
        install(vm, &env, glue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_sms::SmsError;

    #[test]
    fn thread_previews_are_balance_redacted_but_the_store_is_not() {
        let threads = vec![
            SmsThread::new(
                "1",
                "95588",
                "工行",
                "您的余额12,345.67元，请注意查收",
                50,
                1,
            ),
            SmsThread::new("2", "13800138000", "家人", "周末回家吃饭吗？", 40, 0),
        ];
        // The raw store mapping keeps the original preview …
        let raw: Vec<SmsThreadOut> = threads.iter().map(SmsThreadOut::from).collect();
        assert_eq!(raw[0].last_text, "您的余额12,345.67元，请注意查收");
        // … while the display mapping masks the amount (and only that thread).
        let (out, masked) = redact_threads(&threads);
        assert_eq!(out.len(), 2);
        assert_eq!(masked, 1);
        assert_eq!(out[0].last_text, "您的余额***，请注意查收");
        assert_eq!(out[1].last_text, "周末回家吃饭吗？");
    }

    #[test]
    fn message_bodies_get_sender_aware_redaction() {
        let bank = vec![
            SmsMessage::new("1", "m1", false, "账户资金: 50,000.00", 10, false),
            SmsMessage::new("1", "m2", false, "您的消费100.00元", 11, false),
        ];
        let (out, masked) = redact_messages(&bank, Some("95533"));
        assert_eq!(masked, 1, "the bank field rule masks; the spend stays");
        assert_eq!(out[0].text, "账户资金: ***");
        assert_eq!(out[1].text, "您的消费100.00元");
        // Unknown/absent sender: the content rule still applies to the body.
        let body = vec![SmsMessage::new(
            "1",
            "m3",
            false,
            "余额：8,000.00",
            12,
            false,
        )];
        let (out, masked) = redact_messages(&body, None);
        assert_eq!(masked, 1);
        assert_eq!(out[0].text, "余额：***");
    }

    #[test]
    fn seeded_demo_rows_hold_no_balances_so_redaction_is_a_noop() {
        // The fixed demo data must not rely on the mask (it has no balances);
        // a zero masked-count proves the rewrite is an honest no-op there.
        let inbox = MockSms::seeded()
            .snapshot(amos_sms::SmsFolder::Inbox)
            .unwrap();
        let (out, masked) = redact_threads(&inbox);
        assert_eq!(masked, 0);
        assert!(out.iter().all(|t| !t.last_text.contains("***")));
    }

    #[test]
    fn host_boot_is_an_empty_honest_store() {
        let b = SmsBridge::boot();
        for f in amos_sms::SmsFolder::ALL {
            assert!(b.provider.snapshot(f).unwrap().is_empty(), "{f:?}");
        }
        assert!(snapshot_of(b.provider.as_ref(), amos_sms::SmsFolder::Inbox)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn maps_seeded_threads_and_messages_per_folder() {
        let b = SmsBridge::with_provider(Box::new(MockSms::seeded()));
        let inbox = snapshot_of(b.provider.as_ref(), amos_sms::SmsFolder::Inbox).unwrap();
        assert_eq!(inbox.len(), 2);
        assert_eq!(inbox[0].address, "13800138000");
        assert_eq!(inbox[0].unread, 1);
        let sent = snapshot_of(b.provider.as_ref(), amos_sms::SmsFolder::Sent).unwrap();
        assert_eq!(sent.len(), 2);
        assert!(sent.iter().all(|t| t.unread == 0));
        let msgs = b
            .provider
            .messages("1", Some(amos_sms::SmsFolder::Inbox))
            .unwrap();
        let out: Vec<SmsMessageOut> = msgs.iter().map(SmsMessageOut::from).collect();
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|m| !m.from_me));
        // Counts surface through the serializable mirror.
        let counts = SmsFolderCountsOut::from(&b.provider.counts().unwrap());
        assert_eq!(
            counts,
            SmsFolderCountsOut {
                inbox: 2,
                sent: 2,
                draft: 1
            }
        );
    }

    #[test]
    fn folder_counts_hide_blocked_senders_like_the_list_does() {
        // Blocking a sender removes that thread from every folder's list; the
        // badges must drop with it or the inbox tab would count a hidden thread.
        let rules = crate::blocklist::BlocklistState::empty();
        rules.add("13800138000", "exact", "sms", "", 1).unwrap();
        let p = MockSms::seeded();
        // Sanity: the unfiltered provider really does count both senders.
        assert_eq!(p.counts().unwrap().inbox, 2);
        let counts = filtered_counts(&p, &rules, &amos_sms::SmsTrash::new()).unwrap();
        // Thread "1" (13800138000) is gone from inbox+sent; thread "3" (10086)
        // stays in sent+draft. The hidden thread is *not* counted anywhere.
        assert_eq!(
            counts,
            amos_sms::SmsFolderCounts {
                inbox: 1,
                sent: 1,
                draft: 1
            }
        );
        // The badge count equals the filtered list length for every folder.
        for folder in amos_sms::SmsFolder::ALL {
            let visible = crate::blocklist::filter_threads(p.snapshot(folder).unwrap(), &rules).0;
            assert_eq!(counts.of(folder) as usize, visible.len(), "{folder:?}");
        }
    }

    #[test]
    fn a_blocked_sender_is_refused_even_when_the_caller_sends_only_the_thread_id() {
        // P1-B2 / REQ-A1836: the read is judged on the party the **thread** belongs to. Thread "1" is
        // 13800138000 (`MockSms::seeded`); before the fix the command consulted the blocklist
        // only when the caller supplied `address`, so `None` served the blocked sender's
        // messages — the doc's promise ("…even if a caller asks for the thread id directly")
        // was enforced by no line.
        let rules = crate::blocklist::BlocklistState::empty();
        rules.add("13800138000", "exact", "sms", "", 1).unwrap();
        let p = MockSms::seeded();

        assert!(
            blocked_thread_read(&p, &rules, "1", None).is_some(),
            "a blocked sender's thread must be refused with only the thread id"
        );
        // The caller's field still judges a thread no snapshot lists.
        assert!(blocked_thread_read(&p, &rules, "no-such-thread", Some("13800138000")).is_some());
    }

    #[test]
    fn an_unblocked_thread_is_not_refused_and_an_empty_rule_set_refuses_nothing() {
        // Positive controls: the verdict must not be an "always refuse" predicate.
        let p = MockSms::seeded();

        // No rules at all → the very thread the sibling test blocks is served.
        let empty = crate::blocklist::BlocklistState::empty();
        assert!(blocked_thread_read(&p, &empty, "1", None).is_none());

        // With a rule for a *different* sender, thread "3" (10086) is still served.
        let rules = crate::blocklist::BlocklistState::empty();
        rules.add("13800138000", "exact", "sms", "", 1).unwrap();
        assert!(blocked_thread_read(&p, &rules, "3", None).is_none());
    }

    #[test]
    fn a_call_only_rule_does_not_shrink_the_sms_badges() {
        // Only SMS rules feed the filter; a call rule must leave the counts as the
        // provider reported them (the UI keys the role prompt off call rules).
        let rules = crate::blocklist::BlocklistState::empty();
        rules.add("10086", "exact", "call", "", 1).unwrap();
        let p = MockSms::seeded();
        let counts = filtered_counts(&p, &rules, &amos_sms::SmsTrash::new()).unwrap();
        assert_eq!(
            counts,
            amos_sms::SmsFolderCounts {
                inbox: 2,
                sent: 2,
                draft: 1
            }
        );
    }

    /// A provider with one numeric sender and one **alphanumeric service id** —
    /// the latter is what the unknown-number switch classifies as `Unknown`.
    struct ServiceIdSms;

    impl SmsProvider for ServiceIdSms {
        fn name(&self) -> &'static str {
            "service-id-test"
        }
        fn snapshot(&self, folder: amos_sms::SmsFolder) -> Result<Vec<SmsThread>, SmsError> {
            Ok(match folder {
                amos_sms::SmsFolder::Inbox => vec![
                    SmsThread::new("1", "13800138000", "家人", "下班买菜", 2, 0),
                    SmsThread::new("2", "TM-ALIPAY", "支付宝", "验证码 1234", 1, 0),
                ],
                amos_sms::SmsFolder::Sent => {
                    vec![SmsThread::new("1", "13800138000", "家人", "好的", 3, 0)]
                }
                amos_sms::SmsFolder::Draft => Vec::new(),
            })
        }
        fn messages(
            &self,
            _thread_id: &str,
            _folder: Option<amos_sms::SmsFolder>,
        ) -> Result<Vec<SmsMessage>, SmsError> {
            Ok(Vec::new())
        }
        fn counts(&self) -> Result<amos_sms::SmsFolderCounts, SmsError> {
            Ok(amos_sms::SmsFolderCounts {
                inbox: 2,
                sent: 1,
                draft: 0,
            })
        }
        fn send(&self, address: &str, text: &str) -> Result<SmsSendOutcome, SmsError> {
            let _ = normalize_address(address)?;
            validate_text(text)?;
            Ok(SmsSendOutcome::Sent)
        }
    }

    #[test]
    fn the_unknown_number_switch_hides_threads_from_the_badges_too() {
        // `is_blocked` reports an unparseable sender id (an alphanumeric service
        // id) as `Unknown`, so with the switch ON the list hides that thread even
        // with **no rules at all**: the badges must be derived the same way, or
        // the inbox tab counts a thread that is not in the list.
        let rules = crate::blocklist::BlocklistState::empty();
        let p = ServiceIdSms;
        // Sanity: the provider itself counts both inbox threads...
        assert_eq!(p.counts().unwrap().inbox, 2);
        // ...and no *rule* is involved — only the switch.
        assert!(!rules.has_sms_rules());
        rules.set_block_unknown(true);
        assert!(rules.filters_sms());
        let counts = filtered_counts(&p, &rules, &amos_sms::SmsTrash::new()).unwrap();
        assert_eq!(counts.inbox, 1, "the service id must not be counted");
        for folder in amos_sms::SmsFolder::ALL {
            let visible = crate::blocklist::filter_threads(p.snapshot(folder).unwrap(), &rules).0;
            assert_eq!(counts.of(folder) as usize, visible.len(), "{folder:?}");
        }
        // Switch off again → nothing can be hidden, so the platform count wins.
        rules.set_block_unknown(false);
        assert!(!rules.filters_sms());
        assert_eq!(
            filtered_counts(&p, &rules, &amos_sms::SmsTrash::new())
                .unwrap()
                .inbox,
            2
        );
    }

    #[test]
    fn a_withheld_number_under_block_unknown_suppresses_the_arrival_too() {
        // The thread list hides an unparseable sender when the switch is on
        // (`filters_sms`); the arrival event must reach the same verdict, or a
        // hidden number still raises a notification and refreshes the inbox.
        let rules = crate::blocklist::BlocklistState::empty();
        // No rule, switch off → an ordinary (even empty) address arrives.
        assert!(!incoming_is_suppressed(&rules, "13800138000"));
        assert!(!incoming_is_suppressed(&rules, ""));
        rules.set_block_unknown(true);
        // Withheld (empty) address now suppressed like any unparseable sender.
        assert!(
            incoming_is_suppressed(&rules, ""),
            "a withheld number must be suppressed under block_unknown"
        );
        // …and an ordinary number still arrives (it is not "block everything").
        assert!(!incoming_is_suppressed(&rules, "13800138000"));
    }

    #[test]
    fn unknown_folder_is_rejected_before_any_provider_call() {
        assert!(amos_sms::SmsFolder::from_wire("outbox").is_err());
        assert!(amos_sms::SmsFolder::from_wire("").is_err());
        assert_eq!(
            amos_sms::SmsFolder::from_wire("sent").unwrap(),
            amos_sms::SmsFolder::Sent
        );
    }

    #[test]
    fn send_rejects_blank_via_bridge_provider() {
        let b = SmsBridge::with_provider(Box::new(MockSms::seeded()));
        assert!(b.provider.send("10086", "  ").is_err());
        assert!(b.provider.send("10086", "OK").is_ok());
    }

    #[test]
    fn status_distinguishes_mock_from_a_device_backend() {
        let mock = SmsBridge::boot();
        assert_eq!(
            status_of(mock.provider.as_ref()),
            SmsStatusOut {
                provider: "mock".into(),
                device: false
            }
        );
        // A provider with any other id is reported as a device backend.
        struct FakeDevice;
        impl SmsProvider for FakeDevice {
            fn name(&self) -> &'static str {
                "android-sms"
            }
            fn snapshot(&self, _f: amos_sms::SmsFolder) -> Result<Vec<SmsThread>, SmsError> {
                Ok(Vec::new())
            }
            fn messages(
                &self,
                _t: &str,
                _f: Option<amos_sms::SmsFolder>,
            ) -> Result<Vec<SmsMessage>, SmsError> {
                Ok(Vec::new())
            }
            fn counts(&self) -> Result<amos_sms::SmsFolderCounts, SmsError> {
                Ok(amos_sms::SmsFolderCounts::default())
            }
            fn send(&self, _a: &str, _t: &str) -> Result<SmsSendOutcome, SmsError> {
                Ok(SmsSendOutcome::Unconfirmed(
                    "fake device has no radio".into(),
                ))
            }
        }
        assert_eq!(
            status_of(&FakeDevice),
            SmsStatusOut {
                provider: "android-sms".into(),
                device: true
            }
        );
    }

    #[test]
    fn send_is_validated_before_dispatch() {
        // Normalized address + honest segment count for the audit trail.
        let (addr, segments) = checked_send(" +86 138-0013-8000 ", "hello").unwrap();
        assert_eq!(addr, "+8613800138000");
        assert_eq!(segments, 1);
        // Blank/oversized/malformed input never reaches the provider.
        assert!(checked_send("10086", "   ").is_err());
        assert!(checked_send("abc", "hi").is_err());
        assert!(
            checked_send("10086", &"a".repeat(amos_sms::validate::MAX_TEXT_CHARS + 1)).is_err()
        );
        // 200 GSM-7 chars → 2 segments.
        assert_eq!(checked_send("10086", &"a".repeat(200)).unwrap().1, 2);
    }

    /// The bridge's byte-guard backs up the engine's character limit, so it must
    /// never be *tighter* than the gate it backs up — otherwise it becomes the
    /// stricter gate and refuses a body [`validate_text`] accepts. The former
    /// `4 << 10` (4096) had exactly that inversion for every non-ASCII body: 1600
    /// Chinese characters are 4800 bytes, so the engine's legal maximum was
    /// unreachable from the bridge (audit P1-S1).
    #[test]
    fn the_byte_guard_admits_every_engine_legal_body() {
        // The ceiling is the byte-image of the engine's char limit (4 bytes/char
        // is the widest UTF-8 encoding of a single `char`).
        assert_eq!(MAX_SMS_TEXT_BYTES, amos_sms::validate::MAX_TEXT_CHARS * 4);

        // The exact body that was refused at the bridge while the engine accepted it.
        let cjk = "中".repeat(amos_sms::validate::MAX_TEXT_CHARS);
        assert_eq!(cjk.len(), 4800);
        assert!(cjk.len() <= MAX_SMS_TEXT_BYTES);
        assert!(checked_send("10086", &cjk).is_ok(), "the engine agrees");

        // Positive control: the guard is not what refuses an over-long body — one
        // char past the limit still fits the byte ceiling, and the engine refuses it.
        let over = "中".repeat(amos_sms::validate::MAX_TEXT_CHARS + 1);
        assert!(over.len() <= MAX_SMS_TEXT_BYTES);
        assert!(checked_send("10086", &over).is_err());
    }

    /// The fake-send defect was structural in Kotlin: `send` passed `null`
    /// status intents, so the platform never reported a verdict and the glue
    /// answered `{"ok":true}` for a message the radio may never have taken. Pin
    /// the pairing at the source (REQ-A1620 / F-TEL-040):
    ///
    /// 1. `send` hands `SmsManager` a real sent-intent per part (and no longer
    ///    passes `null` for them);
    /// 2. the glue registers a `NOT_EXPORTED` receiver for its own `SMS_SENT`
    ///    action, or the verdicts would never come back;
    /// 3. the wire carries the three verdicts, and the `{"ok":true}` fold is gone;
    /// 4. the glue's wait stays **under** the Rust caller's own timeout — a
    ///    slow radio must surface as the glue's honest `unconfirmed`, not as a
    ///    caller-side timeout that loses the reason.
    #[test]
    fn sms_send_reports_a_real_verdict_not_an_ok_flag() {
        const GLUE: &str = include_str!("../android-glue/com/amos/ai/glue/SmsGlue.kt");

        // (1) The platform is actually given a status target for every part.
        assert!(
            GLUE.contains("sendMultipartTextMessage(normalized, null, parts, sentIntents, null)"),
            "multipart send must pass its per-part sent intents, not null"
        );
        assert!(
            GLUE.contains("sendTextMessage(normalized, null, text, sentIntents[0], null)"),
            "single-part send must pass its sent intent, not null"
        );
        assert!(
            !GLUE.contains("parts, null, null)") && !GLUE.contains("text, null, null)"),
            "a null sent intent is the defect: the platform then reports no verdict"
        );

        // (2) The verdicts come back through a receiver we registered ourselves.
        assert!(
            GLUE.contains("IntentFilter(ACTION_SMS_SENT)"),
            "SmsGlue must register a receiver for its own SMS_SENT action"
        );
        assert!(
            // Registered through `ContextCompat` (REQ-A1627): below API 33 the platform's
            // 3-arg overload does not exist, so the two-arg call there is the only option
            // — and Android Lint cannot see that, so it flagged the version branch. The
            // helper keeps the NOT_EXPORTED property the assertion is about.
            GLUE.contains("ContextCompat.registerReceiver(ctx, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)"),
            "the SENT receiver is in-package only: the PendingIntent fires as this app"
        );
        assert!(
            GLUE.contains("sendProbes[token]?.settle(resultCode)"),
            "the receiver must settle the probe for the token the broadcast carries"
        );

        // (3) The three verdicts on the wire; the old fold is gone.
        for state in ["sent", "unconfirmed"] {
            assert!(
                GLUE.contains(&format!("put(\"state\", \"{state}\")")),
                "the send reply must be able to say '{state}'"
            );
        }
        assert!(
            GLUE.contains("\"rejected\""),
            "a radio refusal is a typed error (error_kind: rejected), not a verdict"
        );
        assert!(
            !GLUE.contains("put(\"ok\", true)"),
            "an ok-flag was the defect: 'it did not throw' is not a verdict"
        );

        // (4) The glue's wait is strictly inside the Rust caller's timeout.
        let wait = GLUE
            .split("SENT_WAIT_MS = ")
            .nth(1)
            .and_then(|rest| rest.split('L').next())
            .and_then(|digits| digits.trim().parse::<u128>().ok())
            .expect("SENT_WAIT_MS must be declared as a literal millisecond value");
        let caller_ms = SMS_TIMEOUT.as_millis();
        assert!(
            wait < caller_ms,
            "SENT_WAIT_MS ({wait}ms) must stay under SMS_TIMEOUT ({caller_ms}ms), or a slow \
             radio becomes a caller-side timeout that loses the glue's reason"
        );
    }

    /// Source-level pin (red-first for PH-P2-06): `SmsGlue.bind` must **re-attempt** the
    /// `SMS_RECEIVED` receiver on every call.
    ///
    /// `registerIncomingReceiver` is permission-gated — it returns without registering when
    /// `RECEIVE_SMS` is not held. It lives inside `bind`, whose first line was
    /// `if (app != null) return`: the first `bind` (from `AmosGlue.onStart`) typically runs
    /// **before** the runtime grant, so the receiver was skipped there and every later `bind`
    /// early-returned — the receiver was never registered, live refresh never started, and
    /// `docs/sms.md`'s「授权后即生效，无需重绑」was false for this half. The pin is the
    /// **absence** of that guard (plus the positive control that `bind` still does its
    /// first-time work), so deleting the whole body cannot satisfy it.
    #[test]
    fn the_incoming_receiver_is_re_attempted_on_every_bind() {
        const GLUE: &str = include_str!("../android-glue/com/amos/ai/glue/SmsGlue.kt");
        let code = strip_kotlin_comments(GLUE);
        let body = kotlin_fun_body(&code, "fun bind(");
        assert!(
            body.contains("registerIncomingReceiver(ctx)"),
            "bind must (re)register the SMS_RECEIVED receiver: got\n{body}"
        );
        assert!(
            !body.contains("if (app != null) return"),
            "the `if (app != null) return` guard skips the permission-gated receiver on every \
             later bind, so a bind before RECEIVE_SMS was granted leaves live refresh dead \
             forever (PH-P2-06): got\n{body}"
        );
        // Positive control: bind still does exactly-once first-time work, so an emptied body
        // fails here rather than satisfying the pin above by accident.
        for needle in [
            "if (app == null)",
            "app = ctx",
            "attach(this)",
            "registerSendReceiver(ctx)",
        ] {
            assert!(
                body.contains(needle),
                "bind is missing `{needle}`: got\n{body}"
            );
        }
    }

    /// Source-level pin (red-first for PH-P2-06): the SMS grant result must itself re-attempt
    /// the receiver registration, so the grant takes effect **without** an app restart.
    ///
    /// `SmsPermissionGlue.onSmsResult` is the callback the platform invokes when the user
    /// answers `REQ_SMS`. Registering the receiver only from the lifecycle `bind` would make
    /// the take-effect moment depend on the Activity happening to `onStart` again; the grant
    /// callback is the deterministic seam (the camera sibling does the same — see
    /// `AmosGlue.onCameraPermissionGranted`). Verdict re-read and Rust resolution are kept as
    /// positive controls so the pin cannot be satisfied by gutting the function.
    #[test]
    fn the_sms_grant_re_attempts_the_incoming_receiver() {
        const PERM: &str = include_str!("../android-glue/com/amos/ai/glue/SmsPermissionGlue.kt");
        let code = strip_kotlin_comments(PERM);
        let body = kotlin_fun_body(&code, "fun onSmsResult(");
        assert!(
            body.contains("SmsGlue.bind("),
            "after the user grants RECEIVE_SMS, the grant result must re-attempt the receiver \
             registration (SmsGlue.bind) — otherwise the grant never takes effect without an \
             app restart and docs/sms.md's 「授权后即生效，无需重绑」 is false (PH-P2-06): \
             got\n{body}"
        );
        assert!(
            body.contains("allGranted()"),
            "onSmsResult must still re-read the grant from the platform: got\n{body}"
        );
        assert!(
            body.contains("onResult(granted)"),
            "onSmsResult must still resolve the Rust await: got\n{body}"
        );
    }

    /// Source-level pin (red-first for PH-P2-07): a message row's `from_me` must mean "the
    /// user's own outgoing side", which is **every type except inbox** — not "sent".
    ///
    /// Before the fix the glue wrote `from_me = (type == TYPE_SENT)`, so a `TYPE_DRAFT` row
    /// read as `false`. `SmsMessage::from_me` is documented as "true when we sent it
    /// (outgoing)" and the **mock authority** (`MockSms::seeded_rows`, `provider.rs`) seeds
    /// its draft row (`m6`, folder `Draft`) with `from_me: true`; the UI bubble side/colour
    /// follows `from_me` (`MessagesApp.svelte`), so host and device disagreed about a field the
    /// spec pins. Inbox is the only received (`MESSAGE_TYPE_INBOX`) type — sent, draft, outbox,
    /// failed and queued are all the user's own.
    #[test]
    fn a_draft_row_is_from_me_not_a_received_message() {
        const GLUE: &str = include_str!("../android-glue/com/amos/ai/glue/SmsGlue.kt");
        let code = strip_kotlin_comments(GLUE);
        let body = kotlin_fun_body(&code, "fun messages(");
        assert!(
            body.contains(r#""from_me", c.getInt(iType) != TYPE_INBOX"#),
            "from_me must be `type != TYPE_INBOX` (every non-inbox type is the user's own), \
             or a draft reads as a received message (PH-P2-07): got\n{body}"
        );
        assert!(
            !body.contains("c.getInt(iType) == TYPE_SENT"),
            "`type == TYPE_SENT` was the defect: it folds draft/outbox/failed/queued into \
             `from_me:false` (PH-P2-07): got\n{body}"
        );
        // Positive control: the row shape is otherwise intact, so an emptied/truncated body
        // cannot satisfy the pin above by accident.
        for needle in [r#""id""#, r#""text""#, r#""ts_ms""#, r#""read""#] {
            assert!(
                body.contains(needle),
                "the message row is missing {needle}: got\n{body}"
            );
        }
    }

    #[test]
    fn audit_masks_the_address() {
        assert_eq!(mask_address("13800138000"), "***8000");
        assert_eq!(mask_address("+8613800138000"), "***8000");
        assert_eq!(mask_address("1008"), "***1008");
        assert_eq!(mask_address("12"), "***12"); // never panics on short input
    }

    #[test]
    fn incoming_event_payload_never_invents_an_address() {
        assert_eq!(SMS_RECEIVED_EVENT, "sms-received");
        assert_eq!(incoming_payload(" 10086 ").address, "10086");
        assert_eq!(incoming_payload("").address, ""); // unknown stays unknown
    }

    /// A provider that hangs must not keep the caller waiting forever.
    #[tokio::test]
    async fn a_hung_provider_times_out_instead_of_blocking_the_caller() {
        let err = blocking_with(Duration::from_millis(50), || {
            std::thread::sleep(Duration::from_millis(500));
            Ok::<(), SmsError>(())
        })
        .await
        .unwrap_err();
        assert!(err.to_string().contains("timed out"), "got: {err}");
        // And it is a *timeout*, not a generic failure: the send path keys on this
        // to answer `unconfirmed` instead of claiming the message was refused
        // (REQ-A1759/F-TEL-045).
        assert_eq!(err.kind(), "timeout");
    }

    /// A caller-side timeout is an absent verdict, never a refusal. Before the fix
    /// this folded into `SmsError::Failed` → `SmsProviderRejected` → the UI's
    /// 「发送失败」 for a message that may well have gone out (REQ-A1759/F-TEL-045).
    #[test]
    fn a_timed_out_send_reads_as_unconfirmed_not_a_refusal() {
        let verdict = send_outcome_from_failure(SmsError::TimedOut("no verdict within 8s".into()))
            .expect("a timeout must not be an error");
        assert_eq!(verdict.wire(), "unconfirmed");
        assert_eq!(
            verdict,
            SmsSendOutcome::Unconfirmed("no verdict within 8s".into()),
            "the provider's own words must survive into the verdict"
        );
    }

    /// Positive control: a *named* refusal is still a typed error, so widening the
    /// timeout arm did not turn every failure into a silent "unconfirmed".
    #[test]
    fn a_named_refusal_is_still_an_error() {
        for e in [
            SmsError::PermissionDenied("SEND_SMS not granted".into()),
            SmsError::Failed("radio off".into()),
            SmsError::Invalid("unknown state".into()),
            SmsError::Unavailable("no telephony service".into()),
        ] {
            let kind = e.kind();
            let err = send_outcome_from_failure(e)
                .expect_err("a named refusal must stay an error, not a verdict");
            assert_eq!(err.code(), codes::PROVIDER_REJECTED, "kind was {kind}");
            assert_eq!(
                err.cause.first().map(String::as_str),
                Some(match kind {
                    "permission" => "SMS permission denied: SEND_SMS not granted",
                    "invalid" => "invalid SMS payload: unknown state",
                    "unavailable" => "SMS provider unavailable: no telephony service",
                    _ => "SMS operation failed: radio off",
                }),
                "the refusal's own words must reach the envelope for kind {kind}"
            );
        }
    }

    #[tokio::test]
    async fn blocking_returns_the_provider_result() {
        let ok = blocking_with(Duration::from_secs(5), || Ok::<u32, SmsError>(7))
            .await
            .unwrap();
        assert_eq!(ok, 7);
        let err = blocking_with(Duration::from_secs(5), || {
            Err::<u32, SmsError>(SmsError::PermissionDenied("no READ_SMS".into()))
        })
        .await
        .unwrap_err();
        assert_eq!(err.kind(), "permission");
    }

    // ---- View-layer trash (REQ-A42) -----------------------------------------

    #[test]
    fn trashing_the_latest_message_swaps_the_preview_to_the_previous_visible_row() {
        let p = MockSms::seeded();
        let state = SmsTrashState::empty();
        // m2 is the newest *inbox* row (and unread) of thread 1.
        trash_message(
            &state,
            &p,
            "1",
            "m2",
            Some(amos_sms::SmsFolder::Inbox),
            5_000,
        )
        .unwrap();
        let (kept, trash_hidden) = apply_trash(
            p.snapshot(amos_sms::SmsFolder::Inbox).unwrap(),
            &state.read(),
        );
        assert_eq!(trash_hidden, 0, "the thread still has a visible row");
        let t = kept.iter().find(|t| t.id == "1").unwrap();
        // The preview moved to the previous visible message, and the badge for
        // the trashed unread row is gone — the "deleted" text leaks nowhere.
        assert_eq!(t.last_text, "下班顺路买点菜。");
        assert_eq!(t.last_ts_ms, 1_699_999_000_000);
        assert_eq!(t.unread, 0);
        // The thread read hides exactly the trashed row.
        let msgs = p.messages("1", None).unwrap();
        let (visible, trashed_n) = amos_sms::filter_messages(&msgs, &state.read());
        assert_eq!(trashed_n, 1);
        assert!(visible.iter().all(|m| m.id != "m2"));
    }

    #[test]
    fn a_thread_with_every_visible_message_trashed_disappears_from_the_list() {
        let p = MockSms::seeded();
        let state = SmsTrashState::empty();
        trash_message(
            &state,
            &p,
            "1",
            "m2",
            Some(amos_sms::SmsFolder::Inbox),
            5_000,
        )
        .unwrap();
        trash_message(
            &state,
            &p,
            "1",
            "m1",
            Some(amos_sms::SmsFolder::Inbox),
            6_000,
        )
        .unwrap();
        let (kept, trash_hidden) = apply_trash(
            p.snapshot(amos_sms::SmsFolder::Inbox).unwrap(),
            &state.read(),
        );
        assert_eq!(trash_hidden, 1);
        assert!(!kept.iter().any(|t| t.id == "1"), "fully trashed → hidden");
        // The trash list records ids + times only (never a message body).
        let list = state.list();
        let entry = list.iter().find(|e| e.message_id == "m1").unwrap();
        assert_eq!(entry.thread_id, "1");
    }

    #[test]
    fn trashing_an_unknown_message_id_is_a_not_found_outcome() {
        let p = MockSms::seeded();
        let state = SmsTrashState::empty();
        // The core reports "not found" as its own rejection (never a fabricated
        // entry), and the command maps it to the `not_found` wire state.
        let rejected = trash_message(&state, &p, "1", "nope", None, 0).unwrap_err();
        assert_eq!(rejected, TrashReject::NotFound);
        assert_eq!(trash_outcome(Err(rejected)), TrashAddOut::not_found());
        assert!(state.list().is_empty(), "no fabricated trash entries");
    }

    #[test]
    fn the_three_trash_states_serialize_to_the_documented_wire_shape() {
        // docs/sms.md §13 + backend.ts `SmsTrashAddResult`: these exact keys are
        // what the Svelte screen discriminates on (`r.trashed`, `"reason" in r`,
        // `"not_found" in r`) — snake_case, because serde's default is what Tauri
        // serializes and nothing here sets `rename_all`.
        let trashed = serde_json::to_value(TrashAddOut::trashed()).unwrap();
        assert_eq!(trashed, serde_json::json!({ "trashed": true }));

        let refused = serde_json::to_value(TrashAddOut::refused("blocked sender".into())).unwrap();
        assert_eq!(
            refused,
            serde_json::json!({ "trashed": false, "reason": "blocked sender" })
        );

        let not_found = serde_json::to_value(TrashAddOut::not_found()).unwrap();
        assert_eq!(
            not_found,
            serde_json::json!({ "trashed": false, "not_found": true })
        );
        // The UI keys off `trashed` first: only the success state may be truthy.
        assert!(trashed["trashed"].as_bool().unwrap());
        assert!(!refused["trashed"].as_bool().unwrap());
        assert!(!not_found["trashed"].as_bool().unwrap());
    }

    #[test]
    fn a_provider_read_failure_is_refused_never_a_fabricated_success() {
        /// A provider whose reads fail (no device backend / permission revoked).
        struct UnreadableSms;
        impl SmsProvider for UnreadableSms {
            fn name(&self) -> &'static str {
                "unreadable-test"
            }
            fn snapshot(&self, _f: amos_sms::SmsFolder) -> Result<Vec<SmsThread>, SmsError> {
                Err(SmsError::Unavailable("no device SMS backend".into()))
            }
            fn messages(
                &self,
                _t: &str,
                _f: Option<amos_sms::SmsFolder>,
            ) -> Result<Vec<SmsMessage>, SmsError> {
                Err(SmsError::Unavailable("no device SMS backend".into()))
            }
            fn counts(&self) -> Result<amos_sms::SmsFolderCounts, SmsError> {
                Err(SmsError::Unavailable("no device SMS backend".into()))
            }
            fn send(&self, address: &str, text: &str) -> Result<SmsSendOutcome, SmsError> {
                let _ = (normalize_address(address), validate_text(text));
                Err(SmsError::Unavailable("no device SMS backend".into()))
            }
        }

        // The provider errors (permission/native failure): the core must reject with
        // the provider's own message and the wire state must stay `trashed:false`.
        let p = UnreadableSms;
        let state = SmsTrashState::empty();
        let rejected = trash_message(&state, &p, "1", "m1", None, 0).unwrap_err();
        match &rejected {
            TrashReject::Refused(reason) => assert!(
                reason.contains("no device SMS backend"),
                "carries the provider's reason: {reason}"
            ),
            other => panic!("expected a refusal, got {other:?}"),
        }
        let out = serde_json::to_value(trash_outcome(Err(rejected))).unwrap();
        assert_eq!(out["trashed"], serde_json::json!(false));
        assert!(state.list().is_empty(), "nothing was stored");
    }

    #[test]
    fn restoring_brings_back_the_message_and_the_natural_preview() {
        let p = MockSms::seeded();
        let state = SmsTrashState::empty();
        trash_message(
            &state,
            &p,
            "1",
            "m2",
            Some(amos_sms::SmsFolder::Inbox),
            5_000,
        )
        .unwrap();
        assert!(state.restore("1", "m2"));
        // The override was dropped with the restore, so the provider's own
        // (fresh, non-trashed) preview shows again.
        let (kept, trash_hidden) = apply_trash(
            p.snapshot(amos_sms::SmsFolder::Inbox).unwrap(),
            &state.read(),
        );
        assert_eq!(trash_hidden, 0);
        let t = kept.iter().find(|t| t.id == "1").unwrap();
        assert_eq!(t.last_text, "晚上回家吃饭吗？");
        assert_eq!(t.unread, 1);
    }

    #[test]
    fn a_newer_message_makes_a_preview_override_stale_and_ignored() {
        let mut p = SmsTrash::new();
        p.set_preview(PreviewOverride {
            thread_id: "1".into(),
            at_last_ts_ms: 100,
            last_text: "old visible".into(),
            last_ts_ms: 50,
            unread: 0,
            hidden: false,
        });
        // A new message arrived: the thread's live last_ts_ms no longer matches
        // the stamp → the override must be ignored, natural preview wins.
        let threads = vec![SmsThread::new(
            "1",
            "13800138000",
            "",
            "fresh message",
            200,
            1,
        )];
        let (kept, hidden) = apply_trash(threads, &p);
        assert_eq!(hidden, 0);
        assert_eq!(kept[0].last_text, "fresh message");
    }

    /// A fresh temp dir for one trash-file test (unique per pid + nonce).
    fn trash_test_dir(tag: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "amos-sms-trash-{tag}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The `corrupt-*` sibling of a trash file, if the fix moved one aside.
    fn corrupt_aside(dir: &Path) -> Option<PathBuf> {
        std::fs::read_dir(dir)
            .ok()?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().contains("corrupt-"))
            })
    }

    /// F-SH-930 (REQ-A1929): a trash file that exists but cannot be parsed is **moved
    /// aside**, not silently folded into an empty trash while the path stays live — the
    /// very next `persist` (a whole-file tmp+rename) would otherwise overwrite the only
    /// copy of the user's trashed messages. Before the fix `configure` only warned and
    /// kept the path, so trashing one more message clobbered the file.
    #[test]
    fn a_corrupt_trash_file_is_kept_aside_before_the_next_persist_overwrites_it() {
        let dir = trash_test_dir("corrupt");
        let path = trash_file_in(&dir);
        std::fs::write(&path, b"{ not json at all").unwrap();

        let st = SmsTrashState::empty();
        st.configure(path.clone());
        assert!(st.list().is_empty(), "a corrupt file starts the trash empty");
        assert!(
            !path.exists(),
            "the corrupt file must be moved aside, not left to be overwritten"
        );
        let kept = corrupt_aside(&dir).expect("the corrupt file was kept under a corrupt-* name");
        assert_eq!(
            std::fs::read(&kept).unwrap(),
            b"{ not json at all",
            "the user's original bytes survive intact"
        );

        // A later write makes a fresh file at the original path — beside, not over, the kept one.
        trash_message(
            &st,
            &MockSms::seeded(),
            "1",
            "m2",
            Some(amos_sms::SmsFolder::Inbox),
            42,
        )
        .unwrap();
        assert!(path.exists(), "a fresh trash is written at the original path");
        assert!(kept.exists(), "and the preserved bytes are still there");
        assert_eq!(
            std::fs::read(&kept).unwrap(),
            b"{ not json at all",
            "the fresh write did not touch the preserved bytes"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Positive control: a **readable** file is loaded in place and is **not** moved aside
    /// (the fix must not rename healthy files). Applying the aside unconditionally makes
    /// this fail.
    #[test]
    fn a_readable_trash_file_is_loaded_without_being_moved_aside() {
        let dir = trash_test_dir("readable");
        let path = trash_file_in(&dir);

        // Produce a real, valid trash file with one entry.
        let writer = SmsTrashState::empty();
        writer.configure(path.clone()); // absent → silent first run
        trash_message(
            &writer,
            &MockSms::seeded(),
            "1",
            "m2",
            Some(amos_sms::SmsFolder::Inbox),
            42,
        )
        .unwrap();
        assert!(path.exists(), "the write created the file");

        let reader = SmsTrashState::empty();
        reader.configure(path.clone());
        assert_eq!(reader.list().len(), 1, "the readable file is loaded");
        assert!(path.exists(), "a readable file is left where it is");
        assert!(
            corrupt_aside(&dir).is_none(),
            "a readable file must not be moved aside"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The disjoint control: an **absent** file is the ordinary first run — nothing is
    /// moved aside, nothing is invented, and the path is still usable for the first write.
    #[test]
    fn a_missing_trash_file_keeps_nothing_aside() {
        let dir = trash_test_dir("missing");
        let path = trash_file_in(&dir);

        let st = SmsTrashState::empty();
        st.configure(path.clone());
        assert!(st.list().is_empty());
        assert!(!path.exists(), "no file is invented");
        assert!(
            corrupt_aside(&dir).is_none(),
            "a first run has nothing to move aside"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_trash_persists_across_a_reconfigure() {
        let dir = std::env::temp_dir().join(format!("amos-sms-trash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = trash_file_in(&dir);
        let p = MockSms::seeded();
        {
            let st = SmsTrashState::empty();
            st.configure(file.clone());
            trash_message(&st, &p, "1", "m2", Some(amos_sms::SmsFolder::Inbox), 42).unwrap();
            assert_eq!(st.list().len(), 1);
        }
        // A fresh state reading the same file sees the same trash — including
        // the preview override (so the hidden text stays hidden on restart).
        let st2 = SmsTrashState::empty();
        st2.configure(file.clone());
        assert_eq!(st2.list().len(), 1);
        let (kept, _) = apply_trash(p.snapshot(amos_sms::SmsFolder::Inbox).unwrap(), &st2.read());
        let t = kept.iter().find(|t| t.id == "1").unwrap();
        assert_eq!(t.last_text, "下班顺路买点菜。");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_answers_false_exactly_when_nothing_matched() {
        // The UI's restore branch reads this boolean as "it was no longer in the trash"
        // and words its message accordingly (`message.trashNotInTrash`, REQ-A288). Pin the
        // three cases that produce it, so a later change cannot make `false` also mean
        // "we tried and the write failed" without breaking this test (which is the only
        // thing standing between the UI's sentence and a silent lie).
        let p = MockSms::seeded();
        let state = SmsTrashState::empty();

        // (a) nothing was ever trashed → false, and nothing is invented.
        assert!(!state.restore("1", "m2"));
        assert!(state.read().is_empty());

        // (b) trashed, then restored → true; the entry is gone …
        trash_message(
            &state,
            &p,
            "1",
            "m2",
            Some(amos_sms::SmsFolder::Inbox),
            5_000,
        )
        .unwrap();
        assert_eq!(state.read().len(), 1);
        assert!(state.restore("1", "m2"));
        assert!(state.read().is_empty(), "the entry is gone");
        // … and the preview override went with it (it was computed against the trashed
        // state), which is what makes the natural preview show again.
        assert!(
            state.read().previews().is_empty(),
            "the override is dropped"
        );

        // (c) restoring it a second time is false again — a no-op, never an error.
        assert!(!state.restore("1", "m2"));
    }

    #[test]
    fn restore_with_a_malformed_or_foreign_id_is_a_no_op_never_a_panic() {
        // `sms_trash_restore` is a `#[tauri::command]` behind a UI button, so a malformed
        // id must not panic the host. The bridge logs the boundary violation (REQ-A286) and
        // the answer stays the same `false` the not-in-trash sentence describes.
        let p = MockSms::seeded();
        let state = SmsTrashState::empty();
        trash_message(
            &state,
            &p,
            "1",
            "m2",
            Some(amos_sms::SmsFolder::Inbox),
            5_000,
        )
        .unwrap();
        let oversized = "x".repeat(MAX_SMS_ID_BYTES + 1);
        for (thread, msg) in [
            ("", ""),
            ("1", ""),
            ("", "m2"),
            (oversized.as_str(), "m2"),
            ("1", oversized.as_str()),
        ] {
            assert!(
                !state.restore(thread, msg),
                "a malformed id ({thread:?}, {msg:?}) matches nothing"
            );
        }
        // …and it did not disturb the one real entry.
        assert_eq!(state.read().len(), 1);
        assert!(state.read().contains("1", "m2"));
    }

    #[test]
    fn purge_answers_a_count_so_zero_is_an_honest_success() {
        // The frontend reads the purge answer as "was the call answered?" and treats `0` as
        // a successful no-op (`smsTrashPurge`), so `0` must really mean "the trash was
        // already empty" — not "the purge failed".
        let p = MockSms::seeded();
        let state = SmsTrashState::empty();
        assert_eq!(
            state.purge(),
            0,
            "an empty trash purges nothing, successfully"
        );
        // Two entries from different threads (m2 is inbox thread "1", m4 inbox thread "2";
        // m3 is a *sent* row, so trashing it against the inbox folder is refused).
        trash_message(
            &state,
            &p,
            "1",
            "m2",
            Some(amos_sms::SmsFolder::Inbox),
            5_000,
        )
        .unwrap();
        trash_message(
            &state,
            &p,
            "2",
            "m4",
            Some(amos_sms::SmsFolder::Inbox),
            5_001,
        )
        .unwrap();
        assert_eq!(state.read().len(), 2);
        assert_eq!(state.purge(), 2);
        assert!(state.read().is_empty());
        assert!(
            state.read().previews().is_empty(),
            "purge drops the overrides too"
        );
        assert_eq!(state.purge(), 0, "and it stays a no-op the second time");
    }

    #[test]
    fn check_sms_id_rejects_empty_and_oversized() {
        assert!(check_sms_id("").is_err(), "empty id is refused");
        let huge = "x".repeat(MAX_SMS_ID_BYTES + 1);
        assert!(
            check_sms_id(&huge).is_err(),
            "id past MAX_SMS_ID_BYTES is refused"
        );
        // A real-looking thread id fits comfortably.
        assert!(check_sms_id("thread_42").is_ok());
        assert!(check_sms_id("+8613800138000").is_ok());
    }

    /// The sms commands now return `AmosError`; the wire vocabulary (codes
    /// module + enum side) must stay in lock-step, and the helper's two
    /// failure modes (blank / oversized) must produce **distinct** stable
    /// codes — a UI rendering "address is empty" must not be confused with
    /// "address is too long", so the two need their own branches.
    #[test]
    fn sms_error_codes_are_distinct_stability_keys() {
        use crate::error::{AmosError, ErrorCode};
        // Wire strings — UI i18n branches on these literals.
        assert_eq!(codes::BLANK_ID, "amos.sms.blank_id");
        assert_eq!(codes::ID_TOO_LONG, "amos.sms.id_too_long");
        assert_eq!(codes::UNKNOWN_FOLDER, "amos.sms.unknown_folder");
        assert_eq!(codes::BLOCKED_SENDER, "amos.sms.blocked_sender");
        assert_eq!(codes::TEXT_TOO_LONG, "amos.sms.text_too_long");
        assert_eq!(codes::PROVIDER_REJECTED, "amos.sms.provider_rejected");

        // Enum side keeps the same strings — drift would be a wire break.
        assert_eq!(ErrorCode::SmsBlankId.as_str(), codes::BLANK_ID);
        assert_eq!(ErrorCode::SmsIdTooLong.as_str(), codes::ID_TOO_LONG);

        // Each variant groups under "sms" — a single tracing filter scopes the
        // whole surface.
        assert_eq!(ErrorCode::SmsProviderRejected.group(), "sms");
        assert_eq!(ErrorCode::SmsTextTooLong.group(), "sms");

        // The two failure modes of `check_sms_id` are distinct codes — a UI
        // rendering one must not be confused with the other.
        let empty = check_sms_id("").expect_err("empty is refused");
        let huge = "x".repeat(MAX_SMS_ID_BYTES + 1);
        let oversized = check_sms_id(&huge).expect_err("oversized is refused");
        assert_eq!(empty.code, ErrorCode::SmsBlankId);
        assert_eq!(oversized.code, ErrorCode::SmsIdTooLong);
        assert_ne!(
            empty.code, oversized.code,
            "blank and oversized ids ride distinct codes"
        );

        // The envelope serialises both fields and the cause chain so a watcher
        // can read which provider rejected the read without grepping the source.
        let e = AmosError::with_cause(
            ErrorCode::SmsProviderRejected,
            codes::PROVIDER_REJECTED,
            "permission denied",
        );
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "amos.sms.provider_rejected");
        assert_eq!(v["cause"][0], "permission denied");
    }

    // ---- Foreground gate (F-SH-654) ------------------------------------------

    /// The focused window may read. `WmState::new()` seeds the launcher (`"main"`) focused —
    /// the phone/tablet shell's single window, which is where `MessagesApp` runs there.
    #[test]
    fn the_focused_window_may_read_sms() {
        let wm = crate::wm::WmState::new();
        assert_eq!(crate::clipboard::foreground_label(&wm).unwrap(), "main");
        assert!(
            require_sms_foreground(&wm, "main").is_ok(),
            "the window the user is looking at must be able to read messages"
        );
    }

    /// Any other window is refused — and the refusal is honest about *which* fact it is. The
    /// code is its own (`foreground_required`), **not** the provider's: "this window may not
    /// read right now" is a different fact from "the OS refused READ_SMS", and only the code
    /// can carry that distinction to a caller.
    #[test]
    fn a_background_window_is_refused_a_read() {
        let wm = crate::wm::WmState::new();
        let err = require_sms_foreground(&wm, "messages").unwrap_err();
        assert_eq!(err.code(), "amos.sms.foreground_required");
        assert_eq!(err.code(), codes::FOREGROUND_REQUIRED);
        assert_ne!(
            err.code(),
            codes::PROVIDER_REJECTED,
            "a foreground refusal must not be reported as the provider rejecting the read"
        );
        // The cause chain keeps `require_foreground`'s own words: both labels, so an operator
        // can read which window *did* have the read.
        let text = err.to_string();
        assert!(
            text.contains("messages") && text.contains("main"),
            "the refusal must name the caller and the window that does have the read: got \
             `{text}`"
        );
    }

    /// The statement in `body` that calls the gate, trimmed (see the clipboard twin, whose
    /// first version asked only whether the *name* appeared — a discarded `Result` denies
    /// nothing, so a `let _ = …` left it green).
    fn gate_statement<'a>(body: &'a str, fname: &str) -> &'a str {
        let at = body.find("require_sms_foreground(").unwrap_or_else(|| {
            panic!(
                "{fname} must gate its read through require_sms_foreground — a background \
                 window draining the user's messages is the F-SH-654 privacy failure"
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
            .unwrap_or_else(|| panic!("{fname} not found in sms.rs"));
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

    /// The body of the Kotlin function whose signature begins with `signature` (e.g.
    /// `"fun bind("`), up to its matching closing brace. Brace-counted so a nested block cannot
    /// cut it short — the Kotlin twin of [`command_body`].
    fn kotlin_fun_body<'a>(src: &'a str, signature: &str) -> &'a str {
        let start = src
            .find(signature)
            .unwrap_or_else(|| panic!("{signature} not found in the glue source"));
        let open = src[start..]
            .find('{')
            .map(|o| start + o)
            .unwrap_or_else(|| panic!("{signature} has no body"));
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
        panic!("{signature}'s body never closed");
    }

    /// Comments are stripped before the Kotlin pins look at the source, so a prose sentence
    /// mentioning a guard cannot satisfy (or defeat) a check meant for code — and a `//` inside
    /// a string literal is not a comment. Sixth copy of this helper in the repo (`blocklist.rs`,
    /// `incall.rs`, `rotation.rs`, `jni_glue.rs`, `amos-telephony/src/number.rs`); there is no
    /// `tests/common`, and `amos-tauri` copies cannot share one without making this module's
    /// tests depend on another module's test-only items.
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

    /// Source-level pin (red-first for P1-B2 / REQ-A1836): the thread read must judge the sender the
    /// **thread** belongs to, not the address the caller happened to send.
    ///
    /// Before the fix `sms_messages` consulted the blocklist only inside
    /// `if let Some(addr) = address…`, so a caller who sent just the thread id got a blocked
    /// sender's messages — the doc above the command ("…must not appear even if a caller asks
    /// for the thread id directly") was a promise no line enforced.
    #[test]
    fn the_thread_read_judges_the_senders_own_address() {
        const SRC: &str = include_str!("sms.rs");
        let body = command_body(SRC, "sms_messages");
        assert!(
            body.contains("blocked_thread_read("),
            "sms_messages must judge the thread's own address (blocked_thread_read) — the \
             caller's optional `address` is a fallback, not the authority: got\n{body}"
        );
    }

    /// Source-level pin (red-first for P1-B1 / REQ-A1836): the JNI arrival handler is behind
    /// `#[cfg(feature = "android")]`, so the lib test build never compiles it — the pure
    /// `incoming_is_suppressed` test above cannot prove the handler *uses* it. Before the fix
    /// the handler gated the verdict on `!payload.address.is_empty()`, so a withheld number
    /// with `block_unknown` never reached the rule and still notified.
    #[test]
    fn the_arrival_handler_routes_through_the_shared_verdict() {
        const SRC: &str = include_str!("sms.rs");
        let body = command_body(SRC, "Java_com_amos_ai_glue_SmsGlue_onIncoming");
        assert!(
            body.contains("incoming_is_suppressed("),
            "the JNI arrival handler must suppress through incoming_is_suppressed — gating on a \
             non-empty address would notify for a withheld number under block_unknown: got\n{body}"
        );
    }

    /// Source-level pin: every SMS command that hands back the user's messages calls the gate,
    /// and the call **is** the statement (propagated with `?`), not a value dropped on the
    /// floor. Deleting the gate from `sms_snapshot` makes this fail.
    #[test]
    fn every_read_command_propagates_the_foreground_gate() {
        const SRC: &str = include_str!("sms.rs");
        for fname in ["sms_snapshot", "sms_counts", "sms_messages"] {
            let stmt = gate_statement(command_body(SRC, fname), fname);
            assert!(
                stmt.starts_with("require_sms_foreground("),
                "{fname}'s gate must *be* the statement, not a value handed to something else \
                 (a discarded `Result` denies nothing): got `{stmt}`"
            );
            assert!(
                stmt.ends_with(")?"),
                "{fname} must propagate the gate's refusal with `?`: got `{stmt}`"
            );
        }
        // The contrast that makes it meaningful. `sms_trash_list` returns ids + times only
        // ("no content" — see its doc), and the write verbs are deliberately *not* gated:
        // posting a message from a background window is not a disclosure of the user's
        // messages, which is the attack this rule is about. Gating them would be a different
        // decision (an action rule), not this one.
        for fname in ["sms_trash_list", "sms_trash_add", "sms_send"] {
            assert!(
                !command_body(SRC, fname).contains("require_sms_foreground("),
                "{fname} must not carry the *read* gate — the rule here is about disclosure"
            );
        }
    }
}
