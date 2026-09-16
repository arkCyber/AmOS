//! `amos-media` — the external-storage / media domain core of AmOS.
//!
//! Bridges the gap documented in `docs/android-storage-unify.md`: AmOS's
//! Photos/Files/Camera currently live in app-virtual stores with **no** bridge
//! to the real, user-visible Android file layout (`/storage/emulated/0`:
//! `DCIM/Camera`, `Pictures`, `Download`, `Recordings`, …). Following the
//! established AmOS convention (cf. `amos-sensor`, `amos-radio`) this crate is a
//! pure, transport- and platform-agnostic **domain core**: the real Android
//! MediaStore backend and the System-UI command/front-end wiring are deliberately
//! left as seams for later phases (see `docs/android-storage-unify.md` §6).
//!
//! ```text
//! [ System UI: Photos / Files / Camera / Store / Voice Memos ]
//!        │  pure TS logic (offline-testable)
//!        ▼
//! [ Tauri command layer  →  amos-tauri/src/media.rs ]   (Phase B)
//!        │  MediaManager: permission/collection policy
//! ┌──────┴──────────┐
//! │  MediaProvider   │  seam — dumb read register:
//! │   · Mock (today) │        list(dir) / save(dir, …)
//! │   · Android (C)  │        MediaStore via Kotlin glue
//! │   · HostFs (E)   │        read_dir over /storage/emulated/0 (root/Waydroid)
//! └─────────────────┘
//! ```
//!
//! Crate layout:
//!
//! * [`spec`] — domain types: [`StandardDir`] (the Android collections),
//!   [`MediaKind`], [`AccessKind`], and [`MediaItem`].
//! * [`error`] — [`MediaError`] (typed: Unauthorized / NotFound / TooLarge /
//!   InvalidArguments / Provider) + [`Result`] alias.
//! * [`provider`] — the [`MediaProvider`] seam (a dumb read register) + a
//!   deterministic [`MockMediaProvider`] with [`MAX_SAVE_BYTES`] guarding writes.
//! * [`manager`] — [`MediaManager`]: owns the provider and the **access policy**
//!   (a per-`(access, collection)` [`Grant`] model mirroring Android runtime
//!   permissions). Nothing is readable/writable until granted; an unauthorized
//!   access is an honest [`MediaError::Unauthorized`], never a silent empty list.
//! * [`mapping`] — pure Android platform knowledge (per-API read/write permission
//!   strings, [`MediaKind`]→MIME, collection relative paths) for the device glue.
//! * [`hostfs`] — a real-filesystem [`MediaProvider`] over a base dir (the **raw
//!   `read_dir`** channel for root / ADB-binary / Waydroid deployments; the
//!   `scan_dir` example packs DCIM paths/mtimes/sizes as JSON).
//!
//! The domain core (`spec`/`provider`/`manager`) is pure `std` (plus `serde` for
//! the types it hands to the UI) and offline-testable. The optional `android`
//! feature enables the real MediaStore backend (Phase C, device bring-up).

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]
// Safety boundary: every backend except the JNI `android` seam must be pure safe
// Rust (`unsafe impl Send/Sync` lives only in `android.rs`, feature `android`).
// This forbids any accidental `unsafe` in the default/host build.
#![cfg_attr(not(feature = "android"), forbid(unsafe_code))]

pub mod error;
pub mod hostfs;
pub mod manager;
pub mod mapping;
pub mod provider;
pub mod range;
pub mod spec;

// `protocol.rs` exists in this tree as a **draft** for REQ-A302 (stream media
// bytes over `amos-media://`). It is NOT yet wired into the lib nor a
// `pub mod` declaration: the file uses a half-finished API surface
// (`range::UnknownPlan`, `MediaRequest`, `MediaManager::read_range`) that
// `range.rs` and `manager.rs` do not export today. Once those are settled
// the module declaration lands here, the file's first 1–2 lines change to
// `use crate::…` to match the actual current crate shape, and a *narrow*
// re-export set re-applies the public types callers will need. Until then,
// `protocol.rs` stays in the tree so the design notes next to it survive
// and can be picked up by the next round — but it is not part of the build.
//
// pub mod protocol;
//
// pub use protocol::{base_url, parse_uri, MediaReply, MediaRequest, ProtocolError};

pub use error::{MediaError, Result};
pub use hostfs::HostFsProvider;
pub use manager::{Grant, MediaManager};
pub use provider::{MediaProvider, MockMediaProvider, MAX_LOAD_BYTES, MAX_SAVE_BYTES};
pub use range::{
    clamp_window, content_range, content_range_unsatisfied, parse_range, plan_response, status_for,
    window_for, window_len, RangeSpec, ResponsePlan, MAX_RANGE_BYTES,
};
pub use spec::{AccessKind, MediaItem, MediaKind, StandardDir};

#[cfg(feature = "android")]
pub mod android;
#[cfg(feature = "android")]
pub use android::AndroidMediaProvider;
