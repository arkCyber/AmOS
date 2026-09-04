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

pub mod chat_asr;
pub mod cli;
pub mod config;
pub mod inference;
pub mod monitoring;
pub mod security;
pub mod semantic;
pub mod server;
pub mod session;

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
