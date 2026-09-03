//! [`SyncedClock`] — a calibrated wall clock.
//!
//! The host OS already keeps a wall clock, but it may drift or be wrong. A
//! [`SyncedClock`] keeps the *offset* between the host clock and an
//! authoritative network time, so `now()` reports the corrected wall time while
//! the underlying monotonic clock keeps advancing. On a fresh process it starts
//! with no offset (reporting the raw host clock); after a successful
//! [`sync`](SyncedClock::sync) it applies the measured offset and persists the
//! last-known-good value, so a later offline boot can start close to correct.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::error::{Error, Result};
use crate::time_source::TimeSource;

/// Default window of *plausible* absolute times (years 2000–2100, in epoch
/// seconds). Any remote time outside this is treated as garbage and rejected.
const DEFAULT_MIN_EPOCH_SECS: u64 = 946_684_800; // 2000-01-01T00:00:00Z
const DEFAULT_MAX_EPOCH_SECS: u64 = 4_102_444_800; // 2100-01-01T00:00:00Z

/// Largest host↔real offset we will accept (200 years). Real corrections are far
/// smaller (an unset RTC sits at ~1970); anything larger is treated as a
/// tampered/corrupt persisted value rather than a genuine calibration.
const MAX_OFFSET_NS: i64 = 6_307_200_000_000_000_000; // 200 * 365d, in ns

fn host_now() -> SystemTime {
    SystemTime::now()
}

/// Add a signed nanosecond offset to a base time.
fn apply_offset(base: SystemTime, offset_ns: i64) -> SystemTime {
    if offset_ns >= 0 {
        base + Duration::from_nanos(offset_ns as u64)
    } else {
        base - Duration::from_nanos(offset_ns.unsigned_abs())
    }
}

/// Clamp a non-negative nanosecond count so it fits an `i64` (never wraps).
fn saturating_ns(ns: u128) -> i64 {
    ns.min(i64::MAX as u128) as i64
}

/// Signed nanosecond offset of `remote` relative to `host`.
///
/// Saturates at the `i64` range so a pathological clock difference (e.g. a host
/// clock off by centuries) can never overflow or wrap into a bogus offset.
fn signed_offset_ns(remote: SystemTime, host: SystemTime) -> i64 {
    match remote.duration_since(host) {
        Ok(ahead) => saturating_ns(ahead.as_nanos()),
        Err(behind) => -saturating_ns(behind.duration().as_nanos()),
    }
}

/// Whether a (host↔real) offset magnitude is physically plausible for a real
/// device. Guards the *load* path against a tampered/corrupt persisted value
/// that would otherwise make `now()` report an absurd time.
fn offset_is_sane(offset_ns: i64) -> bool {
    offset_ns.unsigned_abs() as u128 <= MAX_OFFSET_NS as u128
}

/// Absolute epoch-second bounds a remote time must satisfy to be accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plausibility {
    /// Earliest acceptable Unix time in whole seconds (inclusive).
    pub min_epoch_secs: u64,
    /// Latest acceptable Unix time in whole seconds (exclusive).
    pub max_epoch_secs: u64,
}

impl Default for Plausibility {
    fn default() -> Self {
        Self {
            min_epoch_secs: DEFAULT_MIN_EPOCH_SECS,
            max_epoch_secs: DEFAULT_MAX_EPOCH_SECS,
        }
    }
}

/// On-disk shape of the last-known-good clock state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Persisted {
    /// Signed offset (nanoseconds) to add to the host clock to get real time.
    offset_ns: i64,
    /// Epoch milliseconds at which this offset was measured/synced.
    last_synced_ms: u64,
}

/// A monotonic anchor captured when a calibration was applied: `remote` is the
/// corrected wall time at instant `mono`, so `now()` advances by the *monotonic*
/// clock and is immune to host wall-clock steps (manual change / host NTP slew)
/// between syncs.
#[derive(Debug, Clone, Copy)]
struct Anchor {
    mono: Instant,
    remote: SystemTime,
}

