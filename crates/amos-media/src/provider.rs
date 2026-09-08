//! Provider seam and a deterministic mock.
//!
//! [`MediaProvider`] is the single point where the media domain core talks to
//! the platform's real storage (on a device: MediaStore / SAF, reached via the
//! Kotlin glue because Rust cannot touch `ContentResolver`). Like the
//! radio/sensor cores the provider is a deliberately **dumb register**: it
//! lists a collection and saves bytes into one. All *policy* lives in
//! [`crate::manager::MediaManager`]. Phase A ships a deterministic
//! [`MockMediaProvider`]; the real Android MediaStore backend replaces it behind
//! the `android` seam in a later phase (`docs/android-storage-unify.md` §6 C).

use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::{MediaError, Result};
use crate::spec::{MediaItem, MediaKind, StandardDir};

/// Upper bound on a single save accepted by any provider (guards against an
/// unbounded blob; MediaStore and scoped storage have similar caps).
pub const MAX_SAVE_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB

/// The external seam to the platform's media storage. Implementations must be
/// [`Send`] + [`Sync`]; methods are synchronous and single-shot, cheap to test.
pub trait MediaProvider: Send + Sync {
    /// A short human-readable backend name (for logs).
    fn name(&self) -> &'static str;

    /// Every standard collection this backend can serve.
    fn available_collections(&self) -> Vec<StandardDir>;

    /// List the media items in `dir`. An empty collection yields `Ok(vec![])`,
    /// **not** an error; errors are reserved for backend failure.
    fn list(&self, dir: StandardDir) -> Result<Vec<MediaItem>>;

    /// Persist `data` as `name` in `dir`; returns the created [`MediaItem`].
    /// The provider enforces [`MAX_SAVE_BYTES`]; the manager enforces policy.
    fn save(&self, dir: StandardDir, kind: MediaKind, name: &str, data: &[u8])
        -> Result<MediaItem>;

    /// Read back the bytes of a previously-saved `item` (identified by its opaque
    /// `uri`). Backends return bytes only for payloads they actually hold; an item
    /// with no stored content yields [`MediaError::Provider`] so the UI shows a
    /// thumbnail placeholder instead of pretending. The manager enforces the read
    /// grant.
    fn load(&self, item: &MediaItem) -> Result<Vec<u8>>;
}

/// All mutable state of a mock backend, behind one mutex so the instance is
/// shareable and a poisoned lock never panics the process.
struct MockState {
    items: Vec<MediaItem>,
    /// Bytes saved by [`save`](MediaProvider::save), keyed by item `uri`.
    blobs: HashMap<String, Vec<u8>>,
    /// Next suffix for generated ids (`mock-<seq>`), unique + ordered.
    seq: u64,
    /// Next mock timestamp (epoch ms), greater than any seeded item.
    next_ts: u64,
}

/// Deterministic, in-memory [`MediaProvider`] for tests, demos and CI.
///
/// Listing is a pure filter of the seed; saving appends a well-formed item with
/// deterministic `mock-<seq>` ids and a monotonic timestamp — the real call
/// shape, no I/O.
pub struct MockMediaProvider {
    state: Mutex<MockState>,
}

impl MockMediaProvider {
    /// A provider with no media yet.
    pub fn empty() -> Self {
        Self {
            state: Mutex::new(MockState {
                items: Vec::new(),
                blobs: HashMap::new(),
                seq: 0,
                next_ts: 1,
            }),
        }
    }

    /// A provider seeded with exactly `items`.
    pub fn from_items(items: Vec<MediaItem>) -> Self {
        let max_ts = items.iter().map(|i| i.ts).max().unwrap_or(0);
        Self {
            state: Mutex::new(MockState {
                items,
                blobs: HashMap::new(),
                seq: 0,
                next_ts: max_ts + 1,
            }),
        }
    }

