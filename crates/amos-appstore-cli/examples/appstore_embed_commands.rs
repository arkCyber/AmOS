//! `embed_commands` — the CLI's command set driven from a program (no shell).
//!
//! `run` is exactly what `main.rs` calls: parse argv, build the offline demo store,
//! dispatch, print. Here three argv vectors are fed in as data — a catalog listing, a
//! detail view, and a `download`-only flow (which verifies and writes bytes but installs
//! nothing).
//!
//! Usage:
//! ```text
//! cargo run -p amos-appstore-cli --example embed_commands
//! ```

use amos_appstore_cli::run;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out_path = std::env::temp_dir().join("amos-appstore-embed-commands.pkg");
    let out_arg = out_path.to_string_lossy().to_string();

    let invocations: [Vec<&str>; 3] = [
        vec!["catalog"],
        vec!["info", "org.amos.pomodoro"],
        vec!["download", "org.amos.pomodoro", "--out", out_arg.as_str()],
    ];

    for argv in invocations {
        println!("$ amos-appstore-cli {}", argv.join(" "));
        let args: Vec<String> = argv.iter().map(|s| (*s).to_string()).collect();
        for line in run(&args).await? {
            println!("{line}");
        }
        println!();
    }

    // The bundle is a temp artifact of this example; leave the tree as we found it.
    let _ = std::fs::remove_file(&out_path);
    Ok(())
}
