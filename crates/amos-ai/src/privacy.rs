//! OS **Privacy / permissions domain core** — a deny-by-default, per-app capability
//! store over sensitive resources (microphone / camera / contacts / location /
//! storage) plus a runtime access audit trail.
//!
//! This is the granular Permissions-Manager *domain seam* for the System UI and the
//! third-party-app sandbox: the headless `amos-ai` daemon and the frontend can ask
//! "may app `X` open the mic right now?" and every decision is logged. It is a pure
//! domain core (offline-testable) on the same pattern as the rest of AmOS — *who*
//! enforces the decision at the OS boundary (intercepting a third-party APK's
//! `AudioRecord`/`Camera.open`, gating the glue in `amos-tauri`) is the device/
//! ecosystem step tracked in `docs/` and is *not* faked here.
//!
//! ```text
//! [ System UI / sandbox interposer ]  authorize("com.x.app", Mic) ─┐
//!                                                              ▼
//!                  PrivacyManager { app -> granted Resources }   │ deny-by-default
//!                                                              ▼
//!                         AccessDecision{ Granted | Denied }  +  audit trail
//! ```

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::audit::AuditFile;

/// A sensitive resource a third-party app may request access to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Resource {
    /// Microphone capture.
    Microphone,
    /// Camera capture / preview.
    Camera,
    /// Contacts / address book.
    Contacts,
    /// Precise location / GNSS.
    Location,
    /// User files / external storage.
    Storage,
}

impl Resource {
    /// Stable wire/UI key.
    pub const ALL: [Resource; 5] = [
        Resource::Microphone,
        Resource::Camera,
        Resource::Contacts,
        Resource::Location,
        Resource::Storage,
    ];

    /// Stable wire/UI key (`"microphone"`, `"camera"`, `"contacts"`,
    /// `"location"`, `"storage"`).
    pub const fn key(self) -> &'static str {
        match self {
            Self::Microphone => "microphone",
            Self::Camera => "camera",
            Self::Contacts => "contacts",
            Self::Location => "location",
            Self::Storage => "storage",
        }
    }

    /// Parse from a key; `None` for unknown strings.
    pub fn from_key(s: &str) -> Option<Self> {
        match s {
            "microphone" => Some(Self::Microphone),
            "camera" => Some(Self::Camera),
            "contacts" => Some(Self::Contacts),
            "location" => Some(Self::Location),
            "storage" => Some(Self::Storage),
            _ => None,
        }
    }
}

/// The decision for one app-resource access request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AccessDecision {
    /// Access is permitted (the app holds a grant for this resource).
    Granted,
    /// Access is denied (no grant; deny-by-default).
    Denied,
}

impl std::fmt::Display for AccessDecision {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Granted => "granted",
            Self::Denied => "denied",
        })
    }
}

/// One recorded access attempt (runtime security audit trail).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessRecord {
    /// Unix timestamp (seconds).
    pub timestamp: u64,
    /// The requesting app / principal id.
    pub app: String,
    /// The resource requested.
    pub resource: Resource,
    /// Whether it was granted.
    pub decision: AccessDecision,
}
/// A **deny-by-default**, per-app capability store over sensitive resources.
///
/// Thread-safe (`Send + Sync`): the System UI / sandbox interposer and the audit
/// consumer share one instance. No grant exists until [`Self::grant`] is called —
/// an unknown app is always denied.
#[derive(Debug, Default)]
pub struct PrivacyManager {
    grants: Arc<RwLock<HashMap<String, HashSet<Resource>>>>,
    /// Runtime access audit trail (bounded by `max_audit`).
    audit: Arc<RwLock<Vec<AccessRecord>>>,
    max_audit: usize,
    /// Optional unified durable sink: when present, every [`authorize`] decision
    /// is also mirrored to it as a normalized [`AuditRecord`], so the privacy
    /// audit flows through the same persistable model as the security layer's.
    ///
    /// [`authorize`]: PrivacyManager::authorize
    /// [`AuditRecord`]: crate::audit::AuditRecord
    audit_file: Option<AuditFile>,
}

