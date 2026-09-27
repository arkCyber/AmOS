//! End-to-end tests: run the **real pipeline** — text → MockEmbedder → vector →
//! `FlatIndex` (upsert on note edit) → snapshot to disk → reload → retrieval —
//! exactly the shape an `amos-ai` daemon will drive, but with no model server.
//!
//! The `MockEmbedder` is deliberately **not semantic** (it only makes the wiring
//! runnable offline), so retrieval assertions here never guess "similar text ⇒
//! nearest". Instead they query with an *already-stored* embedding, whose
//! self-similarity is 1.0 (the unique maximum) — that is geometry we control.
//!
//! These also lock the honest semantics a daemon relies on: re-indexing an
//! edited note replaces its old vector (no stale hits), a re-embed with a
//! *changed* dimension is rejected (never silently corrupting), and a missing
//! snapshot is an honest error (a caller chooses to start fresh).

use std::path::{Path, PathBuf};

use amos_vector_db::{Embedder, FlatIndex, Metric, MockEmbedder, Vector};

/// Unique, per-test temp file so parallel test binaries never collide.
fn unique_path(tag: &str) -> PathBuf {
    let pid = std::process::id();
    std::env::temp_dir().join(format!("amos-vdb-e2e-{pid}-{tag}.idx"))
}

/// The staging sibling `<path>.tmp` — spelled exactly as `save_to` builds it.
fn tmp_sibling(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".tmp");
    PathBuf::from(s)
}

/// Embed `text` and wrap it into a validated vector under `id`, returning the
/// vector so the same data can later be used as a guaranteed-top query.
fn embed_as(emb: &MockEmbedder, id: &str, text: &str) -> Vector {
    let data = emb.embed(text).expect("mock embed");
    Vector::new(id, data).expect("valid vector")
}

#[test]
fn full_pipeline_survives_restart_via_snapshot() {
    let emb = MockEmbedder::new(8).expect("dim");
    let a = embed_as(&emb, "note:a", "关于 q4 预算的会议记录");
    let b = embed_as(&emb, "note:b", "食堂菜单与通勤时间");
    let c = embed_as(&emb, "pdf:contract.pdf#p3", "甲乙双方技术保密条款");

    let mut idx = FlatIndex::new(emb.dim()).expect("index");
    idx.upsert(a.clone()).expect("add a");
    idx.upsert(b).expect("add b");
    idx.upsert(c).expect("add pdf");

    let path = unique_path("restart");
    idx.save_to(&path).expect("save");

    // A fresh process-equivalent: reload from disk.
    let loaded = FlatIndex::load_from(&path).expect("load");
    let _ = std::fs::remove_file(&path);
    assert_eq!(loaded.len(), 3);

    // Query with a's own stored embedding → self-similarity is the unique max.
    let hits = loaded.search(&a.data, Metric::Cosine, 1).expect("search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "note:a");
    assert!((hits[0].score - 1.0).abs() < 1e-5);
}

#[test]
fn editing_a_note_upserts_and_removes_stale_hit() {
    let emb = MockEmbedder::new(8).expect("dim");
    let original = embed_as(&emb, "note:todo", "买牛奶");
    let edited = embed_as(&emb, "note:todo", "明天十点开产品会");

    let mut idx = FlatIndex::new(emb.dim()).expect("index");
    idx.upsert(original).expect("add");
    idx.upsert(edited.clone()).expect("upsert edit");
    assert_eq!(idx.len(), 1, "an edit must not duplicate the row");

    // The *old* content is no longer in the index; the new content is.
    let old_query = embed_as(&emb, "q", "买牛奶");
    let old_hits = idx
        .search(&old_query.data, Metric::Cosine, 1)
        .expect("search");
    assert_eq!(old_hits.len(), 1);
    assert_eq!(old_hits[0].id, "note:todo"); // row exists, but…
    assert!(
        old_hits[0].score < 0.9999,
        "stale content must not match the old vector exactly"
    );

    let new_hits = idx.search(&edited.data, Metric::Cosine, 1).expect("search");
    assert_eq!(new_hits[0].id, "note:todo");
    assert!((new_hits[0].score - 1.0).abs() < 1e-5);
}

#[test]
fn deleting_a_note_removes_it_from_retrieval() {
    let emb = MockEmbedder::new(8).expect("dim");
    let mut idx = FlatIndex::new(emb.dim()).expect("index");
    idx.upsert(embed_as(&emb, "note:gone", "一段将被删除的旧内容"))
        .expect("add");
    idx.upsert(embed_as(&emb, "note:keep", "保留的内容"))
        .expect("add");
    assert!(idx.remove("note:gone"));
    assert_eq!(idx.len(), 1);
    assert!(!idx.contains("note:gone"));
}

#[test]
fn changing_embedder_dimension_is_rejected_not_silent() {
    let emb_a = MockEmbedder::new(4).expect("dim");
    let emb_b = MockEmbedder::new(8).expect("dim");
    let mut idx = FlatIndex::new(emb_a.dim()).expect("index");
    idx.upsert(embed_as(&emb_a, "note:x", "四维内容"))
        .expect("add");
    // A model swap that changes embedding dimension must not silently poison the
    // index: it is a hard error the daemon surfaces to the user.
    assert!(idx.upsert(embed_as(&emb_b, "note:y", "八维内容")).is_err());
}

#[test]
fn empty_snapshot_is_valid_empty_index() {
    let idx = FlatIndex::new(6).expect("index");
    let path = unique_path("empty");
    idx.save_to(&path).expect("save");
    let loaded = FlatIndex::load_from(&path).expect("load");
    let _ = std::fs::remove_file(&path);
    assert!(loaded.is_empty());
    assert_eq!(loaded.dim(), 6);
    assert!(loaded
        .search(&[0.0; 6], Metric::Cosine, 3)
        .expect("ok")
        .is_empty());
}

#[test]
fn missing_snapshot_file_is_an_io_error() {
    // An absent snapshot is an honest error, so a caller can choose to start
    // fresh — it is never silently invented as an "empty index" without saying so.
    let missing = std::env::temp_dir().join("amos-vdb-does-not-exist.idx");
    assert!(FlatIndex::load_from(&missing).is_err());
}

/// A reader that opened the snapshot **before** a save must still read the complete
/// **previous** snapshot afterwards.
///
/// `fs::write` truncates the file it is handed, so the old in-place `save_to` left
/// any such reader staring at the new (or half-written) bytes — a torn read of the
/// only copy of the index, which `load_bytes` would then reject wholesale. Replacing
/// it through a temp sibling and `rename` swaps the directory entry and leaves the old
/// inode, and its readers, untouched. A unit test cannot crash the process inside
/// `save_to`, but it can hold the file open across it (REQ-A1966 / F-AI-045, mirroring
/// `amos-tauri`'s `a_persist_leaves_an_open_reader_on_the_complete_previous_snapshot`).
#[test]
fn a_save_leaves_an_open_reader_on_the_complete_previous_snapshot() {
    use std::io::Read as _;

    let emb = MockEmbedder::new(8).expect("dim");
    let mut first = FlatIndex::new(emb.dim()).expect("index");
    first
        .upsert(embed_as(&emb, "note:a", "第一版内容"))
        .expect("add");

    let path = unique_path("atomic-open-reader");
    first.save_to(&path).expect("first save");
    let before = std::fs::read(&path).expect("read snapshot");

    // Pin the pre-write inode across the next save.
    let mut reader = std::fs::File::open(&path).expect("open reader");

    let mut second = FlatIndex::new(emb.dim()).expect("index");
    second
        .upsert(embed_as(&emb, "note:b", "第二版内容"))
        .expect("add");
    second.save_to(&path).expect("second save");

    let mut seen = Vec::new();
    reader.read_to_end(&mut seen).expect("read");
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        seen, before,
        "an in-place write truncates the file under the reader; an atomic replace does not"
    );
}

