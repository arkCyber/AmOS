//! External (black-box) tests for the `amos-media` domain core.
//!
//! These exercise only the **public API** (`amos_media::…`), matching how the
//! System UI will consume the crate, so a change to internals cannot silently
//! invalidate the contract. Coverage maps to the Phase-A acceptance criteria in
//! `docs/android-storage-unify.md` §6 and `docs/media.md`.

use std::sync::Arc;

use amos_media::{
    AccessKind, Grant, MediaError, MediaItem, MediaKind, MediaManager, MediaProvider,
    MockMediaProvider, StandardDir, MAX_SAVE_BYTES,
};

const NOW: u64 = 1_700_000_000_000;

// ---------- spec ----------

#[test]
fn canonical_paths_match_the_android_external_layout() {
    assert_eq!(StandardDir::Camera.canonical_path(), "DCIM/Camera");
    assert_eq!(
        StandardDir::Screenshots.canonical_path(),
        "Pictures/Screenshots"
    );
    assert_eq!(StandardDir::Download.canonical_path(), "Download");
    assert_eq!(StandardDir::Recordings.canonical_path(), "Recordings");
    assert_eq!(StandardDir::Movies.canonical_path(), "Movies");
    assert_eq!(StandardDir::Music.canonical_path(), "Music");
    assert_eq!(StandardDir::Root.canonical_path(), "");
}

#[test]
fn all_collections_are_known_and_kinds_map_sensibly() {
    assert_eq!(StandardDir::all().len(), 8);
    assert!(StandardDir::all().contains(&StandardDir::Camera));
    assert!(StandardDir::all().contains(&StandardDir::Download));
    assert_eq!(StandardDir::Camera.default_kind(), MediaKind::Image);
    assert_eq!(StandardDir::Recordings.default_kind(), MediaKind::Audio);
    assert_eq!(StandardDir::Movies.default_kind(), MediaKind::Video);
}

#[test]
fn media_kind_and_access_tag_are_stable() {
    assert_eq!(MediaKind::Image.as_str(), "image");
    assert_eq!(MediaKind::Download.as_str(), "download");
    assert_eq!(MediaKind::File.as_str(), "file");
    // serde round-trips (these travel to the System UI over the Tauri bridge).
    let k: MediaKind = serde_json::from_str("\"image\"").unwrap();
    assert_eq!(k, MediaKind::Image);
    let a: AccessKind = serde_json::from_str("\"read\"").unwrap();
    assert_eq!(a, AccessKind::Read);
}

#[test]
fn media_item_new_validates_and_round_trips() {
    let ok = MediaItem::new(
        "i".into(),
        MediaKind::Image,
        StandardDir::Camera,
        "a.jpg".into(),
        "mock://a.jpg".into(),
        1,
    );
    assert!(ok.is_ok());
    assert!(MediaItem::new(
        String::new(),
        MediaKind::Image,
        StandardDir::Camera,
        "a".into(),
        "u".into(),
        0
    )
    .is_err());
    assert!(MediaItem::new(
        "i".into(),
        MediaKind::Image,
        StandardDir::Camera,
        String::new(),
        "u".into(),
        0
    )
    .is_err());
    assert!(MediaItem::new(
        "i".into(),
        MediaKind::Image,
        StandardDir::Camera,
        "a".into(),
        String::new(),
        0
    )
    .is_err());
}

// ---------- provider ----------

#[test]
fn seeded_mock_is_deterministic_and_correctly_filtered() {
    let a = MockMediaProvider::seeded(NOW);
    let b = MockMediaProvider::seeded(NOW);

    assert_eq!(a.name(), "mock");
    let cam = a.list(StandardDir::Camera).unwrap();
    assert_eq!(cam.len(), 2);
    assert!(cam.iter().all(|i| i.collection == StandardDir::Camera));
    // Newest first.
    assert!(cam[0].ts >= cam[1].ts);

    // Two fresh instances produce identical lists (determinism).
    assert_eq!(cam, b.list(StandardDir::Camera).unwrap());

    // available_collections reflects exactly the seeded dirs.
    let avail = a.available_collections();
    assert!(avail.contains(&StandardDir::Camera));
    assert!(avail.contains(&StandardDir::Screenshots));
    assert!(!avail.contains(&StandardDir::Music));
}

#[test]
fn empty_collection_lists_empty_not_error() {
    let p = MockMediaProvider::single_photo(NOW);
    // Music is valid but unseeded → Ok([]), never an error.
    assert!(p.list(StandardDir::Music).unwrap().is_empty());
    assert!(MockMediaProvider::empty()
        .list(StandardDir::Camera)
        .unwrap()
        .is_empty());
}

