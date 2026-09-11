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
use std::sync::Arc;

use anyhow::{Context, Result};
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

/// A durable, bounded, JSON-lines audit sink.
///
/// * `path = Some(..)` → every [`AuditRecord`] is appended to that file (created
///   on first write) **and** kept in a bounded in-memory ring.
/// * `path = None` → memory-only (the default for tests / ephemeral managers).
///
/// Concurrency: mutations happen under a `tokio::RwLock` on the ring; file
/// appends are best-effort single-line writes so a torn tail line on crash is
/// simply skipped when the log is re-read (see [`AuditFile::open`]).
#[derive(Debug, Clone)]
pub struct AuditFile {
    path: Option<PathBuf>,
    max_mem: usize,
    mem: Arc<RwLock<VecDeque<AuditRecord>>>,
}

impl AuditFile {
    /// A memory-only sink (never touches disk) keeping up to `max_mem` records.
    pub fn memory(max_mem: usize) -> Self {
        Self {
            path: None,
            max_mem: max_mem.max(1),
            mem: Arc::new(RwLock::new(VecDeque::with_capacity(max_mem.max(1)))),
        }
    }

    /// Open (creating if absent) a durable sink at `path`, pre-loading any
    /// previously appended **valid** records into the bounded ring. Malformed /
    /// torn lines are skipped, never fatal — the log is best-effort by design.
    pub fn open(path: impl AsRef<Path>, max_mem: usize) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let cap = max_mem.max(1);
        let mut ring = VecDeque::with_capacity(cap);
        if let Ok(raw) = std::fs::read_to_string(&path) {
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
        Ok(Self {
            path: Some(path),
            max_mem: cap,
            mem: Arc::new(RwLock::new(ring)),
        })
    }

    /// The on-disk path, if durable.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
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
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .with_context(|| format!("open audit file {}", path.display()))?;
        writeln!(f, "{line}").with_context(|| format!("append audit file {}", path.display()))?;
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
}
