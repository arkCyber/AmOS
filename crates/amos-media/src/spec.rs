//! Spec types for the AmOS media / external-storage domain.
//!
//! These mirror the **user-visible Android file layout** (`/storage/emulated/0`)
//! so a "collection" is always a standard directory identity — never an
//! app-private blob. A [`MediaItem`] is addressed by an opaque `uri`
//! (`content://` on a real device; `mock://` in the deterministic mock), which
//! is what lets the seam swap between a host mock and an Android MediaStore
//! backend without leaking platform details to the UI.

use serde::{Deserialize, Serialize};

/// The standard, user-visible media collections of Android external storage.
///
/// [`StandardDir::canonical_path`] gives the informational relative path under
/// `/storage/emulated/0` — for logs/breadcrumbs, **not** raw reads (scoped
/// storage forbids those on Android 10+, see `docs/android-storage-unify.md` §2.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StandardDir {
    /// `/storage/emulated/0` root (only meaningful for a HostFs-style backend).
    Root,
    /// `DCIM/Camera` — native camera photos/videos.
    Camera,
    /// `Pictures/Screenshots` — screenshots / screen recordings.
    Screenshots,
    /// `Pictures` — app-saved images (WeiXin, browsers, …).
    Pictures,
    /// `Download` — user-downloaded files (PDF/APK/…).
    Download,
    /// `Recordings` — voice notes / recordings (Android 10+ collection).
    Recordings,
    /// `Movies` — user video collection.
    Movies,
    /// `Music` — user audio collection.
    Music,
}

impl StandardDir {
    /// Informational relative path under `/storage/emulated/0`.
    pub const fn canonical_path(self) -> &'static str {
        match self {
            StandardDir::Root => "",
            StandardDir::Camera => "DCIM/Camera",
            StandardDir::Screenshots => "Pictures/Screenshots",
            StandardDir::Pictures => "Pictures",
            StandardDir::Download => "Download",
            StandardDir::Recordings => "Recordings",
            StandardDir::Movies => "Movies",
            StandardDir::Music => "Music",
        }
    }

    /// The most natural [`MediaKind`] a well-behaved backend stores here.
    pub const fn default_kind(self) -> MediaKind {
        match self {
            StandardDir::Camera | StandardDir::Screenshots | StandardDir::Pictures => {
                MediaKind::Image
            }
            StandardDir::Recordings => MediaKind::Audio,
            StandardDir::Movies => MediaKind::Video,
            StandardDir::Download => MediaKind::File,
            StandardDir::Music | StandardDir::Root => MediaKind::File,
        }
    }

    /// Every known collection (for building permission UI / grant matrices).
    pub const fn all() -> &'static [StandardDir] {
        &[
            StandardDir::Root,
            StandardDir::Camera,
            StandardDir::Screenshots,
            StandardDir::Pictures,
            StandardDir::Download,
            StandardDir::Recordings,
            StandardDir::Movies,
            StandardDir::Music,
        ]
    }

    /// A stable, lowercase tag for this collection (matches the serde wire tag;
    /// the Kotlin `MediaStoreGlue` contract keys on it).
    pub const fn tag(self) -> &'static str {
        match self {
            StandardDir::Root => "root",
            StandardDir::Camera => "camera",
            StandardDir::Screenshots => "screenshots",
            StandardDir::Pictures => "pictures",
            StandardDir::Download => "download",
            StandardDir::Recordings => "recordings",
            StandardDir::Movies => "movies",
            StandardDir::Music => "music",
        }
    }
}

/// The high-level kind of a media item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Video,
    Audio,
    /// An arbitrary (non-media) user file, e.g. a downloaded PDF/APK.
    File,
    /// A downloaded, distributable package (APK and friends).
    Download,
}

impl MediaKind {
    /// Short lowercase tag (stable, for logs / serialization).
    pub const fn as_str(self) -> &'static str {
        match self {
            MediaKind::Image => "image",
            MediaKind::Video => "video",
            MediaKind::Audio => "audio",
            MediaKind::File => "file",
            MediaKind::Download => "download",
        }
    }
}

/// Direction of a storage access, used by the permission policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessKind {
    /// Listing / opening media already in a collection.
    Read,
    /// Adding AmOS-produced media into a collection.
    Write,
}

/// One concrete media file inside a collection. Fields are plain/stable so they
/// round-trip to the System UI (serde) and stay comparable in tests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaItem {
    /// Stable, backend-scoped id (for de-duping / favorites merge).
    pub id: String,
    pub kind: MediaKind,
    /// Which standard collection the item lives in.
    pub collection: StandardDir,
    /// Display / file name (no path separators).
    pub name: String,
    /// Opaque handle for opening the bytes (content:// or mock://).
    pub uri: String,
    /// MIME type when known (e.g. `image/jpeg`).
    pub mime: Option<String>,
    /// Size in bytes when known.
    pub size_bytes: Option<u64>,
    /// Last-modified epoch milliseconds (0 = unknown).
    pub ts: u64,
}

impl MediaItem {
    /// Build an item; validates `id`/`name`/`uri` are non-empty.
    pub fn new(
        id: String,
        kind: MediaKind,
        collection: StandardDir,
        name: String,
        uri: String,
        ts: u64,
    ) -> std::result::Result<MediaItem, String> {
        if id.is_empty() {
            return Err("media item id must not be empty".to_string());
        }
        if name.is_empty() {
            return Err("media item name must not be empty".to_string());
        }
        if uri.is_empty() {
            return Err("media item uri must not be empty".to_string());
        }
        Ok(MediaItem {
            id,
            kind,
            collection,
            name,
            uri,
            mime: None,
            size_bytes: None,
            ts,
        })
    }
}
