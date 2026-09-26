//! `provider.rs` — the single seam between the podcast domain and the outside
//! world.
//!
//! ```text
//! [ CLI / Tauri bridge ] --> PodcastManager<P> --> P: FeedProvider
//!                                                   ├─ MockFeedProvider  (deterministic, offline)
//!                                                   └─ HttpFeedProvider  (feature `live`, real HTTP)
//! ```
//!
//! The domain never performs network I/O of its own: it asks a [`FeedProvider`]
//! for a parsed [`Feed`]. Swapping the backend therefore changes no engine,
//! store, CLI or UI code — exactly the split `amos-appstore` uses for its
//! `StoreProvider`.

use async_trait::async_trait;

use crate::error::{PodcastError, Result};
use crate::model::{normalize_feed, normalize_feed_url, Feed};

// Only the `live` HTTP provider uses these.
#[cfg(feature = "live")]
use crate::error::bounded_detail;
#[cfg(feature = "live")]
use crate::feed::parse_feed;

/// Upper bound on the bytes a single episode download may hold.
///
/// Enforced by the providers *before* the whole body is buffered, so a hostile
/// or merely enormous enclosure cannot exhaust memory by streaming forever. 256
/// MiB is far above a normal podcast episode and still a hard ceiling.
pub const MAX_EPISODE_BYTES: usize = 256 * 1024 * 1024;

/// Something that can turn a feed URL into a parsed [`Feed`].
///
/// Implementations must be `Send + Sync` so the manager can be shared across the
/// Tauri command pool / the async runtime.
#[async_trait]
pub trait FeedProvider: Send + Sync {
    /// Fetch and parse `url`. The URL is re-validated here (not just at
    /// subscribe time) because a stored subscription is data that may predate
    /// the current validation rules.
    async fn fetch(&self, url: &str) -> Result<Feed>;

    /// Move the raw bytes of one episode enclosure at `url`.
    ///
    /// This is the transport half of an offline download: the domain drives the
    /// scheduling (see [`crate::download`]) but never speaks HTTP itself, so the
    /// bytes come from here. The default refuses with
    /// [`PodcastError::DownloadUnsupported`] rather than moving nothing: a
    /// provider that only knows how to read feeds must not let a download appear
    /// to succeed with zero bytes.
    ///
    /// Implementations must enforce [`MAX_EPISODE_BYTES`] and refuse a non-http
    /// scheme (an enclosure URL is feed-supplied data, so `file:` would be a
    /// local-file read).
    async fn fetch_episode(&self, _url: &str) -> Result<Vec<u8>> {
        Err(PodcastError::DownloadUnsupported)
    }

    /// Human-readable name of the backend, for status output.
    fn name(&self) -> &'static str;
}

/// Blanket impl so a boxed provider can stand anywhere a concrete one can — the
/// seam that lets a bridge hold `PodcastManager<Box<dyn FeedProvider>>` and swap
/// the offline mock for a live HTTP backend at runtime with no engine changes.
#[async_trait]
impl FeedProvider for Box<dyn FeedProvider> {
    async fn fetch(&self, url: &str) -> Result<Feed> {
        (**self).fetch(url).await
    }

    async fn fetch_episode(&self, url: &str) -> Result<Vec<u8>> {
        (**self).fetch_episode(url).await
    }

    fn name(&self) -> &'static str {
        (**self).name()
    }
}

/// Deterministic, offline provider that serves a small fixed catalog.
///
/// This is the default backend so the workspace builds, tests and runs with
/// **zero network**. It also accepts any URL with a `/broken` path segment and
/// returns a parse failure, so the CLI/UI failure path is exercisable without a
/// real network.
pub struct MockFeedProvider {
    feeds: Vec<(String, Feed)>,
}

impl Default for MockFeedProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl MockFeedProvider {
    pub fn new() -> Self {
        MockFeedProvider {
            feeds: builtin_catalog(),
        }
    }

    /// Replace the built-in catalog (tests use this to pin a specific feed).
    pub fn with_feeds(feeds: Vec<(String, Feed)>) -> Self {
        MockFeedProvider { feeds }
    }

