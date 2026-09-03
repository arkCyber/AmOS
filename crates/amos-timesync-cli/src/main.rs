//! `amos-timesync-cli` binary entry point — thin wrapper over
//! [`amos_timesync_cli::run`] that maps args + exit codes onto the process.

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
    match run(opts).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}
