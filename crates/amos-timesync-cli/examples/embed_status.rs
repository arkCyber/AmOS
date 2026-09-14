//! `embed_status` — the CLI's library surface offline: which state file it reads, and
//! exactly how a clock is rendered.
//!
//! `parse_from` and `resolve_state` are what `main.rs` calls; `render` is the single
//! formatter behind both `now` and `status`. The first clock has never been calibrated
//! (the honest default), the second is synced against the offline host clock — no network.
//!
//! Usage:
//! ```text
//! cargo run -p amos-timesync-cli --example embed_status
//! ```

use amos_timesync::{HostClock, SyncedClock};
use amos_timesync_cli::{parse_from, render, resolve_state};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let state = std::env::temp_dir().join("amos-timesync-embed-status.json");

    let opts = match parse_from(["--state", state.to_string_lossy().as_ref(), "status"]) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("usage: {e}");
            std::process::exit(2);
        }
    };
    println!("command:               {:?}", opts.cmd);
    println!("--state:               {}", opts.state.display());
    println!("resolve_state(None):   {}", resolve_state(None).display());

    // A clock with no persisted calibration reports that, rather than inventing a time.
    let never = SyncedClock::load(&opts.state);
    println!("\nnever calibrated:      synced={}", never.synced());
    println!("render:                {}", render(&never));

    // One calibration pass against the offline host clock (the `--server` path needs the
    // `ntp` feature + a reachable server; this stays offline).
    let mut synced = SyncedClock::load(&opts.state).with_state_file(opts.state.clone());
    synced.sync(&HostClock).await?;
    println!("\nafter host-clock sync: synced={}", synced.synced());
    println!("render:                {}", render(&synced));

    let _ = std::fs::remove_file(&opts.state);
    Ok(())
}
