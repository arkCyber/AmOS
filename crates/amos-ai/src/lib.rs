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
// Bundled / user-installed GGUF model resolution chain (Gap 4 / F-AI-016/017):
// AMOS_MODEL_PATH → bundled assets → user dir. `build_backend_from_env` turns a
// resolved path into a real `ggml` engine and an empty chain into an honest
// `unconfigured` backend — never the mock.
pub mod bundled_model;
pub mod chat_asr;
pub mod cli;
pub mod energy;
pub mod governor;
pub mod governor_service;
pub mod inference;
pub mod jsonlog;
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

// Bridge the threshold alerts to `amos-notifier` so an operator pages on a
// state transition (appear + clear), not on every poll. The bridge is a
// `Send + Sync` value type so it sits on the status-poll task; the actual
// `Dispatcher` wiring is the operator's choice (compile-time feature
// `notifier` pulls `amos-notifier`; default build is a no-op).
pub mod notifier_bridge;

#[cfg(feature = "notifier")]
mod notifier_sink;

#[cfg(feature = "notifier")]
pub use notifier_sink::{notifier_sink, notifier_sink_from_env, NotifierSink};

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

/// Resolve the UDS path this daemon binds: `AMOS_SOCKET`, else the shared
/// default.
///
/// The knob is read as **three** facts, not two: **unset** ⇒ the default,
/// silently; a **usable** path ⇒ that path; a value the operator set but which
/// cannot be read as UTF-8 ⇒ reported once, then the default — so an unreadable
/// override is never silently mistaken for "unset". (REQ-A1999 / F-AI-061)
pub fn resolve_socket() -> PathBuf {
    socket_path_from("AMOS_SOCKET", std::env::var_os("AMOS_SOCKET"))
        .unwrap_or_else(amos_proto::socket::default_socket_path)
}

/// Pure three-state read of a socket-path override (the raw `OsString` is
/// injected so every arm is reachable in a test).
fn socket_path_from(key: &str, raw: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let raw = raw?;
    match raw.into_string() {
        Ok(s) if !s.is_empty() => Some(PathBuf::from(s)),
        Ok(_) => None,
        Err(_) => {
            warn_once_bad_socket_path(key);
            None
        }
    }
}

/// The `(key, reason)` pairs already reported as an unusable socket override, so
/// a repeated bad value is not news twice.
fn bad_socket_path_seen() -> &'static std::sync::Mutex<std::collections::BTreeSet<(String, String)>>
{
    static SEEN: std::sync::OnceLock<
        std::sync::Mutex<std::collections::BTreeSet<(String, String)>>,
    > = std::sync::OnceLock::new();
    SEEN.get_or_init(Default::default)
}

fn warn_once_bad_socket_path(key: &str) {
    let first = bad_socket_path_seen()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert((key.to_owned(), "non-Unicode".to_owned()));
    if first {
        tracing::warn!(
            key,
            "amos-ai: {key} is set but not valid Unicode — read as unset, so the shared socket \
             default is used"
        );
    }
}

#[cfg(test)]
fn bad_socket_path_reports_for(key: &str) -> usize {
    bad_socket_path_seen()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .filter(|(k, _)| k == key)
        .count()
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

    #[test]
    fn an_unset_socket_knob_is_the_default_and_silent() {
        assert_eq!(socket_path_from("TEST_AI_SOCK_UNSET", None), None);
        assert_eq!(bad_socket_path_reports_for("TEST_AI_SOCK_UNSET"), 0);
    }

    #[test]
    fn a_usable_socket_knob_is_read_as_given() {
        assert_eq!(
            socket_path_from("TEST_AI_SOCK_OK", Some("/run/amos/ai.sock".into())),
            Some(PathBuf::from("/run/amos/ai.sock"))
        );
        assert_eq!(bad_socket_path_reports_for("TEST_AI_SOCK_OK"), 0);
    }

    #[test]
    fn a_blank_socket_knob_is_the_default_and_silent() {
        assert_eq!(
            socket_path_from("TEST_AI_SOCK_BLANK", Some("".into())),
            None
        );
        assert_eq!(bad_socket_path_reports_for("TEST_AI_SOCK_BLANK"), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_non_unicode_socket_knob_is_reported_not_read_as_unset() {
        use std::os::unix::ffi::OsStringExt;
        let raw = std::ffi::OsString::from_vec(vec![0xff, 0xfe]);
        assert_eq!(socket_path_from("TEST_AI_SOCK_MOJIBAKE", Some(raw)), None);
        assert_eq!(bad_socket_path_reports_for("TEST_AI_SOCK_MOJIBAKE"), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_repeated_bad_socket_knob_is_reported_once() {
        use std::os::unix::ffi::OsStringExt;
        let key = "TEST_AI_SOCK_DEDUP";
        for _ in 0..3 {
            let raw = std::ffi::OsString::from_vec(vec![0xff, 0xfe]);
            assert_eq!(socket_path_from(key, Some(raw)), None);
        }
        assert_eq!(bad_socket_path_reports_for(key), 1);
    }
}
