//! Atomic file writes.
//!
//! Two artifacts in this store are ones whose *partial* form is worse than no
//! file at all: the CLI's downloaded packages / exported indexes (a half-written
//! APK would be trusted by a later PackageInstaller hand-off) and the engine's
//! installed-apps registry, which [`AppStore::open`](crate::AppStore::open)
//! refuses once it is unparseable — so a torn write there breaks *every* later
//! command, not just one.
//!
//! A plain `fs::write` truncates the destination in place, leaving exactly that
//! window. [`write_atomic`] instead stages a sibling temp file, flushes it to
//! disk, then `rename`s it over the destination (atomic within one filesystem),
//! so a crash leaves either the previous file or nothing.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{Result, StoreError};

/// Monotonic per-process sequence for staging-file names.
///
/// The pid alone is **not** enough to make a staging file unique: two writers in
/// the same process (e.g. two `AppStore`s opened on the same registry path) would
/// share one temp file, and one could then `rename` the other's half-written
/// bytes into place. The counter makes every call's staging path its own.
static STAGING_SEQ: AtomicU64 = AtomicU64::new(0);

/// Write `bytes` to `path` atomically (see the module docs for why).
///
/// The temp file is staged in the **same directory** as `path`, which is what
/// makes the `rename` atomic; a cross-device rename would silently degrade to a
/// copy, so we never stage elsewhere (e.g. the system temp dir).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let file_name = path.file_name().ok_or_else(|| {
        StoreError::Provider(format!("{} has no file name to write", path.display()))
    })?;
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let tmp = dir.join(format!(
        ".{}.tmp.{}.{}",
        file_name.to_string_lossy(),
        std::process::id(),
        STAGING_SEQ.fetch_add(1, Ordering::Relaxed)
    ));

    let staged = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = staged {
        return Err(StoreError::Provider(format!(
            "write {}: {e}{}",
            tmp.display(),
            remove_tmp(&tmp)
        )));
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        return Err(StoreError::Provider(format!(
            "rename {} -> {}: {e}{}",
            tmp.display(),
            path.display(),
            remove_tmp(&tmp)
        )));
    }
    Ok(())
}

/// Best-effort removal of a staged temp file after [`write_atomic`] failed,
/// with the cleanup outcome **reported rather than discarded**: a temp file we
/// could not delete is exactly what the next run would have to puzzle over.
///
/// Returns `""` when nothing is left behind — including the case where
/// `File::create` never succeeded, where the honest answer is "there was never
/// anything to report", not a fabricated `left behind`.
fn remove_tmp(tmp: &Path) -> String {
    match std::fs::remove_file(tmp) {
        Ok(()) => String::new(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => format!(" (temp file {} left behind: {e})", tmp.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("amos-atomic-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_atomic_replaces_content_and_leaves_no_temp_files() {
        let dir = tmpdir("replace");
        let target = dir.join("registry.json");

        write_atomic(&target, b"first").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"first");

        // A second write replaces the content (rename over the old file).
        write_atomic(&target, b"second").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"second");

        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp."))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no staged temp may survive: {leftovers:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_writers_to_one_path_never_corrupt_it() {
        // Two writers in the same process must not share a staging file: with a
        // pid-only name they would, and one could rename the other's half-written
        // bytes into place (or fail spuriously). Payloads differ in *length* so a
        // mixed file cannot masquerade as a valid one.
        let dir = tmpdir("concurrent");
        let target = dir.join("registry.json");
        let a = vec![b'A'; 4096];
        let b = vec![b'B'; 16];

        let mut handles = Vec::new();
        for payload in [a.clone(), b.clone()] {
            let target = target.clone();
            handles.push(std::thread::spawn(move || {
                for _ in 0..200 {
                    write_atomic(&target, &payload).expect("every write must succeed");
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        let got = std::fs::read(&target).unwrap();
        assert!(
            got == a || got == b,
            "the destination must be exactly one payload, never a mix ({} bytes)",
            got.len()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_tmp_reports_only_a_real_leftover() {
        let dir = tmpdir("rmtmp");

        // A temp file that was never created is not a leftover — nothing to say.
        assert_eq!(remove_tmp(&dir.join("never-existed.tmp")), "");

        // A temp file that *was* created is removed, and silence is correct.
        let created = dir.join(".registry.json.tmp.1");
        std::fs::write(&created, b"partial").unwrap();
        assert_eq!(remove_tmp(&created), "");
        assert!(!created.exists(), "the temp file must actually be gone");

        // A path that cannot be removed (here: a non-empty directory) is reported:
        // silence would hide exactly the file the next run has to deal with.
        let stuck = dir.join(".registry.json.tmp.2");
        std::fs::create_dir_all(stuck.join("inside")).unwrap();
        let reported = remove_tmp(&stuck);
        assert!(
            reported.contains("left behind") && reported.contains("tmp.2"),
            "an undeletable temp path must be reported, got {reported:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
