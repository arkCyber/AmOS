//! `progress.rs` — per-episode playhead, speed and finished state.
//!
//! Records are keyed by [`episode_uid`] (`feed_id::episode_id`) because an
//! episode id is only unique *within* its feed: two subscriptions whose feeds
//! both name an episode `1` must not share one playhead — the bug where
//! finishing one podcast marks a different show's episode as played.
//!
//! The store is bounded ([`MAX_PROGRESS_RECORDS`]) and evicts the
//! least-recently-updated record. Eviction here trades "resume position for an
//! episode you have not touched in a very long time" for a bounded file; that is
//! an acceptable cache loss. What is **not** acceptable is the reverse: a store
//! that grows without bound because nothing evicts.
//!
//! Eviction is the **only** acceptable loss. A record here is the user's own
//! playhead (`position_secs` ∕ `played` ∕ `speed`), which — unlike the feed cache
//! ([`crate::library::EpisodeLibrary`]) or the download registry
//! ([`crate::download::DownloadRegistry`]) — no refresh or re-fetch can rebuild.
//! So a file that was present but could **not be read** must not be answered by
//! writing the empty store we substituted over its bytes:
//! [`ProgressStore::save`] refuses ([`PodcastError::StoreReadFailed`]), the same
//! rule [`SubscriptionStore`](crate::store::SubscriptionStore) states for the
//! subscription list (REQ-A1813 / F-SH-899, extended here under REQ-A1827 /
//! F-SH-906).

use std::collections::HashMap;
use std::path::PathBuf;

use crate::error::{PodcastError, Result};
use crate::model::{normalize_progress, EpisodeProgress, MAX_SPEED, MIN_SPEED};
use crate::persist::{load_json, save_json, LoadOutcome};

/// Hard cap on stored progress records.
pub const MAX_PROGRESS_RECORDS: usize = 5000;

pub struct ProgressStore {
    path: Option<PathBuf>,
    records: HashMap<String, EpisodeProgress>,
    outcome: LoadOutcome,
}

impl ProgressStore {
    pub fn open(path: Option<PathBuf>) -> Self {
        match path {
            None => ProgressStore {
                path: None,
                records: HashMap::new(),
                outcome: LoadOutcome::Ephemeral,
            },
            Some(p) => {
                let (raw, outcome): (HashMap<String, EpisodeProgress>, _) = load_json(&p);
                let mut records: HashMap<String, EpisodeProgress> = raw
                    .into_iter()
                    .map(|(k, v)| (k, normalize_progress(&v)))
                    .collect();
                if records.len() > MAX_PROGRESS_RECORDS {
                    evict_to_cap(&mut records);
                }
                ProgressStore {
                    path: Some(p),
                    records,
                    outcome,
                }
            }
        }
    }

    pub fn load_outcome(&self) -> LoadOutcome {
        self.outcome
    }

    pub fn get(&self, uid: &str) -> Option<&EpisodeProgress> {
        self.records.get(uid)
    }

    /// The stored playhead for `uid`, or `None` when nothing is recorded — an
    /// **absent** resume position, distinct from `0.0` (a recorded "start of
    /// episode"). The UI shows these differently; folding them would make a
    /// never-played episode look like one started and abandoned at 0.
    pub fn position(&self, uid: &str) -> Option<f64> {
        self.records.get(uid).map(|p| p.position_secs)
    }

    pub fn is_played(&self, uid: &str) -> bool {
        self.records.get(uid).map(|p| p.played).unwrap_or(false)
    }

    pub fn speed_for(&self, uid: &str) -> Option<f64> {
        self.records.get(uid).map(|p| p.speed)
    }

    /// Record a playhead update. `observed_duration` is the duration the
    /// *player* measured (`None` when it has not measured one yet); it is kept
    /// separately from the feed's stated duration.
    pub fn set_position(
        &mut self,
        uid: &str,
        position_secs: f64,
        observed_duration: Option<f64>,
        now: i64,
    ) -> Result<()> {
        let mut p = self.records.remove(uid).unwrap_or_default();
        p.position_secs = position_secs;
        if observed_duration.is_some() {
            p.observed_duration_secs = observed_duration;
        }
        p.updated_at = now;
        self.insert(uid.to_string(), normalize_progress(&p))
    }

    /// Set the playback speed for one episode (clamped to the supported range).
    pub fn set_speed(&mut self, uid: &str, speed: f64, now: i64) -> Result<()> {
        let mut p = self.records.remove(uid).unwrap_or_default();
        p.speed = speed;
        p.updated_at = now;
        self.insert(uid.to_string(), normalize_progress(&p))
    }

