//! `download.rs` — the offline-download registry and its scheduling policy.
//!
//! The *policy* is pure and lives here (which episode starts next, how long a
//! failed attempt waits, whether it is retried at all); the *transport* is a
//! separate concern reached through the [`crate::provider::FeedProvider`] seam
//! and driven by [`crate::PodcastManager::run_download`]. Keeping them apart is
//! what lets the scheduling rules be pinned by tests with no network and no
//! filesystem.
//!
//! The registry is bounded ([`MAX_DOWNLOAD_RECORDS`]) and evicts the
//! least-recently-updated record. A `Done` record whose row is evicted means the
//! file is forgotten (and can be re-fetched); the alternative — an unbounded
//! registry — is the defect this bound exists to prevent.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use crate::error::Result;
use crate::model::DownloadState;
use crate::persist::{load_json, save_json, LoadOutcome};

/// Hard cap on download records (finished, queued, and failed alike).
pub const MAX_DOWNLOAD_RECORDS: usize = 2000;

/// How many downloads may run at once. Two keeps the queue responsive on a
/// phone without saturating a metered link.
pub const MAX_CONCURRENT_DOWNLOADS: usize = 2;

/// How many times a failed download is retried before it is left `Failed` for
/// the user to retry by hand.
pub const MAX_DOWNLOAD_ATTEMPTS: u32 = 3;

/// One download's state plus the bookkeeping the scheduler needs.
///
/// `#[serde(default)]` — a record written before a bookkeeping field existed
/// must degrade to that field's default (a state of `Absent`, zero attempts)
/// rather than fold the whole download registry to empty over one missing key.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct DownloadRecord {
    pub state: DownloadState,
    /// Attempts made so far.
    pub attempts: u32,
    /// Last change, unix seconds — the LRU key.
    pub updated_at: i64,
}

impl Default for DownloadRecord {
    fn default() -> Self {
        DownloadRecord {
            state: DownloadState::Absent,
            attempts: 0,
            updated_at: 0,
        }
    }
}

pub struct DownloadRegistry {
    path: Option<PathBuf>,
    records: HashMap<String, DownloadRecord>,
    outcome: LoadOutcome,
}

