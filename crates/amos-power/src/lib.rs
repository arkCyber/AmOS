//! `amos-power` — the battery/thermal/foreground-aware energy-governor domain core.
//!
//! This closes the audit gap that AmOS has *isolated energy-policy knobs but no
//! closed-loop decision layer* (`docs/bottom-layer-os-audit.md` §2.B / §3.P2 #11):
//! `amos-sensor` can already gate continuous sampling by [`SensorMode`] and
//! `amos-profiling` can measure live board power, but nothing folds battery
//! state-of-charge, charger state, die temperature, live power **and** whether the
//! heavy consumer is in the foreground into *one* recommended energy mode.
//!
//! Mirroring the rest of AmOS this is a **pure `std` decision core** with a
//! deterministic rule engine — the periodic ticker (a tokio task in the daemon /
//! System UI) and the real power HAL remain caller-side seams. The input side is
//! data ([`Telemetry`]) rather than a trait so the whole policy is a *pure function
//! of a snapshot*, hence trivially testable and free of wall-clock flapping.
//!
//! ```text
//!   battery level / charger / temperature        live board power (PowerSource)
//!          │                                              │
//!          └──────────────┬───────────────────────────────┘
//!                         ▼
//!          ┌──────────────────────────┐
//!          │   Telemetry (per tick)   │   + foreground/background usage
//!          └────────────┬─────────────┘
//!                       ▼
//!          ┌──────────────────────────┐
//!          │  policy::decide(policy,  │   pure, deterministic, hysteresis-aware
//!          │           telemetry)     │
//!          └────────────┬─────────────┘
//!                       ▼
//!          Decision { SensorMode, cap_inference, throttle_background, reason }
//!                       │  Decision::apply_to(&SensorManager) pushes the mode
//!                       ▼
//!                  amos-sensor gating
//! ```
//!
//! Crate layout:
//!
//! * [`types`] — [`BatteryState`], [`Usage`], [`Telemetry`] (+ a sampler helper
//!   over a [`PowerSource`](amos_profiling::PowerSource)).
//! * [`policy`] — [`Policy`] thresholds, [`Reason`], [`Decision`], and the pure
//!   [`decide`] rule with entry/exit hysteresis (battery low band, thermal).
//! * [`governor`] — [`EnergyGovernor`], a thin stateful ticker that keeps the last
//!   decision and returns a fresh one per poll (what a periodic scheduler drives).
//!
//! The decision core is pure `std` and offline-testable; it depends only on the
//! `amos-sensor`/`amos-profiling` **domain** types, so `cargo test -p amos-power`
//! needs no device, HAL or network.
//!
//! Design: `docs/power-policy.md`.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod governor;
pub mod policy;
pub mod types;

#[cfg(feature = "android")]
pub mod android;

pub use governor::EnergyGovernor;
pub use policy::{decide, Decision, Policy, Reason};
pub use types::{BatteryState, Telemetry, Usage};

#[cfg(feature = "android")]
pub use android::AndroidBatteryTelemetry;
