//! `amos-podcast-cli` — Amos podcast **CLI**.
//!
//! A thin headless front-end over [`amos_podcast::PodcastManager`], driving the
//! deterministic offline [`MockFeedProvider`]. It is the "CLI half" of the
//! podcast strategy — the *same* engine this binary uses is what the Tauri
//! System-UI bridge exposes to the WebView.
//!
//! ```text
//! $ amos-podcast-cli demo
//! $ amos-podcast-cli subscribe https://feeds.amos.dev/rust-weekly.xml
//! $ amos-podcast-cli subscriptions
//! $ amos-podcast-cli episodes https://feeds.amos.dev/rust-weekly.xml
//! $ amos-podcast-cli play https://feeds.amos.dev/rust-weekly.xml rw-3 600 --duration 2760
//! $ amos-podcast-cli refresh
//! $ amos-podcast-cli unsubscribe https://feeds.amos.dev/rust-weekly.xml
//! ```
//!
//! Subcommand parsing lives in [`parse_args`] and execution in [`dispatch`]
//! (generic over any [`FeedProvider`], so the live HTTP backend drops in without
//! changing the CLI code). The core is exposed for unit tests that run entirely
//! in memory.
//!
//! *Note:* the default backend is the offline mock and the default stores are
//! **ephemeral** (reset each run). Pass `--dir <PATH>` (or set
//! `AMOS_PODCAST_DIR`) to persist subscriptions, the episode cache, playheads
//! and the download registry; `--live` (a `--features live` build) fetches real
//! feeds instead of the demo catalog.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

use std::path::PathBuf;

use amos_podcast::{
    clamp_speed, episode_uid, format_duration, normalize_feed_url, progress_fraction,
    DownloadState, FeedProvider, MockFeedProvider, PodcastManager, PodcastPaths, RefreshReport,
};

use anyhow::{anyhow, Result};

/// CLI usage text.
pub const USAGE: &str = "\
amos-podcast-cli — Amos podcast CLI (offline MockFeedProvider by default)

USAGE:
    amos-podcast-cli [--dir <PATH>] [--live] <SUBCOMMAND>

SUBCOMMANDS:
    subscriptions                  List the subscribed feeds (with refresh state)
    subscribe <URL>                Fetch a feed and subscribe to it (fetch first, so a
                                   feed that cannot be reached is never stored)
    add <URL> [--title <T>]        Store a subscription WITHOUT fetching it
    refresh [<URL>]                Re-fetch one subscribed feed, or every one (a dead
                                   feed is reported, never silently dropped)
    episodes <URL>                 List the cached episodes for a subscribed feed
    unsubscribe <URL>              Drop a subscription, its cached episodes and its
                                   playheads (downloaded files are the caller's)
    progress <URL> <EPISODE>       Show the stored playhead / speed / finished state
    play <URL> <EPISODE> <SECS>    Record a playhead update; `--duration <SECS>` also
                                   records the duration the PLAYER measured
    speed <URL> <EPISODE> <RATE>   Set the playback rate (clamped to 0.25..4.0)
    played <URL> <EPISODE>         Mark the episode finished
    unplayed <URL> <EPISODE>       Un-mark the episode finished
    download <URL> <EPISODE>       Download the episode now: fetch its enclosure
                                   bytes and write them under <dir>/audio
                                   (needs --dir / $AMOS_PODCAST_DIR)
    download-status <URL> <EPISODE>
                                   Show a download's state
    remove-download <URL> <EPISODE>
                                   Forget a download record (the file is left alone)
    demo                           Print an offline sample session
    help                           Show this help

OPTIONS:
    -h, --help                     Show this help
    -V, --version                  Print version and exit
    --dir <PATH>                   Persist the four stores under this directory
                                   (subscriptions.json, library.json, progress.json,
                                   downloads.json). Also honors $AMOS_PODCAST_DIR.
                                   Without it every store is in memory only.
    --title <T>                    With `add`: the name shown for this subscription
                                   (the user's own, kept across refreshes).
    --duration <SECS>              With `play`: the duration the player measured.
    --live                         Fetch real feeds over HTTP instead of the offline
                                   mock catalog. Requires --features live; without it
                                   the command refuses loudly rather than silently
                                   handing back the demo feed.
";

/// One CLI operation, fully parsed and ready to execute against a manager.
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    /// Print `USAGE`.
    Help,
    /// Print the binary's version (how a deployed artifact is identified).
    Version,
    /// Print an offline demo session over one ephemeral manager.
    Demo,
    /// List subscriptions.
    Subscriptions,
    /// Fetch a feed and subscribe to it.
    Subscribe { url: String },
    /// Store a subscription without fetching it.
    Add { url: String, title: Option<String> },
    /// Re-fetch one (`Some`) or every (`None`) subscribed feed.
    Refresh { url: Option<String> },
    /// List the cached episodes for a feed.
    Episodes { url: String },
    /// Drop a subscription and the state derived from it.
    Unsubscribe { url: String },
    /// Show the stored state for one episode.
    Progress { url: String, episode: String },
    /// Record a playhead update.
    Play {
        url: String,
        episode: String,
        position: f64,
        duration: Option<f64>,
    },
    /// Set one episode's playback rate.
    Speed {
        url: String,
        episode: String,
        rate: f64,
    },
    /// Mark one episode finished (or un-finish it).
    SetPlayed {
        url: String,
        episode: String,
        played: bool,
    },
    /// Download one episode now (moving its bytes through the provider seam).
    ///
    /// `audio_dir` is the directory the file is written into, resolved at parse
    /// time from `--dir` / `$AMOS_PODCAST_DIR`. It is `None` when neither is set —
    /// there is then nowhere to put the audio, which the dispatch refuses rather
    /// than reporting a download that wrote nothing.
    EnqueueDownload {
        url: String,
        episode: String,
        audio_dir: Option<PathBuf>,
    },
    /// Show a download's state.
    DownloadStatus { url: String, episode: String },
    /// Forget a download record.
    RemoveDownload { url: String, episode: String },
}

/// Options that take a value. Kept in one place so the parser and the raw-arg
/// readers ([`scan_flag`]) cannot disagree about which flags exist.
const VALUE_FLAGS: &[&str] = &["--dir", "--title", "--duration"];

/// Which value flags each subcommand actually reads (besides the global
/// `--dir`, which every command honours). A value flag is *never* swallowed: a
/// `--title` on a command that does not read it would quietly lose the name the
/// user chose, and a `--duration` would vanish for the same reason — the same
/// rule that makes a dangling `--dir` an error rather than a quiet forfeit of
/// persistence (see the filter in [`parse_args`]).
fn allowed_value_flags(cmd: &str) -> &'static [&'static str] {
    match cmd {
        "add" => &["--title"],
        "play" => &["--duration"],
        _ => &[],
    }
}

/// The value that follows `--flag` anywhere in the raw args, if present.
/// [`parse_args`] has already rejected a flag with no (or an empty) value.
fn scan_flag<'a>(args: &'a [String], flag: &str) -> Option<&'a String> {
    args.windows(2)
        .find(|w| w[0] == flag)
        .and_then(|w| w.get(1))
}

