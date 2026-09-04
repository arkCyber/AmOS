//! `amos-scheduler` — the background-task scheduler / wakeup-alignment domain core.
//!
//! AmOS has the energy policy (`amos-power`) and the app-lifecycle model
//! (`amos-applife`) but **no place that answers "may this background job run now,
//! and when is the next device wake?"** — the audit's #10/#12 blank
//! (`docs/bottom-layer-os-audit.md` §3.P2). This crate is the transport- and
//! platform-agnostic kernel for that: a register of jobs with an alarm/alignment
//! window, Doze-compliant gating, due-batching (so deferred jobs coalesce into one
//! maintenance window instead of many wakes) and a next-wake answer a caller can
//! hand to a real `AlarmManager`/`JobScheduler`.
//!
//! ```text
//!   caller registers a job        OS clock / doze state        caller fires due jobs
//!   register(AlarmExact | Deferred) ─▶ Scheduler ──due(now, power)──▶ Vec<JobId>
//!       earliest / latest window         │                          then complete(id)
//!                                        ▼
//!                               next_wake(now) → when to sleep until
//! ```
//!
//! Two job kinds capture Android's alarm taxonomy:
//! * [`JobType::AlarmExact`] — a user-visible alarm / reminder; the caller may run
//!   it once its time arrives even during Doze (Android still lets alarm apps
//!   fire, subject to its own cadence — the caller is the authority there).
//! * [`JobType::Deferred`] — background sync/cleanup/inference that must **not**
//!   wake the device arbitrarily; it only runs when not dozing, or when charging,
//!   or inside an open **maintenance window**. Deferred jobs whose windows overlap
//!   are returned together in one batch (coalesced alignment → fewer wakes).
//!
//! Pure `std`, no wall clock (the caller supplies `now` in arbitrary monotonic
//! ticks), fully offline-testable. Binding to a real `AlarmManager` /
//! `JobScheduler` / doze feed stays a caller-side seam.
//!
//! Design: `docs/scheduler.md`.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod error;
pub mod scheduler;
pub mod spec;

pub use error::SchedulerError;
pub use scheduler::{ScheduledJob, Scheduler};
pub use spec::{JobId, JobType, PowerState};
