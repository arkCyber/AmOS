//! `amos-timesync-cli` — query and drive the calibrated wall clock from a
//! terminal.
//!
//! Reads/writes the same last-known-good state the `amos-supervisor` `timesync`
//! feature exports via `AMOS_TIMESYNC_STATE`, so an operator (or a supervised
//! daemon / script) can ask: *what is the corrected time?*, *is it fresh?*, or
//! *sync now against a server*.
//!
//! ```text
//! amos-timesync-cli now      # corrected now from persisted state (no network)
//! amos-timesync-cli status   # same, plus freshness detail
//! amos-timesync-cli sync     # one calibration pass against a time source
//! ```
//!
//! The command logic lives here (testable with temp state + the offline host
//! clock); `src/main.rs` is a thin wrapper over [`run`].

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use amos_timesync::{HostClock, SyncedClock, TimeSource};
#[cfg(not(feature = "ntp"))]
use anyhow::bail;
use anyhow::{Context, Result};

pub const USAGE: &str = "\
amos-timesync-cli — query and calibrate the Amos wall clock

USAGE:
    amos-timesync-cli now     Show corrected now from state (no network)
    amos-timesync-cli status  Show corrected now + freshness detail
    amos-timesync-cli sync    [--server H]  Run one calibration pass (persists state)

OPTIONS:
        --state <PATH>   Clock state file (default: $AMOS_TIMESYNC_STATE,
                         else ~/.amos/timesync.json)
        --server <HOST>  NTP server for `sync` (needs the `ntp` feature; else
                         $AMOS_NTP_SERVER; otherwise the offline host clock)
    -h, --help           Print this help and exit
";

/// Which operation to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cmd {
    /// Print the corrected now from persisted last-known-good state.
    Now,
    /// Like `now`, but emphasise freshness.
    Status,
    /// Run one calibration pass and persist the new offset.
    Sync,
}

/// Resolved CLI options.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opts {
    pub cmd: Cmd,
    pub state: PathBuf,
    /// Optional `--server` NTP address (host or host:port).
    pub server: Option<String>,
    pub help: bool,
}

/// Resolve the state file: `--state`, then `$AMOS_TIMESYNC_STATE`, else the
/// default (`~/.amos/timesync.json`, or `./.amos-timesync.json` if no HOME).
pub fn resolve_state(cli: Option<PathBuf>) -> PathBuf {
    if let Some(p) = cli {
        return p;
    }
    if let Ok(p) = std::env::var("AMOS_TIMESYNC_STATE") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".amos").join("timesync.json");
    }
    PathBuf::from(".amos-timesync.json")
}

/// Parse CLI args (manual, mirroring the other `*-cli` crates).
pub fn parse_from<I, S>(args: I) -> Result<Opts, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut state: Option<PathBuf> = None;
    let mut server: Option<String> = None;
    let mut cmd = Cmd::Now;
    let mut help = false;

    let mut args = args.into_iter().map(Into::into);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => help = true,
            "--state" => {
                state = Some(
                    args.next()
                        .map(PathBuf::from)
                        .ok_or_else(|| "--state requires a value".to_string())?,
                );
            }
            "--server" => {
                server = Some(
                    args.next()
                        .ok_or_else(|| "--server requires a value".to_string())?,
                );
            }
            // A command token; only the first is honoured (later ones are caught
            // by the catch-all below once cmd != Now, unless help short-circuits).
            "now" | "status" | "sync" if cmd == Cmd::Now => {
                cmd = match arg.as_str() {
                    "sync" => Cmd::Sync,
                    "status" => Cmd::Status,
                    _ => Cmd::Now,
                };
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Opts {
        cmd,
        state: resolve_state(state),
        server,
        help,
    })
}

/// Resolve [`parse_from`] against the process environment.
pub fn parse_args() -> Result<Opts, String> {
    parse_from(std::env::args().skip(1))
}

/// Build the time source: a real SNTP source when `--server` is given (needs the
/// `ntp` feature), otherwise the offline host clock.
fn build_source(server: Option<String>) -> Result<Arc<dyn TimeSource>> {
    #[cfg(feature = "ntp")]
    if let Some(s) = server {
        return Ok(Arc::new(amos_timesync::NtpTimeSource::new([s])));
    }
    #[cfg(not(feature = "ntp"))]
    if server.is_some() {
        bail!("`--server` requires building with the `ntp` feature (cargo run --features ntp)");
    }
    Ok(Arc::new(HostClock))
}

