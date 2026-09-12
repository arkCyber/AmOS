//! `amos-timesync-cli` binary entry point — thin wrapper over
//! [`amos_timesync_cli::run`] that maps args + exit codes onto the process.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

use std::process::ExitCode;

use amos_timesync_cli::{parse_args, run, USAGE};

#[tokio::main]
async fn main() -> ExitCode {
    let opts = match parse_args() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    if opts.help {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if opts.version {
        // Self-describing artifacts: the release bundle's `--version` is how a
        // deployed binary is identified (scripts/release-artifacts.sh checks it).
        println!("amos-timesync-cli {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    match run(opts).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}
