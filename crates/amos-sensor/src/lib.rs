//! `amos-sensor` — the device-sensor domain core of AmOS.
//!
//! Bridges the gap the audit flags as the missing mobile-hardware surface (next
//! to `amos-audio` and Telephony): real **camera**, **GPS/GNSS** and **IMU**
//! (accelerometer + gyroscope) service abstractions. Following the established
//! AmOS convention this crate is a pure, transport- and platform-agnostic domain
//! core — the standard *service bus* (gRPC over UDS mounted in the daemon) and
//! the real Android HAL wiring are deliberately left as seams for later rounds
//! (see `docs/sensors.md`).
//!
//! ```text
//!            [ apps / System UI ] ── high-level API
//!                    │
//!          ┌─────────▼───────────┐
//!          │  SensorManager      │  policy (PowerSave/energy budget) + typed reads
//!          │  (Arc<dyn Provider>)│
//!          └─────────┬───────────┘
//!                    │ dumb read register (single-shot pull)
//!          ┌─────────▼───────────┐
//!          │  SensorProvider     │  seam:  Mock today · Android Camera2 /
//!          │                     │         Gnss / SensorManager HAL later
//!          └─────────────────────┘
//! ```
//!
//! Crate layout:
//!
//! * [`spec`] — sensor descriptors + sample types: [`SensorKind`], [`SensorMode`],
//!   [`CameraConfig`] / [`CameraFrame`], [`GeoFix`] / [`FixMode`], [`ImuSample`],
//!   and the PowerSave / hardware rate ceilings.
//! * [`error`] — [`SensorError`], the single error type.
//! * [`provider`] — the [`SensorProvider`] seam (a dumb read register) + a
//!   deterministic [`MockSensorProvider`].
//! * [`manager`] — [`SensorManager`], which owns the provider and the energy
//!   policy: single-shot reads always allowed, continuous streams gated by mode.
//! * [`service`] — the gRPC `SensorService` (proto `amos_sensor`) that exposes
//!   the manager over the daemon's shared UDS; [`mock_server`] yields a
//!   ready-to-mount [`SensorServer`] backed by the deterministic mock.
//!
//! The domain core (`spec`/`provider`/`manager`) is pure `std` and offline-testable;
//! the optional [`service`] pulls in tonic on top. This mirrors how `amos-radio`
//! and `amos-telephony` ship a testable core with the real backend held behind a
//! feature seam.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod error;
pub mod manager;
pub mod provider;
pub mod service;
pub mod spec;

#[cfg(feature = "android")]
pub mod android;

pub use error::{Result, SensorError};
pub use manager::SensorManager;
pub use provider::{MockSensorProvider, SensorProvider};
pub use service::{mock_server, server, SensorService};
pub use spec::{
    frame_bytes_len, CameraConfig, CameraFrame, CameraId, FixMode, GeoFix, ImuSample, PixelFormat,
    Resolution, SensorKind, SensorMode, Vec3, CAMERA_SAVE_MAX_FPS, GNSS_SAVE_MAX_HZ,
    IMU_SAVE_MAX_HZ, MAX_FRAME_BYTES,
};

#[cfg(feature = "android")]
pub use android::AndroidSensorProvider;