#[test]
fn save_creates_well_formed_item_visible_to_later_list() {
    let p = MockMediaProvider::empty();
    let saved = p
        .save(
            StandardDir::Camera,
            MediaKind::Image,
            "IMG_new.jpg",
            &[1, 2, 3],
        )
        .unwrap();
    assert_eq!(saved.id, "mock-0");
    assert_eq!(saved.name, "IMG_new.jpg");
    assert_eq!(saved.collection, StandardDir::Camera);
    assert_eq!(saved.uri, "mock://DCIM/Camera/IMG_new.jpg");
    assert_eq!(saved.size_bytes, Some(3));

    let listed = p.list(StandardDir::Camera).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, "mock-0");

    // Second save gets a distinct, monotonic id/timestamp.
    let second = p
        .save(StandardDir::Download, MediaKind::File, "notes.txt", b"hi")
        .unwrap();
    assert_eq!(second.id, "mock-1");
    assert!(second.ts > saved.ts);
}

#[test]
fn save_rejects_empty_name_and_oversized_payload() {
    let p = MockMediaProvider::empty();
    assert!(matches!(
        p.save(StandardDir::Camera, MediaKind::Image, "   ", b"x"),
        Err(MediaError::InvalidArguments(_))
    ));
    let huge = vec![0_u8; (MAX_SAVE_BYTES + 1) as usize];
    assert!(matches!(
        p.save(StandardDir::Download, MediaKind::File, "big.bin", &huge),
        Err(MediaError::TooLarge { .. })
    ));
    // Nothing was persisted for the rejected write.
    assert!(p.list(StandardDir::Download).unwrap().is_empty());
}
#[test]
fn standard_dir_tags_are_stable_wire_tags() {
    use amos_media::StandardDir as D;
    assert_eq!(D::Camera.tag(), "camera");
    assert_eq!(D::Screenshots.tag(), "screenshots");
    assert_eq!(D::Download.tag(), "download");
    assert_eq!(D::Recordings.tag(), "recordings");
    assert_eq!(D::Root.tag(), "root");
    // All known dirs have a distinct, lowercase, stable tag (glue contract).
    let mut tags: Vec<&str> = StandardDir::all().iter().map(|d| d.tag()).collect();
    tags.sort_unstable();
    tags.dedup();
    assert_eq!(tags.len(), StandardDir::all().len());
}

// ---------- manager: permission policy ----------

fn seeded_manager() -> MediaManager {
    MediaManager::new(Arc::new(MockMediaProvider::seeded(NOW)))
}

#[test]
fn nothing_is_authorized_by_default() {
    let m = seeded_manager();
    // list on an ungranted collection is an honest Unauthorized — NOT empty.
    assert!(matches!(
        m.list(StandardDir::Camera),
        Err(MediaError::Unauthorized {
            access: AccessKind::Read,
            collection: StandardDir::Camera
        })
    ));
    // save on an ungranted collection is likewise rejected.
    assert!(matches!(
        m.save(StandardDir::Camera, MediaKind::Image, "x.jpg", b"x"),
        Err(MediaError::Unauthorized {
            access: AccessKind::Write,
            collection: StandardDir::Camera
        })
    ));
    assert!(m.grants().is_empty());
}

#[test]
fn read_grant_enables_list_but_not_write() {
    let m = seeded_manager();
    m.grant_read(StandardDir::Camera);
    assert!(m.is_granted(AccessKind::Read, StandardDir::Camera));
    assert!(!m.is_granted(AccessKind::Write, StandardDir::Camera));

    let items = m.list(StandardDir::Camera).unwrap();
    assert!(!items.is_empty());
    assert!(items.iter().all(|i| i.collection == StandardDir::Camera));

    // Read grant does NOT confer write.
    assert!(matches!(
        m.save(StandardDir::Camera, MediaKind::Image, "x.jpg", b"x"),
        Err(MediaError::Unauthorized {
            access: AccessKind::Write,
            ..
        })
    ));
}

#[test]
fn write_grant_enables_save_and_round_trips_through_list() {
    let m = seeded_manager();
    m.grant_read(StandardDir::Camera);
    m.grant_write(StandardDir::Camera);
    let saved = m
        .save(
            StandardDir::Camera,
            MediaKind::Image,
            "IMG_shot.jpg",
            b"\xff\xd8\xff",
        )
        .unwrap();
    assert_eq!(saved.name, "IMG_shot.jpg");
    assert!(m
        .list(StandardDir::Camera)
        .unwrap()
        .iter()
        .any(|i| i.id == saved.id));
}

#[test]
fn grants_are_per_collection_and_per_access() {
    let m = seeded_manager();
    m.grant_read(StandardDir::Camera);
    // An ungranted dir is still Unauthorized even though Camera is readable.
    assert!(matches!(
        m.list(StandardDir::Download),
        Err(MediaError::Unauthorized { .. })
    ));

    m.grant_read(StandardDir::Download);
    // Download is seeded with ReleaseNotes.pdf → now readable + non-empty.
    assert!(!m.list(StandardDir::Download).unwrap().is_empty());
    // …but Music is still unauthorized.
    assert!(matches!(
        m.list(StandardDir::Music),
        Err(MediaError::Unauthorized { .. })
    ));
}

