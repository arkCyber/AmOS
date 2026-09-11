//! `hostfs` — the **one** explicit filesystem backend, confined to a configured
//! root.
//!
//! The rest of this crate is a pure, I/O-free kernel. This module is the
//! deliberate exception so a desktop host, a rooted device or a Waydroid/Linux
//! deployment can actually scan and reclaim without a MediaStore (cf.
//! `amos-media::HostFsProvider`, same rationale and same "never the default"
//! rule). It is only ever constructed with an explicit root.
//!
//! ```text
//!    root (= AMOS_DEVCARE_ROOT on the host, a cache/ dir on a device)
//!      ├── cache/…              → AppCache
//!      ├── thumbs/.thumbnails/… → Thumbnail
//!      ├── setup.apk            → ApkInstaller
//!      ├── app.log              → LogFile
//!      ├── edit.swp             → TempFile
//!      ├── crash.dmp            → CrashDump
//!      └── (empty dir)          → EmptyDir
//! ```
//!
//! # Two safety rules, both testable without a device
//!
//! 1. **Everything is confined to the root.** [`HostFsCleanProvider`] refuses any
//!    path that is not inside the canonicalized root ([`is_within`]), so a
//!    crafted plan or a hostile `uri` cannot reach the rest of the disk.
//! 2. **Only modelled junk is matched.** The scanner looks for exactly the
//!    [`JunkKind`] shapes above and never enumerates user media — a `.jpg`/`.mp4`
//!    under the root is *not junk* and is never returned.
//!
//! A scan additionally reports how many directories it could not read
//! ([`HostScan::unreadable_dirs`]) so a partial scan is never presented as a
//! complete one.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{DevCareError, Result};
use crate::provider::CleanProvider;
use crate::spec::{JunkItem, JunkKind, MAX_JUNK_ITEMS};

/// Maximum directory depth a scan descends (a bounded walk: no unbounded
/// recursion, no way to traverse a pathological tree).
pub const MAX_SCAN_DEPTH: usize = 12;

/// Directory names whose whole subtree is treated as rebuildable cache.
const CACHE_DIRS: &[&str] = &["cache", "code_cache", ".cache", "tmp", "temp"];
/// Directory names whose contents are regenerable thumbnails.
const THUMB_DIRS: &[&str] = &[".thumbnails", "thumbnails"];
/// Extensions of leftover installer payloads.
const APK_EXTS: &[&str] = &["apk", "apks", "xapk", "apkm"];
/// Extensions of temporary files.
const TEMP_EXTS: &[&str] = &["tmp", "temp", "swp", "swo"];
/// Extensions of crash dumps / heap profiles.
const CRASH_EXTS: &[&str] = &["dmp", "hprof"];

/// Whether `path` is inside `root`, after full canonicalization.
///
/// Canonicalizing BOTH sides is what makes `..` and symlinks unable to escape:
/// resolution happens first, then a component-wise prefix check. Any path that
/// cannot be canonicalized — including one that does not exist — is **not**
/// within the root (the safe default), so a caller needing a precise "not found"
/// must check containment on an existing ancestor (see
/// [`HostFsCleanProvider::remove`], which checks the parent).
pub fn is_within(root: &Path, path: &Path) -> bool {
    let (Ok(root), Ok(path)) = (root.canonicalize(), path.canonicalize()) else {
        return false;
    };
    path == root || path.starts_with(&root)
}

/// Whether `root` is a sane confinement root.
///
/// A bare filesystem root (`/`, `C:\`) is refused: pointing the cleaner at the
/// whole disk is never what an operator means, and it removes the containment
/// property that makes this module safe.
pub fn is_safe_root(root: &Path) -> bool {
    root.parent().is_some()
}

/// The result of a host scan.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostScan {
    /// The junk found, in the walk's deterministic depth-first order.
    pub items: Vec<JunkItem>,
    /// Directories skipped because they could not be listed (permissions, races).
    /// Non-zero means the scan is **partial**, and a caller should say so.
    pub unreadable_dirs: usize,
}