/// The persistent store directory from `--dir <PATH>` (appearing anywhere in the
/// raw args) or `$AMOS_PODCAST_DIR`. `None` keeps every store in memory.
fn store_dir(args: &[String]) -> Option<PathBuf> {
    scan_flag(args, "--dir").map(PathBuf::from).or_else(|| {
        std::env::var("AMOS_PODCAST_DIR")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
    })
}

/// Whether the raw args ask for the real HTTP backend.
fn wants_live(args: &[String]) -> bool {
    args.iter().any(|a| a == "--live")
}

/// Parse a number from the command line, rejecting anything non-finite — a
/// playhead of `NaN` would poison the stored record and every later render.
fn parse_number(raw: &str, what: &str) -> Result<f64> {
    let v: f64 = raw
        .parse()
        .map_err(|_| anyhow!("{what} must be a number, got {raw:?}"))?;
    if !v.is_finite() {
        return Err(anyhow!("{what} must be a finite number, got {raw:?}"));
    }
    Ok(v)
}

/// Collect exactly one positional token, with a command-specific message.
fn one<'a>(it: &mut impl Iterator<Item = &'a String>, cmd: &str, what: &str) -> Result<String> {
    let toks: Vec<&String> = it.collect();
    match toks.as_slice() {
        [a] => Ok((*a).clone()),
        [] => Err(anyhow!("{cmd} needs {what}")),
        _ => Err(anyhow!(
            "{cmd}: unexpected extra arguments (expected {what})"
        )),
    }
}

/// Collect exactly two positional tokens.
fn two<'a>(
    it: &mut impl Iterator<Item = &'a String>,
    cmd: &str,
    what: &str,
) -> Result<(String, String)> {
    let toks: Vec<&String> = it.collect();
    match toks.as_slice() {
        [a, b] => Ok(((*a).clone(), (*b).clone())),
        _ => Err(anyhow!("{cmd} needs {what}")),
    }
}

/// Collect exactly three positional tokens.
fn three<'a>(
    it: &mut impl Iterator<Item = &'a String>,
    cmd: &str,
    what: &str,
) -> Result<(String, String, String)> {
    let toks: Vec<&String> = it.collect();
    match toks.as_slice() {
        [a, b, c] => Ok(((*a).clone(), (*b).clone(), (*c).clone())),
        _ => Err(anyhow!("{cmd} needs {what}")),
    }
}