#[test]
fn grant_is_idempotent_and_revocable() {
    let m = seeded_manager();
    m.grant_read(StandardDir::Camera);
    m.grant_read(StandardDir::Camera);
    m.grant_read(StandardDir::Camera);
    assert_eq!(
        m.grants()
            .iter()
            .filter(|g| g.collection == StandardDir::Camera)
            .count(),
        1
    );

    m.revoke(AccessKind::Read, StandardDir::Camera);
    assert!(!m.is_granted(AccessKind::Read, StandardDir::Camera));
    assert!(matches!(
        m.list(StandardDir::Camera),
        Err(MediaError::Unauthorized { .. })
    ));
}

#[test]
fn with_grants_starts_authorized() {
    let m = MediaManager::with_grants(
        Arc::new(MockMediaProvider::seeded(NOW)),
        vec![
            Grant::read(StandardDir::Camera),
            Grant::write(StandardDir::Camera),
        ],
    );
    assert!(!m.list(StandardDir::Camera).unwrap().is_empty());
    assert!(m
        .save(StandardDir::Camera, MediaKind::Image, "a.jpg", b"x")
        .is_ok());
}

#[test]
fn save_validates_empty_name_before_permission_is_consulted() {
    let m = seeded_manager();
    // Even with no grant, an empty name → InvalidArguments (deterministic arg
    // bugs surface before policy, never accidentally masked as Unauthorized).
    assert!(matches!(
        m.save(StandardDir::Camera, MediaKind::Image, "   ", b"x"),
        Err(MediaError::InvalidArguments(_))
    ));
}

#[test]
fn provider_errors_propagate_after_grant() {
    let m = seeded_manager();
    m.grant_write(StandardDir::Download);
    let huge = vec![0_u8; (MAX_SAVE_BYTES + 1) as usize];
    // Passes the manager write gate, then is rejected by the provider ceiling.
    assert!(matches!(
        m.save(StandardDir::Download, MediaKind::File, "big.bin", &huge),
        Err(MediaError::TooLarge { .. })
    ));
}

// ---------- load (read bytes) ----------

#[test]
fn load_returns_exactly_the_saved_bytes() {
    let p = MockMediaProvider::empty();
    let bytes = b"\xff\xd8\xff\xe0".to_vec();
    let saved = p
        .save(StandardDir::Camera, MediaKind::Image, "pic.jpg", &bytes)
        .unwrap();
    let got = p.load(&saved).unwrap();
    assert_eq!(got, bytes);
}

#[test]
fn load_of_a_seeded_item_without_content_is_an_honest_provider_error() {
    // Seeded/demo items carry a size but no bytes → load must NOT fabricate an
    // "image"; it returns a descriptive Provider error the UI maps to a glyph.
    let p = MockMediaProvider::seeded(NOW);
    let cam = p.list(StandardDir::Camera).unwrap();
    assert!(!cam.is_empty());
    let e = p.load(&cam[0]).unwrap_err();
    assert!(matches!(e, MediaError::Provider(msg) if msg.contains("holds no content")));
}

#[test]
fn manager_load_is_gated_by_the_read_grant() {
    let m = MediaManager::with_grants(
        Arc::new(MockMediaProvider::empty()),
        vec![Grant::write(StandardDir::Camera)],
    );
    let saved = m
        .save(StandardDir::Camera, MediaKind::Image, "a.jpg", b"abc")
        .unwrap();
    // Write granted but not read → load is Unauthorized.
    assert!(matches!(
        m.load(&saved),
        Err(MediaError::Unauthorized {
            access: AccessKind::Read,
            collection: StandardDir::Camera
        })
    ));
    m.grant_read(StandardDir::Camera);
    assert_eq!(m.load(&saved).unwrap(), b"abc".to_vec());
}

#[test]
fn provider_name_and_available_collections_pass_through() {
    let m = seeded_manager();
    assert_eq!(m.provider_name(), "mock");
    let avail = m.available_collections();
    assert!(avail.contains(&StandardDir::Camera));
    assert!(avail.contains(&StandardDir::Download));
}

// ---------- aerospace: concurrency / thread-safety ----------

#[test]
fn manager_is_safely_shared_across_threads_without_panic() {
    // The System UI / daemon may touch the manager from several threads; a
    // poisoned lock or data race here would surface as a panic / inconsistency.
    let manager = Arc::new(seeded_manager());
    manager.grant_read(StandardDir::Camera);

    let workers = 8;
    let handles: Vec<_> = (0..workers)
        .map(|_| {
            let m = Arc::clone(&manager);
            std::thread::spawn(move || {
                let items = m.list(StandardDir::Camera).expect("list must not fail");
                // Every thread sees the full, consistent set.
                assert_eq!(items.len(), 2);
                assert!(items.iter().all(|i| i.collection == StandardDir::Camera));
            })
        })
        .collect();
    for h in handles {
        h.join().expect("worker thread must not panic");
    }
}
