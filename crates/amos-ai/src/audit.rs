//! **Unified runtime audit model + durable sink** shared by the privacy
//! Permissions-Manager (`crate::privacy`) and the security layer
//! (`crate::security`).
//!
//! The two domains record audit events in slightly different typed shapes —
//! [`security::AuditEntry`] talks about *client operations* (`Success /
//! Rejected / Error`) while [`privacy::AccessRecord`] talks about *capability
//! decisions* (`Granted / Denied`). Both are normalised here into a single
//! on-the-wire / on-disk [`AuditRecord`], so a deployer can point the security
//! layer and the privacy manager at the **same durable sink** ([`AuditFile`])
//! without losing the distinction between an operation result and an access
//! decision (see [`Outcome`]).
//!
//! [`AuditFile`] is a JSON-lines append log: records are appended one per line,
//! a bounded in-memory ring keeps the *recent* window for cheap queries, and
//! the full log survives restarts (re-read on [`AuditFile::open`]). It is the
//! honest, type-unifying seam that turns the previous "memory-only, two
//! disconnected audit trails" into "one model, persistable, exportable".

use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::privacy::{AccessDecision, AccessRecord};
use crate::security::{AuditEntry, AuditResult};

/// The unified outcome of an audited event.
///
/// The security-layer results ([`AuditResult`]) and the privacy-layer access
/// decisions ([`AccessDecision`]) are folded into one enum so a single sink can
/// hold both without inventing a false "the policy gate had an error" for an
/// ordinary `Denied` decision (and vice-versa).
///
/// # One canonical spelling
///
/// Serialization is **lowercase** (`"rejected"`), identical to the gRPC wire
/// form (`proto/privacy.proto`: `granted|denied|success|rejected|error`) — the
/// on-disk JSON-lines trail and the RPC answer the *same* tag for the same
/// record, so an external consumer (SIEM export, log parser) cannot be tripped
/// by a casing mismatch. The PascalCase variant names are still **accepted when
/// reading**, so a trail written before this normalization stays readable
/// instead of being silently skipped as a malformed line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// Operation succeeded (security).
    #[serde(alias = "Success")]
    Success,
    /// Access to a sensitive resource was permitted (privacy).
    #[serde(alias = "Granted")]
    Granted,
    /// Access to a sensitive resource was denied (privacy; deny-by-default).
    #[serde(alias = "Denied")]
    Denied,
    /// Operation was rejected (e.g. rate limit / permission denied).
    #[serde(alias = "Rejected")]
    Rejected,
    /// Operation failed due to an error.
    #[serde(alias = "Error")]
    Error,
}

impl std::fmt::Display for Outcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Success => "SUCCESS",
            Self::Granted => "GRANTED",
            Self::Denied => "DENIED",
            Self::Rejected => "REJECTED",
            Self::Error => "ERROR",
        })
    }
}

impl From<AuditResult> for Outcome {
    fn from(r: AuditResult) -> Self {
        match r {
            AuditResult::Success => Self::Success,
            AuditResult::Rejected => Self::Rejected,
            AuditResult::Error => Self::Error,
        }
    }
}

impl From<AccessDecision> for Outcome {
    fn from(d: AccessDecision) -> Self {
        match d {
            AccessDecision::Granted => Self::Granted,
            AccessDecision::Denied => Self::Denied,
        }
    }
}

/// A single normalized, serializable audit event (one JSON-lines entry on disk).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditRecord {
    /// Unix timestamp (seconds).
    pub ts: u64,
    /// The acting principal: an app id (privacy) or a client id (security).
    pub principal: String,
    /// What happened (e.g. `"generate"`, `"perm.authorize"`, `"camera.open"`).
    pub op: String,
    /// Which resource was involved (`"microphone"`, `"camera"`, `"tokens"`, …).
    pub resource: String,
    /// The unified outcome.
    pub outcome: Outcome,
    /// Free-form detail.
    pub details: String,
}

