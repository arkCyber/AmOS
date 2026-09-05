//! `amos-flashlight` — illumination (flashlight / torch) domain core.
//!
//! Transport- and platform-agnostic rules and seams for the torch AmOS exposes
//! as an illumination control, so the business logic is testable offline and a
//! real device backend can be swapped in later. Mirrors the shape of
//! `amos-radio` / `amos-telephony` (domain kernel + provider seam + Mock).
//!
//! Three pieces:
//!
//! * [`state`] — [`FlashlightState`]: point-in-time on/off of the torch plus the
//!   honest hardware fact of whether a usable torch (rear camera with a flash
//!   unit) exists on the device.
//! * [`provider`] — the single external seam: [`FlashlightProvider`] is a *dumb*
//!   register over the real torch (get the snapshot / set on|off);
//!   [`MockFlashlightProvider`] is the deterministic in-memory impl for tests and
//!   offline demos.
//! * [`manager`] — [`FlashlightManager`] wraps a provider and owns the **policy**
//!   the UI depends on: the torch cannot be lit on a device that reports no torch
//!   hardware ([`FlashlightError::NoTorchHardware`]), while turning it off is
//!   always a harmless/idempotent no-op.
//!
//! The real Android backend (Android `CameraManager#setTorchMode` on the rear
//! camera's flash unit, reached from the System UI APK via JNI/binder) lives
//! under the `android` feature (see `docs/flashlight.md`). Today the System UI
//! drives [`MockFlashlightProvider`] seeded from the durable settings store.

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

pub use error::{FlashlightError, Result};
pub use manager::FlashlightManager;
pub use provider::{FlashlightProvider, MockFlashlightProvider};
pub use state::FlashlightState;

#[cfg(feature = "android")]
pub use android::AndroidFlashlightProvider;
