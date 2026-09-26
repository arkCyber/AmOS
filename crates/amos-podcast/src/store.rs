//! `store.rs` — the subscription list, persisted as one JSON document.
//!
//! The store owns three invariants the rest of the crate relies on:
//!
//! * **identity** — a subscription is keyed by its normalized feed URL, so
//!   subscribing to the same feed twice is idempotent rather than a duplicate;
//! * **boundedness** — the list is capped at [`MAX_SUBSCRIPTIONS`], and an add
//!   past the cap is **refused** (`SubscriptionLimitReached`), never satisfied by
//!   silently dropping someone else's subscription (a subscription is user data,
//!   not a cache);
//! * **shape** — every row is run through [`normalize_subscription`] on both load
//!   and add, so a hand-edited or older file cannot put a row with no URL into
//!   the list where the UI would render a dead entry.
//! * **no lossy overwrite** — a file that was present but could not be *read*
//!   leaves the store empty, and an empty store must not be written back over
//!   the bytes nobody managed to read. That case is refused
//!   ([`PodcastError::StoreReadFailed`]) rather than "recovered" by replacing the
//!   user's subscriptions with the list we failed to load (REQ-A1813 / F-SH-899).
//!
//! The clock is **injected** (`now: i64`) rather than read here, so a test can
//! assert on `last_refreshed` without sleeping.

use std::path::{Path, PathBuf};

use crate::error::{PodcastError, Result};
use crate::model::{normalize_subscription, Subscription};
use crate::persist::{load_json, save_json, LoadOutcome};

/// Hard cap on subscriptions.
pub const MAX_SUBSCRIPTIONS: usize = 500;

/// What happened to the last load, so the UI can distinguish "no subscriptions
/// yet" from "your subscriptions could not be read".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreLoad {
    pub outcome: LoadOutcome,
    /// Rows dropped because they were unusable or past the cap.
    pub dropped: usize,
}

pub struct SubscriptionStore {
    path: Option<PathBuf>,
    subs: Vec<Subscription>,
    load: StoreLoad,
}

impl SubscriptionStore {
    /// Open the store at `path`; `None` keeps it in memory only.
    pub fn open(path: Option<PathBuf>) -> Self {
        match path {
            None => SubscriptionStore {
                path: None,
                subs: Vec::new(),
                load: StoreLoad {
                    outcome: LoadOutcome::Ephemeral,
                    dropped: 0,
                },
            },
            Some(p) => {
                let (raw, outcome): (Vec<Subscription>, _) = load_json(&p);
                let before = raw.len();
                let mut subs: Vec<Subscription> = raw
                    .iter()
                    .filter_map(normalize_subscription)
                    .take(MAX_SUBSCRIPTIONS)
                    .collect();
                // Dedup by feed_id, first wins.
                let mut seen = std::collections::HashSet::new();
                subs.retain(|s| seen.insert(s.feed_id.clone()));
                SubscriptionStore {
                    path: Some(p),
                    load: StoreLoad {
                        outcome,
                        dropped: before - subs.len(),
                    },
                    subs,
                }
            }
        }
    }

