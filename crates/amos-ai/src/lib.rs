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
pub mod energy;
pub mod governor;
pub mod governor_service;
pub mod inference;
pub mod life_guard;
pub mod logfile;
pub mod monitoring;
pub mod netguard_service;
// Bounded daemon-wide generation admission gate, enforcing `AMOS_MAX_SESSIONS` at
// the two generation paths (stream_chat + bidi chat). See docs/daemon-resource-gate.md.
pub mod pool;
// Bounded LRU+TTL inference-response cache + transparent CachingBackend
// decorator (opt-in via AMOS_RESPONSE_CACHE=1). Closes the cache.rs audit gap.
pub mod cache;

// Circuit breaker for the backend (CODE_AUDIT_REPORT "实现断路器模式"): fail fast
// with a stated reason while a backend is down, one probe at a time afterwards.
// Sits inside the response cache so a hit is still served while it is open.
pub mod breaker;

// Threshold alerts over the counters the daemon already reports
// (CODE_AUDIT_REPORT "添加警告和告警机制"): one place that says what is wrong now.
pub mod alerts;

// Peer-credential check for the daemon's unix socket (gap #28 / REQ-A141): the 0700
// mode keeps other users out, but that is a filesystem property — this asks the
// kernel *who* connected (SO_PEERCRED / getpeereid).
pub mod peercred;

// Shared-secret authentication for the TCP transport (gap #28 / REQ-A142).
pub mod privacy;
pub mod privacy_service;
pub mod profiler;
pub mod rag;
pub mod rag_service;
pub mod security;
pub mod semantic;
pub mod server;
pub mod session;
pub mod tcp_auth;
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

/// The tracing filter directive the daemon starts with.
///
/// Precedence: **`AMOS_LOG`** (the name `docs/life-guard.md` tells operators to
/// use, e.g. `AMOS_LOG=amos_ai=trace`) → **`RUST_LOG`** (the ecosystem default
/// `tracing_subscriber` would read on its own) → `info`. Pure and injectable so
/// the precedence is unit-tested rather than assumed.
pub fn log_filter_from(amos_log: Option<&str>, rust_log: Option<&str>) -> String {
    /// A blank/`None` value means "unset", never a filter that silences everything.
    fn non_blank(v: Option<&str>) -> Option<&str> {
        v.map(str::trim).filter(|s| !s.is_empty())
    }
    non_blank(amos_log)
        .or_else(|| non_blank(rust_log))
        .unwrap_or("info")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_filter_prefers_amos_log_then_rust_log_then_info() {
        assert_eq!(
            log_filter_from(Some("amos_ai=trace"), Some("debug")),
            "amos_ai=trace"
        );
        assert_eq!(log_filter_from(None, Some("debug")), "debug");
        assert_eq!(log_filter_from(None, None), "info");
        // Blank values are "unset", not a filter that silences everything.
        assert_eq!(log_filter_from(Some("   "), Some("warn")), "warn");
        assert_eq!(log_filter_from(Some(""), None), "info");
    }
}
