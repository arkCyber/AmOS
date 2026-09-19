//! amos-ai daemon entry point (CLI binary).
//!
//! Binds a Unix Domain Socket and serves the `AiAgent` gRPC service. On the
//! no-UI Android base this binary lives in `/system/bin/` and is started by an
//! init.rc service (see `deploy/android/amos.rc`). It is fully headless: no
//! TTY, no interactive input — all configuration comes from flags/env.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

use std::process::ExitCode;

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    let cli = amos_ai::cli::Cli::parse(std::env::args().skip(1));

    if cli.help {
        print!("{}", amos_ai::cli::USAGE);
        return ExitCode::SUCCESS;
    }
    if cli.version {
        println!("amos-ai {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    // Daemon logging: stdout (unchanged) **plus** a bounded, self-rotating log file
    // when configured (`AMOS_LOG_DIR`, see `lib/logfile.rs`) — a headless daemon's
    // stdout is often dropped, which made on-device failures uninvestigable.
    let log_cfg = amos_ai::logfile::LogFileConfig::from_env();
    let log_path = log_cfg.as_ref().map(|c| c.path());
    let sink = amos_ai::logfile::TeeWriter::new(log_cfg);
    // Filter precedence: AMOS_LOG (the name docs/life-guard.md tells operators to
    // use) → RUST_LOG (the tracing convention) → "info". Previously only
    // `try_from_default_env()` was consulted, i.e. RUST_LOG — so the documented
    // `AMOS_LOG=…` silently did nothing.
    let directive = amos_ai::log_filter_from(
        std::env::var("AMOS_LOG").ok().as_deref(),
        std::env::var("RUST_LOG").ok().as_deref(),
    );

    // The structured JSON line sink is **opt-in** (`AMOS_LOG_JSON=1`) so a second
    // sink never silently ships events to disk without an explicit operator
    // decision (REQ-A87: an unexpected sink that ships is the exact opposite of
    // the "log_sink on the wire" invariant this daemon ships with). When enabled
    // it writes one JSON object per event into `amos-ai.jsonl` next to the human
    // `amos-ai.log` — see `lib/jsonlog.rs` for the wire format.
    let json_sink = amos_ai::jsonlog::JsonSink::new(amos_ai::jsonlog::JsonLogConfig::from_env());
    let json_layer = if json_sink.enabled() {
        Some(amos_ai::jsonlog::JsonLayer::new(json_sink.clone()))
    } else {
        None
    };

    tracing_subscriber::registry()
        .with(EnvFilter::try_new(&directive).unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer().with_writer(sink.clone()))
        .with(json_layer)
        .init();

    match (&log_path, sink.file_enabled()) {
        (Some(p), true) => tracing::info!(path = %p.display(), "file log sink active"),
        (Some(p), false) => {
            tracing::warn!(path = %p.display(), "file log sink unavailable — stdout only")
        }
        _ => tracing::info!("file log sink disabled (AMOS_LOG_DIR off) — stdout only"),
    }
    if json_sink.enabled() {
        tracing::info!(
            path = %json_sink.handle().report().path,
            "JSON log sink active (machine-parseable)"
        );
    }

    let socket = cli.socket.unwrap_or_else(amos_ai::resolve_socket);

    // Make sure a stale socket from a previous run does not block binding.
    if socket.exists() {
        tracing::warn!(path = %socket.display(), "removing stale socket file");
        std::fs::remove_file(&socket).ok();
    }

    // Arm the notifier sink (REQ-A451 / F-AI-014 (a) step). The factory
    // reads `AMOS_NOTIFIER=1` and `AMOS_NOTIFIER_WEBHOOK=…` itself, so the
    // binary's only responsibility here is "ask for the sink if there is
    // one and forward it to `serve_with_sinks_full`". Without this call
    // every other piece of work on this page (the dispatcher, the
    // bridge, the rules) is dead code in production — `rust-unwired-scan`
    // already flagged `with_notifier_bridge` as "referenced nowhere" for
    // tests only, and the supervisor's REQ-A444 patch closed the same gap
    // there (`bin/amos-supervisor.rs:108`); this is its sibling.
    //
    // `notifier_sink_from_env` is feature-gated so the default build
    // does **not** pull `amos-notifier` (the default build's quiet
    // contract is preserved). When the operator wants the alerting path
    // armed they rebuild with `--features notifier`.
    #[cfg(feature = "notifier")]
    let notifier_sink = amos_ai::notifier_sink_from_env();
    #[cfg(not(feature = "notifier"))]
    let notifier_sink: Option<std::sync::Arc<dyn amos_ai::notifier_bridge::AlertSink>> = None;
    #[cfg(not(feature = "notifier"))]
    if std::env::var("AMOS_NOTIFIER").is_ok() {
        eprintln!(
            "AMOS_NOTIFIER is set but this build has no `notifier` feature, so threshold \
             alerts are computed and visible on GetStatus but not delivered to any sink \
             (rebuild with `--features notifier`)"
        );
    }

    tracing::info!(path = %socket.display(), "amos-ai listening");
    match amos_ai::server::serve_with_sinks_full(
        socket,
        Some(sink.handle()),
        Some(json_sink.handle()),
        notifier_sink,
    )
    .await
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!("server error: {e:#}");
            ExitCode::FAILURE
        }
    }
}
