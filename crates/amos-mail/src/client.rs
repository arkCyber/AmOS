//! The high-level [`MailClient`] engine that a CLI or Tauri bridge drives.
//!
//! It wraps any [`MailProvider`] plus the default [`Account`] and exposes
//! convenient, validated operations: listing mailboxes, reading the inbox,
//! fetching a message, and sending (filling the sender from the account).

use crate::error::{MailError, Result};
use crate::model::{
    Address, Email, EmailSummary, SendDraft, SendReceipt, ARCHIVE, INBOX, SENT, TRASH,
};
use crate::MailProvider;

/// The user's identity for this mail account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    /// Provider/account identifier (opaque to the engine).
    pub id: String,
    /// Display name used when composing (e.g. "Ada Lovelace").
    pub display_name: String,
    /// The account's own address, used as the default sender.
    pub email: Address,
}

impl Account {
    /// Build an account. The email address is already validated by its own
    /// constructor; this stays a `Result` so callers share one error channel.
    pub fn new(
        id: impl Into<String>,
        display_name: impl Into<String>,
        email: Address,
    ) -> Result<Self> {
        Ok(Self {
            id: id.into(),
            display_name: display_name.into(),
            email,
        })
    }

    /// The `From` header used when composing from this account: the account's
    /// email, with the display name filled in when the address has none.
    pub fn sender_address(&self) -> Address {
        if self.email.name.is_empty() && !self.display_name.is_empty() {
            let mut a = self.email.clone();
            a.name = self.display_name.clone();
            a
        } else {
            self.email.clone()
        }
    }
}

/// Engine over a [`MailProvider`]. Cheap to clone when `P: Clone`; the provider
/// normally owns its connection/state.
pub struct MailClient<P: MailProvider> {
    provider: P,
    account: Account,
}

impl<P: MailProvider> MailClient<P> {
    /// Wrap a provider with the default account.
    pub fn new(provider: P, account: Account) -> Self {
        Self { provider, account }
    }

    /// Borrow the underlying provider.
    pub fn provider(&self) -> &P {
        &self.provider
    }

    /// The configured account.
    pub fn account(&self) -> &Account {
        &self.account
    }

