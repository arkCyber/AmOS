//! `amos-translate` daemon entry point (CLI binary).
//!
//! Binds a Unix Domain Socket and serves the `Translator` gRPC service. Like
//! `amos-ai`, it is fully headless: all configuration comes from flags/env, and
//! it is intended to be launched and supervised by `amos-supervisor`.

use std::process::ExitCode;

use tracing_subscriber::EnvFilter;

/// Resolve the UDS path: `--socket` / `AMOS_TRANSLATE_SOCKET`, else the shared
/// `AMOS_SOCKET`, else the platform default.
fn resolve_socket(cli_socket: Option<std::path::PathBuf>) -> std::path::PathBuf {
    if let Some(s) = cli_socket {
        return s;
    }
    if let Ok(p) = std::env::var("AMOS_TRANSLATE_SOCKET") {
        if !p.is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    if let Ok(p) = std::env::var("AMOS_SOCKET") {
        if !p.is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    std::path::PathBuf::from("/tmp/amos-translate.sock")
}

#[tokio::main]
async fn main() -> ExitCode {
    let mut socket: Option<std::path::PathBuf> = None;
    let mut help = false;
    let mut version = false;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-s" | "--socket" => socket = it.next().map(std::path::PathBuf::from),
            "-h" | "--help" => help = true,
            "-V" | "--version" => version = true,
            _ => {}
        }
    }

    if help {
        println!("{}", USAGE);
        return ExitCode::SUCCESS;
    }
    if version {
        println!("amos-translate {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let path = resolve_socket(socket);
    if path.exists() {
        tracing::warn!(path = %path.display(), "removing stale socket file");
        std::fs::remove_file(&path).ok();
    }

    tracing::info!(path = %path.display(), "amos-translate listening");
    match amos_translate::serve(path).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!("server error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

const USAGE: &str = "\
amos-translate — Amos simultaneous-interpretation daemon (gRPC over a Unix Domain Socket)

USAGE:
    amos-translate [OPTIONS]

OPTIONS:
    -s, --socket <PATH>   Override the Unix Domain Socket path
                          (default: $AMOS_TRANSLATE_SOCKET, else $AMOS_SOCKET, else /tmp/amos-translate.sock)
    -V, --version         Print version and exit
    -h, --help            Print this help and exit

ENV:
    AMOS_TRANSLATE_SOCKET   Socket path override
    AMOS_TRANSLATE_BACKEND  Provider: \"ollama\" | \"mock\" (default \"ollama\")
    AMOS_TRANSLATE_HOST     Ollama base URL (default http://localhost:11434)
    AMOS_TRANSLATE_MODEL    Ollama model (default llama3.2)
    AMOS_TRANSLATE_API_KEY  Optional bearer token (auth-gated OpenAI-compatible hosts)
    AMOS_TRANSLATE_SOURCE   Default source language (default auto)
    AMOS_TRANSLATE_TARGET   Default target language (default zh)
    RUST_LOG                Log level, e.g. RUST_LOG=info
";
