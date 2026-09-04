//! `amos-appstore` — Amos **app store core engine**.
//!
//! A transport-agnostic crate that encodes the *domain* of a software store —
//! what an app is, how versions advance, how a downloaded package's integrity
//! is proven — in pure Rust, so the **same** engine can drive a headless CLI,
//! the Tauri System UI bridge, and any future store frontend. This is exactly
//! the split the rest of Amos uses (`amos-mail` / `amos-int` / `amos-tts`).
//!
//! # Why this crate exists
//!
//! Amos today ships a fixed, compile-time set of apps. Building a *store with an
//! ecosystem* needs a definition of an installable third-party app plus the
//! download → verify → install lifecycle. Real fetching happens over HTTP (the
//! catalog + package CDN), which is (a) not something the domain model should
//! care about and (b) not testable headlessly. Mirroring the repo's
//! provider-seam pattern:
//!
//! ```text
//! [ CLI / Tauri bridge ] --> AppStore<P> --> P: StoreProvider
//!                                             ├─ MockStoreProvider  (deterministic, offline)
//!                                             └─ HttpStoreProvider  (feature `live`, real HTTP)
//! ```
//!
//! * [`model`] owns the publish contract a *developer* meets: [`AppManifest`]
//!   (identity, authorship, category), a small [`Version`] for upgrade
//!   detection, and a [`Checksum`] so a downloaded package can be proven to be
//!   exactly what the developer published.
//! * [`StoreProvider`] is the single seam to the outside: list the catalog and
//!   fetch a package's bytes. The deterministic [`MockStoreProvider`] (catalog +
//!   packages in memory) is the offline default; the `live`-gated
//!   `http::HttpStoreProvider` fetches a real catalog + downloads over HTTP.
//!   Both share one trait, so callers never change when the backend swaps.
//! * [`AppStore`] is the engine the CLI / UI drive. It owns the local
//!   installed-registry and enforces the lifecycle: an install **downloads →
//!   verifies sha256 → records** (refusing a mismatched/tampered payload), an
//!   upgrade only ever moves to a newer [`Version`], and the registry persists
//!   to JSON across restarts.
//!
//! The core performs **no network I/O** of its own: it only defines types,
//! validation, the integrity check, and the provider + engine contract, plus
//! the in-memory mock. (This crate deliberately adds no UI or Tauri bridge;
//! those are later steps like `amos-mail`'s `amos-mail-cli` and the Tauri
//! `mail` bridge.)

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod client;
pub mod error;
pub mod host;
pub mod model;
pub mod provider;
pub mod serve;
pub mod sign;
pub mod webinstall;

#[cfg(feature = "live")]
pub mod http;

pub use client::AppStore;
pub use error::{Result, StoreError};
pub use host::{is_valid_app_id, parse_bundle_uri, serve_bundle, ServedBundle, SCHEME};
pub use model::{
    AppCategory, AppManifest, AppStatus, Checksum, HashAlgorithm, InstalledApp, PackageFormat,
    PackageRef, PublisherSig, Version,
};
pub use provider::{MockStoreProvider, StoreProvider};
pub use serve::{content_type_for, resolve_request, ServedFile};
pub use sign::{sign_manifest, verify_manifest_signature, DeveloperKey};
pub use webinstall::{read_file, WebBundleMeta, WebInstall, WebInstaller};

#[cfg(feature = "live")]
pub use http::HttpStoreProvider;
