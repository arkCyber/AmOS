//! Minimal, zero-dependency CLI parsing for headless/daemon deployment.
//!
//! `amos-ai` runs as an init-spawned system service on the no-UI Android base,
//! so it must not depend on a TTY or interactive input. It accepts a small set
//! of flags (help / version / socket path); everything else is env-driven
//! (`AMOS_SOCKET`, `RUST_LOG`).

use std::path::PathBuf;

/// Parsed command-line options.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Cli {
    pub socket: Option<PathBuf>,
    pub help: bool,
    pub version: bool,
}

impl Cli {
    /// Parse `std::env::args().skip(1)`-style arguments.
    pub fn parse<I>(args: I) -> Self
    where
        I: IntoIterator<Item = String>,
    {
        let mut cli = Cli::default();
        let mut it = args.into_iter();
        while let Some(arg) = it.next() {
            match arg.as_str() {
                "-h" | "--help" => cli.help = true,
                "-V" | "--version" => cli.version = true,
                "-s" | "--socket" => {
                    if let Some(v) = it.next() {
                        if !v.is_empty() {
                            cli.socket = Some(PathBuf::from(v));
                        }
                    }
                }
                _ => { /* ignore unknown/positional args */ }
            }
        }
        cli
    }
}

pub const USAGE: &str = "\
amos-ai — Amos OS AI daemon (gRPC server over a Unix Domain Socket)

USAGE:
    amos-ai [OPTIONS]

OPTIONS:
    -s, --socket <PATH>   Override the Unix Domain Socket path
                          (default: $AMOS_SOCKET, else platform default)
    -V, --version         Print version and exit
    -h, --help            Print this help and exit

ENV:
    AMOS_SOCKET           Socket path override (same as --socket)
    AMOS_BACKEND          Inference backend: \"mock\" | \"api\" | \"ollama\" | \"hermes\" | \"ggml\" (default \"mock\")
    AMOS_MODEL_PATH       Path to the GGUF model (ggml backend)
    AMOS_GGML_BIN         External GGML engine to run GGUFs, e.g. allama (default: allama)
    AMOS_GGML_MODEL       Engine run-name override for the model (default: derived from GGUF path)
    AMOS_API_KEY          API key (api backend)
    AMOS_API_ENDPOINT     OpenAI-compatible endpoint (api backend, default /v1/chat/completions)
    AMOS_OLLAMA_HOST      Ollama server base URL (ollama backend, default http://localhost:11434)
    AMOS_OLLAMA_API_KEY   Bearer token for token-gated Ollama /v1 (optional)
    AMOS_HERMES_ENDPOINT  Hermes-Rust agent base URL (hermes backend, default http://127.0.0.1:11438)
    AMOS_MODEL            Model id for api/ollama/hermes backends (default gpt-4o-mini / hermes3 / hermes-rust)
    AMOS_SESSIONS_PATH    Persist agent sessions to a JSON file on shutdown
    AMOS_SESSION_TIMEOUT_SECS  Idle-session expiry (seconds, default 300)
    AMOS_METRICS_INTERVAL_SECS Health-metrics heartbeat interval (seconds, default 60)
    RUST_LOG              Log level, e.g. RUST_LOG=info
";

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str]) -> Cli {
        Cli::parse(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn defaults_are_empty() {
        let cli = p(&[]);
        assert!(!cli.help && !cli.version && cli.socket.is_none());
    }

    #[test]
    fn parses_help_and_version() {
        assert!(p(&["--help"]).help);
        assert!(p(&["-h"]).help);
        assert!(p(&["--version"]).version);
        assert!(p(&["-V"]).version);
    }

    #[test]
    fn parses_socket_long_and_short() {
        assert_eq!(
            p(&["--socket", "/tmp/a.sock"]).socket,
            Some(PathBuf::from("/tmp/a.sock"))
        );
        assert_eq!(
            p(&["-s", "/data/amos/ai.sock"]).socket,
            Some(PathBuf::from("/data/amos/ai.sock"))
        );
    }

    #[test]
    fn missing_socket_value_is_ignored() {
        let cli = p(&["--socket"]);
        assert!(cli.socket.is_none());
    }

    #[test]
    fn ignores_unknown_args() {
        let cli = p(&["run", "--socket", "/tmp/x.sock", "extra"]);
        assert_eq!(cli.socket, Some(PathBuf::from("/tmp/x.sock")));
        assert!(!cli.help && !cli.version);
    }
}
