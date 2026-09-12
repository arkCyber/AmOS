//! AmOS spam blocking — numbers blocked for **calls** and/or **SMS**.
//!
//! Pure, deterministic domain logic (no I/O, no platform calls) so the rules can
//! be unit-tested on the host and reused by:
//!
//! * the SMS path — blocked senders are filtered out of the inbox view and never
//!   raise a notification (an honest AmOS-level block: the system store is owned
//!   by the default SMS app, so we cannot delete rows the platform wrote),
//! * the call path — the Android `CallScreeningService` asks this crate (over
//!   JNI) whether to reject an incoming call.
//!
//! Matching rules (deliberately simple + documented, never fuzzy):
//!
//! * Addresses and patterns are normalized to digits with an optional leading
//!   `+`; comparison uses the **digit string only** (so `+86 138-0013-8000`,
//!   `+8613800138000` and `8613800138000` are the same number).
//! * [`MatchKind::Exact`] compares the whole digit string.
//! * [`MatchKind::Prefix`] compares a leading digit run (at least
//!   [`MIN_PREFIX_DIGITS`], so a 1–2 digit rule cannot silently block swathes of
//!   numbers).
//! * An unparseable/withheld address is blocked only when
//!   [`Blocklist::block_unknown`] is on.
//!
//! The rule list is **bounded** ([`DEFAULT_CAP`]): adding past the cap evicts the
//! oldest rule (documented, deterministic) rather than growing without limit.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

mod error;
mod list;
mod rule;

pub use error::BlocklistError;
pub use list::Blocklist;
pub use rule::{BlockReason, Channel, MatchKind, Rule, DEFAULT_CAP, MIN_PREFIX_DIGITS};
