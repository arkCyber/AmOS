//! `library.rs` — the persisted episode cache (what makes the app work offline).
//!
//! A subscription stores *which* feeds the user follows; this store keeps the
//! last successfully fetched episode list for each, so opening the app with no
//! network still shows content and — critically — so the screen can say
//! "as of <time>" rather than presenting stale data as fresh.
//!
//! Unlike [`crate::store::SubscriptionStore`] this **is** a cache, so it evicts:
//! past [`MAX_CACHED_FEEDS`] the least-recently-fetched feed is dropped. Eviction
//! is safe here because the data is re-derivable by a refresh; a *subscription* is
//! not, which is why that store refuses instead.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::model::{normalize_feed, Feed};
use crate::persist::{load_json, save_json, LoadOutcome};

/// How many feeds' episode lists to keep. Comfortably above a realistic
/// subscription count while bounding the file.
pub const MAX_CACHED_FEEDS: usize = 500;

/// One feed's cached episodes plus when they were fetched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedFeed {
    /// When this snapshot was fetched, unix seconds. Always present (a cache entry
    /// without a timestamp could not report its own staleness), so it is the one
    /// field here **without** a serde default — an entry that lost its timestamp
    /// is not silently re-dated (which would render as the epoch, the very thing
    /// this crate forbids); the file is reported `Corrupt` instead.
    pub fetched_at: i64,
    /// `#[serde(default)]`: a cached feed that predates a `Feed` field must
    /// degrade to an empty field, not fold the whole cache (and every *other*
    /// feed's episodes) to empty over one missing key.
    #[serde(default)]
    pub feed: Feed,
}

pub struct EpisodeLibrary {
    path: Option<PathBuf>,
    entries: HashMap<String, CachedFeed>,
    outcome: LoadOutcome,
}

impl EpisodeLibrary {
    pub fn open(path: Option<PathBuf>) -> Self {
        match path {
            None => EpisodeLibrary {
                path: None,
                entries: HashMap::new(),
                outcome: LoadOutcome::Ephemeral,
            },
            Some(p) => {
                let (raw, outcome): (HashMap<String, CachedFeed>, _) = load_json(&p);
                let mut entries: HashMap<String, CachedFeed> = raw
                    .into_iter()
                    .map(|(k, v)| {
                        (
                            k,
                            CachedFeed {
                                fetched_at: v.fetched_at,
                                feed: normalize_feed(v.feed),
                            },
                        )
                    })
                    .collect();
                if entries.len() > MAX_CACHED_FEEDS {
                    evict_to_cap(&mut entries);
                }
                EpisodeLibrary {
                    path: Some(p),
                    entries,
                    outcome,
                }
            }
        }
    }

    pub fn load_outcome(&self) -> LoadOutcome {
        self.outcome
    }

    pub fn get(&self, feed_id: &str) -> Option<&CachedFeed> {
        self.entries.get(feed_id)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Record a fresh snapshot for `feed_id`, evicting the least-recently-fetched
    /// entry if that pushes the cache past the cap.
    pub fn put(&mut self, feed_id: &str, feed: Feed, fetched_at: i64) -> Result<()> {
        self.entries.insert(
            feed_id.to_string(),
            CachedFeed {
                fetched_at,
                feed: normalize_feed(feed),
            },
        );
        if self.entries.len() > MAX_CACHED_FEEDS {
            evict_to_cap(&mut self.entries);
        }
        self.save()
    }

    /// Drop a feed's cached episodes (used on unsubscribe).
    pub fn forget(&mut self, feed_id: &str) -> Result<bool> {
        let removed = self.entries.remove(feed_id).is_some();
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    fn save(&self) -> Result<()> {
        match &self.path {
            Some(p) => save_json(p, &self.entries),
            None => Ok(()),
        }
    }
}

/// Evict least-recently-fetched entries until the map is within the cap.
fn evict_to_cap(entries: &mut HashMap<String, CachedFeed>) {
    while entries.len() > MAX_CACHED_FEEDS {
        let victim = entries
            .iter()
            .min_by_key(|(_, v)| v.fetched_at)
            .map(|(k, _)| k.clone());
        match victim {
            Some(k) => {
                entries.remove(&k);
            }
            None => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Episode;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "amos-podcast-lib-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d.join("lib.json")
    }

    fn feed(title: &str, n: usize) -> Feed {
        Feed {
            title: title.into(),
            episodes: (0..n)
                .map(|i| Episode {
                    id: format!("e{i}"),
                    title: format!("E{i}"),
                    description: String::new(),
                    audio_url: None,
                    duration_secs: None,
                    published: None,
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn put_get_forget_round_trip() {
        let mut lib = EpisodeLibrary::open(None);
        lib.put("f", feed("T", 2), 100).unwrap();
        assert_eq!(lib.get("f").unwrap().feed.episodes.len(), 2);
        assert_eq!(lib.get("f").unwrap().fetched_at, 100);
        assert!(lib.forget("f").unwrap());
        assert!(lib.get("f").is_none());
        assert!(!lib.forget("f").unwrap());
    }

    #[test]
    fn persists_and_reopens_with_timestamps() {
        let path = tmp();
        {
            let mut lib = EpisodeLibrary::open(Some(path.clone()));
            lib.put("f", feed("T", 1), 55).unwrap();
        }
        let lib = EpisodeLibrary::open(Some(path));
        assert_eq!(lib.load_outcome(), LoadOutcome::Loaded);
        assert_eq!(lib.get("f").unwrap().fetched_at, 55);
    }

    #[test]
    fn evicts_the_least_recently_fetched_past_the_cap() {
        let mut lib = EpisodeLibrary::open(None);
        for i in 0..MAX_CACHED_FEEDS {
            lib.put(&format!("f{i}"), feed("T", 1), i as i64).unwrap();
        }
        assert_eq!(lib.len(), MAX_CACHED_FEEDS);
        // One more pushes out f0 (the oldest fetched_at).
        lib.put("new", feed("T", 1), 10_000).unwrap();
        assert_eq!(lib.len(), MAX_CACHED_FEEDS);
        assert!(lib.get("f0").is_none());
        assert!(lib.get("new").is_some());
    }

    /// The asymmetry: a cache entry that lost a *feed* field still loads (the
    /// feed degrades to an empty one), but an entry that lost its timestamp is a
    /// hard failure — re-dating it to 0 would render the epoch, which this crate
    /// forbids. Degrade what has a safe default; refuse what does not.
    #[test]
    fn a_cached_feed_missing_a_field_survives_but_a_missing_timestamp_does_not() {
        let path = tmp();
        std::fs::write(&path, br#"{"f":{"fetched_at":77,"feed":{"title":"T"}}}"#).unwrap();
        let lib = EpisodeLibrary::open(Some(path.clone()));
        assert_eq!(lib.load_outcome(), LoadOutcome::Loaded);
        assert_eq!(lib.get("f").unwrap().fetched_at, 77);
        assert_eq!(lib.get("f").unwrap().feed.title, "T");

        std::fs::write(&path, br#"{"f":{"feed":{"title":"T"}}}"#).unwrap();
        let lib = EpisodeLibrary::open(Some(path));
        assert_eq!(lib.load_outcome(), LoadOutcome::Corrupt);
    }

    #[test]
    fn a_corrupt_file_loads_empty_and_reports_it() {
        let path = tmp();
        std::fs::write(&path, b"not json").unwrap();
        let lib = EpisodeLibrary::open(Some(path));
        assert_eq!(lib.load_outcome(), LoadOutcome::Corrupt);
        assert!(lib.is_empty());
    }
}