    pub fn load_outcome(&self) -> StoreLoad {
        self.load
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn list(&self) -> &[Subscription] {
        &self.subs
    }

    pub fn len(&self) -> usize {
        self.subs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.subs.is_empty()
    }

    pub fn get(&self, feed_id: &str) -> Option<&Subscription> {
        self.subs.iter().find(|s| s.feed_id == feed_id)
    }

    /// Add (or re-affirm) a subscription. Idempotent on `feed_id`: an existing
    /// row keeps its original `subscribed_at` and its feed-owned `title`, and
    /// takes the incoming `custom_title` only when the caller supplied one.
    /// `title` is established by [`SubscriptionStore::mark_refreshed`], never by
    /// an add.
    ///
    /// Refuses a new row past [`MAX_SUBSCRIPTIONS`], and refuses any write at all
    /// ([`PodcastError::StoreReadFailed`]) while the loaded file could not be
    /// read — see [`SubscriptionStore::refuse_if_unreadable`].
    pub fn add(&mut self, sub: Subscription) -> Result<()> {
        let sub = normalize_subscription(&sub).ok_or(PodcastError::UrlInvalid)?;
        if let Some(existing) = self.subs.iter_mut().find(|s| s.feed_id == sub.feed_id) {
            // The existing row's `title` is the feed's own name — learned by a
            // refresh, or the URL placeholder until the first fetch. An `add`
            // carries that URL placeholder (the caller does not know the feed's
            // name yet), so letting it through would erase a name a refresh had
            // learned; `mark_refreshed` is the only thing that establishes
            // `title`. The user's own `custom_title` *is* set here, and only when
            // given — re-adding with no name says nothing about the name.
            if sub.custom_title.is_some() {
                existing.custom_title = sub.custom_title;
            }
            if sub.category.is_some() {
                existing.category = sub.category;
            }
            return self.save();
        }
        if self.subs.len() >= MAX_SUBSCRIPTIONS {
            return Err(PodcastError::SubscriptionLimitReached);
        }
        // Checked *before* the push: a refused write must not leave a row in the
        // list that the file does not hold.
        self.refuse_if_unreadable()?;
        self.subs.push(sub);
        self.save()
    }

    /// Remove by id. Returns whether a row was removed.
    pub fn remove(&mut self, feed_id: &str) -> Result<bool> {
        let before = self.subs.len();
        self.subs.retain(|s| s.feed_id != feed_id);
        let removed = self.subs.len() != before;
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    /// Record a successful refresh: set `last_refreshed = Some(now)` and refresh
    /// the display title from the fetched feed.
    pub fn mark_refreshed(&mut self, feed_id: &str, title: &str, now: i64) -> Result<()> {
        let Some(sub) = self.subs.iter_mut().find(|s| s.feed_id == feed_id) else {
            return Err(PodcastError::UnknownFeed(feed_id.to_string()));
        };
        sub.last_refreshed = Some(now);
        if !title.trim().is_empty() {
            sub.title = title.trim().to_string();
        }
        self.save()
    }

    /// Refuse to persist while the file this store loaded could **not be read**.
    ///
    /// A subscription is the user's own data (it cannot be re-derived by a
    /// refresh — see the module docs), so the store may not answer "I could not
    /// read your file" by writing the empty list it substituted over the top of
    /// it. [`LoadOutcome::Corrupt`] is different: the bytes were read and are
    /// already unparseable, so replacing them loses nothing. The same rule guards
    /// the playhead store, whose rows are equally un-rebuildable:
    /// [`ProgressStore`](crate::progress::ProgressStore) (REQ-A1827). The two
    /// are the only producers of
    /// [`PodcastError::StoreReadFailed`], whose doc names exactly this case; the
    /// feed cache ([`crate::library::EpisodeLibrary`]) and the download registry
    /// ([`crate::download::DownloadRegistry`]) are deliberately left unguarded —
    /// their rows a refresh ∕ re-fetch rebuilds.
    fn refuse_if_unreadable(&self) -> Result<()> {
        if self.load.outcome == LoadOutcome::Unreadable {
            return Err(PodcastError::StoreReadFailed(format!(
                "{} could not be read; refusing to overwrite it with a list that was never loaded",
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
            Some(p) => save_json(p, &self.subs),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persist::LoadOutcome;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "amos-podcast-store-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d.join("subs.json")
    }

    fn sub(url: &str, title: &str) -> Subscription {
        Subscription {
            feed_id: url.to_string(),
            title: title.to_string(),
            custom_title: None,
            url: url.to_string(),
            subscribed_at: 100,
            last_refreshed: None,
            category: None,
        }
    }

    /// A re-affirm is idempotent on `feed_id`: still one row, original
    /// `subscribed_at`. It does **not** re-title from the incoming row — `title`
    /// is the feed's own name and `mark_refreshed` is the only thing that
    /// establishes it; an `add` carries only the user's `custom_title`.
    #[test]
    fn add_is_idempotent_on_feed_id_and_does_not_re_title() {
        let mut s = SubscriptionStore::open(Some(tmp()));
        s.add(sub("https://x/f", "First")).unwrap();
        s.add(sub("https://x/f", "Second")).unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(s.get("https://x/f").unwrap().title, "First");
        assert_eq!(s.get("https://x/f").unwrap().subscribed_at, 100);

        // The user's own name *is* carried by an `add`…
        let mut named = sub("https://x/f", "First");
        named.custom_title = Some("Mine".into());
        s.add(named).unwrap();
        assert_eq!(
            s.get("https://x/f").unwrap().custom_title.as_deref(),
            Some("Mine")
        );
        assert_eq!(s.get("https://x/f").unwrap().title, "First"); // feed's name untouched
                                                                  // …and an `add` with no name says nothing about the name.
        s.add(sub("https://x/f", "First")).unwrap();
        assert_eq!(
            s.get("https://x/f").unwrap().custom_title.as_deref(),
            Some("Mine")
        );
    }

    #[test]
    fn persists_across_reopen() {
        let path = tmp();
        {
            let mut s = SubscriptionStore::open(Some(path.clone()));
            s.add(sub("https://x/f", "T")).unwrap();
        }
        let s = SubscriptionStore::open(Some(path));
        assert_eq!(s.load_outcome().outcome, LoadOutcome::Loaded);
        assert_eq!(s.len(), 1);
        assert_eq!(s.list()[0].title, "T");
    }

    #[test]
    fn a_first_run_reports_absent_not_corrupt() {
        let s = SubscriptionStore::open(Some(tmp()));
        assert_eq!(s.load_outcome().outcome, LoadOutcome::Absent);
        assert!(s.is_empty());
    }

    #[test]
    fn mark_refreshed_sets_the_timestamp_and_title() {
        let mut s = SubscriptionStore::open(Some(tmp()));
        s.add(sub("https://x/f", "Old")).unwrap();
        s.mark_refreshed("https://x/f", "New", 12345).unwrap();
        let got = s.get("https://x/f").unwrap();
        assert_eq!(got.last_refreshed, Some(12345));
        assert_eq!(got.title, "New");
        // An unknown id is a named refusal, not a silent no-op.
        assert_eq!(
            s.mark_refreshed("https://nope/", "x", 1),
            Err(PodcastError::UnknownFeed("https://nope/".into()))
        );
    }

    /// A row that predates a field (or lost one to a hand edit) must degrade to
    /// that field's default and be *judged* by `normalize_subscription` — not
    /// fail the whole file's deserialization, which would fold the entire
    /// subscription list (the user's own data, the one store that cannot be
    /// re-derived) to empty over one missing key.
    #[test]
    fn a_row_missing_a_field_does_not_take_down_the_whole_store() {
        let path = tmp();
        std::fs::write(
            &path,
            br#"[{"feed_id":"https://x/a","url":"https://x/a","subscribed_at":1},
                 {"feed_id":"https://x/b","url":"","subscribed_at":2}]"#,
        )
        .unwrap();
        let s = SubscriptionStore::open(Some(path));
        assert_eq!(s.load_outcome().outcome, LoadOutcome::Loaded); // not Corrupt
        assert_eq!(s.len(), 1);
        assert_eq!(s.get("https://x/a").unwrap().title, "https://x/a"); // url fallback
        assert_eq!(s.load_outcome().dropped, 1); // the row with no url was judged out
    }

    /// An unreadable-but-present file must not be replaced by the list we failed
    /// to read. A subscription is the user's own data, and `write_atomic` only
    /// makes a write *atomic* — it cannot make bytes we never managed to read
    /// safe to discard. (The playhead store carries the same rule; see
    /// `progress.rs`'s `an_unreadable_progress_file_is_not_overwritten_…`.)
    #[test]
    fn an_unreadable_store_refuses_to_overwrite_the_file_it_could_not_read() {
        let path = tmp();
        let original = vec![0x80u8, 0xff, 0x00];
        std::fs::write(&path, &original).unwrap();
        let mut s = SubscriptionStore::open(Some(path.clone()));
        assert_eq!(s.load_outcome().outcome, LoadOutcome::Unreadable);
        assert!(s.is_empty());
        // The write is refused, by the variant that names a read failure…
        assert!(matches!(
            s.add(sub("https://x/f", "T")),
            Err(PodcastError::StoreReadFailed(_))
        ));
        // …and nothing was added to the in-memory list behind the refusal.
        assert!(s.is_empty());
        // …and the file is byte-for-byte what it was.
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    /// The control for the rule above: a file that *was* read and is malformed
    /// is a different event — the data it held is already gone, so replacing it
    /// is the correct recovery. This is what keeps the refusal about
    /// `Unreadable` rather than about every outcome that is not `Loaded`.
    #[test]
    fn a_malformed_store_is_recoverable_by_rewriting_it() {
        let path = tmp();
        std::fs::write(&path, b"{not json").unwrap();
        let mut s = SubscriptionStore::open(Some(path.clone()));
        assert_eq!(s.load_outcome().outcome, LoadOutcome::Corrupt);
        s.add(sub("https://x/f", "T")).unwrap();
        let reopened = SubscriptionStore::open(Some(path));
        assert_eq!(reopened.load_outcome().outcome, LoadOutcome::Loaded);
        assert_eq!(reopened.len(), 1);
    }

    #[test]
    fn remove_reports_whether_a_row_left() {
        let mut s = SubscriptionStore::open(Some(tmp()));
        s.add(sub("https://x/f", "T")).unwrap();
        assert!(s.remove("https://x/f").unwrap());
        assert!(!s.remove("https://x/f").unwrap());
    }

    #[test]
    fn dropping_an_unusable_row_is_reported() {
        let path = tmp();
        // A row with no URL (hand-edited file) must not reach the list.
        std::fs::write(
            &path,
            br#"[{"feed_id":"a","title":"t","url":"","subscribed_at":0}]"#,
        )
        .unwrap();
        let s = SubscriptionStore::open(Some(path));
        assert!(s.is_empty());
        assert_eq!(s.load_outcome().dropped, 1);
    }

    #[test]
    fn the_cap_refuses_rather_than_evicts() {
        let mut s = SubscriptionStore::open(None);
        for i in 0..MAX_SUBSCRIPTIONS {
            s.add(sub(&format!("https://x/{i}"), "t")).unwrap();
        }
        assert_eq!(s.len(), MAX_SUBSCRIPTIONS);
        assert_eq!(
            s.add(sub("https://x/one-more", "t")),
            Err(PodcastError::SubscriptionLimitReached)
        );
        // The existing rows are untouched.
        assert_eq!(s.len(), MAX_SUBSCRIPTIONS);
        assert!(s.get("https://x/0").is_some());
    }

    #[test]
    fn an_ephemeral_store_still_works_in_memory() {
        let mut s = SubscriptionStore::open(None);
        assert_eq!(s.load_outcome().outcome, LoadOutcome::Ephemeral);
        s.add(sub("https://x/f", "T")).unwrap();
        assert_eq!(s.len(), 1);
    }
}
