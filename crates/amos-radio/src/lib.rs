//! `amos-radio` — radio / connectivity domain core.
//!
//! Transport- and platform-agnostic rules and seams for the radios AmOS exposes
//! as quick-settings toggles (Wi-Fi, Bluetooth, Airplane mode), so the business
//! logic is testable offline and a real device backend can be swapped in later.
//! Mirrors the shape of `amos-telephony` (domain kernel + provider seam + Mock).
//!
//! Three pieces:
//!
//! * [`state`] — [`RadioMode`] (which radios exist) and [`RadioSnapshot`]
//!   (point-in-time on/off state).
//! * [`provider`] — the single external seam: [`RadioProvider`] is a *dumb*
//!   register over the real radios (get / set each bit); [`MockRadioProvider`] is
//!   the deterministic in-memory impl for tests and offline demos.
//! * [`manager`] — [`RadioManager`] wraps a provider and owns the **policy** the
//!   UI depends on: enabling Airplane mode cascades Wi-Fi + Bluetooth off, and
//!   the non-airplane radios cannot be switched on while Airplane is active.
//!
//! The real Android backend (Android `ConnectivityManager` for Wi-Fi and
//! `BluetoothManager` for Bluetooth, reached from the System UI APK via JNI /
//! binder) will live under the `android` feature (see `docs/radio.md`). Today the
//! System UI drives [`MockRadioProvider`] seeded from the durable settings store.

// P0-1 gate: production code must not panic on programmer error. Test code is
// exempt (assertions/unwrap are idiomatic there).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod error;
pub mod manager;
pub mod provider;
pub mod state;

#[cfg(feature = "android")]
pub mod android;

pub use error::{RadioError, Result};
pub use manager::RadioManager;
pub use provider::{MockRadioProvider, RadioProvider};
pub use state::{RadioMode, RadioSnapshot};

#[cfg(feature = "android")]
pub use android::AndroidRadioProvider;
