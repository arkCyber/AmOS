//! `manager.rs` — the engine the CLI and the Tauri bridge both drive.
//!
//! It folds the five pieces (provider, subscriptions, episode cache, progress,
//! downloads) into the operations a caller actually wants, and — the point of
//! the whole design — it keeps every *observation* and *capability* distinct:
//!
//! * [`PodcastManager::subscribe`] **fetches before it stores**, so a
//!   subscription is never a dead entry pointing at an unreachable feed;
//!   [`PodcastManager::add_subscription`] is the explicit "store it now, fetch
//!   later" path for when the user is offline on purpose.
//! * [`PodcastManager::episodes`] returns the cached snapshot *with* its
//!   `fetched_at`, so a screen can say how old it is instead of implying it is
//!   live.
//! * A refresh failure leaves the previous cache intact and reports the error —
//!   it does not blank the list the user is looking at.

use std::path::{Path, PathBuf};

use crate::download::DownloadRegistry;
use crate::error::{PodcastError, Result};
use crate::feed::display_title;
use crate::library::{CachedFeed, EpisodeLibrary};
use crate::model::{episode_uid, normalize_feed_url, DownloadState, Subscription};
use crate::progress::ProgressStore;
use crate::provider::FeedProvider;
use crate::store::SubscriptionStore;

/// Where each store lives. Every field is optional so a caller can run fully in
/// memory (tests) or fully on disk (CLI / app).
#[derive(Debug, Clone, Default)]
pub struct PodcastPaths {
    pub subscriptions: Option<PathBuf>,
    pub library: Option<PathBuf>,
    pub progress: Option<PathBuf>,
    pub downloads: Option<PathBuf>,
}

/// `AMOS_PODCAST_DIR`: one directory holding all four store files.
pub const DIR_ENV: &str = "AMOS_PODCAST_DIR";
/// Per-store overrides of [`DIR_ENV`]; a usable value wins over the directory.
pub const SUBSCRIPTIONS_ENV: &str = "AMOS_PODCAST_SUBSCRIPTIONS";
pub const LIBRARY_ENV: &str = "AMOS_PODCAST_LIBRARY";
pub const PROGRESS_ENV: &str = "AMOS_PODCAST_PROGRESS";
pub const DOWNLOADS_ENV: &str = "AMOS_PODCAST_DOWNLOADS";

/// Three-state read of a podcast store-path knob.
///
/// Unset, or set to whitespace only, is `None` **silently** — the documented
/// "ephemeral store" state. A value that is set but cannot be read back as
/// Unicode is a *different* fact: it is reported once with the key named and
/// then treated as unset, because an operator who configured a store directory
/// must not be told their stores are merely unconfigured.
///
/// Both readers outside this crate (`amos-tauri`'s `podcast::store_dir` and
/// `amos-podcast-cli`'s `--dir` fallback) go through this seam, so the rule has
/// exactly one home.
pub fn path_knob(key: &str, raw: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let raw = raw?;
    match raw.into_string() {
        Ok(s) if !s.trim().is_empty() => Some(PathBuf::from(s)),
        Ok(_) => None,
        Err(_) => {
            report_unusable_path_knob(key);
            None
        }
    }
}

/// [`path_knob`] over the process environment.
pub fn path_knob_from_env(key: &str) -> Option<PathBuf> {
    path_knob(key, std::env::var_os(key))
}

fn unusable_path_knobs_seen(
) -> &'static std::sync::Mutex<std::collections::BTreeSet<(String, String)>> {
    static SEEN: std::sync::OnceLock<
        std::sync::Mutex<std::collections::BTreeSet<(String, String)>>,
    > = std::sync::OnceLock::new();
    SEEN.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeSet::new()))
}

#[cfg(test)]
fn unusable_path_knob_reports_for(key: &str) -> usize {
    unusable_path_knobs_seen()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .filter(|(seen_key, _)| seen_key == key)
        .count()
}

fn report_unusable_path_knob(key: &str) {
    let mut seen = unusable_path_knobs_seen()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if seen.insert((key.to_owned(), "<non-Unicode>".to_owned())) {
        tracing::warn!(
            "podcast store path {key} is set but is not valid Unicode; treating it as unset \
             (the stores stay in memory)"
        );
    }
}

impl PodcastPaths {
    /// Resolve paths from the environment.
    ///
    /// `AMOS_PODCAST_DIR` sets the directory for all four; the individual
    /// `AMOS_PODCAST_SUBSCRIPTIONS` / `_LIBRARY` / `_PROGRESS` / `_DOWNLOADS`
    /// override it. With neither set — **or with a value that is set but cannot
    /// be read back as Unicode, which is reported once and then treated as
    /// unset** — every store is in memory only (nothing is written to a user's
    /// disk without being asked).
    pub fn from_env() -> Self {
        Self::from_env_with(|name| std::env::var_os(name))
    }

