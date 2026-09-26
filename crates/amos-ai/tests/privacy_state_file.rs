//! The daemon's privacy-state file: what happens when `AMOS_PRIVACY_PATH` points
//! at a file that exists but cannot be read back (REQ-A1924 / F-AI-032).
//!
//! Own test binary/process on purpose: these cases drive the state path through
//! the real `AMOS_PRIVACY_PATH` seam, and a process-global environment variable
//! must not be mutated in the same process as the unit tests that read their own
//! variables in parallel (`privacy_audit_e2e.rs` and `devcare_audit_e2e.rs` make
//! the same choice).
//!
//! The defect: `bootstrap_with_sink` answered one `Err` for both "no file yet"
//! and "a file I cannot read or parse", started deny-by-default — and returned
//! the **same** path to the service, whose `persist_save` rewrites it after every
//! grant. So one corrupt file silently became an empty state file on the next
//! grant, with no copy left behind.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use amos_ai::audit::AuditFile;
use amos_ai::privacy::Resource;
use amos_ai::privacy_service::bootstrap_with_sink;

/// A fresh, empty directory, so a test can look for a sibling file beside the
/// state path (not just at the path itself).
fn tmp_dir(tag: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("amos-privacy-{tag}-{n}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The `*.corrupt-*` sibling the loader kept, matched on the file **name** so a
/// directory whose own name says "corrupt" cannot be mistaken for the copy.
fn corrupt_aside(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().contains("corrupt-"))
        })
}

/// Counts WARN events: a bootstrap has no caller to return an error to, so
/// tracing is the one channel that tells the operator what happened.
struct WarnProbe(Arc<AtomicU64>);
impl tracing::Subscriber for WarnProbe {
    fn enabled(&self, _m: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _s: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _id: &tracing::span::Id, _r: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _a: &tracing::span::Id, _b: &tracing::span::Id) {}
    fn event(&self, ev: &tracing::Event<'_>) {
        if ev.metadata().level() == &tracing::Level::WARN {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn enter(&self, _id: &tracing::span::Id) {}
    fn exit(&self, _id: &tracing::span::Id) {}
}

/// Bootstrap with `AMOS_PRIVACY_PATH` pointed at `path`. Guarded by the single
/// global serial lock this binary's tests share, since the variable is
/// process-wide.
fn bootstrap_at(path: &Path) -> (Arc<amos_ai::privacy::PrivacyManager>, Option<PathBuf>) {
    std::env::set_var("AMOS_PRIVACY_PATH", path);
    let out = bootstrap_with_sink(Some(AuditFile::memory(16)));
    std::env::remove_var("AMOS_PRIVACY_PATH");
    out
}

/// A grants file that exists but cannot be read back is **kept aside** before the
/// deny-by-default manager takes its place, because the service keeps this very
/// path live: without the aside, the next grant rewrites the file from scratch and
/// the operator's only copy of every granted app↔resource pair is gone.
#[tokio::test]
#[serial_test::serial]
async fn a_corrupt_privacy_state_is_kept_aside_before_the_next_save_overwrites_it() {
    let dir = tmp_dir("state-bad");
    let path = dir.join("privacy.json");
    let original: &[u8] = b"{ this is not the privacy state";
    std::fs::write(&path, original).unwrap();

    let warns = Arc::new(AtomicU64::new(0));
    let (manager, persist) = {
        let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
        bootstrap_at(&path)
    };

    assert_eq!(
        persist.as_deref(),
        Some(path.as_path()),
        "the service keeps this very path live, which is why the bytes must be moved"
    );
    assert_eq!(
        manager.granted("com.amos.phone").await,
        Vec::new(),
        "a corrupt file still starts deny-by-default"
    );
    assert_eq!(
        warns.load(Ordering::Relaxed),
        1,
        "the drop must be audible: bootstrap has no caller to return an error to"
    );

    let kept = corrupt_aside(&dir).expect("the unreadable state was kept beside the original");
    assert_eq!(
        std::fs::read(&kept).unwrap(),
        original,
        "the bytes the operator left behind survive byte-for-byte"
    );

    // The proof that matters: a later save writes over `path`, and the kept copy
    // is still there to be recovered.
    manager.grant("com.amos.phone", Resource::Microphone).await;
    manager.save(&path).await.unwrap();
    assert!(path.exists(), "the live path is rewritten with fresh state");
    assert_eq!(
        std::fs::read(&kept).unwrap(),
        original,
        "the aside is not the file a save touches"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// Disjoint control: a **missing** file is the ordinary first boot, not
/// corruption. There is nothing to keep aside, and nothing to report either.
#[tokio::test]
#[serial_test::serial]
async fn a_missing_privacy_state_keeps_nothing_aside_and_stays_silent() {
    let dir = tmp_dir("state-missing");
    let path = dir.join("privacy.json");

    let warns = Arc::new(AtomicU64::new(0));
    let (manager, persist) = {
        let _probe = tracing::subscriber::set_default(WarnProbe(warns.clone()));
        bootstrap_at(&path)
    };

    assert_eq!(
        persist.as_deref(),
        Some(path.as_path()),
        "an absent file is still the path the daemon will persist to"
    );
    assert_eq!(manager.granted("com.amos.phone").await, Vec::new());
    assert!(
        corrupt_aside(&dir).is_none(),
        "a missing file is not corruption; nothing is kept aside"
    );
    assert_eq!(
        warns.load(Ordering::Relaxed),
        0,
        "a missing state file is the ordinary first boot, not a warning"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
