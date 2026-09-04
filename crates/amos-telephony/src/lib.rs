//! `amos-telephony` — telephony domain core.
//!
//! Transport-agnostic rules and seams for phone calls, so the business logic is
//! testable offline and a real device backend can be swapped in later. Three
//! pieces:
//!
//! * [`number`] — [`Number`] validation + [`EmergencyMap`]/[`NumberKind`]
//!   classification (the legal 110/112 hard-path basis).
//! * [`session`] — [`CallId`]/[`Call`] and the per-call [`CallSession`] state
//!   machine (Dialing/Ringing/Active/Ended) with a whitelisted transition set.
//! * [`provider`] — the single external seam: [`TelephonyProvider`] (dial /
//!   answer / end / status) and a *separate* [`EmergencyTelephonyProvider`]
//!   (emergency must never share the ordinary dial path), plus a deterministic
//!   [`MockTelephonyProvider`].
//!
//! The design & contract live in `docs/telephony.md`; this crate implements its
//! P0 (domain kernel). The gRPC service, Binder/Android backend and the UI
//! bridge are later stages and are intentionally absent here.

// P0-1 gate: production code must not panic on programmer error. Test code is
// exempt (assertions/unwrap are idiomatic there).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod error;
pub mod number;
pub mod provider;
pub mod session;

pub use error::{Result, TelephonyError};
pub use number::{EmergencyMap, Number, NumberKind};
pub use provider::{
    EmergencyTelephonyProvider, MockTelephonyProvider, ProviderEvent, TelephonyProvider,
};
pub use session::{Call, CallDirection, CallId, CallSession, CallState, EndReason, RecordingState};

// The gRPC `TelephonyService` (see docs/telephony.md §6) exposed over the shared
// UDS. Backed by the domain core + Mock for P1; a real Android backend replaces
// the providers in P3 (feature `android`).
pub mod service;

// The Android/Binder backend will live here under `#[cfg(feature = "android")]`
// (see docs/telephony.md §10 P3). Not yet present.
