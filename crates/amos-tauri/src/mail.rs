//! Tauri <-> mail bridge.
//!
//! Exposes the email client to the WebView. The managed [`MailBridge`] wraps an
//! [`amos_mail::MailClient`] over the deterministic offline
//! [`MockMailProvider`] (the same engine the `amos-mail-cli` drives), so the
//! "mail" app in the System UI works with zero network. A future live IMAP/SMTP
//! provider replaces the mock inside the bridge and nothing else changes.
//!
//! Commands are async and take `&self` — the mock owns its store behind a
//! mutex, so concurrent calls are safe.
//!
//! # Persistence
//!
//! When the `AMOS_MAIL_STORE` env var points at a file, [`MailBridge`] loads it
//! (or creates an empty one) and writes it back after every mutating command
//! (`send`/`read`/star/`delete`), so mail survives app restarts. Without it the
//! store is ephemeral and seeded with two demo messages on each launch.
//!
//! The write is **all-or-nothing**: a mutation whose store cannot be written is undone
//! and the command answers [`ErrorCode::MailPersistFailed`] rather than reporting a
//! success the disk did not accept (audit PH-P2-02). A "best-effort" write that warned
//! and returned `Ok` left the shell unable to tell a saved change from one lost at the
//! next launch — and re-reading the store could not catch it, because memory still held
//! the change.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use amos_mail::{
    Account, Address, Email, EmailSummary, MailClient, MockMailProvider, SendDraft, SendReceipt,
};
use tauri::State;

use crate::error::{AmosError, ErrorCode};

/// Default demo identity used as the account sender.
const ACCOUNT_EMAIL: &str = "me@amos.local";

/// Maximum bytes in a `mail_send` subject line.
///
/// E-mail subjects are traditionally kept under 78 chars by clients, and a UI
/// that paste-attacks a multi-megabyte subject into the bridge is far outside
/// any reasonable use case. 4 KiB is a generous ceiling.
pub const MAX_MAIL_SUBJECT_BYTES: usize = 4 << 10;

/// Maximum bytes in a `mail_send` body.
///
/// 4 MiB is two orders of magnitude above any real e-mail body; beyond that the
/// command is almost certainly a paste attack or a loop, and the right answer
/// is to refuse at the seam rather than let a giant body accumulate in memory
/// or stall the JSON store rewrite.
pub const MAX_MAIL_BODY_BYTES: usize = 4 << 20;

/// Maximum bytes in a mailbox / message id / target label the WebView hands in.
///
/// Real mailbox names are `INBOX` / `Sent` / `Drafts` / `<10 chars>`. The 256 B
/// cap mirrors `MAX_SESSION_ID_BYTES` — well above any legitimate value, but
/// tight enough that a paste-sized caller cannot inflate storage keys.
pub const MAX_MAIL_NAME_BYTES: usize = 256;

/// Maximum recipients in `mail_send` (to + cc combined).
///
/// Recipients are individually validated by `Address::bare`; this cap is the
/// extra ceiling a single compose-call may carry, so a runaway loop cannot ship
/// an enormous recipient list through the engine.
pub const MAX_MAIL_RECIPIENTS: usize = 256;

/// Managed mail engine state.
pub struct MailBridge {
    client: MailClient<MockMailProvider>,
    /// Optional JSON store path (from `$AMOS_MAIL_STORE`). When `None` the store
    /// is ephemeral and demo mail is seeded on launch.
    store: Option<PathBuf>,
}

/// Serializable mirror of what the mail surface can actually do — the same shape
/// [`crate::sms::SmsStatusOut`] uses, so a composer can say "this will not be
/// delivered" **before** the user writes anything (F-SH-824).
#[derive(Clone, Debug, serde::Serialize)]
pub struct MailStatusOut {
    /// Backend id: `"mock"` (host/offline) or, once a real account is configured,
    /// `"imap+smtp"`.
    pub provider: String,
    /// `true` only for a backend with a real wire. `false` means a send is filed
    /// in `Sent` and delivered nowhere.
    pub delivers: bool,
}

/// The demo account used as the sender (infallible: literals are valid).
fn demo_account() -> Account {
    Account {
        id: "demo".into(),
        display_name: "Amos Demo".into(),
        email: Address {
            name: String::new(),
            email: ACCOUNT_EMAIL.into(),
        },
    }
}

impl MailBridge {
    /// Build a bridge. Honors `$AMOS_MAIL_STORE`: when set, the store is loaded
    /// (or created) from that file and persists across app restarts; otherwise an
    /// ephemeral store seeded with a couple of demo messages is used.
    pub fn new() -> Self {
        match std::env::var("AMOS_MAIL_STORE")
            .ok()
            .filter(|s| !s.is_empty())
        {
            Some(p) => Self::from_store(Path::new(&p)),
            None => Self::seeded(),
        }
    }

