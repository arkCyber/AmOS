//! `amos-timesync` — network time calibration for the Amos OS layer.
//!
//! Amos needs an authoritative, calibrated wall clock. Following the repo's
//! provider-seam pattern, this crate keeps the *time model* pure and offline-green,
//! and pushes any real network backend behind a trait + feature gate:
//!
//! ```text
//! [ timekeeper (periodic loop) ] --> SyncedClock --> TimeSource
//!                                                    ├─ HostClock          (offline; reads host wall clock)
//!                                                    ├─ MockTimeSource     (deterministic, for tests)
//!                                                    └─ NtpTimeSource      (feature `ntp`, real SNTP query)
//! ```
//!
//! * [`time_source`] — the [`TimeSource`] seam plus a deterministic
//!   [`MockTimeSource`] and an offline [`HostClock`].
//! * [`clock`] — [`SyncedClock`]: turns an absolute network time into an *offset*
//!   applied to the monotonic host clock, persists the last-known-good offset so a
//!   reboot with no network still gets a rough start, and rejects implausible
//!   remote times.
//! * [`timekeeper`] — [`Timekeeper`]: a periodic loop that repeatedly pulls from a
//!   [`TimeSource`] into a shared [`SyncedClock`] until told to stop (spawned by a
//!   supervisor / daemon orchestrator).
//! * `ntp` (behind the `ntp` feature) — the real SNTP-backed `NtpTimeSource`.

// P0-1 gate: production code must not panic on programmer error. Test code is
// exempt (assertions/unwrap are idiomatic there).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod clock;
pub mod error;
pub mod time_source;
pub mod timekeeper;

#[cfg(feature = "ntp")]
pub mod ntp;

pub use clock::SyncedClock;
pub use error::{Error, Result};
pub use time_source::{HostClock, MockTimeSource, TimeSource};
pub use timekeeper::{spawn_timekeeper, Timekeeper};

#[cfg(feature = "ntp")]
pub use ntp::NtpTimeSource;