    /// The URLs this provider can serve — the CLI's "discover" surface.
    pub fn catalog_urls(&self) -> Vec<String> {
        self.feeds.iter().map(|(u, _)| u.clone()).collect()
    }
}

#[async_trait]
impl FeedProvider for MockFeedProvider {
    async fn fetch(&self, url: &str) -> Result<Feed> {
        let url = normalize_feed_url(url)?;
        if url.contains("/broken") {
            return Err(PodcastError::ParseFailed(
                "mock: feed is not well-formed".into(),
            ));
        }
        self.feeds
            .iter()
            .find(|(u, _)| u == &url)
            .map(|(_, f)| normalize_feed(f.clone()))
            .ok_or_else(|| PodcastError::FetchFailed(format!("mock: no feed at {url}")))
    }

    /// Deterministic canned bytes, so an offline download reaches `Done` for
    /// real (a length the tests can predict) with no network.
    ///
    /// The enclosure count is derived from the URL, so two episodes have
    /// different sizes and a test can tell them apart. A URL containing
    /// `/broken` fails at the transport, so the `Failed` path is exercisable
    /// offline too.
    async fn fetch_episode(&self, url: &str) -> Result<Vec<u8>> {
        let url = require_http_url(url)?;
        if url.contains("/broken") {
            return Err(PodcastError::DownloadFailed(
                "mock: enclosure is not reachable".into(),
            ));
        }
        // 1 KiB..5 KiB, stable per URL and distinct across URLs.
        let n = 1024 + (crate::manager::fnv1a64(url.as_bytes()) % 4096) as usize;
        Ok((0..n).map(|i| (i % 251) as u8).collect())
    }

    fn name(&self) -> &'static str {
        "mock"
    }
}

/// Refuse an enclosure URL that is not `http(s)`.
///
/// An enclosure URL is feed-supplied data, so a `file:` URL would turn "cache
/// this episode" into a local-file read. Shared by every provider so the rule
/// cannot drift between the mock and the live transport.
pub(crate) fn require_http_url(url: &str) -> Result<String> {
    let url = url.trim();
    if url.is_empty() || url.len() > crate::model::MAX_URL_BYTES {
        return Err(PodcastError::UrlInvalid);
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(PodcastError::UrlSchemeUnsupported);
    }
    Ok(url.to_string())
}

fn ep(id: &str, title: &str, audio: &str, dur: u64, day: i64) -> crate::model::Episode {
    crate::model::Episode {
        id: id.to_string(),
        title: title.to_string(),
        description: format!("{title} — a deterministic offline episode."),
        audio_url: Some(audio.to_string()),
        duration_secs: Some(dur),
        published: Some(day),
    }
}

/// The built-in demo catalog. Stable ids/timestamps so a test (or a demo) that
/// subscribes to one of these always sees the same episodes.
pub fn builtin_catalog() -> Vec<(String, Feed)> {
    vec![
        (
            "https://feeds.amos.dev/rust-weekly.xml".to_string(),
            Feed {
                title: "Rust Weekly".to_string(),
                author: "Amos Demo".to_string(),
                description: "Weekly Rust news and deep dives.".to_string(),
                link: "https://feeds.amos.dev/rust-weekly".to_string(),
                image_url: None,
                episodes: vec![
                    ep(
                        "rw-3",
                        "Ownership in depth",
                        "https://cdn.amos.dev/rw-3.mp3",
                        2760,
                        1_700_000_000,
                    ),
                    ep(
                        "rw-2",
                        "Async runtimes compared",
                        "https://cdn.amos.dev/rw-2.mp3",
                        3120,
                        1_699_600_000,
                    ),
                    ep(
                        "rw-1",
                        "The 2024 edition",
                        "https://cdn.amos.dev/rw-1.mp3",
                        1980,
                        1_699_200_000,
                    ),
                ],
                truncated: false,
            },
        ),
        (
            "https://feeds.amos.dev/systems-cast.xml".to_string(),
            Feed {
                title: "Systems Cast".to_string(),
                author: "Amos Demo".to_string(),
                description: "Operating systems, schedulers, and the occasional kernel panic."
                    .to_string(),
                link: "https://feeds.amos.dev/systems-cast".to_string(),
                image_url: None,
                episodes: vec![
                    ep(
                        "sc-2",
                        "Schedulers that don't starve",
                        "https://cdn.amos.dev/sc-2.mp3",
                        3300,
                        1_700_100_000,
                    ),
                    ep(
                        "sc-1",
                        "Boot, and how long it takes",
                        "https://cdn.amos.dev/sc-1.mp3",
                        2400,
                        1_699_700_000,
                    ),
                ],
                truncated: false,
            },
        ),
    ]
}

