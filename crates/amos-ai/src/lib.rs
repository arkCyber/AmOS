//! amos-ai library: the OS-level AI daemon core.
//!
//! Exposes the gRPC service implementation and the socket resolution helper so
//! both the CLI binary (`main.rs`) and integration tests / the mobile embedder
//! can reuse the same logic.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod accelerator;
pub mod audit;
pub mod chat_asr;
pub mod cli;
pub mod config;
pub mod energy;
pub mod governor;
pub mod governor_service;
pub mod inference;
pub mod life_guard;
pub mod monitoring;
pub mod netguard_service;
// Bounded daemon-wide generation admission gate: enforces the long-dormant
// `Config::max_concurrent_sessions` / `AMOS_MAX_SESSIONS` at the two generation
// paths (stream_chat + bidi chat). See docs/daemon-resource-gate.md.
pub mod pool;
// Bounded LRU+TTL inference-response cache + transparent CachingBackend
// decorator (opt-in via AMOS_RESPONSE_CACHE=1). Closes the cache.rs audit gap.
pub mod cache;
pub mod privacy;
pub mod privacy_service;
pub mod profiler;
pub mod rag;
pub mod rag_service;
pub mod security;
pub mod semantic;
pub mod server;
pub mod session;
pub mod telemetry_spy_service;
// Daemon-side pnet capture producer feeding TelemetrySpySvc::ingest_match. Only
// compiled under `telemetry-spy-audit` (amos-telemetry-spy `audit` = pnet).
#[cfg(feature = "telemetry-spy-audit")]
pub mod telemetry_spy_capture;

use std::path::PathBuf;

/// `AMOS_SOCKET` env var wins; otherwise fall back to the shared default.
pub fn resolve_socket() -> PathBuf {
    if let Ok(p) = std::env::var("AMOS_SOCKET") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    amos_proto::socket::default_socket_path()
}
