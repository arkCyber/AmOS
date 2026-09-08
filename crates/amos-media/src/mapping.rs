//! Android platform mapping helpers (pure, host-testable).
//!
//! The Phase-C Android MediaStore backend and its Kotlin `MediaStoreGlue` share a
//! body of *deterministic* platform knowledge — which runtime permissions to ask
//! at each API level, what MIME a [`MediaKind`] maps to, and where each
//! [`StandardDir`] sits under external storage. Encoding that here (pure, no
//! JNI) lets it be unit-tested on host and reused by both the Rust backend and
//! the glue contract — mirroring how `docs/android-storage-unify.md` §7 keeps the
//! permission matrix in one place.
//!
//! See `crates/amos-tauri/android-glue/AndroidManifest.permissions.xml` for the
//! actual `<uses-permission>` fragment these strings must match.

use crate::spec::{AccessKind, MediaKind, StandardDir};

/// Android SDK API level used for testing / threshold logic (compile-time const).
pub const API_30: u32 = 30;
pub const API_33: u32 = 33;

/// Runtime permissions required to **read** shared media at `api` level.
///
/// * API 33+: granular `READ_MEDIA_*` (images/video/audio).
/// * API ≤32: legacy `READ_EXTERNAL_STORAGE`.
pub fn read_permissions(api: u32) -> &'static [&'static str] {
    if api >= API_33 {
        &[
            "android.permission.READ_MEDIA_IMAGES",
            "android.permission.READ_MEDIA_VIDEO",
            "android.permission.READ_MEDIA_AUDIO",
        ]
    } else {
        &["android.permission.READ_EXTERNAL_STORAGE"]
    }
}

/// Runtime permissions required to **write** AmOS-produced media at `api` level.
///
/// API 29+ writes to shared collections via `MediaStore.insert` need **no**
/// permission; only API ≤28 needs the legacy write permission.
pub fn write_permissions(api: u32) -> &'static [&'static str] {
    if api >= 29 {
        // API >= 29: MediaStore insert is permission-free.
        &[]
    } else {
        &["android.permission.WRITE_EXTERNAL_STORAGE"]
    }
}

/// Whether a MediaStore insert for `access` requires a runtime permission at `api`.
pub fn needs_permission(access: AccessKind, api: u32) -> bool {
    match access {
        AccessKind::Read => !read_permissions(api).is_empty(),
        AccessKind::Write => !write_permissions(api).is_empty(),
    }
}

/// The MIME type a [`MediaKind`] most naturally maps to when saving.
pub fn mime_for(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Image => "image/jpeg",
        MediaKind::Video => "video/mp4",
        MediaKind::Audio => "audio/mpeg",
        MediaKind::File => "application/octet-stream",
        MediaKind::Download => "application/vnd.android.package-archive",
    }
}

/// The external-storage **relative path** of a [`StandardDir`] under
/// `/storage/emulated/0` — the value a MediaStore `RELATIVE_PATH` / bucket query
/// uses (for `Root` this is the collection root). Pure alias of
/// [`StandardDir::canonical_path`] kept here so device glue uses one spelling.
pub fn relative_path(dir: StandardDir) -> &'static str {
    dir.canonical_path()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_permissions_follow_the_api_split() {
        assert!(read_permissions(34).contains(&"android.permission.READ_MEDIA_IMAGES"));
        assert!(read_permissions(API_33).contains(&"android.permission.READ_MEDIA_AUDIO"));
        assert!(!read_permissions(API_33).contains(&"android.permission.READ_EXTERNAL_STORAGE"));
        for api in [28, 29, 30, 32] {
            assert!(read_permissions(api).contains(&"android.permission.READ_EXTERNAL_STORAGE"));
        }
    }

    #[test]
    fn write_permissions_are_removed_from_api_29_up() {
        assert!(write_permissions(28).contains(&"android.permission.WRITE_EXTERNAL_STORAGE"));
        // API 29+ MediaStore insert needs no permission.
        assert!(write_permissions(29).is_empty());
        assert!(write_permissions(API_33).is_empty());
    }

    #[test]
    fn needs_permission_tracks_read_and_write_granularly() {
        // API 28: both read + write need a runtime permission.
        assert!(needs_permission(AccessKind::Read, 28));
        assert!(needs_permission(AccessKind::Write, 28));
        // API 33: read needs granular media, write needs none.
        assert!(needs_permission(AccessKind::Read, API_33));
        assert!(!needs_permission(AccessKind::Write, API_33));
    }

    #[test]
    fn mime_for_kind_is_stable() {
        assert_eq!(mime_for(MediaKind::Image), "image/jpeg");
        assert_eq!(
            mime_for(MediaKind::Download),
            "application/vnd.android.package-archive"
        );
        assert_eq!(mime_for(MediaKind::File), "application/octet-stream");
        assert_eq!(mime_for(MediaKind::Audio), "audio/mpeg");
    }

    #[test]
    fn relative_path_matches_android_layout() {
        assert_eq!(relative_path(StandardDir::Camera), "DCIM/Camera");
        assert_eq!(relative_path(StandardDir::Download), "Download");
        assert_eq!(relative_path(StandardDir::Root), "");
    }
}