    /// An in-memory store seeded with a couple of demo messages (default path).
    pub fn seeded() -> Self {
        let provider = MockMailProvider::new();
        // Addresses below are statically valid literals; construct them directly
        // (pub fields) to keep this infallible.
        let from_ada = Address {
            name: "Ada".into(),
            email: "ada@x.io".into(),
        };
        let from_grace = Address {
            name: "Grace".into(),
            email: "grace@x.io".into(),
        };
        let me = Address {
            name: String::new(),
            email: ACCOUNT_EMAIL.into(),
        };
        // The in-memory mock accepts every delivery, so a discarded error here can only ever
        // shorten a *demo* inbox (never a user-visible failure) — kept as an explicit
        // discard rather than an unexamined one.
        let _ = provider.deliver(
            Some(from_ada),
            vec![me.clone()],
            "Welcome to Amos Mail",
            "Hi! This is your first mail app message.\nTry replying to see it land in Sent.",
            1_700_000_000,
        );
        let _ = provider.deliver(
            Some(from_grace),
            vec![me],
            "Re: build report",
            "Build is green. Shipping the email client today.",
            1_700_010_000,
        );
        Self {
            client: MailClient::new(provider, demo_account()),
            store: None,
        }
    }

    /// Load (or create) a persistent store at `path`. Never seeds demo mail into
    /// a user's real store. If the file is unreadable/corrupt it is **moved aside** and
    /// the bridge starts empty — so the app stays usable and the first successful write
    /// cannot clobber the one file that still held the user's mail (audit PH-P2-02).
    pub fn from_store(path: &Path) -> Self {
        let provider = match MockMailProvider::open_file(path) {
            Ok(p) => p,
            Err(e) => {
                let kept = preserve_unreadable_store(path);
                match &kept {
                    Some(k) => tracing::warn!(
                        "mail store {} unreadable: {e}; kept at {} and starting empty",
                        path.display(),
                        k.display(),
                    ),
                    None => tracing::warn!(
                        "mail store {} unreadable: {e}; could not be moved aside, starting empty",
                        path.display(),
                    ),
                }
                MockMailProvider::new()
            }
        };
        Self {
            client: MailClient::new(provider, demo_account()),
            store: Some(path.to_path_buf()),
        }
    }

    /// What this bridge can actually do. Today `client` is monomorphized over
    /// [`MockMailProvider`], so the answer is always the offline mock: sends are
    /// filed in `Sent` and delivered nowhere. The method exists so the composer's
    /// disclosure is read *off the backend* rather than hardcoded in the frontend —
    /// when this bridge is handed `live::ImapSmtpProvider` (account config, i.e.
    /// audit PH-P0-1), only this changes.
    pub fn status(&self) -> MailStatusOut {
        MailStatusOut {
            provider: "mock".to_string(),
            delivers: false,
        }
    }

    /// Take the undo image of the durable store **before** a mutation.
    ///
    /// Three answers, not two: `Ok(None)` is a bridge with no store (nothing was
    /// promised to survive a restart, so nothing needs undoing), `Ok(Some bytes)` is the
    /// image to [`restore`](amos_mail::MockMailProvider::restore) if the write fails, and
    /// `Err` is a store that could not even be read into an image — in which case a
    /// mutation could not be taken back, so the caller must **refuse before mutating**
    /// rather than risk a change it can never undo.
    fn undo_image(&self) -> Result<Option<Vec<u8>>, String> {
        if self.store.is_none() {
            return Ok(None);
        }
        self.client
            .provider()
            .snapshot()
            .map(Some)
            .map_err(|e| format!("mail store could not be snapshotted: {e}"))
    }

    /// Write the store, undoing the in-memory mutation if the write fails.
    ///
    /// A mutation that cannot be persisted must not be **reported as done** (audit
    /// PH-P2-02). The shell re-reads the store to decide whether a write landed
    /// (`MailApp.svelte::settleFlag`), so simply returning an error while leaving the
    /// change in memory would make the host-vs-refusal disagreement invisible — the
    /// re-read would still see the intended value. Restoring `before` is what makes the
    /// refusal observable as *absence* of the change.
    ///
    /// A bridge with no store is a no-op: it promised nothing durable, so there is
    /// nothing to refuse. (A no-op is never a `before == None` confusion: `undo_image`
    /// returned `None` for exactly this case, and the `store.is_none()` guard here is the
    /// same fact, not a second guess.)
    fn persist_or_undo(&self, before: Option<Vec<u8>>) -> Result<(), String> {
        let Some(p) = &self.store else {
            return Ok(());
        };
        match self.client.provider().save_file(p) {
            Ok(()) => Ok(()),
            Err(e) => {
                let msg = format!("failed to persist mail store {}: {e}", p.display());
                tracing::warn!("{msg}");
                if let Some(bytes) = before {
                    if let Err(re) = self.client.provider().restore(&bytes) {
                        // Both halves failed: the running state now disagrees with the
                        // refusal we are about to report. There is nothing left to do but
                        // say so — this is the one case the undo could not cover.
                        tracing::error!("mail store undo failed after a persist error: {re}");
                    }
                }
                Err(msg)
            }
        }
    }