/// A monotonic-anchored, optionally network-calibrated wall clock.
///
/// `SyncedClock` is **not** internally synchronized: it is cheap and shared, but
/// concurrent readers and the calibrating [`Timekeeper`](crate::Timekeeper) should
/// guard it behind a `Mutex`/`RwLock` (see [`timekeeper`](crate::timekeeper)).
#[derive(Debug, Clone)]
pub struct SyncedClock {
    /// Measured offset from the host clock to real time; `None` = not synced.
    offset_ns: Option<i64>,
    /// Monotonic anchor used to make `now()` advance monotonically.
    anchor: Option<Anchor>,
    /// When the current offset was last synced (wall clock), if ever.
    last_synced: Option<SystemTime>,
    /// Absolute-time sanity bounds for accepting a remote time.
    plausibility: Plausibility,
    /// Where the last-known-good offset is persisted (optional).
    state_file: Option<PathBuf>,
}

impl Default for SyncedClock {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncedClock {
    /// A fresh, unsynced clock that reports the raw host wall clock until synced.
    pub fn new() -> Self {
        Self {
            offset_ns: None,
            anchor: None,
            last_synced: None,
            plausibility: Plausibility::default(),
            state_file: None,
        }
    }

    /// Override the plausibility window (used to widen tests, rarely in prod).
    pub fn with_plausibility(mut self, bounds: Plausibility) -> Self {
        self.plausibility = bounds;
        self
    }

    /// Enable persistence of the last-known-good offset to `path`.
    pub fn with_state_file(mut self, path: PathBuf) -> Self {
        self.state_file = Some(path);
        self
    }

    /// Restore a clock from previously-persisted last-known-good state.
    ///
    /// If the file is absent or malformed this returns a fresh, *unsynced* clock
    /// (non-fatal), matching the repo's session-persistence philosophy.
    pub fn load(path: &Path) -> Self {
        let mut clock = Self::new().with_state_file(path.to_path_buf());
        match Self::read_persisted(path) {
            Ok(Some(p)) => {
                if offset_is_sane(p.offset_ns) {
                    clock.offset_ns = Some(p.offset_ns);
                    // Re-anchor at load: the corrected wall time is the persisted
                    // one advanced by the monotonic clock from this instant.
                    clock.anchor = Some(Anchor {
                        mono: Instant::now(),
                        remote: apply_offset(ms_to_system(p.last_synced_ms), p.offset_ns),
                    });
                    clock.last_synced = Some(ms_to_system(p.last_synced_ms));
                    info!(
                        "timesync: restored last-known-good offset {}ns (synced {}ms)",
                        p.offset_ns, p.last_synced_ms
                    );
                } else {
                    warn!(
                        "timesync: ignoring implausible persisted offset {}ns in {}",
                        p.offset_ns,
                        path.display()
                    );
                }
            }
            Ok(None) => info!("timesync: no prior clock state at {}", path.display()),
            Err(e) => warn!(
                "timesync: ignoring unreadable clock state {}: {e}",
                path.display()
            ),
        }
        clock
    }

    /// Whether a calibration offset is known (from this run or persisted state).
    pub fn synced(&self) -> bool {
        self.offset_ns.is_some()
    }

    /// The signed offset (nanoseconds) currently applied, if any.
    pub fn offset_ns(&self) -> Option<i64> {
        self.offset_ns
    }

    /// When the current offset was last synced, if ever.
    pub fn last_synced(&self) -> Option<SystemTime> {
        self.last_synced
    }

    /// The corrected wall clock.
    ///
    /// Once calibrated it advances by the **monotonic** clock from the anchor
    /// captured when the offset was measured, so a host wall-clock change between
    /// syncs does not jump the corrected time. Before the first sync it reports
    /// the raw host wall clock.
    pub fn now(&self) -> SystemTime {
        match self.anchor {
            Some(anchor) => anchor.remote + anchor.mono.elapsed(),
            None => host_now(),
        }
    }

    /// How long ago the current offset was last confirmed against a source.
    ///
    /// Returns `None` when the clock has never been synced. Consumers can use
    /// this to decide whether the calibration is still trustworthy (e.g. refusing
    /// to act on a stale time).
    pub fn staleness(&self) -> Option<Duration> {
        let last = self.last_synced?;
        Some(host_now().duration_since(last).unwrap_or(Duration::ZERO))
    }

    /// Whether the clock is calibrated *and* the calibration is no older than
    /// `max_age` — a convenient guard for time-sensitive decisions.
    pub fn is_fresh(&self, max_age: Duration) -> bool {
        self.staleness().is_some_and(|age| age <= max_age)
    }

