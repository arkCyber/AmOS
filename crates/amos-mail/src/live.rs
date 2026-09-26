//! Real network backends, gated behind the `live` feature.
//!
//! This is where the deterministic in-memory mock is replaced by actual mail
//! protocols: **SMTP sending** (via `lettre`) and **IMAP reading** (mailboxes,
//! summaries, bodies, flags) over raw IMAP. [`ImapSmtpProvider`] is the live
//! [`crate::MailProvider`] that pairs the two, so one provider — reached through
//! the same seam every caller already uses — both reads the mailbox and delivers
//! a draft.
//!
//! The crate's default (no features) build stays fully offline; compile these
//! with `cargo build -p amos-mail --features live`.

pub mod imap;
pub mod imap_provider;
pub mod live_provider;
pub mod smtp;

pub use imap::{
    count_unseen, delete_message, fetch_inbox_summaries, fetch_message_body, list_mailboxes,
    move_message, store_answered, store_flagged, store_seen, ImapConfig,
};
pub use imap_provider::LiveImapProvider;
pub use live_provider::ImapSmtpProvider;
pub use smtp::{send, SmtpConfig};