/// One-line human summary of a clock's current state.
pub fn render(clock: &SyncedClock) -> String {
    let corrected_ms = epoch_ms(clock.now());
    let offset_ms = clock.offset_ns().map(|ns| ns / 1_000_000).unwrap_or(0);
    let freshness = match clock.staleness() {
        Some(d) => format!("last synced {}ms ago", d.as_millis()),
        None => "never synced (using host clock)".to_string(),
    };
    format!("corrected now = epoch {corrected_ms}ms (offset {offset_ms}ms), {freshness}")
}

/// Run the requested command.
pub async fn run(opts: Opts) -> Result<()> {
    match opts.cmd {
        Cmd::Now | Cmd::Status => {
            let clock = SyncedClock::load(&opts.state);
            if opts.cmd == Cmd::Status {
                println!("status of {}:", opts.state.display());
            }
            println!("{}", render(&clock));
            Ok(())
        }
        Cmd::Sync => {
            // `--server` wins; otherwise fall back to $AMOS_NTP_SERVER; otherwise
            // the offline host clock.
            let server = opts.server.or_else(|| {
                std::env::var("AMOS_NTP_SERVER")
                    .ok()
                    .filter(|s| !s.is_empty())
            });
            let source = build_source(server)?;
            let mut clock = SyncedClock::load(&opts.state).with_state_file(opts.state.clone());
            clock
                .sync(source.as_ref())
                .await
                .with_context(|| "time sync failed".to_string())?;
            println!("synced (state {}):", opts.state.display());
            println!("{}", render(&clock));
            Ok(())
        }
    }
}

fn epoch_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_state(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("amos-ts-cli-{tag}-{}.json", std::process::id()))
    }

    #[test]
    fn parses_commands_and_options() {
        let o = parse_from(["sync", "--state", "/tmp/x.json", "--server", "ntp.example"]).unwrap();
        assert_eq!(o.cmd, Cmd::Sync);
        assert_eq!(o.state, PathBuf::from("/tmp/x.json"));
        assert_eq!(o.server.as_deref(), Some("ntp.example"));
        assert!(!o.help);

        assert_eq!(parse_from(["now"]).unwrap().cmd, Cmd::Now);
        assert_eq!(parse_from(["status"]).unwrap().cmd, Cmd::Status);
    }

    #[test]
    fn help_and_unknown_reject() {
        assert!(parse_from(["-h"]).unwrap().help);
        assert!(
            parse_from(["frobnicate"]).is_err(),
            "unknown command rejected"
        );
        assert!(
            parse_from(["--server"]).is_err(),
            "option missing value rejected"
        );
        assert!(
            parse_from(["--state"]).is_err(),
            "--state missing value rejected"
        );
    }

    #[tokio::test]
    async fn sync_then_now_round_trips_through_state() {
        let state = tmp_state("roundtrip");
        let _ = std::fs::remove_file(&state);

        // `sync` with no --server → offline host clock; persists state.
        run(Opts {
            cmd: Cmd::Sync,
            state: state.clone(),
            server: None,
            help: false,
        })
        .await
        .expect("offline sync ok");
        assert!(state.exists(), "sync persists state");

        // `now` reloads it and reports a synced clock.
        run(Opts {
            cmd: Cmd::Now,
            state: state.clone(),
            server: None,
            help: false,
        })
        .await
        .expect("now ok");

        let clock = SyncedClock::load(&state);
        assert!(clock.synced(), "persisted clock should be synced");
        let text = render(&clock);
        assert!(text.contains("last synced"), "got: {text}");

        let _ = std::fs::remove_file(&state);
        let _ = std::fs::remove_file(state.with_extension("tmp"));
    }

    #[test]
    fn missing_state_now_degrades_gracefully() {
        let clock = SyncedClock::load(&tmp_state("missing"));
        assert!(!clock.synced());
        let text = render(&clock);
        assert!(text.contains("never synced"), "got: {text}");
    }
}
