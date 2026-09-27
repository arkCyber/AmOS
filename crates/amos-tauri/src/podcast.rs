//! Tauri <-> podcast bridge.
//!
//! Exposes the podcast engine ([`amos_podcast::PodcastManager`]) to the WebView.
//! The managed [`PodcastBridge`] wraps a manager over a **type-erased**
//! [`FeedProvider`](amos_podcast::FeedProvider), so the same commands drive the
//! offline mock and (in a `podcast-live` build, with `AMOS_PODCAST_LIVE=1`) a
//! real HTTP fetcher.
//!
//! # Why the bridge owns the join
//!
//! A screen renders a *feed* — its metadata plus, per episode, the playhead,
//! the speed, the finished flag and the download state. Those live in four
//! different stores. [`PodcastBridge::feed_view`] joins them **server-side** so
//! the UI makes one call per screen instead of N+1, and so the four stores
//! cannot be read at four different instants by a caller that then renders them
//! as one snapshot.
//!
//! # Honest absence is carried across this seam
//!
//! Every optional field stays optional in the payload: `duration_secs`,
//! `published`, `position_secs` and `observed_duration_secs` are
//! `Option`/`null`. That is deliberate and load-bearing — a bridge that folded
//! them into `0` would leave the UI unable to say "the feed never stated a
//! duration" or "you have never played this", which is the whole point of the
//! domain modelling them that way.
//!
//! # Locking
//!
//! The manager's mutating operations take `&mut self`, and `subscribe` /
//! `refresh` hold that borrow **across an await** (they fetch, then store). The
//! lock is therefore a [`tokio::sync::Mutex`] rather than a `std` one: a
//! `std::sync::MutexGuard` is not `Send`, so holding it across an await would
//! make every command future non-`Send` and unusable from Tauri's executor.
//!
//! `tokio`'s mutex does not poison, which is the behaviour this bridge wants —
//! a caller must not be locked out of the podcast feature forever because some
//! unrelated task panicked while holding the lock. (Nothing here can panic under
//! it anyway: the domain crate is built against the P0-1 gate.)

use std::path::PathBuf;

use amos_podcast::{
    episode_uid, feed::display_title, DownloadState, Episode, FeedProvider, MockFeedProvider,
    PodcastError, PodcastManager, PodcastPaths, Subscription, MAX_ID_BYTES,
};
use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

use crate::error::{AmosError, ErrorCode};

/// Result type used by every podcast Tauri command.
pub type PodcastResult<T> = Result<T, AmosError>;

#[cfg(feature = "podcast-live")]
use amos_podcast::HttpFeedProvider;

/// Managed podcast engine state.
pub struct PodcastBridge {
    manager: Mutex<PodcastManager<Box<dyn FeedProvider>>>,
    /// Where downloaded audio is written. `None` when no store directory is
    /// configured — an ephemeral bridge has nowhere to put a file, so a download
    /// is refused rather than written somewhere the user did not choose.
    audio_dir: Option<PathBuf>,
}

/// The provider this process uses: a real HTTP fetcher when `AMOS_PODCAST_LIVE`
/// is a **truthy token** *and* the bridge is built with `podcast-live`, otherwise
/// the offline mock. Without the feature the env var is ignored, so the default
/// UI build cannot reach the network.
fn provider() -> Box<dyn FeedProvider> {
    #[cfg(feature = "podcast-live")]
    {
        if live_enabled() {
            // One bucket for every feed: the domain is transport-agnostic, so the
            // bridge does not need a per-subscription provider choice.
            tracing::info!("podcast: using the live HTTP feed provider");
            return Box::new(HttpFeedProvider::new());
        }
    }
    Box::new(MockFeedProvider::new())
}

/// The two token sets of the repo-wide bool-env convention
/// (`docs/ENV_VARIABLES.md` §20.1, coined by `amos-ai`'s `energy::parse_flag`).
#[cfg(feature = "podcast-live")]
const TRUE_TOKENS: [&str; 4] = ["1", "true", "yes", "on"];
#[cfg(feature = "podcast-live")]
const FALSE_TOKENS: [&str; 4] = ["0", "false", "no", "off"];

/// Whether the live HTTP provider is armed, read **strictly**.
///
/// The gate is an *opt-in to the network*, so the safe side is "mock": a value
/// outside the two documented sets — a typo (`enable`), a stray `2`, a
/// blank-but-set string, a non-Unicode one — keeps the mock **and warns**. The
/// previous read (`!v.is_empty() && v != "0"`) armed the live fetcher on
/// `AMOS_PODCAST_LIVE=false` / `no` / `off` and on any typo, i.e. it treated the
/// documented **off** spellings as ON — the opposite of the convention every
/// other bool knob in the tree follows (REQ-A1906).
#[cfg(feature = "podcast-live")]
fn live_enabled() -> bool {
    decide_live(std::env::var_os("AMOS_PODCAST_LIVE").as_deref())
}

/// The **pure** decision behind [`live_enabled`], over the raw env value.
///
/// Split out so the rule can be pinned without mutating the process environment:
/// `AMOS_PODCAST_LIVE` is process-global and `PodcastBridge::new()` reads it, so
/// a test that set it would arm the live fetcher for every other podcast test
/// running in parallel (REQ-A1906).
#[cfg(feature = "podcast-live")]
fn decide_live(raw: Option<&std::ffi::OsStr>) -> bool {
    let Some(raw) = raw else {
        return false; // unset = the documented offline-mock default, quiet
    };
    let Some(raw) = raw.to_str() else {
        tracing::warn!("AMOS_PODCAST_LIVE is set but not valid Unicode; keeping the offline mock");
        return false;
    };
    let token = raw.trim().to_ascii_lowercase();
    if TRUE_TOKENS.contains(&token.as_str()) {
        return true;
    }
    if FALSE_TOKENS.contains(&token.as_str()) {
        return false;
    }
    tracing::warn!(
        value = %raw,
        "AMOS_PODCAST_LIVE is set to a value this gate does not recognise — keeping the offline \
         mock (arm with 1/true/yes/on, stay off with 0/false/no/off)"
    );
    false
}

/// The store paths for this process, from the environment.
///
/// `$AMOS_PODCAST_DIR` puts all four files in one directory; the per-store
/// `$AMOS_PODCAST_SUBSCRIPTIONS` / `_LIBRARY` / `_PROGRESS` / `_DOWNLOADS`
/// override it. With none set the stores are **ephemeral** — the bridge does not
/// write to a user's disk unless it was asked to.
pub fn store_paths() -> PodcastPaths {
    PodcastPaths::from_env()
}

impl PodcastBridge {
    /// Build the bridge from the environment ([`store_paths`] + [`provider`]).
    pub fn new() -> Self {
        Self::with_paths(store_paths())
    }

    /// Build over explicit paths (tests / a caller that owns the layout).
    pub fn with_paths(paths: PodcastPaths) -> Self {
        Self::with_provider(provider(), paths)
    }

    /// Build over an explicit provider and paths.
    ///
    /// The provider is injectable because the bridge's own contract — the
    /// four-store join and the wire shape — is what a test needs to pin, and some
    /// of it (a refresh that fails *after* a successful one) is not expressible
    /// through the fixed catalog the default provider serves.
    pub fn with_provider(provider: Box<dyn FeedProvider>, paths: PodcastPaths) -> Self {
        Self::with_provider_and_dir(provider, paths, audio_dir())
    }

    /// Build over an explicit provider, paths **and** download directory.
    /// Injectable so a test can point downloads at a temp directory instead of
    /// the developer's real `$AMOS_PODCAST_DIR`.
    pub fn with_provider_and_dir(
        provider: Box<dyn FeedProvider>,
        paths: PodcastPaths,
        audio_dir: Option<PathBuf>,
    ) -> Self {
        PodcastBridge {
            manager: Mutex::new(PodcastManager::new(provider, paths)),
            audio_dir,
        }
    }

