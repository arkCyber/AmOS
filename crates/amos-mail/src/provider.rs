//! The [`MailProvider`] seam and a deterministic in-memory [`MockMailProvider`].
//!
//! Every mail backend — the offline mock today, real IMAP+SMTP tomorrow — goes
//! behind [`MailProvider`]. Callers (CLI / Tauri bridge via [`MailClient`]) only
//! ever talk to this trait, so swapping storage is invisible to them.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::{MailError, Result};
use crate::model::{
    Address, AttachmentMeta, Email, EmailFlags, EmailSummary, SendDraft, SendReceipt, INBOX, SENT,
};

/// A pluggable mail backend: list mailboxes, list/fetch messages (read side,
/// IMAP-shaped) and send drafts (write side, SMTP-shaped).
#[async_trait]
pub trait MailProvider: Send + Sync {
    /// Backend display name, e.g. `"mock-mail"` or, later, `"imap+imap.gmail.com"`.
    fn name(&self) -> &'static str;

    /// List all mailbox names the account can select (e.g. `INBOX`, `Sent`).
    async fn list_mailboxes(&self) -> Result<Vec<String>>;

    /// Return message summaries in `mailbox`, newest first, capped by `limit`
    /// (all when `None`). Bodies are not included — fetch them with [`Self::fetch`].
    async fn list(&self, mailbox: &str, limit: Option<usize>) -> Result<Vec<EmailSummary>>;

    /// Return summaries in `mailbox` whose sender/recipients/subject/body match
    /// `query` (case-insensitive substring), newest first.
    async fn search(&self, mailbox: &str, query: &str) -> Result<Vec<EmailSummary>>;

    /// Fetch one full message (bodies + attachment metadata).
    async fn fetch(&self, mailbox: &str, id: &str) -> Result<Email>;

    /// Fetch the bytes of one attachment of a stored message.
    async fn fetch_attachment(
        &self,
        mailbox: &str,
        email_id: &str,
        attachment_id: &str,
    ) -> Result<Vec<u8>>;

    /// Transmit `draft` and return a receipt; the backend stores a copy of the
    /// sent message in its `Sent` mailbox.
    async fn send(&self, draft: SendDraft) -> Result<SendReceipt>;

    /// Mark a message read/unread.
    async fn set_seen(&self, mailbox: &str, id: &str, seen: bool) -> Result<()>;

    /// Star / unstar a message.
    async fn set_flagged(&self, mailbox: &str, id: &str, flagged: bool) -> Result<()>;

    /// Remove a message from `mailbox`.
    async fn delete(&self, mailbox: &str, id: &str) -> Result<()>;

    /// Move a message from `mailbox` into `target` (creating `target` if needed),
    /// e.g. archive / trash. Source and target equal is a no-op.
    async fn move_to(&self, mailbox: &str, id: &str, target: &str) -> Result<()>;
}

// ---------------------------------------------------------------------------
// In-memory store backing the mock
// ---------------------------------------------------------------------------

/// A stored attachment (bytes kept so `fetch_attachment` works headlessly).
#[derive(Clone, Serialize, Deserialize)]
struct StoredAttachment {
    id: String,
    filename: String,
    mime: String,
    data: Vec<u8>,
}

impl StoredAttachment {
    fn meta(&self) -> AttachmentMeta {
        AttachmentMeta {
            id: self.id.clone(),
            filename: self.filename.clone(),
            mime: self.mime.clone(),
            size: self.data.len() as u64,
        }
    }
}

/// A stored message.
#[derive(Clone, Serialize, Deserialize)]
struct StoredMessage {
    /// Monotonic insertion order (tie-breaker when sorting by date).
    seq: u64,
    id: String,
    mailbox: String,
    from: Option<Address>,
    to: Vec<Address>,
    subject: String,
    date: i64,
    seen: bool,
    flagged: bool,
    answered: bool,
    body_plain: String,
    body_html: Option<String>,
    attachments: Vec<StoredAttachment>,
}

