//! SMS bridge — exposes the real-SMS domain (`amos-sms`) to the WebView.
//!
//! Same shape as the radio/flashlight bridges, with three production concerns
//! made explicit:
//!
//! * **No UI-thread blocking.** Reading SMS means `ContentResolver`/JNI work on
//!   device. Tauri runs *synchronous* commands on the main thread, so every
//!   command here is `async` and the provider call is moved to the blocking pool
//!   (`tauri::async_runtime::spawn_blocking`) with a hard [`SMS_TIMEOUT`] — a
//!   wedged platform call surfaces as an honest error instead of a frozen UI.
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
    SmsMessage, SmsProvider, SmsThread, SmsTrash, TrashEntry, DEFAULT_TRASH_CAP,
};
use serde::Serialize;
use tauri::State;

/// Hard cap on one provider call. The blocking task itself cannot be cancelled,
/// but the caller is released with an honest timeout error instead of hanging.
const SMS_TIMEOUT: Duration = Duration::from_secs(8);

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
        Err(_) => Err(SmsError::Failed(format!(
            "SMS provider timed out after {}s",
            timeout.as_secs()
        ))),
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
fn checked_send(address: &str, text: &str) -> Result<(String, usize), String> {
    let addr = normalize_address(address).map_err(|e| e.to_string())?;
    validate_text(text).map_err(|e| e.to_string())?;
    Ok((addr, segment_count(text)))
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

    /// Point the state at a file and load it (once per path). A missing file is
    /// simply "no trash yet"; a corrupt one is logged and treated as empty
    /// (same policy as the blocklist — settings damage must never crash).
    pub fn configure(&self, path: PathBuf) {
        let mut slot = match self.path.lock() {
            Ok(p) => p,
            Err(poisoned) => poisoned.into_inner(),
        };
        if slot.as_deref() == Some(path.as_path()) {
            return;
        }
        *slot = Some(path.clone());
        if let Ok(text) = std::fs::read_to_string(&path) {
            match SmsTrash::from_json(&text, DEFAULT_TRASH_CAP) {
                Ok(loaded) => {
                    if let Ok(mut t) = self.inner.write() {
                        *t = loaded;
                    }
                    tracing::info!(
                        target: "amos::sms",
                        path = %path.display(),
                        "sms trash loaded"
                    );
                }
                Err(e) => tracing::warn!(
                    target: "amos::sms",
                    path = %path.display(),
                    error = %e,
                    "sms trash file unreadable — starting empty"
                ),
            }
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
            let _ = std::fs::create_dir_all(dir);
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
    let newly = trash
        .write()
        .add(thread_id, &m.id, m.ts_ms, trashed_ms)
        .map_err(|e| TrashReject::Refused(e.to_string()))?;
    if newly {
        tracing::info!(
            target: "amos::sms",
            thread = %thread_id,
            msg_id = %m.id,
            trashed_count = trash.read().len(),
            "message moved to the trash (hidden from AmOS; platform store untouched)"
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
) -> Result<TrashAddOut, String> {
    if thread_id.trim().is_empty() || message_id.trim().is_empty() {
        return Err("invalid SMS payload: blank thread/message id".to_string());
    }
    let folder = match folder.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(name) => Some(amos_sms::SmsFolder::from_wire(name).map_err(|e| e.to_string())?),
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
    .map_err(|e| e.to_string())
}

/// The trash list, newest first (ids + times only — no content).
#[tauri::command]
pub fn sms_trash_list() -> Vec<TrashOut> {
    trash_shared().list()
}

/// Undo a trash: the message shows in AmOS again. `true` when it was trashed.
#[tauri::command]
pub fn sms_trash_restore(thread_id: String, message_id: String) -> bool {
    let ok = trash_shared().restore(&thread_id, &message_id);
    if ok {
        tracing::info!(
            target: "amos::sms",
            thread = %thread_id,
            msg_id = %message_id,
            "message restored from the trash"
        );
    }
    ok
}

/// Empty the trash; returns how many entries were purged.
#[tauri::command]
pub fn sms_trash_purge() -> usize {
    let n = trash_shared().purge();
    if n > 0 {
        tracing::info!(target: "amos::sms", purged = n, "sms trash purged");
    }
    n
}

/// Read one folder's threads (newest first), with **blocked senders removed**.
/// `Err` (permission denied / unavailable / unknown folder) is honest and must
/// never be shown as "no messages"; an `Ok` empty list means that folder is
/// empty (or fully filtered — [`filter_threads`] reports the hidden count).
#[tauri::command]
pub async fn sms_snapshot(
    state: State<'_, SmsBridge>,
    folder: String,
) -> Result<Vec<SmsThreadOut>, String> {
    let folder = amos_sms::SmsFolder::from_wire(&folder).map_err(|e| e.to_string())?;
    let provider = active_arc(&state);
    let threads = blocking(move || provider.snapshot(folder))
        .await
        .map_err(|e| e.to_string())?;
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
pub async fn sms_counts(state: State<'_, SmsBridge>) -> Result<SmsFolderCountsOut, String> {
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
    .map_err(|e| e.to_string())
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

/// Read one thread's messages (chronological). An empty/absent `folder` means
/// "the whole conversation"; otherwise only that folder's rows.
///
/// `address` is the thread's remote party: when it is blocked for SMS the read
/// is refused with an honest error (a blocked sender's content must not appear
/// even if a caller asks for the thread id directly).
#[tauri::command]
pub async fn sms_messages(
    state: State<'_, SmsBridge>,
    thread_id: String,
    folder: Option<String>,
    address: Option<String>,
) -> Result<Vec<SmsMessageOut>, String> {
    if thread_id.trim().is_empty() {
        return Err("invalid SMS payload: blank thread id".to_string());
    }
    if let Some(addr) = address.as_deref().filter(|a| !a.trim().is_empty()) {
        if let Some(reason) = crate::blocklist::shared().check(addr, amos_blocklist::Channel::Sms) {
            return Err(format!("blocked by rule: {reason:?}"));
        }
    }
    let folder = match folder.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(name) => Some(amos_sms::SmsFolder::from_wire(name).map_err(|e| e.to_string())?),
    };
    let provider = active_arc(&state);
    let msgs = blocking(move || provider.messages(&thread_id, folder))
        .await
        .map_err(|e| e.to_string())?;
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
/// Returns `"sent"` on success so the caller can tell success from the `null`
/// that an unavailable/errored bridge yields.
#[tauri::command]
pub async fn sms_send(
    state: State<'_, SmsBridge>,
    address: String,
    text: String,
) -> Result<String, String> {
    let (addr, segments) = checked_send(&address, &text)?;
    let masked = mask_address(&addr);
    let provider = active_arc(&state);
    let send_addr = addr.clone();
    match blocking(move || provider.send(&send_addr, &text)).await {
        Ok(()) => {
            tracing::info!(
                target: "amos::sms",
                to = %masked,
                segments,
                "SMS send accepted by the provider"
            );
            Ok("sent".to_string())
        }
        Err(e) => {
            tracing::warn!(
                target: "amos::sms",
                to = %masked,
                kind = e.kind(),
                "SMS send failed"
            );
            Err(e.to_string())
        }
    }
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
        if !payload.address.is_empty() && crate::blocklist::shared().blocks_sms(&payload.address) {
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
        let _ = app.emit(SMS_RECEIVED_EVENT, payload);
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
        fn send(&self, address: &str, text: &str) -> Result<(), SmsError> {
            let _ = normalize_address(address)?;
            validate_text(text)?;
            Ok(())
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
            fn send(&self, _a: &str, _t: &str) -> Result<(), SmsError> {
                Ok(())
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
            fn send(&self, address: &str, text: &str) -> Result<(), SmsError> {
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
}
