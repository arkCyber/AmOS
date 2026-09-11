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

/// Upper bound on a single whole-item [`MediaProvider::load`]. A huge file must
/// never trigger an unbounded allocation; callers that need a large item stream
/// it with [`MediaProvider::read_range`] instead. Symmetric with the save cap.
pub const MAX_LOAD_BYTES: u64 = 256 * 1024 * 1024; // 256 MiB

/// Enforce the whole-item load ceiling. Pure + total so every backend shares one
/// rule (and it is cheaply testable without allocating a huge buffer).
pub fn ensure_loadable(len: u64) -> Result<()> {
    if len > MAX_LOAD_BYTES {
        Err(MediaError::TooLarge {
            bytes: len,
            max: MAX_LOAD_BYTES,
        })
    } else {
        Ok(())
    }
}

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

    /// Read at most `len` bytes starting at `offset` (a backend may return fewer
    /// bytes than asked at the end of the item). This is the streaming primitive
    /// a range-capable HTTP layer serves from, so it must never allocate more than
    /// it returns. The default implementation slices a bounded [`load`], which is
    /// correct but loads the whole item — a provider with seekable storage (e.g.
    /// [`crate::hostfs::HostFsProvider`]) overrides it.
    ///
    /// [`load`]: MediaProvider::load
    fn read_range(&self, item: &MediaItem, offset: u64, len: u64) -> Result<Vec<u8>> {
        let all = self.load(item)?;
        let (start, end) = window(all.len() as u64, offset, len);
        // `get` (not indexing) so a degenerate window can never panic.
        Ok(all.get(start..end).map(<[u8]>::to_vec).unwrap_or_default())
    }
}

/// A byte window `[start, end)` clamped to `total` — the shared math of every
/// `read_range` implementation (total, no underflow, no out-of-bounds).
pub(crate) fn window(total: u64, offset: u64, len: u64) -> (usize, usize) {
    let start = offset.min(total) as usize;
    let end = offset.saturating_add(len).min(total) as usize;
    (start, end)
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
            Some(bytes) => {
                ensure_loadable(bytes.len() as u64)?;
                Ok(bytes.clone())
            }
            // Honest: the mock only returns bytes it actually saved. Seeded /
            // demo items (sizes without content) yield a clear error so the UI
            // shows a placeholder instead of a fabricated "image".
            None => Err(MediaError::Provider(format!(
                "mock holds no content for uri `{}` (only saved payloads)",
                item.uri
            ))),
        }
    }

    fn read_range(&self, item: &MediaItem, offset: u64, len: u64) -> Result<Vec<u8>> {
        let state = self.lock_state();
        match state.blobs.get(&item.uri) {
            Some(bytes) => {
                let (start, end) = window(bytes.len() as u64, offset, len);
                Ok(bytes
                    .get(start..end)
                    .map(<[u8]>::to_vec)
                    .unwrap_or_default())
            }
            None => Err(MediaError::Provider(format!(
                "mock holds no content for uri `{}` (only saved payloads)",
                item.uri
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A provider that implements only the required methods, so the **default**
    /// `read_range` (bounded load + slice) is exercised.
    struct WholeProvider(Vec<u8>);

    impl MediaProvider for WholeProvider {
        fn name(&self) -> &'static str {
            "whole"
        }
        fn available_collections(&self) -> Vec<StandardDir> {
            vec![StandardDir::Download]
        }
        fn list(&self, _dir: StandardDir) -> Result<Vec<MediaItem>> {
            Ok(Vec::new())
        }
        fn save(
            &self,
            _dir: StandardDir,
            _kind: MediaKind,
            _name: &str,
            _data: &[u8],
        ) -> Result<MediaItem> {
            Err(MediaError::Provider("read-only".to_string()))
        }
        fn load(&self, _item: &MediaItem) -> Result<Vec<u8>> {
            Ok(self.0.clone())
        }
    }

    fn item() -> MediaItem {
        MediaItem::new(
            "x".to_string(),
            MediaKind::File,
            StandardDir::Download,
            "a.bin".to_string(),
            "mock://Download/a.bin".to_string(),
            0,
        )
        .unwrap_or_else(|e| panic!("fixture: {e}"))
    }

    #[test]
    fn ensure_loadable_enforces_the_ceiling() {
        assert!(ensure_loadable(0).is_ok());
        assert!(ensure_loadable(MAX_LOAD_BYTES).is_ok());
        assert_eq!(
            ensure_loadable(MAX_LOAD_BYTES + 1),
            Err(MediaError::TooLarge {
                bytes: MAX_LOAD_BYTES + 1,
                max: MAX_LOAD_BYTES
            })
        );
    }

    #[test]
    fn window_is_total_and_clamped() {
        assert_eq!(window(10, 0, 3), (0, 3));
        assert_eq!(window(10, 8, 5), (8, 10)); // short read at EOF
        assert_eq!(window(10, 10, 5), (10, 10)); // at EOF → empty
        assert_eq!(window(10, 99, 5), (10, 10)); // past EOF → empty
        assert_eq!(window(0, 0, 5), (0, 0));
        assert_eq!(window(10, 0, 0), (0, 0));
        assert_eq!(window(5, u64::MAX, u64::MAX), (5, 5)); // no overflow/underflow
    }

    #[test]
    fn the_default_read_range_slices_the_loaded_bytes() {
        let p = WholeProvider(b"0123456789".to_vec());
        assert_eq!(p.read_range(&item(), 2, 3).unwrap(), b"234");
        assert_eq!(p.read_range(&item(), 0, 100).unwrap(), b"0123456789");
        assert_eq!(p.read_range(&item(), 9, 100).unwrap(), b"9");
        assert_eq!(p.read_range(&item(), 10, 1).unwrap(), b"");
        assert_eq!(p.read_range(&item(), 0, 0).unwrap(), b"");
    }

    #[test]
    fn mock_read_range_returns_windows_and_stays_honest() {
        let p = MockMediaProvider::empty();
        let it = p
            .save(
                StandardDir::Download,
                MediaKind::File,
                "a.bin",
                b"0123456789",
            )
            .unwrap_or_else(|e| panic!("save: {e}"));
        assert_eq!(p.read_range(&it, 2, 3).unwrap(), b"234");
        assert_eq!(p.read_range(&it, 0, 999).unwrap(), b"0123456789");
        assert_eq!(p.read_range(&it, 8, 100).unwrap(), b"89");
        assert_eq!(p.read_range(&it, 10, 5).unwrap(), b"");

        // A seeded item holds no bytes → an honest error, never a fake empty read.
        let seeded = MockMediaProvider::seeded(1);
        let mut list = seeded.list(StandardDir::Camera).unwrap();
        let item = match list.pop() {
            Some(i) => i,
            None => panic!("seeded camera item"),
        };
        assert!(seeded.read_range(&item, 0, 4).is_err());
    }
}