impl StoredMessage {
    fn summary(&self) -> EmailSummary {
        EmailSummary {
            id: self.id.clone(),
            mailbox: self.mailbox.clone(),
            from: self.from.clone(),
            to: self.to.clone(),
            subject: self.subject.clone(),
            date: self.date,
            flags: EmailFlags {
                seen: self.seen,
                flagged: self.flagged,
                answered: self.answered,
            },
            attachment_count: self.attachments.len(),
        }
    }

    fn full(&self) -> Email {
        Email {
            summary: self.summary(),
            body_plain: self.body_plain.clone(),
            body_html: self.body_html.clone(),
            attachments: self
                .attachments
                .iter()
                .map(StoredAttachment::meta)
                .collect(),
        }
    }
}

/// Whether `m` matches a (lowercased) search needle across sender, recipients,
/// subject and plain-text body. An empty needle matches everything.
fn message_matches(m: &StoredMessage, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    let mut hay = String::new();
    if let Some(from) = &m.from {
        hay.push_str(&from.to_string());
        hay.push(' ');
    }
    for to in &m.to {
        hay.push_str(&to.to_string());
        hay.push(' ');
    }
    hay.push_str(&m.subject);
    hay.push(' ');
    hay.push_str(&m.body_plain);
    hay.to_lowercase().contains(needle)
}

/// The mock's backing state, shared behind a mutex so the provider is
/// `Send + Sync` while each async call can mutate the same mailbox store.
/// Derives `serde` so a store can be snapshotted to disk (CLI persistence).
#[derive(Default, Serialize, Deserialize)]
struct Store {
    mailboxes: HashMap<String, Vec<StoredMessage>>,
    /// Monotonic counter used to mint globally-unique message ids.
    #[serde(default)]
    next_seq: u64,
}

impl Store {
    fn ensure(&mut self, name: &str) {
        self.mailboxes.entry(name.to_string()).or_default();
    }

    /// Increment the counter and return the newly allocated sequence number.
    fn next_seq(&mut self) -> u64 {
        self.next_seq += 1;
        self.next_seq
    }
}

// ---------------------------------------------------------------------------
// MockMailProvider
// ---------------------------------------------------------------------------

/// Deterministic [`MailProvider`] with all messages in memory.
///
/// Suitable for unit tests and offline demos (a future CLI can run fully
/// offline against it). Behaviour is simple and predictable:
///
/// * `INBOX` and `Sent` exist from birth.
/// * [`list`](Self::list) returns messages newest-first (by `date`, then by
///   insertion order).
/// * [`send`](Self::send) stores a copy of the outgoing message in `Sent`.
/// * Fetching/flagging an unknown id yields a [`MailError::NotFound`].
#[derive(Clone, Default)]
pub struct MockMailProvider {
    store: Arc<Mutex<Store>>,
}

impl MockMailProvider {
    /// An empty provider with the well-known `INBOX` and `Sent` mailboxes.
    pub fn new() -> Self {
        let this = Self::default();
        if let Ok(mut s) = this.store.lock() {
            s.ensure(INBOX);
            s.ensure(SENT);
        }
        this
    }