impl PrivacyManager {
    /// A fresh manager (deny-by-default) keeping up to `max_audit` recent records.
    pub fn new(max_audit: usize) -> Self {
        Self {
            grants: Arc::new(RwLock::new(HashMap::new())),
            audit: Arc::new(RwLock::new(Vec::with_capacity(max_audit))),
            max_audit: max_audit.max(1),
            audit_file: None,
        }
    }

    /// A fresh deny-by-default manager that additionally mirrors every
    /// [`authorize`] decision to the durable unified sink `sink`.
    ///
    /// [`authorize`]: PrivacyManager::authorize
    pub fn with_audit_file(max_audit: usize, sink: AuditFile) -> Self {
        let mut m = Self::new(max_audit);
        m.audit_file = Some(sink);
        m
    }

    /// Attach a durable unified sink (builder; consumes `self`). Use this after
    /// [`PrivacyManager::load`] so a restarted manager keeps appending decisions.
    pub fn with_durable_audit(mut self, sink: AuditFile) -> Self {
        self.audit_file = Some(sink);
        self
    }

    /// Allow `app` access to `resource`.
    pub async fn grant(&self, app: impl Into<String>, resource: Resource) {
        self.grants
            .write()
            .await
            .entry(app.into())
            .or_default()
            .insert(resource);
    }

    /// Remove `app`'s access to `resource` only.
    pub async fn revoke(&self, app: &str, resource: Resource) {
        let mut grants = self.grants.write().await;
        if let Some(set) = grants.get_mut(app) {
            set.remove(&resource);
            if set.is_empty() {
                grants.remove(app);
            }
        }
    }

    /// Remove every grant for `app` (sandbox teardown / uninstall).
    pub async fn revoke_all(&self, app: &str) {
        self.grants.write().await.remove(app);
    }

    /// The resources currently granted to `app` (empty for an unknown app).
    pub async fn granted(&self, app: &str) -> Vec<Resource> {
        self.grants
            .read()
            .await
            .get(app)
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default()
    }

    /// Decide one access request (deny-by-default) and record it in the audit
    /// trail. This is the single chokepoint an interposer/sandbox should call.
    pub async fn authorize(&self, app: &str, resource: Resource) -> AccessDecision {
        let decision = if self
            .grants
            .read()
            .await
            .get(app)
            .map(|s| s.contains(&resource))
            .unwrap_or(false)
        {
            AccessDecision::Granted
        } else {
            AccessDecision::Denied
        };
        self.record(app, resource, decision).await;
        decision
    }

    /// Cheap grant check without auditing (probes / UI toggles).
    pub async fn is_granted(&self, app: &str, resource: Resource) -> bool {
        self.grants
            .read()
            .await
            .get(app)
            .map(|s| s.contains(&resource))
            .unwrap_or(false)
    }

    /// The most recent audit records, newest first.
    pub async fn recent_audit(&self, limit: usize) -> Vec<AccessRecord> {
        self.audit
            .read()
            .await
            .iter()
            .rev()
            .take(limit)
            .cloned()
            .collect()
    }

    async fn record(&self, app: &str, resource: Resource, decision: AccessDecision) {
        let entry = AccessRecord {
            timestamp: now_secs(),
            app: app.to_string(),
            resource,
            decision,
        };
        {
            let mut audit = self.audit.write().await;
            audit.push(entry.clone());
            if audit.len() > self.max_audit {
                let drop = audit.len() - self.max_audit;
                audit.drain(0..drop);
            }
        }
        // Mirror every decision to the durable unified sink, if configured.
        // Best-effort: a disk error is logged, never fatal to the decision.
        if let Some(sink) = &self.audit_file {
            let rec = crate::audit::AuditRecord::from(entry);
            if let Err(e) = sink.log(rec).await {
                tracing::warn!("privacy audit append failed: {e:#}");
            }
        }
    }