    /// The backend in use (`"mock"` or `"http"`), so a screen can say which.
    pub async fn provider_name(&self) -> &'static str {
        let guard = self.manager.lock().await;
        guard.provider_name()
    }

    /// One feed's full screen payload, or `None` when the feed is subscribed but
    /// has **no cached snapshot yet** (added without fetching, or never
    /// refreshed). `None` is deliberately not an empty episode list: "we have not
    /// looked" and "there are no episodes" are different sentences.
    pub async fn feed_view(&self, feed_id: &str) -> PodcastResult<Option<PodcastFeedView>> {
        let feed_id = validate_feed_id(feed_id)?;
        let guard = self.manager.lock().await;
        if guard.subscription(&feed_id).is_none() {
            return Err(unknown_feed(&feed_id));
        }
        let Some(cached) = guard.episodes(&feed_id) else {
            return Ok(None);
        };
        let sub = guard.subscription(&feed_id);
        let episodes = cached
            .feed
            .episodes
            .iter()
            .map(|ep| {
                let uid = episode_uid(&feed_id, &ep.id);
                let progress = guard.progress().get(&uid);
                PodcastEpisodeView {
                    episode: ep.clone(),
                    position_secs: progress.map(|p| p.position_secs),
                    observed_duration_secs: progress.and_then(|p| p.observed_duration_secs),
                    played: progress.map(|p| p.played).unwrap_or(false),
                    speed: progress.map(|p| p.speed).unwrap_or(1.0),
                    download: guard.downloads().state(&uid),
                }
            })
            .collect();
        Ok(Some(PodcastFeedView {
            feed_id: feed_id.clone(),
            // The *display* name, not the cache's raw `title`: the cache keeps the feed's
            // markup (that is what `display_title` exists to strip), and the sidebar names
            // this same feed from the subscription's `display_title`. Sending the cache
            // field made one screen show one show under two different names.
            title: display_title(&cached.feed, &feed_id),
            author: cached.feed.author.clone(),
            description: cached.feed.description.clone(),
            link: cached.feed.link.clone(),
            image_url: cached.feed.image_url.clone(),
            truncated: cached.feed.truncated,
            fetched_at: cached.fetched_at,
            last_refreshed: sub.and_then(|s| s.last_refreshed),
            episodes,
        }))
    }

    /// Fetch a feed and subscribe. Fetches **first**, so a feed that cannot be
    /// reached is never written to the subscription list.
    pub async fn subscribe(&self, url: &str, now: i64) -> PodcastResult<Subscription> {
        let mut guard = self.manager.lock().await;
        guard.subscribe(url, now).await.map_err(map_error)
    }

    /// Store a subscription **without** fetching it (the explicit offline path).
    /// Its `last_refreshed` stays `None`, which the UI must render as "never
    /// refreshed" rather than as an empty feed.
    pub async fn add(
        &self,
        url: &str,
        title: Option<&str>,
        now: i64,
    ) -> PodcastResult<Subscription> {
        let mut guard = self.manager.lock().await;
        guard.add_subscription(url, title, now).map_err(map_error)
    }

    /// Re-fetch one feed (`Some`) or every subscribed feed (`None`).
    ///
    /// Always continues past a failure and reports each outcome, so one dead feed
    /// does not stop the others and the caller can show a partial success. On a
    /// failure the previous cache is left intact.
    pub async fn refresh(
        &self,
        feed_id: Option<&str>,
        now: i64,
    ) -> PodcastResult<Vec<PodcastRefresh>> {
        let mut guard = self.manager.lock().await;
        match feed_id {
            Some(id) => {
                let id = validate_feed_id(id)?;
                // Snapshot *before* the fetch: `kept_previous_cache` has to mean
                // "there is a cache the UI can still show", so a first fetch that
                // fails must not claim one was kept.
                let had_cache = guard.episodes(&id).is_some();
                let out = guard.refresh(&id, now).await;
                Ok(vec![refresh_outcome(id, had_cache, out)])
            }
            None => {
                let had: Vec<(String, bool)> = guard
                    .subscriptions()
                    .iter()
                    .map(|s| (s.feed_id.clone(), guard.episodes(&s.feed_id).is_some()))
                    .collect();
                let out = guard.refresh_all(now).await;
                Ok(out
                    .into_iter()
                    .map(|(id, res)| {
                        let had_cache = had.iter().find(|(h, _)| h == &id).is_some_and(|(_, c)| *c);
                        refresh_outcome(id, had_cache, res)
                    })
                    .collect())
            }
        }
    }

    /// Drop a subscription, its cached feed and its playheads.
    ///
    /// Downloaded files are **not** deleted here: the domain crate does not own
    /// their paths, and a bridge that guessed would be deleting a user's files
    /// based on a record it only partially trusts.
    ///
    /// A feed that is not subscribed is [`ErrorCode::PodcastUnknownFeed`], the
    /// same refusal [`PodcastBridge::feed_view`] makes and the same one the CLI's
    /// `require_subscription` makes. The engine's own `Ok(..)` with
    /// `removed_subscription: false` is not "nothing to do" to a *screen*: it is
    /// passed on as a report the caller renders as a completed unsubscribe. So the
    /// guard runs **first**, and the report the screen gets therefore always
    /// describes a removal that happened — which is why [`PodcastUnsubscribe`]
    /// carries no `removed_subscription` to contradict it.
    pub async fn unsubscribe(&self, feed_id: &str) -> PodcastResult<PodcastUnsubscribe> {
        let feed_id = validate_feed_id(feed_id)?;
        let mut guard = self.manager.lock().await;
        if guard.subscription(&feed_id).is_none() {
            return Err(unknown_feed(&feed_id));
        }
        let r = guard.unsubscribe(&feed_id).map_err(map_error)?;
        Ok(PodcastUnsubscribe {
            dropped_cached_episodes: r.dropped_cached_episodes,
            cleared_progress_records: r.cleared_progress_records,
        })
    }

    /// Record a playhead update, plus (when the player has measured one) the
    /// duration it observed — kept apart from the feed's stated duration.
    pub async fn set_position(
        &self,
        feed_id: &str,
        episode_id: &str,
        position_secs: f64,
        observed_duration_secs: Option<f64>,
        now: i64,
    ) -> PodcastResult<()> {
        let uid = validate_uid(feed_id, episode_id)?;
        if !position_secs.is_finite() || position_secs < 0.0 {
            return Err(AmosError::new(
                ErrorCode::PodcastRpcFailed,
                format!(
                    "playhead must be a finite, non-negative number of seconds: {position_secs}"
                ),
            ));
        }
        if let Some(d) = observed_duration_secs {
            if !d.is_finite() || d < 0.0 {
                return Err(AmosError::new(
                    ErrorCode::PodcastRpcFailed,
                    format!("observed duration must be finite and non-negative: {d}"),
                ));
            }
        }
        let mut guard = self.manager.lock().await;
        guard
            .progress_mut()
            .set_position(&uid, position_secs, observed_duration_secs, now)
            .map_err(map_error)
    }

    /// Set one episode's playback rate (clamped by the domain to 0.25x..4.0x).
    pub async fn set_speed(
        &self,
        feed_id: &str,
        episode_id: &str,
        speed: f64,
        now: i64,
    ) -> PodcastResult<f64> {
        let uid = validate_uid(feed_id, episode_id)?;
        let mut guard = self.manager.lock().await;
        guard
            .progress_mut()
            .set_speed(&uid, speed, now)
            .map_err(map_error)?;
        // Report what was actually stored, not what was asked for: the domain
        // clamps, and a UI that echoes the request would lie about the rate.
        Ok(guard.progress().speed_for(&uid).unwrap_or(1.0))
    }

    /// Mark one episode finished (or un-finish it).
    pub async fn set_played(
        &self,
        feed_id: &str,
        episode_id: &str,
        played: bool,
        now: i64,
    ) -> PodcastResult<()> {
        let uid = validate_uid(feed_id, episode_id)?;
        let mut guard = self.manager.lock().await;
        guard
            .progress_mut()
            .set_played(&uid, played, now)
            .map_err(map_error)
    }

    /// Download one episode now: move its enclosure bytes through the provider
    /// and write them under the configured audio directory, returning the
    /// terminal state (`Done` / `Failed`, or the existing state when the episode
    /// is already queued / in flight / downloaded).
    ///
    /// A transport failure is **data**: it is recorded as `Failed` and returned,
    /// not raised — the previous recording is intact and the UI renders a retry.
    /// An episode the cache does not hold, or that has no enclosure URL, is
    /// `PodcastNoAudio` (nothing was attempted). With no audio directory
    /// configured, `PodcastDownloadNoDir` is raised rather than writing the file
    /// somewhere the user did not choose.
    pub async fn download(
        &self,
        feed_id: &str,
        episode_id: &str,
        now: i64,
    ) -> PodcastResult<DownloadState> {
        // Use the *normalized* feed id the seam just accepted: the manager looks
        // the episode up by feed id, so handing it the raw string would miss a
        // padded/whitespace variant and report `NoAudio` about an episode that
        // has audio. (Every sibling command already looks up by the validated id.)
        let feed_id = validate_feed_id(feed_id)?;
        validate_episode_id(episode_id)?;
        let dest = self.audio_dir.clone().ok_or_else(|| {
            AmosError::new(
                ErrorCode::PodcastDownloadNoDir,
                "no download directory: set $AMOS_PODCAST_DIR so the audio has somewhere to go",
            )
        })?;
        let mut guard = self.manager.lock().await;
        guard
            .run_download(&feed_id, episode_id, &dest, now)
            .await
            .map_err(map_error)
    }

    /// One episode's download state.
    pub async fn download_state(
        &self,
        feed_id: &str,
        episode_id: &str,
    ) -> PodcastResult<DownloadState> {
        let uid = validate_uid(feed_id, episode_id)?;
        let guard = self.manager.lock().await;
        Ok(guard.downloads().state(&uid))
    }

    /// Forget a download record. Returns whether one existed; the file it named
    /// is the caller's to delete.
    pub async fn remove_download(&self, feed_id: &str, episode_id: &str) -> PodcastResult<bool> {
        let uid = validate_uid(feed_id, episode_id)?;
        let mut guard = self.manager.lock().await;
        guard.downloads_mut().remove(&uid).map_err(map_error)
    }
}

