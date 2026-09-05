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
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

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
}

impl PrivacyManager {
    /// A fresh manager (deny-by-default) keeping up to `max_audit` recent records.
    pub fn new(max_audit: usize) -> Self {
        Self {
            grants: Arc::new(RwLock::new(HashMap::new())),
            audit: Arc::new(RwLock::new(Vec::with_capacity(max_audit))),
            max_audit: max_audit.max(1),
        }
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
        let mut audit = self.audit.write().await;
        audit.push(entry);
        if audit.len() > self.max_audit {
            let drop = audit.len() - self.max_audit;
            audit.drain(0..drop);
        }
    }
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
}