    /// Apply an authoritative remote time: sanity-check it, measure the signed
    /// offset from the host clock, and store it.
    ///
    /// This is the *non-network* half of a sync — callers that already hold a
    /// remote time (e.g. fetched outside a lock) apply it here. Persistence of
    /// the new last-known-good value is best-effort: a write failure is logged
    /// but does not fail the sync (the in-memory clock is already corrected).
    ///
    /// Returns the accepted remote time on success. On failure (implausible
    /// remote) the existing calibration is left untouched.
    pub fn apply(&mut self, remote: SystemTime) -> Result<SystemTime> {
        self.validate(&remote)?;

        let host = host_now();
        let offset_ns = signed_offset_ns(remote, host);
        self.offset_ns = Some(offset_ns);
        // Anchor now(): from this instant it advances by the monotonic clock, so
        // a host wall-clock change mid-run cannot jump the corrected time.
        self.anchor = Some(Anchor {
            mono: Instant::now(),
            remote,
        });
        self.last_synced = Some(host);
        info!(
            "timesync: applied offset {offset_ns}ns (host was {}ms from remote)",
            offset_ns.abs() / 1_000_000
        );

        if let Err(e) = self.persist() {
            warn!("timesync: could not persist clock state: {e}");
        }
        Ok(remote)
    }

    /// Fetch a remote time and apply it in one call (convenience wrapper).
    ///
    /// Prefer fetching via the [`TimeSource`] yourself when you must not hold a
    /// lock across the network wait, then apply the result with
    /// [`SyncedClock::apply`].
    pub async fn sync(&mut self, source: &dyn TimeSource) -> Result<SystemTime> {
        let remote = source.fetch_time().await?;
        self.apply(remote)
    }

    /// Persist the current last-known-good state to the configured file (atomic).
    pub fn save(&self) -> Result<()> {
        self.persist()
    }

    fn validate(&self, remote: &SystemTime) -> Result<()> {
        match remote.duration_since(UNIX_EPOCH) {
            Ok(d) => {
                let secs = d.as_secs();
                if secs >= self.plausibility.min_epoch_secs
                    && secs < self.plausibility.max_epoch_secs
                {
                    Ok(())
                } else {
                    Err(Error::Implausible(secs))
                }
            }
            Err(_) => Err(Error::Implausible(0)),
        }
    }

    fn persist(&self) -> Result<()> {
        let path = match &self.state_file {
            Some(p) => p,
            None => return Ok(()),
        };
        let offset_ns = self
            .offset_ns
            .ok_or_else(|| Error::Io("cannot persist an unsynced clock".into()))?;
        let persisted = Persisted {
            offset_ns,
            last_synced_ms: self
                .last_synced
                .map(system_to_ms)
                .unwrap_or_else(host_now_ms),
        };
        let json = serde_json::to_string_pretty(&persisted)
            .map_err(|e| Error::Io(format!("serialize: {e}")))?;
        atomic_write(path, json.as_bytes())
    }

    fn read_persisted(path: &Path) -> Result<Option<Persisted>> {
        let json = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Error::Io(format!("read {}: {e}", path.display()))),
        };
        serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| Error::Io(format!("parse {}: {e}", path.display())))
    }
}

fn system_to_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn ms_to_system(ms: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(ms)
}

fn host_now_ms() -> u64 {
    system_to_ms(host_now())
}

