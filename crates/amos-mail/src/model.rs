//! Mail domain models.
//!
//! Transport-agnostic: these types carry no knowledge of IMAP/SMTP wire formats.
//! They are `serde`-serializable so a future Tauri bridge (JSON) and CLI (table)
//! can both render them.

use serde::{Deserialize, Serialize};

use crate::error::{MailError, Result};

/// Well-known mailbox names used by the engine. Real IMAP servers standardize
/// on `INBOX`; `Sent` holds the copies of messages this account sent (mirrors
/// the common IMAP convention of storing outgoing mail in a `Sent` folder).
/// `Archive` / `Trash` are the destinations for the archive & trash actions.
pub const INBOX: &str = "INBOX";
pub const SENT: &str = "Sent";
pub const ARCHIVE: &str = "Archive";
pub const TRASH: &str = "Trash";

/// A display name plus an RFC-ish address, e.g. `"Ada" <ada@example.com>`.
///
/// This is the identity unit used for `From`/`To`/`Cc`/`Bcc`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Address {
    /// Human-readable display name (may be empty).
    pub name: String,
    /// The `local@domain` mail address.
    pub email: String,
}

impl Address {
    /// Build an address, validating the email part.
    pub fn new(name: impl Into<String>, email: impl Into<String>) -> Result<Self> {
        let email = email.into();
        if !valid_email(&email) {
            return Err(MailError::InvalidEmail(email));
        }
        Ok(Self {
            name: name.into(),
            email,
        })
    }

    /// Build a bare address (empty display name).
    pub fn bare(email: impl Into<String>) -> Result<Self> {
        Self::new("", email)
    }

    /// The `local` part before the first `@`, if the address is well formed.
    pub fn local(&self) -> Option<&str> {
        self.email.split_once('@').map(|(l, _)| l)
    }

    /// The domain after the first `@`, if the address is well formed.
    pub fn domain(&self) -> Option<&str> {
        self.email.split_once('@').map(|(_, d)| d)
    }
}

impl std::fmt::Display for Address {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.name.is_empty() {
            write!(f, "{}", self.email)
        } else {
            write!(f, "{} <{}>", self.name, self.email)
        }
    }
}

/// Lightweight email syntax check: exactly one `@`, non-empty local and domain,
/// no ASCII whitespace, and no second `@` hiding in the domain.
fn valid_email(email: &str) -> bool {
    if email.is_empty() || email.bytes().any(|b| b.is_ascii_whitespace()) {
        return false;
    }
    match email.split_once('@') {
        Some((local, domain)) => !local.is_empty() && !domain.is_empty() && !domain.contains('@'),
        None => false,
    }
}

/// Read/flag state carried by a message.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmailFlags {
    /// Read (`\Seen`). A freshly delivered message starts unread.
    pub seen: bool,
    /// Starred / important (`\Flagged`).
    pub flagged: bool,
    /// Replied to (`\Answered`).
    pub answered: bool,
}

/// Lightweight metadata returned by listing a mailbox — no body payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmailSummary {
    /// Provider-local identifier, unique within `mailbox`.
    pub id: String,
    /// The mailbox this message lives in (e.g. `INBOX`).
    pub mailbox: String,
    pub from: Option<Address>,
    pub to: Vec<Address>,
    pub subject: String,
    /// Unix epoch seconds.
    pub date: i64,
    pub flags: EmailFlags,
    /// Number of attachments (bodies are fetched separately).
    pub attachment_count: usize,
}

/// A full message body as returned by `fetch` — summaries plus text payloads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Email {
    pub summary: EmailSummary,
    pub body_plain: String,
    pub body_html: Option<String>,
    /// Attachment metadata; the bytes are retrieved via
    /// [`MailProvider::fetch_attachment`](crate::MailProvider::fetch_attachment).
    pub attachments: Vec<AttachmentMeta>,
}

impl Email {
    /// First `max` characters of the plain-text body, newlines collapsed — a
    /// small helper for list/preview rows in a CLI or UI.
    pub fn preview(&self, max: usize) -> String {
        let flat: String = self
            .body_plain
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if flat.chars().count() <= max {
            flat
        } else {
            let cut: String = flat.chars().take(max).collect();
            format!("{cut}…")
        }
    }
}

/// Descriptor for a file attached to a full [`Email`] (bytes live on the
/// provider; fetched on demand).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentMeta {
    pub id: String,
    pub filename: String,
    pub mime: String,
    /// Size in bytes.
    pub size: u64,
}

/// A file ready to be sent with a [`SendDraft`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub filename: String,
    pub mime: String,
    pub data: Vec<u8>,
}

