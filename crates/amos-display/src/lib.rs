//! `amos-display` — display-protection / auto screen-off domain core.
//!
//! A phone does not need a desktop "screensaver"; what it needs is a small,
//! honest rule: *after the user stops interacting, turn the display off* (which
//! the host then renders as sleep + lock, and the daemon energy beat sees as
//! `screen_on = false` → it can freeze background apps / defer work).
//!
//! This crate is the transport- and platform-agnostic kernel for that decision:
//!
//! ```text
//!   host interaction ─▶ touch(now)          host wakes ─▶ wake(now)
//!         │                                              ▲
//!         ▼                                              │
//!   [ ScreenController ]  state: ScreenState{On,Off}     │  (user acts again)
//!         │                                              │
//!         └─ probe(now, charging, hold_screen) ── TurnOff after idle timeout
//! ```
//!
//! * Pure `std`, no wall clock — the caller passes `now` in **seconds** since the
//!   host's idle clock started, so the whole controller is fully offline-testable.
//! * Idle timeouts are separate for battery vs charging (phones keep the screen
//!   alive longer on a charger), and a "hold the screen" input (an active call /
//!   foreground-heavy task) disables auto-off entirely.
//!
//! The crate also owns the **screen-state file contract** ([`host`]) shared by
//! the daemon energy beat (`amos-ai::energy::telemetry_from_env`, which makes
//! `screen_on` reflect a real *off* instead of an env default) and the System UI
//! host (`amos-tauri::display`, which writes the file when the shell goes idle).
//!
//! Design: `docs/display-idle.md`.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod host;
pub mod idle;
pub mod spec;

pub use host::{parse_screen_state, read_screen_state_from, screen_state_path, SCREEN_STATE_ENV};
pub use idle::{IdlePolicy, ScreenController};
pub use spec::{ScreenChange, ScreenState};
