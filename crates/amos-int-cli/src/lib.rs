//! `amos-int-cli` — an interactive **text simultaneous-interpretation** CLI.
//!
//! Drives an [`amos_int::Session`] backed by the `amos-translate` daemon's
//! [`GrpcPipeline`]. Reads stdin; each line is source text that gets translated;
//! dot-prefixed commands control the session:
//!
//! ```text
//! hello               -> translate "hello"
//! .lang ja            -> hint the source language
//! .status             -> print the session state
//! .pause / .resume    -> suspend / resume input
//! .stop / .abort      -> end / hard-end the session
//! .help / .quit
//! ```
//!
//! The line-processing core is exposed as [`exec_line`] so it can be unit-tested
//! with a [`MockPipeline`] — no daemon required.

use std::path::PathBuf;

use amos_int::event::InterpretationOutput;
use amos_int::{Session, SessionConfig, SessionEvent};
use anyhow::Context;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

pub const USAGE: &str = "\
amos-int-cli — Amos text simultaneous-interpretation CLI (drives the amos-translate daemon)

USAGE:
    amos-int-cli [OPTIONS]

OPTIONS:
    -s, --socket <PATH>   Translate daemon Unix Domain Socket
                          (default: $AMOS_TRANSLATE_SOCKET, else /tmp/amos-translate.sock)
        --source <LANG>   Source language tag, or \"auto\" (default auto)
        --target <LANG>   Target language tag (default zh)
    -h, --help            Print this help and exit

COMMANDS (stdin):
    <text>                Translate a line of source text
    .lang <LANG>          Hint / set the source language
    .status               Print the session state
    .pause  / .resume     Suspend / resume input
    .stop   / .abort      End / hard-end the session
    .restart              Reset an ended session and run again
    .help   / .quit       Help / exit
";

/// Resolved CLI options.
#[derive(Clone, Debug)]
pub struct Opts {
    pub socket: PathBuf,
    pub source: String,
    pub target: String,
    pub help: bool,
}

/// Resolve the socket path: `--socket`, then `AMOS_TRANSLATE_SOCKET`, else the
/// daemon default.
pub fn resolve_socket(cli: Option<PathBuf>) -> PathBuf {
    if let Some(s) = cli {
        return s;
    }
    if let Ok(p) = std::env::var("AMOS_TRANSLATE_SOCKET") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    PathBuf::from("/tmp/amos-translate.sock")
}

/// Parse CLI args (manual, no clap dependency).
pub fn parse_args() -> Result<Opts, String> {
    let mut socket: Option<PathBuf> = None;
    let mut source = "auto".to_string();
    let mut target = "zh".to_string();
    let mut help = false;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-s" | "--socket" => socket = it.next().map(PathBuf::from),
            "--source" => source = it.next().cloned().unwrap_or_else(|| "auto".into()),
            "--target" => target = it.next().cloned().unwrap_or_else(|| "zh".into()),
            "-h" | "--help" => help = true,
            other => return Err(format!("unknown option: {other}")),
        }
    }
    Ok(Opts {
        socket: resolve_socket(socket),
        source,
        target,
        help,
    })
}

/// Render one [`InterpretationOutput`] as a display line, or `None` to skip.
pub fn format_output(o: &InterpretationOutput) -> Option<String> {
    match o {
        InterpretationOutput::Partial(p) => Some(format!("  [~] {}", p.text)),
        InterpretationOutput::SegmentFinal(s) => {
            Some(format!("  {}  →  {}", s.source_text, s.target_text))
        }
        InterpretationOutput::LanguageDetected(l) => Some(format!("  [lang] {l}")),
        InterpretationOutput::TtsRequest(r) => Some(format!("  [tts] {}", r.text)),
        InterpretationOutput::SessionEnded { reason } => Some(format!("  [ended] {reason:?}")),
        InterpretationOutput::Error { message } => Some(format!("  [error] {message}")),
        _ => None,
    }
}

fn drain(rx: &mut mpsc::Receiver<InterpretationOutput>, out: &mut Vec<String>) {
    while let Ok(o) = rx.try_recv() {
        if let Some(s) = format_output(&o) {
            out.push(s);
        }
    }
}

/// Process one stdin line against the session. Pushes rendered outputs to `out`
/// and returns `true` when the caller should exit.
pub async fn exec_line(
    session: &mut Session,
    rx: &mut mpsc::Receiver<InterpretationOutput>,
    line: &str,
    out: &mut Vec<String>,
) -> bool {
    let line = line.trim();
    if line.is_empty() {
        return false;
    }
    if let Some(cmd) = line.strip_prefix('.') {
        let mut parts = cmd.split_whitespace();
        let name = parts.next().unwrap_or("");
        match name {
            "quit" | "exit" => {
                drain(rx, out);
                return true;
            }
            "start" => {
                let _ = session.start();
            }
            "restart" => {
                let _ = session.restart();
            }
            "stop" => {
                let _ = session.stop();
            }
            "abort" => {
                let _ = session.abort();
            }
            "pause" => {
                let _ = session.pause();
            }
            "resume" => {
                let _ = session.resume();
            }
            "status" => out.push(format!("  [status] {:?}", session.state())),
            "lang" => {
                if let Some(l) = parts.next() {
                    let _ = session.handle(SessionEvent::SetSourceLang(l.into())).await;
                }
            }
            "help" => out.push(USAGE.trim_end().to_string()),
            other => out.push(format!("  unknown command: .{other}")),
        }
        drain(rx, out);
        return false;
    }
    if let Err(e) = session
        .handle(SessionEvent::TextSegment(line.to_string()))
        .await
    {
        out.push(format!("  [error] {e}"));
    }
    drain(rx, out);
    false
}