    /// A realistic demo device seeded across the common collections, timestamped
    /// relative to `now` (epoch ms). Built directly (no fallible API), panic-free.
    pub fn seeded(now: u64) -> Self {
        fn mk(kind: MediaKind, coll: StandardDir, name: &str, offset: u64, now: u64) -> MediaItem {
            MediaItem {
                id: format!("mock-seed-{name}"),
                kind,
                collection: coll,
                name: name.to_string(),
                uri: format!("mock://{}/{}", coll.canonical_path(), name),
                mime: Some("application/octet-stream".to_string()),
                size_bytes: Some(2048),
                ts: now.saturating_sub(offset),
            }
        }
        let items = vec![
            mk(
                MediaKind::Image,
                StandardDir::Camera,
                "IMG_0001.jpg",
                3_600_000,
                now,
            ),
            mk(
                MediaKind::Image,
                StandardDir::Camera,
                "IMG_0002.jpg",
                86_400_000,
                now,
            ),
            mk(
                MediaKind::Image,
                StandardDir::Screenshots,
                "Screenshot_2026-01-01.png",
                172_800_000,
                now,
            ),
            mk(
                MediaKind::File,
                StandardDir::Download,
                "ReleaseNotes.pdf",
                259_200_000,
                now,
            ),
            mk(
                MediaKind::Audio,
                StandardDir::Recordings,
                "Voice_001.m4a",
                345_600_000,
                now,
            ),
        ];
        Self::from_items(items)
    }

    /// A tiny device with just one camera photo (fast, focused tests).
    pub fn single_photo(now: u64) -> Self {
        let items = vec![MediaItem {
            id: "mock-photo-1".to_string(),
            kind: MediaKind::Image,
            collection: StandardDir::Camera,
            name: "IMG_0001.jpg".to_string(),
            uri: "mock://DCIM/Camera/IMG_0001.jpg".to_string(),
            mime: Some("image/jpeg".to_string()),
            size_bytes: Some(2048),
            ts: now,
        }];
        Self::from_items(items)
    }

    /// Lock state, recovering from a poisoned mutex without panicking.
    fn lock_state(&self) -> std::sync::MutexGuard<'_, MockState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }
}
impl MediaProvider for MockMediaProvider {
    fn name(&self) -> &'static str {
        "mock"
    }

    fn available_collections(&self) -> Vec<StandardDir> {
        let state = self.lock_state();
        let mut out: Vec<StandardDir> = Vec::new();
        for item in &state.items {
            if !out.contains(&item.collection) {
                out.push(item.collection);
            }
        }
        out
    }

    fn list(&self, dir: StandardDir) -> Result<Vec<MediaItem>> {
        let state = self.lock_state();
        let mut items: Vec<MediaItem> = state
            .items
            .iter()
            .filter(|i| i.collection == dir)
            .cloned()
            .collect();
        drop(state);
        items.sort_by_key(|i| std::cmp::Reverse(i.ts));
        Ok(items)
    }

    fn save(
        &self,
        dir: StandardDir,
        kind: MediaKind,
        name: &str,
        data: &[u8],
    ) -> Result<MediaItem> {
        let name = name.trim();
        if name.is_empty() {
            return Err(MediaError::InvalidArguments(
                "cannot save media with an empty name".to_string(),
            ));
        }
        let len = data.len() as u64;
        if len > MAX_SAVE_BYTES {
            return Err(MediaError::TooLarge {
                bytes: len,
                max: MAX_SAVE_BYTES,
            });
        }
        let mut state = self.lock_state();
        let id = format!("mock-{}", state.seq);
        let ts = state.next_ts;
        state.seq += 1;
        state.next_ts += 1;
        let item = MediaItem {
            id: id.clone(),
            kind,
            collection: dir,
            name: name.to_string(),
            uri: format!("mock://{}/{name}", dir.canonical_path()),
            mime: None,
            size_bytes: Some(len),
            ts,
        };
        // Hold the payload so a later `load` can return the exact bytes.
        state.blobs.insert(item.uri.clone(), data.to_vec());
        state.items.push(item.clone());
        Ok(item)
    }

    fn load(&self, item: &MediaItem) -> Result<Vec<u8>> {
        let state = self.lock_state();
        match state.blobs.get(&item.uri) {
            Some(bytes) => Ok(bytes.clone()),
            // Honest: the mock only returns bytes it actually saved. Seeded /
            // demo items (sizes without content) yield a clear error so the UI
            // shows a placeholder instead of a fabricated "image".
            None => Err(MediaError::Provider(format!(
                "mock holds no content for uri `{}` (only saved payloads)",
                item.uri
            ))),
        }
    }
}