    /// [`Self::from_env`] with the environment read injected, so the rule can be
    /// pinned without mutating process-global state.
    pub fn from_env_with(read: impl Fn(&str) -> Option<std::ffi::OsString>) -> Self {
        let dir = path_knob(DIR_ENV, read(DIR_ENV));
        let pick = |name: &str, file: &str| -> Option<PathBuf> {
            path_knob(name, read(name)).or_else(|| dir.as_ref().map(|d| d.join(file)))
        };
        PodcastPaths {
            subscriptions: pick(SUBSCRIPTIONS_ENV, "subscriptions.json"),
            library: pick(LIBRARY_ENV, "library.json"),
            progress: pick(PROGRESS_ENV, "progress.json"),
            downloads: pick(DOWNLOADS_ENV, "downloads.json"),
        }
    }
}

/// The result of a successful refresh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshReport {
    pub feed_id: String,
    pub title: String,
    pub fetched_at: i64,
    pub episode_count: usize,
    /// The feed declared more episodes than the parser collected.
    pub truncated: bool,
}

/// The result of an unsubscribe, so a caller can report what was cleaned up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnsubscribeReport {
    pub removed_subscription: bool,
    pub dropped_cached_episodes: bool,
    pub cleared_progress_records: usize,
}

pub struct PodcastManager<P: FeedProvider> {
    provider: P,
    subs: SubscriptionStore,
    library: EpisodeLibrary,
    progress: ProgressStore,
    downloads: DownloadRegistry,
}

impl<P: FeedProvider> PodcastManager<P> {
    pub fn new(provider: P, paths: PodcastPaths) -> Self {
        PodcastManager {
            provider,
            subs: SubscriptionStore::open(paths.subscriptions),
            library: EpisodeLibrary::open(paths.library),
            progress: ProgressStore::open(paths.progress),
            downloads: DownloadRegistry::open(paths.downloads),
        }
    }

