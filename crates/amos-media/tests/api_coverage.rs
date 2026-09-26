//! Explicit **per-function** API-coverage tests for the `amos-media` public
//! surface (aerospace: every exported constructor / method has a test pinning it).
//!
//! Existing behavioral tests in `media_core.rs` cover scenarios; this file makes
//! the *coverage contract* explicit — one test group per module, calling each
//! public function at least once. Private helpers are exercised through the
//! public API they serve. (JNI-only paths in `android.rs` are compile-verified
//! under `--features android` and exercised at device time — see docs.)

use std::sync::Arc;

use amos_media::{
    AccessKind, Grant, HostFsProvider, MediaError, MediaItem, MediaKind, MediaManager,
    MediaProvider, MockMediaProvider, StandardDir, MAX_SAVE_BYTES,
};

// ---------- spec :: StandardDir / MediaKind / MediaItem ----------

#[test]
fn spec_standard_dir_full_matrix() {
    let dirs = StandardDir::all();
    assert_eq!(dirs.len(), 8);
    // canonical_path, default_kind, tag — every variant, every function.
    for d in dirs {
        let _path: &'static str = d.canonical_path();
        let _kind = d.default_kind();
        let tag: &'static str = d.tag();
        assert!(!tag.is_empty());
    }
    assert_eq!(StandardDir::Camera.canonical_path(), "DCIM/Camera");
    assert_eq!(StandardDir::Root.canonical_path(), "");
}

#[test]
fn spec_media_kind_as_str_all_variants() {
    assert_eq!(MediaKind::Image.as_str(), "image");
    assert_eq!(MediaKind::Video.as_str(), "video");
    assert_eq!(MediaKind::Audio.as_str(), "audio");
    assert_eq!(MediaKind::File.as_str(), "file");
    assert_eq!(MediaKind::Download.as_str(), "download");
}

#[test]
fn spec_media_item_new_valid_and_rejections() {
    let ok = MediaItem::new(
        "id".into(),
        MediaKind::Image,
        StandardDir::Camera,
        "a.jpg".into(),
        "mock://a".into(),
        1,
    );
    assert!(ok.is_ok());
    for bad in [
        MediaItem::new(
            String::new(),
            MediaKind::Image,
            StandardDir::Camera,
            "a".into(),
            "u".into(),
            0,
        ),
        MediaItem::new(
            "id".into(),
            MediaKind::Image,
            StandardDir::Camera,
            String::new(),
            "u".into(),
            0,
        ),
        MediaItem::new(
            "id".into(),
            MediaKind::Image,
            StandardDir::Camera,
            "a".into(),
            String::new(),
            0,
        ),
    ] {
        assert!(bad.is_err());
    }
}

// ---------- provider :: constants + every Mock entry point ----------

#[test]
fn provider_max_save_bytes_constant() {
    assert_eq!(MAX_SAVE_BYTES, 64 * 1024 * 1024);
}

#[test]
fn provider_mock_all_constructors_and_trait_methods() {
    let empty = MockMediaProvider::empty();
    assert_eq!(empty.name(), "mock");
    assert!(empty.available_collections().is_empty());
    assert!(empty.list(StandardDir::Camera).unwrap().is_empty());

    let one = MockMediaProvider::single_photo(5);
    assert!(one.available_collections().contains(&StandardDir::Camera));
    let listed = one.list(StandardDir::Camera).unwrap();
    assert_eq!(listed.len(), 1);

    let from_items = MockMediaProvider::from_items(listed.clone());
    assert_eq!(from_items.list(StandardDir::Camera).unwrap(), listed);

    let seeded = MockMediaProvider::seeded(1);
    assert!(seeded
        .available_collections()
        .contains(&StandardDir::Download));

    // save + load (Mock's real-payload path).
    let saved = empty
        .save(
            StandardDir::Camera,
            MediaKind::Image,
            "shot.jpg",
            b"\xff\xd8",
        )
        .unwrap();
    assert_eq!(empty.load(&saved).unwrap(), b"\xff\xd8".to_vec());
    // load of a seeded (no-payload) item is an honest Provider error.
    let seeded_cam = seeded.list(StandardDir::Camera).unwrap();
    assert!(matches!(
        seeded.load(&seeded_cam[0]),
        Err(MediaError::Provider(_))
    ));
}

// ---------- manager :: Grant + every MediaManager method ----------

#[test]
fn manager_grant_helpers() {
    let r = Grant::read(StandardDir::Camera);
    assert_eq!(r.access, AccessKind::Read);
    assert_eq!(r.collection, StandardDir::Camera);
    let w = Grant::write(StandardDir::Download);
    assert_eq!(w.access, AccessKind::Write);
    assert_eq!(w.collection, StandardDir::Download);
}