    /// Backend display name (e.g. `"mock-mail"`).
    pub fn provider_name(&self) -> &'static str {
        self.provider.name()
    }

    /// All selectable mailbox names.
    pub async fn mailboxes(&self) -> Result<Vec<String>> {
        self.provider.list_mailboxes().await
    }

    /// Summaries for the inbox, newest first.
    pub async fn inbox(&self, limit: Option<usize>) -> Result<Vec<EmailSummary>> {
        self.provider.list(INBOX, limit).await
    }

    /// Summaries for the sent folder, newest first.
    pub async fn sent(&self, limit: Option<usize>) -> Result<Vec<EmailSummary>> {
        self.provider.list(SENT, limit).await
    }

    /// Summaries for an arbitrary mailbox, newest first.
    pub async fn list(&self, mailbox: &str, limit: Option<usize>) -> Result<Vec<EmailSummary>> {
        self.provider.list(mailbox, limit).await
    }

    /// Summaries in `mailbox` matching `query`, newest first.
    pub async fn search(
        &self,
        mailbox: &str,
        query: &str,
        limit: Option<usize>,
    ) -> Result<Vec<EmailSummary>> {
        let matched = self.provider.search(mailbox, query).await?;
        Ok(match limit {
            Some(n) => matched.into_iter().take(n).collect(),
            None => matched,
        })
    }

    /// Fetch one full message.
    pub async fn fetch(&self, mailbox: &str, id: &str) -> Result<Email> {
        self.provider.fetch(mailbox, id).await
    }

    /// Convenience: fetch a message and immediately mark it read.
    pub async fn read(&self, mailbox: &str, id: &str) -> Result<Email> {
        let email = self.provider.fetch(mailbox, id).await?;
        if !email.summary.flags.seen {
            self.provider.set_seen(mailbox, id, true).await?;
        }
        Ok(email)
    }

    /// Fetch one attachment's bytes.
    pub async fn fetch_attachment(
        &self,
        mailbox: &str,
        email_id: &str,
        attachment_id: &str,
    ) -> Result<Vec<u8>> {
        self.provider
            .fetch_attachment(mailbox, email_id, attachment_id)
            .await
    }

    /// Start a draft pre-filled with the account as sender.
    ///
    /// Callers finish it (recipients/subject/body/attachments) and pass it to
    /// [`send`](Self::send). Recipients are validated at send time.
    pub fn compose(&self, subject: impl Into<String>, body: impl Into<String>) -> SendDraft {
        SendDraft {
            from: Some(self.account.sender_address()),
            subject: subject.into(),
            body_plain: body.into(),
            ..SendDraft::default()
        }
    }

    /// Send a draft. Fills the sender from the account when absent and verifies
    /// there is at least one recipient before handing off to the provider.
    pub async fn send(&self, mut draft: SendDraft) -> Result<SendReceipt> {
        if draft.from.is_none() {
            draft.from = Some(self.account.sender_address());
        }
        if !draft.has_recipients() {
            return Err(MailError::NoRecipient);
        }
        self.provider.send(draft).await
    }

    /// Toggle a message's read/unread flag.
    pub async fn set_seen(&self, mailbox: &str, id: &str, seen: bool) -> Result<()> {
        self.provider.set_seen(mailbox, id, seen).await
    }

    /// Mark every unread message in `mailbox` as read. Returns how many changed.
    pub async fn mark_all_seen(&self, mailbox: &str) -> Result<usize> {
        let msgs = self.provider.list(mailbox, None).await?;
        let mut changed = 0;
        for m in msgs {
            if !m.flags.seen {
                self.provider.set_seen(mailbox, &m.id, true).await?;
                changed += 1;
            }
        }
        Ok(changed)
    }

    /// Toggle a message's starred flag.
    pub async fn set_flagged(&self, mailbox: &str, id: &str, flagged: bool) -> Result<()> {
        self.provider.set_flagged(mailbox, id, flagged).await
    }

    /// Delete a message from a mailbox (permanent removal from that mailbox).
    pub async fn delete(&self, mailbox: &str, id: &str) -> Result<()> {
        self.provider.delete(mailbox, id).await
    }

    /// Move a message into `target` (archive / trash / any other mailbox).
    pub async fn move_to(&self, mailbox: &str, id: &str, target: &str) -> Result<()> {
        self.provider.move_to(mailbox, id, target).await
    }

    /// Archive a message (move it into the `Archive` mailbox).
    pub async fn archive(&self, mailbox: &str, id: &str) -> Result<()> {
        self.move_to(mailbox, id, ARCHIVE).await
    }

    /// Trash a message (move it into the `Trash` mailbox).
    pub async fn trash(&self, mailbox: &str, id: &str) -> Result<()> {
        self.move_to(mailbox, id, TRASH).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::EmailFlags;
    use crate::MockMailProvider;

    fn account() -> Account {
        Account {
            id: "me".into(),
            display_name: "Me".into(),
            email: Address::bare("me@x.io").unwrap(),
        }
    }

    fn addr(email: &str) -> Address {
        Address::bare(email).unwrap()
    }

    #[tokio::test]
    async fn compose_and_send_fills_sender_and_lands_in_sent() {
        let provider = MockMailProvider::new();
        let client = MailClient::new(provider.clone(), account());
        assert_eq!(client.provider_name(), "mock-mail");

        let mut draft = client.compose("Hello", "world");
        draft.to.push(addr("them@x.io"));
        let receipt = client.send(draft).await.unwrap();

        let sent = client.sent(None).await.unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].id, receipt.id);
        let full = client.fetch(SENT, &receipt.id).await.unwrap();
        // Sender auto-filled from the account (name from display_name).
        assert_eq!(
            full.summary.from.as_ref().unwrap().to_string(),
            "Me <me@x.io>"
        );
    }

    #[tokio::test]
    async fn inbox_and_read_flow_marks_seen() {
        let provider = MockMailProvider::new();
        provider
            .deliver(
                Some(addr("ada@x.io")),
                vec![addr("me@x.io")],
                "Re: review",
                "please look",
                42,
            )
            .unwrap();
        let client = MailClient::new(provider.clone(), account());

        let inbox = client.inbox(None).await.unwrap();
        assert_eq!(inbox.len(), 1);
        let id = inbox[0].id.clone();
        assert!(!inbox[0].flags.seen);

        let opened = client.read(INBOX, &id).await.unwrap();
        assert_eq!(opened.body_plain, "please look");
        let flags: EmailFlags = client.fetch(INBOX, &id).await.unwrap().summary.flags;
        assert!(flags.seen, "read() marks the message seen");
    }

    #[tokio::test]
    async fn send_without_recipients_is_rejected() {
        let provider = MockMailProvider::new();
        let client = MailClient::new(provider.clone(), account());
        let draft = client.compose("no one", "goes nowhere");
        let err = client.send(draft).await.unwrap_err();
        assert_eq!(err, MailError::NoRecipient);
    }

    #[tokio::test]
    async fn mailboxes_expose_inbox_and_sent() {
        let provider = MockMailProvider::new();
        let client = MailClient::new(provider.clone(), account());
        let boxes = client.mailboxes().await.unwrap();
        assert_eq!(boxes, vec![INBOX.to_string(), SENT.to_string()]);
    }

    #[tokio::test]
    async fn archive_and_trash_move_messages_out_of_inbox() {
        let provider = MockMailProvider::new();
        let id = provider
            .deliver(
                Some(addr("ada@x.io")),
                vec![addr("me@x.io")],
                "to archive",
                "keep me",
                1,
            )
            .unwrap();
        let client = MailClient::new(provider.clone(), account());

        client.archive(INBOX, &id).await.unwrap();
        assert!(client.inbox(None).await.unwrap().is_empty());
        let arch = client.list("Archive", None).await.unwrap();
        assert_eq!(arch.len(), 1);
        assert_eq!(arch[0].id, id);

        client.trash("Archive", &id).await.unwrap();
        assert!(client.list("Archive", None).await.unwrap().is_empty());
        let trash = client.list("Trash", None).await.unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, id);
    }

    #[tokio::test]
    async fn mark_all_seen_returns_count_and_clears_inbox() {
        let provider = MockMailProvider::new();
        provider
            .deliver(Some(addr("a@x.io")), vec![addr("me@x.io")], "one", "b", 1)
            .unwrap();
        provider
            .deliver(Some(addr("b@x.io")), vec![addr("me@x.io")], "two", "b", 2)
            .unwrap();
        provider
            .deliver(Some(addr("c@x.io")), vec![addr("me@x.io")], "three", "b", 3)
            .unwrap();
        let client = MailClient::new(provider.clone(), account());

        // Mark one seen so only two remain unread.
        let first = client.inbox(None).await.unwrap()[0].id.clone();
        client.set_seen(INBOX, &first, true).await.unwrap();

        let changed = client.mark_all_seen(INBOX).await.unwrap();
        assert_eq!(changed, 2);
        // Everything is now read.
        assert!(
            client
                .inbox(None)
                .await
                .unwrap()
                .iter()
                .all(|m| m.flags.seen),
            "all messages should be read after mark_all_seen"
        );
        // A second pass changes nothing.
        assert_eq!(client.mark_all_seen(INBOX).await.unwrap(), 0);
    }
}