    pub fn provider_name(&self) -> &'static str {
        self.provider.name()
    }

    pub fn subscriptions(&self) -> &[Subscription] {
        self.subs.list()
    }

    pub fn subscription(&self, feed_id: &str) -> Option<&Subscription> {
        self.subs.get(feed_id)
    }

    /// The cached snapshot for a feed, **with** the time it was fetched.
    pub fn episodes(&self, feed_id: &str) -> Option<&CachedFeed> {
        self.library.get(feed_id)
    }

    pub fn progress(&self) -> &ProgressStore {
        &self.progress
    }

    pub fn progress_mut(&mut self) -> &mut ProgressStore {
        &mut self.progress
    }

    pub fn downloads(&self) -> &DownloadRegistry {
        &self.downloads
    }

    pub fn downloads_mut(&mut self) -> &mut DownloadRegistry {
        &mut self.downloads
    }

    /// Store a subscription without fetching it. The name the user typed is
    /// kept as the **custom title** — the feed's own name is unknown until a
    /// fetch, and a later refresh must not overwrite what they typed. `title`
    /// falls back to the URL until the feed is read, and `last_refreshed` stays
    /// `None` (never fetched) so the UI can say so.
    pub fn add_subscription(
        &mut self,
        url: &str,
        title: Option<&str>,
        now: i64,
    ) -> Result<Subscription> {
        let url = normalize_feed_url(url)?;
        let sub = Subscription {
            feed_id: url.clone(),
            title: url.clone(),
            custom_title: title
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_string),
            url: url.clone(),
            subscribed_at: now,
            last_refreshed: None,
            category: None,
        };
        self.subs.add(sub)?;
        // Report the *stored* row, not the one just built: on an existing feed
        // the store merges into the row that is already there (keeps the feed's
        // learned `title`), so handing back the local copy would tell the caller
        // a name it is not what the list now shows.
        self.subs
            .get(&url)
            .cloned()
            .ok_or(PodcastError::UnknownFeed(url))
    }

    /// Fetch a feed and subscribe to it. The fetch happens **first**: a failed
    /// fetch leaves no subscription behind, so the list never shows a feed that
    /// was never reachable.
    pub async fn subscribe(&mut self, url: &str, now: i64) -> Result<Subscription> {
        let url = normalize_feed_url(url)?;
        let feed = self.provider.fetch(&url).await?;
        let title = display_title(&feed, &url);
        let sub = Subscription {
            feed_id: url.clone(),
            title: title.clone(),
            custom_title: None,
            url: url.clone(),
            subscribed_at: now,
            last_refreshed: None,
            category: None,
        };
        self.subs.add(sub)?;
        self.library.put(&url, feed, now)?;
        // Re-store the *display* title: the cache holds the raw one (markup and
        // all), so reading it back here would undo the markup-stripping above.
        self.subs.mark_refreshed(&url, &title, now)?;
        self.subs
            .get(&url)
            .cloned()
            .ok_or(PodcastError::UnknownFeed(url))
    }

    /// Re-fetch a subscribed feed into the cache.
    ///
    /// On failure the previous cache is **left intact** and the error is
    /// returned: a transient network failure must not blank the list the user is
    /// reading. On success the subscription's `last_refreshed` is updated.
    pub async fn refresh(&mut self, feed_id: &str, now: i64) -> Result<RefreshReport> {
        if self.subs.get(feed_id).is_none() {
            return Err(PodcastError::UnknownFeed(feed_id.to_string()));
        }
        let feed = self.provider.fetch(feed_id).await?;
        let report = RefreshReport {
            feed_id: feed_id.to_string(),
            title: display_title(&feed, feed_id),
            fetched_at: now,
            episode_count: feed.episodes.len(),
            truncated: feed.truncated,
        };
        self.library.put(feed_id, feed, now)?;
        self.subs.mark_refreshed(feed_id, &report.title, now)?;
        Ok(report)
    }

    /// Refresh every subscription, returning one outcome per feed.
    ///
    /// Always continues past a failure (one dead feed must not stop the rest)
    /// and reports each result, so the caller can show a partial success.
    pub async fn refresh_all(&mut self, now: i64) -> Vec<(String, Result<RefreshReport>)> {
        let ids: Vec<String> = self.subs.list().iter().map(|s| s.feed_id.clone()).collect();
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let res = self.refresh(&id, now).await;
            out.push((id, res));
        }
        out
    }

    /// Unsubscribe: drop the subscription, its cached episodes, and its progress
    /// records. Downloaded files are left to the caller (it owns the paths).
    pub fn unsubscribe(&mut self, feed_id: &str) -> Result<UnsubscribeReport> {
        let removed_subscription = self.subs.remove(feed_id)?;
        if !removed_subscription {
            return Ok(UnsubscribeReport {
                removed_subscription: false,
                dropped_cached_episodes: false,
                cleared_progress_records: 0,
            });
        }
        let dropped_cached_episodes = self.library.forget(feed_id)?;
        let cleared_progress_records = self.progress.clear_feed(feed_id)?;
        Ok(UnsubscribeReport {
            removed_subscription,
            dropped_cached_episodes,
            cleared_progress_records,
        })
    }

    /// Queue an offline download for one episode **of a cached feed**.
    ///
    /// Refuses ([`PodcastError::NoAudio`]) when the cache holds no such episode,
    /// or when the episode carries no enclosure URL. There would be no bytes to
    /// move in either case, and a `Queued` row for it is a status the screen
    /// draws as progress that can never advance.
    pub fn enqueue_download(&mut self, feed_id: &str, episode_id: &str, now: i64) -> Result<bool> {
        let episode = self
            .library
            .get(feed_id)
            .and_then(|c| c.feed.episodes.iter().find(|e| e.id == episode_id))
            .ok_or(PodcastError::NoAudio)?;
        if episode.audio_url.is_none() {
            return Err(PodcastError::NoAudio);
        }
        self.downloads
            .enqueue(&episode_uid(feed_id, episode_id), now)
    }

    /// Run one offline download to completion and return its terminal state.
    ///
    /// This is the transport driver the policy in [`crate::download`] was built
    /// for: it enqueues, marks the download started, asks the [`FeedProvider`]
    /// for the enclosure bytes, writes them under `dest`, and records
    /// `Done` / `Failed`. Without it the registry's `Done`/`Downloading`/`Failed`
    /// states were unreachable and a queued row never advanced.
    ///
    /// Pre-flight refusals (unknown episode, no enclosure URL, or an enclosure
    /// that is not `http(s)`) are `Err` — nothing was attempted. A **transport
    /// failure is data**, not an error: the record is marked `Failed` and that
    /// state is returned, because the caller renders it (with a retry) rather
    /// than treating the whole command as having failed.
    ///
    /// A download already `Done`/`Downloading`/`Queued` is not re-run; its
    /// current state is returned unchanged.
    pub async fn run_download(
        &mut self,
        feed_id: &str,
        episode_id: &str,
        dest: &Path,
        now: i64,
    ) -> Result<DownloadState> {
        let uid = episode_uid(feed_id, episode_id);
        let audio = self
            .library
            .get(feed_id)
            .and_then(|c| c.feed.episodes.iter().find(|e| e.id == episode_id))
            .and_then(|e| e.audio_url.clone())
            .ok_or(PodcastError::NoAudio)?;
        // The enclosure URL is feed-supplied data: gate it through the domain's
        // one URL rule (scheme + byte ceiling) before any transport sees it.
        let audio = normalize_feed_url(&audio)?;

        if matches!(
            self.downloads.state(&uid),
            DownloadState::Done { .. } | DownloadState::Downloading { .. } | DownloadState::Queued
        ) {
            return Ok(self.downloads.state(&uid));
        }

        self.downloads.enqueue(&uid, now)?;
        self.downloads.start(&uid, now)?;

        // Transport, then write. Both halves are reported the same way: a
        // failure leaves the record `Failed`, never stuck `Downloading`.
        let moved: std::result::Result<(String, u64), String> =
            match self.provider.fetch_episode(&audio).await {
                Ok(bytes) => match write_episode(dest, &uid, &audio, &bytes) {
                    Ok(path) => Ok((path, bytes.len() as u64)),
                    Err(e) => Err(e),
                },
                Err(e) => Err(e.to_string()),
            };

        match moved {
            Ok((path, bytes)) => self.downloads.finish(&uid, path, bytes, now)?,
            Err(reason) => self.downloads.fail(&uid, reason, now)?,
        }
        Ok(self.downloads.state(&uid))
    }
}