    /// The undo image's failure as a typed refusal, for the commands whose seam answers
    /// [`AmosError`] rather than a bare string.
    fn undo_image_error(e: String) -> AmosError {
        AmosError::new(ErrorCode::MailPersistFailed, e)
    }
}

/// Move an unreadable store file aside so the first successful write cannot destroy it.
///
/// Returns the path it was kept at, or `None` when it could not be moved (a permission
/// error, or a non-file at `path`) — the caller's warning says which. A silent `None`
/// would be the very defect this exists to remove, one level down.
fn preserve_unreadable_store(path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        // `open_file` only fails on bytes it could read but not parse, or a path that is
        // not a regular file. Nothing to preserve in the latter case.
        return None;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let kept = path.with_extension(format!("corrupt-{nonce}"));
    std::fs::rename(path, &kept).ok().map(|()| kept)
}

impl Default for MailBridge {
    fn default() -> Self {
        Self::new()
    }
}

/// Wire spellings the mail surface owns (each is its [`ErrorCode`]'s `as_str`, so the code is
/// declared once and read from there).
pub mod codes {
    use crate::error::ErrorCode;

    /// A read driven by a window the user is not looking at.
    pub const FOREGROUND_REQUIRED: &str = ErrorCode::MailForegroundRequired.as_str();
    /// A malformed mailbox / id / query.
    pub const INVALID_ARGUMENT: &str = ErrorCode::MailInvalidArgument.as_str();
    /// The engine refused a well-formed request.
    pub const PROVIDER_REJECTED: &str = ErrorCode::MailProviderRejected.as_str();
}

/// A mailbox / id / query the seam refuses — empty, or over [`MAX_MAIL_NAME_BYTES`].
fn invalid_argument(message: String) -> AmosError {
    AmosError::new(ErrorCode::MailInvalidArgument, message)
}

/// The engine's own refusal, with its words kept as the cause so an operator can read *why*
/// without grepping the source.
fn provider_rejected(e: impl std::fmt::Display) -> AmosError {
    AmosError::with_cause(ErrorCode::MailProviderRejected, e.to_string(), e)
}

/// The user's mail is a disclosure, so the reads follow the same rule `clipboard_read`, the
/// SMS reads (`sms::require_sms_foreground`), the in-call recording toggle and
/// `device_mic_start` follow: only the window the user is actually looking at may read it.
/// Without this, any window's WebView could reach `mail_list` / `mail_read` / `mail_search` /
/// `mail_inbox` with an `invoke` and drain the mailbox — the frontend's capability ledger is a
/// `$state` in the very JS context that would be doing the reaching, so it can never be the
/// guard. The caller's label is injected by Tauri (not an argument), so a caller cannot claim
/// to be another window.
///
/// Named and compiled on **every** target (not behind `#[cfg(feature = "android")]`) for the
/// same reason [`crate::clipboard::require_foreground`] is: a host test can pin both
/// directions, and the device is what is pending, not the rule.
pub fn require_mail_foreground(wm: &crate::wm::WmState, caller: &str) -> Result<(), AmosError> {
    crate::clipboard::require_foreground(wm, caller).map_err(|e| {
        // The rule is `clipboard::require_foreground`'s alone, and its words (the caller's
        // label and the focused one) ride along as the cause so an operator can read which
        // window *did* have the read.
        AmosError::with_cause(
            ErrorCode::MailForegroundRequired,
            format!(
                "mail read refused: {e} (only the window the user is looking at may read \
                 mail; F-SH-655)"
            ),
            e,
        )
    })
}

/// List selectable mailbox names.
///
/// **Not** gated, on purpose: mailbox *names* are the shape of the mailbox (the provider's
/// `INBOX` / `Sent` / …), not the user's correspondence — the same boundary the SMS reads draw
/// around `sms_trash_list` ("ids + times only — no content"). A window with no right to read
/// the mail still cannot see a subject, a sender or a body through this command.
#[tauri::command]
pub async fn mail_mailboxes(state: State<'_, MailBridge>) -> Result<Vec<String>, String> {
    state.client.mailboxes().await.map_err(|e| e.to_string())
}