/// A real HTTP fetcher, gated behind the `live` feature.
///
/// Kept out of the default build so the offline workspace stays green (mirrors
/// `amos-appstore`'s `live` gating): without the feature, the env-var that
/// selects it is ignored and the mock catalog is used.
#[cfg(feature = "live")]
pub struct HttpFeedProvider {
    timeout: std::time::Duration,
    max_bytes: usize,
}

#[cfg(feature = "live")]
impl Default for HttpFeedProvider {
    fn default() -> Self {
        HttpFeedProvider {
            timeout: std::time::Duration::from_secs(20),
            // A feed larger than this is refused before it is buffered, so a
            // hostile server cannot exhaust memory by streaming forever.
            max_bytes: crate::feed::MAX_XML_BYTES,
        }
    }
}

#[cfg(feature = "live")]
impl HttpFeedProvider {
    pub fn new() -> Self {
        Self::default()
    }

    /// A provider with a custom timeout (tests use a short one).
    pub fn with_timeout(timeout: std::time::Duration) -> Self {
        HttpFeedProvider {
            timeout,
            ..Self::default()
        }
    }
}

#[cfg(feature = "live")]
#[async_trait]
impl FeedProvider for HttpFeedProvider {
    async fn fetch(&self, url: &str) -> Result<Feed> {
        let url = normalize_feed_url(url)?;
        let timeout = self.timeout;
        let max_bytes = self.max_bytes;
        let target = url.clone();
        // ureq is blocking; run it on the blocking pool so the async runtime is
        // never stalled by a slow server.
        let body = tokio::task::spawn_blocking(move || -> Result<String> {
            let agent = ureq::AgentBuilder::new().timeout(timeout).build();
            let resp = agent
                .get(&target)
                .set(
                    "Accept",
                    "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
                )
                .call()
                .map_err(|e| PodcastError::FetchFailed(bounded_detail(&e.to_string())))?;
            let mut reader = std::io::Read::take(resp.into_reader(), max_bytes as u64 + 1);
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut reader, &mut buf)
                .map_err(|e| PodcastError::FetchFailed(bounded_detail(&e.to_string())))?;
            if buf.len() > max_bytes {
                return Err(PodcastError::FetchFailed(format!(
                    "response exceeds {max_bytes} bytes"
                )));
            }
            String::from_utf8(buf)
                .map_err(|_| PodcastError::ParseFailed("feed is not valid UTF-8".into()))
        })
        .await
        .map_err(|e| PodcastError::FetchFailed(format!("fetch task failed: {e}")))?;