/// A save that cannot be staged must fail **and** leave the previous snapshot
/// byte-intact — never a half-written file, and never a silent success.
///
/// The staging sibling is occupied by a directory, so the temp write cannot complete.
/// The old in-place `save_to` never touched that sibling at all: it wrote `path`
/// directly, clobbering the good snapshot while reporting success.
#[test]
fn a_save_that_cannot_stage_leaves_the_previous_snapshot_intact() {
    let emb = MockEmbedder::new(8).expect("dim");
    let mut good = FlatIndex::new(emb.dim()).expect("index");
    for id in ["note:a", "note:b", "note:c"] {
        good.upsert(embed_as(&emb, id, id)).expect("add");
    }
    let path = unique_path("atomic-cannot-stage");
    good.save_to(&path).expect("save good");
    let before = std::fs::read(&path).expect("read snapshot");

    // Occupy the staging sibling with a directory so `fs::write(tmp)` must fail.
    let tmp = tmp_sibling(&path);
    let _ = std::fs::remove_file(&tmp);
    std::fs::create_dir(&tmp).expect("occupy tmp with a directory");

    let mut replacement = FlatIndex::new(emb.dim()).expect("index");
    replacement
        .upsert(embed_as(&emb, "note:new", "替换内容"))
        .expect("add");
    let result = replacement.save_to(&path);

    let after = std::fs::read(&path).expect("read snapshot");
    let reloaded = FlatIndex::load_from(&path).expect("the old snapshot still loads");
    let _ = std::fs::remove_dir(&tmp);
    let _ = std::fs::remove_file(&path);

    assert!(
        result.is_err(),
        "a save that cannot stage must report the failure, not answer Ok"
    );
    assert_eq!(
        after, before,
        "and the previous snapshot must survive it byte-for-byte"
    );
    assert_eq!(reloaded.len(), 3, "the previous three rows are still there");
}

/// Positive control for the atomic replace: the temp sibling is renamed onto the
/// target, so a normal re-save replaces the content and leaves no `.tmp` behind.
/// A fix that wrote the temp but forgot the `rename` would fail here (and would
/// leave the snapshot stale).
#[test]
fn a_save_over_an_existing_snapshot_replaces_it_and_leaves_no_temp() {
    let emb = MockEmbedder::new(8).expect("dim");
    let path = unique_path("atomic-no-tmp");

    let mut first = FlatIndex::new(emb.dim()).expect("index");
    first
        .upsert(embed_as(&emb, "note:a", "第一版"))
        .expect("add");
    first.save_to(&path).expect("first save");

    let mut second = FlatIndex::new(emb.dim()).expect("index");
    second
        .upsert(embed_as(&emb, "note:b", "第二版"))
        .expect("add");
    second.save_to(&path).expect("second save");

    let tmp = tmp_sibling(&path);
    let reloaded = FlatIndex::load_from(&path).expect("load");
    let _ = std::fs::remove_file(&path);
    assert_eq!(reloaded.len(), 1, "the renamed file is the new snapshot");
    assert!(reloaded.contains("note:b"), "the second save wins");
    assert!(!reloaded.contains("note:a"), "the first snapshot is gone");
    assert!(
        !tmp.exists(),
        "the temp file is renamed away, never left beside the snapshot"
    );
}
