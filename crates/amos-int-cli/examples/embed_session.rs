//! `embed_session` — the CLI's library surface, driven from a program (no daemon).
//!
//! `parse_from` and `resolve_socket` are exactly what `main.rs` calls, and `exec_line`
//! is the line processor behind the interactive REPL. With a `MockPipeline` standing in
//! for the translate daemon, this shows *which* socket a session would connect to and
//! *how* one interpretation is rendered — without faking a translation over the wire.
//!
//! Usage:
//! ```text
//! cargo run -p amos-int-cli --example embed_session
//! ```

use amos_int::{MockPipeline, Session, SessionConfig};
use amos_int_cli::{exec_line, parse_from, resolve_socket};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Parse a command line as data (env-free) — the binary uses `parse_args` on argv.
    let opts = match parse_from([
        "--socket",
        "/tmp/amos-translate.sock",
        "--source",
        "en",
        "--target",
        "zh",
    ]) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("usage: {e}");
            std::process::exit(2);
        }
    };
    println!("socket:  {}", opts.socket.display());
    println!("languages: {} -> {}", opts.source, opts.target);
    println!(
        "resolve_socket(None) (env, then default): {}",
        resolve_socket(None).display()
    );

    // 2. Render a session offline. The mock pipeline produces the outputs; `exec_line`
    //    is the same function the REPL uses to render them.
    let config = SessionConfig::one_way(opts.source.clone(), opts.target.clone());
    let (mut session, mut rx) = Session::new(
        config,
        Box::new(MockPipeline::new("你好", opts.source.as_str())),
    );
    session.start()?;

    for line in ["hello", ".status", "good morning"] {
        let mut out = Vec::new();
        exec_line(&mut session, &mut rx, line, &mut out).await;
        for rendered in out {
            println!("  {line:>12} -> {rendered}");
        }
    }
    Ok(())
}