/// Parse CLI arguments (the first non-option token is the subcommand). A value
/// flag pair is dropped here (it does not affect dispatch) so the flag may
/// appear anywhere; the readers above scan it back off the raw args.
pub fn parse_args(args: &[String]) -> Result<Op> {
    let filtered: Vec<String> = {
        let mut out = Vec::new();
        let mut it = args.iter();
        while let Some(a) = it.next() {
            if VALUE_FLAGS.contains(&a.as_str()) {
                // A flag with no value must be an error, never a silent drop:
                // swallowing a dangling `--dir` would quietly forfeit
                // persistence, and a dangling `--duration` would record a
                // playhead with no measured duration.
                match it.next() {
                    Some(v) if !v.trim().is_empty() => {}
                    Some(_) => return Err(anyhow!("{a} needs a non-empty value")),
                    None => return Err(anyhow!("{a} needs a value")),
                }
            } else {
                out.push(a.clone());
            }
        }
        out
    };

    // `-V/--version` is a global flag: it must work without a subcommand (that is
    // exactly how a deployed artifact is identified).
    if filtered.iter().any(|a| a == "-V" || a == "--version") {
        return Ok(Op::Version);
    }

    let mut rest = filtered.iter();
    // `--live` is a global switch that may precede the subcommand; skip any that
    // do, so `--live subscribe <url>` and `subscribe <url> --live` both work.
    let cmd = match rest.find(|c| c.as_str() != "--live") {
        Some(c) => c.as_str(),
        // No subcommand (or only the `--live` switch): print help.
        None => return Ok(Op::Help),
    };

    // Refuse a value flag this command does not read rather than silently
    // swallowing it (`--title` is documented "With `add`"; `--duration` only
    // applies to `play`).
    for a in args {
        if VALUE_FLAGS.contains(&a.as_str())
            && a != "--dir"
            && !allowed_value_flags(cmd).contains(&a.as_str())
        {
            return Err(anyhow!("{cmd} does not take {a}"));
        }
    }

    match cmd {
        "help" | "-h" | "--help" => Ok(Op::Help),
        "demo" => Ok(Op::Demo),
        "subscriptions" | "list" => Ok(Op::Subscriptions),
        "subscribe" => Ok(Op::Subscribe {
            url: one(&mut rest, "subscribe", "a <URL>")?,
        }),
        "add" => Ok(Op::Add {
            url: one(&mut rest, "add", "a <URL>")?,
            title: scan_flag(args, "--title").cloned(),
        }),
        "refresh" => {
            let toks: Vec<String> = rest.cloned().collect();
            match toks.as_slice() {
                [] => Ok(Op::Refresh { url: None }),
                [url] => Ok(Op::Refresh {
                    url: Some(url.clone()),
                }),
                _ => Err(anyhow!(
                    "refresh takes at most one <URL> (omit it to refresh all)"
                )),
            }
        }
        "episodes" => Ok(Op::Episodes {
            url: one(&mut rest, "episodes", "a <URL>")?,
        }),
        "unsubscribe" => Ok(Op::Unsubscribe {
            url: one(&mut rest, "unsubscribe", "a <URL>")?,
        }),
        "progress" => {
            let (url, episode) = two(&mut rest, "progress", "<URL> <EPISODE>")?;
            Ok(Op::Progress { url, episode })
        }
        "play" => {
            let (url, episode, secs) = three(&mut rest, "play", "<URL> <EPISODE> <SECS>")?;
            Ok(Op::Play {
                url,
                episode,
                position: parse_number(&secs, "the playhead <SECS>")?,
                duration: match scan_flag(args, "--duration") {
                    Some(d) => Some(parse_number(d, "--duration")?),
                    None => None,
                },
            })
        }
        "speed" => {
            let (url, episode, rate) = three(&mut rest, "speed", "<URL> <EPISODE> <RATE>")?;
            Ok(Op::Speed {
                url,
                episode,
                rate: parse_number(&rate, "the <RATE>")?,
            })
        }
        "played" | "unplayed" => {
            let (url, episode) = two(&mut rest, cmd, "<URL> <EPISODE>")?;
            Ok(Op::SetPlayed {
                url,
                episode,
                played: cmd == "played",
            })
        }
        "download" => {
            let (url, episode) = two(&mut rest, "download", "<URL> <EPISODE>")?;
            Ok(Op::EnqueueDownload {
                url,
                episode,
                audio_dir: store_dir(args).map(|d| d.join("audio")),
            })
        }
        "download-status" => {
            let (url, episode) = two(&mut rest, "download-status", "<URL> <EPISODE>")?;
            Ok(Op::DownloadStatus { url, episode })
        }
        "remove-download" => {
            let (url, episode) = two(&mut rest, "remove-download", "<URL> <EPISODE>")?;
            Ok(Op::RemoveDownload { url, episode })
        }
        other => Err(anyhow!(
            "unknown subcommand {other:?} (try: amos-podcast-cli help)"
        )),
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// Unix seconds -> an RFC 3339 UTC stamp, or a plain `t=<secs>` when the value
/// is outside what a calendar can represent (never a panic, never a wrong date).
fn format_time(secs: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| format!("t={secs}"))
}

/// A duration in seconds as `H:MM:SS` / `M:SS`, or an em dash when the feed
/// never stated one. An unknown duration must never render as `0:00`.
fn dur(secs: Option<u64>) -> String {
    format_duration(secs).unwrap_or_else(|| "—".to_string())
}

/// A playhead in seconds, or an em dash when nothing is recorded — an absent
/// resume position reads differently from "start of episode".
fn pos(secs: Option<f64>) -> String {
    match secs {
        Some(s) => format!("{s:.0}s"),
        None => "—".to_string(),
    }
}

/// One subscription rendered as a line.
fn subscription_line(s: &amos_podcast::Subscription) -> String {
    let refreshed = match s.last_refreshed {
        Some(t) => format!("last refreshed {}", format_time(t)),
        None => "NEVER refreshed".to_string(),
    };
    format!(
        "{:<44} {}  (subscribed {}, {refreshed})",
        s.url,
        s.display_title(),
        format_time(s.subscribed_at)
    )
}

/// A one-word state for the download column.
fn download_label(s: &DownloadState) -> String {
    match s {
        DownloadState::Absent => "not downloaded".to_string(),
        DownloadState::Queued => "queued".to_string(),
        DownloadState::Downloading { received, total } => match total {
            Some(t) => format!("downloading {received}/{t}"),
            None => format!("downloading {received} bytes"),
        },
        DownloadState::Done { bytes, .. } => format!("downloaded ({bytes} bytes)"),
        DownloadState::Failed { reason } => format!("FAILED: {reason}"),
    }
}

/// One episode row for `episodes <URL>`.
fn episode_line(index: usize, ep: &amos_podcast::Episode, playhead: &str, played: bool) -> String {
    let published = ep
        .published
        .map(format_time)
        .unwrap_or_else(|| "—".to_string());
    let mark = if played { "[x]" } else { "[ ]" };
    // An episode the feed left untitled is an absent name, drawn like every
    // other absent field on this line (`—`), not a word this program made up.
    let title = if ep.title.is_empty() {
        "—"
    } else {
        ep.title.as_str()
    };
    format!(
        "  {index:>3}. {mark} {:<28} {:>9}  {:<20}  playhead {:<8}  {}",
        ep.id,
        dur(ep.duration_secs),
        published,
        playhead,
        title
    )
}

/// A refresh outcome for the report lines.
fn refresh_line(id: &str, res: &Result<RefreshReport, amos_podcast::PodcastError>) -> String {
    match res {
        Ok(r) => {
            let trunc = if r.truncated {
                " (TRUNCATED: the feed declared more episodes than were collected)"
            } else {
                ""
            };
            format!(
                "  {id}: {} episode(s), fetched {}{trunc}",
                r.episode_count,
                format_time(r.fetched_at)
            )
        }
        Err(e) => {
            // Only a failure *before* the write leaves the stored snapshot alone.
            // A store failure may well have been the write itself, so claiming the
            // cache survived would assert a cause this path never established —
            // the line the bridge's `kept_previous_cache` already draws.
            let note = match e {
                amos_podcast::PodcastError::FetchFailed(_)
                | amos_podcast::PodcastError::ParseFailed(_) => {
                    " (the previous cache is left intact)"
                }
                _ => "",
            };
            format!("  {id}: FAILED — {e}{note}")
        }
    }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Resolve a user-typed feed reference to the store's key (the normalized URL)
/// and fail with the store's own "unknown subscription" error when it is not
/// subscribed. Doing this in one place is what keeps a typo a *typo* rather than
/// a second, silently-created subscription.
fn require_subscription<P: FeedProvider>(mgr: &PodcastManager<P>, url: &str) -> Result<String> {
    let id = normalize_feed_url(url).map_err(|e| anyhow!("{e}"))?;
    if mgr.subscription(&id).is_none() {
        return Err(anyhow!(
            "not subscribed: {id} (try: amos-podcast-cli subscriptions)"
        ));
    }
    Ok(id)
}

/// Execute `op` against a manager and return the lines to print.
///
/// Generic over the provider so the live HTTP backend works unchanged.
pub async fn dispatch<P: FeedProvider>(mgr: &mut PodcastManager<P>, op: Op) -> Result<Vec<String>> {
    match op {
        Op::Help => Ok(vec![USAGE.to_string()]),
        Op::Version => Ok(vec![format!(
            "amos-podcast-cli {}",
            env!("CARGO_PKG_VERSION")
        )]),
        Op::Demo => demo_lines().await,

        Op::Subscriptions => {
            let subs = mgr.subscriptions();
            let mut out = vec![format!("Subscriptions: {} feed(s)", subs.len())];
            if subs.is_empty() {
                out.push("  (none — try: subscribe https://feeds.amos.dev/rust-weekly.xml)".into());
            } else {
                for s in subs {
                    out.push(format!("  {}", subscription_line(s)));
                }
            }
            Ok(out)
        }

        Op::Subscribe { url } => {
            let now = now_unix();
            let sub = mgr.subscribe(&url, now).await.map_err(|e| anyhow!("{e}"))?;
            let count = mgr
                .episodes(&sub.feed_id)
                .map(|c| c.feed.episodes.len())
                .unwrap_or(0);
            let mut out = vec![format!(
                "subscribed {} — {} ({count} episode(s))",
                sub.url,
                sub.display_title()
            )];
            if let Some(c) = mgr.episodes(&sub.feed_id) {
                if c.feed.truncated {
                    out.push("  note: the feed declared more episodes than were collected".into());
                }
            }
            Ok(out)
        }

        Op::Add { url, title } => {
            let now = now_unix();
            let sub = mgr
                .add_subscription(&url, title.as_deref(), now)
                .map_err(|e| anyhow!("{e}"))?;
            Ok(vec![
                format!("added {} — {}", sub.url, sub.display_title()),
                "  stored WITHOUT fetching: last_refreshed is unset. Run `refresh` to fetch it."
                    .into(),
            ])
        }

        Op::Refresh { url } => {
            let now = now_unix();
            match url {
                None => {
                    let results = mgr.refresh_all(now).await;
                    let ok = results.iter().filter(|(_, r)| r.is_ok()).count();
                    let mut out = vec![format!("Refreshed {ok}/{} feed(s):", results.len())];
                    if results.is_empty() {
                        out.push("  (nothing subscribed)".into());
                    } else {
                        for (id, res) in &results {
                            out.push(refresh_line(id, res));
                        }
                    }
                    Ok(out)
                }
                Some(url) => {
                    let id = require_subscription(mgr, &url)?;
                    let r = mgr.refresh(&id, now).await.map_err(|e| anyhow!("{e}"))?;
                    Ok(vec![refresh_line(&id, &Ok(r))])
                }
            }
        }

        Op::Episodes { url } => {
            let id = require_subscription(mgr, &url)?;
            let Some(cached) = mgr.episodes(&id) else {
                return Ok(vec![format!(
                    "{id}: no cached episodes yet — run `refresh {id}` (a subscription with no \
                     cached feed has not been fetched since it was stored)"
                )]);
            };
            // The *display* name, the same derivation `subscription_line` prints: the
            // cache keeps the feed's raw `title` (markup and all), so header and list
            // used to name one show two different ways.
            let mut out = vec![format!(
                "{}: {} episode(s), cached {}",
                amos_podcast::feed::display_title(&cached.feed, &id),
                cached.feed.episodes.len(),
                format_time(cached.fetched_at)
            )];
            if cached.feed.truncated {
                out.push(
                    "  note: the feed declared more episodes than were collected — this list is \
                     the head, not the whole feed"
                        .into(),
                );
            }
            let subs = mgr.subscriptions().iter().find(|s| s.feed_id == id);
            if let Some(s) = subs {
                if s.last_refreshed.is_none() {
                    out.push("  note: this subscription has never been refreshed".into());
                }
            }
            if cached.feed.episodes.is_empty() {
                out.push("  (the feed lists no episodes)".into());
            }
            for (i, ep) in cached.feed.episodes.iter().enumerate() {
                let uid = episode_uid(&id, &ep.id);
                let playhead = pos(mgr.progress().position(&uid));
                out.push(episode_line(
                    i,
                    ep,
                    &playhead,
                    mgr.progress().is_played(&uid),
                ));
            }
            Ok(out)
        }

        Op::Unsubscribe { url } => {
            let id = require_subscription(mgr, &url)?;
            let r = mgr.unsubscribe(&id).map_err(|e| anyhow!("{e}"))?;
            Ok(vec![format!(
                "unsubscribed {id} (subscription removed={}, cache dropped={}, playheads cleared={})",
                r.removed_subscription, r.dropped_cached_episodes, r.cleared_progress_records
            )])
        }

        Op::Progress { url, episode } => {
            let id = require_subscription(mgr, &url)?;
            let uid = episode_uid(&id, &episode);
            let p = mgr.progress();
            let stored = p.get(&uid).is_some();
            let mut out = vec![format!("{uid}:")];
            out.push(format!("  position:  {}", pos(p.position(&uid))));
            out.push(format!(
                "  speed:     {}x",
                p.speed_for(&uid).unwrap_or(1.0)
            ));
            out.push(format!("  finished:  {}", p.is_played(&uid)));
            if !stored {
                out.push(
                    "  (no record: this episode has never been played — not the same as a \
                     playhead of 0s)"
                        .into(),
                );
            }
            let dl = mgr.downloads().state(&uid);
            out.push(format!("  download:  {}", download_label(&dl)));
            Ok(out)
        }

        Op::Play {
            url,
            episode,
            position,
            duration,
        } => {
            let id = require_subscription(mgr, &url)?;
            let uid = episode_uid(&id, &episode);
            mgr.progress_mut()
                .set_position(&uid, position, duration, now_unix())
                .map_err(|e| anyhow!("{e}"))?;
            let stored = mgr.progress().position(&uid).unwrap_or(0.0);
            // `set_position` keeps a previously measured `observed_duration_secs` when a
            // later update passes `None`, so a run that omits `--duration` must read that
            // measurement back rather than telling the user to go take one we already hold.
            let measured = duration.or_else(|| {
                mgr.progress()
                    .get(&uid)
                    .and_then(|p| p.observed_duration_secs)
            });
            match progress_fraction(stored, measured) {
                Some(f) => Ok(vec![format!(
                    "{uid}: playhead {stored:.0}s ({:.0}% of the measured duration)",
                    f * 100.0
                )]),
                None => Ok(vec![format!(
                    "{uid}: playhead {stored:.0}s (no duration known yet, so no percentage — \
                     pass --duration <SECS> once the player has measured one)"
                )]),
            }
        }

        Op::Speed { url, episode, rate } => {
            let id = require_subscription(mgr, &url)?;
            let uid = episode_uid(&id, &episode);
            mgr.progress_mut()
                .set_speed(&uid, rate, now_unix())
                .map_err(|e| anyhow!("{e}"))?;
            let applied = mgr.progress().speed_for(&uid).unwrap_or(1.0);
            let clamp_note = if (clamp_speed(rate) - rate).abs() > f64::EPSILON {
                " (clamped to the supported 0.25..4.0 range)"
            } else {
                ""
            };
            Ok(vec![format!("{uid}: speed {applied}x{clamp_note}")])
        }

        Op::SetPlayed {
            url,
            episode,
            played,
        } => {
            let id = require_subscription(mgr, &url)?;
            let uid = episode_uid(&id, &episode);
            mgr.progress_mut()
                .set_played(&uid, played, now_unix())
                .map_err(|e| anyhow!("{e}"))?;
            let verb = if played {
                "marked finished"
            } else {
                "un-marked"
            };
            Ok(vec![format!("{uid}: {verb}")])
        }

        Op::EnqueueDownload {
            url,
            episode,
            audio_dir,
        } => {
            let id = require_subscription(mgr, &url)?;
            let uid = episode_uid(&id, &episode);
            // There must be somewhere to write the bytes. With no store dir the
            // manager runs in memory and a download would record a `Done` for a
            // file that was never written — so refuse before moving anything.
            let Some(dir) = audio_dir else {
                return Err(anyhow!(
                    "no download directory: pass --dir <DIR> (or set $AMOS_PODCAST_DIR) so the audio has somewhere to go"
                ));
            };
            // Routed through the manager, not `downloads_mut()`: the manager is
            // what actually moves the bytes (and an episode the cache does not
            // hold, or that has no audio, is refused rather than recorded as a
            // queue that can never drain).
            let before = mgr.downloads().state(&uid);
            let state = mgr
                .run_download(&id, &episode, &dir, now_unix())
                .await
                .map_err(|e| anyhow!("{e}"))?;
            let label = download_label(&state);
            match before {
                // Already in hand: the manager did not re-fetch, and the CLI says
                // so rather than implying a second transfer happened.
                DownloadState::Done { .. }
                | DownloadState::Downloading { .. }
                | DownloadState::Queued => Ok(vec![format!("{uid}: not re-run — already {label}")]),
                _ => Ok(vec![format!("{uid}: {label}")]),
            }
        }

        Op::DownloadStatus { url, episode } => {
            let id = require_subscription(mgr, &url)?;
            let uid = episode_uid(&id, &episode);
            let state = mgr.downloads().state(&uid);
            let mut out = vec![format!("{uid}: {}", download_label(&state))];
            if let Some(rec) = mgr.downloads().get(&uid) {
                out.push(format!(
                    "  attempts: {}, updated {}",
                    rec.attempts,
                    format_time(rec.updated_at)
                ));
                if let DownloadState::Failed { .. } = rec.state {
                    out.push(format!(
                        "  a retry is {} (delay {}s after attempt {})",
                        if amos_podcast::download::should_retry(rec.attempts) {
                            "allowed"
                        } else {
                            "exhausted"
                        },
                        amos_podcast::download::retry_delay(rec.attempts).as_secs(),
                        rec.attempts
                    ));
                }
            }
            Ok(out)
        }

        Op::RemoveDownload { url, episode } => {
            let id = require_subscription(mgr, &url)?;
            let uid = episode_uid(&id, &episode);
            let removed = mgr
                .downloads_mut()
                .remove(&uid)
                .map_err(|e| anyhow!("{e}"))?;
            if removed {
                Ok(vec![format!(
                    "{uid}: download record removed (any file it named is the caller's to delete)"
                )])
            } else {
                Ok(vec![format!("{uid}: no download record to remove")])
            }
        }
    }
}

/// The current unix time, or `0` when the clock is set before the epoch. A
/// pre-epoch clock is a broken environment, not a reason to fail a subscribe.
fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// An offline sample session over one ephemeral manager: subscribe -> episodes
/// -> playhead -> refresh -> unsubscribe.
async fn demo_lines() -> Result<Vec<String>> {
    let mut mgr = PodcastManager::new(MockFeedProvider::new(), PodcastPaths::default());
    let mut out = vec!["amos-podcast-cli demo (offline MockFeedProvider)".to_string()];

    let url = "https://feeds.amos.dev/rust-weekly.xml";
    let sub = mgr
        .subscribe(url, 1_700_000_000)
        .await
        .map_err(|e| anyhow!("{e}"))?;
    out.push(format!(
        "  subscribed {} — {}",
        sub.url,
        sub.display_title()
    ));

    let count = mgr
        .episodes(&sub.feed_id)
        .map(|c| c.feed.episodes.len())
        .unwrap_or(0);
    out.push(format!("    -> {count} episode(s) cached"));

    let uid = episode_uid(&sub.feed_id, "rw-3");
    out.push(format!(
        "  before playing, {} position is: {}",
        uid,
        pos(mgr.progress().position(&uid))
    ));
    mgr.progress_mut()
        .set_position(&uid, 600.0, Some(2755.0), 1_700_000_100)
        .map_err(|e| anyhow!("{e}"))?;
    out.push(format!(
        "    -> after playing 600s of a measured 2755s: {}",
        pos(mgr.progress().position(&uid))
    ));

    let refreshed = mgr
        .refresh(&sub.feed_id, 1_700_001_000)
        .await
        .map_err(|e| anyhow!("{e}"))?;
    out.push(format!(
        "  refreshed {} at {}",
        refreshed.title,
        format_time(refreshed.fetched_at)
    ));

    let gone = mgr.unsubscribe(&sub.feed_id).map_err(|e| anyhow!("{e}"))?;
    out.push(format!(
        "  unsubscribed: cache dropped={}, playheads cleared={}",
        gone.dropped_cached_episodes, gone.cleared_progress_records
    ));
    out.push("  (try `amos-podcast-cli subscribe https://feeds.amos.dev/systems-cast.xml`)".into());
    Ok(out)
}

/// Build a store-path set from `--dir` / `$AMOS_PODCAST_DIR`.
fn paths_from(args: &[String]) -> PodcastPaths {
    match store_dir(args) {
        Some(dir) => PodcastPaths {
            subscriptions: Some(dir.join("subscriptions.json")),
            library: Some(dir.join("library.json")),
            progress: Some(dir.join("progress.json")),
            downloads: Some(dir.join("downloads.json")),
        },
        None => PodcastPaths::default(),
    }
}

/// Parse args, build the manager (offline mock, or the real HTTP provider when
/// `--live` is given in a `live` build), dispatch, and print the resulting lines.
pub async fn run(args: &[String]) -> Result<Vec<String>> {
    let op = parse_args(args)?;
    let paths = paths_from(args);
    if wants_live(args) {
        #[cfg(feature = "live")]
        {
            let provider = amos_podcast::HttpFeedProvider::new();
            let mut mgr = PodcastManager::new(provider, paths);
            return dispatch(&mut mgr, op).await;
        }
        #[cfg(not(feature = "live"))]
        {
            // Refuse loudly: silently handing back the demo feed would look like
            // a successful real fetch.
            return Err(anyhow!(
                "--live needs a live build: compile with `cargo run -p amos-podcast-cli --features live`"
            ));
        }
    }
    let mut mgr = PodcastManager::new(MockFeedProvider::new(), paths);
    dispatch(&mut mgr, op).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use amos_podcast::MockFeedProvider;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn s(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    fn mgr() -> PodcastManager<MockFeedProvider> {
        PodcastManager::new(MockFeedProvider::new(), PodcastPaths::default())
    }

    /// A fresh temp directory for one test's downloaded audio.
    fn tmp_audio_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "amos-podcast-cli-dl-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    const RW: &str = "https://feeds.amos.dev/rust-weekly.xml";

    #[test]
    fn usage_documents_the_live_refusal_and_the_persist_flag() {
        assert!(
            USAGE.contains("--dir <PATH>"),
            "the persistence flag is named"
        );
        assert!(
            USAGE.contains("refuses loudly"),
            "a non-live build refuses --live rather than silently using the mock"
        );
        assert!(
            !USAGE.contains("ignores it"),
            "it does not silently ignore --live"
        );
    }

    #[test]
    fn parse_known_subcommands() {
        assert_eq!(parse_args(&s(&[])).unwrap(), Op::Help);
        assert_eq!(parse_args(&s(&["help"])).unwrap(), Op::Help);
        assert_eq!(parse_args(&s(&["--version"])).unwrap(), Op::Version);
        assert_eq!(parse_args(&s(&["-V"])).unwrap(), Op::Version);
        assert_eq!(parse_args(&s(&["list", "--version"])).unwrap(), Op::Version);
        assert_eq!(
            parse_args(&s(&["subscriptions"])).unwrap(),
            Op::Subscriptions
        );
        assert_eq!(parse_args(&s(&["list"])).unwrap(), Op::Subscriptions);
        assert_eq!(parse_args(&s(&["demo"])).unwrap(), Op::Demo);
        assert_eq!(
            parse_args(&s(&["subscribe", RW])).unwrap(),
            Op::Subscribe { url: RW.into() }
        );
        // `--live` is a global switch: it must not be mistaken for the subcommand.
        assert_eq!(
            parse_args(&s(&["--live", "subscribe", RW])).unwrap(),
            Op::Subscribe { url: RW.into() }
        );
        // Only the switch, no subcommand: help, not an "unknown subcommand".
        assert_eq!(parse_args(&s(&["--live"])).unwrap(), Op::Help);
        assert_eq!(
            parse_args(&s(&["refresh"])).unwrap(),
            Op::Refresh { url: None }
        );
        assert_eq!(
            parse_args(&s(&["refresh", RW])).unwrap(),
            Op::Refresh {
                url: Some(RW.into())
            }
        );
        assert_eq!(
            parse_args(&s(&["episodes", RW])).unwrap(),
            Op::Episodes { url: RW.into() }
        );
        assert_eq!(
            parse_args(&s(&["played", RW, "rw-3"])).unwrap(),
            Op::SetPlayed {
                url: RW.into(),
                episode: "rw-3".into(),
                played: true
            }
        );
        assert_eq!(
            parse_args(&s(&["unplayed", RW, "rw-3"])).unwrap(),
            Op::SetPlayed {
                url: RW.into(),
                episode: "rw-3".into(),
                played: false
            }
        );
    }

    #[test]
    fn parse_play_carries_position_and_optional_measured_duration() {
        assert_eq!(
            parse_args(&s(&["play", RW, "rw-3", "600"])).unwrap(),
            Op::Play {
                url: RW.into(),
                episode: "rw-3".into(),
                position: 600.0,
                duration: None
            }
        );
        assert_eq!(
            parse_args(&s(&["play", RW, "rw-3", "600", "--duration", "2755.5"])).unwrap(),
            Op::Play {
                url: RW.into(),
                episode: "rw-3".into(),
                position: 600.0,
                duration: Some(2755.5)
            }
        );
    }

    #[test]
    fn parse_rejects_bad_input() {
        assert!(parse_args(&s(&["nope"])).is_err());
        assert!(parse_args(&s(&["subscribe"])).is_err(), "url required");
        assert!(
            parse_args(&s(&["subscribe", "a", "b"])).is_err(),
            "one url only"
        );
        assert!(
            parse_args(&s(&["refresh", "a", "b"])).is_err(),
            "at most one url"
        );
        assert!(
            parse_args(&s(&["play", RW, "rw-3"])).is_err(),
            "secs required"
        );
        assert!(
            parse_args(&s(&["speed", RW, "rw-3", "fast"])).is_err(),
            "not a number"
        );
        // A non-finite playhead would poison the stored record.
        assert!(parse_args(&s(&["play", RW, "rw-3", "inf"])).is_err());
        assert!(parse_args(&s(&["play", RW, "rw-3", "NaN"])).is_err());
    }

    #[test]
    fn a_value_flag_without_a_value_is_rejected_not_silently_dropped() {
        let err = parse_args(&s(&["--dir"])).unwrap_err();
        assert!(err.to_string().contains("--dir"), "{err}");
        let err = parse_args(&s(&["add", RW, "--title"])).unwrap_err();
        assert!(err.to_string().contains("--title"), "{err}");
        assert!(
            parse_args(&s(&["--duration", ""])).is_err(),
            "empty value rejected"
        );
    }

    #[test]
    fn value_flags_are_stripped_from_the_subcommand_positionals() {
        let args = s(&["--dir", "/tmp/x", "subscribe", RW]);
        assert_eq!(parse_args(&args).unwrap(), Op::Subscribe { url: RW.into() });
        assert_eq!(store_dir(&args), Some(PathBuf::from("/tmp/x")));

        let args = s(&["add", RW, "--title", "Rust Weekly"]);
        assert_eq!(
            parse_args(&args).unwrap(),
            Op::Add {
                url: RW.into(),
                title: Some("Rust Weekly".into())
            }
        );
        assert!(store_dir(&s(&["subscriptions"])).is_none());
    }

    /// A value flag on a command that does not read it is a refusal, not a
    /// swallow: `subscribe --title X` used to parse fine and lose the name.
    #[test]
    fn a_value_flag_the_command_does_not_read_is_refused() {
        let err = parse_args(&s(&["subscribe", RW, "--title", "Mine"])).unwrap_err();
        assert!(err.to_string().contains("--title"), "{err}");
        let err = parse_args(&s(&["refresh", "--duration", "60"])).unwrap_err();
        assert!(err.to_string().contains("--duration"), "{err}");
        // Positive controls: the commands that *do* read them still parse.
        assert!(parse_args(&s(&["add", RW, "--title", "Mine"])).is_ok());
        assert!(parse_args(&s(&["play", RW, "rw-3", "60", "--duration", "120"])).is_ok());
        // `--dir` is global and read everywhere.
        assert!(parse_args(&s(&["subscribe", RW, "--dir", "/tmp/x"])).is_ok());
    }

    #[test]
    fn renderings_never_fold_an_unknown_into_a_zero() {
        // Unknown duration is an em dash, never `0:00`.
        assert_eq!(dur(None), "—");
        assert_eq!(dur(Some(0)), "0:00");
        // Absolute absence of a playhead is an em dash, never `0s`.
        assert_eq!(pos(None), "—");
        assert_eq!(pos(Some(0.0)), "0s");
    }

    /// A failed refresh may only claim the stored snapshot survived when the
    /// failure happened **before** the write. A fetch/parse failure leaves the
    /// cache alone; a store failure may *be* the write, so nothing is claimed —
    /// the same line the bridge's `kept_previous_cache` draws (REQ-A1570).
    #[test]
    fn a_failed_refresh_does_not_claim_the_cache_survived_when_it_could_not_have() {
        use amos_podcast::PodcastError;
        let id = "https://x/f";
        let fetch = refresh_line(id, &Err(PodcastError::FetchFailed("net down".into())));
        assert!(fetch.contains("previous cache is left intact"), "{fetch}");
        let parse = refresh_line(id, &Err(PodcastError::ParseFailed("bad xml".into())));
        assert!(parse.contains("previous cache is left intact"), "{parse}");
        let store = refresh_line(id, &Err(PodcastError::StoreWriteFailed("disk full".into())));
        assert!(
            !store.contains("previous cache is left intact"),
            "a store failure may be the write itself: {store}"
        );
    }

    #[tokio::test]
    async fn subscribe_then_list_then_episodes_round_trips() {
        let mut m = mgr();
        let out = dispatch(&mut m, Op::Subscribe { url: RW.into() })
            .await
            .unwrap();
        assert!(out[0].contains("subscribed"), "{out:?}");

        let list = dispatch(&mut m, Op::Subscriptions).await.unwrap();
        assert!(list[0].contains("1 feed(s)"), "{list:?}");
        assert!(list[1].contains(RW), "{list:?}");
        assert!(
            list[1].contains("refreshed"),
            "a subscribed feed reports its refresh: {list:?}"
        );

        let eps = dispatch(&mut m, Op::Episodes { url: RW.into() })
            .await
            .unwrap();
        assert!(eps[0].contains("3 episode(s)"), "{eps:?}");
        assert!(eps.iter().any(|l| l.contains("rw-3")), "{eps:?}");
        // Nothing has been played, so every row's playhead is absent (—).
        assert!(eps.iter().any(|l| l.contains("playhead —")), "{eps:?}");
    }

    /// A feed's *name* is drawn by `subscriptions`, `subscribe` and `add` through
    /// `display_title` — the markup-stripped form. The `episodes` header printed the
    /// cache's **raw** `title` instead, so one show read `Rust & Friends` in
    /// `subscriptions` and `<b>Rust</b> & Friends` in `episodes`.
    #[tokio::test]
    async fn episodes_names_the_feed_the_way_subscriptions_does() {
        let mut m = PodcastManager::new(
            MockFeedProvider::with_feeds(vec![(
                RW.to_string(),
                amos_podcast::Feed {
                    title: "<b>Rust</b> &amp; Friends".into(),
                    episodes: vec![amos_podcast::Episode {
                        id: "e1".into(),
                        title: "One".into(),
                        description: String::new(),
                        audio_url: Some("https://cdn.amos.dev/1.mp3".into()),
                        duration_secs: None,
                        published: None,
                    }],
                    ..Default::default()
                },
            )]),
            PodcastPaths::default(),
        );
        dispatch(&mut m, Op::Subscribe { url: RW.into() })
            .await
            .unwrap();

        let subs = dispatch(&mut m, Op::Subscriptions).await.unwrap();
        let eps = dispatch(&mut m, Op::Episodes { url: RW.into() })
            .await
            .unwrap();

        assert!(
            !eps[0].contains("<b>"),
            "the header drew the raw cache title: {eps:?}"
        );
        assert!(
            eps[0].starts_with("Rust & Friends:"),
            "the header must carry the same name `subscriptions` prints: {eps:?}"
        );
        assert!(
            subs.iter().any(|l| l.contains("Rust & Friends")),
            "the positive control: the sibling really does strip: {subs:?}"
        );
    }

    /// An episode the feed left untitled is drawn like every other absent field
    /// on the row (`—`), not with a word the program invented. The domain used to
    /// write an English `"Untitled"` into the cached feed, so this line — and the
    /// GUI — read English in every locale, and the fabricated name was
    /// indistinguishable from a feed that really named an episode that way.
    #[tokio::test]
    async fn an_untitled_episode_row_prints_an_absent_marker_not_a_made_up_name() {
        let mut m = PodcastManager::new(
            MockFeedProvider::with_feeds(vec![(
                RW.to_string(),
                amos_podcast::Feed {
                    title: "Rust Weekly".into(),
                    episodes: vec![amos_podcast::Episode {
                        id: "e1".into(),
                        title: String::new(),
                        description: String::new(),
                        audio_url: None,
                        duration_secs: None,
                        published: None,
                    }],
                    ..Default::default()
                },
            )]),
            PodcastPaths::default(),
        );
        dispatch(&mut m, Op::Subscribe { url: RW.into() })
            .await
            .unwrap();

        let eps = dispatch(&mut m, Op::Episodes { url: RW.into() })
            .await
            .unwrap();
        let row = eps.iter().find(|l| l.contains("e1")).unwrap();
        assert!(row.ends_with("—"), "an absent title draws —: {row:?}");
        assert!(
            !row.contains("Untitled"),
            "the row must not carry a fabricated name: {row:?}"
        );
    }

    #[tokio::test]
    async fn a_subscription_added_without_fetching_says_so() {
        let mut m = mgr();
        let out = dispatch(
            &mut m,
            Op::Add {
                url: "https://example.com/f.xml".into(),
                title: Some("Later".into()),
            },
        )
        .await
        .unwrap();
        assert!(out[0].contains("Later"), "{out:?}");
        assert!(out[1].contains("WITHOUT fetching"), "{out:?}");

        // `episodes` on a never-fetched subscription names the missing cache
        // rather than showing an empty list as "no episodes".
        let eps = dispatch(
            &mut m,
            Op::Episodes {
                url: "https://example.com/f.xml".into(),
            },
        )
        .await
        .unwrap();
        assert!(eps[0].contains("no cached episodes"), "{eps:?}");

        let list = dispatch(&mut m, Op::Subscriptions).await.unwrap();
        assert!(list[1].contains("NEVER refreshed"), "{list:?}");
    }

    #[tokio::test]
    async fn a_failed_fetch_leaves_no_subscription_behind() {
        let mut m = mgr();
        assert!(dispatch(
            &mut m,
            Op::Subscribe {
                url: "https://feeds.amos.dev/broken.xml".into()
            }
        )
        .await
        .is_err());
        let list = dispatch(&mut m, Op::Subscriptions).await.unwrap();
        assert!(list[0].contains("0 feed(s)"), "{list:?}");
    }

    #[tokio::test]
    async fn unsubscribe_reports_what_it_cleaned_up() {
        let mut m = mgr();
        dispatch(&mut m, Op::Subscribe { url: RW.into() })
            .await
            .unwrap();
        let uid = episode_uid(RW, "rw-3");
        dispatch(
            &mut m,
            Op::Play {
                url: RW.into(),
                episode: "rw-3".into(),
                position: 10.0,
                duration: Some(100.0),
            },
        )
        .await
        .unwrap();
        assert!(m.progress().get(&uid).is_some());

        let out = dispatch(&mut m, Op::Unsubscribe { url: RW.into() })
            .await
            .unwrap();
        assert!(out[0].contains("playheads cleared=1"), "{out:?}");
        assert!(m.progress().get(&uid).is_none());
    }

    #[tokio::test]
    async fn refresh_all_continues_past_a_dead_feed_and_reports_it() {
        let mut m = mgr();
        dispatch(&mut m, Op::Subscribe { url: RW.into() })
            .await
            .unwrap();
        // A second subscription whose feed the mock refuses to serve.
        dispatch(
            &mut m,
            Op::Add {
                url: "https://feeds.amos.dev/broken.xml".into(),
                title: None,
            },
        )
        .await
        .unwrap();

        let out = dispatch(&mut m, Op::Refresh { url: None }).await.unwrap();
        assert!(out[0].contains("1/2 feed(s)"), "{out:?}");
        assert!(out.iter().any(|l| l.contains("FAILED")), "{out:?}");
        assert!(
            out.iter()
                .any(|l| l.contains("previous cache is left intact")),
            "{out:?}"
        );
    }

    #[tokio::test]
    async fn commands_refuse_an_unsubscribed_url_with_a_named_error() {
        let mut m = mgr();
        for op in [
            Op::Episodes { url: RW.into() },
            Op::Unsubscribe { url: RW.into() },
            Op::Progress {
                url: RW.into(),
                episode: "rw-3".into(),
            },
        ] {
            let err = dispatch(&mut m, op).await.unwrap_err();
            assert!(err.to_string().contains("not subscribed"), "{err}");
        }
        // A non-http scheme is refused at the boundary, not fetched.
        let err = dispatch(
            &mut m,
            Op::Episodes {
                url: "file:///etc/passwd".into(),
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("http"), "{err}");
    }

    #[tokio::test]
    async fn play_records_a_playhead_and_the_measured_duration_separately() {
        let mut m = mgr();
        dispatch(&mut m, Op::Subscribe { url: RW.into() })
            .await
            .unwrap();

        // No duration known: the line says so rather than printing a percentage.
        let out = dispatch(
            &mut m,
            Op::Play {
                url: RW.into(),
                episode: "rw-3".into(),
                position: 600.0,
                duration: None,
            },
        )
        .await
        .unwrap();
        assert!(out[0].contains("no duration known yet"), "{out:?}");

        // With one, the percentage appears — from the *measured* duration.
        let out = dispatch(
            &mut m,
            Op::Play {
                url: RW.into(),
                episode: "rw-3".into(),
                position: 600.0,
                duration: Some(1200.0),
            },
        )
        .await
        .unwrap();
        assert!(out[0].contains("50%"), "{out:?}");
    }

    /// A later `play` that omits `--duration` does not erase the measurement a
    /// previous one recorded — `set_position` keeps it when passed `None`, and the
    /// record test pins that. So the line must not tell the user to go measure a
    /// duration the store already holds.
    #[tokio::test]
    async fn play_reads_the_stored_measurement_a_later_run_did_not_repeat() {
        let mut m = mgr();
        dispatch(&mut m, Op::Subscribe { url: RW.into() })
            .await
            .unwrap();
        dispatch(
            &mut m,
            Op::Play {
                url: RW.into(),
                episode: "rw-3".into(),
                position: 10.0,
                duration: Some(300.0),
            },
        )
        .await
        .unwrap();

        let out = dispatch(
            &mut m,
            Op::Play {
                url: RW.into(),
                episode: "rw-3".into(),
                position: 150.0,
                duration: None,
            },
        )
        .await
        .unwrap();
        assert!(out[0].contains("50%"), "{out:?}");
        assert!(!out[0].contains("no duration known yet"), "{out:?}");
    }

    #[tokio::test]
    async fn speed_is_clamped_and_says_when_it_was() {
        let mut m = mgr();
        dispatch(&mut m, Op::Subscribe { url: RW.into() })
            .await
            .unwrap();
        let out = dispatch(
            &mut m,
            Op::Speed {
                url: RW.into(),
                episode: "rw-3".into(),
                rate: 99.0,
            },
        )
        .await
        .unwrap();
        assert!(out[0].contains("4x"), "{out:?}");
        assert!(out[0].contains("clamped"), "{out:?}");
    }

    #[tokio::test]
    async fn played_and_unplayed_move_the_finished_flag() {
        let mut m = mgr();
        dispatch(&mut m, Op::Subscribe { url: RW.into() })
            .await
            .unwrap();
        dispatch(
            &mut m,
            Op::SetPlayed {
                url: RW.into(),
                episode: "rw-3".into(),
                played: true,
            },
        )
        .await
        .unwrap();
        assert!(m.progress().is_played(&episode_uid(RW, "rw-3")));
        dispatch(
            &mut m,
            Op::SetPlayed {
                url: RW.into(),
                episode: "rw-3".into(),
                played: false,
            },
        )
        .await
        .unwrap();
        assert!(!m.progress().is_played(&episode_uid(RW, "rw-3")));
    }

    #[tokio::test]
    async fn download_verbs_round_trip_and_never_re_enqueue_a_finished_one() {
        let mut m = mgr();
        dispatch(&mut m, Op::Subscribe { url: RW.into() })
            .await
            .unwrap();
        let uid = episode_uid(RW, "rw-3");
        let dir = tmp_audio_dir("roundtrip");

        let out = dispatch(
            &mut m,
            Op::EnqueueDownload {
                url: RW.into(),
                episode: "rw-3".into(),
                audio_dir: Some(dir.clone()),
            },
        )
        .await
        .unwrap();
        // A real transfer happened: the bytes are on disk and the state is Done.
        assert!(out[0].contains("downloaded ("), "{out:?}");
        assert!(m.downloads().is_done(&uid));

        // Running it again does not re-fetch bytes we already have, and says so.
        let out = dispatch(
            &mut m,
            Op::EnqueueDownload {
                url: RW.into(),
                episode: "rw-3".into(),
                audio_dir: Some(dir.clone()),
            },
        )
        .await
        .unwrap();
        assert!(out[0].contains("not re-run"), "{out:?}");

        m.downloads_mut()
            .finish(&uid, "/tmp/rw-3.mp3".into(), 1234, 9)
            .unwrap();
        let out = dispatch(
            &mut m,
            Op::DownloadStatus {
                url: RW.into(),
                episode: "rw-3".into(),
            },
        )
        .await
        .unwrap();
        assert!(out[0].contains("downloaded (1234 bytes)"), "{out:?}");

        let out = dispatch(
            &mut m,
            Op::RemoveDownload {
                url: RW.into(),
                episode: "rw-3".into(),
            },
        )
        .await
        .unwrap();
        assert!(out[0].contains("removed"), "{out:?}");
        // Removing again is a clean "nothing to do", not an error.
        let out = dispatch(
            &mut m,
            Op::RemoveDownload {
                url: RW.into(),
                episode: "rw-3".into(),
            },
        )
        .await
        .unwrap();
        assert!(out[0].contains("no download record"), "{out:?}");
    }

    /// With no store directory there is nowhere to write the audio, so the verb
    /// refuses instead of recording a `Done` for a file that was never written.
    #[tokio::test]
    async fn download_refuses_when_there_is_nowhere_to_write() {
        let mut m = mgr();
        dispatch(&mut m, Op::Subscribe { url: RW.into() })
            .await
            .unwrap();
        let uid = episode_uid(RW, "rw-3");
        let err = dispatch(
            &mut m,
            Op::EnqueueDownload {
                url: RW.into(),
                episode: "rw-3".into(),
                audio_dir: None,
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("no download directory"), "{err}");
        assert!(
            !m.downloads().is_done(&uid),
            "nothing was downloaded, so nothing may read as done"
        );
    }

    #[tokio::test]
    async fn progress_reports_a_failed_download_with_its_retry_policy() {
        let mut m = mgr();
        dispatch(&mut m, Op::Subscribe { url: RW.into() })
            .await
            .unwrap();
        let uid = episode_uid(RW, "rw-3");
        m.downloads_mut().start(&uid, 1).unwrap();
        m.downloads_mut()
            .fail(&uid, "connection reset".into(), 2)
            .unwrap();

        let out = dispatch(
            &mut m,
            Op::DownloadStatus {
                url: RW.into(),
                episode: "rw-3".into(),
            },
        )
        .await
        .unwrap();
        assert!(out[0].contains("FAILED: connection reset"), "{out:?}");
        assert!(
            out.iter().any(|l| l.contains("retry is allowed")),
            "{out:?}"
        );
    }

    #[tokio::test]
    async fn version_prints_the_package_version() {
        let lines = run(&s(&["--version"])).await.unwrap();
        assert_eq!(
            lines,
            vec![format!("amos-podcast-cli {}", env!("CARGO_PKG_VERSION"))]
        );
    }

    #[tokio::test]
    async fn run_demo_plays_an_offline_session() {
        let out = run(&s(&["demo"])).await.unwrap();
        let joined = out.join("\n");
        assert!(joined.contains("subscribed"), "{joined}");
        assert!(joined.contains("position is: —"), "{joined}");
        assert!(joined.contains("refreshed"), "{joined}");
        assert!(joined.contains("playheads cleared=1"), "{joined}");
    }

    #[cfg(not(feature = "live"))]
    #[tokio::test]
    async fn a_non_live_build_refuses_live_rather_than_falling_back_to_the_mock() {
        let err = run(&s(&["--live", "subscriptions"])).await.unwrap_err();
        assert!(err.to_string().contains("needs a live build"), "{err}");
    }

    #[cfg(feature = "live")]
    #[tokio::test]
    async fn a_live_build_uses_the_http_provider() {
        // `--live` only changes which provider is built; the op is the same.
        // Point it at an unroutable host so the test never depends on a network.
        let err = run(&s(&["--live", "subscribe", "https://127.0.0.1:1/nope.xml"]))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("fetch"), "{err}");
    }

    #[tokio::test]
    async fn run_persists_state_across_invocations_via_dir() {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "amos-podcast-cli-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let dir_s = dir.to_string_lossy().to_string();

        let out = run(&s(&["--dir", &dir_s, "subscribe", RW])).await.unwrap();
        assert!(out[0].contains("subscribed"), "{out:?}");
        run(&s(&["--dir", &dir_s, "play", RW, "rw-3", "42"]))
            .await
            .unwrap();

        // A fresh process-equivalent sees both the subscription and the playhead.
        let list = run(&s(&["--dir", &dir_s, "subscriptions"])).await.unwrap();
        assert!(list[0].contains("1 feed(s)"), "{list:?}");

        let eps = run(&s(&["--dir", &dir_s, "episodes", RW])).await.unwrap();
        assert!(eps.iter().any(|l| l.contains("playhead 42s")), "{eps:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_corrupt_store_file_is_reported_not_silently_a_first_run() {
        static SEQ: AtomicU64 = AtomicU64::new(1);
        let dir = std::env::temp_dir().join(format!(
            "amos-podcast-cli-corrupt-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("subscriptions.json"), b"{not json").unwrap();

        // The store falls back to empty (reported via its own tracing warning)
        // rather than failing the whole command.
        let list = run(&s(&["--dir", &dir.to_string_lossy(), "subscriptions"]))
            .await
            .unwrap();
        assert!(list[0].contains("0 feed(s)"), "{list:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