/// A real-filesystem scanner rooted at an explicit directory.
#[derive(Debug, Clone)]
pub struct HostFsScanner {
    root: PathBuf,
}

impl HostFsScanner {
    /// Root the scanner at `root` (e.g. an app cache dir or `AMOS_DEVCARE_ROOT`).
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Walk the root and return the modelled junk found.
    ///
    /// Refuses an unsafe (`/`) or non-existent root. Unreadable subtrees are
    /// counted in [`HostScan::unreadable_dirs`] rather than silently ignored, and
    /// a scan that would exceed [`MAX_JUNK_ITEMS`] is refused instead of
    /// truncating an input a destructive operation would later consume.
    pub fn scan(&self) -> Result<HostScan> {
        if !is_safe_root(&self.root) {
            return Err(DevCareError::Refused {
                uri: self.root.to_string_lossy().into_owned(),
                reason: "refusing to scan a bare filesystem root".to_string(),
            });
        }
        if self.root.canonicalize().is_err() {
            return Err(DevCareError::Refused {
                uri: self.root.to_string_lossy().into_owned(),
                reason: "root does not exist".to_string(),
            });
        }
        let mut out = HostScan::default();
        self.walk(&self.root, 0, false, false, &mut out)?;
        Ok(out)
    }

    fn walk(
        &self,
        dir: &Path,
        depth: usize,
        in_cache: bool,
        in_thumbs: bool,
        out: &mut HostScan,
    ) -> Result<()> {
        if depth > MAX_SCAN_DEPTH {
            return Ok(());
        }
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => {
                out.unreadable_dirs += 1;
                return Ok(());
            }
        };

        let mut children: Vec<PathBuf> = Vec::new();
        for entry in entries {
            match entry {
                Ok(e) => children.push(e.path()),
                Err(_) => out.unreadable_dirs += 1,
            }
        }

        // An empty directory is left-over junk — but never the root itself.
        if children.is_empty() {
            if depth > 0 {
                if let Some(uri) = path_string(dir) {
                    push(out, JunkItem::new(uri, JunkKind::EmptyDir, 0))?;
                }
            }
            return Ok(());
        }

        for child in children {
            // `symlink_metadata` does not follow links: a symlink reports neither
            // `is_dir` nor `is_file`, so it is skipped and can never be used to
            // walk outside the root.
            let meta = match fs::symlink_metadata(&child) {
                Ok(m) => m,
                Err(_) => {
                    out.unreadable_dirs += 1;
                    continue;
                }
            };

            if meta.is_dir() {
                let name = file_name_lower(&child);
                let child_cache = in_cache || CACHE_DIRS.contains(&name.as_str());
                let child_thumbs = in_thumbs || THUMB_DIRS.contains(&name.as_str());
                self.walk(&child, depth + 1, child_cache, child_thumbs, out)?;
                continue;
            }
            if !meta.is_file() {
                continue;
            }

            let kind = if in_thumbs {
                Some(JunkKind::Thumbnail)
            } else if in_cache {
                Some(JunkKind::AppCache)
            } else {
                classify_file(&child)
            };
            if let Some(kind) = kind {
                if let Some(uri) = path_string(&child) {
                    push(out, JunkItem::new(uri, kind, meta.len()))?;
                }
            }
        }
        Ok(())
    }
}

/// Append one item, enforcing the scan cap as we go (bounded memory).
fn push(out: &mut HostScan, item: JunkItem) -> Result<()> {
    if out.items.len() >= MAX_JUNK_ITEMS {
        return Err(DevCareError::TooManyItems {
            found: out.items.len() + 1,
            cap: MAX_JUNK_ITEMS,
        });
    }
    out.items.push(item);
    Ok(())
}

/// A UTF-8-addressable path — a non-UTF-8 path cannot be round-tripped to a
/// provider call, so it is skipped rather than lossily mangled.
fn path_string(p: &Path) -> Option<String> {
    p.to_str().map(str::to_string)
}

