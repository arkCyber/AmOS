//! `amos-mail-cli` binary entry point.
//!
//! Thin wrapper over [`amos_mail_cli::run`]: it maps parsed args onto the
//! offline `MailClient` engine and prints the resulting lines. Logic lives in
//! the lib so it is unit-testable headlessly.

use std::process::ExitCode;

use amos_mail_cli::run;

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
            eprintln!("{}", amos_mail_cli::USAGE);
            ExitCode::FAILURE
        }
    }
}
