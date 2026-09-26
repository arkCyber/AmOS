//! Thin entry point: pass argv to [`amos_ota_cli::run`] and exit with its code.

// P0-1 gate: production code must not panic on programmer error.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let mut out = std::io::stdout();
    // A failed write to stdout (a closed pipe) is reported as an error exit, not
    // silently ignored: a caller that never saw the answer must not read a 0.
    let code = match amos_ota_cli::run(&args, &mut out) {
        Ok(code) => code,
        Err(err) => match writeln!(out, "amos-ota-cli: {err}") {
            Ok(()) => 1,
            Err(_) => return ExitCode::from(1),
        },
    };
    match out.flush() {
        Ok(()) => ExitCode::from(code as u8),
        Err(_) => ExitCode::from(1),
    }
}