impl From<AuditEntry> for AuditRecord {
    fn from(e: AuditEntry) -> Self {
        Self {
            ts: e.timestamp,
            principal: e.client_id,
            op: e.operation,
            resource: e.resource,
            outcome: e.result.into(),
            details: e.details,
        }
    }
}

impl From<AccessRecord> for AuditRecord {
    fn from(a: AccessRecord) -> Self {
        Self {
            ts: a.timestamp,
            principal: a.app,
            op: "perm.authorize".to_string(),
            resource: a.resource.key().to_string(),
            outcome: a.decision.into(),
            details: String::new(),
        }
    }
}

/// In-memory audit bound used when `AMOS_AUDIT_MAX_ENTRIES` is unset.
pub const DEFAULT_AUDIT_MAX_ENTRIES: usize = 10_000;

/// Rotation size for the durable audit trail when `AMOS_AUDIT_MAX_BYTES` is unset.
pub const DEFAULT_AUDIT_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Rotated audit files kept when `AMOS_AUDIT_KEEP` is unset.
pub const DEFAULT_AUDIT_KEEP: usize = 3;

/// Hard cap on `AMOS_AUDIT_KEEP`, so a typo cannot keep unlimited files.
pub const MAX_AUDIT_KEEP: usize = 64;

/// Parse `AMOS_AUDIT_MAX_ENTRIES`. A blank / non-numeric / **zero** value is
/// ignored: the bound is a safety property, so a typo must not remove it.
pub fn audit_max_entries_from(v: Option<&str>) -> usize {
    v.and_then(|s| s.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_AUDIT_MAX_ENTRIES)
}

/// Parse `AMOS_AUDIT_MAX_BYTES`. `None` (blank / non-numeric / **zero**) means
/// "use the default": a missing bound must never be read as "unbounded".
pub fn parse_audit_max_bytes(v: Option<&str>) -> Option<u64> {
    v.and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|n| *n > 0)
}

/// Parse `AMOS_AUDIT_KEEP` (bounded by [`MAX_AUDIT_KEEP`]). `None` for blank /
/// non-numeric / **zero** — same "a typo cannot remove the bound" rule.
pub fn parse_audit_keep(v: Option<&str>) -> Option<usize> {
    v.and_then(|s| s.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .map(|n| n.min(MAX_AUDIT_KEEP))
}

/// Where the daemon's **shared** durable audit trail lives and how it is bounded.
///
/// Resolved from already-read environment values, so the rule is a pure function
/// (the process environment is global; `security.rs` splits `from_env` the same way).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedTrailConfig {
    /// The JSON-lines trail file.
    pub path: PathBuf,
    /// Bounded in-memory window kept for cheap queries.
    pub max_mem: usize,
    /// Rotate the active file once it reaches this many bytes.
    pub max_bytes: u64,
    /// Rotated siblings kept (`<path>.1` newest … `<path>.<keep>` oldest).
    pub keep: usize,
}

/// Resolve the shared trail from already-read env values.
///
/// * `audit_path` (`AMOS_AUDIT_PATH`, explicit) wins;
/// * else `<privacy_path>.jsonl` (`AMOS_PRIVACY_PATH`), the historical location
///   the privacy service already wrote — so an existing deployment keeps, and
///   now **shares**, its trail instead of losing it;
/// * neither set ⇒ `None` (memory-only; the caller reports that honestly).
pub fn shared_trail_config_from_values(
    audit_path: Option<&str>,
    privacy_path: Option<&str>,
    max_entries: Option<&str>,
    max_bytes: Option<&str>,
    keep: Option<&str>,
) -> Option<SharedTrailConfig> {
    let path = match audit_path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => {
            let privacy = privacy_path.map(str::trim).filter(|s| !s.is_empty())?;
            PathBuf::from(privacy).with_extension("jsonl")
        }
    };
    Some(SharedTrailConfig {
        path,
        max_mem: audit_max_entries_from(max_entries),
        max_bytes: parse_audit_max_bytes(max_bytes).unwrap_or(DEFAULT_AUDIT_MAX_BYTES),
        keep: parse_audit_keep(keep).unwrap_or(DEFAULT_AUDIT_KEEP),
    })
}

