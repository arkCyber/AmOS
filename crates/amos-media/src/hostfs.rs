//! A real-filesystem [`MediaProvider`] over a base directory.
//!
//! This is the **raw-path** channel reserved for deployments where the standard
//! Android layout is directly readable — a **root** device, an ADB-pushed
//! standalone binary, or Waydroid/Linux — NOT a normal Android app (scoped
//! storage forbids raw `read_dir` on `/storage/emulated/0/DCIM` since Android
//! 10; see `docs/android-storage-unify.md` §2.2). It reads real files: each
//! [`MediaItem`] carries the absolute path as its `uri`, its mtime as `ts`, and
//! its real size.
//!
//! This is also the function the architect's bring-up proposes (scan
//! `/storage/emulated/0/DCIM/Camera/` in a standalone Rust binary, pack
//! path/mtime/size as JSON to the Svelte 5 UI) — see the `scan_dir` example and
//! `docs/android-storage-unify.md` §6 E.
//!
//! It is deliberately **never** the desktop/CI default (that stays the
//! deterministic mock); you opt in by constructing it with an explicit base path.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{MediaError, Result};
use crate::provider::{MediaProvider, MAX_SAVE_BYTES};
use crate::spec::{MediaItem, MediaKind, StandardDir};

/// Map an [`std::io::Error`] into a [`MediaError::Provider`].
fn io_err(op: &str, e: std::io::Error) -> MediaError {
    MediaError::Provider(format!("hostfs {op} failed: {e}"))
}

/// A real-filesystem provider rooted at `base` (e.g. `/storage/emulated/0`).
pub struct HostFsProvider {
    base: PathBuf,
}

impl HostFsProvider {
    /// Root the provider at `base`. The standard collections are then resolved
    /// relative to it via [`StandardDir::canonical_path`] (`DCIM/Camera`, …).
    pub fn new(base: PathBuf) -> Self {
        Self { base }
    }

    /// The absolute path a `StandardDir` maps to under this base (`Root` → base).
    fn dir_path(&self, dir: StandardDir) -> PathBuf {
        self.base.join(dir.canonical_path())
    }

    /// A file entry's display name (strips any directory component).
    fn meta(entry: &fs::DirEntry) -> MediaItem {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = MediaKind::File;
        let meta = entry.metadata().ok();
        let ts = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let size_bytes = meta.map(|m| m.len());
        let uri = path.to_string_lossy().into_owned();
        MediaItem {
            id: uri.clone(),
            kind,
            collection: StandardDir::Root,
            name,
            uri,
            mime: None,
            size_bytes,
            ts,
        }
    }
}
impl MediaProvider for HostFsProvider {
    fn name(&self) -> &'static str {
        "hostfs"
    }

    fn available_collections(&self) -> Vec<StandardDir> {
        StandardDir::all()
            .iter()
            .copied()
            .filter(|d| self.dir_path(*d).is_dir())
            .collect()
    }

    fn list(&self, dir: StandardDir) -> Result<Vec<MediaItem>> {
        let path = self.dir_path(dir);
        let read = match fs::read_dir(&path) {
            Ok(r) => r,
            // An *absent* collection is empty, not an error…
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            // …but a real I/O failure (permission, IO) must NOT be swallowed as
            // an empty folder — that would lie to the UI / scan tool.
            Err(e) => return Err(io_err("list", e)),
        };
        let mut items: Vec<MediaItem> = Vec::new();
        for e in read {
            let entry = match e {
                Ok(e) => e,
                Err(_) => continue,
            };
            // Only regular files become media items — skip dirs, symlinks, and
            // special files (a symlink isn't a photo; don't misreport it).
            let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
            if !is_file {
                continue;
            }
            let mut item = Self::meta(&entry);
            item.collection = dir;
            item.kind = dir.default_kind();
            items.push(item);
        }
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
        let name = sanitize_name(name)
            .ok_or_else(|| MediaError::InvalidArguments("unsafe or empty file name".to_string()))?;
        // Enforce the shared save ceiling (same contract as Mock / MediaStore).
        let len = data.len() as u64;
        if len > MAX_SAVE_BYTES {
            return Err(MediaError::TooLarge {
                bytes: len,
                max: MAX_SAVE_BYTES,
            });
        }
        let dir_path = self.dir_path(dir);
        fs::create_dir_all(&dir_path).map_err(|e| io_err("mkdir", e))?;
        let full = dir_path.join(&name);
        fs::write(&full, data).map_err(|e| io_err("write", e))?;
        let ts = now_ms();
        let uri = full.to_string_lossy().into_owned();
        Ok(MediaItem {
            id: uri.clone(),
            kind,
            collection: dir,
            name,
            uri,
            mime: None,
            size_bytes: Some(len),
            ts,
        })
    }

    fn load(&self, item: &MediaItem) -> Result<Vec<u8>> {
        fs::read(&item.uri).map_err(|e| io_err("read", e))
    }
}

