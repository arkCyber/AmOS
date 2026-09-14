//! `embed_commands` — drive the CLI's own command set from a program, with no shell.
//!
//! The crate is not only a binary: [`parse_from`] + [`run`] are the same two calls
//! `src/main.rs` makes, so a harness (a bring-up script, a CI probe, an operator tool) can
//! build a command line as data and run it in-process. This example runs three commands
//! and prints what the shell would have printed.
//!
//! Everything here is offline: `status` / `bench` / `motor` build their own in-process
//! node (or, for `motor`, no link at all). Commands that need a *running* peer
//! (`--socket`, `--transport zenoh`, `discover --lan`) are deliberately not in this list —
//! they depend on an environment an example must not assume.
//!
//! Usage:
//! ```text
//! cargo run -p amos-link-cli --example embed_commands
//! ```

use amos_link_cli::{parse_from, run};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let scripts: Vec<Vec<&str>> = vec![
        vec!["status", "--peer", "dog1", "--kind", "robot"],
        vec!["bench", "--count", "200", "--size", "1024"],
        vec!["motor", "--action", r#"{"action":"trot","speed":0.5}"#],
    ];

    for argv in scripts {
        println!("$ amos-link-cli {}", argv.join(" "));
        // The same parse the binary uses, including its refusals (a bad argument is an
        // error here, not a panic).
        let opts = parse_from(argv.clone())?;
        if let Err(e) = run(opts).await {
            println!("  (refused: {e})");
        }
        println!();
    }
    Ok(())
}
