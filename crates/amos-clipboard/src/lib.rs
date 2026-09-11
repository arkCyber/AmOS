//! AmOS clipboard domain core — shared by the **host System UI** and the
//! **guest Android container** (Waydroid / no-UI base). See
//! `docs/clipboard-container-sync.md` for the two-topology decision.
//!
//! This crate owns the **single source of truth** for the host↔guest clipboard
//! sync contract so the two sides cannot drift apart byte-for-byte:
//!
//! * [`proto`] — the wire protocol: framed JSON messages ([`proto::HostToGuest`]
//!   / [`proto::GuestToHost`]), a length-prefixed streaming [`proto::FrameDecoder`],
//!   and an [`proto::EchoGuard`] that keeps each side from re-ingesting the copy it
//!   just pushed to the other side (the copy-loop guard).
//! * [`provider`] — the [`provider::ClipboardProvider`] seam the guest agent uses
//!   to reach the Android `ClipboardManager`: a deterministic [`provider::MockClipboardProvider`]
//!   (headless-testable) and, behind `--features android`, an
//!   [`android`] `AndroidClipboardProvider` (compile-checked; device at runtime).
//! * [`agent`] — the headless-testable [`agent::GuestClipboardAgent`] that lives
//!   *inside* the container: applies inbound `PushText` to the provider and reports
//!   genuine container copies back as `ClipboardChanged`.
//!
//! The host transport (`crates/amos-tauri/src/clipboard_guest.rs`) re-exports
//! [`proto`] from here so host and guest compile against one protocol definition.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod agent;
pub mod link;
pub mod proto;
pub mod provider;
/// Real host↔guest byte channel over a Unix domain socket (P2b). `unix` only —
/// the container topologies this crate targets are all Unix.
#[cfg(unix)]
pub mod unix;

#[cfg(feature = "android")]
pub mod android;
