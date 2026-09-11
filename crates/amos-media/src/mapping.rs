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

/// The lowercased extension after the final `.` of a name (path-aware).
///
/// Returns `None` for an extensionless name **and** for a dotfile (`.hidden`),
/// so a caller never treats a hidden file's stem as a type.
pub fn extension_of(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let dot = base.rfind('.')?;
    if dot == 0 || dot + 1 >= base.len() {
        return None;
    }
    Some(base[dot + 1..].to_ascii_lowercase())
}

/// Infer `(kind, MIME)` from a file name's extension — the inverse of
/// [`mime_for`].
///
/// A real file reaches a backend as little more than a name, so a provider that
/// derives the kind from the *containing collection* would report an `.mp3` in
/// `Music` as a generic `File` with no MIME (and an `.apk` in `Download` as a
/// plain file). Inferring from the name makes a real file honest about what it
/// is, for both the player and the Files screen. `None` (unknown/extensionless)
/// lets the caller keep its own default instead of being told a lie.
pub fn kind_and_mime_for_name(name: &str) -> Option<(MediaKind, &'static str)> {
    let ext = extension_of(name)?;
    let pair = match ext.as_str() {
        // ---- images ----
        "jpg" | "jpeg" => (MediaKind::Image, "image/jpeg"),
        "png" => (MediaKind::Image, "image/png"),
        "gif" => (MediaKind::Image, "image/gif"),
        "webp" => (MediaKind::Image, "image/webp"),
        "avif" => (MediaKind::Image, "image/avif"),
        "heic" => (MediaKind::Image, "image/heic"),
        "heif" => (MediaKind::Image, "image/heif"),
        "bmp" => (MediaKind::Image, "image/bmp"),
        "svg" => (MediaKind::Image, "image/svg+xml"),
        "tif" | "tiff" => (MediaKind::Image, "image/tiff"),
        "dng" => (MediaKind::Image, "image/x-adobe-dng"),
        // ---- video ----
        "mp4" | "m4v" => (MediaKind::Video, "video/mp4"),
        "mov" => (MediaKind::Video, "video/quicktime"),
        "webm" => (MediaKind::Video, "video/webm"),
        "mkv" => (MediaKind::Video, "video/x-matroska"),
        "avi" => (MediaKind::Video, "video/x-msvideo"),
        "3gp" => (MediaKind::Video, "video/3gpp"),
        "3g2" => (MediaKind::Video, "video/3gpp2"),
        "mpg" | "mpeg" => (MediaKind::Video, "video/mpeg"),
        "ts" => (MediaKind::Video, "video/mp2t"),
        "wmv" => (MediaKind::Video, "video/x-ms-wmv"),
        "ogv" => (MediaKind::Video, "video/ogg"),
        "flv" => (MediaKind::Video, "video/x-flv"),
        // ---- audio ----
        "mp3" => (MediaKind::Audio, "audio/mpeg"),
        "m4a" | "m4b" => (MediaKind::Audio, "audio/mp4"),
        "aac" => (MediaKind::Audio, "audio/aac"),
        "wav" => (MediaKind::Audio, "audio/wav"),
        "ogg" | "oga" | "opus" => (MediaKind::Audio, "audio/ogg"),
        "flac" => (MediaKind::Audio, "audio/flac"),
        "aif" | "aiff" => (MediaKind::Audio, "audio/aiff"),
        "amr" => (MediaKind::Audio, "audio/amr"),
        "weba" => (MediaKind::Audio, "audio/webm"),
        "mka" => (MediaKind::Audio, "audio/x-matroska"),
        "mid" | "midi" => (MediaKind::Audio, "audio/midi"),
        // ---- installable package ----
        "apk" => (
            MediaKind::Download,
            "application/vnd.android.package-archive",
        ),
        // ---- other user files (still typed, not "unknown") ----
        "pdf" => (MediaKind::File, "application/pdf"),
        "txt" | "log" | "md" => (MediaKind::File, "text/plain"),
        "json" => (MediaKind::File, "application/json"),
        "xml" => (MediaKind::File, "application/xml"),
        "csv" => (MediaKind::File, "text/csv"),
        "html" => (MediaKind::File, "text/html"),
        "zip" => (MediaKind::File, "application/zip"),
        _ => return None,
    };
    Some(pair)
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

    #[test]
    fn extension_of_is_path_aware_and_rejects_dotfiles() {
        assert_eq!(extension_of("a/b/c.MP3").as_deref(), Some("mp3"));
        assert_eq!(extension_of("a\\b\\c.MP4").as_deref(), Some("mp4"));
        assert_eq!(extension_of("noext"), None);
        assert_eq!(extension_of(".hidden"), None); // a dotfile has no type
        assert_eq!(extension_of("trailing."), None);
        assert_eq!(extension_of("dir.d/name"), None); // the dot belongs to the dir
    }

    #[test]
    fn kind_and_mime_infers_real_media_types() {
        // Names mirror the real files the acceptance probe generates.
        assert_eq!(
            kind_and_mime_for_name("晨光.mp3"),
            Some((MediaKind::Audio, "audio/mpeg"))
        );
        assert_eq!(
            kind_and_mime_for_name("星河.MP4"),
            Some((MediaKind::Video, "video/mp4"))
        );
        assert_eq!(
            kind_and_mime_for_name("IMG_0001.MOV"),
            Some((MediaKind::Video, "video/quicktime"))
        );
        assert_eq!(
            kind_and_mime_for_name("Voice_001.m4a"),
            Some((MediaKind::Audio, "audio/mp4"))
        );
        assert_eq!(
            kind_and_mime_for_name("song.flac"),
            Some((MediaKind::Audio, "audio/flac"))
        );
        assert_eq!(
            kind_and_mime_for_name("shot.png"),
            Some((MediaKind::Image, "image/png"))
        );
        assert_eq!(
            kind_and_mime_for_name("app.apk"),
            Some((
                MediaKind::Download,
                "application/vnd.android.package-archive"
            ))
        );
        assert_eq!(
            kind_and_mime_for_name("ReleaseNotes.pdf"),
            Some((MediaKind::File, "application/pdf"))
        );
    }

    #[test]
    fn kind_and_mime_is_none_for_unknown_or_extensionless() {
        for n in ["archive.xyz", "README", ".env", "a.", "noext"] {
            assert_eq!(kind_and_mime_for_name(n), None, "name: {n}");
        }
    }
}