fn manager_over(provider: Arc<dyn MediaProvider>) -> MediaManager {
    MediaManager::with_grants(
        provider,
        vec![
            Grant::read(StandardDir::Camera),
            Grant::write(StandardDir::Camera),
        ],
    )
}

#[test]
fn manager_every_public_method() {
    let m = manager_over(Arc::new(MockMediaProvider::seeded(1)));
    // provider_name / available_collections / is_granted / grants
    assert_eq!(m.provider_name(), "mock");
    assert!(m.available_collections().contains(&StandardDir::Camera));
    assert!(m.is_granted(AccessKind::Read, StandardDir::Camera));
    assert!(!m.is_granted(AccessKind::Write, StandardDir::Download));
    assert!(!m.grants().is_empty());

    // grant / grant_read / grant_write (idempotent)
    m.grant_read(StandardDir::Camera);
    m.grant_write(StandardDir::Download);
    m.grant(Grant::read(StandardDir::Camera));
    assert!(m.is_granted(AccessKind::Write, StandardDir::Download));

    // list / save / load
    let items = m.list(StandardDir::Camera).unwrap();
    assert!(!items.is_empty());
    let saved = m
        .save(StandardDir::Camera, MediaKind::Image, "x.jpg", b"abc")
        .unwrap();
    assert_eq!(m.load(&saved).unwrap(), b"abc".to_vec());

    // revoke
    m.revoke(AccessKind::Read, StandardDir::Camera);
    assert!(!m.is_granted(AccessKind::Read, StandardDir::Camera));
    assert!(matches!(
        m.list(StandardDir::Camera),
        Err(MediaError::Unauthorized { .. })
    ));

    // new() starts with nothing granted (honest), with_grants() seeds them.
    let fresh = MediaManager::new(Arc::new(MockMediaProvider::empty()));
    assert!(fresh.grants().is_empty());
}
// ---------- mapping :: every public fn + constants ----------

#[test]
fn mapping_every_public_function_and_constants() {
    use amos_media::mapping::{
        mime_for, needs_permission, read_permissions, relative_path, write_permissions, API_30,
        API_33,
    };
    assert_eq!(API_30, 30);
    assert_eq!(API_33, 33);

    for api in [28, 30, 32] {
        assert!(read_permissions(api).contains(&"android.permission.READ_EXTERNAL_STORAGE"));
    }
    assert!(read_permissions(API_33).contains(&"android.permission.READ_MEDIA_IMAGES"));

    assert!(write_permissions(28).contains(&"android.permission.WRITE_EXTERNAL_STORAGE"));
    assert!(write_permissions(29).is_empty());

    assert!(needs_permission(AccessKind::Read, 28));
    assert!(!needs_permission(AccessKind::Write, API_33));
    assert!(needs_permission(AccessKind::Read, API_33));

    assert_eq!(mime_for(MediaKind::Image), "image/jpeg");
    assert_eq!(mime_for(MediaKind::Video), "video/mp4");
    assert_eq!(mime_for(MediaKind::Audio), "audio/mpeg");
    assert_eq!(mime_for(MediaKind::File), "application/octet-stream");
    assert_eq!(
        mime_for(MediaKind::Download),
        "application/vnd.android.package-archive"
    );

    assert_eq!(relative_path(StandardDir::Camera), "DCIM/Camera");
    assert_eq!(relative_path(StandardDir::Download), "Download");
}

// ---------- hostfs :: every constructor + trait method (tempdir-backed) ----------

