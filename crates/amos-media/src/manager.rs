//! [`MediaManager`]: drives a [`MediaProvider`] and enforces the access policy.
//!
//! The provider is deliberately a dumb register (see [`crate::provider`]); the
//! policy that decides **which collections the System UI may read / write** lives
//! here, so it is unit-testable and identical across Mock and a future real
//! backend:
//!
//! * **Nothing is authorized by default.** The UI must obtain a [`Grant`] (read
//!   and/or write) per [`StandardDir`] first — mirroring Android's runtime
//!   `READ_MEDIA_*` model. Until granted, [`MediaManager::list`] returns
//!   [`MediaError::Unauthorized`] — **never** a silent empty list — so the UI can
//!   show a permission prompt instead of pretending the folder is empty.
//! * **Read and write are separate grants** (Android splits `READ_MEDIA_*` from
//!   "write your own contributions via MediaStore insert").
//! * **The manager validates arguments** (empty save names) before touching the
//!   provider; the provider enforces size ceilings.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::error::{MediaError, Result};
use crate::provider::MediaProvider;
use crate::spec::{AccessKind, MediaItem, MediaKind, StandardDir};

/// A single authorization: `access` on one `collection`.
///
/// This is the domain model of an Android runtime permission grant (a UI maps
/// `READ_MEDIA_IMAGES` → a read [`Grant`] over the image collections). serde so
/// grants can travel to/from the System UI over the Tauri bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Grant {
    pub access: AccessKind,
    pub collection: StandardDir,
}

impl Grant {
    /// Authorize reading `collection`.
    pub const fn read(collection: StandardDir) -> Self {
        Grant {
            access: AccessKind::Read,
            collection,
        }
    }

    /// Authorize writing into `collection`.
    pub const fn write(collection: StandardDir) -> Self {
        Grant {
            access: AccessKind::Write,
            collection,
        }
    }
}

/// A policy-owning handle over one [`MediaProvider`]. The provider is shared
/// (`Arc<dyn MediaProvider>`) so the System UI can hand the same backend to
/// several surfaces if needed.
pub struct MediaManager {
    provider: Arc<dyn MediaProvider>,
    grants: Mutex<Vec<Grant>>,
}

impl MediaManager {
    /// Wrap a provider with **no** grants (nothing is open by default).
    pub fn new(provider: Arc<dyn MediaProvider>) -> Self {
        Self {
            provider,
            grants: Mutex::new(Vec::new()),
        }
    }

    /// Wrap a provider with the given initial grants.
    pub fn with_grants(provider: Arc<dyn MediaProvider>, grants: Vec<Grant>) -> Self {
        let m = Self::new(provider);
        for g in grants {
            m.grant(g);
        }
        m
    }

    /// Name of the underlying backend.
    pub fn provider_name(&self) -> &'static str {
        self.provider.name()
    }

    /// Collections the underlying backend can serve (for building permission UI).
    pub fn available_collections(&self) -> Vec<StandardDir> {
        self.provider.available_collections()
    }

    /// Whether `access` on `collection` is currently authorized.
    pub fn is_granted(&self, access: AccessKind, collection: StandardDir) -> bool {
        self.grant_set()
            .iter()
            .any(|g| g.access == access && g.collection == collection)
    }

    /// Authorize `grant` (idempotent).
    pub fn grant(&self, grant: Grant) {
        let mut set = self.grant_set();
        if !set.contains(&grant) {
            set.push(grant);
        }
    }

    /// Convenience: authorize reading `collection`.
    pub fn grant_read(&self, collection: StandardDir) {
        self.grant(Grant::read(collection));
    }

    /// Convenience: authorize writing into `collection`.
    pub fn grant_write(&self, collection: StandardDir) {
        self.grant(Grant::write(collection));
    }

    /// Revoke `access` on `collection`.
    pub fn revoke(&self, access: AccessKind, collection: StandardDir) {
        let mut set = self.grant_set();
        set.retain(|g| !(g.access == access && g.collection == collection));
    }

    /// All current grants (for settings / privacy UI + serialization).
    pub fn grants(&self) -> Vec<Grant> {
        self.grant_set().clone()
    }

    /// List the media in `collection`, gated by the **read** grant.
    pub fn list(&self, collection: StandardDir) -> Result<Vec<MediaItem>> {
        if !self.is_granted(AccessKind::Read, collection) {
            return Err(MediaError::Unauthorized {
                access: AccessKind::Read,
                collection,
            });
        }
        self.provider.list(collection)
    }

    /// Persist `data` as `name` in `collection`, gated by the **write** grant.
    pub fn save(
        &self,
        collection: StandardDir,
        kind: MediaKind,
        name: &str,
        data: &[u8],
    ) -> Result<MediaItem> {
        if name.trim().is_empty() {
            return Err(MediaError::InvalidArguments(
                "cannot save media with an empty name".to_string(),
            ));
        }
        if !self.is_granted(AccessKind::Write, collection) {
            return Err(MediaError::Unauthorized {
                access: AccessKind::Write,
                collection,
            });
        }
        self.provider.save(collection, kind, name, data)
    }

    /// Read back the bytes of a previously-saved `item`, gated by the **read**
    /// grant on the item's collection.
    pub fn load(&self, item: &MediaItem) -> Result<Vec<u8>> {
        if !self.is_granted(AccessKind::Read, item.collection) {
            return Err(MediaError::Unauthorized {
                access: AccessKind::Read,
                collection: item.collection,
            });
        }
        self.provider.load(item)
    }

    /// Read at most `len` bytes from `offset`, gated by the same **read** grant.
    /// This is the streaming counterpart of [`MediaManager::load`]: it never
    /// materialises the whole item, so it is the correct primitive for large
    /// media (the policy is identical, so a denial is identical too).
    pub fn read_range(&self, item: &MediaItem, offset: u64, len: u64) -> Result<Vec<u8>> {
        if !self.is_granted(AccessKind::Read, item.collection) {
            return Err(MediaError::Unauthorized {
                access: AccessKind::Read,
                collection: item.collection,
            });
        }
        self.provider.read_range(item, offset, len)
    }

    /// Snapshot of the grant set (poison-safe lock).
    fn grant_set(&self) -> std::sync::MutexGuard<'_, Vec<Grant>> {
        self.grants.lock().unwrap_or_else(|p| p.into_inner())
    }
}
