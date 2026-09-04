//! `amos-applife` — the app/process lifecycle domain core.
//!
//! AmOS front-end "apps" currently share one WebView process, so it has no
//! per-app lifecycle model to speak of (`docs/bottom-layer-os-audit.md` §3.P2 #8:
//! "App 进程模型 + 前台/后台 + 墓碑状态机" — the audit's biggest remaining blank
//! alongside wakeup/Doze). This crate is the transport- and platform-agnostic
//! **domain core** for that model, mirroring how `amos-wm`/`amos-sensor` ship a
//! pure state machine the runtime (System UI / a real per-app process host) later
//! drives.
//!
//! ```text
//!            launch              user leaves            pressure          reclaim
//!   Stopped ────────▶ Foreground ───────▶ Background ───────▶ Cached ────────▶ Stopped
//!     ▲                                    │  ▲ (wake)           │
//!     └──────────── resume ────────────────┘  └── Tombstone ─────┘
//! ```
//!
//! Key ideas:
//! * **States** [`AppState`] express importance + whether the process may run
//!   work: `Foreground` / `Visible` / `ForegroundService` are never reclaimed;
//!   `Background` may be frozen; `Cached` is the "tombstone" (process alive but
//!   frozen, state saved) that memory/energy pressure reclaims first. `Stopped`
//!   is a dead process that kept its saved state.
//! * **LRU ordering**: every transition bumps a monotonic sequence, so the
//!   reclaim selector can evict the *least-recently-used* process within the
//!   lowest reclaimable tier — a faithful, deterministic `lmkd`-style policy.
//! * **Pure `std`**: no I/O, no wall clock, fully offline-testable. The runtime
//!   (per-app process host / LMK pressure feed) stays a caller-side seam.
//!
//! Design: `docs/app-lifecycle.md`.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod error;
pub mod manager;
pub mod spec;

pub use error::{LifecycleError, Result};
pub use manager::{AppLifecycle, ProcessRecord};
pub use spec::{AppId, AppState};
