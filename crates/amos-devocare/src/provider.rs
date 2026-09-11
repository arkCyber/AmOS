//! The [`CleanProvider`] seam — the **only** external touch point of this crate.
//!
//! The domain core never touches a filesystem. A caller supplies a provider (an
//! Android `MediaStore`/`PackageManager` backend on a device, a temp-dir host
//! backend in tests, or [`MockCleanProvider`] here) and the domain decides *what*
//! may be removed and reports *what actually happened*. Following the AmOS
//! convention (`amos-media::MediaProvider`), the seam is a dumb register: it
//! removes what it is told and fails honestly otherwise — it makes no safety
//! decisions, so a compromised backend cannot widen the policy.

use std::collections::{HashMap, HashSet};

use crate::error::{DevCareError, Result};
use crate::spec::JunkItem;

/// A backend that can delete one junk item.
pub trait CleanProvider {
    /// Attempt to remove one item. `Err` means "not removed" and is reported
    /// verbatim in the resulting [`crate::CleanFailure`].
    fn remove(&mut self, item: &JunkItem) -> Result<()>;
}

/// A deterministic, in-memory [`CleanProvider`] for tests, offline demos and CI.
///
/// * It only removes `uri`s it was constructed with (`existing`).
/// * A configured failure (`with_failure`) always wins, so "partial clean"
///   paths can be exercised without a real device.
/// * Removal is **not** idempotent: a second removal of the same `uri` fails
///   with an honest `Provider` error, mirroring a real backend.
#[derive(Debug, Default, Clone)]
pub struct MockCleanProvider {
    existing: HashSet<String>,
    failures: HashMap<String, String>,
    removed: Vec<JunkItem>,
}

impl MockCleanProvider {
    /// A mock holding exactly the given `uri`s.
    pub fn new(existing: impl IntoIterator<Item = String>) -> Self {
        Self {
            existing: existing.into_iter().collect(),
            failures: HashMap::new(),
            removed: Vec::new(),
        }
    }

    /// Configure a `uri` whose removal always fails with `message`.
    pub fn with_failure(mut self, uri: impl Into<String>, message: impl Into<String>) -> Self {
        self.failures.insert(uri.into(), message.into());
        self
    }

    /// Items this mock has confirmed removed, in removal order.
    pub fn removed(&self) -> &[JunkItem] {
        &self.removed
    }

    /// Whether a `uri` is still present in the mock storage.
    pub fn contains(&self, uri: &str) -> bool {
        self.existing.contains(uri)
    }
}

impl CleanProvider for MockCleanProvider {
    fn remove(&mut self, item: &JunkItem) -> Result<()> {
        if let Some(message) = self.failures.get(&item.uri) {
            return Err(DevCareError::Provider {
                uri: item.uri.clone(),
                message: message.clone(),
            });
        }
        if !self.existing.remove(&item.uri) {
            return Err(DevCareError::Provider {
                uri: item.uri.clone(),
                message: "not present in the mock storage".to_string(),
            });
        }
        self.removed.push(item.clone());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::JunkKind;

    fn item(uri: &str) -> JunkItem {
        JunkItem::new(uri, JunkKind::AppCache, 8)
    }

    #[test]
    fn removes_present_items_and_records_them() {
        let mut p = MockCleanProvider::new(["a".to_string(), "b".to_string()]);
        p.remove(&item("a")).expect("a is present");
        assert_eq!(p.removed().len(), 1);
        assert_eq!(p.removed()[0].uri, "a");
        assert!(!p.contains("a"));
        assert!(p.contains("b"));
    }

    #[test]
    fn removing_a_missing_uri_is_an_honest_error() {
        let mut p = MockCleanProvider::new(["a".to_string()]);
        let err = p.remove(&item("nope")).expect_err("missing uri must fail");
        match err {
            DevCareError::Provider { uri, .. } => assert_eq!(uri, "nope"),
            other => panic!("expected Provider, got {other:?}"),
        }
        assert!(p.removed().is_empty());
    }

    #[test]
    fn a_configured_failure_always_wins_and_is_never_recorded() {
        let mut p =
            MockCleanProvider::new(["a".to_string()]).with_failure("a", "permission denied");
        let err = p.remove(&item("a")).expect_err("configured failure");
        assert_eq!(err.to_string(), "provider failed for a: permission denied");
        assert!(p.removed().is_empty());
        // The item was not consumed by the failed attempt.
        assert!(p.contains("a"));
    }

    #[test]
    fn removal_is_not_idempotent() {
        let mut p = MockCleanProvider::new(["a".to_string()]);
        p.remove(&item("a")).expect("first removal succeeds");
        let err = p.remove(&item("a")).expect_err("second removal fails");
        assert_eq!(err.key(), "provider");
    }
}