fn file_name_lower(p: &Path) -> String {
    p.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// Classify a file by its extension only (never by content sniffing).
fn classify_file(path: &Path) -> Option<JunkKind> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if APK_EXTS.contains(&ext.as_str()) {
        Some(JunkKind::ApkInstaller)
    } else if TEMP_EXTS.contains(&ext.as_str()) {
        Some(JunkKind::TempFile)
    } else if CRASH_EXTS.contains(&ext.as_str()) {
        Some(JunkKind::CrashDump)
    } else if ext == "log" {
        Some(JunkKind::LogFile)
    } else {
        None
    }
}

/// A real-filesystem [`CleanProvider`] confined to an explicit root.
///
/// Refuses any `uri` that is not inside the canonicalized root, and removes a
/// directory only via `remove_dir` (so a non-empty directory fails honestly
/// instead of being recursively deleted — the scanner only ever plans empty
/// ones, and this is defence in depth).
#[derive(Debug, Clone)]
pub struct HostFsCleanProvider {
    root: PathBuf,
}

impl HostFsCleanProvider {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl CleanProvider for HostFsCleanProvider {
    fn remove(&mut self, item: &JunkItem) -> Result<()> {
        let path = Path::new(&item.uri);
        // Containment is checked on the PARENT directory. The parent must exist
        // for a real entry, so this both (a) resolves symlinks/`..` before the
        // check and (b) lets a genuinely missing file be reported as an honest
        // "not found" instead of being misattributed to a containment failure.
        let Some(parent) = path.parent() else {
            return Err(DevCareError::Refused {
                uri: item.uri.clone(),
                reason: "no parent directory".to_string(),
            });
        };
        if !is_within(&self.root, parent) {
            return Err(DevCareError::Refused {
                uri: item.uri.clone(),
                reason: "outside the configured root".to_string(),
            });
        }
        // `symlink_metadata` does not follow links: removing a symlink deletes the
        // link itself, never its target.
        let meta = fs::symlink_metadata(path).map_err(|e| DevCareError::Provider {
            uri: item.uri.clone(),
            message: e.to_string(),
        })?;
        let result = if meta.is_dir() {
            // `remove_dir` (never `remove_dir_all`): a non-empty directory fails
            // honestly instead of being recursively deleted.
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
        };
        result.map_err(|e| DevCareError::Provider {
            uri: item.uri.clone(),
            message: e.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{analyze, execute, plan, CleanRequest};
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A self-cleaning temp directory (no external tempdir dependency).
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("amos-devocare-{}-{}", std::process::id(), n));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create temp root");
            TempRoot(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn file(&self, rel: &str, bytes: usize) -> PathBuf {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().expect("parent")).expect("mkdir");
            fs::write(&p, vec![0u8; bytes]).expect("write");
            p
        }

        fn dir(&self, rel: &str) -> PathBuf {
            let p = self.0.join(rel);
            fs::create_dir_all(&p).expect("mkdir");
            p
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn kinds(scan: &HostScan) -> Vec<JunkKind> {
        let mut ks: Vec<JunkKind> = scan.items.iter().map(|i| i.kind).collect();
        ks.sort();
        ks.dedup();
        ks
    }

    #[test]
    fn scan_finds_the_modelled_shapes_and_never_user_media() {
        let t = TempRoot::new();
        t.file("cache/blob.bin", 10);
        t.file("thumbs/.thumbnails/t1.png", 20);
        t.file("setup.apk", 30);
        t.file("app.log", 40);
        t.file("edit.swp", 50);
        t.file("crash.dmp", 60);
        t.dir("left-over-empty");
        // User media must never be classified as junk.
        t.file("holiday.jpg", 7);
        t.file("clip.mp4", 7);
        t.file("report.pdf", 7);

        let scan = HostFsScanner::new(t.path()).scan().expect("scan ok");
        assert_eq!(scan.unreadable_dirs, 0);
        let found = kinds(&scan);

        assert!(found.contains(&JunkKind::AppCache));
        assert!(found.contains(&JunkKind::Thumbnail));
        assert!(found.contains(&JunkKind::ApkInstaller));
        assert!(found.contains(&JunkKind::LogFile));
        assert!(found.contains(&JunkKind::TempFile));
        assert!(found.contains(&JunkKind::CrashDump));
        assert!(found.contains(&JunkKind::EmptyDir));

        // Hard safety assertion: no user media anywhere in the scan.
        for item in &scan.items {
            for banned in [".jpg", ".mp4", ".pdf"] {
                assert!(!item.uri.ends_with(banned), "leaked {banned}: {}", item.uri);
            }
        }
    }

    #[test]
    fn scan_reports_real_sizes() {
        let t = TempRoot::new();
        let apk = t.file("big.apk", 1234);
        let scan = HostFsScanner::new(t.path()).scan().expect("scan ok");
        let item = scan
            .items
            .iter()
            .find(|i| i.uri == apk.to_str().expect("utf8 path"))
            .expect("apk found");
        assert_eq!(item.kind, JunkKind::ApkInstaller);
        assert_eq!(item.size_bytes, 1234);
    }

    #[test]
    fn scan_refuses_a_bare_filesystem_root() {
        let err = HostFsScanner::new("/")
            .scan()
            .expect_err("bare root refused");
        assert_eq!(err.key(), "refused");
    }

    #[test]
    fn scan_refuses_a_root_that_does_not_exist() {
        let missing = std::env::temp_dir().join("amos-devocare-does-not-exist-xyz");
        let err = HostFsScanner::new(&missing)
            .scan()
            .expect_err("missing root refused");
        assert_eq!(
            err.to_string(),
            format!(
                "refusing to touch {}: root does not exist",
                missing.display()
            )
        );
    }

    #[test]
    fn scan_is_depth_bounded() {
        let t = TempRoot::new();
        // A log buried deeper than MAX_SCAN_DEPTH must NOT be reached.
        let mut deep = t.path().to_path_buf();
        for i in 0..MAX_SCAN_DEPTH + 2 {
            deep = deep.join(format!("d{i}"));
        }
        fs::create_dir_all(&deep).expect("mkdir deep");
        fs::write(deep.join("buried.log"), b"x").expect("write deep log");

        let scan = HostFsScanner::new(t.path()).scan().expect("scan ok");
        assert!(
            scan.items.iter().all(|i| !i.uri.ends_with("buried.log")),
            "the bounded walk must not reach beyond MAX_SCAN_DEPTH"
        );
    }

    #[test]
    fn is_within_rejects_prefix_neighbours_and_accepts_real_children() {
        let t = TempRoot::new();
        let inside = t.file("a.txt", 1);
        let root_canon = t.path().canonicalize().expect("canonical root");
        t.dir("sub"); // exists, so `sub/..` can be resolved
        assert!(is_within(t.path(), &inside));
        // `..` that lands back inside is still inside (resolved before the check).
        assert!(is_within(t.path(), &root_canon.join("sub/../a.txt")));
        // A sibling whose name shares the prefix is NOT inside.
        let sibling = PathBuf::from(format!("{}-sibling", root_canon.display()));
        assert!(!is_within(t.path(), &sibling));
        // A non-existent path is not inside (safe default).
        assert!(!is_within(t.path(), &root_canon.join("nope.txt")));
    }

    #[test]
    fn provider_removes_files_and_empty_dirs_inside_the_root() {
        let t = TempRoot::new();
        let f = t.file("x.tmp", 5);
        let empty = t.dir("gone");
        let mut p = HostFsCleanProvider::new(t.path());

        p.remove(&JunkItem::new(
            f.to_string_lossy().to_string(),
            JunkKind::TempFile,
            5,
        ))
        .expect("file removed");
        assert!(!f.exists());

        p.remove(&JunkItem::new(
            empty.to_string_lossy().to_string(),
            JunkKind::EmptyDir,
            0,
        ))
        .expect("empty dir removed");
        assert!(!empty.exists());
    }

    #[test]
    fn provider_refuses_a_path_outside_the_root() {
        let t = TempRoot::new();
        let outside = TempRoot::new();
        let victim = outside.file("keep.txt", 3);
        let mut p = HostFsCleanProvider::new(t.path());
        let err = p
            .remove(&JunkItem::new(
                victim.to_string_lossy().to_string(),
                JunkKind::TempFile,
                3,
            ))
            .expect_err("outside root must be refused");
        assert_eq!(err.key(), "refused");
        assert!(victim.exists(), "the outside file must survive");
    }

    #[test]
    fn provider_refuses_a_missing_file_and_a_non_empty_directory() {
        let t = TempRoot::new();
        let mut p = HostFsCleanProvider::new(t.path());
        let missing = t.path().join("nope.tmp");
        let err = p
            .remove(&JunkItem::new(
                missing.to_string_lossy().to_string(),
                JunkKind::TempFile,
                1,
            ))
            .expect_err("missing file is an honest error");
        assert_eq!(err.key(), "provider");

        // A non-empty directory must not be recursively deleted.
        let dir = t.dir("full");
        fs::write(dir.join("inner.txt"), b"x").expect("write inner");
        let err = p
            .remove(&JunkItem::new(
                dir.to_string_lossy().to_string(),
                JunkKind::EmptyDir,
                0,
            ))
            .expect_err("non-empty dir must fail");
        assert_eq!(err.key(), "provider");
        assert!(dir.exists());
    }

    #[cfg(unix)]
    #[test]
    fn scan_does_not_follow_symlinks_out_of_the_root() {
        let t = TempRoot::new();
        let outside = TempRoot::new();
        outside.file("secret.apk", 9);
        std::os::unix::fs::symlink(outside.path(), t.path().join("link")).expect("symlink");

        let scan = HostFsScanner::new(t.path()).scan().expect("scan ok");
        assert!(
            scan.items.iter().all(|i| !i.uri.contains("secret.apk")),
            "a symlinked dir must not be traversed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn removing_a_symlink_deletes_the_link_not_its_target() {
        let t = TempRoot::new();
        let outside = TempRoot::new();
        let target = outside.file("precious.dat", 4);
        let link = t.path().join("trap.tmp");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");

        let mut p = HostFsCleanProvider::new(t.path());
        p.remove(&JunkItem::new(
            link.to_string_lossy().to_string(),
            JunkKind::TempFile,
            4,
        ))
        .expect("the link is removed");

        assert!(!link.exists(), "the link itself is gone");
        assert!(target.exists(), "the symlink target must survive");
    }

    #[test]
    fn end_to_end_scan_plan_execute_reclaims_real_files_only() {
        let t = TempRoot::new();
        let apk = t.file("old.apk", 100);
        let log = t.file("app.log", 50);
        t.file("cache/com.example/c.bin", 25);
        let photo = t.file("DCIM/photo.jpg", 999);

        let scan = HostFsScanner::new(t.path()).scan().expect("scan ok");
        let report = analyze(&scan.items).expect("within cap");
        assert_eq!(report.review_bytes(), 0);

        let req = CleanRequest::new(crate::auto_cleanable_kinds(&report));
        let clean_plan = plan(&scan.items, &req).expect("plan ok");
        let mut provider = HostFsCleanProvider::new(t.path());
        let outcome = execute(&clean_plan, &mut provider);

        assert!(
            !outcome.is_partial(),
            "every planned item should be removable: {:?}",
            outcome.failures
        );
        assert_eq!(outcome.attempted(), clean_plan.len());
        assert_eq!(outcome.freed_bytes, 175);
        assert!(!apk.exists());
        assert!(!log.exists());
        assert!(photo.exists(), "user media is never touched");
    }
}