        parse_feed(&body?)
    }

    /// Real HTTP GET of one enclosure. Bounded by [`MAX_EPISODE_BYTES`] and the
    /// configured timeout, and run on the blocking pool so a slow CDN never
    /// stalls the async runtime.
    async fn fetch_episode(&self, url: &str) -> Result<Vec<u8>> {
        let url = require_http_url(url)?;
        let timeout = self.timeout;
        let target = url.clone();
        let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
            let agent = ureq::AgentBuilder::new().timeout(timeout).build();
            let resp = agent
                .get(&target)
                .set("Accept", "audio/*, application/octet-stream, */*")
                .call()
                .map_err(|e| PodcastError::DownloadFailed(bounded_detail(&e.to_string())))?;
            let mut reader = std::io::Read::take(resp.into_reader(), MAX_EPISODE_BYTES as u64 + 1);
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut reader, &mut buf)
                .map_err(|e| PodcastError::DownloadFailed(bounded_detail(&e.to_string())))?;
            if buf.len() > MAX_EPISODE_BYTES {
                return Err(PodcastError::DownloadFailed(format!(
                    "enclosure exceeds {MAX_EPISODE_BYTES} bytes"
                )));
            }
            Ok(buf)
        })
        .await
        .map_err(|e| PodcastError::DownloadFailed(format!("download task failed: {e}")))?;
        bytes
    }

    fn name(&self) -> &'static str {
        "http"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_serves_the_builtin_catalog() {
        let p = MockFeedProvider::new();
        let f = p
            .fetch("https://feeds.amos.dev/rust-weekly.xml")
            .await
            .unwrap();
        assert_eq!(f.title, "Rust Weekly");
        assert_eq!(f.episodes.len(), 3);
        assert_eq!(p.catalog_urls().len(), 2);
    }

    #[tokio::test]
    async fn mock_refuses_an_unknown_url_and_a_non_http_scheme() {
        let p = MockFeedProvider::new();
        assert!(matches!(
            p.fetch("https://feeds.amos.dev/nope.xml").await,
            Err(PodcastError::FetchFailed(_))
        ));
        assert_eq!(
            p.fetch("file:///etc/passwd").await,
            Err(PodcastError::UrlSchemeUnsupported)
        );
    }

    #[tokio::test]
    async fn mock_exposes_a_broken_feed_for_failure_paths() {
        let p = MockFeedProvider::new();
        assert!(matches!(
            p.fetch("https://feeds.amos.dev/broken.xml").await,
            Err(PodcastError::ParseFailed(_))
        ));
    }

    #[tokio::test]
    async fn mock_is_deterministic() {
        let p = MockFeedProvider::new();
        let a = p
            .fetch("https://feeds.amos.dev/systems-cast.xml")
            .await
            .unwrap();
        let b = p
            .fetch("https://feeds.amos.dev/systems-cast.xml")
            .await
            .unwrap();
        assert_eq!(a, b);
    }

    #[tokio::test]
    async fn mock_moves_real_bytes_for_an_enclosure() {
        let p = MockFeedProvider::new();
        let a = p
            .fetch_episode("https://cdn.amos.dev/rw-3.mp3")
            .await
            .unwrap();
        assert!(
            !a.is_empty(),
            "a download that moves no bytes is not a download"
        );
        // Stable per URL and distinct across URLs, so a test can tell them apart.
        let again = p
            .fetch_episode("https://cdn.amos.dev/rw-3.mp3")
            .await
            .unwrap();
        assert_eq!(a, again);
        let other = p
            .fetch_episode("https://cdn.amos.dev/rw-2.mp3")
            .await
            .unwrap();
        assert_ne!(a.len(), other.len());
    }

    #[tokio::test]
    async fn mock_refuses_a_local_file_enclosure() {
        // A `file:` enclosure must never be read: that is a local-file read
        // reached through feed-supplied data.
        let p = MockFeedProvider::new();
        assert_eq!(
            p.fetch_episode("file:///etc/passwd").await,
            Err(PodcastError::UrlSchemeUnsupported)
        );
    }

    #[tokio::test]
    async fn mock_exposes_a_broken_enclosure_for_the_failure_path() {
        let p = MockFeedProvider::new();
        assert!(matches!(
            p.fetch_episode("https://cdn.amos.dev/broken.mp3").await,
            Err(PodcastError::DownloadFailed(_))
        ));
    }

    #[tokio::test]
    async fn the_default_transport_refuses_instead_of_moving_nothing() {
        // A provider that only knows feeds must not let a download read as
        // having happened with zero bytes.
        struct FeedsOnly;
        #[async_trait]
        impl FeedProvider for FeedsOnly {
            async fn fetch(&self, _url: &str) -> Result<Feed> {
                Err(PodcastError::FetchFailed("nope".into()))
            }
            fn name(&self) -> &'static str {
                "feeds-only"
            }
        }
        assert_eq!(
            FeedsOnly
                .fetch_episode("https://cdn.amos.dev/rw-3.mp3")
                .await,
            Err(PodcastError::DownloadUnsupported)
        );
    }
}
