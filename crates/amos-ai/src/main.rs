//! amos-ai daemon entry point (CLI binary).
//!
//! Binds a Unix Domain Socket and serves the `AiAgent` gRPC service. On the
//! no-UI Android base this binary lives in `/system/bin/` and is started by an
//! init.rc service (see `deploy/android/amos.rc`). It is fully headless: no
//! TTY, no interactive input — all configuration comes from flags/env.

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

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let socket = cli.socket.unwrap_or_else(amos_ai::resolve_socket);

    // Make sure a stale socket from a previous run does not block binding.
    if socket.exists() {
        tracing::warn!(path = %socket.display(), "removing stale socket file");
        std::fs::remove_file(&socket).ok();
    }

    tracing::info!(path = %socket.display(), "amos-ai listening");
    match amos_ai::server::serve(socket).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!("server error: {e:#}");
            ExitCode::FAILURE
        }
    }
}
