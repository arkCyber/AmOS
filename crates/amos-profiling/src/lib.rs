//! `amos-profiling` — inference performance & power-profiling domain core.
//!
//! The roadmap flags *Performance profiling and optimization* as not yet started;
//! running a local on-device LLM is a real drain on battery and thermals, so a
//! model team needs honest, deterministic numbers. Mirroring the rest of AmOS,
//! this is a pure domain core with a provider seam — the real `PowerSource`
//! (Android battery/power HAL), the metric *export* (monitoring / status / wire)
//! and the profiling harness around `amos-ai`'s actual engine are left as later
//! seams (see `docs/profiling.md`).
//!
//! Two knobs drive on-device UX:
//!
//! * **Prompt eval (prefill)** — process the whole prompt once. Its wall time is
//!   the dominant part of time-to-first-token; throughput is prompt tokens/s.
//! * **Decode** — generate tokens one at a time. Decode tokens/s and the inverse
//!   (ms per token) are what a user feels as streaming speed.
//!
//! ```text
//! [ model call ] ── time()/Instant ─▶ Phase + tokens + wall
//!        │                                 │
//!        ▼                                 ▼
//! [ PowerSource seam ]           [ ProfileTracker ]  (pure sums, guarded ÷)
//!   Mock today · Android                │
//!   power HAL later                     ▼
//!                              [ ProfileReport ] ──▶ logs / monitoring / wire
//! ```
//!
//! Crate layout:
//!
//! * [`types`] — [`Phase`] (PromptEval / Decode) and [`Record`].
//! * [`tracker`] — [`ProfileTracker`]: lossless sums + tokens/s, ms-per-token,
//!   TTFT and merge. Division-by-zero guarded (empty → `None`, never `NaN`).
//! * [`power`] — the [`PowerSource`] seam + deterministic [`MockPowerSource`]
//!   + `power × time` energy math.
//! * [`measure`] — [`time`]/[`time_and`] helpers that wrap a model call in an
//!   `Instant` and return the wall `Duration` to record.
//! * [`report`] — an owned, displayable [`ProfileReport`] snapshot.
//!
//! The domain core is pure `std` on the host (no tokio / FFI), so the default
//! workspace build stays light and green. An optional real Android power backend
//! ([`android`]) is feature-gated `android` + `jni`, for on-device System UI builds.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod measure;
pub mod power;
pub mod report;
pub mod tracker;
pub mod types;

#[cfg(feature = "android")]
pub mod android;

pub use measure::{time, time_and};
pub use power::{energy_joules, MockPowerSource, PowerSource};
pub use report::{fmt_opt, ProfileReport};
pub use tracker::{safe_div, ProfileTracker};
pub use types::{Phase, Record};

#[cfg(feature = "android")]
pub use android::AndroidBatteryPowerSource;
