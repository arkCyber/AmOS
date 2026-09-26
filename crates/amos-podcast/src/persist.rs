//! `persist.rs` — atomic JSON file I/O shared by the four stores
//! ([`crate::store`] / [`crate::library`] / [`crate::progress`] /
//! [`crate::download`]).
//!
//! Every store here is one whose *partial* form is worse than no file at all:
//! a half-written subscription list is a list the user's next command cannot
//! read, and it fails on **every** later command, not just one. A plain
//! `fs::write` truncates the destination in place, leaving exactly that window.
//! [`write_atomic`] stages a sibling temp file, flushes it, then `rename`s it
//! over the destination (atomic within one filesystem), so a crash leaves either
//! the previous file or nothing.
//!
//! Reading is deliberately forgiving: an absent file is the default value, and a
//! **corrupt** file is also the default value with a warning — but the caller is
//! told which happened via [`LoadOutcome`], because "no subscriptions yet" and
//! "your subscriptions were unreadable" are different sentences and only the
//! caller knows whether that difference matters on this screen.
//!
//! Those are three different events, not two, and the middle one is the one that
//! must not be acted on: a file we could **not read** ([`LoadOutcome::Unreadable`])
//! may still hold the user's own data, where a file we read and could not parse
//! ([`LoadOutcome::Corrupt`]) is already gone. Folding the first into the second
//! is what hands a caller an empty store over an intact file, whose next write
//! then replaces those bytes with the empty list it substituted (REQ-A1813 /
//! F-SH-899).

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{bounded_detail, PodcastError, Result};

static STAGING_SEQ: AtomicU64 = AtomicU64::new(0);

/// How a store's bytes were obtained on load.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadOutcome {
    /// The file existed and parsed.
    Loaded,
    /// The file did not exist (a first run) — not an error.
    Absent,
    /// The file existed but its bytes could **not be read** (permissions, IO, or
    /// an encoding `read_to_string` refuses). The default is in use, and the
    /// file's own bytes are still on disk — so a write must not be taken as
    /// "replace the malformed thing", because the thing was never read.
    Unreadable,
    /// The file was read, but its text is not the expected shape; the default is
    /// in use. Distinct from [`LoadOutcome::Unreadable`]: the bytes here are the
    /// ones we looked at, so replacing them loses only what was already
    /// unparseable.
    Corrupt,
    /// No path was configured, so the store is in memory only.
    Ephemeral,
}

/// Write `bytes` to `path` atomically: stage a sibling temp file, fsync it, then
/// `rename` over the destination.
///
/// The temp file lives in the **same directory** as `path` so the rename is
/// atomic on one filesystem; staging in the system temp dir would silently
/// degrade to a cross-device copy.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let file_name = path.file_name().ok_or_else(|| {
        PodcastError::StoreWriteFailed(format!("{} has no file name", path.display()))
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
        let _ = std::fs::remove_file(&tmp);
        return Err(PodcastError::StoreWriteFailed(bounded_detail(&format!(
            "write {}: {e}",
            tmp.display()
        ))));
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        PodcastError::StoreWriteFailed(bounded_detail(&format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            path.display()
        )))
    })
}

/// Read + parse `path`, reporting how it was obtained.
///
/// `T` must be `Default` so an absent, unreadable or corrupt file has a
/// well-defined value. A read error that is *not* "not found" (permissions, IO,
/// non-UTF-8 bytes) is reported as [`LoadOutcome::Unreadable`] rather than
/// silently folded into "first run" **or** into `Corrupt`: the user's data may
/// still be there, and a caller that reads `Corrupt` as "the file is garbage,
/// write over it" would destroy it.
pub fn load_json<T: DeserializeOwned + Default>(path: &Path) -> (T, LoadOutcome) {
    match std::fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (T::default(), LoadOutcome::Absent),
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "podcast store unreadable; using default");
            (T::default(), LoadOutcome::Unreadable)
        }
        Ok(text) => match serde_json::from_str::<T>(&text) {
            Ok(v) => (v, LoadOutcome::Loaded),
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "podcast store malformed; using default");
                (T::default(), LoadOutcome::Corrupt)
            }
        },
    }
}

/// Serialize + atomically write `value` to `path`.
pub fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| PodcastError::StoreWriteFailed(bounded_detail(&e.to_string())))?;
    write_atomic(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn tmpdir() -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "amos-podcast-persist-{}-{}",
            std::process::id(),
            STAGING_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn round_trips_a_map() {
        let dir = tmpdir();
        let path = dir.join("m.json");
        let mut m: BTreeMap<String, i64> = BTreeMap::new();
        m.insert("a".into(), 1);
        save_json(&path, &m).unwrap();
        let (got, outcome): (BTreeMap<String, i64>, _) = load_json(&path);
        assert_eq!(outcome, LoadOutcome::Loaded);
        assert_eq!(got, m);
    }

    #[test]
    fn an_absent_file_is_the_default_not_an_error() {
        let dir = tmpdir();
        let (got, outcome): (BTreeMap<String, i64>, _) = load_json(&dir.join("nope.json"));
        assert_eq!(outcome, LoadOutcome::Absent);
        assert!(got.is_empty());
    }

    #[test]
    fn a_corrupt_file_is_reported_and_defaulted() {
        let dir = tmpdir();
        let path = dir.join("bad.json");
        std::fs::write(&path, b"{not json").unwrap();
        let (got, outcome): (BTreeMap<String, i64>, _) = load_json(&path);
        assert_eq!(outcome, LoadOutcome::Corrupt);
        assert!(got.is_empty());
    }

    /// A file that is **present** but cannot be read as text (permissions, IO,
    /// invalid encoding) is a different event from one whose bytes *were* read
    /// and are the wrong shape. The first may still hold the user's own data, so
    /// it must not be reported as the same thing as the second — the module doc
    /// promises "your subscriptions were unreadable" as its own sentence, and
    /// folding it into `Corrupt` also tells the caller it is safe to replace the
    /// file with the default it just substituted.
    #[test]
    fn a_file_that_cannot_be_read_is_unreadable_not_corrupt() {
        let dir = tmpdir();
        let path = dir.join("bin.json");
        // Not valid UTF-8, so `read_to_string` fails with `InvalidData` — never
        // `NotFound`. The file is there and its bytes are still on disk.
        let original = vec![0x80u8, 0xff, 0x00, 0xfe];
        std::fs::write(&path, &original).unwrap();
        let (got, outcome): (BTreeMap<String, i64>, _) = load_json(&path);
        assert_eq!(outcome, LoadOutcome::Unreadable);
        assert!(got.is_empty());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            original,
            "a failed read must leave the bytes it could not parse alone"
        );
    }

    #[test]
    fn write_atomic_leaves_no_staging_file_behind() {
        let dir = tmpdir();
        let path = dir.join("x.json");
        save_json(&path, &vec![1, 2, 3]).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty());
    }
}