impl Default for PodcastBridge {
    fn default() -> Self {
        Self::new()
    }
}

/// A feed's metadata plus the per-episode join, ready for one screen.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PodcastFeedView {
    pub feed_id: String,
    /// The feed's **display** name ([`display_title`]): markup stripped from the
    /// cache's raw `title`, falling back to `feed_id` when the feed names itself
    /// nothing. The same derivation [`Subscription::display_title`] uses, so the
    /// sidebar row and this header cannot disagree about what a show is called.
    pub title: String,
    pub author: String,
    pub description: String,
    pub link: String,
    /// `None` when the feed declares no artwork — not an empty string the UI
    /// would render as a broken image.
    pub image_url: Option<String>,
    /// The feed declared more episodes than the parser collected; the UI must say
    /// so rather than presenting this list as the whole feed.
    pub truncated: bool,
    /// When this snapshot was fetched (unix seconds).
    pub fetched_at: i64,
    /// The last **successful** refresh, or `None` when the subscription has never
    /// been fetched — distinct from `Some(0)`.
    pub last_refreshed: Option<i64>,
    pub episodes: Vec<PodcastEpisodeView>,
}

/// One episode with the state the four stores hold about it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PodcastEpisodeView {
    pub episode: Episode,
    /// The stored playhead in seconds, or `None` when nothing is recorded. This
    /// is **not** `0.0`: an absent playhead means "never played", and the UI shows
    /// the two differently.
    pub position_secs: Option<f64>,
    /// The duration the *player* measured, or `None` when it never has. Kept
    /// apart from the feed's stated `duration_secs`.
    pub observed_duration_secs: Option<f64>,
    pub played: bool,
    /// The stored playback rate (1.0 when nothing is recorded).
    pub speed: f64,
    pub download: DownloadState,
}

/// One feed's refresh outcome. A failure is **data**, not an error: `refresh`
/// of many feeds must report the ones that failed without discarding the ones
/// that succeeded.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PodcastRefresh {
    pub feed_id: String,
    /// `None` on failure (see `error`).
    pub title: Option<String>,
    pub fetched_at: Option<i64>,
    pub episode_count: Option<usize>,
    /// Whether the episode list was capped — `None` on failure, like every other
    /// observation on this row. A bare `false` would read as "the whole feed was
    /// collected" about a refresh that collected nothing.
    pub truncated: Option<bool>,
    /// The failure's stable code + sentence, when the refresh failed.
    pub error: Option<PodcastRefreshError>,
    /// `true` when the previous cache was left untouched after a failure.
    pub kept_previous_cache: bool,
}

/// The failure half of a [`PodcastRefresh`].
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PodcastRefreshError {
    /// The stable wire code (e.g. `amos.podcast.fetch_failed`).
    pub code: String,
    pub message: String,
}

/// What an unsubscribe cleaned up, so the UI can say so.
///
/// The removal itself is not reported: a feed that is not subscribed is refused
/// before this is built (see [`PodcastBridge::unsubscribe`]), so a report only
/// exists for a removal that happened. Forwarding the domain's
/// `removed_subscription` would put a `bool` on the wire that is `true` for every
/// value the screen can ever see — the shape that let a no-op read as a success.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct PodcastUnsubscribe {
    /// Whether a **cached** episode list existed and was dropped. A subscription
    /// stored by `podcast_add` and never fetched has none, and says so here
    /// rather than being reported as having cleaned up a cache it never had.
    pub dropped_cached_episodes: bool,
    pub cleared_progress_records: usize,
}

/// Shape a domain refresh result into the wire form.
///
/// `had_cache` is whether a snapshot existed **before** this fetch — without it a
/// first fetch that fails would report `kept_previous_cache: true` about a cache
/// that never existed (REQ-A1570 / F-SH-796).
fn refresh_outcome(
    feed_id: String,
    had_cache: bool,
    res: Result<amos_podcast::RefreshReport, PodcastError>,
) -> PodcastRefresh {
    match res {
        Ok(r) => PodcastRefresh {
            feed_id,
            title: Some(r.title),
            fetched_at: Some(r.fetched_at),
            episode_count: Some(r.episode_count),
            truncated: Some(r.truncated),
            error: None,
            kept_previous_cache: false,
        },
        Err(e) => {
            let err = map_error(e);
            // Only these two leave the stored snapshot alone; a store failure may
            // well have been the write, so nothing is claimed to have survived.
            let preserved = matches!(
                err.code,
                ErrorCode::PodcastFetchFailed | ErrorCode::PodcastParseFailed
            );
            let kept = had_cache && preserved;
            PodcastRefresh {
                feed_id,
                title: None,
                fetched_at: None,
                episode_count: None,
                // A failed refresh has no truncation *observation* at all, so the
                // field is absent (`None`) rather than a measured `false`, which
                // would read as "the whole feed was collected".
                truncated: None,
                error: Some(PodcastRefreshError {
                    code: err.code.as_str().to_string(),
                    message: err.message,
                }),
                kept_previous_cache: kept,
            }
        }
    }
}

fn unknown_feed(feed_id: &str) -> AmosError {
    AmosError::new(
        ErrorCode::PodcastUnknownFeed,
        format!("not subscribed: {feed_id}"),
    )
}