/// Write one episode's bytes under `dest` and return the absolute path.
///
/// The file name is a stable hash of the uid, not the uid itself: a uid is
/// `<feed url>::<episode id>` and contains `/`, so using it directly would make
/// the "file" a path. The enclosure's extension is preserved so the platform
/// player can open the result.
fn write_episode(
    dest: &Path,
    uid: &str,
    audio_url: &str,
    bytes: &[u8],
) -> std::result::Result<String, String> {
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("could not create {}: {e}", dest.display()))?;
    let path = dest.join(format!(
        "{:016x}.{}",
        fnv1a64(uid.as_bytes()),
        audio_ext(audio_url)
    ));
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// The enclosure's file extension, or `"audio"` when the URL carries none.
///
/// Only a short ASCII-alphanumeric suffix is accepted, so a hostile URL cannot
/// smuggle a path separator or a dotfile name into the downloaded file's name.
fn audio_ext(url: &str) -> String {
    let last = url.split(['?', '#']).next().unwrap_or(url);
    let seg = last.rsplit('/').next().unwrap_or("");
    match seg.rsplit_once('.') {
        Some((_, ext))
            if !ext.is_empty()
                && ext.len() <= 5
                && ext.chars().all(|c| c.is_ascii_alphanumeric()) =>
        {
            ext.to_ascii_lowercase()
        }
        _ => "audio".to_string(),
    }
}