/// What the mail surface can actually deliver. **Not** gated, on purpose: it
/// carries a capability, not one byte of the user's correspondence — the same
/// boundary `mail_mailboxes` and `sms_trash_list` draw. Without it the composer
/// could only discover the offline mock *after* a send printed 「已发送」 (F-SH-824).
#[tauri::command]
pub async fn mail_status(state: State<'_, MailBridge>) -> Result<MailStatusOut, String> {
    Ok(state.status())
}

/// List message summaries in `mailbox`, newest first, capped by `limit`.
#[tauri::command]
pub async fn mail_list(
    state: State<'_, MailBridge>,
    wm: State<'_, crate::wm::WmState>,
    window: tauri::WebviewWindow,
    mailbox: String,
    limit: Option<usize>,
) -> Result<Vec<EmailSummary>, AmosError> {
    // Before the engine is even asked: reading the mailbox is a disclosure, so only the
    // window the user is looking at may do it (F-SH-655).
    require_mail_foreground(wm.inner(), window.label())?;
    check_mail_name(&mailbox).map_err(invalid_argument)?;
    state
        .client
        .list(&mailbox, limit)
        .await
        .map_err(provider_rejected)
}

/// Search summaries in `mailbox` (sender/recipient/subject/body), newest first.
#[tauri::command]
pub async fn mail_search(
    state: State<'_, MailBridge>,
    wm: State<'_, crate::wm::WmState>,
    window: tauri::WebviewWindow,
    mailbox: String,
    query: String,
) -> Result<Vec<EmailSummary>, AmosError> {
    require_mail_foreground(wm.inner(), window.label())?;
    check_mail_name(&mailbox).map_err(invalid_argument)?;
    if query.len() > MAX_MAIL_NAME_BYTES {
        return Err(invalid_argument(format!(
            "mail_search query too long: {} bytes (max {MAX_MAIL_NAME_BYTES})",
            query.len()
        )));
    }
    state
        .client
        .search(&mailbox, &query, None)
        .await
        .map_err(provider_rejected)
}

/// Fetch a full message and mark it read.
#[tauri::command]
pub async fn mail_read(
    state: State<'_, MailBridge>,
    wm: State<'_, crate::wm::WmState>,
    window: tauri::WebviewWindow,
    mailbox: String,
    id: String,
) -> Result<Email, AmosError> {
    require_mail_foreground(wm.inner(), window.label())?;
    check_mail_name(&mailbox).map_err(invalid_argument)?;
    check_mail_name(&id).map_err(invalid_argument)?;
    let before = state.undo_image().map_err(MailBridge::undo_image_error)?;
    let email = state
        .client
        .read(&mailbox, &id)
        .await
        .map_err(provider_rejected)?;
    state
        .persist_or_undo(before)
        .map_err(MailBridge::undo_image_error)?;
    Ok(email)
}

/// Compose and send a message (sender filled from the account).
#[tauri::command]
pub async fn mail_send(
    state: State<'_, MailBridge>,
    to: Vec<String>,
    subject: String,
    body: String,
    cc: Option<Vec<String>>,
) -> Result<SendReceipt, String> {
    // Bound at the command seam — `body` reaching multi-megabytes would inflate
    // both the in-memory mock store and the JSON persistence on every mutation,
    // and `subject` is meant to be a one-line header.
    if subject.len() > MAX_MAIL_SUBJECT_BYTES {
        return Err(format!(
            "subject too long: {} bytes (max {MAX_MAIL_SUBJECT_BYTES})",
            subject.len()
        ));
    }
    if body.len() > MAX_MAIL_BODY_BYTES {
        return Err(format!(
            "body too long: {} bytes (max {MAX_MAIL_BODY_BYTES})",
            body.len()
        ));
    }
    let total = to.len() + cc.as_ref().map(|c| c.len()).unwrap_or(0);
    if total > MAX_MAIL_RECIPIENTS {
        return Err(format!(
            "too many recipients: {total} (max {MAX_MAIL_RECIPIENTS})"
        ));
    }
    let mut draft: SendDraft = state.client.compose(&subject, &body);
    for raw in &to {
        let a = Address::bare(raw).map_err(|e| e.to_string())?;
        draft.to.push(a);
    }
    for raw in cc.unwrap_or_default() {
        let a = Address::bare(&raw).map_err(|e| e.to_string())?;
        draft.cc.push(a);
    }
    if draft.to.is_empty() && draft.cc.is_empty() {
        return Err("draft needs at least one recipient (to or cc)".into());
    }
    let before = state.undo_image()?;
    let receipt = state.client.send(draft).await.map_err(|e| e.to_string())?;
    state.persist_or_undo(before)?;
    Ok(receipt)
}