/// Validate a caller-supplied feed id at the command seam.
///
/// The rule is **not** re-implemented here: it is
/// [`amos_podcast::normalize_feed_url`], the domain's own single entry point
/// (which enforces both the `http`/`https` scheme and the byte ceiling). This
/// seam only maps its typed refusal onto the wire envelope, so the bridge and the
/// engine cannot disagree about which URLs are acceptable.
fn validate_feed_id(raw: &str) -> PodcastResult<String> {
    amos_podcast::normalize_feed_url(raw).map_err(map_error)
}

/// Validate an episode id at the seam, deferring to the domain's own id bound
/// ([`MAX_ID_BYTES`]) rather than a second, drift-prone copy of it.
fn validate_episode_id(id: &str) -> PodcastResult<()> {
    if id.is_empty() {
        return Err(AmosError::new(
            ErrorCode::PodcastEpisodeIdEmpty,
            "episode id is empty",
        ));
    }
    if id.len() > MAX_ID_BYTES {
        return Err(AmosError::new(
            ErrorCode::PodcastEpisodeIdTooLong,
            format!(
                "episode id too long: {} bytes (max {MAX_ID_BYTES})",
                id.len()
            ),
        ));
    }
    Ok(())
}

/// Resolve a (feed, episode) pair to the progress key, validating both halves.
fn validate_uid(feed_id: &str, episode_id: &str) -> PodcastResult<String> {
    let feed_id = validate_feed_id(feed_id)?;
    validate_episode_id(episode_id)?;
    Ok(episode_uid(&feed_id, episode_id))
}

