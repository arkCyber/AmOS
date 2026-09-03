//! Error type and result alias for the mail engine.

use thiserror::Error;

/// Errors surfaced by the mail core engine / providers.
#[derive(Error, Debug, PartialEq, Eq)]
pub enum MailError {
    #[error("invalid email address: {0}")]
    InvalidEmail(String),

    #[error("draft has no recipients (to/cc/bcc are all empty)")]
    NoRecipient,

    #[error("draft has no sender address")]
    MissingSender,

    #[error("mailbox {mailbox:?} does not exist")]
    UnknownMailbox { mailbox: String },

    #[error("message {id:?} not found in mailbox {mailbox:?}")]
    NotFound { mailbox: String, id: String },

    #[error("attachment {attachment:?} not found on message {id:?}")]
    AttachmentNotFound { id: String, attachment: String },

    #[error("{0}")]
    Provider(String),
}

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, MailError>;