    /// Snapshot the current grants (resources stored by their stable wire key,
    /// sorted for a deterministic file) + the audit trail. This is what
    /// [`PrivacyManager::save`] writes to disk and [`PrivacyManager::load`] reads.
    async fn file_state(&self) -> FileState {
        let grants = self.grants.read().await;
        let audit = self.audit.read().await;
        let mut g: HashMap<String, Vec<String>> = HashMap::with_capacity(grants.len());
        for (app, set) in grants.iter() {
            let mut keys: Vec<String> = set.iter().map(|r| r.key().to_string()).collect();
            keys.sort();
            g.insert(app.clone(), keys);
        }
        FileState {
            max_audit: self.max_audit,
            grants: g,
            audit: audit.clone(),
        }
    }

    /// Persist the current grants + audit trail atomically to `path` as JSON
    /// (write a temp file in the same directory, then rename). Grants survive a
    /// restart by reading them back with [`PrivacyManager::load`]. Unknown keys
    /// in the file are dropped on load (deny-by-default is preserved).
    pub async fn save(&self, path: &Path) -> Result<()> {
        let state = self.file_state().await;
        let json = serde_json::to_string_pretty(&state).context("serialize privacy state")?;
        atomic_write(path, json.as_bytes())
    }

    /// Rebuild a manager from a JSON file previously written by
    /// [`PrivacyManager::save`]. A missing / malformed file yields an error
    /// (the caller may fall back to an empty, deny-by-default manager); an
    /// audit trail longer than `max_audit` is trimmed to the newest entries.
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("read privacy state at {}", path.display()))?;
        let state: FileState = serde_json::from_str(&raw)
            .with_context(|| format!("parse privacy state at {}", path.display()))?;

        let max = state.max_audit.max(1);
        let mut grants: HashMap<String, HashSet<Resource>> =
            HashMap::with_capacity(state.grants.len());
        for (app, keys) in state.grants {
            let set: HashSet<Resource> =
                keys.iter().filter_map(|k| Resource::from_key(k)).collect();
            if !set.is_empty() {
                grants.insert(app, set);
            }
        }
        let mut audit = state.audit;
        if audit.len() > max {
            let drop = audit.len() - max;
            audit.drain(0..drop);
        }
        Ok(Self {
            grants: Arc::new(RwLock::new(grants)),
            audit: Arc::new(RwLock::new(audit)),
            max_audit: max,
            audit_file: None,
        })
    }
}

/// Serialisable snapshot of a [`PrivacyManager`] for on-disk persistence.
///
/// Grants store resources by their **stable wire key** (`Resource::key`) rather
/// than the enum's serde tag, so the file is human-friendly and future-proof
/// against enum-variant renames. Fields are private: construction/parsing only
/// happens through [`PrivacyManager::save`] / [`PrivacyManager::load`].
#[derive(Debug, Serialize, Deserialize)]
struct FileState {
    max_audit: usize,
    grants: HashMap<String, Vec<String>>,
    audit: Vec<AccessRecord>,
}

