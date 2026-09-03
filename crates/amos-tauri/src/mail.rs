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

use std::path::{Path, PathBuf};

use amos_mail::{
    Account, Address, Email, EmailSummary, MailClient, MockMailProvider, SendDraft, SendReceipt,
};
use tauri::State;

/// Default demo identity used as the account sender.
const ACCOUNT_EMAIL: &str = "me@amos.local";

/// Managed mail engine state.
pub struct MailBridge {
    client: MailClient<MockMailProvider>,
    /// Optional JSON store path (from `$AMOS_MAIL_STORE`). When `None` the store
    /// is ephemeral and demo mail is seeded on launch.
    store: Option<PathBuf>,
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
    /// a user's real store. If the file is unreadable/corrupt, start empty and
    /// warn — the next successful write rewrites a clean snapshot.
    pub fn from_store(path: &Path) -> Self {
        let provider = match MockMailProvider::open_file(path) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(
                    "mail store {} unreadable: {e}; starting empty",
                    path.display()
                );
                MockMailProvider::new()
            }
        };
        Self {
            client: MailClient::new(provider, demo_account()),
            store: Some(path.to_path_buf()),
        }
    }

    /// Best-effort: write the store to disk when a persistent store is set.
    fn persist_best_effort(&self) {
        if let Some(p) = &self.store {
            if let Err(e) = self.client.provider().save_file(p) {
                tracing::warn!("failed to persist mail store {}: {e}", p.display());
            }
        }
    }
}

impl Default for MailBridge {
    fn default() -> Self {
        Self::new()
    }
}

/// List selectable mailbox names.
#[tauri::command]
pub async fn mail_mailboxes(state: State<'_, MailBridge>) -> Result<Vec<String>, String> {
    state.client.mailboxes().await.map_err(|e| e.to_string())
}

/// List message summaries in `mailbox`, newest first, capped by `limit`.
#[tauri::command]
pub async fn mail_list(
    state: State<'_, MailBridge>,
    mailbox: String,
    limit: Option<usize>,
) -> Result<Vec<EmailSummary>, String> {
    state
        .client
        .list(&mailbox, limit)
        .await
        .map_err(|e| e.to_string())
}

/// Search summaries in `mailbox` (sender/recipient/subject/body), newest first.
#[tauri::command]
pub async fn mail_search(
    state: State<'_, MailBridge>,
    mailbox: String,
    query: String,
) -> Result<Vec<EmailSummary>, String> {
    state
        .client
        .search(&mailbox, &query, None)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch a full message and mark it read.
#[tauri::command]
pub async fn mail_read(
    state: State<'_, MailBridge>,
    mailbox: String,
    id: String,
) -> Result<Email, String> {
    let email = state
        .client
        .read(&mailbox, &id)
        .await
        .map_err(|e| e.to_string())?;
    state.persist_best_effort();
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
    let receipt = state.client.send(draft).await.map_err(|e| e.to_string())?;
    state.persist_best_effort();
    Ok(receipt)
}

/// Convenience: the INBOX summaries the mail app shows on open.
#[tauri::command]
pub async fn mail_inbox(
    state: State<'_, MailBridge>,
    limit: Option<usize>,
) -> Result<Vec<EmailSummary>, String> {
    state.client.inbox(limit).await.map_err(|e| e.to_string())
}

/// Star / unstar a message.
#[tauri::command]
pub async fn mail_set_flagged(
    state: State<'_, MailBridge>,
    mailbox: String,
    id: String,
    flagged: bool,
) -> Result<(), String> {
    state
        .client
        .set_flagged(&mailbox, &id, flagged)
        .await
        .map_err(|e| e.to_string())?;
    state.persist_best_effort();
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
    state
        .client
        .set_seen(&mailbox, &id, seen)
        .await
        .map_err(|e| e.to_string())?;
    state.persist_best_effort();
    Ok(())
}

/// Delete a message from a mailbox.
#[tauri::command]
pub async fn mail_delete(
    state: State<'_, MailBridge>,
    mailbox: String,
    id: String,
) -> Result<(), String> {
    state
        .client
        .delete(&mailbox, &id)
        .await
        .map_err(|e| e.to_string())?;
    state.persist_best_effort();
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
    state
        .client
        .move_to(&mailbox, &id, &target)
        .await
        .map_err(|e| e.to_string())?;
    state.persist_best_effort();
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
        b.persist_best_effort();

        // A fresh bridge over the same path sees the message (cross-restart).
        let again = MailBridge::from_store(&path);
        assert_eq!(again.client.list("Sent", None).await.unwrap().len(), 1);
        assert_eq!(again.client.list("INBOX", None).await.unwrap().len(), 0);

        let _ = std::fs::remove_file(&path);
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
}
