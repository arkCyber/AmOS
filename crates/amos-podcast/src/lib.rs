//! `amos-podcast` — the Amos **podcast domain core**.
//!
//! A transport-agnostic crate that encodes the *domain* of podcasts — what a
//! feed is, what an episode is, how a subscription and a playhead persist — in
//! pure Rust, so the **same** engine drives a headless CLI, the Tauri System UI
//! bridge, and any future frontend. This is exactly the split the rest of Amos
//! uses (`amos-appstore` / `amos-mail` / `amos-int`).
//!
//! # Shape
//!
//! ```text
//! [ CLI / Tauri bridge ] --> PodcastManager<P> --> P: FeedProvider
//!                                                   ├─ MockFeedProvider  (deterministic, offline)
//!                                                   └─ HttpFeedProvider  (feature `live`, real HTTP)
//! ```
//!
//! `PodcastManager` folds five pieces:
//!
//! * [`feed`] parses RSS 2.0 / Atom into [`model::Feed`] (a real XML parser,
//!   bounded depth/size/text and a reported truncation cap).
//! * [`provider`] is the single seam to the outside — the domain performs **no
//!   network I/O of its own**.
//! * [`store`] persists subscriptions (bounded, refuses past the cap);
//!   [`library`] caches fetched episodes (bounded, evicts); [`progress`] keeps
//!   per-episode playheads and [`download`] the offline-download registry.
//!
//! # The one rule this crate enforces everywhere
//!
//! **An unknown is never folded into a measured zero.** `Episode::duration_secs`
//! and `Episode::published` are `Option` because a feed may omit them, and a UI
//! that renders `None` as `0:00` / the epoch is claiming data the feed never
//! gave. `Subscription::last_refreshed: Option<i64>` distinguishes "never
//! fetched" from "fetched at the epoch", which is the difference between "no
//! episodes yet" and "we have not looked". Every normalizer here preserves that.
//!
//! # Honest boundaries
//!
//! * This crate is **not** a player: it models playback *progress*, but decoding
//!   and rendering audio is the platform player's job (the Tauri `PlayerApp`).
//! * Downloaded bytes are moved through the [`provider::FeedProvider`] seam
//!   ([`provider::FeedProvider::fetch_episode`]) and written to disk by
//!   [`manager::PodcastManager::run_download`]; [`download::DownloadRegistry`]
//!   records their state and the scheduling *policy*. A provider that has no
//!   transport refuses ([`error::PodcastError::DownloadUnsupported`]) rather
//!   than letting a download read as having moved zero bytes.
//! * Real HTTP fetching is behind the `live` feature and off by default, so the
//!   workspace builds, tests and runs offline.

// P0-1 gate: production code must not panic on programmer error (tests exempt).
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod download;
pub mod error;
pub mod feed;
pub mod library;
pub mod manager;
pub mod model;
pub mod persist;
pub mod progress;
pub mod provider;
pub mod store;

#[cfg(feature = "live")]
pub use provider::HttpFeedProvider;
pub use provider::{builtin_catalog, FeedProvider, MockFeedProvider};

pub use download::{
    DownloadRecord, DownloadRegistry, MAX_CONCURRENT_DOWNLOADS, MAX_DOWNLOAD_ATTEMPTS,
    MAX_DOWNLOAD_RECORDS,
};
pub use error::{bounded_detail, PodcastError, Result};
pub use feed::{parse_date, parse_duration, parse_feed, MAX_XML_BYTES, MAX_XML_DEPTH};
pub use library::{CachedFeed, EpisodeLibrary, MAX_CACHED_FEEDS};
pub use manager::{PodcastManager, PodcastPaths, RefreshReport, UnsubscribeReport};
pub use model::{
    episode_uid, format_duration, normalize_feed_url, progress_fraction, DownloadState, Episode,
    EpisodeProgress, Feed, Subscription, MAX_EPISODES_PER_FEED, MAX_ID_BYTES, MAX_SPEED,
    MAX_URL_BYTES, MIN_SPEED,
};
pub use progress::{clamp_speed, ProgressStore, MAX_PROGRESS_RECORDS};
pub use store::{StoreLoad, SubscriptionStore, MAX_SUBSCRIPTIONS};