/// Run the interactive REPL against a live daemon.
pub async fn run(opts: Opts) -> anyhow::Result<()> {
    let pipeline = Box::new(amos_translate::grpc_pipeline::GrpcPipeline::new(
        opts.socket.clone(),
        opts.source.clone(),
        opts.target.clone(),
    ));
    let config = SessionConfig::one_way(opts.source.clone(), opts.target.clone());
    let (mut session, mut rx) = Session::new(config, pipeline);
    session.start().context("failed to start session")?;

    println!(
        "connected to {} ({} -> {}) — type text to translate; '.help' for commands; '.quit' to exit",
        opts.socket.display(),
        opts.source,
        opts.target
    );

    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut out = Vec::new();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(l)) => l,
            Ok(None) => break, // EOF
            Err(e) => return Err(e.into()),
        };
        let exit = exec_line(&mut session, &mut rx, &line, &mut out).await;
        for s in out.drain(..) {
            println!("{s}");
        }
        if exit {
            break;
        }
    }
    let _ = session.stop();
    drain(&mut rx, &mut out);
    for s in out.drain(..) {
        println!("{s}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_int::{InterpretationOutput, MockPipeline};

    fn fresh() -> (Session, mpsc::Receiver<InterpretationOutput>) {
        let cfg = SessionConfig::one_way("en", "zh");
        let (s, rx) = Session::new(cfg, Box::new(MockPipeline::new("ignored", "en")));
        (s, rx)
    }

    #[tokio::test]
    async fn text_line_translates_and_renders() {
        let (mut s, mut rx) = fresh();
        s.start().unwrap();
        let mut out = Vec::new();
        let exit = exec_line(&mut s, &mut rx, "hello", &mut out).await;
        assert!(!exit);
        assert!(
            out.iter().any(|l| l == "  hello  →  [en] hello"),
            "expected rendered translation, got {out:?}"
        );
    }

    #[tokio::test]
    async fn status_and_lang_commands() {
        let (mut s, mut rx) = fresh();
        s.start().unwrap();
        let mut out = Vec::new();
        exec_line(&mut s, &mut rx, ".status", &mut out).await;
        assert!(out.iter().any(|l| l.contains("Collecting")));

        out.clear();
        exec_line(&mut s, &mut rx, ".lang ja", &mut out).await;
        exec_line(&mut s, &mut rx, "こんにちは", &mut out).await;
        assert!(
            out.iter().any(|l| l.contains("[ja] こんにちは")),
            "lang hint should be applied: {out:?}"
        );
    }

    #[tokio::test]
    async fn pause_resume_and_quit() {
        let (mut s, mut rx) = fresh();
        s.start().unwrap();
        let mut out = Vec::new();

        exec_line(&mut s, &mut rx, ".pause", &mut out).await;
        exec_line(&mut s, &mut rx, "hello", &mut out).await; // rejected while paused
        assert!(out.iter().any(|l| l.contains("[error]")), "{out:?}");

        out.clear();
        exec_line(&mut s, &mut rx, ".resume", &mut out).await;
        exec_line(&mut s, &mut rx, "hi", &mut out).await;
        assert!(out.iter().any(|l| l == "  hi  →  [en] hi"), "{out:?}");

        out.clear();
        assert!(exec_line(&mut s, &mut rx, ".quit", &mut out).await);
    }

    #[tokio::test]
    async fn restart_resets_an_ended_session() {
        let (mut s, mut rx) = fresh();
        s.start().unwrap();
        let mut out = Vec::new();
        exec_line(&mut s, &mut rx, "hello", &mut out).await;
        assert!(out.iter().any(|l| l == "  hello  →  [en] hello"));

        exec_line(&mut s, &mut rx, ".stop", &mut out).await;
        assert_eq!(s.state(), amos_int::SessionState::Ended);

        // A fresh text line after stop is rejected (session ended)…
        out.clear();
        exec_line(&mut s, &mut rx, "again", &mut out).await;
        assert!(out.iter().any(|l| l.contains("[error]")), "{out:?}");

        // …but .restart makes it usable again.
        out.clear();
        exec_line(&mut s, &mut rx, ".restart", &mut out).await;
        assert_eq!(s.state(), amos_int::SessionState::Collecting);
        exec_line(&mut s, &mut rx, "hi", &mut out).await;
        assert!(out.iter().any(|l| l == "  hi  →  [en] hi"), "{out:?}");
    }
}