/// Open the daemon's shared durable trail from the environment (`None` when
/// neither `AMOS_AUDIT_PATH` nor `AMOS_PRIVACY_PATH` is set).
///
/// The single sink handed to **both** the security layer and the privacy
/// manager, so one `RecentTrail` read-back shows operation results *and* access
/// decisions. A trail that cannot be opened degrades to memory-only with a
/// warning — the daemon keeps serving, exactly like the log-file sink.
pub fn shared_trail_from_env() -> Option<AuditFile> {
    let cfg = shared_trail_config_from_values(
        std::env::var("AMOS_AUDIT_PATH").ok().as_deref(),
        std::env::var("AMOS_PRIVACY_PATH").ok().as_deref(),
        std::env::var("AMOS_AUDIT_MAX_ENTRIES").ok().as_deref(),
        std::env::var("AMOS_AUDIT_MAX_BYTES").ok().as_deref(),
        std::env::var("AMOS_AUDIT_KEEP").ok().as_deref(),
    )?;
    match AuditFile::open_rotating(&cfg.path, cfg.max_mem, cfg.max_bytes, cfg.keep) {
        Ok(file) => {
            tracing::info!(
                path = %cfg.path.display(),
                max_bytes = cfg.max_bytes,
                keep = cfg.keep,
                "shared audit trail active"
            );
            Some(file)
        }
        Err(e) => {
            tracing::warn!(
                path = %cfg.path.display(),
                "audit trail unavailable ({e:#}); the audit is memory-only"
            );
            None
        }
    }
}

/// Path of the `k`-th rotated file (`k >= 1`): `<path>.1`, `<path>.2`, …
///
/// Same naming as the daemon log sink (`crate::logfile`), so an operator has one
/// rotation convention to remember.
fn rotated_path(path: &Path, k: usize) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(format!(".{k}"));
    PathBuf::from(s)
}

/// Append every **valid** JSON line of `path` to `ring`, keeping it at most `cap`
/// records (newest last). A missing file, a torn tail line or a line that is not
/// an [`AuditRecord`] is skipped — never fatal.
fn load_valid_lines(path: &Path, ring: &mut VecDeque<AuditRecord>, cap: usize) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(rec) = serde_json::from_str::<AuditRecord>(line) {
            ring.push_back(rec);
            if ring.len() > cap {
                let _ = ring.pop_front();
            }
        }
    }
}

/// A durable, bounded, JSON-lines audit sink.
///
/// * `path = Some(..)` → every [`AuditRecord`] is appended to that file (created
///   on first write) **and** kept in a bounded in-memory ring.
/// * `path = None` → memory-only (the default for tests / ephemeral managers).
///
/// **Bounded growth**: with `max_bytes > 0` the active file rotates to `<path>.1`
/// once it reaches that size (`.1` → `.2` … up to `keep`, oldest dropped), so a
/// long-running daemon cannot fill the disk with its own audit trail. Each write
/// is one complete line, so a rotation boundary is always a record boundary.
///
/// Concurrency: mutations happen under a `tokio::RwLock` on the ring; the
/// size-check + rotate + append is serialized by a `std::sync::Mutex` (the
/// shared trail has two producers, the security layer and the privacy manager).
/// File appends are best-effort single-line writes so a torn tail line on crash
/// is simply skipped when the log is re-read (see [`AuditFile::open`]).
#[derive(Debug, Clone)]
pub struct AuditFile {
    path: Option<PathBuf>,
    max_mem: usize,
    /// Rotate the active file once it reaches this many bytes (`0` = never).
    max_bytes: u64,
    /// Rotated siblings to keep (`<path>.1` newest … `<path>.<keep>` oldest).
    keep: usize,
    mem: Arc<RwLock<VecDeque<AuditRecord>>>,
    /// Serializes the size-check + rotate + append (never held across an `await`).
    io: Arc<Mutex<()>>,
    rotations: Arc<AtomicU64>,
}

