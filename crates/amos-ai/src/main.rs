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
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_new(&directive).unwrap_or_else(|_| EnvFilter::new("info")))
        .with_writer(sink.clone())
        .init();

    match (&log_path, sink.file_enabled()) {
        (Some(p), true) => tracing::info!(path = %p.display(), "file log sink active"),
        (Some(p), false) => {
            tracing::warn!(path = %p.display(), "file log sink unavailable — stdout only")
        }
        _ => tracing::info!("file log sink disabled (AMOS_LOG_DIR off) — stdout only"),
    }

    let socket = cli.socket.unwrap_or_else(amos_ai::resolve_socket);

    // Make sure a stale socket from a previous run does not block binding.
    if socket.exists() {
        tracing::warn!(path = %socket.display(), "removing stale socket file");
        std::fs::remove_file(&socket).ok();
    }

    tracing::info!(path = %socket.display(), "amos-ai listening");
    match amos_ai::server::serve_with_log_sink(socket, Some(sink.handle())).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!("server error: {e:#}");
            ExitCode::FAILURE
        }
    }
}