/// FNV-1a, shared so the mock transport and the on-disk file name derive from
/// the same primitive (and neither pulls in a hashing dependency).
pub(crate) fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DownloadState, Episode, Feed};
    use crate::provider::MockFeedProvider;

    fn mgr() -> PodcastManager<MockFeedProvider> {
        PodcastManager::new(MockFeedProvider::new(), PodcastPaths::default())
    }

    #[tokio::test]
    async fn subscribe_fetches_then_stores() {
        let mut m = mgr();
        let sub = m
            .subscribe("https://feeds.amos.dev/rust-weekly.xml", 1000)
            .await
            .unwrap();
        assert_eq!(sub.title, "Rust Weekly");
        assert_eq!(sub.last_refreshed, Some(1000));
        assert_eq!(m.episodes(&sub.feed_id).unwrap().feed.episodes.len(), 3);
    }

    /// A feed with a markup-bearing channel title and a named set of episodes.
    fn feed(title: &str, episodes: Vec<Episode>) -> Feed {
        Feed {
            title: title.to_string(),
            episodes,
            ..Feed::default()
        }
    }

    fn ep(id: &str, audio: Option<&str>) -> Episode {
        Episode {
            id: id.to_string(),
            title: id.to_string(),
            description: String::new(),
            audio_url: audio.map(str::to_string),
            duration_secs: None,
            published: None,
        }
    }

    /// The subscription's title is the *display* title; the cache keeps the raw
    /// one. Reading the cache back would re-introduce the markup the store must
    /// not draw.
    #[tokio::test]
    async fn subscribe_stores_the_markup_stripped_title() {
        let mut m = PodcastManager::new(
            MockFeedProvider::with_feeds(vec![(
                "https://x.test/f.xml".to_string(),
                feed("<b>Rust</b> &amp; Friends", vec![]),
            )]),
            PodcastPaths::default(),
        );
        let sub = m.subscribe("https://x.test/f.xml", 1).await.unwrap();
        assert_eq!(sub.title, "Rust & Friends");
        assert_eq!(
            m.subscription(&sub.feed_id).unwrap().title,
            "Rust & Friends"
        );
        // The cache still holds the markup — that is the other fact, and why the
        // subscription must not be re-derived from it.
        assert_eq!(
            m.episodes(&sub.feed_id).unwrap().feed.title,
            "<b>Rust</b> & Friends"
        );
    }

    /// The show's *name* is what the parser reads from the channel, and it is what names the
    /// subscription — so a feed whose `<image>` carries the (RSS-required) `<title>` of its
    /// cover art must not end up with the subscription called "Cover art". The parser's own
    /// test pins the field; this one pins the consequence the user sees in the feed list.
    #[tokio::test]
    async fn the_subscription_is_named_from_the_channel_not_from_the_cover_art() {
        let xml = r#"<rss version="2.0">
  <channel>
    <title>Rust Weekly</title>
    <link>https://example.com/</link>
    <image>
      <url>https://example.com/cover.png</url>
      <title>Cover art</title>
      <link>https://img.example.com/</link>
    </image>
    <item>
      <title>One</title>
      <guid>e1</guid>
      <enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg"/>
    </item>
  </channel>
</rss>"#;
        let parsed = crate::feed::parse_feed(xml).expect("parses");
        let mut m = PodcastManager::new(
            MockFeedProvider::with_feeds(vec![("https://x.test/f.xml".to_string(), parsed)]),
            PodcastPaths::default(),
        );
        let sub = m.subscribe("https://x.test/f.xml", 1).await.unwrap();
        assert_eq!(sub.title, "Rust Weekly");
        // And the row the screen lists carries the same name, not the parser's.
        assert_eq!(
            m.subscription(&sub.feed_id).unwrap().display_title(),
            "Rust Weekly"
        );
    }

    #[tokio::test]
    async fn enqueue_download_refuses_an_episode_with_no_bytes_to_move() {
        let mut m = PodcastManager::new(
            MockFeedProvider::with_feeds(vec![(
                "https://x.test/f.xml".to_string(),
                feed(
                    "F",
                    vec![
                        ep("with-audio", Some("https://x.test/a.mp3")),
                        ep("no-audio", None),
                    ],
                ),
            )]),
            PodcastPaths::default(),
        );
        let id = m
            .subscribe("https://x.test/f.xml", 1)
            .await
            .unwrap()
            .feed_id;
        // An episode the feed never mentioned, and one with no enclosure: both
        // would be a `Queued` row for bytes that cannot arrive.
        assert!(matches!(
            m.enqueue_download(&id, "ghost", 2),
            Err(PodcastError::NoAudio)
        ));
        assert!(matches!(
            m.enqueue_download(&id, "no-audio", 2),
            Err(PodcastError::NoAudio)
        ));
        // The refusal minted no record (an `Absent` row is a state the screen draws).
        assert_eq!(
            m.downloads().state(&episode_uid(&id, "no-audio")),
            DownloadState::Absent
        );
        // Positive control: the playable one really does queue.
        assert!(m.enqueue_download(&id, "with-audio", 3).unwrap());
        assert_eq!(
            m.downloads().state(&episode_uid(&id, "with-audio")),
            DownloadState::Queued
        );
    }

    #[tokio::test]
    async fn a_failed_fetch_leaves_no_subscription_behind() {
        let mut m = mgr();
        assert!(m
            .subscribe("https://feeds.amos.dev/broken.xml", 1000)
            .await
            .is_err());
        assert!(m.subscriptions().is_empty());
    }

    #[test]
    fn add_subscription_records_never_fetched_distinctly() {
        let mut m = mgr();
        let sub = m
            .add_subscription("https://example.com/f.xml", None, 42)
            .unwrap();
        assert_eq!(sub.last_refreshed, None); // never fetched, not the epoch
        assert_eq!(sub.title, "https://example.com/f.xml");
        assert_eq!(sub.custom_title, None); // they gave no name
        assert!(m.episodes(&sub.feed_id).is_none());
    }

    /// The name the user typed is *theirs*: the feed renaming itself (and the
    /// refresh that records the new name) must not erase it. Two facts, two
    /// fields — the frontend's `subTitle` picks between them.
    #[tokio::test]
    async fn a_custom_name_survives_a_refresh_that_renames_the_feed() {
        let mut m = mgr();
        let sub = m
            .add_subscription(
                "https://feeds.amos.dev/rust-weekly.xml",
                Some("  My Rust Feed  "),
                42,
            )
            .unwrap();
        assert_eq!(sub.custom_title.as_deref(), Some("My Rust Feed")); // trimmed
        assert_eq!(sub.title, sub.url); // the feed's name is unknown until fetched
                                        // Nothing has been fetched yet, so the name the user typed is what is drawn.
        assert_eq!(
            m.subscription(&sub.feed_id).unwrap().display_title(),
            "My Rust Feed"
        );

        m.refresh(&sub.feed_id, 100).await.unwrap();

        let after = m.subscription(&sub.feed_id).unwrap();
        assert_eq!(after.title, "Rust Weekly"); // the feed's own name, now known
        assert_eq!(after.custom_title.as_deref(), Some("My Rust Feed"));
        assert_eq!(after.display_title(), "My Rust Feed"); // the user's still wins
                                                           // Positive control: with no custom name, the feed's name is what shows.
        let plain = m
            .subscribe("https://feeds.amos.dev/systems-cast.xml", 100)
            .await
            .unwrap();
        assert_eq!(
            m.subscription(&plain.feed_id).unwrap().display_title(),
            "Systems Cast"
        );
    }

    /// Naming an already-subscribed feed must set the name, not wipe the name
    /// the feed itself gave. `add_subscription` builds its row with `title = url`
    /// (the feed's name is unknown until a fetch), so a merge that lets *that*
    /// row overwrite an existing `title` would turn "Rust Weekly" into a URL —
    /// and drop the very name the user was trying to set.
    #[tokio::test]
    async fn re_adding_a_feed_sets_the_name_without_wiping_the_feeds_own() {
        let mut m = mgr();
        let sub = m
            .subscribe("https://feeds.amos.dev/rust-weekly.xml", 100)
            .await
            .unwrap();
        assert_eq!(sub.title, "Rust Weekly"); // learned from the fetch
        assert_eq!(sub.custom_title, None);

        // The user re-adds the same feed with a name of their own.
        let again = m
            .add_subscription(&sub.feed_id, Some("My Rust"), 200)
            .unwrap();
        assert_eq!(again.title, "Rust Weekly"); // the feed's name survives
        assert_eq!(again.custom_title.as_deref(), Some("My Rust"));
        assert_eq!(again.display_title(), "My Rust"); // and the user's wins
        assert_eq!(again.subscribed_at, sub.subscribed_at); // still the original row
        assert_eq!(m.subscriptions().len(), 1); // idempotent, not a second row

        // Negative control's sibling: re-adding with no name leaves the name alone.
        let bare = m.add_subscription(&sub.feed_id, None, 300).unwrap();
        assert_eq!(bare.custom_title.as_deref(), Some("My Rust"));
    }

    #[tokio::test]
    async fn refresh_updates_the_cache_and_timestamp() {
        let mut m = mgr();
        let sub = m
            .subscribe("https://feeds.amos.dev/systems-cast.xml", 100)
            .await
            .unwrap();
        let report = m.refresh(&sub.feed_id, 200).await.unwrap();
        assert_eq!(report.episode_count, 2);
        assert_eq!(report.fetched_at, 200);
        assert_eq!(
            m.subscription(&sub.feed_id).unwrap().last_refreshed,
            Some(200)
        );
    }

    #[tokio::test]
    async fn a_failed_refresh_keeps_the_previous_cache() {
        let mut m = mgr();
        let sub = m
            .subscribe("https://feeds.amos.dev/rust-weekly.xml", 100)
            .await
            .unwrap();
        // Corrupt the subscription's URL so the next fetch fails, but the cache
        // from the successful subscribe must survive.
        let before = m.episodes(&sub.feed_id).unwrap().feed.episodes.len();
        let bad = m.refresh("https://feeds.amos.dev/nope.xml", 200).await;
        assert!(bad.is_err());
        assert_eq!(
            m.episodes(&sub.feed_id).unwrap().feed.episodes.len(),
            before
        );
        // And an unknown id is a named refusal.
        assert!(matches!(
            m.refresh("https://unknown/", 1).await,
            Err(PodcastError::UnknownFeed(_))
        ));
    }

    #[tokio::test]
    async fn refresh_all_reports_per_feed_and_continues() {
        let mut m = mgr();
        m.subscribe("https://feeds.amos.dev/rust-weekly.xml", 1)
            .await
            .unwrap();
        m.add_subscription("https://dead.example/f.xml", None, 2)
            .unwrap();
        let out = m.refresh_all(300).await;
        assert_eq!(out.len(), 2);
        assert!(out.iter().any(|(_, r)| r.is_ok()));
        assert!(out.iter().any(|(_, r)| r.is_err()));
    }

    #[tokio::test]
    async fn unsubscribe_cleans_up_cache_and_progress() {
        let mut m = mgr();
        let sub = m
            .subscribe("https://feeds.amos.dev/rust-weekly.xml", 1)
            .await
            .unwrap();
        let uid = crate::model::episode_uid(&sub.feed_id, "rw-1");
        m.progress_mut()
            .set_position(&uid, 30.0, Some(60.0), 1)
            .unwrap();
        let report = m.unsubscribe(&sub.feed_id).unwrap();
        assert!(report.removed_subscription);
        assert!(report.dropped_cached_episodes);
        assert_eq!(report.cleared_progress_records, 1);
        assert!(m.episodes(&sub.feed_id).is_none());
        // A second unsubscribe reports nothing was removed.
        let again = m.unsubscribe(&sub.feed_id).unwrap();
        assert!(!again.removed_subscription);
    }

    /// A fresh temp directory for one test's downloaded files.
    fn dest(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "amos-podcast-run-{}-{}-{}",
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

    /// The point of the whole registry: a queued download reaches `Done` with
    /// real bytes on disk. Before `run_download` nothing moved them, so this
    /// state was unreachable and the row said "queued" forever.
    #[tokio::test]
    async fn run_download_moves_bytes_to_disk_and_reaches_done() {
        let mut m = mgr();
        let url = "https://feeds.amos.dev/rust-weekly.xml";
        m.subscribe(url, 1000).await.unwrap();
        let dest = dest("done");
        let uid = episode_uid(url, "rw-3");

        let state = m.run_download(url, "rw-3", &dest, 2000).await.unwrap();
        let (path, bytes) = match state {
            DownloadState::Done { path, bytes } => (path, bytes),
            other => panic!("expected Done, got {other:?}"),
        };
        assert!(
            bytes > 0,
            "a download that moved no bytes is not a download"
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            bytes,
            "the recorded size is the file's real size"
        );
        assert_eq!(std::fs::read(&path).unwrap().len() as u64, bytes);
        assert!(
            path.ends_with(".mp3"),
            "{path} must keep the enclosure extension"
        );
        assert!(m.downloads().is_done(&uid));
        assert_eq!(m.downloads().get(&uid).unwrap().attempts, 1);
        let _ = std::fs::remove_dir_all(&dest);
    }

    /// Re-running a finished download must not re-fetch bytes we already have:
    /// the file is not rewritten even after it is deleted underneath us.
    #[tokio::test]
    async fn run_download_does_not_re_fetch_what_is_already_done() {
        let mut m = mgr();
        let url = "https://feeds.amos.dev/rust-weekly.xml";
        m.subscribe(url, 1000).await.unwrap();
        let dest = dest("norefetch");
        let first = m.run_download(url, "rw-3", &dest, 2000).await.unwrap();
        let path = match first {
            DownloadState::Done { path, .. } => path,
            other => panic!("expected Done, got {other:?}"),
        };
        std::fs::remove_file(&path).unwrap();
        let again = m.run_download(url, "rw-3", &dest, 3000).await.unwrap();
        assert!(matches!(again, DownloadState::Done { .. }));
        assert!(
            !std::path::Path::new(&path).exists(),
            "a second run must not move bytes again for an episode we already have"
        );
        let _ = std::fs::remove_dir_all(&dest);
    }

    /// A transport failure is **data**: the record is `Failed` (not stuck
    /// `Downloading`, not an `Err` the caller would read as "the command
    /// failed"), and the reason is carried.
    #[tokio::test]
    async fn run_download_records_a_transport_failure_as_failed() {
        let url = "https://x.test/f.xml";
        let mut m = PodcastManager::new(
            MockFeedProvider::with_feeds(vec![(
                url.to_string(),
                feed(
                    "F",
                    vec![ep("b-1", Some("https://cdn.amos.dev/broken.mp3"))],
                ),
            )]),
            PodcastPaths::default(),
        );
        m.subscribe(url, 1).await.unwrap();
        let dest = dest("failed");
        let uid = episode_uid(url, "b-1");
        let state = m.run_download(url, "b-1", &dest, 2).await.unwrap();
        match state {
            DownloadState::Failed { reason } => assert!(!reason.is_empty()),
            other => panic!("expected Failed, got {other:?}"),
        }
        assert!(matches!(
            m.downloads().state(&uid),
            DownloadState::Failed { .. }
        ));
        // And it is retryable: a failed record may be queued again.
        assert!(m.downloads_mut().enqueue(&uid, 3).unwrap());
        let _ = std::fs::remove_dir_all(&dest);
    }

    /// Pre-flight refusals are errors — nothing was attempted, so no record is
    /// minted that the screen would draw as progress.
    #[tokio::test]
    async fn run_download_refuses_an_episode_with_no_audio() {
        let url = "https://x.test/f.xml";
        let mut m = PodcastManager::new(
            MockFeedProvider::with_feeds(vec![(url.to_string(), feed("F", vec![ep("t-1", None)]))]),
            PodcastPaths::default(),
        );
        m.subscribe(url, 1).await.unwrap();
        let dest = dest("noaudio");
        let uid = episode_uid(url, "t-1");
        assert_eq!(
            m.run_download(url, "t-1", &dest, 2).await,
            Err(PodcastError::NoAudio)
        );
        assert!(!m.downloads().get(&uid).is_some_and(|r| {
            matches!(
                r.state,
                DownloadState::Queued
                    | DownloadState::Downloading { .. }
                    | DownloadState::Done { .. }
            )
        }));
        // And an episode the cache does not hold is the same refusal.
        assert_eq!(
            m.run_download(url, "ghost", &dest, 3).await,
            Err(PodcastError::NoAudio)
        );
        let _ = std::fs::remove_dir_all(&dest);
    }

    /// A `file:` enclosure is refused before any transport runs — it is
    /// feed-supplied data and must not become a local-file read.
    #[tokio::test]
    async fn run_download_refuses_a_non_http_enclosure() {
        let url = "https://x.test/f.xml";
        let mut m = PodcastManager::new(
            MockFeedProvider::with_feeds(vec![(
                url.to_string(),
                feed("F", vec![ep("l-1", Some("file:///etc/passwd"))]),
            )]),
            PodcastPaths::default(),
        );
        m.subscribe(url, 1).await.unwrap();
        let dest = dest("scheme");
        assert_eq!(
            m.run_download(url, "l-1", &dest, 2).await,
            Err(PodcastError::UrlSchemeUnsupported)
        );
        let _ = std::fs::remove_dir_all(&dest);
    }

    /// `OsString` holding bytes that are not valid UTF-8 (tests only).
    #[cfg(unix)]
    fn non_unicode_path(raw: &[u8]) -> std::ffi::OsString {
        use std::os::unix::ffi::OsStrExt;
        std::ffi::OsString::from(std::ffi::OsStr::from_bytes(raw))
    }

    fn env_from(
        pairs: &'static [(&'static str, &'static str)],
    ) -> impl Fn(&str) -> Option<std::ffi::OsString> {
        move |name: &str| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| std::ffi::OsString::from(*v))
        }
    }

    #[test]
    fn an_unset_path_knob_is_none_and_silent() {
        assert_eq!(path_knob("TEST_PODCAST_UNSET", None), None);
        assert_eq!(unusable_path_knob_reports_for("TEST_PODCAST_UNSET"), 0);
    }

    #[test]
    fn a_usable_path_knob_is_taken_as_given() {
        assert_eq!(
            path_knob(
                "TEST_PODCAST_USABLE",
                Some(std::ffi::OsString::from("/srv/amos-podcast"))
            ),
            Some(PathBuf::from("/srv/amos-podcast"))
        );
        assert_eq!(unusable_path_knob_reports_for("TEST_PODCAST_USABLE"), 0);
    }

    #[test]
    fn a_blank_path_knob_keeps_the_ephemeral_default() {
        let blank = path_knob("TEST_PODCAST_BLANK", Some("   ".into()));
        assert_eq!(blank, None);
        // The pre-fix read only rejected the *empty* string, so `"   "` became a
        // literal relative directory made of spaces — assert against it directly.
        assert_ne!(blank, Some(PathBuf::from("   ")));
    }

    #[cfg(unix)]
    #[test]
    fn a_non_unicode_path_knob_is_reported_not_read_as_unset() {
        let key = "TEST_PODCAST_NONUNICODE";
        assert_eq!(path_knob(key, Some(non_unicode_path(b"/srv/\xff"))), None);
        assert_eq!(
            unusable_path_knob_reports_for(key),
            1,
            "a set-but-unreadable store path must be named once, not folded into unset"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_repeated_bad_path_knob_is_reported_once() {
        let key = "TEST_PODCAST_DEDUP";
        assert_eq!(path_knob(key, Some(non_unicode_path(b"/srv/\xfe"))), None);
        assert_eq!(path_knob(key, Some(non_unicode_path(b"/srv/\xfe"))), None);
        assert_eq!(unusable_path_knob_reports_for(key), 1);
    }

    #[test]
    fn the_directory_places_all_four_stores() {
        let paths = PodcastPaths::from_env_with(env_from(&[(DIR_ENV, "/srv/pc")]));
        assert_eq!(
            paths.subscriptions,
            Some(PathBuf::from("/srv/pc/subscriptions.json"))
        );
        assert_eq!(paths.library, Some(PathBuf::from("/srv/pc/library.json")));
        assert_eq!(paths.progress, Some(PathBuf::from("/srv/pc/progress.json")));
        assert_eq!(
            paths.downloads,
            Some(PathBuf::from("/srv/pc/downloads.json"))
        );
    }

    #[test]
    fn a_per_store_override_wins_over_the_directory() {
        let paths = PodcastPaths::from_env_with(env_from(&[
            (DIR_ENV, "/srv/pc"),
            (PROGRESS_ENV, "/var/pc/progress.json"),
        ]));
        assert_eq!(paths.progress, Some(PathBuf::from("/var/pc/progress.json")));
        assert_eq!(paths.library, Some(PathBuf::from("/srv/pc/library.json")));
    }

    #[test]
    fn a_blank_override_falls_through_to_the_directory() {
        // A whitespace-only override is "not set", not a directory of spaces.
        let paths =
            PodcastPaths::from_env_with(env_from(&[(DIR_ENV, "/srv/pc"), (DOWNLOADS_ENV, "   ")]));
        assert_eq!(
            paths.downloads,
            Some(PathBuf::from("/srv/pc/downloads.json"))
        );
    }

    #[test]
    fn no_directory_at_all_keeps_every_store_ephemeral() {
        let paths = PodcastPaths::from_env_with(env_from(&[]));
        assert_eq!(paths.subscriptions, None);
        assert_eq!(paths.library, None);
        assert_eq!(paths.progress, None);
        assert_eq!(paths.downloads, None);
    }

    #[cfg(unix)]
    #[test]
    fn a_non_unicode_directory_keeps_the_stores_ephemeral_but_is_reported() {
        let bad = non_unicode_path(b"/srv/\xfd");
        let paths = PodcastPaths::from_env_with(move |name: &str| {
            if name == DIR_ENV {
                Some(bad.clone())
            } else {
                None
            }
        });
        assert_eq!(paths.subscriptions, None);
        assert_eq!(paths.library, None);
        assert_eq!(
            unusable_path_knob_reports_for(DIR_ENV),
            1,
            "the operator named a store directory; unset is the wrong story"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_non_unicode_override_falls_through_but_is_reported() {
        let bad = non_unicode_path(b"/var/\xfc");
        let paths = PodcastPaths::from_env_with(move |name: &str| match name {
            DIR_ENV => Some(std::ffi::OsString::from("/srv/pc")),
            PROGRESS_ENV => Some(bad.clone()),
            _ => None,
        });
        assert_eq!(paths.progress, Some(PathBuf::from("/srv/pc/progress.json")));
        assert_eq!(unusable_path_knob_reports_for(PROGRESS_ENV), 1);
    }

    #[test]
    fn the_path_knobs_are_read_via_var_os_not_var() {
        let src = include_str!("manager.rs");
        let production = src
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("production half");
        let needle = format!("std::env::var(\"{}\")", DIR_ENV);
        assert!(
            !production.contains(&needle),
            "a store-path knob must not be read with the folding `std::env::var`"
        );
        assert!(production.contains("std::env::var_os(name)"));
    }
}