/// Convenience: the INBOX summaries the mail app shows on open.
#[tauri::command]
pub async fn mail_inbox(
    state: State<'_, MailBridge>,
    wm: State<'_, crate::wm::WmState>,
    window: tauri::WebviewWindow,
    limit: Option<usize>,
) -> Result<Vec<EmailSummary>, AmosError> {
    require_mail_foreground(wm.inner(), window.label())?;
    state.client.inbox(limit).await.map_err(provider_rejected)
}

/// Star / unstar a message.
#[tauri::command]
pub async fn mail_set_flagged(
    state: State<'_, MailBridge>,
    mailbox: String,
    id: String,
    flagged: bool,
) -> Result<(), String> {
    check_mail_name(&mailbox)?;
    check_mail_name(&id)?;
    let before = state.undo_image()?;
    state
        .client
        .set_flagged(&mailbox, &id, flagged)
        .await
        .map_err(|e| e.to_string())?;
    state.persist_or_undo(before)?;
    Ok(())
}

/// Mark a message replied / un-replied.
#[tauri::command]
pub async fn mail_set_answered(
    state: State<'_, MailBridge>,
    mailbox: String,
    id: String,
    answered: bool,
) -> Result<(), String> {
    check_mail_name(&mailbox)?;
    check_mail_name(&id)?;
    let before = state.undo_image()?;
    state
        .client
        .set_answered(&mailbox, &id, answered)
        .await
        .map_err(|e| e.to_string())?;
    state.persist_or_undo(before)?;
    Ok(())
}

/// Mark a message read / unread.
#[tauri::command]
pub async fn mail_set_seen(
    state: State<'_, MailBridge>,
    mailbox: String,
    id: String,
    seen: bool,
) -> Result<(), String> {
    check_mail_name(&mailbox)?;
    check_mail_name(&id)?;
    let before = state.undo_image()?;
    state
        .client
        .set_seen(&mailbox, &id, seen)
        .await
        .map_err(|e| e.to_string())?;
    state.persist_or_undo(before)?;
    Ok(())
}

/// Delete a message from a mailbox.
#[tauri::command]
pub async fn mail_delete(
    state: State<'_, MailBridge>,
    mailbox: String,
    id: String,
) -> Result<(), String> {
    check_mail_name(&mailbox)?;
    check_mail_name(&id)?;
    let before = state.undo_image()?;
    state
        .client
        .delete(&mailbox, &id)
        .await
        .map_err(|e| e.to_string())?;
    state.persist_or_undo(before)?;
    Ok(())
}

/// Move a message from `mailbox` into `target` (archive / trash).
#[tauri::command]
pub async fn mail_move(
    state: State<'_, MailBridge>,
    mailbox: String,
    id: String,
    target: String,
) -> Result<(), String> {
    check_mail_name(&mailbox)?;
    check_mail_name(&id)?;
    check_mail_name(&target)?;
    let before = state.undo_image()?;
    state
        .client
        .move_to(&mailbox, &id, &target)
        .await
        .map_err(|e| e.to_string())?;
    state.persist_or_undo(before)?;
    Ok(())
}

