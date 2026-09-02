//! `amos-supervisor` CLI — orchestrates (launches + supervises) all Amos CLI
//! daemons from a JSON config.
//!
//! ```
//! amos-supervisor check <config.json>   # validate config (dry-run)
//! amos-supervisor run   <config.json>   # launch + supervise; Ctrl-C to stop
//! ```

use std::process::ExitCode;

use amos_supervisor::{load_config, start_all, Supervisor};
use tracing_subscriber::EnvFilter;

const USAGE: &str = "\
amos-supervisor — launch & supervise Amos CLI daemons from a JSON config

USAGE:
    amos-supervisor check <config.json>
    amos-supervisor run   <config.json>

The config is a JSON file: { \"daemons\": [ { \"name\", \"program\", \"args\",
\"env\", \"restart\": { \"max_restarts\", \"backoff_secs\", \"backoff_factor\" } } ] }
";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 || (args[0] != "run" && args[0] != "check") {
        print!("{USAGE}");
        return ExitCode::FAILURE;
    }
    let cmd = args[0].as_str();
    let path = std::path::PathBuf::from(&args[1]);

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = match load_config(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("config error: {e}");
            return ExitCode::FAILURE;
        }
    };

    if cmd == "check" {
        println!("config OK: {} daemon(s) defined", config.daemons.len());
        for d in &config.daemons {
            println!("  - {}  →  {}", d.name, d.program);
        }
        return ExitCode::SUCCESS;
    }

    // `run`: launch every daemon, supervise, and block until Ctrl-C.
    let sup = Supervisor::new();
    let results = start_all(&sup, &config).await;
    let mut any_failed = false;
    for (name, r) in results {
        match r {
            Ok(()) => println!("[{name}] started"),
            Err(e) => {
                any_failed = true;
                eprintln!("[{name}] failed to start: {e}");
            }
        }
    }
    if any_failed {
        eprintln!("one or more daemons failed to start; continuing to supervise the rest");
    }

    println!(
        "supervising {} daemon(s)… press Ctrl-C to stop",
        config.daemons.len()
    );
    tokio::signal::ctrl_c().await.ok();
    println!("stopping all daemons…");
    sup.shutdown_all().await;
    println!("done");
    ExitCode::SUCCESS
}
