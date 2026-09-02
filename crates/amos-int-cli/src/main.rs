//! `amos-int-cli` binary entry point.
//!
//! Thin wrapper over [`amos_int_cli::run`] that wires stdin/stdout and maps the
//! session-driving logic (kept in the lib for testability) onto the process.

use std::process::ExitCode;

use amos_int_cli::{run, USAGE};

#[tokio::main]
async fn main() -> ExitCode {
    let opts = match amos_int_cli::parse_args() {
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
    match run(opts).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}
