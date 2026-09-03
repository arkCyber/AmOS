//! Live SNTP probe: query one or more NTP servers and print the corrected time
//! and the measured offset from the host clock.
//!
//! ```text
//! cargo run -p amos-timesync --example ntp_probe -- [server ...]
//! ```
//!
//! Requires the `ntp` feature. This is a manual diagnostic tool (network I/O is
//! never exercised by the default test suite).

use std::time::Duration;

use amos_timesync::SyncedClock;

fn main() {
    // Command-line args or a sensible default pool.
    let servers: Vec<String> = std::env::args().skip(1).collect();
    let servers = if servers.is_empty() {
        vec!["time.apple.com".to_string(), "pool.ntp.org".to_string()]
    } else {
        servers
    };

    let source = amos_timesync::NtpTimeSource::new(servers).with_timeout(Duration::from_secs(5));

    // Minimal async driver so we can call the async TimeSource from a sync main.
    let now = tokio::runtime::Runtime::new()
        .expect("build tokio runtime")
        .block_on(async {
            let mut clock = SyncedClock::new();
            match clock.sync(&source).await {
                Ok(remote) => {
                    let offset = clock.offset_ns().unwrap_or(0);
                    println!("remote  = {remote:?}");
                    println!("corrected now = {:?}", clock.now());
                    println!("offset  = {offset}ns ({} ms)", offset / 1_000_000);
                    clock
                }
                Err(e) => {
                    eprintln!("sync failed: {e}");
                    std::process::exit(1);
                }
            }
        });
    let _ = now;
}
