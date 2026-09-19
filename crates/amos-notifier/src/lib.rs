//! `amos-notifier` — alert dispatcher for the AmOS monitoring pipeline.
//!
//! Five modules, each re-exported here so a consumer can `use
//! amos_notifier::Dispatcher` (short path) **or** `use
//! amos_notifier::dispatcher::Dispatcher` (full path):
//!
//! * [`alert`] — the [`Alert`] value type + [`Severity`] (P0/P1/P2).
//! * [`channel`] — the [`Channel`] trait that every transport implements.
//! * [`dispatcher`] — the [`Dispatcher`] that fans alerts out, enforces
//!   suppression windows, applies per-channel rate limits, and merges
//!   duplicates.
//! * [`throttle`] — token-bucket rate limiter + suppression-window state
//!   machine.
//! * [`metrics`] — per-channel counters (`sent` / `dropped` / `failed`).
//! * [`webhook`], [`smtp`], [`stdout`] — concrete transports.
//!
//! Honesty rules — same as the rest of the workspace:
//!
//! * A transport that fails **never** panics. It records a `failed` counter
//!   and lets the next transport try; the daemon stays alive.
//! * Suppression windows merge duplicates into a single counter the
//!   operator can query — never a silent drop.
//! * When no transports are configured (or every transport fails), alerts
//!   still reach the operator through stderr — the system logs are the
//!   fallback the operator can always read.

// P0-1 gate (all three lints, as `scripts/rust-panic-scan.mjs` requires and
// every other crate root in this workspace declares). This crate previously
// declared only the first two, while the comment below claimed the third was
// "locally silenced" — a silencing that existed nowhere, because the lint was
// never enabled (F-DEV-031 family: the prose asserted a fact the build did not
// enforce; REQ-A459).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

// `panic!` is allowed in production code but only in startup-misconfiguration
// paths (e.g. a malformed webhook URL). The rule is:
//   1. Constructor fails loud if the build cannot proceed.
//   2. Per-event send paths must NEVER panic — the dispatcher relies on
//      this contract for its no-shutdown guarantee.
// Rule 2 is enforced by the crate-root `deny(clippy::panic)` above; rule 1 is
// the *only* exception, and each such site carries a local, reasoned
// `#[allow(clippy::panic)]` so the exception is visible where it is taken
// (see `WebhookChannel::new`).

pub mod alert;
pub mod channel;
pub mod dispatcher;
pub mod metrics;
pub mod smtp;
pub mod stdout;
pub mod throttle;
pub mod webhook;

pub use alert::{Alert, Severity};
pub use channel::{Channel, ChannelId};
pub use dispatcher::{Dispatcher, DispatcherBuilder};
pub use metrics::{ChannelMetrics, DispatchMetrics};
pub use smtp::SmtpChannel;
pub use stdout::StdoutChannel;
pub use webhook::WebhookChannel;