/// An outgoing message. Defaults to an empty draft so callers can build it
/// incrementally (recipients, subject and body are validated at send time).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendDraft {
    /// Sender; if `None`, [`crate::MailClient`] fills it from the account.
    pub from: Option<Address>,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub subject: String,
    pub body_plain: String,
    pub body_html: Option<String>,
    pub attachments: Vec<Attachment>,
    /// Message id this is a reply to (threading hint, informational today).
    pub in_reply_to: Option<String>,
}

impl SendDraft {
    /// Construct a draft with recipients, subject and body — the minimum a
    /// "compose" screen collects. Rejects drafts with no recipients.
    pub fn new(
        to: Vec<Address>,
        subject: impl Into<String>,
        body: impl Into<String>,
    ) -> Result<Self> {
        if to.is_empty() {
            return Err(MailError::NoRecipient);
        }
        Ok(Self {
            to,
            subject: subject.into(),
            body_plain: body.into(),
            ..Self::default()
        })
    }

    /// Whether any recipient (to/cc/bcc) is present.
    pub fn has_recipients(&self) -> bool {
        !self.to.is_empty() || !self.cc.is_empty() || !self.bcc.is_empty()
    }

    /// All `to + cc` addresses in one view (bcc is intentionally excluded).
    pub fn visible_recipients(&self) -> impl Iterator<Item = &Address> {
        self.to.iter().chain(self.cc.iter())
    }

    /// Chainable builder: add a Cc.
    pub fn cc(mut self, addr: Address) -> Self {
        self.cc.push(addr);
        self
    }

    /// Chainable builder: add a Bcc.
    pub fn bcc(mut self, addr: Address) -> Self {
        self.bcc.push(addr);
        self
    }

    /// Chainable builder: set the sender.
    pub fn from(mut self, addr: Address) -> Self {
        self.from = Some(addr);
        self
    }

    /// Chainable builder: attach a file.
    pub fn attach(mut self, a: Attachment) -> Self {
        self.attachments.push(a);
        self
    }

    /// Chainable builder: add an HTML body alongside the plain-text one.
    pub fn html(mut self, body: impl Into<String>) -> Self {
        self.body_html = Some(body.into());
        self
    }
}

/// Acknowledgment returned by a successful send.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendReceipt {
    /// Provider-local id of the stored copy (in the `Sent` mailbox).
    pub id: String,
    /// Unix epoch seconds when it was sent.
    pub date: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_accepts_valid_forms() {
        let a = Address::new("Ada", "ada@example.com").unwrap();
        assert_eq!(a.local(), Some("ada"));
        assert_eq!(a.domain(), Some("example.com"));
        assert_eq!(a.to_string(), "Ada <ada@example.com>");
        assert_eq!(Address::bare("x@y.io").unwrap().to_string(), "x@y.io");
    }

    #[test]
    fn address_rejects_invalid_forms() {
        for bad in [
            "",
            "no-at-sign",
            "@missing-local",
            "missing-domain@",
            "two@ats@here.io",
            "has space@example.com",
        ] {
            assert!(
                matches!(Address::bare(bad), Err(MailError::InvalidEmail(_))),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn empty_display_name_prints_bare_email() {
        let a = Address::new("", "a@b.io").unwrap();
        assert_eq!(a.to_string(), "a@b.io");
    }

    #[test]
    fn draft_requires_recipients_at_construction() {
        let err = SendDraft::new(vec![], "hi", "body").unwrap_err();
        assert_eq!(err, MailError::NoRecipient);
    }

    #[test]
    fn draft_builders_and_recipient_view() {
        let to = Address::bare("a@x.io").unwrap();
        let cc = Address::bare("b@x.io").unwrap();
        let d = SendDraft::new(vec![to.clone()], "subj", "body")
            .unwrap()
            .cc(cc.clone())
            .from(Address::bare("me@x.io").unwrap())
            .attach(Attachment {
                filename: "f.txt".into(),
                mime: "text/plain".into(),
                data: b"hi".to_vec(),
            });
        assert!(d.has_recipients());
        let vis: Vec<_> = d.visible_recipients().collect();
        assert_eq!(vis, vec![&to, &cc]);
        assert_eq!(d.attachments.len(), 1);
        assert!(d.from.is_some());
    }

    #[test]
    fn preview_collapses_and_truncates() {
        let summary = EmailSummary {
            id: "1".into(),
            mailbox: INBOX.into(),
            from: None,
            to: vec![],
            subject: String::new(),
            date: 0,
            flags: EmailFlags::default(),
            attachment_count: 0,
        };
        let mut e = Email {
            summary,
            body_plain: "line one\n   line two".into(),
            body_html: None,
            attachments: vec![],
        };
        assert_eq!(e.preview(100), "line one line two");
        e.body_plain = "一二三四五六七八九十".into();
        assert_eq!(e.preview(5), "一二三四五…");
    }
}
