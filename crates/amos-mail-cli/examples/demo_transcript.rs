//! `demo_transcript` — the deterministic offline mailbox session, from a program.
//!
//! `demo_lines()` is what the `demo` subcommand prints to a shell; calling it here proves
//! the engine is drivable **without a shell and without a server** (the same seed → list
//! → read → send path, in memory).
//!
//! Usage:
//! ```text
//! cargo run -p amos-mail-cli --example demo_transcript
//! ```

use amos_mail_cli::demo_lines;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in demo_lines().await? {
        println!("{line}");
    }
    Ok(())
}