    /// Mark an episode finished (or un-finish it). Marking finished also parks
    /// the playhead at the observed duration when one is known, so a later
    /// "resume" starts from the end rather than mid-episode.
    pub fn set_played(&mut self, uid: &str, played: bool, now: i64) -> Result<()> {
        let mut p = self.records.remove(uid).unwrap_or_default();
        p.played = played;
        if played {
            if let Some(d) = p.observed_duration_secs {
                p.position_secs = d;
            }
        }
        p.updated_at = now;
        self.insert(uid.to_string(), normalize_progress(&p))
    }

    /// Forget one record (e.g. an episode removed from a feed).
    pub fn clear(&mut self, uid: &str) -> Result<bool> {
        self.refuse_if_unreadable()?;
        let removed = self.records.remove(uid).is_some();
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    /// Drop every record belonging to `feed_id` (used on unsubscribe).
    pub fn clear_feed(&mut self, feed_id: &str) -> Result<usize> {
        self.refuse_if_unreadable()?;
        let prefix = format!("{feed_id}::");
        let before = self.records.len();
        self.records.retain(|k, _| !k.starts_with(&prefix));
        let removed = before - self.records.len();
        if removed > 0 {
            self.save()?;
        }
        Ok(removed)
    }

    fn insert(&mut self, uid: String, p: EpisodeProgress) -> Result<()> {
        // Checked *before* the map insert (the analogue of `SubscriptionStore::add`'s
        // check before its push): a refused write must not leave a record in memory
        // that the file does not hold, or the next successful write would smuggle
        // the substituted record out over the user's unread bytes.
        self.refuse_if_unreadable()?;
        self.records.insert(uid, p);
        if self.records.len() > MAX_PROGRESS_RECORDS {
            evict_to_cap(&mut self.records);
        }
        self.save()
    }

    /// Refuse to persist while the file this store loaded could **not be read**.
    ///
    /// A playhead is the user's own data (see the module docs), so — exactly as
    /// [`SubscriptionStore`](crate::store::SubscriptionStore) does for the
    /// subscription list — the store may not answer "I could not
    /// read your file" by writing the empty map it substituted over the top of
    /// it. [`LoadOutcome::Corrupt`] is different: the bytes were read and are
    /// already unparseable, so replacing them loses nothing.
    fn refuse_if_unreadable(&self) -> Result<()> {
        if self.outcome == LoadOutcome::Unreadable {
            return Err(PodcastError::StoreReadFailed(format!(
                "{} could not be read; refusing to overwrite it with a progress list that was never loaded",
                self.path
                    .as_deref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default()
            )));
        }
        Ok(())
    }

    fn save(&self) -> Result<()> {
        self.refuse_if_unreadable()?;
        match &self.path {
            Some(p) => save_json(p, &self.records),
            None => Ok(()),
        }
    }
}

fn evict_to_cap(records: &mut HashMap<String, EpisodeProgress>) {
    while records.len() > MAX_PROGRESS_RECORDS {
        let victim = records
            .iter()
            .min_by_key(|(_, v)| v.updated_at)
            .map(|(k, _)| k.clone());
        match victim {
            Some(k) => {
                records.remove(&k);
            }
            None => break,
        }
    }
}

/// Clamp a speed value into the supported range (a helper for callers that
/// accept a raw number from a UI control before handing it to
/// [`ProgressStore::set_speed`]).
pub fn clamp_speed(speed: f64) -> f64 {
    if speed.is_finite() {
        speed.clamp(MIN_SPEED, MAX_SPEED)
    } else {
        1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_position_records_and_reports_absence_separately() {
        let mut s = ProgressStore::open(None);
        assert_eq!(s.position("f::e"), None); // absent, not 0.0
        s.set_position("f::e", 42.0, Some(100.0), 1).unwrap();
        assert_eq!(s.position("f::e"), Some(42.0));
        assert!(!s.is_played("f::e"));
    }

    #[test]
    fn set_played_parks_the_playhead_at_the_observed_duration() {
        let mut s = ProgressStore::open(None);
        s.set_position("f::e", 10.0, Some(120.0), 1).unwrap();
        s.set_played("f::e", true, 2).unwrap();
        assert!(s.is_played("f::e"));
        assert_eq!(s.position("f::e"), Some(120.0));
        s.set_played("f::e", false, 3).unwrap();
        assert!(!s.is_played("f::e"));
    }

    #[test]
    fn speed_is_clamped() {
        let mut s = ProgressStore::open(None);
        s.set_speed("f::e", 99.0, 1).unwrap();
        assert_eq!(s.speed_for("f::e"), Some(MAX_SPEED));
        s.set_speed("f::e", f64::NAN, 2).unwrap();
        assert_eq!(s.speed_for("f::e"), Some(1.0));
    }

    #[test]
    fn observed_duration_is_not_erased_by_a_later_update_without_one() {
        let mut s = ProgressStore::open(None);
        s.set_position("f::e", 5.0, Some(300.0), 1).unwrap();
        s.set_position("f::e", 6.0, None, 2).unwrap();
        assert_eq!(s.get("f::e").unwrap().observed_duration_secs, Some(300.0));
    }

    #[test]
    fn clear_feed_removes_only_that_feeds_records() {
        let mut s = ProgressStore::open(None);
        s.set_position("f1::a", 1.0, None, 1).unwrap();
        s.set_position("f1::b", 2.0, None, 2).unwrap();
        s.set_position("f2::a", 3.0, None, 3).unwrap();
        assert_eq!(s.clear_feed("f1").unwrap(), 2);
        assert!(s.get("f1::a").is_none());
        assert!(s.get("f2::a").is_some());
    }

    #[test]
    fn persists_across_reopen() {
        let d = std::env::temp_dir().join(format!("amos-podcast-progress-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let path = d.join(format!(
            "p-{}.json",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        {
            let mut s = ProgressStore::open(Some(path.clone()));
            s.set_position("f::e", 12.0, Some(60.0), 7).unwrap();
        }
        let s = ProgressStore::open(Some(path));
        assert_eq!(s.load_outcome(), LoadOutcome::Loaded);
        assert_eq!(s.position("f::e"), Some(12.0));
    }

    /// A file that is **present but unreadable** must not be replaced by the
    /// empty store we substituted for it. A playhead (`position_secs` ∕ `played`
    /// ∕ `speed`) is the user's own data: unlike the feed cache
    /// ([`crate::library::EpisodeLibrary`]) and the download registry
    /// ([`crate::download::DownloadRegistry`]), no refresh or re-fetch can
    /// rebuild it. This is [`SubscriptionStore`](crate::store::SubscriptionStore)'s
    /// rule, and `save()` is this store's one chokepoint (every mutator funnels
    /// through it), so the guard belongs there and not in each caller.
    #[test]
    fn an_unreadable_progress_file_is_not_overwritten_by_the_store_that_failed_to_load_it() {
        use crate::error::PodcastError;
        let dir = std::env::temp_dir().join(format!(
            "amos-podcast-progress-unread-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!(
            "p-{}.json",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        // Not valid UTF-8, so `read_to_string` fails with `InvalidData` — never
        // `NotFound`: the file is there and its bytes are still on disk.
        let original = vec![0x80u8, 0xff, 0x00, 0xfe];
        std::fs::write(&path, &original).unwrap();
        let mut s = ProgressStore::open(Some(path.clone()));
        assert_eq!(s.load_outcome(), LoadOutcome::Unreadable);
        assert!(s.position("f::e").is_none());
        // The write is refused, by the variant that names a read failure…
        assert!(matches!(
            s.set_position("f::e", 12.0, Some(60.0), 7),
            Err(PodcastError::StoreReadFailed(_))
        ));
        // …and the refusal is total: nothing was recorded in memory behind it,
        // so a later successful write cannot smuggle the substituted row out.
        assert!(s.position("f::e").is_none());
        // …and the file is byte-for-byte what it was.
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    /// The control for the rule above: a file that *was* read and is malformed is
    /// a different event — the data it held is already gone, so replacing it is
    /// the correct recovery. This keeps the refusal about `Unreadable` rather than
    /// about every outcome that is not `Loaded`.
    #[test]
    fn a_malformed_progress_file_is_recoverable_by_rewriting_it() {
        let dir =
            std::env::temp_dir().join(format!("amos-podcast-progress-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!(
            "p-{}.json",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&path, b"{not json").unwrap();
        let mut s = ProgressStore::open(Some(path.clone()));
        assert_eq!(s.load_outcome(), LoadOutcome::Corrupt);
        s.set_position("f::e", 12.0, Some(60.0), 7).unwrap();
        assert_eq!(s.position("f::e"), Some(12.0));
        let reopened = ProgressStore::open(Some(path));
        assert_eq!(reopened.load_outcome(), LoadOutcome::Loaded);
        assert_eq!(reopened.position("f::e"), Some(12.0));
    }

    #[test]
    fn clamp_speed_handles_non_finite() {
        assert_eq!(clamp_speed(f64::INFINITY), 1.0);
        assert_eq!(clamp_speed(0.1), MIN_SPEED);
        assert_eq!(clamp_speed(2.0), 2.0);
    }
}