/// Write `bytes` to `path` atomically (temp file + rename), mirroring the
/// repo's session persistence.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Error::Io(format!("create_dir_all {}: {e}", parent.display())))?;
        }
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| Error::Io(format!("write {}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| Error::Io(format!("rename to {}: {e}", path.display())))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time_source::MockTimeSource;

    /// Host now, captured around a call, never diverges by more than 2s (bounds
    /// skew from slow CI runners, not from clock logic).
    fn near(a: SystemTime, b: SystemTime) -> bool {
        let d = a.duration_since(b).unwrap_or_else(|e| e.duration());
        d <= Duration::from_secs(2)
    }

    #[test]
    fn fresh_clock_reports_unsynced_host_time() {
        let clock = SyncedClock::new();
        assert!(!clock.synced());
        assert!(clock.offset_ns().is_none());
        assert!(clock.last_synced().is_none());
        assert!(
            near(clock.now(), SystemTime::now()),
            "unsynced now == host now"
        );
    }

    #[test]
    fn load_missing_file_yields_unsynced_clock() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("amos-ts-missing-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let clock = SyncedClock::load(&path);
        assert!(!clock.synced());
        assert!(near(clock.now(), SystemTime::now()));
    }

    #[tokio::test]
    async fn sync_ahead_applies_positive_offset_and_persists() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("amos-ts-ahead-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let remote = SystemTime::now() + Duration::from_secs(5_000);
        let source = MockTimeSource::fixed(remote);

        let mut clock = SyncedClock::new()
            .with_plausibility(wide())
            .with_state_file(path.clone());
        let got = clock.sync(&source).await.expect("sync ok");
        assert_eq!(got, remote);

        assert!(clock.synced());
        let off = clock.offset_ns().expect("offset present");
        assert!(
            off > 0,
            "remote is ahead of host, so offset should be positive"
        );
        assert!(clock.last_synced().is_some());

        // Corrected now should be ~5s ahead of host now.
        let host_after = SystemTime::now();
        let lead = clock
            .now()
            .duration_since(host_after)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        assert!(
            (4998..=5002).contains(&lead),
            "now should be ~5s ahead, got {lead}s"
        );

        // Persisted → a fresh load() restores the same offset.
        let restored = SyncedClock::load(&path);
        assert!(restored.synced());
        assert_eq!(restored.offset_ns(), clock.offset_ns());
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("tmp"));
    }

    #[tokio::test]
    async fn sync_behind_applies_negative_offset() {
        let remote = SystemTime::now() - Duration::from_secs(3_000);
        let source = MockTimeSource::fixed(remote);
        let mut clock = SyncedClock::new().with_plausibility(wide());
        clock.sync(&source).await.expect("sync ok");
        assert!(clock.offset_ns().is_some_and(|o| o < 0));
        assert!(clock.now() < SystemTime::now());
    }

    #[tokio::test]
    async fn implausible_remote_time_is_rejected_and_not_applied() {
        // Year 1980 (epoch 315532800) is inside SystemTime's representable range
        // but below the default plausibility window floor (2000).
        let ancient = SystemTime::UNIX_EPOCH + Duration::from_secs(315_532_800);
        let source = MockTimeSource::fixed(ancient);
        let mut clock = SyncedClock::new(); // default bounds (2000..2100)
        assert!(matches!(
            clock.sync(&source).await,
            Err(Error::Implausible(_))
        ));
        assert!(
            !clock.synced(),
            "a rejected time must not mark the clock synced"
        );
    }

    #[tokio::test]
    async fn source_failure_propagates_and_leaves_clock_unsynced() {
        let source = MockTimeSource::failing(Error::Source("network down".into()));
        let mut clock = SyncedClock::new();
        assert!(clock.sync(&source).await.is_err());
        assert!(!clock.synced());
    }

    #[test]
    fn corrupt_state_file_degrades_gracefully_to_unsynced() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("amos-ts-corrupt-{}.json", std::process::id()));
        std::fs::write(&path, "not json").unwrap();
        let clock = SyncedClock::load(&path);
        assert!(
            !clock.synced(),
            "corrupt file must not panic, just go unsynced"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn absurd_but_valid_offset_in_state_is_ignored_on_load() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("amos-ts-absurd-{}.json", std::process::id()));
        // Valid JSON, but with an offset far beyond a plausible real correction.
        let bad = format!(
            "{{\"offset_ns\":{},\"last_synced_ms\":1700000000000}}",
            i64::MAX
        );
        std::fs::write(&path, bad).unwrap();
        let clock = SyncedClock::load(&path);
        assert!(
            !clock.synced(),
            "an absurd persisted offset must be ignored (treated as unsynced)"
        );
        assert!(clock.offset_ns().is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn failed_sync_keeps_prior_calibration() {
        let mut clock = SyncedClock::new().with_plausibility(wide());
        clock
            .apply(SystemTime::now() + Duration::from_secs(1_000))
            .expect("apply ok");
        let before = clock.offset_ns();

        // A failing source must not clobber the already-applied offset.
        let failing = MockTimeSource::failing(Error::Source("network down".into()));
        assert!(clock.sync(&failing).await.is_err());
        assert_eq!(
            clock.offset_ns(),
            before,
            "failed sync must leave prior calibration intact"
        );
    }

    #[tokio::test]
    async fn staleness_is_none_until_synced_then_small() {
        let mut clock = SyncedClock::new();
        assert_eq!(clock.staleness(), None, "unsynced clock has no staleness");
        assert!(!clock.is_fresh(Duration::from_secs(1)));

        // Now-ish remote passes the default plausibility window (year 2026).
        clock.apply(SystemTime::now()).expect("apply ok");
        let age = clock.staleness().expect("synced clock has staleness");
        assert!(
            age < Duration::from_secs(2),
            "just-synced staleness is tiny"
        );
        assert!(clock.is_fresh(Duration::from_secs(5)));
    }

    #[test]
    fn apply_rejects_implausible_without_marking_synced() {
        // Year 1980 is below the default (2000) plausibility floor.
        let ancient = SystemTime::UNIX_EPOCH + Duration::from_secs(315_532_800);
        let mut clock = SyncedClock::new(); // default bounds
        assert!(matches!(clock.apply(ancient), Err(Error::Implausible(_))));
        assert!(
            !clock.synced(),
            "a rejected time must not mark the clock synced"
        );
        assert!(clock.offset_ns().is_none());
    }

    #[tokio::test]
    async fn persist_creates_missing_parent_dir() {
        let dir = std::env::temp_dir().join(format!("amos-ts-parent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nested").join("state.json");

        let remote = SystemTime::now() + Duration::from_secs(10);
        let source = MockTimeSource::fixed(remote);
        let mut clock = SyncedClock::new()
            .with_plausibility(wide())
            .with_state_file(path.clone());
        clock.sync(&source).await.expect("sync ok");

        assert!(path.exists(), "parent dirs should be created automatically");
        let restored = SyncedClock::load(&path);
        assert_eq!(restored.offset_ns(), clock.offset_ns());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn signed_offset_saturates_without_wrapping() {
        let epoch = SystemTime::UNIX_EPOCH;
        let year = Duration::from_secs(365 * 24 * 3600);

        // ~400 years ahead is beyond i64::MAX nanoseconds → saturates, never wraps
        // negative.
        let far_ahead = epoch + year * 400;
        assert_eq!(
            signed_offset_ns(far_ahead, epoch),
            i64::MAX,
            "huge forward offset must saturate"
        );

        // Same magnitude but the host is the far-future one → negative saturates.
        let far_back = epoch + year * 400;
        assert_eq!(
            signed_offset_ns(epoch, far_back),
            -i64::MAX,
            "huge backward offset must saturate (not underflow)"
        );

        // Normal small offsets stay exact.
        assert_eq!(
            signed_offset_ns(epoch + Duration::from_secs(5), epoch),
            5_000_000_000
        );
        assert_eq!(
            signed_offset_ns(epoch, epoch + Duration::from_secs(3)),
            -3_000_000_000
        );
        assert_eq!(signed_offset_ns(epoch, epoch), 0);
    }

    #[test]
    fn clock_types_are_send_and_sync() {
        // SyncedClock is shared behind Arc<Mutex> and driven from spawned async
        // tasks (Timekeeper) / across threads — lock the Send+Sync contract in at
        // compile time so a future field can't silently break it.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<SyncedClock>();
        assert_send_sync::<Plausibility>();
    }

    #[tokio::test]
    async fn corrected_now_advances_monotonically_from_anchor() {
        let mut clock = SyncedClock::new().with_plausibility(wide());
        let remote = SystemTime::now() + Duration::from_secs(5_000);
        clock.apply(remote).expect("apply ok");

        let t0 = clock.now();
        tokio::time::sleep(Duration::from_millis(20)).await;
        let t1 = clock.now();

        assert!(t1 > t0, "corrected now must advance monotonically");
        let step = t1.duration_since(t0).map(|d| d.as_millis()).unwrap_or(0);
        assert!(
            step >= 15,
            "corrected now should advance ~the wall time slept, got {step}ms"
        );
    }

    fn wide() -> Plausibility {
        Plausibility {
            min_epoch_secs: 0,
            max_epoch_secs: u64::MAX,
        }
    }
}