/// Write `bytes` to `path` atomically: write to a temp sibling, then rename over
/// the target so a crash mid-write never leaves a truncated grants file.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("create privacy state dir {}", dir.display()))?;
        }
    }
    let tmp = tmp_path_for(path);
    std::fs::write(&tmp, bytes)
        .with_context(|| format!("write temp privacy state {}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("rename temp state to {}", path.display()))?;
    Ok(())
}

/// A `<path>.tmp` sibling used by [`atomic_write`].
fn tmp_path_for(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".tmp");
    PathBuf::from(s)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
#[cfg(test)]
mod tests {
    use super::*;

    fn pm() -> PrivacyManager {
        PrivacyManager::new(16)
    }

    fn _assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn privacy_manager_is_send_sync() {
        _assert_send_sync::<PrivacyManager>();
    }

    #[test]
    fn resource_keys_round_trip_and_reject_unknown() {
        for r in Resource::ALL {
            assert_eq!(Resource::from_key(r.key()), Some(r));
        }
        assert_eq!(Resource::from_key("microphone"), Some(Resource::Microphone));
        assert_eq!(Resource::from_key("barometer"), None);
    }

    #[tokio::test]
    async fn deny_by_default_unknown_app_is_denied() {
        let p = pm();
        assert_eq!(
            p.authorize("com.third.party", Resource::Camera).await,
            AccessDecision::Denied
        );
        assert!(!p.is_granted("com.third.party", Resource::Camera).await);
        assert!(p.granted("com.third.party").await.is_empty());
    }

    #[tokio::test]
    async fn grant_then_authorize_then_revoke() {
        let p = pm();
        p.grant("com.amos.phone", Resource::Microphone).await;
        assert_eq!(
            p.authorize("com.amos.phone", Resource::Microphone).await,
            AccessDecision::Granted
        );
        // A different resource on the same app is still denied.
        assert_eq!(
            p.authorize("com.amos.phone", Resource::Camera).await,
            AccessDecision::Denied
        );
        p.revoke("com.amos.phone", Resource::Microphone).await;
        assert_eq!(
            p.authorize("com.amos.phone", Resource::Microphone).await,
            AccessDecision::Denied
        );
    }

    #[tokio::test]
    async fn grants_are_per_app_isolated() {
        let p = pm();
        p.grant("appA", Resource::Camera).await;
        assert!(p.is_granted("appA", Resource::Camera).await);
        assert!(!p.is_granted("appB", Resource::Camera).await);
        assert_eq!(
            p.authorize("appB", Resource::Camera).await,
            AccessDecision::Denied
        );
    }

    #[tokio::test]
    async fn revoke_all_is_sandbox_teardown() {
        let p = pm();
        p.grant("com.x", Resource::Microphone).await;
        p.grant("com.x", Resource::Storage).await;
        p.revoke_all("com.x").await;
        assert!(p.granted("com.x").await.is_empty());
        assert_eq!(
            p.authorize("com.x", Resource::Microphone).await,
            AccessDecision::Denied
        );
    }

    #[tokio::test]
    async fn audit_trail_records_every_decision_and_is_bounded() {
        let p = PrivacyManager::new(2);
        p.grant("app", Resource::Camera).await;
        p.authorize("app", Resource::Camera).await; // granted
        p.authorize("app", Resource::Microphone).await; // denied
        p.authorize("other", Resource::Location).await; // denied (evicts oldest)

        let trail = p.recent_audit(10).await;
        assert_eq!(trail.len(), 2, "audit is bounded by max_audit");
        assert_eq!(trail[0].decision, AccessDecision::Denied); // newest
        assert!(trail.iter().any(|r| r.resource == Resource::Microphone));
        assert!(trail.iter().any(|r| r.app == "other"));
    }

    #[tokio::test]
    async fn save_load_round_trips_grants_and_audit() {
        let dir = std::env::temp_dir().join(format!("amos-privacy-{}", std::process::id()));
        let path = dir.join("privacy.json");

        let p = PrivacyManager::new(16);
        p.grant("com.amos.phone", Resource::Microphone).await;
        p.grant("com.amos.phone", Resource::Storage).await;
        p.grant("com.x", Resource::Camera).await;
        p.authorize("com.amos.phone", Resource::Microphone).await; // granted → audit
        p.authorize("com.x", Resource::Location).await; // denied → audit
        p.save(&path).await.unwrap();

        let loaded = PrivacyManager::load(&path).unwrap();
        assert!(
            loaded
                .is_granted("com.amos.phone", Resource::Microphone)
                .await
        );
        assert!(loaded.is_granted("com.amos.phone", Resource::Storage).await);
        assert!(loaded.is_granted("com.x", Resource::Camera).await);
        // Deny-by-default is preserved for an app absent from the file.
        assert!(!loaded.is_granted("nobody", Resource::Camera).await);

        let trail = loaded.recent_audit(10).await;
        assert_eq!(trail.len(), 2, "audit trail survived persistence");
        assert_eq!(trail[0].decision, AccessDecision::Denied);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn load_from_missing_or_garbage_file_is_an_error() {
        let dir = std::env::temp_dir().join(format!("amos-privacy-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // Missing file → error (caller falls back to a fresh deny-by-default).
        let missing = dir.join("nope.json");
        assert!(PrivacyManager::load(&missing).is_err());

        // Garbage file → error.
        let garbage = dir.join("garbage.json");
        std::fs::write(&garbage, "{not json").unwrap();
        assert!(PrivacyManager::load(&garbage).is_err());

        // But an *empty-but-valid* state file (unknown keys only) loads to an
        // empty deny-by-default manager — unknown resources are dropped, never
        // fabricated into grants.
        let unknown = dir.join("unknown.json");
        std::fs::write(
            &unknown,
            r#"{"max_audit":8,"grants":{"a":["microphone","barometer","camera"]},"audit":[]}"#,
        )
        .unwrap();
        let p = PrivacyManager::load(&unknown).unwrap();
        assert!(p.is_granted("a", Resource::Microphone).await);
        assert!(p.is_granted("a", Resource::Camera).await);
        assert!(
            !p.is_granted("a", Resource::Location).await,
            "unknown key dropped"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn load_trims_oversized_audit_to_newest_max() {
        let dir = std::env::temp_dir().join(format!("amos-privacy-trim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("privacy.json");

        // Build a manager whose saved audit (5 records) exceeds the loaded cap.
        let p = PrivacyManager::new(64);
        for _ in 0..5 {
            p.authorize("a", Resource::Camera).await;
        }
        p.save(&path).await.unwrap();

        // The file stores max_audit=64, so loading keeps all 5… unless the file
        // itself says a smaller cap (simulate an older/smaller policy).
        let raw = std::fs::read_to_string(&path).unwrap();
        let trimmed = raw.replace("\"max_audit\": 64", "\"max_audit\": 2");
        std::fs::write(&path, trimmed).unwrap();

        let loaded = PrivacyManager::load(&path).unwrap();
        assert_eq!(
            loaded.recent_audit(10).await.len(),
            2,
            "audit trimmed to max_audit"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn authorize_decisions_mirror_to_durable_unified_sink() {
        use crate::audit::{AuditFile, Outcome};

        let dir = std::env::temp_dir().join(format!("amos-privacy-sink-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let audit_path = dir.join("audit.jsonl");

        // A manager whose every decision is mirrored to a durable unified sink.
        let sink = AuditFile::open(&audit_path, 16).unwrap();
        let p = PrivacyManager::with_audit_file(16, sink);
        p.grant("com.amos.phone", Resource::Microphone).await;
        p.authorize("com.amos.phone", Resource::Microphone).await; // granted
        p.authorize("com.amos.phone", Resource::Camera).await; // denied
        p.authorize("com.x", Resource::Location).await; // denied

        // The decisions were appended to the shared JSON-lines model on disk.
        let reopened = AuditFile::open(&audit_path, 16).unwrap();
        assert_eq!(
            reopened.count().await,
            3,
            "every decision mirrored to the sink"
        );
        let granted = reopened
            .recent_matching(
                10,
                Some("com.amos.phone"),
                Some("microphone"),
                Some(Outcome::Granted),
            )
            .await;
        assert_eq!(granted.len(), 1, "granted mic decision is in the sink");
        let denied = reopened
            .recent_matching(10, None, Some("camera"), Some(Outcome::Denied))
            .await;
        assert_eq!(denied.len(), 1, "denied camera decision is in the sink");

        // Builder form also works so a restarted manager keeps appending decisions
        // to the same durable sink.
        let p2 =
            PrivacyManager::new(4).with_durable_audit(AuditFile::open(&audit_path, 16).unwrap());
        p2.authorize("com.x", Resource::Storage).await; // denied → 4th line
        assert_eq!(
            AuditFile::open(&audit_path, 16).unwrap().count().await,
            4,
            "decision appended after re-attaching the durable sink"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
