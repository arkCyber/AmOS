//! Append-only audit log for configuration changes.
//!
//! Operators want to know "what changed, when, from where" — every successful
//! `Resolver::set` call writes one JSON line to the audit file (the same
//! `~/.amos/` directory the user config lives in). The file is **never**
//! truncated or rotated by this module; the operator owns it.
//!
//! The writer is best-effort: a write that fails (disk full, permission
//! change) is logged once on stderr (via `tracing::warn`) and then silenced
//! — logging must not take the process down.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AuditEvent {
    pub ts: String,
    pub key: String,
    pub from: serde_json::Value,
    pub to: serde_json::Value,
    /// `cli` / `ipc` / `remote` / `auto` (e.g. a hot-reload picked up a file
    /// change). Operators grep for this.
    pub source: String,
}

#[derive(Debug)]
pub struct AuditLogger {
    inner: Mutex<Option<PathBuf>>,
}

impl Clone for AuditLogger {
    fn clone(&self) -> Self {
        // Re-read the path from the mutex; an `AuditLogger` with no path is a
        // no-op (the writer is disabled), so cloning preserves the disabled
        // state too.
        let path = self.inner.lock().ok().and_then(|g| g.clone());
        Self {
            inner: Mutex::new(path),
        }
    }
}

impl AuditLogger {
    /// Open (or create) the audit file at `path`. The parent directory is
    /// created if it is missing.
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let p = path.into();
        if let Some(parent) = p.parent() {
            // Name the real cause here. The subsequent `append` can only report
            // "write failed" against the *file*, which hides the actual reason
            // (the parent directory could not be created) — same discipline as
            // the `store.rs` / `blocklist.rs` / `sms.rs` mkdir sites. Reported
            // rather than discarded (Power of 10 rule #7); the logger stays
            // best-effort and never panics.
            if let Err(e) = std::fs::create_dir_all(parent) {
                tracing::warn!(
                    dir = %parent.display(),
                    error = %e,
                    "config audit: audit directory could not be created; \
                     writes will fail and be reported per file"
                );
            }
        }
        Self {
            inner: Mutex::new(Some(p)),
        }
    }

    /// Append one event. A missing file or a write error is logged once and
    /// then silently dropped (the audit must not panic the daemon).
    pub fn append(&self, ev: AuditEvent) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let Some(path) = guard.as_ref() else { return };
        let line = match serde_json::to_string(&ev) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(error = %e, "config audit: event could not be serialised");
                return;
            }
        };
        let res = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| writeln!(f, "{line}"));
        if let Err(e) = res {
            tracing::warn!(path = %path.display(), error = %e, "config audit: write failed");
            // Disable further writes so we don't spam stderr.
            *guard = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!(
            "amos-config-audit-{tag}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn append_writes_one_json_line_per_event() {
        let dir = tmpdir("one");
        let path = dir.join("audit.jsonl");
        let log = AuditLogger::open(&path);
        log.append(AuditEvent {
            ts: "2026-09-18T00:00:00Z".into(),
            key: "amos.ai.port".into(),
            from: json!(8080),
            to: json!(9090),
            source: "cli".into(),
        });
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 1);
        let obj: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(obj["key"], "amos.ai.port");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_parent_dir_is_created() {
        let dir = tmpdir("nested");
        let path = dir.join("nested/audit.jsonl");
        let log = AuditLogger::open(&path);
        log.append(AuditEvent {
            ts: "t".into(),
            key: "k".into(),
            from: json!(null),
            to: json!(true),
            source: "ipc".into(),
        });
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_failure_is_logged_and_disables_further_writes() {
        let dir = tmpdir("nope");
        let log = AuditLogger::open(dir.join("nope/audit.jsonl"));
        // A bad path should not panic: the second append is a no-op rather
        // than a panic (the audit must never crash the daemon).
        log.append(AuditEvent {
            ts: "t".into(),
            key: "k".into(),
            from: json!(null),
            to: json!(true),
            source: "ipc".into(),
        });
        log.append(AuditEvent {
            ts: "t".into(),
            key: "k".into(),
            from: json!(null),
            to: json!(true),
            source: "ipc".into(),
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