/// Bound a mailbox / message id / target label at the command seam so a
/// paste-sized caller cannot inflate the engine's persistent storage keys.
fn check_mail_name(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Err("mail name is empty".to_string());
    }
    if s.len() > MAX_MAIL_NAME_BYTES {
        return Err(format!(
            "mail name too long: {} bytes (max {MAX_MAIL_NAME_BYTES})",
            s.len()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_mail::EmailSummary;

    /// The newest INBOX summary (the message `mail_read` shows first).
    /// `client` is private but tests live in the same module.
    async fn newest(b: &MailBridge) -> EmailSummary {
        b.client
            .inbox(None)
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
    }

    #[tokio::test]
    async fn new_bridge_seeds_demo_inbox_newest_first() {
        let b = MailBridge::seeded();
        let boxes = b.client.mailboxes().await.unwrap();
        assert!(boxes.contains(&"INBOX".to_string()));
        assert!(boxes.contains(&"Sent".to_string()));

        let inbox = b.client.inbox(None).await.unwrap();
        assert_eq!(inbox.len(), 2);
        assert_eq!(inbox[0].subject, "Re: build report"); // newest first
        assert!(!inbox[0].flags.seen);
    }

    #[tokio::test]
    async fn read_marks_seen() {
        let b = MailBridge::seeded();
        let id = newest(&b).await.id;
        assert!(!newest(&b).await.flags.seen);
        let email = b.client.read("INBOX", &id).await.unwrap();
        assert_eq!(
            email.body_plain,
            "Build is green. Shipping the email client today."
        );
        assert!(newest(&b).await.flags.seen, "read() marks seen");
    }

    #[tokio::test]
    async fn send_uses_account_sender_and_lands_in_sent() {
        let b = MailBridge::seeded();
        let mut draft = b.client.compose("hello", "from the bridge test");
        draft.to.push(Address {
            name: "Them".into(),
            email: "them@x.io".into(),
        });
        let receipt = b.client.send(draft).await.unwrap();

        let sent = b.client.list("Sent", None).await.unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].id, receipt.id);
        let full = b.client.fetch("Sent", &receipt.id).await.unwrap();
        assert_eq!(
            full.summary.from.as_ref().unwrap().to_string(),
            "Amos Demo <me@amos.local>"
        );
    }

    /// The default bridge is the offline mock, so its status must say so: a
    /// composer that reads `delivers: true` here would promise a wire that does
    /// not exist (F-SH-824). Positive control: the field is read, and a `true`
    /// would flip the assertion.
    #[test]
    fn the_bridge_reports_it_cannot_deliver() {
        let b = MailBridge::seeded();
        let s = b.status();
        assert_eq!(s.provider, "mock");
        assert!(
            !s.delivers,
            "the offline mock has no wire; the status must not claim delivery"
        );
    }

    /// The receipt the frontend reads must not claim delivery either — the two
    /// ends agree, so no path can print 「已发送」 for a message that never left
    /// the device. This is the Rust half of the frontend assertion.
    #[tokio::test]
    async fn the_send_receipt_never_claims_delivery_on_the_mock() {
        let b = MailBridge::seeded();
        let mut draft = b.client.compose("hello", "does this leave the device?");
        draft.to.push(Address::bare("them@x.io").unwrap());
        let receipt = b.client.send(draft).await.unwrap();
        assert!(!receipt.delivered, "a mock send is stored, not delivered");
        // Positive control: the stored copy still exists, so `delivered: false`
        // means "not on a wire", not "the send failed".
        assert_eq!(b.client.list("Sent", None).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn flag_and_delete_round_trip() {
        let b = MailBridge::seeded();
        let id = newest(&b).await.id;
        assert!(!newest(&b).await.flags.flagged);
        b.client.set_flagged("INBOX", &id, true).await.unwrap();
        assert!(newest(&b).await.flags.flagged);

        let count = b.client.inbox(None).await.unwrap().len();
        b.client.delete("INBOX", &id).await.unwrap();
        assert_eq!(b.client.inbox(None).await.unwrap().len(), count - 1);
    }

    #[tokio::test]
    async fn from_store_persists_across_bridges() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "amos-mail-tauri-bridge-{}-{nonce}.json",
            std::process::id()
        ));

        // A store-backed bridge is never seeded with demo mail.
        let b = MailBridge::from_store(&path);
        assert!(
            b.client.inbox(None).await.unwrap().is_empty(),
            "persistent store must not be seeded with demo mail"
        );

        let mut draft = b.client.compose("hello", "persisted across restarts");
        draft.to.push(Address {
            name: "Them".into(),
            email: "them@x.io".into(),
        });
        b.client.send(draft).await.unwrap();
        b.persist_or_undo(b.undo_image().unwrap()).unwrap();

        // A fresh bridge over the same path sees the message (cross-restart).
        let again = MailBridge::from_store(&path);
        assert_eq!(again.client.list("Sent", None).await.unwrap().len(), 1);
        assert_eq!(again.client.list("INBOX", None).await.unwrap().len(), 0);

        let _ = std::fs::remove_file(&path);
    }

    /// PH-P2-02 (load half): an unreadable store is **moved aside**, not silently replaced
    /// — otherwise the first successful write overwrites the one file that still held the
    /// user's mail. Before the fix, `from_store` only warned and kept the path, so the next
    /// mutation clobbered the user's bytes with an empty store.
    #[tokio::test]
    async fn an_unreadable_store_is_preserved_not_silently_replaced() {
        let dir = std::env::temp_dir().join(format!(
            "amos-mail-corrupt-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.json");
        std::fs::write(&path, b"{ not json at all").unwrap();

        let b = MailBridge::from_store(&path);
        assert!(
            b.client.inbox(None).await.unwrap().is_empty(),
            "an unreadable store starts the bridge empty"
        );
        assert!(
            !path.exists(),
            "the unreadable file must be moved aside, not left to be overwritten"
        );
        let kept = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.to_string_lossy().contains("corrupt-"))
            .expect("the unreadable store was kept under a corrupt-* name");
        assert_eq!(
            std::fs::read(&kept).unwrap(),
            b"{ not json at all",
            "the user's bytes survive intact"
        );

        // A later successful write makes a fresh store at the original path — beside, not
        // over, the kept file.
        let before = b.undo_image().unwrap();
        b.persist_or_undo(before).unwrap();
        assert!(
            path.exists(),
            "a fresh store is written at the original path"
        );
        assert!(kept.exists(), "and the preserved bytes are still there");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The path a store cannot be written to: a file inside a directory that is never
    /// created. `open_file` treats the missing file as "start empty" (so the bridge is
    /// usable), but every `save_file` fails with `ENOENT` — the reachable shape of a real
    /// persistence failure (a removed mount, a read-only directory) without needing root.
    fn unwritable_store_path() -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "amos-mail-nowrite-{}-{nonce}/store.json",
            std::process::id()
        ))
    }

    /// A store-backed bridge with one inbox message: `from_store` starts **empty** (it must
    /// never seed demo mail into a user's store), so a test that needs a row to mutate
    /// delivers one itself.
    fn bridge_with_one_inbox_message(path: &Path) -> MailBridge {
        let b = MailBridge::from_store(path);
        b.client
            .provider()
            .deliver(
                Some(Address::bare("a@x.io").unwrap()),
                vec![Address::bare(ACCOUNT_EMAIL).unwrap()],
                "hello",
                "body",
                10,
            )
            .unwrap();
        b
    }

    /// PH-P2-02 red-first: a mutation whose store cannot be written must be **undone** and
    /// reported, not left in memory behind an `Ok`. Before the fix, `persist_best_effort`
    /// only warned and the command answered success — so the shell (which re-reads the
    /// store to judge a write, `MailApp.svelte::settleFlag`) would see the intended value
    /// and draw it as fact, even though a restart would lose it.
    #[tokio::test]
    async fn a_failed_persist_undoes_the_mutation_and_reports_it() {
        let b = bridge_with_one_inbox_message(&unwritable_store_path());
        let id = newest(&b).await.id;
        assert!(!newest(&b).await.flags.flagged);

        // The command-shaped sequence: image → mutate → persist.
        let before = b.undo_image().unwrap();
        b.client.set_flagged("INBOX", &id, true).await.unwrap();
        assert!(
            newest(&b).await.flags.flagged,
            "the engine applies the mutation before any persist is attempted"
        );

        let err = b.persist_or_undo(before).unwrap_err();
        assert!(
            err.contains("persist"),
            "the refusal names the store it could not write: {err}"
        );
        assert!(
            !newest(&b).await.flags.flagged,
            "a mutation whose persist failed must not survive in memory — otherwise the \
             store re-read cannot tell it from a saved change (PH-P2-02)"
        );
    }

    /// Positive control for [`a_failed_persist_undoes_the_mutation_and_reports_it`]: with a
    /// **writable** store the same sequence keeps the change and answers `Ok`, so the
    /// undo is driven by the write's own verdict and not by the snapshot being taken.
    #[tokio::test]
    async fn a_writable_store_keeps_the_mutation_and_answers_ok() {
        let path = std::env::temp_dir().join(format!(
            "amos-mail-writable-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let b = bridge_with_one_inbox_message(&path);
        let id = newest(&b).await.id;

        let before = b.undo_image().unwrap();
        b.client.set_flagged("INBOX", &id, true).await.unwrap();
        b.persist_or_undo(before).unwrap();
        assert!(newest(&b).await.flags.flagged);

        let _ = std::fs::remove_file(&path);
    }

    /// Third answer, not folded into the other two: a bridge with **no** store returns
    /// `Ok(None)` from `undo_image` (nothing was promised to survive a restart) and
    /// `Ok(())` from `persist_or_undo`, so an ephemeral/demo bridge is never treated as a
    /// persistence failure.
    #[tokio::test]
    async fn an_ephemeral_bridge_needs_no_undo_and_never_refuses() {
        let b = MailBridge::seeded();
        let id = newest(&b).await.id;
        assert!(b.undo_image().unwrap().is_none());
        b.client.set_flagged("INBOX", &id, true).await.unwrap();
        b.persist_or_undo(None).unwrap();
        assert!(newest(&b).await.flags.flagged);
    }

    #[tokio::test]
    async fn archive_moves_newest_into_archive_mailbox() {
        let b = MailBridge::seeded();
        let id = newest(&b).await.id;
        b.client.archive("INBOX", &id).await.unwrap();
        assert!(b
            .client
            .inbox(None)
            .await
            .unwrap()
            .iter()
            .all(|m| m.id != id));
        let archive = b.client.list("Archive", None).await.unwrap();
        assert_eq!(archive.len(), 1);
        assert_eq!(archive[0].id, id);
    }

    #[tokio::test]
    async fn search_finds_seeded_by_body() {
        let b = MailBridge::seeded();
        let hits = b.client.search("INBOX", "shipping", None).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].subject, "Re: build report");
    }

    // ---- Foreground gate (F-SH-655) ------------------------------------------

    /// The focused window may read. `WmState::new()` seeds the launcher (`"main"`) focused —
    /// the phone/tablet shell's single window, which is where `MailApp` runs there.
    #[test]
    fn the_focused_window_may_read_mail() {
        let wm = crate::wm::WmState::new();
        assert_eq!(crate::clipboard::foreground_label(&wm).unwrap(), "main");
        assert!(
            require_mail_foreground(&wm, "main").is_ok(),
            "the window the user is looking at must be able to read mail"
        );
    }

    /// Any other window is refused — and the refusal is honest about *which* fact it is. The
    /// code is its own (`foreground_required`), **not** the engine's: "this window may not
    /// read right now" is a different fact from "the mail engine refused the read", and only
    /// the code can carry that distinction to a caller.
    #[test]
    fn a_background_window_is_refused_a_read() {
        let wm = crate::wm::WmState::new();
        let err = require_mail_foreground(&wm, "mail").unwrap_err();
        assert_eq!(err.code(), "amos.mail.foreground_required");
        assert_eq!(err.code(), codes::FOREGROUND_REQUIRED);
        assert_ne!(
            err.code(),
            codes::PROVIDER_REJECTED,
            "a foreground refusal must not be reported as the engine rejecting the read"
        );
        // The cause chain keeps `require_foreground`'s own words: both labels, so an operator
        // can read which window *did* have the read.
        let text = err.to_string();
        assert!(
            text.contains("mail") && text.contains("main"),
            "the refusal must name the caller and the window that does have the read: got \
             `{text}`"
        );
    }

    /// The statement in `body` that calls the gate, trimmed (the clipboard twin's first
    /// version asked only whether the *name* appeared — a discarded `Result` denies nothing,
    /// so a `let _ = …` left it green).
    fn gate_statement<'a>(body: &'a str, fname: &str) -> &'a str {
        let at = body.find("require_mail_foreground(").unwrap_or_else(|| {
            panic!(
                "{fname} must gate its read through require_mail_foreground — a background \
                 window draining the user's mailbox is the F-SH-655 privacy failure"
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
            .unwrap_or_else(|| panic!("{fname} not found in mail.rs"));
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

    /// Source-level pin: every mail command that hands back the user's correspondence calls
    /// the gate, and the call **is** the statement (propagated with `?`), not a value dropped
    /// on the floor. Deleting the gate from `mail_list` makes this fail.
    #[test]
    fn every_read_command_propagates_the_foreground_gate() {
        const SRC: &str = include_str!("mail.rs");
        for fname in ["mail_list", "mail_search", "mail_read", "mail_inbox"] {
            let stmt = gate_statement(command_body(SRC, fname), fname);
            assert!(
                stmt.starts_with("require_mail_foreground("),
                "{fname}'s gate must *be* the statement, not a value handed to something else \
                 (a discarded `Result` denies nothing): got `{stmt}`"
            );
            assert!(
                stmt.ends_with(")?"),
                "{fname} must propagate the gate's refusal with `?`: got `{stmt}`"
            );
        }
        // The contrast that makes it meaningful. `mail_mailboxes` answers the *shape* of the
        // mailbox (the provider's own `INBOX` / `Sent` / …), not the user's correspondence —
        // the same boundary the SMS reads draw around `sms_trash_list` ("ids + times only — no
        // content"). The capability probe `mail_status` is deliberately *not* gated either: it
        // answers what the backend can do, not one byte of the correspondence (F-SH-824). The
        // write verbs are deliberately *not* gated either: sending a message
        // from a background window is not a disclosure of the user's mail, which is the attack
        // this rule is about. Gating them would be a different decision (an action rule).
        for fname in [
            "mail_mailboxes",
            "mail_status",
            "mail_send",
            "mail_delete",
            "mail_move",
        ] {
            assert!(
                !command_body(SRC, fname).contains("require_mail_foreground("),
                "{fname} must not carry the *read* gate — the rule here is about disclosure"
            );
        }
    }
}
