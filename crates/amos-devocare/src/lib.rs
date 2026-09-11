//! `amos-devocare` — the **device-care (手机管家)** domain core of AmOS.
//!
//! The phone manager is the surface where a user reclaims storage, removes
//! unwanted apps, checks battery health and audits who holds sensitive
//! permissions. AmOS already owns every *subsystem* that needs — `amos-appstore`
//! (install/uninstall), `amos-applife` (reclaim), `amos-power` (energy), the
//! daemon privacy ledger — but had no **unifying domain** that decides *what is
//! safe to do*. This crate is that layer, following the established AmOS
//! convention (cf. `amos-media`, `amos-blocklist`): a pure, transport- and
//! platform-agnostic kernel, fully offline-testable, with the real device
//! backends left as seams.
//!
//! ```text
//!   [ System UI: 手机管家 (Svelte) ]
//!            │   analyze / plan / execute / assess / review
//!            ▼
//!   [ Tauri bridge → amos-tauri/src/devcare.rs ]        (next phase)
//!            │
//!   ┌────────┴─────────┬───────────────┬────────────────┐
//!   │ junk (scan+clean)│ guard         │ permissions    │  ← this crate
//!   │ analyze/plan/exec│ UninstallGuard│ review_grants  │
//!   └────────┬─────────┴───────────────┴────────────────┘
//!            │ CleanProvider seam
//!            ▼
//!     Mock (today) · Android MediaStore/PackageManager (device bring-up)
//! ```
//!
//! # The three disciplines this crate is held to
//!
//! 1. **Safety by construction.** [`JunkKind`] enumerates the only deletable
//!    material; user media/documents/contacts/messages/app data are not modelled
//!    as junk, so no code path can select them. Uninstall is gated by
//!    [`UninstallGuard`]. Review-only categories ([`JunkKind::StaleDownload`])
//!    need an explicit [`CleanRequest::acknowledge_review`].
//! 2. **Honest failure.** Nothing is silently swallowed: an over-cap scan is
//!    refused ([`DevCareError::TooManyItems`]), a partial clean reports every
//!    failed item ([`CleanOutcome::failures`]), `freed_bytes` counts only
//!    confirmed removals, and an unobserved care area is left **unassessed**
//!    ([`CareReport::has_data`]) rather than scored as healthy.
//! 3. **Determinism.** Same input ⇒ identical output. All collections are
//!    ordered by a documented key; all sums saturate instead of overflowing.
//!
//! # Purity (and its one documented exception)
//!
//! `spec`/`error`/`provider`/`junk`/`guard`/`permissions`/`health` are pure `std`
//! with **no I/O**. [`hostfs`] is the single, deliberate exception: an explicit,
//! root-confined filesystem scanner + provider for desktop/root deployments
//! (`is_within` refuses anything outside the canonicalized root). Nothing else in
//! this crate touches the disk.
//!
//! Design: `docs/devcare.md`.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]
// The kernel is pure safe Rust; the JNI/device backend will live in a future
// feature-gated module, never here.
#![forbid(unsafe_code)]

pub mod audit;
pub mod boost;
pub mod error;
pub mod guard;
pub mod health;
pub mod hostfs;
pub mod junk;
pub mod permissions;
pub mod provider;
pub mod spec;

pub use audit::{
    boost_events, clean_events, uninstall_performed, uninstall_refused, BoostReclaim,
    CareAuditEvent, ACTOR, OP_BOOST, OP_BOOST_ITEM, OP_CLEAN, OP_CLEAN_ITEM, OP_UNINSTALL,
};
pub use boost::{is_reclaimable, reclaim_plan, reclaim_rank, RECLAIMABLE_STATES};
pub use error::{DevCareError, Result, SCAN_ITEM_CAP};
pub use guard::{UninstallGuard, CRITICAL_PACKAGES};
pub use health::{
    assess, BatteryCare, CareInput, BATTERY_CRITICAL_PCT, BATTERY_LOW_PCT, MANY_SENSITIVE_GRANTS,
    STORAGE_WARNING_BYTES,
};
pub use hostfs::{
    is_safe_root, is_within, HostFsCleanProvider, HostFsScanner, HostScan, MAX_SCAN_DEPTH,
};
pub use junk::{analyze, auto_cleanable_kinds, execute, plan};
pub use permissions::{apps_holding, granted_resource_count, review_grants, MAX_REVIEW_APPS};
pub use provider::{CleanProvider, MockCleanProvider};
pub use spec::{
    AppPackage, CareArea, CareFinding, CareGrade, CareReport, CleanFailure, CleanOutcome,
    CleanPlan, CleanRequest, JunkGroup, JunkItem, JunkKind, JunkReport, PermissionGrant,
    SensitiveAppRow, SensitiveResource, Severity, UninstallVerdict, MAX_CLEAN_BATCH,
    MAX_JUNK_ITEMS,
};