impl DownloadRegistry {
    pub fn open(path: Option<PathBuf>) -> Self {
        match path {
            None => DownloadRegistry {
                path: None,
                records: HashMap::new(),
                outcome: LoadOutcome::Ephemeral,
            },
            Some(p) => {
                let (raw, outcome): (HashMap<String, DownloadRecord>, _) = load_json(&p);
                let mut records = raw;
                // A record left `Downloading`/`Queued` by a process that died
                // mid-download is not "in flight" any more — nothing is moving
                // its bytes. Fold it to `Failed` so it is not shown as progress
                // that will never advance, and so the scheduler can pick it up.
                let mut healed = 0usize;
                for r in records.values_mut() {
                    if matches!(
                        r.state,
                        DownloadState::Downloading { .. } | DownloadState::Queued
                    ) {
                        r.state = DownloadState::Failed {
                            reason: "interrupted".to_string(),
                        };
                        healed += 1;
                    }
                }
                if healed > 0 {
                    tracing::warn!(healed, "recovered interrupted podcast downloads");
                }
                if records.len() > MAX_DOWNLOAD_RECORDS {
                    evict_to_cap(&mut records);
                }
                DownloadRegistry {
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

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn get(&self, uid: &str) -> Option<&DownloadRecord> {
        self.records.get(uid)
    }

    pub fn state(&self, uid: &str) -> DownloadState {
        self.records
            .get(uid)
            .map(|r| r.state.clone())
            .unwrap_or(DownloadState::Absent)
    }

    /// Whether the episode is fully downloaded.
    pub fn is_done(&self, uid: &str) -> bool {
        matches!(self.state(uid), DownloadState::Done { .. })
    }

    /// Number of in-flight downloads (used to gate the scheduler).
    pub fn active_count(&self) -> usize {
        self.records
            .values()
            .filter(|r| matches!(r.state, DownloadState::Downloading { .. }))
            .count()
    }

    /// Enqueue `uid`. Refuses (returns `false`) when it is already done or in
    /// flight — re-enqueuing a finished download would re-fetch bytes we have.
    pub fn enqueue(&mut self, uid: &str, now: i64) -> Result<bool> {
        let previous = self.state(uid);
        match previous {
            DownloadState::Done { .. }
            | DownloadState::Downloading { .. }
            | DownloadState::Queued => {
                return Ok(false);
            }
            _ => {}
        }
        let mut rec = self.records.remove(uid).unwrap_or_default();
        rec.state = DownloadState::Queued;
        // Only a *fresh* download starts its count at zero. Re-queueing a
        // `Failed` one is the retry that `MAX_DOWNLOAD_ATTEMPTS` bounds, and
        // `should_retry`/`retry_delay` read this counter — resetting it here
        // would pin it at 1 forever and make the ceiling a dead branch
        // (REQ-A1879 / F-SH-918).
        if !matches!(previous, DownloadState::Failed { .. }) {
            rec.attempts = 0;
        }
        rec.updated_at = now;
        self.insert(uid.to_string(), rec)?;
        Ok(true)
    }

    /// Mark a download as started.
    pub fn start(&mut self, uid: &str, now: i64) -> Result<()> {
        let mut rec = self.records.remove(uid).unwrap_or_default();
        rec.state = DownloadState::Downloading {
            received: 0,
            total: None,
        };
        rec.attempts = rec.attempts.saturating_add(1);
        rec.updated_at = now;
        self.insert(uid.to_string(), rec)
    }

    /// Record progress.
    pub fn progress(
        &mut self,
        uid: &str,
        received: u64,
        total: Option<u64>,
        now: i64,
    ) -> Result<()> {
        // A tick for a download this registry never started has nothing to move:
        // minting a record here would create an `Absent` row out of a stray
        // callback, and `Absent` is a state the screen draws.
        let Some(mut rec) = self.records.remove(uid) else {
            return Ok(());
        };
        // A progress tick for a download that already finished/failed must not
        // resurrect it into `Downloading` (out-of-order callbacks happen) — and
        // must not rewrite the file for a state it did not change.
        if matches!(rec.state, DownloadState::Downloading { .. }) {
            rec.state = DownloadState::Downloading { received, total };
            rec.updated_at = now;
            self.insert(uid.to_string(), rec)
        } else {
            self.records.insert(uid.to_string(), rec);
            Ok(())
        }
    }

    /// Mark a download complete.
    pub fn finish(&mut self, uid: &str, path: String, bytes: u64, now: i64) -> Result<()> {
        let mut rec = self.records.remove(uid).unwrap_or_default();
        rec.state = DownloadState::Done { path, bytes };
        rec.updated_at = now;
        self.insert(uid.to_string(), rec)
    }

    /// Mark a download failed with a bounded reason.
    pub fn fail(&mut self, uid: &str, reason: String, now: i64) -> Result<()> {
        let mut rec = self.records.remove(uid).unwrap_or_default();
        rec.state = DownloadState::Failed {
            reason: crate::error::bounded_detail(&reason),
        };
        rec.updated_at = now;
        self.insert(uid.to_string(), rec)
    }

    /// Remove a download record (e.g. the user deletes a downloaded episode).
    /// The caller is responsible for deleting the file the `Done` state named.
    pub fn remove(&mut self, uid: &str) -> Result<bool> {
        let removed = self.records.remove(uid).is_some();
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    fn insert(&mut self, uid: String, rec: DownloadRecord) -> Result<()> {
        self.records.insert(uid, rec);
        if self.records.len() > MAX_DOWNLOAD_RECORDS {
            evict_to_cap(&mut self.records);
        }
        self.save()
    }

    fn save(&self) -> Result<()> {
        match &self.path {
            Some(p) => save_json(p, &self.records),
            None => Ok(()),
        }
    }
}

fn evict_to_cap(records: &mut HashMap<String, DownloadRecord>) {
    while records.len() > MAX_DOWNLOAD_RECORDS {
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

/// Pure scheduling policy: which queued `uid` should start next, given how many
/// downloads are already in flight.
///
/// Returns `None` when the concurrency budget is full or nothing is queued.
/// Ties on `updated_at` are broken by `uid` so the choice is deterministic (a
/// test, and a user, see the same order twice).
pub fn next_to_start<'a, I>(records: I, active: usize) -> Option<String>
where
    I: IntoIterator<Item = (&'a String, &'a DownloadRecord)>,
{
    if active >= MAX_CONCURRENT_DOWNLOADS {
        return None;
    }
    let mut queued: Vec<(&String, &DownloadRecord)> = records
        .into_iter()
        .filter(|(_, r)| r.state == DownloadState::Queued)
        .collect();
    queued.sort_by(|a, b| {
        a.1.updated_at
            .cmp(&b.1.updated_at)
            .then_with(|| a.0.cmp(b.0))
    });
    queued.first().map(|(k, _)| (*k).clone())
}

/// Whether a failure at `attempts` (already made) should be retried.
pub fn should_retry(attempts: u32) -> bool {
    attempts < MAX_DOWNLOAD_ATTEMPTS
}

/// Backoff before retry `attempts` (1-based): 2s, 4s, 8s, capped at
/// [`MAX_BACKOFF`]. A non-positive/first attempt gets the base delay.
pub const BASE_BACKOFF: Duration = Duration::from_secs(2);
/// Ceiling on the retry backoff.
pub const MAX_BACKOFF: Duration = Duration::from_secs(60);

pub fn retry_delay(attempts: u32) -> Duration {
    let exp = attempts.clamp(1, 16);
    let secs = BASE_BACKOFF
        .as_secs()
        .saturating_mul(1u64 << (exp - 1).min(5));
    Duration::from_secs(secs.min(MAX_BACKOFF.as_secs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(state: DownloadState, attempts: u32, updated_at: i64) -> DownloadRecord {
        DownloadRecord {
            state,
            attempts,
            updated_at,
        }
    }

    #[test]
    fn enqueue_refuses_what_is_already_in_hand() {
        let mut r = DownloadRegistry::open(None);
        assert!(r.enqueue("a", 1).unwrap());
        assert!(!r.enqueue("a", 2).unwrap()); // already queued
        r.start("a", 3).unwrap();
        assert!(!r.enqueue("a", 4).unwrap()); // in flight
        r.finish("a", "/p".into(), 10, 5).unwrap();
        assert!(!r.enqueue("a", 6).unwrap()); // done
        assert!(r.is_done("a"));
    }

    #[test]
    fn a_failed_download_can_be_requeued() {
        let mut r = DownloadRegistry::open(None);
        r.fail("a", "boom".into(), 1).unwrap();
        assert!(r.enqueue("a", 2).unwrap());
        assert_eq!(r.state("a"), DownloadState::Queued);
    }

    /// Attempts must accumulate across re-queues. `MAX_DOWNLOAD_ATTEMPTS` bounds
    /// how many times a failure is retried, and the scheduler reads the counter
    /// through `should_retry`/`retry_delay` — so resetting it on every `enqueue`
    /// pins it at 1 forever and the ceiling is structurally unreachable.
    #[test]
    fn requeuing_a_failed_download_accumulates_attempts_up_to_the_ceiling() {
        let mut r = DownloadRegistry::open(None);
        // Positive control: a *fresh* download is the case that starts at zero.
        r.enqueue("a", 1).unwrap();
        assert_eq!(r.get("a").unwrap().attempts, 0);
        r.start("a", 2).unwrap();
        assert_eq!(r.get("a").unwrap().attempts, 1);

        let mut seen = vec![r.get("a").unwrap().attempts];
        while should_retry(r.get("a").unwrap().attempts) {
            r.fail("a", "boom".into(), 3).unwrap();
            assert!(r.enqueue("a", 4).unwrap(), "a failed download re-queues");
            assert_eq!(
                r.get("a").unwrap().attempts,
                *seen.last().unwrap(),
                "a re-queue preserved the attempt count instead of resetting it"
            );
            r.start("a", 5).unwrap();
            seen.push(r.get("a").unwrap().attempts);
        }
        assert_eq!(seen, vec![1, 2, 3], "one attempt is counted per start");
        assert!(
            !should_retry(r.get("a").unwrap().attempts),
            "the ceiling is reachable, not a dead branch"
        );
    }

    #[test]
    fn progress_does_not_resurrect_a_finished_download() {
        let mut r = DownloadRegistry::open(None);
        r.start("a", 1).unwrap();
        r.finish("a", "/p".into(), 10, 2).unwrap();
        r.progress("a", 5, Some(10), 3).unwrap();
        assert!(r.is_done("a"));
    }

    /// A tick for a download this registry never started mints nothing: an
    /// `Absent` row is a state the screen draws, so a stray callback must not
    /// create one (and must not rewrite the file).
    #[test]
    fn progress_for_an_unknown_download_creates_no_record() {
        let mut r = DownloadRegistry::open(None);
        r.progress("ghost", 5, Some(10), 1).unwrap();
        assert_eq!(r.len(), 0);
        assert_eq!(r.state("ghost"), DownloadState::Absent);
        // Positive control: a tick for a *live* one still moves it.
        r.start("a", 1).unwrap();
        r.progress("a", 5, Some(10), 2).unwrap();
        assert_eq!(
            r.state("a"),
            DownloadState::Downloading {
                received: 5,
                total: Some(10)
            }
        );
    }

    #[test]
    fn active_count_tracks_downloading_only() {
        let mut r = DownloadRegistry::open(None);
        r.enqueue("a", 1).unwrap();
        r.enqueue("b", 1).unwrap();
        assert_eq!(r.active_count(), 0);
        r.start("a", 2).unwrap();
        assert_eq!(r.active_count(), 1);
    }

    #[test]
    fn next_to_start_respects_concurrency_and_order() {
        let mut m: HashMap<String, DownloadRecord> = HashMap::new();
        m.insert("b".into(), rec(DownloadState::Queued, 0, 200));
        m.insert("a".into(), rec(DownloadState::Queued, 0, 100));
        m.insert(
            "d".into(),
            rec(
                DownloadState::Done {
                    path: "p".into(),
                    bytes: 1,
                },
                0,
                50,
            ),
        );
        assert_eq!(next_to_start(&m, 0), Some("a".into())); // oldest first
        assert_eq!(next_to_start(&m, MAX_CONCURRENT_DOWNLOADS), None);
    }

    #[test]
    fn next_to_start_is_deterministic_on_ties() {
        let mut m: HashMap<String, DownloadRecord> = HashMap::new();
        m.insert("z".into(), rec(DownloadState::Queued, 0, 5));
        m.insert("a".into(), rec(DownloadState::Queued, 0, 5));
        assert_eq!(next_to_start(&m, 0), Some("a".into()));
    }

    #[test]
    fn retry_policy_has_a_ceiling() {
        assert!(should_retry(0));
        assert!(should_retry(MAX_DOWNLOAD_ATTEMPTS - 1));
        assert!(!should_retry(MAX_DOWNLOAD_ATTEMPTS));
        assert_eq!(retry_delay(1), Duration::from_secs(2));
        assert_eq!(retry_delay(2), Duration::from_secs(4));
        assert_eq!(retry_delay(100), MAX_BACKOFF);
    }

    #[test]
    fn an_interrupted_download_is_healed_to_failed_on_load() {
        let d = std::env::temp_dir().join(format!("amos-podcast-dl-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let path = d.join(format!(
            "dl-{}.json",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(
            &path,
            br#"{"x":{"state":{"state":"downloading","received":5,"total":10},"attempts":1,"updated_at":1}}"#,
        )
        .unwrap();
        let r = DownloadRegistry::open(Some(path));
        assert!(matches!(r.state("x"), DownloadState::Failed { .. }));
    }
}
