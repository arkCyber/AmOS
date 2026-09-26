//! `amos-mail` — Amos email client **core engine**.
//!
//! A transport-agnostic crate that encodes the *domain* of an email client
//! (accounts, mailboxes, messages, drafts, flags) in pure Rust, so the **same**
//! engine drives both a headless CLI (`amos-mail-cli`) and the Tauri System UI
//! bridge — exactly the split the rest of Amos uses (see `amos-int` /
//! `amos-tts` / `amos-asr`).
//!
//! # Why this crate exists
//!
//! A real mail client talks to the network over IMAP (read) and SMTP (send).
//! That network code is (a) not something the domain model should care about and
//! (b) not testable headlessly. So, mirroring the repo's provider-seam pattern:
//!
//! ```text
//! [ WebView / CLI ] --> MailClient<P> --> P: MailProvider
//!                                        ├─ MockMailProvider  (deterministic, in-memory)
//!                                        └─ ImapSmtpProvider  (live, feature `live`)
//! ```
//!
//! * [`MailClient`] is the high-level, state-light engine the CLI and UI call:
//!   it carries the default [`Account`], fills the sender on drafts and drives
//!   the provider (list / fetch / send / mark / delete).
//! * [`MailProvider`] is the single seam. The deterministic [`MockMailProvider`]
//!   is the default (emails live in memory, so tests and offline demos work with
//!   zero network); the real IMAP+SMTP backends ship behind the `live` feature
//!   (`live::ImapSmtpProvider`) with no change to callers.
//! * The models in [`model`] are the wire-format that a future JSON bridge /
//!   CLI table printer will serialize (`serde`).
//!
//! The default (featureless) build performs **no I/O** of its own: it only
//! defines types, validation and the provider contract, plus the in-memory mock.
//! The `live` feature adds the real network backends under the `live` module.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod client;
pub mod error;
pub mod model;
pub mod provider;

#[cfg(feature = "live")]
pub mod live;

pub use client::{Account, MailClient};
pub use error::{MailError, Result};
pub use model::{
    Address, Attachment, AttachmentMeta, Email, EmailFlags, EmailSummary, SendDraft, SendReceipt,
    ARCHIVE, INBOX, SENT, TRASH,
};
pub use provider::{MailProvider, MockMailProvider};
