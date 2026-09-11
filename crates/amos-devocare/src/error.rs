//! Typed errors for the device-care domain.
//!
//! Every failure mode is **named** — an unreadable scan, an over-cap scan, a
//! refused protected path, or a provider that failed to remove one item. The
//! domain never collapses these into a silent `Ok(())`: that is the whole point
//! of a cleaner (see `docs/devcare.md` §5).

use thiserror::Error;

use crate::spec::{MAX_CLEAN_BATCH, MAX_JUNK_ITEMS};

/// Everything that can go wrong while scanning, planning, cleaning or
/// reviewing device care.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DevCareError {
    /// The caller asked for something the policy forbids (empty selection,
    /// review-only kind without acknowledgement). The message is diagnostic
    /// only; the UI owns user-facing wording.
    #[error("invalid request: {0}")]
    InvalidArguments(String),
    /// A scan handed us more entries than the domain will model. We refuse
    /// rather than silently truncate a destructive operation's input.
    #[error("scan returned {found} entries, over the {cap}-entry cap")]
    TooManyItems { found: usize, cap: usize },
    /// A clean plan would exceed the per-batch budget. The caller must split
    /// the work explicitly so no single request is unboundedly destructive.
    #[error("clean batch of {requested} exceeds the {MAX_CLEAN_BATCH}-item budget")]
    BatchTooLarge { requested: usize },
    /// A `uri` was outside the modelled, cleanable set (defence in depth: the
    /// type system already keeps user media out of [`crate::JunkItem`]).
    #[error("refusing to touch {uri}: {reason}")]
    Refused { uri: String, reason: String },
    /// The storage backend failed for one item. Always carries the `uri` so a
    /// partial clean can be reported honestly, item by item.
    #[error("provider failed for {uri}: {message}")]
    Provider { uri: String, message: String },
}

impl DevCareError {
    /// The stable, lowercase machine tag for this error (logs / UI branches).
    pub const fn key(&self) -> &'static str {
        match self {
            DevCareError::InvalidArguments(_) => "invalid_arguments",
            DevCareError::TooManyItems { .. } => "too_many_items",
            DevCareError::BatchTooLarge { .. } => "batch_too_large",
            DevCareError::Refused { .. } => "refused",
            DevCareError::Provider { .. } => "provider",
        }
    }
}

/// Convenience alias matching the rest of the workspace (`amos-media` etc.).
pub type Result<T> = std::result::Result<T, DevCareError>;

/// The scan cap, re-exported at the error site so callers can size pagination
/// against the same constant the domain enforces.
pub const SCAN_ITEM_CAP: usize = MAX_JUNK_ITEMS;