/// Map a domain [`PodcastError`] onto the wire envelope.
///
/// One-to-one on purpose: each variant names a *different* recovery, and the UI
/// has a different sentence for each. Folding them into one code here would throw
/// away the distinction the domain crate exists to preserve.
pub fn map_error(e: PodcastError) -> AmosError {
    let code = match &e {
        PodcastError::UrlInvalid => ErrorCode::PodcastUrlInvalid,
        PodcastError::UrlSchemeUnsupported => ErrorCode::PodcastUrlSchemeUnsupported,
        PodcastError::FetchFailed(_) => ErrorCode::PodcastFetchFailed,
        PodcastError::ParseFailed(_) => ErrorCode::PodcastParseFailed,
        PodcastError::FeedNotRecognized | PodcastError::FeedEmpty => ErrorCode::PodcastFeedRejected,
        PodcastError::UnknownFeed(_) => ErrorCode::PodcastUnknownFeed,
        PodcastError::SubscriptionLimitReached => ErrorCode::PodcastSubscriptionLimitReached,
        PodcastError::StoreReadFailed(_) | PodcastError::StoreWriteFailed(_) => {
            ErrorCode::PodcastStoreFailed
        }
        PodcastError::NoAudio => ErrorCode::PodcastNoAudio,
        PodcastError::DownloadFailed(_) => ErrorCode::PodcastDownloadFailed,
        PodcastError::DownloadUnsupported => ErrorCode::PodcastDownloadUnsupported,
    };
    AmosError::with_cause(code, e.to_string(), e)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// The backend in use (`"mock"` / `"http"`), so a screen can say which.
#[tauri::command]
pub async fn podcast_backend_name(state: State<'_, PodcastBridge>) -> PodcastResult<String> {
    Ok(state.provider_name().await.to_string())
}

/// The subscribed feeds, in subscription order.
#[tauri::command]
pub async fn podcast_subscriptions(
    state: State<'_, PodcastBridge>,
) -> PodcastResult<Vec<Subscription>> {
    // The list is a cheap read of one store; going through the manager keeps the
    // bridge from reaching around it into a store the manager owns.
    let guard = state.manager.lock().await;
    Ok(guard.subscriptions().to_vec())
}

/// Fetch a feed and subscribe to it.
#[tauri::command]
pub async fn podcast_subscribe(
    state: State<'_, PodcastBridge>,
    url: String,
) -> PodcastResult<Subscription> {
    state.subscribe(&url, now_unix()).await
}

/// Store a subscription without fetching it.
#[tauri::command]
pub async fn podcast_add(
    state: State<'_, PodcastBridge>,
    url: String,
    title: Option<String>,
) -> PodcastResult<Subscription> {
    state.add(&url, title.as_deref(), now_unix()).await
}

/// Re-fetch one feed (when `feed_id` is given) or every subscribed feed.
#[tauri::command]
pub async fn podcast_refresh(
    state: State<'_, PodcastBridge>,
    feed_id: Option<String>,
) -> PodcastResult<Vec<PodcastRefresh>> {
    state.refresh(feed_id.as_deref(), now_unix()).await
}

/// One feed's screen payload. `None` = subscribed but never fetched.
#[tauri::command]
pub async fn podcast_feed(
    state: State<'_, PodcastBridge>,
    feed_id: String,
) -> PodcastResult<Option<PodcastFeedView>> {
    state.feed_view(&feed_id).await
}

/// Drop a subscription, its cached feed and its playheads.
#[tauri::command]
pub async fn podcast_unsubscribe(
    state: State<'_, PodcastBridge>,
    feed_id: String,
) -> PodcastResult<PodcastUnsubscribe> {
    state.unsubscribe(&feed_id).await
}

/// Record a playhead update (and, when known, the player's measured duration).
#[tauri::command]
pub async fn podcast_set_position(
    state: State<'_, PodcastBridge>,
    feed_id: String,
    episode_id: String,
    position_secs: f64,
    observed_duration_secs: Option<f64>,
) -> PodcastResult<()> {
    state
        .set_position(
            &feed_id,
            &episode_id,
            position_secs,
            observed_duration_secs,
            now_unix(),
        )
        .await
}

/// Set one episode's playback rate; returns the rate actually stored.
#[tauri::command]
pub async fn podcast_set_speed(
    state: State<'_, PodcastBridge>,
    feed_id: String,
    episode_id: String,
    speed: f64,
) -> PodcastResult<f64> {
    state
        .set_speed(&feed_id, &episode_id, speed, now_unix())
        .await
}

/// Mark one episode finished (or un-finish it).
#[tauri::command]
pub async fn podcast_set_played(
    state: State<'_, PodcastBridge>,
    feed_id: String,
    episode_id: String,
    played: bool,
) -> PodcastResult<()> {
    state
        .set_played(&feed_id, &episode_id, played, now_unix())
        .await
}

/// Download one episode now. Returns its terminal state (`Done` / `Failed`, or
/// the existing state when it is already queued / in flight / downloaded).
#[tauri::command]
pub async fn podcast_download(
    state: State<'_, PodcastBridge>,
    feed_id: String,
    episode_id: String,
) -> PodcastResult<DownloadState> {
    state.download(&feed_id, &episode_id, now_unix()).await
}

/// One episode's download state.
#[tauri::command]
pub async fn podcast_download_state(
    state: State<'_, PodcastBridge>,
    feed_id: String,
    episode_id: String,
) -> PodcastResult<DownloadState> {
    state.download_state(&feed_id, &episode_id).await
}

/// Forget a download record (the file it named is left alone).
#[tauri::command]
pub async fn podcast_remove_download(
    state: State<'_, PodcastBridge>,
    feed_id: String,
    episode_id: String,
) -> PodcastResult<bool> {
    state.remove_download(&feed_id, &episode_id).await
}

/// The current unix time, or `0` when the clock is set before the epoch. A
/// pre-epoch clock is a broken environment, not a reason to refuse a subscribe.
fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The directory the four stores live in, for diagnostics (`None` = ephemeral).
pub fn store_dir() -> Option<PathBuf> {
    store_dir_from(std::env::var_os(amos_podcast::manager::DIR_ENV))
}

/// [`store_dir`] over an injected raw value. The rule itself lives in
/// [`amos_podcast::manager::path_knob`], shared with the CLI, so this is only
/// the env read plus that call — and it is pinned without mutating the
/// process-global `AMOS_PODCAST_DIR` that other podcast tests share.
fn store_dir_from(raw: Option<std::ffi::OsString>) -> Option<PathBuf> {
    amos_podcast::manager::path_knob(amos_podcast::manager::DIR_ENV, raw)
}

/// Where downloaded audio is written: `<store dir>/audio`, or `None` when no
/// store directory is configured (an ephemeral bridge has nowhere to put it).
pub fn audio_dir() -> Option<PathBuf> {
    store_dir().map(|d| d.join("audio"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RW: &str = "https://feeds.amos.dev/rust-weekly.xml";

    /// A bridge over the offline mock with all four stores in memory, so a test
    /// never touches the developer's real podcast directory.
    fn bridge() -> PodcastBridge {
        PodcastBridge::with_paths(PodcastPaths::default())
    }

    async fn subscribed() -> PodcastBridge {
        let b = bridge();
        b.subscribe(RW, 1_700_000_000).await.unwrap();
        b
    }

    #[tokio::test]
    async fn the_default_provider_is_the_offline_mock() {
        // No `podcast-live` feature ⇒ the env var cannot reach the network, so
        // this is deterministic in both feature configurations.
        let b = bridge();
        #[cfg(not(feature = "podcast-live"))]
        assert_eq!(b.provider_name().await, "mock");
        assert!(matches!(b.provider_name().await, "mock" | "http"));
    }

    /// Counts WARN events so the assertion is on the *observable* diagnostic, not
    /// on a re-statement of the code. A test-only probe, deliberately local: a
    /// shared `#[cfg(test)]` helper would have to compile under every feature
    /// combination this crate is built with, and where it is unused `-D warnings`
    /// refuses it (F-DEV-155).
    #[cfg(feature = "podcast-live")]
    struct WarnProbe(std::sync::Arc<std::sync::atomic::AtomicU64>);
    #[cfg(feature = "podcast-live")]
    impl tracing::Subscriber for WarnProbe {
        fn enabled(&self, _m: &tracing::Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _s: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _id: &tracing::span::Id, _r: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _a: &tracing::span::Id, _b: &tracing::span::Id) {}
        fn event(&self, ev: &tracing::Event<'_>) {
            if ev.metadata().level() == &tracing::Level::WARN {
                self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
        fn enter(&self, _id: &tracing::span::Id) {}
        fn exit(&self, _id: &tracing::span::Id) {}
    }

    /// Count the WARN events `f` emits on this thread.
    #[cfg(feature = "podcast-live")]
    fn warns_during(f: impl FnOnce()) -> u64 {
        let warns = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        {
            let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
            f();
        }
        warns.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Run [`decide_live`] on one raw value, returning `(armed, warns)`.
    #[cfg(feature = "podcast-live")]
    fn decide(raw: Option<&str>) -> (bool, u64) {
        let mut armed = false;
        let warns = warns_during(|| armed = decide_live(raw.map(std::ffi::OsStr::new)));
        (armed, warns)
    }

    /// The gate is an opt-in to the **network**, so its safe side is the mock.
    /// The previous read armed the live fetcher on the documented **off**
    /// spellings (`false` / `no` / `off`) and on every typo, because it asked only
    /// "non-empty and not literally `0`" (REQ-A1906).
    #[cfg(feature = "podcast-live")]
    #[test]
    fn an_explicitly_off_podcast_live_value_stays_on_the_offline_mock() {
        for val in ["0", "false", "no", "off", "FALSE", "  Off  "] {
            let (armed, warns) = decide(Some(val));
            assert!(
                !armed,
                "AMOS_PODCAST_LIVE={val:?} is a recognised off — it must not arm the network"
            );
            assert_eq!(
                warns, 0,
                "a recognised off is a deliberate off, not a misread"
            );
        }
    }

    #[cfg(feature = "podcast-live")]
    #[test]
    fn an_unrecognised_podcast_live_value_is_reported_not_armed() {
        for val in ["enable", "2", "l3", " " /* blank-but-set */] {
            let (armed, warns) = decide(Some(val));
            assert!(
                !armed,
                "AMOS_PODCAST_LIVE={val:?} is outside both sets — the safe side is the mock"
            );
            assert_eq!(
                warns, 1,
                "AMOS_PODCAST_LIVE={val:?} is present but unreadable — the operator must learn \
                 the live request was dropped"
            );
        }
    }

    #[cfg(all(feature = "podcast-live", unix))]
    #[test]
    fn a_non_unicode_podcast_live_value_is_reported_not_armed() {
        use std::os::unix::ffi::OsStrExt;
        let raw = std::ffi::OsStr::from_bytes(b"\xff\xfe");
        let mut armed = true;
        let warns = warns_during(|| armed = decide_live(Some(raw)));
        assert!(!armed, "an unreadable value must not arm the network");
        assert_eq!(
            warns, 1,
            "the operator must learn the live request was dropped"
        );
    }

    /// Disjointness controls: unset is the documented `→ mock` default and the
    /// truthy tokens are the only values that arm the fetcher.
    #[cfg(feature = "podcast-live")]
    #[test]
    fn unset_and_truthy_podcast_live_values_are_disjoint() {
        let (armed, warns) = decide(None);
        assert_eq!(
            warns, 0,
            "unset is the documented offline-mock default — silent, not a misread"
        );
        assert!(!armed);

        for val in ["1", "true", "yes", "on", " On "] {
            let (armed, warns) = decide(Some(val));
            assert_eq!(
                warns, 0,
                "AMOS_PODCAST_LIVE={val:?} is a recognised on value"
            );
            assert!(armed, "AMOS_PODCAST_LIVE={val:?} must arm the live fetcher");
        }
    }

    /// A temp directory for one test's downloaded audio.
    fn tmp_audio(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "amos-tauri-podcast-dl-{}-{}-{}",
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

    /// A bridge over the mock with downloads pointed at a fresh temp directory.
    async fn subscribed_with_dir(tag: &str) -> (PodcastBridge, PathBuf) {
        let dir = tmp_audio(tag);
        let b = PodcastBridge::with_provider_and_dir(
            Box::new(MockFeedProvider::new()),
            PodcastPaths::default(),
            Some(dir.clone()),
        );
        b.subscribe(RW, 1_700_000_000).await.unwrap();
        (b, dir)
    }

    /// Every sibling command routes the caller's feed id through
    /// `validate_feed_id` **and uses the normalized result**; `download`
    /// validated it and then handed the *raw* string to the cache lookup. So an
    /// id with surrounding space — which this very seam just accepted — missed
    /// the lookup and came back `PodcastNoAudio` ("no bytes to move") about an
    /// episode that plainly has an enclosure.
    #[tokio::test]
    async fn download_looks_up_with_the_id_it_validated() {
        let (b, dir) = subscribed_with_dir("validated").await;
        let padded = format!("  {RW}  ");
        let state = b.download(&padded, "rw-1", 10).await.unwrap();
        assert!(
            matches!(state, DownloadState::Done { .. }),
            "the padded id the seam accepted must reach the same episode: {state:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The wire shape of `download` is a contract with the frontend's `DownloadState`
    /// type, which models the domain enum's internal tag (`{"state":"..."}`) and reads
    /// the payload each variant carries. Pinned here because the screen cannot see the
    /// Rust type: when this was mistyped as a bare `"Absent"`, every comparison in
    /// `PodcastsApp.svelte` was false and the tests — which spelled their own fixtures —
    /// could not tell.
    #[test]
    fn the_view_carries_the_download_state_the_screen_reads() {
        let view = |download| PodcastEpisodeView {
            episode: Episode {
                id: "e1".into(),
                title: "t".into(),
                description: String::new(),
                audio_url: Some("https://cdn.amos.dev/e1.mp3".into()),
                duration_secs: None,
                published: None,
            },
            position_secs: None,
            observed_duration_secs: None,
            played: false,
            speed: 1.0,
            download,
        };
        assert_eq!(
            serde_json::to_value(view(DownloadState::Absent)).unwrap()["download"],
            serde_json::json!({ "state": "absent" }),
        );
        assert_eq!(
            serde_json::to_value(view(DownloadState::Downloading {
                received: 5,
                total: Some(10),
            }))
            .unwrap()["download"],
            serde_json::json!({ "state": "downloading", "received": 5, "total": 10 }),
        );
        assert_eq!(
            serde_json::to_value(view(DownloadState::Failed {
                reason: "interrupted".into(),
            }))
            .unwrap()["download"],
            serde_json::json!({ "state": "failed", "reason": "interrupted" }),
        );
    }

    #[tokio::test]
    async fn subscribe_fetches_before_it_stores() {
        let b = bridge();
        let sub = b.subscribe(RW, 1_700_000_000).await.unwrap();
        assert_eq!(sub.feed_id, RW);
        assert_eq!(sub.last_refreshed, Some(1_700_000_000));

        let view = b.feed_view(RW).await.unwrap().unwrap();
        assert_eq!(view.title, "Rust Weekly");
        assert_eq!(view.episodes.len(), 3);
    }

    /// The show's name is drawn on this screen **twice** — the sidebar row from the
    /// subscription's `display_title`, the detail header from this payload. The cache
    /// deliberately keeps the feed's raw title (markup and all), so handing that cache
    /// field straight to the header made one show read `Rust & Friends` in the list and
    /// `<b>Rust</b> & Friends` in the header. `display_title` is the crate's single rule
    /// for what a feed is *called*; a payload documented as "ready for one screen" must
    /// carry that form, not the raw cache field.
    #[tokio::test]
    async fn the_view_names_the_feed_the_way_the_subscription_does() {
        let raw = "<b>Rust</b> &amp; Friends";
        let b = PodcastBridge::with_provider(
            Box::new(MockFeedProvider::with_feeds(vec![(
                RW.to_string(),
                amos_podcast::Feed {
                    title: raw.to_string(),
                    episodes: vec![Episode {
                        id: "e1".into(),
                        title: "One".into(),
                        description: String::new(),
                        audio_url: Some("https://cdn.amos.dev/1.mp3".into()),
                        duration_secs: None,
                        published: None,
                    }],
                    ..Default::default()
                },
            )])),
            PodcastPaths::default(),
        );
        let sub = b.subscribe(RW, 1).await.unwrap();
        assert_eq!(sub.title, "Rust & Friends", "the pinned display form");

        let view = b.feed_view(RW).await.unwrap().unwrap();
        assert_eq!(
            view.title, sub.title,
            "one screen, one name for one feed (the cache title was {raw:?})"
        );
    }

    #[tokio::test]
    async fn a_feed_that_cannot_be_fetched_is_never_subscribed() {
        let b = bridge();
        let err = b.subscribe("https://feeds.amos.dev/nope.xml", 0).await;
        assert_eq!(err.unwrap_err().code, ErrorCode::PodcastFetchFailed);
        assert!(b
            .feed_view("https://feeds.amos.dev/nope.xml")
            .await
            .is_err());
        assert!(b.subscriptions_now().is_empty());
    }

    #[tokio::test]
    async fn add_stores_without_fetching_and_feed_view_says_we_have_not_looked() {
        let b = bridge();
        let sub = b.add(RW, None, 1_700_000_000).await.unwrap();
        assert_eq!(
            sub.last_refreshed, None,
            "an unfetched subscription must not claim a refresh time"
        );

        // `None` — subscribed, but no cached snapshot. Deliberately *not* an empty
        // episode list: "we have not looked" is not "there are no episodes".
        assert_eq!(b.feed_view(RW).await.unwrap(), None);
    }

    #[tokio::test]
    async fn feed_view_for_an_unsubscribed_feed_is_unknown_feed() {
        let b = subscribed().await;
        let err = b
            .feed_view("https://feeds.amos.dev/systems-cast.xml")
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::PodcastUnknownFeed);
    }

    #[tokio::test]
    async fn absence_is_carried_across_the_seam_as_none_not_zero() {
        let b = subscribed().await;
        let view = b.feed_view(RW).await.unwrap().unwrap();
        let ep = view
            .episodes
            .iter()
            .find(|e| e.episode.id == "rw-3")
            .unwrap();

        // Never played ⇒ no playhead, no measured duration, not 0.0 seconds.
        assert_eq!(ep.position_secs, None);
        assert_eq!(ep.observed_duration_secs, None);
        assert!(!ep.played);
        assert_eq!(ep.speed, 1.0);
    }

    #[tokio::test]
    async fn the_playhead_and_the_players_measured_duration_are_kept_apart() {
        let b = subscribed().await;
        // The feed says rw-3 is 2760s; the player measured 2755s.
        b.set_position(RW, "rw-3", 600.0, Some(2755.0), 1_700_000_100)
            .await
            .unwrap();

        let view = b.feed_view(RW).await.unwrap().unwrap();
        let ep = view
            .episodes
            .iter()
            .find(|e| e.episode.id == "rw-3")
            .unwrap();
        assert_eq!(ep.position_secs, Some(600.0));
        assert_eq!(ep.episode.duration_secs, Some(2760), "the feed's own claim");
        assert_eq!(
            ep.observed_duration_secs,
            Some(2755.0),
            "the player's measurement is a different field, not a correction"
        );
    }

    #[tokio::test]
    async fn a_non_finite_playhead_is_refused_by_name() {
        let b = subscribed().await;
        for bad in [f64::NAN, f64::INFINITY, -1.0] {
            let err = b.set_position(RW, "rw-3", bad, None, 0).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::PodcastRpcFailed, "position {bad}");
        }
        // The refusal wrote nothing.
        let view = b.feed_view(RW).await.unwrap().unwrap();
        let ep = view
            .episodes
            .iter()
            .find(|e| e.episode.id == "rw-3")
            .unwrap();
        assert_eq!(ep.position_secs, None);
    }

    #[tokio::test]
    async fn set_speed_reports_what_was_stored_not_what_was_asked_for() {
        let b = subscribed().await;
        // 99x is outside the domain's 0.25..4.0 band and is clamped, not refused.
        let stored = b.set_speed(RW, "rw-3", 99.0, 0).await.unwrap();
        assert!(
            stored <= 4.0,
            "stored rate {stored} must be inside the band"
        );
        assert_ne!(stored, 99.0, "the bridge must not echo the request back");

        let view = b.feed_view(RW).await.unwrap().unwrap();
        let ep = view
            .episodes
            .iter()
            .find(|e| e.episode.id == "rw-3")
            .unwrap();
        assert_eq!(ep.speed, stored, "the screen and the reply must agree");
    }

    #[tokio::test]
    async fn a_successful_refresh_carries_a_real_truncation_observation() {
        // Positive control for the failure case below: a refresh that ran must
        // report the observation itself (`Some`), so "absent on failure" is a
        // *difference* between the two arms, not a field that is never set.
        let b = subscribed().await;
        let out = b.refresh(Some(RW), 0).await.unwrap();
        let r = &out[0];
        assert_eq!(r.error, None);
        assert_eq!(
            r.truncated,
            Some(false),
            "a complete mock feed is not truncated"
        );
        assert_eq!(r.episode_count, Some(3));
    }

    #[tokio::test]
    async fn a_failed_refresh_is_data_with_the_previous_cache_kept() {
        let b = subscribed().await;
        // `systems-cast` is known to the mock but never subscribed; refreshing it
        // is `UnknownFeed`, which is *not* a kept-cache case (nothing was cached).
        let out = b
            .refresh(Some("https://feeds.amos.dev/systems-cast.xml"), 0)
            .await
            .unwrap();
        assert_eq!(out.len(), 1);
        let r = &out[0];
        assert!(r.error.is_some());
        assert_eq!(
            r.error.as_ref().unwrap().code,
            ErrorCode::PodcastUnknownFeed.as_str()
        );
        assert_eq!(r.episode_count, None, "a failure measured no episodes");
        assert_eq!(r.fetched_at, None);
        assert!(!r.kept_previous_cache);
        // A failed refresh made no truncation observation, so the field is absent
        // (`None`), never a measured `false` that would read as "the whole feed
        // arrived". The presence of `error` is what says a failure happened.
        assert_eq!(r.truncated, None, "a failed refresh observed no truncation");
    }

    #[tokio::test]
    async fn a_first_fetch_that_fails_does_not_claim_to_have_kept_a_cache() {
        let b = bridge();
        b.add("https://feeds.amos.dev/broken.xml", Some("Broken"), 0)
            .await
            .unwrap();
        let out = b
            .refresh(Some("https://feeds.amos.dev/broken.xml"), 1)
            .await
            .unwrap();
        let r = &out[0];
        assert_eq!(
            r.error.as_ref().unwrap().code,
            ErrorCode::PodcastParseFailed.as_str()
        );
        assert!(
            !r.kept_previous_cache,
            "nothing was cached, so nothing was kept — the UI must not offer to show it"
        );
    }

    #[tokio::test]
    async fn a_failed_refresh_of_a_cached_feed_keeps_the_cache_and_says_so() {
        let dir = std::env::temp_dir().join(format!("amos-podcast-keep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let paths = PodcastPaths {
            subscriptions: Some(dir.join("subscriptions.json")),
            library: Some(dir.join("library.json")),
            progress: Some(dir.join("progress.json")),
            downloads: Some(dir.join("downloads.json")),
        };

        // First bridge fetches and caches the feed.
        {
            let b = PodcastBridge::with_paths(paths.clone());
            b.subscribe(RW, 0).await.unwrap();
            assert_eq!(b.feed_view(RW).await.unwrap().unwrap().episodes.len(), 3);
        }

        // Second bridge over the *same* stores but a provider that no longer has
        // the feed: the refresh fails, and what the first bridge cached stands.
        let b =
            PodcastBridge::with_provider(Box::new(MockFeedProvider::with_feeds(Vec::new())), paths);
        let out = b.refresh(Some(RW), 10).await.unwrap();
        let r = &out[0];
        assert_eq!(
            r.error.as_ref().unwrap().code,
            ErrorCode::PodcastFetchFailed.as_str()
        );
        assert!(
            r.kept_previous_cache,
            "a fetch failure must not destroy the snapshot we already had"
        );

        // The flag is a reading of the store, not a promise about it.
        let view = b.feed_view(RW).await.unwrap().unwrap();
        assert_eq!(view.episodes.len(), 3);
        assert_eq!(
            view.fetched_at, 0,
            "the kept snapshot keeps its own timestamp, not the failed attempt's"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn refresh_all_reports_every_feed_including_the_ones_that_fail() {
        let b = bridge();
        b.subscribe(RW, 0).await.unwrap();
        b.add("https://feeds.amos.dev/broken.xml", Some("Broken"), 0)
            .await
            .unwrap();

        let out = b.refresh(None, 5).await.unwrap();
        assert_eq!(
            out.len(),
            2,
            "one outcome per subscription, failures included"
        );
        let ok = out.iter().find(|r| r.feed_id == RW).unwrap();
        assert!(ok.error.is_none());
        assert_eq!(ok.episode_count, Some(3));
        let bad = out
            .iter()
            .find(|r| r.feed_id == "https://feeds.amos.dev/broken.xml")
            .unwrap();
        assert!(
            bad.error.is_some(),
            "a dead feed is reported, not swallowed"
        );
    }

    /// `podcast_feed` refuses a feed that is not subscribed by name, and so does the CLI
    /// (`require_subscription`). `podcast_unsubscribe` was the sibling that let it through
    /// as `Ok(removed_subscription: false)` — a report the screen reads as
    /// 「已取消订阅，清理了 0 条播放进度。」, asserting a removal that never happened.
    #[tokio::test]
    async fn unsubscribe_refuses_a_feed_that_is_not_subscribed() {
        let b = subscribed().await;
        let err = b
            .unsubscribe("https://feeds.amos.dev/systems-cast.xml")
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::PodcastUnknownFeed);
    }

    #[tokio::test]
    async fn unsubscribe_drops_the_cache_and_the_playheads_and_says_what_it_did() {
        let b = subscribed().await;
        b.set_position(RW, "rw-3", 600.0, None, 0).await.unwrap();
        b.set_position(RW, "rw-1", 30.0, None, 0).await.unwrap();

        let r = b.unsubscribe(RW).await.unwrap();
        assert!(r.dropped_cached_episodes);
        assert_eq!(r.cleared_progress_records, 2);
        assert_eq!(
            b.feed_view(RW).await.unwrap_err().code,
            ErrorCode::PodcastUnknownFeed
        );
    }

    /// The point of the whole feature: a download reaches `Done` with real bytes
    /// on disk, a second ask does not re-fetch, and the record can be forgotten.
    #[tokio::test]
    async fn download_moves_bytes_and_a_second_ask_does_not_re_fetch() {
        let (b, dir) = subscribed_with_dir("done").await;
        let state = b.download(RW, "rw-3", 0).await.unwrap();
        let (path, bytes) = match state {
            DownloadState::Done { ref path, bytes } => (path.clone(), bytes),
            other => panic!("expected Done, got {other:?}"),
        };
        assert!(
            bytes > 0,
            "a download that moved no bytes is not a download"
        );
        assert_eq!(std::fs::metadata(&path).unwrap().len(), bytes);
        assert_eq!(
            b.download_state(RW, "rw-3").await.unwrap(),
            DownloadState::Done {
                path: path.clone(),
                bytes
            }
        );

        // A second ask returns the finished state and does not move bytes again:
        // the file is gone, and the record still says the same path.
        std::fs::remove_file(&path).unwrap();
        let again = b.download(RW, "rw-3", 0).await.unwrap();
        assert_eq!(
            again,
            DownloadState::Done {
                path: path.clone(),
                bytes
            }
        );
        assert!(
            !std::path::Path::new(&path).exists(),
            "a second ask must not re-fetch what we already have"
        );

        assert!(b.remove_download(RW, "rw-3").await.unwrap());
        assert!(!b.remove_download(RW, "rw-3").await.unwrap());
        assert_eq!(
            b.download_state(RW, "rw-3").await.unwrap(),
            DownloadState::Absent
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// With no store directory configured there is nowhere to write the audio, so
    /// the command refuses with its own code rather than recording a `Done` for a
    /// file that was never written.
    #[tokio::test]
    async fn download_refuses_when_no_directory_is_configured() {
        let b = subscribed().await;
        let err = b.download(RW, "rw-3", 0).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::PodcastDownloadNoDir, "{err}");
        assert_eq!(
            b.download_state(RW, "rw-3").await.unwrap(),
            DownloadState::Absent,
            "nothing was attempted, so no record may exist"
        );
    }

    /// A provider whose feed holds one episode with an enclosure and one
    /// **text-only** item (`audio_url: None`). Its transport serves canned bytes
    /// for the enclosure, so the first episode reaches `Done` (the positive
    /// control) while the text-only one is refused before anything is attempted.
    struct TextOnlyProvider;

    #[async_trait::async_trait]
    impl FeedProvider for TextOnlyProvider {
        async fn fetch(&self, _url: &str) -> amos_podcast::Result<amos_podcast::Feed> {
            Ok(amos_podcast::Feed {
                title: "Text Only".to_string(),
                episodes: vec![
                    Episode {
                        id: "t-1".to_string(),
                        title: "has audio".to_string(),
                        description: String::new(),
                        audio_url: Some("https://cdn.amos.dev/t-1.mp3".to_string()),
                        duration_secs: None,
                        published: None,
                    },
                    Episode {
                        id: "t-2".to_string(),
                        title: "text only".to_string(),
                        description: String::new(),
                        audio_url: None,
                        duration_secs: None,
                        published: None,
                    },
                ],
                ..amos_podcast::Feed::default()
            })
        }

        async fn fetch_episode(&self, url: &str) -> amos_podcast::Result<Vec<u8>> {
            Ok(format!("bytes for {url}").into_bytes())
        }

        fn name(&self) -> &'static str {
            "text-only"
        }
    }

    #[tokio::test]
    async fn download_refuses_an_episode_with_no_audio_instead_of_claiming_we_have_it() {
        let dir = tmp_audio("textonly");
        let b = PodcastBridge::with_provider_and_dir(
            Box::new(TextOnlyProvider),
            PodcastPaths::default(),
            Some(dir.clone()),
        );
        let feed = "https://feeds.amos.dev/text-only.xml";
        b.subscribe(feed, 1_700_000_000).await.unwrap();

        // Positive control: the episode that *does* carry an enclosure downloads,
        // so the refusal below is the text-only arm and not "download never works".
        assert!(matches!(
            b.download(feed, "t-1", 0).await.unwrap(),
            DownloadState::Done { .. }
        ));

        // The text-only item: `NoAudio` — nothing was attempted, so there is no
        // record to read as "already have it".
        let err = b.download(feed, "t-2", 0).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::PodcastNoAudio, "{err}");
        assert_eq!(
            b.download_state(feed, "t-2").await.unwrap(),
            DownloadState::Absent
        );

        // …and an episode the cache does not hold at all is the same refusal.
        let err = b.download(feed, "absent", 0).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::PodcastNoAudio, "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn the_seam_defers_the_url_rule_to_the_domain() {
        let b = bridge();
        // `file:` is refused by `normalize_feed_url`, not by a copy living here —
        // so the bridge and the engine cannot drift on which schemes are legal.
        assert_eq!(
            b.subscribe("file:///etc/passwd", 0).await.unwrap_err().code,
            ErrorCode::PodcastUrlSchemeUnsupported
        );
        // The domain splits the refusals the way its own normalizer does: a
        // scheme-less string is "unsupported", an empty one is "invalid".
        assert_eq!(
            validate_feed_id("not a url").unwrap_err().code,
            ErrorCode::PodcastUrlSchemeUnsupported
        );
        assert_eq!(
            validate_feed_id("").unwrap_err().code,
            ErrorCode::PodcastUrlInvalid
        );
        assert_eq!(
            validate_feed_id(&format!("https://x.dev/{}", "y".repeat(4096)))
                .unwrap_err()
                .code,
            ErrorCode::PodcastUrlInvalid
        );
        assert_eq!(
            validate_feed_id("https://feeds.amos.dev/rust-weekly.xml").unwrap(),
            RW
        );
    }

    #[tokio::test]
    async fn an_episode_id_is_validated_by_its_own_two_named_refusals() {
        assert_eq!(
            validate_episode_id("").unwrap_err().code,
            ErrorCode::PodcastEpisodeIdEmpty
        );
        let long = "x".repeat(MAX_ID_BYTES + 1);
        assert_eq!(
            validate_episode_id(&long).unwrap_err().code,
            ErrorCode::PodcastEpisodeIdTooLong
        );
        assert!(validate_episode_id(&"x".repeat(MAX_ID_BYTES)).is_ok());
    }

    #[test]
    fn every_domain_error_maps_onto_its_own_code() {
        use amos_podcast::PodcastError as P;
        let cases = [
            (P::UrlInvalid, ErrorCode::PodcastUrlInvalid),
            (
                P::UrlSchemeUnsupported,
                ErrorCode::PodcastUrlSchemeUnsupported,
            ),
            (P::FetchFailed("x".into()), ErrorCode::PodcastFetchFailed),
            (P::ParseFailed("x".into()), ErrorCode::PodcastParseFailed),
            (P::FeedNotRecognized, ErrorCode::PodcastFeedRejected),
            (P::FeedEmpty, ErrorCode::PodcastFeedRejected),
            (P::UnknownFeed("x".into()), ErrorCode::PodcastUnknownFeed),
            (
                P::SubscriptionLimitReached,
                ErrorCode::PodcastSubscriptionLimitReached,
            ),
            (
                P::StoreReadFailed("x".into()),
                ErrorCode::PodcastStoreFailed,
            ),
            (
                P::StoreWriteFailed("x".into()),
                ErrorCode::PodcastStoreFailed,
            ),
            (P::NoAudio, ErrorCode::PodcastNoAudio),
            (
                P::DownloadFailed("x".into()),
                ErrorCode::PodcastDownloadFailed,
            ),
        ];
        for (e, want) in cases {
            assert_eq!(map_error(e).code, want);
        }
    }

    #[tokio::test]
    async fn a_bridge_over_explicit_paths_persists_across_instances() {
        let dir = std::env::temp_dir().join(format!("amos-podcast-bridge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let paths = PodcastPaths {
            subscriptions: Some(dir.join("subscriptions.json")),
            library: Some(dir.join("library.json")),
            progress: Some(dir.join("progress.json")),
            downloads: Some(dir.join("downloads.json")),
        };

        {
            let b = PodcastBridge::with_paths(paths.clone());
            b.subscribe(RW, 7).await.unwrap();
            b.set_position(RW, "rw-3", 42.0, None, 7).await.unwrap();
        }
        // A second instance over the same directory reads back what the first wrote.
        let b = PodcastBridge::with_paths(paths);
        let subs = b.subscriptions_now();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].last_refreshed, Some(7));
        let view = b.feed_view(RW).await.unwrap().unwrap();
        let ep = view
            .episodes
            .iter()
            .find(|e| e.episode.id == "rw-3")
            .unwrap();
        assert_eq!(ep.position_secs, Some(42.0));

        let _ = std::fs::remove_dir_all(&dir);
    }

    impl PodcastBridge {
        /// The subscriptions as a plain vec, for assertions (the command path
        /// returns them by value already; this keeps tests from locking twice).
        fn subscriptions_now(&self) -> Vec<Subscription> {
            self.manager
                .try_lock()
                .expect("no other task holds the bridge")
                .subscriptions()
                .to_vec()
        }
    }

    #[test]
    fn an_unset_store_dir_is_ephemeral() {
        assert_eq!(store_dir_from(None), None);
    }

    #[test]
    fn a_usable_store_dir_is_taken_as_given() {
        assert_eq!(
            store_dir_from(Some(std::ffi::OsString::from("/srv/amos-podcast"))),
            Some(PathBuf::from("/srv/amos-podcast"))
        );
    }

    #[test]
    fn a_blank_store_dir_is_ephemeral_not_a_directory_of_spaces() {
        // Goes through the shared `amos_podcast::manager::path_knob`, so this is
        // also the cross-crate proof that the rule is not re-implemented here.
        let dir = store_dir_from(Some("   ".into()));
        assert_eq!(dir, None);
        assert_ne!(dir, Some(PathBuf::from("   ")));
    }

    #[test]
    fn the_store_dir_goes_through_the_shared_seam() {
        let src = include_str!("podcast.rs");
        let production = src
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("production half");
        assert!(production.contains("amos_podcast::manager::path_knob("));
        let needle = format!("std::env::var(\"{}\")", amos_podcast::manager::DIR_ENV);
        assert!(
            !production.contains(&needle),
            "the store directory must not be re-read with the folding `std::env::var`"
        );
    }
}