    /// Open (or create) a persistent store at `path`.
    ///
    /// When `path` exists it is loaded as JSON (must be a store written by
    /// [`save_file`](Self::save_file)); otherwise a fresh empty provider with the
    /// well-known mailboxes is returned. This is what lets a CLI share mail
    /// state across process invocations.
    pub fn open_file(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::new());
        }
        let bytes =
            std::fs::read(path).map_err(|e| MailError::Provider(format!("read {path:?}: {e}")))?;
        let mut store: Store = serde_json::from_slice(&bytes)
            .map_err(|e| MailError::Provider(format!("parse {path:?}: {e}")))?;
        // Repair: a store must always expose the well-known mailboxes.
        store.ensure(INBOX);
        store.ensure(SENT);
        Ok(Self {
            store: Arc::new(Mutex::new(store)),
        })
    }

    /// Persist the current store to `path` as JSON (pretty-printed).
    pub fn save_file(&self, path: &Path) -> Result<()> {
        let store = self
            .store
            .lock()
            .map_err(|_| MailError::Provider("mock store poisoned".into()))?;
        let bytes = serde_json::to_vec_pretty(&*store)
            .map_err(|e| MailError::Provider(format!("serialize: {e}")))?;
        std::fs::write(path, bytes)
            .map_err(|e| MailError::Provider(format!("write {path:?}: {e}")))?;
        Ok(())
    }

    /// Append an *incoming* message to `INBOX` (used by tests / seeding). The
    /// message id is minted automatically and drives ordering by date/sequence.
    pub fn deliver(
        &self,
        from: Option<Address>,
        to: Vec<Address>,
        subject: impl Into<String>,
        body: impl Into<String>,
        date: i64,
    ) -> Result<String> {
        self.insert(INBOX, from, to, subject, body, date, vec![])
    }

    /// Internal insert used by both `deliver` and `send`; returns the new id.
    // Arguments mirror the fields a stored message needs; the seam is internal,
    // so the arity is an acceptable trade-off for a single code path.
    #[allow(clippy::too_many_arguments)]
    fn insert(
        &self,
        mailbox: &str,
        from: Option<Address>,
        to: Vec<Address>,
        subject: impl Into<String>,
        body: impl Into<String>,
        date: i64,
        attachments: Vec<StoredAttachment>,
    ) -> Result<String> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| MailError::Provider("mock store poisoned".into()))?;
        if !store.mailboxes.contains_key(mailbox) {
            return Err(MailError::UnknownMailbox {
                mailbox: mailbox.to_string(),
            });
        }
        let seq = store.next_seq();
        let id = format!("m{seq}");
        let slot = store
            .mailboxes
            .get_mut(mailbox)
            .ok_or_else(|| MailError::UnknownMailbox {
                mailbox: mailbox.to_string(),
            })?;
        slot.push(StoredMessage {
            seq,
            id: id.clone(),
            mailbox: mailbox.to_string(),
            from,
            to,
            subject: subject.into(),
            date,
            seen: false,
            flagged: false,
            answered: false,
            body_plain: body.into(),
            body_html: None,
            attachments,
        });
        Ok(id)
    }

    /// Current unix-epoch seconds (falls back to 0 if the clock is behind the
    /// epoch — never panics).
    fn now_secs() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    /// Find the index of a message in `mailbox` (returns a cloned message list
    /// and the index) or a descriptive error.
    fn index_of(
        store: &Store,
        mailbox: &str,
        id: &str,
    ) -> std::result::Result<(Vec<StoredMessage>, usize), MailError> {
        let msgs = store
            .mailboxes
            .get(mailbox)
            .ok_or_else(|| MailError::UnknownMailbox {
                mailbox: mailbox.to_string(),
            })?;
        let idx = msgs
            .iter()
            .position(|m| m.id == id)
            .ok_or_else(|| MailError::NotFound {
                mailbox: mailbox.to_string(),
                id: id.to_string(),
            })?;
        Ok((msgs.clone(), idx))
    }
}

