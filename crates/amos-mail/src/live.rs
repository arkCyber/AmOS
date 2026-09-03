//! Real network backends, gated behind the `live` feature.
//!
//! This is where the deterministic in-memory mock is replaced by actual mail
//! protocols. Today it ships **SMTP sending** (via `lettre`) and a first slice
//! of **IMAP reading** (unseen count over raw IMAP). Reading more (envelopes,
//! bodies) will build on the same command/response plumbing, all behind the
//! [`crate::MailProvider`] seam.
//!
//! The crate's default (no features) build stays fully offline; compile these
//! with `cargo build -p amos-mail --features live`.

pub mod imap;
pub mod imap_provider;
pub mod smtp;

pub use imap::{
    count_unseen, delete_message, fetch_inbox_summaries, fetch_message_body, list_mailboxes,
    move_message, store_flagged, store_seen, ImapConfig,
};
pub use imap_provider::LiveImapProvider;
pub use smtp::{send, SmtpConfig};