fn hostfs_base(tag: &str) -> std::path::PathBuf {
    let base = std::env::temp_dir().join(format!(
        "amos-api-coverage-hostfs-{tag}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("DCIM/Camera")).unwrap();
    std::fs::write(base.join("DCIM/Camera/real.jpg"), b"\xff\xd8").unwrap();
    base
}

#[test]
fn hostfs_every_method() {
    let base = hostfs_base("api");
    let p = HostFsProvider::new(base.clone());
    assert_eq!(p.name(), "hostfs");
    assert!(p.available_collections().contains(&StandardDir::Camera));

    let items = p.list(StandardDir::Camera).unwrap();
    assert_eq!(items.len(), 1);
    let it = &items[0];
    assert_eq!(it.name, "real.jpg");
    assert!(it.ts > 0);
    assert_eq!(p.load(it).unwrap(), b"\xff\xd8".to_vec());

    let saved = p
        .save(
            StandardDir::Camera,
            MediaKind::Image,
            "new.jpg",
            b"\x00\x01",
        )
        .unwrap();
    assert!(base.join("DCIM/Camera/new.jpg").is_file());
    assert_eq!(p.load(&saved).unwrap(), b"\x00\x01".to_vec());

    let _ = std::fs::remove_dir_all(&base);
}

// ---------- error :: MediaError display ----------

#[test]
fn error_media_error_display_variants() {
    let variants = [
        MediaError::Unauthorized {
            access: AccessKind::Read,
            collection: StandardDir::Camera,
        },
        MediaError::NotFound("x".into()),
        MediaError::TooLarge { bytes: 1, max: 2 },
        MediaError::InvalidArguments("x".into()),
        MediaError::Provider("x".into()),
    ];
    for e in variants {
        assert!(!e.to_string().is_empty(), "MediaError must be Display-able");
    }
}

// ---------- protocol :: the *crate-root* re-exports (the bridge's contract) ----------
//
// These call the symbols through the crate root (`amos_media::media_url`), which is the
// path an external consumer uses — **not** `amos_media::protocol::media_url`. The
// distinction is the whole test: `protocol.rs`'s own tests reach these functions through
// `super::*`, so a symbol silently dropped from the crate-root re-export list compiles
// green *inside this crate* and only breaks the downstream build (`amos-tauri`'s
// `media_stream_url`, REQ-A601). A re-export is a contract with other crates; this is the
// only place in this crate that exercises it.

#[test]
fn protocol_crate_root_reexports_the_url_round_trip() {
    assert_eq!(amos_media::base_url_for(false), "amos-media://");
    assert_eq!(amos_media::SCHEME, "amos-media");
    assert_eq!(amos_media::MAX_BODY_BYTES, amos_media::MAX_RANGE_BYTES);
    assert!(!amos_media::base_url().is_empty());

    // The emitter (what the bridge calls) and the parser are two halves of one grammar;
    // a URL the host hands out must read back as the same item.
    let url = amos_media::media_url(
        &amos_media::base_url_for(false),
        StandardDir::Camera,
        "clip.mp4",
    )
    .expect("a plain id is representable");
    assert_eq!(
        amos_media::parse_uri(&url),
        Ok((StandardDir::Camera, "clip.mp4".to_string()))
    );
}

#[test]
fn protocol_crate_root_reexports_serve() {
    let m = manager_over(Arc::new(MockMediaProvider::empty()));
    let saved = m
        .save(
            StandardDir::Camera,
            MediaKind::Image,
            "clip.mp4",
            b"\x00\x01\x02",
        )
        .unwrap();
    let url = amos_media::media_url(
        &amos_media::base_url_for(false),
        StandardDir::Camera,
        &saved.id,
    )
    .expect("a saved id is representable");

    let reply: amos_media::MediaReply = amos_media::serve(&m, &url, None);
    assert_eq!(reply.status, 200);
    assert_eq!(reply.bytes, b"\x00\x01\x02".to_vec());
    assert!(reply.accept_ranges, "a player will not seek without it");
}

// ---------- range :: the crate-root re-exports (both planners) ----------

#[test]
fn range_crate_root_reexports_both_planners() {
    // Length-known planner + its supporting helpers, all via the crate root.
    assert_eq!(
        amos_media::parse_range(None, 100),
        amos_media::RangeSpec::Full
    );
    assert_eq!(amos_media::window_len(0, 9), 10);
    assert_eq!(amos_media::clamp_window(0, 99, 10), (0, 9));
    assert_eq!(amos_media::status_for(amos_media::RangeSpec::Full), 200);
    assert_eq!(
        amos_media::window_for(amos_media::RangeSpec::Satisfiable { start: 2, end: 5 }, 100),
        Some((2, 5))
    );
    assert_eq!(amos_media::content_range(0, 9, 100), "bytes 0-9/100");
    assert_eq!(amos_media::content_range_unsatisfied(100), "bytes */100");
    assert_eq!(amos_media::MAX_RANGE_BYTES, 4 * 1024 * 1024);
    assert!(matches!(
        amos_media::plan_response(Some("bytes=0-9"), 100, 4),
        amos_media::ResponsePlan::Partial {
            start: 0,
            end: 3,
            total: 100
        }
    ));

    // The length-unknown planner (REQ-A599) must be reachable from the same root: the
    // two halves are useless apart, and a re-export that carries only one is the drift
    // this pair exists to prevent.
    assert_eq!(
        amos_media::plan_unknown(None, 4),
        amos_media::UnknownPlan::WholeOrTooLarge { probe: 5 }
    );
    assert_eq!(
        amos_media::plan_unknown(Some("bytes=-9"), 4),
        amos_media::UnknownPlan::NeedsLength
    );
    assert_eq!(
        amos_media::plan_unknown(Some("bytes=10-19"), 4),
        amos_media::UnknownPlan::Window { start: 10, len: 4 }
    );
    assert_eq!(amos_media::content_range_unknown(0, 3), "bytes 0-3/*");
}
