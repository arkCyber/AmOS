//! `amos-appstore-cli` binary entry point.
//!
//! Thin wrapper over [`amos_appstore_cli::run`]: it maps parsed args onto the
//! offline app-store engine and prints the resulting lines. Logic lives in the
//! lib so it is unit-testable headlessly.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

use std::process::ExitCode;

use amos_appstore_cli::run;

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args).await {
        Ok(lines) => {
            for line in lines {
                println!("{line}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e:#}");
            eprintln!();
            eprintln!("{}", amos_appstore_cli::USAGE);
            ExitCode::FAILURE
        }
    }
}
