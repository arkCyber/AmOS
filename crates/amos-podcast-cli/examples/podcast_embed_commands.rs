//! `podcast_embed_commands` — the CLI's command set driven from a program (no shell).
//!
//! `run` is exactly what `main.rs` calls: parse argv, build the manager, dispatch,
//! return lines. Here a handful of argv vectors are fed in as data, sharing one
//! `--dir` so state carries between them — subscribe, list, browse the cached
//! episodes, record a playhead, then unsubscribe and watch it be cleaned up.
//!
//! The name carries the crate because cargo writes every example to the **same**
//! path (`target/debug/examples/<name>`), and a workspace-unique name keeps the
//! by-path artefact unambiguous (`scripts/isolation-check.mjs` fails on a collision).
//!
//! Usage:
//! ```text
//! cargo run -p amos-podcast-cli --example podcast_embed_commands
//! ```

use amos_podcast_cli::run;

const RW: &str = "https://feeds.amos.dev/rust-weekly.xml";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // One persistent dir so the invocations below share subscriptions, cache and
    // playheads exactly as separate shell invocations would.
    let dir = std::env::temp_dir().join(format!("amos-podcast-embed-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let dir_arg = dir.to_string_lossy().to_string();

    let invocations: [Vec<&str>; 6] = [
        vec!["--dir", dir_arg.as_str(), "subscribe", RW],
        vec!["--dir", dir_arg.as_str(), "subscriptions"],
        vec!["--dir", dir_arg.as_str(), "episodes", RW],
        vec![
            "--dir",
            dir_arg.as_str(),
            "play",
            RW,
            "rw-3",
            "600",
            "--duration",
            "2755",
        ],
        vec!["--dir", dir_arg.as_str(), "progress", RW, "rw-3"],
        vec!["--dir", dir_arg.as_str(), "unsubscribe", RW],
    ];

    for argv in invocations {
        println!("$ amos-podcast-cli {}", argv.join(" "));
        let args: Vec<String> = argv.iter().map(|s| (*s).to_string()).collect();
        for line in run(&args).await? {
            println!("{line}");
        }
        println!();
    }

    // The store files are a temp artifact of this example; leave the tree as we
    // found it.
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}