impl AuditFile {
    /// A memory-only sink (never touches disk) keeping up to `max_mem` records.
    pub fn memory(max_mem: usize) -> Self {
        Self {
            path: None,
            max_mem: max_mem.max(1),
            max_bytes: 0,
            keep: 0,
            mem: Arc::new(RwLock::new(VecDeque::with_capacity(max_mem.max(1)))),
            io: Arc::new(Mutex::new(())),
            rotations: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Open (creating if absent) a durable sink at `path`, pre-loading any
    /// previously appended **valid** records into the bounded ring. Malformed /
    /// torn lines are skipped, never fatal — the log is best-effort by design.
    ///
    /// No rotation: the file grows unbounded. Prefer [`AuditFile::open_rotating`]
    /// (what the daemon uses) for a trail that must stay bounded.
    pub fn open(path: impl AsRef<Path>, max_mem: usize) -> Result<Self> {
        Self::open_rotating(path, max_mem, 0, 0)
    }

    /// Open a durable sink that **rotates itself** once the active file reaches
    /// `max_bytes`, keeping at most `keep` rotated siblings (`max_bytes == 0` ⇒
    /// never rotate, same as [`AuditFile::open`]).
    ///
    /// On open, the rotated siblings (`.<keep>` oldest → `.1`) are read first,
    /// then the active file, so a restart still sees the recent window across a
    /// roll-over. Malformed / torn lines are skipped.
    pub fn open_rotating(
        path: impl AsRef<Path>,
        max_mem: usize,
        max_bytes: u64,
        keep: usize,
    ) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let cap = max_mem.max(1);
        let mut ring = VecDeque::with_capacity(cap);
        // Oldest file first, so the ring's `pop_front` keeps the newest records.
        for k in (1..=keep).rev() {
            load_valid_lines(&rotated_path(&path, k), &mut ring, cap);
        }
        load_valid_lines(&path, &mut ring, cap);
        Ok(Self {
            path: Some(path),
            max_mem: cap,
            max_bytes,
            keep,
            mem: Arc::new(RwLock::new(ring)),
            io: Arc::new(Mutex::new(())),
            rotations: Arc::new(AtomicU64::new(0)),
        })
    }

    /// The on-disk path, if durable.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Completed roll-overs since this sink was opened (diagnostics / tests).
    pub fn rotations(&self) -> u64 {
        self.rotations.load(Ordering::Relaxed)
    }

    /// Record one event: append to disk (if durable) and keep in the ring.
    pub async fn log(&self, rec: AuditRecord) -> Result<()> {
        {
            let mut ring = self.mem.write().await;
            ring.push_back(rec.clone());
            if ring.len() > self.max_mem {
                let _ = ring.pop_front();
            }
        }

        if self.path.is_none() {
            return Ok(());
        }
        // The durable half is **synchronous**: it takes the `std::sync::Mutex` and does
        // open/append/metadata/rotate, so it runs on a blocking thread. `log` is awaited
        // by every security and privacy decision on the request path — a slow or contended
        // disk must not stall the tokio worker. The clone is cheap (every heavy field is an
        // `Arc`; the rest are `Copy`/`PathBuf`).
        let me = self.clone();
        tokio::task::spawn_blocking(move || me.append_blocking(rec))
            .await
            .map_err(|e| anyhow!("audit append task failed: {e}"))?
    }

    /// The synchronous half of [`AuditFile::log`]: create the directory, append one line,
    /// then rotate once the active file passed the bound.
    ///
    /// Must run on a **blocking thread** (see `log`): it takes the `std::sync::Mutex` and
    /// touches the filesystem. Split out so the async caller can hand it to
    /// `spawn_blocking` without borrowing `&self` across threads.
    fn append_blocking(&self, rec: AuditRecord) -> Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if let Some(dir) = path.parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir)
                    .with_context(|| format!("create audit dir {}", dir.display()))?;
            }
        }
        let line = serde_json::to_string(&rec).context("serialize audit record")?;
        // Serialize size-check + rotate + append: the shared trail has two
        // producers, and an interleaved roll-over would split a record.
        let _guard = self.io.lock().unwrap_or_else(|p| p.into_inner());
        {
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .with_context(|| format!("open audit file {}", path.display()))?;
            writeln!(f, "{line}")
                .with_context(|| format!("append audit file {}", path.display()))?;
        }
        // Rotate only once the write is complete, so the active file always ends
        // on a record boundary (never a half line).
        if self.max_bytes > 0 {
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            if size >= self.max_bytes {
                self.rotate(path)?;
            }
        }
        Ok(())
    }

    /// Shift `.<k>` → `.<k+1>`, drop the oldest, then `path` → `.1` and restart empty.
    fn rotate(&self, path: &Path) -> Result<()> {
        if self.keep == 0 {
            // Keep no history: start the active file over.
            std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(path)
                .with_context(|| format!("truncate audit file {}", path.display()))?;
            self.rotations.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }
        let _ = std::fs::remove_file(rotated_path(path, self.keep));
        for k in (1..self.keep).rev() {
            let from = rotated_path(path, k);
            if from.exists() {
                let _ = std::fs::rename(&from, rotated_path(path, k + 1));
            }
        }
        std::fs::rename(path, rotated_path(path, 1))
            .with_context(|| format!("rotate audit file {}", path.display()))?;
        // Recreate the active file so the trail path always exists (a concurrent
        // reader must not see a vanished file mid-roll-over).
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .with_context(|| format!("reopen audit file {}", path.display()))?;
        self.rotations.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// Number of records currently in the in-memory ring.
    pub async fn count(&self) -> usize {
        self.mem.read().await.len()
    }

    /// The most recent records, newest first.
    pub async fn recent(&self, limit: usize) -> Vec<AuditRecord> {
        let ring = self.mem.read().await;
        ring.iter().rev().take(limit).cloned().collect()
    }

    /// Filtered view of the recent window (newest first). `None` means
    /// "any" for that dimension; `resource` matches the wire key exactly.
    pub async fn recent_matching(
        &self,
        limit: usize,
        principal: Option<&str>,
        resource: Option<&str>,
        outcome: Option<Outcome>,
    ) -> Vec<AuditRecord> {
        let ring = self.mem.read().await;
        ring.iter()
            .rev()
            .filter(|r| {
                principal.map_or(true, |p| r.principal == p)
                    && resource.map_or(true, |x| r.resource == x)
                    && outcome.map_or(true, |o| r.outcome == o)
            })
            .take(limit)
            .cloned()
            .collect()
    }

    /// Serialize the in-memory ring (oldest first) as a JSON array, for
    /// SIEM-style export. Returns an error only on serialization failure.
    pub async fn export_json(&self) -> Result<String> {
        let ring = self.mem.read().await;
        serde_json::to_string(&*ring).context("serialize audit ring")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::privacy::{AccessDecision, AccessRecord, Resource};
    use crate::security::AuditEntry;

    fn _assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn audit_file_is_send_sync() {
        _assert_send_sync::<AuditFile>();
    }

    #[test]
    fn conversions_map_domains_without_collapsing() {
        let e = AuditEntry {
            timestamp: 1,
            client_id: "cli".into(),
            operation: "generate".into(),
            resource: "tokens".into(),
            result: AuditResult::Rejected,
            details: "over quota".into(),
        };
        let rec = AuditRecord::from(e);
        assert_eq!(rec.outcome, Outcome::Rejected);
        assert_eq!(rec.principal, "cli");
        assert_eq!(rec.resource, "tokens");

        let a = AccessRecord {
            timestamp: 2,
            app: "com.x".into(),
            resource: Resource::Microphone,
            decision: AccessDecision::Denied,
        };
        let rec2 = AuditRecord::from(a);
        assert_eq!(rec2.outcome, Outcome::Denied);
        assert_eq!(rec2.op, "perm.authorize");
        assert_eq!(rec2.resource, "microphone");
        assert_ne!(rec2.outcome, Outcome::Rejected, "denied ≠ rejected");
    }

    #[tokio::test]
    async fn memory_sink_is_bounded_and_newest_first() {
        let s = AuditFile::memory(2);
        for i in 0..4 {
            s.log(AuditRecord {
                ts: i,
                principal: "a".into(),
                op: "perm.authorize".into(),
                resource: "camera".into(),
                outcome: Outcome::Granted,
                details: String::new(),
            })
            .await
            .unwrap();
        }
        assert_eq!(s.count().await, 2, "ring is bounded");
        let recent = s.recent(10).await;
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].ts, 3, "newest first");
        assert_eq!(recent[1].ts, 2);
    }

    #[tokio::test]
    async fn durable_sink_round_trips_and_appends_across_reopen() {
        let dir = std::env::temp_dir().join(format!("amos-audit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audit.jsonl");

        let sink = AuditFile::open(&path, 64).unwrap();
        sink.log(AuditRecord {
            ts: 1,
            principal: "com.amos.phone".into(),
            op: "perm.authorize".into(),
            resource: "microphone".into(),
            outcome: Outcome::Granted,
            details: String::new(),
        })
        .await
        .unwrap();

        // A *second* open (simulating restart) sees the first record.
        let reopened = AuditFile::open(&path, 64).unwrap();
        assert_eq!(reopened.count().await, 1);
        let recent = reopened.recent(10).await;
        assert_eq!(recent[0].resource, "microphone");
        assert_eq!(recent[0].outcome, Outcome::Granted);

        // Appending on the reopened instance persists a second record.
        reopened
            .log(AuditRecord {
                ts: 2,
                principal: "com.x".into(),
                op: "perm.authorize".into(),
                resource: "location".into(),
                outcome: Outcome::Denied,
                details: String::new(),
            })
            .await
            .unwrap();
        let again = AuditFile::open(&path, 64).unwrap();
        assert_eq!(again.count().await, 2, "both records survived");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn outcome_has_one_canonical_spelling_but_reads_the_legacy_one() {
        // On disk AND over the wire the tag is lowercase, so an external consumer
        // (SIEM export, log parser) can never be tripped by a casing mismatch.
        for (outcome, tag) in [
            (Outcome::Success, "success"),
            (Outcome::Granted, "granted"),
            (Outcome::Denied, "denied"),
            (Outcome::Rejected, "rejected"),
            (Outcome::Error, "error"),
        ] {
            let json = serde_json::to_string(&outcome).expect("serialize");
            assert_eq!(json, format!("\"{tag}\""));
            // The RPC form the privacy service emits is the same string.
            assert_eq!(outcome.to_string().to_ascii_lowercase(), tag);
            // And it round-trips.
            assert_eq!(
                serde_json::from_str::<Outcome>(&json).expect("deserialize"),
                outcome
            );
        }

        // A record written before the normalization (PascalCase) still reads.
        let legacy = r#"{"ts":1,"principal":"a","op":"devcare.clean","resource":"r","outcome":"Rejected","details":""}"#;
        let rec: AuditRecord = serde_json::from_str(legacy).expect("legacy line is readable");
        assert_eq!(rec.outcome, Outcome::Rejected);
        // Re-serializing normalizes it to the canonical spelling.
        assert!(serde_json::to_string(&rec)
            .expect("serialize")
            .contains("\"rejected\""));
    }

    #[test]
    fn open_skips_torn_or_malformed_lines() {
        let dir = std::env::temp_dir().join(format!("amos-audit-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audit.jsonl");
        let good = serde_json::to_string(&AuditRecord {
            ts: 1,
            principal: "a".into(),
            op: "perm.authorize".into(),
            resource: "camera".into(),
            outcome: Outcome::Granted,
            details: String::new(),
        })
        .unwrap();
        std::fs::write(&path, format!("{good}\n{{torn,\nnot-json\n")).unwrap();

        let sink = AuditFile::open(&path, 64).unwrap();
        let ring = sink.mem.blocking_read();
        assert_eq!(ring.len(), 1, "only the valid line is kept");

        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn audit_bounds_are_a_safety_property_not_a_knob_to_switch_off() {
        // A blank / garbage / zero value must never remove a bound.
        assert_eq!(audit_max_entries_from(None), DEFAULT_AUDIT_MAX_ENTRIES);
        assert_eq!(audit_max_entries_from(Some("")), DEFAULT_AUDIT_MAX_ENTRIES);
        assert_eq!(
            audit_max_entries_from(Some("junk")),
            DEFAULT_AUDIT_MAX_ENTRIES
        );
        assert_eq!(audit_max_entries_from(Some("0")), DEFAULT_AUDIT_MAX_ENTRIES);
        assert_eq!(audit_max_entries_from(Some(" 250 ")), 250);

        assert_eq!(parse_audit_max_bytes(None), None);
        assert_eq!(parse_audit_max_bytes(Some("0")), None);
        assert_eq!(parse_audit_max_bytes(Some("4096")), Some(4096));

        assert_eq!(parse_audit_keep(Some("0")), None);
        assert_eq!(parse_audit_keep(Some("2")), Some(2));
        assert_eq!(parse_audit_keep(Some("9999")), Some(MAX_AUDIT_KEEP));
    }

    #[test]
    fn shared_trail_prefers_the_explicit_path_and_keeps_the_legacy_one() {
        // An explicit AMOS_AUDIT_PATH wins.
        let c = shared_trail_config_from_values(
            Some("/var/log/amos/audit.jsonl"),
            Some("/data/privacy.json"),
            Some("500"),
            Some("1024"),
            Some("2"),
        )
        .expect("configured");
        assert_eq!(c.path, PathBuf::from("/var/log/amos/audit.jsonl"));
        assert_eq!((c.max_mem, c.max_bytes, c.keep), (500, 1024, 2));

        // No explicit path ⇒ the historical `<AMOS_PRIVACY_PATH>.jsonl` is reused,
        // so an existing deployment keeps — and now shares — its trail.
        let c = shared_trail_config_from_values(None, Some("/data/privacy.json"), None, None, None)
            .expect("legacy path");
        assert_eq!(c.path, PathBuf::from("/data/privacy.jsonl"));
        assert_eq!(c.max_mem, DEFAULT_AUDIT_MAX_ENTRIES);
        assert_eq!(c.max_bytes, DEFAULT_AUDIT_MAX_BYTES);
        assert_eq!(c.keep, DEFAULT_AUDIT_KEEP);

        // Blank counts as unset; with neither path there is no trail at all.
        assert!(shared_trail_config_from_values(Some("  "), Some(""), None, None, None).is_none());
        assert!(shared_trail_config_from_values(None, None, None, None, None).is_none());
    }

    #[tokio::test]
    async fn rotating_sink_stays_bounded_and_keeps_the_newest_records() {
        let dir = std::env::temp_dir().join(format!("amos-audit-rot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("trail.jsonl");

        // Wide records + a small cap ⇒ several roll-overs, keeping 2 files. The
        // count is deliberately odd so the active file holds a record at the end.
        let sink = AuditFile::open_rotating(&path, 64, 200, 2).unwrap();
        for i in 0..13u64 {
            sink.log(AuditRecord {
                ts: i,
                principal: "cli".into(),
                op: "generate".into(),
                resource: format!("r{i}"),
                outcome: Outcome::Success,
                details: "x".repeat(40),
            })
            .await
            .unwrap();
        }
        assert!(sink.rotations() >= 1, "it really rolled over");

        // Only `keep` siblings (plus the active file) may exist.
        assert!(dir.join("trail.jsonl").exists(), "the active file exists");
        assert!(dir.join("trail.jsonl.1").exists());
        assert!(dir.join("trail.jsonl.2").exists());
        assert!(!dir.join("trail.jsonl.3").exists(), "the oldest is dropped");

        // Rotation happens on a record boundary, so every file is whole JSON lines.
        for f in ["trail.jsonl", "trail.jsonl.1", "trail.jsonl.2"] {
            let raw = std::fs::read_to_string(dir.join(f)).unwrap();
            if f != "trail.jsonl" {
                assert!(!raw.is_empty(), "{f} is a completed roll-over");
                assert!(raw.ends_with('\n'), "{f} ends on a record boundary");
            }
            for line in raw.lines() {
                serde_json::from_str::<AuditRecord>(line).unwrap_or_else(|e| panic!("{f}: {e}"));
            }
        }

        // A restart reads across the rotation window: the newest record is there,
        // the oldest is not (bounded ⇒ the far past is honestly gone, not implied).
        let reopened = AuditFile::open_rotating(&path, 64, 200, 2).unwrap();
        let recent = reopened.recent(64).await;
        assert_eq!(recent[0].ts, 12, "newest first");
        assert!(recent.iter().all(|r| r.ts < 13));
        assert!(!recent.iter().any(|r| r.ts == 0), "the oldest rolled away");
        assert!(recent.len() < 13, "the trail really is bounded");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn one_shared_sink_carries_security_operations_and_privacy_decisions() {
        use crate::privacy::PrivacyManager;
        use crate::security::AuditLogger;

        let dir = std::env::temp_dir().join(format!("amos-audit-shared-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("trail.jsonl");

        // The daemon opens ONE sink and hands a clone to both domains (a clone
        // shares the ring + the file) — this is what makes `RecentTrail` unified.
        let sink = AuditFile::open_rotating(&path, 64, 0, 0).unwrap();
        let privacy = PrivacyManager::with_audit_file(16, sink.clone());
        let mut logger = AuditLogger::new(16);
        logger.attach_sink(sink.clone());

        privacy.grant("com.amos.phone", Resource::Microphone).await;
        assert_eq!(
            privacy
                .authorize("com.amos.phone", Resource::Microphone)
                .await,
            AccessDecision::Granted
        );
        logger
            .log(
                "client-1".into(),
                "generate".into(),
                "tokens".into(),
                AuditResult::Rejected,
                "rate limit exceeded".into(),
            )
            .await;

        // One read-back shows BOTH an access decision and an operation result —
        // exactly what the trail RPC needs and could never show before.
        let (trail, durable) = privacy.recent_trail(10, None, None).await;
        assert!(durable, "a trail is attached");
        assert_eq!(trail.len(), 2, "both domains land in ONE trail");
        assert_eq!(trail[0].op, "generate");
        assert_eq!(trail[0].principal, "client-1");
        assert_eq!(trail[0].outcome, Outcome::Rejected);
        assert_eq!(trail[1].op, "perm.authorize");
        assert_eq!(trail[1].principal, "com.amos.phone");
        assert_eq!(trail[1].outcome, Outcome::Granted);

        // ... and it is durable: a restart (re-open) still has both records.
        let reopened = AuditFile::open(&path, 64).unwrap();
        assert_eq!(reopened.count().await, 2, "persisted, not just in memory");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