/// Epoch-ms now (0 on clock error).
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Reject anything that isn't a plain file name: empty, `.`, `..`, or containing a
/// path separator (so a caller can never traverse out of the collection).
fn sanitize_name(name: &str) -> Option<String> {
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    if name.contains('/') || name.contains('\\') {
        return None;
    }
    Some(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn tmp_base(tag: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("amos-media-hostfs-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn touch(p: &Path, bytes: &[u8]) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    #[test]
    fn lists_real_files_with_size_and_mtime() {
        let base = tmp_base("list");
        touch(&base.join("DCIM/Camera/IMG_1.jpg"), b"aaa");
        touch(&base.join("DCIM/Camera/IMG_2.jpg"), b"bbbb");
        touch(&base.join("Download/notes.pdf"), b"cccccc");
        let p = HostFsProvider::new(base.clone());
        let avail = p.available_collections();
        assert!(avail.contains(&StandardDir::Camera), "got {avail:?}");
        assert!(avail.contains(&StandardDir::Download));

        let cam = p.list(StandardDir::Camera).unwrap();
        assert_eq!(cam.len(), 2);
        for it in &cam {
            assert_eq!(it.collection, StandardDir::Camera);
            assert!(
                it.uri.starts_with(&base.to_string_lossy().into_owned()),
                "uri {}",
                it.uri
            );
            assert!(it.ts > 0, "mtime must be real");
            assert!(it.size_bytes.is_some());
            assert!(it.uri.ends_with(".jpg"));
        }
        // A dir with no files is empty, not an error.
        assert!(p.list(StandardDir::Music).unwrap().is_empty());
    }

    #[test]
    fn save_writes_a_real_file_and_load_reads_it_back() {
        let base = tmp_base("save");
        let p = HostFsProvider::new(base.clone());
        let saved = p
            .save(
                StandardDir::Camera,
                MediaKind::Image,
                "IMG_new.jpg",
                b"\xff\xd8",
            )
            .unwrap();
        let file = base.join("DCIM/Camera/IMG_new.jpg");
        assert!(file.is_file());
        assert_eq!(std::fs::read(&file).unwrap(), b"\xff\xd8");
        assert_eq!(p.load(&saved).unwrap(), b"\xff\xd8");
    }

    #[test]
    fn ignores_non_regular_entries_inside_a_collection() {
        let base = tmp_base("nonreg");
        touch(&base.join("DCIM/Camera/a.jpg"), b"a");
        // A nested folder must not be reported as a media file.
        touch(&base.join("DCIM/Camera/thumbs/t.jpg"), b"t");
        let p = HostFsProvider::new(base.clone());
        let cam = p.list(StandardDir::Camera).unwrap();
        assert_eq!(cam.len(), 1);
        assert_eq!(cam[0].name, "a.jpg");
    }

    #[test]
    fn hostfs_is_safely_shared_across_threads() {
        // The scan tool / System UI may read a collection from several threads at
        // once; read_dir + stat on the same provider must never panic or race.
        let base = tmp_base("concurrent");
        touch(&base.join("DCIM/Camera/a.jpg"), b"a");
        touch(&base.join("DCIM/Camera/b.jpg"), b"bb");
        let provider = std::sync::Arc::new(HostFsProvider::new(base.clone()));

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let p = std::sync::Arc::clone(&provider);
                std::thread::spawn(move || {
                    let items = p.list(StandardDir::Camera).expect("list must not fail");
                    assert_eq!(items.len(), 2);
                    assert!(items.iter().all(|i| i.collection == StandardDir::Camera));
                })
            })
            .collect();
        for h in handles {
            h.join().expect("worker thread must not panic");
        }
    }

    #[test]
    fn save_rejects_unsafe_names() {
        let p = HostFsProvider::new(tmp_base("unsafe"));
        assert!(p
            .save(StandardDir::Camera, MediaKind::Image, "../escape.jpg", b"x")
            .is_err());
        assert!(p
            .save(StandardDir::Camera, MediaKind::Image, "", b"x")
            .is_err());
        assert!(p
            .save(StandardDir::Camera, MediaKind::Image, "a/b.jpg", b"x")
            .is_err());
        // Nothing escaped.
        let escaped = p
            .dir_path(StandardDir::Camera)
            .parent()
            .unwrap()
            .join("escape.jpg");
        assert!(!escaped.exists());
    }

    #[test]
    fn save_rejects_oversized_payload_without_writing() {
        let p = HostFsProvider::new(tmp_base("big"));
        let huge = vec![0_u8; (MAX_SAVE_BYTES + 1) as usize];
        assert!(matches!(
            p.save(StandardDir::Camera, MediaKind::Image, "big.jpg", &huge),
            Err(MediaError::TooLarge { .. })
        ));
        // Nothing was created on disk.
        assert!(!p.dir_path(StandardDir::Camera).join("big.jpg").exists());
    }

    #[test]
    fn list_reports_a_real_io_error_instead_of_a_silent_empty() {
        // Base is a *file*, so `DCIM/…` resolution is a not-found → empty (fine).
        // Simulate an unreadable path portably: a base that is itself a file means
        // the Root collection read_dir fails with NotADirectory (real IO error),
        // which must surface as Err — never a fabricated empty list.
        let file = tmp_base("iobase").join("not_a_dir.txt");
        fs::write(&file, b"x").unwrap();
        let p = HostFsProvider::new(file.clone());
        assert!(p.list(StandardDir::Root).is_err());
    }
}