#[async_trait]
impl MailProvider for MockMailProvider {
    fn name(&self) -> &'static str {
        "mock-mail"
    }

    async fn list_mailboxes(&self) -> Result<Vec<String>> {
        let store = self
            .store
            .lock()
            .map_err(|_| MailError::Provider("mock store poisoned".into()))?;
        let mut names: Vec<String> = store.mailboxes.keys().cloned().collect();
        // Stable, intuitive order: INBOX first, then alphabetical.
        names.sort();
        if names.first().map(String::as_str) == Some(SENT) {
            names.rotate_left(1);
        }
        Ok(names)
    }

    async fn list(&self, mailbox: &str, limit: Option<usize>) -> Result<Vec<EmailSummary>> {
        let store = self
            .store
            .lock()
            .map_err(|_| MailError::Provider("mock store poisoned".into()))?;
        let msgs = store
            .mailboxes
            .get(mailbox)
            .ok_or_else(|| MailError::UnknownMailbox {
                mailbox: mailbox.to_string(),
            })?;
        let mut sorted = msgs.clone();
        // Newest first: higher date wins; same date → later insertion wins.
        sorted.sort_by_key(|m| std::cmp::Reverse((m.date, m.seq)));
        let n = limit.unwrap_or(sorted.len());
        Ok(sorted.into_iter().take(n).map(|m| m.summary()).collect())
    }

    async fn search(&self, mailbox: &str, query: &str) -> Result<Vec<EmailSummary>> {
        let needle = query.to_lowercase();
        let store = self
            .store
            .lock()
            .map_err(|_| MailError::Provider("mock store poisoned".into()))?;
        let msgs = store
            .mailboxes
            .get(mailbox)
            .ok_or_else(|| MailError::UnknownMailbox {
                mailbox: mailbox.to_string(),
            })?;
        let mut matched = msgs
            .iter()
            .filter(|m| message_matches(m, &needle))
            .cloned()
            .collect::<Vec<_>>();
        matched.sort_by_key(|m| std::cmp::Reverse((m.date, m.seq)));
        Ok(matched.into_iter().map(|m| m.summary()).collect())
    }

    async fn fetch(&self, mailbox: &str, id: &str) -> Result<Email> {
        let store = self
            .store
            .lock()
            .map_err(|_| MailError::Provider("mock store poisoned".into()))?;
        let (msgs, idx) = Self::index_of(&store, mailbox, id)?;
        Ok(msgs[idx].full())
    }

    async fn fetch_attachment(
        &self,
        mailbox: &str,
        email_id: &str,
        attachment_id: &str,
    ) -> Result<Vec<u8>> {
        let store = self
            .store
            .lock()
            .map_err(|_| MailError::Provider("mock store poisoned".into()))?;
        let (msgs, idx) = Self::index_of(&store, mailbox, email_id)?;
        msgs[idx]
            .attachments
            .iter()
            .find(|a| a.id == attachment_id)
            .map(|a| a.data.clone())
            .ok_or(MailError::AttachmentNotFound {
                id: email_id.to_string(),
                attachment: attachment_id.to_string(),
            })
    }

    async fn send(&self, draft: SendDraft) -> Result<SendReceipt> {
        if !draft.has_recipients() {
            return Err(MailError::NoRecipient);
        }
        let from = draft.from.clone().ok_or(MailError::MissingSender)?;
        let date = Self::now_secs();
        // Mint attachment ids, unique within this message.
        let attachments = draft
            .attachments
            .iter()
            .enumerate()
            .map(|(i, a)| StoredAttachment {
                id: format!("a{i}"),
                filename: a.filename.clone(),
                mime: a.mime.clone(),
                data: a.data.clone(),
            })
            .collect::<Vec<_>>();
        let id = self.insert(
            SENT,
            Some(from),
            draft.to.clone(),
            draft.subject.clone(),
            draft.body_plain.clone(),
            date,
            attachments,
        )?;
        Ok(SendReceipt { id, date })
    }

    async fn set_seen(&self, mailbox: &str, id: &str, seen: bool) -> Result<()> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| MailError::Provider("mock store poisoned".into()))?;
        let msgs = store
            .mailboxes
            .get_mut(mailbox)
            .ok_or_else(|| MailError::UnknownMailbox {
                mailbox: mailbox.to_string(),
            })?;
        let msg = msgs
            .iter_mut()
            .find(|m| m.id == id)
            .ok_or_else(|| MailError::NotFound {
                mailbox: mailbox.to_string(),
                id: id.to_string(),
            })?;
        msg.seen = seen;
        Ok(())
    }

    async fn set_flagged(&self, mailbox: &str, id: &str, flagged: bool) -> Result<()> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| MailError::Provider("mock store poisoned".into()))?;
        let msgs = store
            .mailboxes
            .get_mut(mailbox)
            .ok_or_else(|| MailError::UnknownMailbox {
                mailbox: mailbox.to_string(),
            })?;
        let msg = msgs
            .iter_mut()
            .find(|m| m.id == id)
            .ok_or_else(|| MailError::NotFound {
                mailbox: mailbox.to_string(),
                id: id.to_string(),
            })?;
        msg.flagged = flagged;
        Ok(())
    }

    async fn delete(&self, mailbox: &str, id: &str) -> Result<()> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| MailError::Provider("mock store poisoned".into()))?;
        let msgs = store
            .mailboxes
            .get_mut(mailbox)
            .ok_or_else(|| MailError::UnknownMailbox {
                mailbox: mailbox.to_string(),
            })?;
        let before = msgs.len();
        msgs.retain(|m| m.id != id);
        if msgs.len() == before {
            return Err(MailError::NotFound {
                mailbox: mailbox.to_string(),
                id: id.to_string(),
            });
        }
        Ok(())
    }

    async fn move_to(&self, mailbox: &str, id: &str, target: &str) -> Result<()> {
        if mailbox == target {
            return Ok(());
        }
        // Single guard: clone the message out, remove it from the source and
        // append to the target, all under one lock (never re-lock a mutex here).
        let mut store = self
            .store
            .lock()
            .map_err(|_| MailError::Provider("mock store poisoned".into()))?;
        let src = store
            .mailboxes
            .get(mailbox)
            .ok_or_else(|| MailError::UnknownMailbox {
                mailbox: mailbox.to_string(),
            })?;
        let idx = src
            .iter()
            .position(|m| m.id == id)
            .ok_or_else(|| MailError::NotFound {
                mailbox: mailbox.to_string(),
                id: id.to_string(),
            })?;
        let mut msg = src[idx].clone();
        msg.mailbox = target.to_string();
        if let Some(slot) = store.mailboxes.get_mut(mailbox) {
            slot.retain(|m| m.id != id);
        }
        store
            .mailboxes
            .entry(target.to_string())
            .or_default()
            .push(msg);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Attachment, INBOX};

    fn addr(email: &str) -> Address {
        Address::bare(email).unwrap()
    }

    /// A provider with three inbox messages: dates 10/20/30 (epoch seconds),
    /// so newest-first is C, B, A.
    fn seeded() -> MockMailProvider {
        let p = MockMailProvider::new();
        p.deliver(
            Some(addr("a@x.io")),
            vec![addr("me@x.io")],
            "oldest",
            "hello A",
            10,
        )
        .unwrap();
        p.deliver(
            Some(addr("b@x.io")),
            vec![addr("me@x.io")],
            "middle",
            "hello B",
            20,
        )
        .unwrap();
        p.deliver(
            Some(addr("c@x.io")),
            vec![addr("me@x.io")],
            "newest",
            "hello C",
            30,
        )
        .unwrap();
        p
    }

    #[tokio::test]
    async fn mailboxes_are_well_known_and_ordered() {
        let p = MockMailProvider::new();
        let boxes = p.list_mailboxes().await.unwrap();
        assert_eq!(boxes, vec![INBOX.to_string(), SENT.to_string()]);
        assert_eq!(p.name(), "mock-mail");
    }

    #[tokio::test]
    async fn list_sorts_newest_first_and_respects_limit() {
        let p = seeded();
        let all = p.list(INBOX, None).await.unwrap();
        let subjects: Vec<_> = all.iter().map(|m| m.subject.as_str()).collect();
        assert_eq!(subjects, vec!["newest", "middle", "oldest"]);

        let limited = p.list(INBOX, Some(2)).await.unwrap();
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].subject, "newest");
        // Newest delivery mints the highest seq; ids are deterministic.
        assert_eq!(all[0].id, "m3");
    }

    #[tokio::test]
    async fn list_unknown_mailbox_errors() {
        let p = MockMailProvider::new();
        let err = p.list("Nope", None).await.unwrap_err();
        assert!(matches!(err, MailError::UnknownMailbox { .. }));
    }

    #[tokio::test]
    async fn fetch_returns_full_message_and_unknown_errors() {
        let p = seeded();
        let first = p.list(INBOX, None).await.unwrap();
        let fetched = p.fetch(INBOX, &first[0].id).await.unwrap();
        assert_eq!(fetched.body_plain, "hello C");
        assert_eq!(fetched.summary.subject, "newest");
        assert!(!fetched.summary.flags.seen);

        let err = p.fetch(INBOX, "does-not-exist").await.unwrap_err();
        assert!(matches!(err, MailError::NotFound { .. }));
    }

    #[tokio::test]
    async fn send_validates_then_lands_in_sent() {
        let p = MockMailProvider::new();
        let draft = SendDraft {
            from: Some(addr("me@x.io")),
            to: vec![addr("them@x.io")],
            subject: "greetings".into(),
            body_plain: "hi".into(),
            ..SendDraft::default()
        };
        let receipt = p.send(draft.clone()).await.unwrap();
        assert_eq!(receipt.id, "m1");
        assert!(receipt.date > 0);

        let sent = p.list(SENT, None).await.unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].subject, "greetings");
        let full = p.fetch(SENT, &receipt.id).await.unwrap();
        assert_eq!(full.body_plain, "hi");
        assert_eq!(full.summary.from.as_ref().unwrap().email, "me@x.io");
    }

    #[tokio::test]
    async fn send_requires_recipients_and_sender() {
        let p = MockMailProvider::new();
        let bare = SendDraft {
            from: Some(addr("me@x.io")),
            to: vec![],
            cc: vec![],
            bcc: vec![],
            ..SendDraft::default()
        };
        assert!(matches!(
            p.send(bare).await.unwrap_err(),
            MailError::NoRecipient
        ));
        let no_sender = SendDraft {
            from: None,
            to: vec![addr("them@x.io")],
            subject: "s".into(),
            body_plain: "b".into(),
            ..SendDraft::default()
        };
        assert!(matches!(
            p.send(no_sender).await.unwrap_err(),
            MailError::MissingSender
        ));
    }

    #[tokio::test]
    async fn seen_and_flagged_toggle_and_persist() {
        let p = seeded();
        let id = p.list(INBOX, None).await.unwrap()[0].id.clone();
        assert!(!p.fetch(INBOX, &id).await.unwrap().summary.flags.seen);
        p.set_seen(INBOX, &id, true).await.unwrap();
        p.set_flagged(INBOX, &id, true).await.unwrap();
        let f = p.fetch(INBOX, &id).await.unwrap().summary.flags;
        assert!(f.seen && f.flagged);
        p.set_seen(INBOX, &id, false).await.unwrap();
        assert!(!p.fetch(INBOX, &id).await.unwrap().summary.flags.seen);
    }

    #[tokio::test]
    async fn delete_removes_and_unknown_errors() {
        let p = seeded();
        let before = p.list(INBOX, None).await.unwrap();
        let victim = before[1].id.clone();
        p.delete(INBOX, &victim).await.unwrap();
        let after = p.list(INBOX, None).await.unwrap();
        assert_eq!(after.len(), before.len() - 1);
        assert!(after.iter().all(|m| m.id != victim));
        assert!(matches!(
            p.delete(INBOX, &victim).await.unwrap_err(),
            MailError::NotFound { .. }
        ));
    }

    #[tokio::test]
    async fn attachments_send_and_fetch_round_trip() {
        let p = MockMailProvider::new();
        let payload = b"the file contents".to_vec();
        let draft = SendDraft::new(vec![addr("them@x.io")], "with file", "see attach")
            .unwrap()
            .from(addr("me@x.io"))
            .attach(Attachment {
                filename: "report.txt".into(),
                mime: "text/plain".into(),
                data: payload.clone(),
            });
        let receipt = p.send(draft).await.unwrap();
        let full = p.fetch(SENT, &receipt.id).await.unwrap();
        assert_eq!(full.attachments.len(), 1);
        let meta = &full.attachments[0];
        assert_eq!(meta.filename, "report.txt");
        assert_eq!(meta.size as usize, payload.len());
        let bytes = p
            .fetch_attachment(SENT, &receipt.id, &meta.id)
            .await
            .unwrap();
        assert_eq!(bytes, payload);
        // Unknown attachment on an existing message errors cleanly.
        assert!(matches!(
            p.fetch_attachment(SENT, &receipt.id, "nope")
                .await
                .unwrap_err(),
            MailError::AttachmentNotFound { .. }
        ));
    }

    #[tokio::test]
    async fn deliver_round_trip_through_inbox() {
        let p = seeded();
        let id = p
            .deliver(
                Some(addr("d@x.io")),
                vec![addr("me@x.io")],
                "just in",
                "fresh",
                99,
            )
            .unwrap();
        let got = p.fetch(INBOX, &id).await.unwrap();
        assert_eq!(got.summary.subject, "just in");
    }

    #[tokio::test]
    async fn save_and_reopen_persists_mailboxes_and_messages() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "amos-mail-persist-{}-{nonce}.json",
            std::process::id()
        ));

        // 1. Fresh provider (path absent) → deliver one → persist.
        let prov = MockMailProvider::open_file(&path).unwrap();
        prov.deliver(
            Some(addr("a@x.io")),
            vec![addr("me@x.io")],
            "persist me",
            "body",
            5,
        )
        .unwrap();
        assert_eq!(
            prov.list_mailboxes().await.unwrap(),
            vec![INBOX.to_string(), SENT.to_string()]
        );
        prov.save_file(&path).unwrap();

        // 2. Reopen a *new* provider from the same file → message survived.
        let loaded = MockMailProvider::open_file(&path).unwrap();
        let inbox = loaded.list(INBOX, None).await.unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].subject, "persist me");

        // 3. Send on the loaded store, persist again, reopen → Sent persisted.
        let draft = SendDraft {
            from: Some(addr("me@x.io")),
            to: vec![addr("them@x.io")],
            subject: "reply".into(),
            body_plain: "hi".into(),
            ..SendDraft::default()
        };
        loaded.send(draft).await.unwrap();
        loaded.save_file(&path).unwrap();

        let again = MockMailProvider::open_file(&path).unwrap();
        assert_eq!(again.list(SENT, None).await.unwrap().len(), 1);
        assert_eq!(again.list(INBOX, None).await.unwrap().len(), 1);

        let _ = std::fs::remove_file(&path);
    }
    #[tokio::test]
    async fn search_matches_fields_case_insensitive_newest_first() {
        let p = seeded(); // subjects oldest/middle/newest, senders a|b|c@x.io, dates 10/20/30

        // Body match.
        let body = p.search(INBOX, "hello B").await.unwrap();
        assert_eq!(body.len(), 1);
        assert_eq!(body[0].subject, "middle");

        // Sender (email) matches every seeded message.
        assert_eq!(p.search(INBOX, "x.io").await.unwrap().len(), 3);

        // Case-insensitive over bodies, newest (date 30) first.
        let all = p.search(INBOX, "HELLO").await.unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].subject, "newest");

        // No match → empty; empty needle → everything.
        assert!(p.search(INBOX, "zzz-not-there").await.unwrap().is_empty());
        assert_eq!(p.search(INBOX, "").await.unwrap().len(), 3);

        // Unknown mailbox is a clean error.
        assert!(matches!(
            p.search("Nope", "x").await.unwrap_err(),
            MailError::UnknownMailbox { .. }
        ));
    }

    #[tokio::test]
    async fn move_to_creates_target_and_removes_from_source() {
        let p = seeded();
        let newest_id = p.list(INBOX, None).await.unwrap()[0].id.clone();

        p.move_to(INBOX, &newest_id, "Archive").await.unwrap();
        let inbox = p.list(INBOX, None).await.unwrap();
        assert_eq!(inbox.len(), 2, "source lost the moved message");
        assert!(inbox.iter().all(|m| m.id != newest_id));

        let archive = p.list("Archive", None).await.unwrap();
        assert_eq!(archive.len(), 1, "target mailbox was created and holds it");
        assert_eq!(archive[0].id, newest_id);
        assert_eq!(archive[0].mailbox, "Archive");
        assert_eq!(archive[0].subject, "newest");

        // mailboxes now include the newly created folder.
        let boxes = p.list_mailboxes().await.unwrap();
        assert!(boxes.iter().any(|b| b == "Archive"), "{boxes:?}");
    }

    #[tokio::test]
    async fn move_to_errors_and_noops() {
        let p = seeded();
        // Missing message in source.
        assert!(matches!(
            p.move_to(INBOX, "nope", "Archive").await.unwrap_err(),
            MailError::NotFound { .. }
        ));
        // Missing source mailbox.
        assert!(matches!(
            p.move_to("Ghost", "m1", "Archive").await.unwrap_err(),
            MailError::UnknownMailbox { .. }
        ));
        // Source == target is a no-op and keeps the message.
        let id = p.list(INBOX, None).await.unwrap()[0].id.clone();
        p.move_to(INBOX, &id, "INBOX").await.unwrap();
        assert_eq!(p.list(INBOX, None).await.unwrap().len(), 3);
    }
}
