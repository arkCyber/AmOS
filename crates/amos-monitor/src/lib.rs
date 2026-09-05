//! `amos-monitor` — the AmOS **system working-status (health) domain core**.
//!
//! Mirrors the rest of AmOS: a transport-/platform-agnostic **domain core** with
//! provider seams and deterministic mocks, host-testable with zero device/HAL.
//! It is the unification point that turns scattered producers into one honest
//! [`SystemHealth`] snapshot a Task-Manager / diagnostics / gRPC `SystemStatus`
//! surface can ship:
//!
//! ```text
//!  [ SystemSampler seam ]─┐
//!    Mock · Linux /proc   │
//!    Android (skeleton)   │
//!  [ amos-profiling ]     │   ┌─────────────────────────┐
//!    PowerSource /        ├──▶│  SystemMonitor.health() │──▶ SystemHealth
//!    BatterySample        │   └─────────────────────────┘   (log / wire / UI)
//!  [ amos-applife ]       │
//!    AppLifecycle counts  │
//!    (process_summary)   ─┘
//! ```
//!
//! Crate layout:
//! * [`spec`] — honest `Option`-carrying snapshot types ([`SystemLoad`],
//!   [`CpuSample`], [`MemoryInfo`], [`BatteryStatus`], [`ProcessSummary`],
//!   [`SystemHealth`]).
//! * [`sampler`] — the [`SystemSampler`] seam + deterministic
//!   [`MockSystemSampler`].
//! * [`monitor`] — the [`SystemMonitor`] aggregator folding load + battery +
//!   process counts into a [`SystemHealth`].
//!
//! The energy-governor *decision* (mode / throttle) is a consumer input owned by
//! `amos-power`, folded in at the transport boundary — this core never re-derives
//! policy.
//!
//! Feature gates: `linux` = real `/proc` sampler (`src/linux.rs`),
//! `android` = on-device skeleton (`src/android.rs`). Default build is pure `std`.
//!
//! Design: `docs/system-monitor.md`.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod monitor;
pub mod sampler;
pub mod spec;

#[cfg(feature = "android")]
pub mod android;
#[cfg(feature = "linux")]
pub mod linux;

pub use monitor::{process_summary, process_summary_from_counts, SystemMonitor};
pub use sampler::{MockSystemSampler, SystemSampler};
pub use spec::{BatteryStatus, CpuSample, MemoryInfo, ProcessSummary, SystemHealth, SystemLoad};

#[cfg(feature = "android")]
pub use android::AndroidSystemSampler;
#[cfg(feature = "linux")]
pub use linux::LinuxSystemSampler;
