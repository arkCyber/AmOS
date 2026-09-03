//! `amos-supervisor` CLI — orchestrates (launches + supervises) all Amos CLI
//! daemons from a JSON config.
//!
//! ```
//! amos-supervisor check <config.json>   # validate config (dry-run)
//! amos-supervisor run   <config.json>   # launch + supervise; Ctrl-C to stop
//! ```

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

use std::process::ExitCode;

use amos_supervisor::{load_config, start_all, Supervisor};
use tracing_subscriber::EnvFilter;

const USAGE: &str = "\
amos-supervisor — launch & supervise Amos CLI daemons from a JSON config

USAGE:
    amos-supervisor check <config.json>
    amos-supervisor run   <config.json>

The config is a JSON file: { \"daemons\": [ { \"name\", \"program\", \"args\",
\"env\", \"restart\": { \"max_restarts\", \"backoff_secs\", \"backoff_factor\" } } ] }
";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 || (args[0] != "run" && args[0] != "check") {
        print!("{USAGE}");
        return ExitCode::FAILURE;
    }
    let cmd = args[0].as_str();
    let path = std::path::PathBuf::from(&args[1]);

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = match load_config(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("config error: {e}");
            return ExitCode::FAILURE;
        }
    };

    if cmd == "check" {
        println!("config OK: {} daemon(s) defined", config.daemons.len());
        for d in &config.daemons {
            println!("  - {}  →  {}", d.name, d.program);
        }
        return ExitCode::SUCCESS;
    }

    // `run`: start the optional periodic wall-clock calibration FIRST so its state
    // path can be exported to children (feature `timesync` + AMOS_TIMESYNC=1),
    // then launch & supervise every daemon until Ctrl-C.
    #[cfg(feature = "timesync")]
    let mut _timekeeper: Option<amos_supervisor::timesync::TimeSyncHandle> = {
        use amos_supervisor::timesync::TimeSyncConfig;
        match TimeSyncConfig::from_env() {
            Some(cfg) => {
                let tk = cfg.start();
                if let Some(s) = tk.state_file().to_str() {
                    // Children inherit the process env, so this hands each
                    // supervised daemon the last-known-good calibrated clock.
                    std::env::set_var("AMOS_TIMESYNC_STATE", s);
                }
                println!(
                    "time sync: enabled (state {}): {}",
                    tk.state_file().display(),
                    tk.report().await
                );
                Some(tk)
            }
            None => {
                println!("time sync: disabled (set AMOS_TIMESYNC=1 to enable)");
                None
            }
        }
    };
    #[cfg(not(feature = "timesync"))]
    let _timekeeper = ();

    let sup = Supervisor::new();
    let results = start_all(&sup, &config).await;
    let mut any_failed = false;
    for (name, r) in results {
        match r {
            Ok(()) => println!("[{name}] started"),
            Err(e) => {
                any_failed = true;
                eprintln!("[{name}] failed to start: {e}");
            }
        }
    }
    if any_failed {
        eprintln!("one or more daemons failed to start; continuing to supervise the rest");
    }

    println!(
        "supervising {} daemon(s)… Ctrl-C/SIGTERM to stop, SIGUSR1 to restart all",
        config.daemons.len()
    );

    // Foreground supervision loop: Ctrl-C = graceful shutdown; on Unix, SIGUSR1 =
    // recycle every supervised daemon (operators can `kill -USR1 <pid>`).
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        // Best-effort SIGUSR1: if it cannot be installed we degrade to Ctrl-C
        // only and warn (never panic the supervisor).
        let mut usr1 = match signal(SignalKind::user_defined1()) {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!(
                    "warning: cannot install SIGUSR1 ({e}); hot-restart disabled, Ctrl-C only"
                );
                None
            }
        };
        loop {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => break,
                _ = async {
                    match usr1.as_mut() {
                        Some(u) => { u.recv().await; }
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    println!("SIGUSR1 received: restarting all daemons…");
                    #[cfg(feature = "timesync")]
                    if let Some(tk) = _timekeeper.as_ref() {
                        println!("time sync status: {}", tk.report().await);
                    }
                    sup.restart_all().await;
                    println!("restart requested for all supervised daemons");
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await.ok();
    }

    // Stop the periodic time-sync task (reporting its final calibration) before
    // tearing down the supervised daemons.
    #[cfg(feature = "timesync")]
    if let Some(tk) = _timekeeper.take() {
        println!("time sync final status: {}", tk.report().await);
        tk.stop().await;
    }

    println!("stopping all daemons…");
    sup.shutdown_all().await;
    println!("done");
    ExitCode::SUCCESS
}
