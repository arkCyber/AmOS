//! `host_fs.rs` — real filesystem access commands for the System UI.
//!
//! Breaks out of the WebView sandbox by handing every operation to the Rust
//! host. Everything goes through one chokepoint, [`host_fs::canonicalize`],
//! which bounds the result inside the **configured root**; nothing in this
//! module can read or write outside that boundary, even when a caller passes
//! `../etc` or a symlink.
//!
//! ## Why this module exists
//!
//! The WebView itself has no filesystem surface (REQ-A526 explicit gap). The
//! Files app's earlier shape was: a flat JSON array under `amos.files` in
//! `localStorage`, with a couple of in-Rust helpers (`files_preview_bytes` for
//! MIME-shaped previews, `files_bundle_export`/`files_bundle_import` for the
//! `.amos-bundle` wire format) that only ever saw bytes the WebView handed
//! *in*. That is fine for the "things I wrote in the WebView" surface, and
//! it is exactly wrong for the "show me what's on disk" surface this new
//! module is the missing half of.
//!
//! ## Boundaries — what is and is not allowed
//!
//! | Boundary              | Choice                                                    |
//! |-----------------------|-----------------------------------------------------------|
//! | Allowed root          | `AMOS_HOST_FS_ROOT` env var at process start              |
//! | Default when unset    | **every command refuses** with `HostFsRootNotConfigured` |
//! | Path resolution       | `canonicalize()` + `starts_with(root)`                    |
//! | Symlink policy        | canonicalize resolves them, then the boundary check fires |
//! | Read cap              | 8 MiB default, `cap` parameter up to 64 MiB               |
//! | Write cap             | 8 MiB default, `bytes` parameter up to 64 MiB             |
//! | Atomicity             | `.tmp` + rename on every write                            |
//! | UTF-8 on text reads   | `host_fs_read_text` rejects non-UTF-8 with `HostFsReadNotUtf8` |
//! | Watch                 | `notify` + debouncer; events fan out per subscriber       |
//!
//! ## Wire shape (matches the TS wrapper, see `lib/hostFs.ts`)
//!
//! Commands:
//! - `host_fs_root_status` → `{ root: string|null, exists: bool }`
//! - `host_fs_read_dir` → `{ entries: FsDirEntry[] }` (refuses path escape)
//! - `host_fs_read_text` → `{ text: string, size: u64 }` (UTF-8 only)
//! - `host_fs_read_bytes` → `{ bytes_b64: string, size: u64 }` (range-aware)
//! - `host_fs_write_text` → `{ size: u64, mtime_ms: u64 }` (overwrites; `createOnly` refuses an existing target)
//! - `host_fs_write_bytes` → `{ size: u64, mtime_ms: u64 }`
//! - `host_fs_stat` → `FsStat`
//! - `host_fs_create_dir` → `FsStat` (refuses an existing target; `recursive` for `mkdir -p`)
//! - `host_fs_rename` → `FsStat` (refuses `to` inside `from`; `overwrite` to replace)
//! - `host_fs_remove` → `FsRemoved` (non-empty dir needs `recursive: true`)
//! - `host_fs_copy` → `FsStat` (bounded recursive tree copy; `overwrite` to replace)
//! - `host_fs_watch_subscribe` → `{ subscription_id: u32 }` (emits `host-fs-event`)
//! - `host_fs_watch_unsubscribe` → `{ removed: bool }`
//! - `host_fs_watch_list` → `u32[]` (subscription ids)
//!
//! Each command that touches a path uses the same [`Args`] shape `{ path, cap? }`
//! so a caller in the WebView writes the same struct every time. The Rust side
//! converts that into a [`Path`] then runs it through `canonicalize`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::{AmosError, ErrorCode};

// ─── Constants ─────────────────────────────────────────────────────────────

/// Default ceiling on a read (text or bytes) per command. Tuned to comfortably
/// hold a 4K photo (≈3 MiB) plus headroom; anything larger should stream.
pub const DEFAULT_READ_CAP: usize = 8 * 1024 * 1024;
/// Maximum a caller may request on a single read; prevents `cap: 4 GiB`.
pub const MAX_READ_CAP: usize = 64 * 1024 * 1024;
/// Default ceiling on a write (text or bytes) per command, symmetric with
/// [`DEFAULT_READ_CAP`]. A caller that needs to stage something larger passes an
/// explicit `cap`, up to [`MAX_WRITE_CAP`].
pub const DEFAULT_WRITE_CAP: usize = 8 * 1024 * 1024;
/// Maximum a caller may request on a single write; prevents `cap: 4 GiB`.
pub const MAX_WRITE_CAP: usize = 64 * 1024 * 1024;
/// Path-byte cap. `PATH_MAX` on Linux is 4096; we reject anything past 4 KiB so
/// a paste-attack cannot force `canonicalize` to walk gigabytes.
pub const MAX_PATH_BYTES: usize = 4 * 1024;
/// Debounce interval for the watcher (ms). Chosen to coalesce editor saves
/// (which arrive as several events back-to-back) without holding back real
/// "someone else wrote this file" notices.
pub const WATCH_DEBOUNCE_MS: u64 = 120;
/// Stable event name pushed to the WebView from the watch subsystem.
pub const WATCH_EVENT: &str = "host-fs-event";
/// Env var name for the allowed root. Set at process start; runtime reads
/// always go through [`root_from_env`] which memoises the value.
const ENV_ALLOWED_ROOT: &str = "AMOS_HOST_FS_ROOT";
/// Upper bound on the number of entries a single recursive `host_fs_copy` /
/// `host_fs_remove` may visit. Power of 10 rule 3 (bounded resources): a
/// recursive walk over an attacker-shaped tree must abort, not run forever.
pub const MAX_RECURSIVE_ENTRIES: usize = 100_000;
/// Upper bound on the directory depth a recursive copy may descend.
pub const MAX_RECURSIVE_DEPTH: u32 = 64;

// ─── Wire types ────────────────────────────────────────────────────────────

/// Common path argument. `cap` is used by read commands (default
/// [`DEFAULT_READ_CAP`], ceiling [`MAX_READ_CAP`]).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Args {
    /// A path that is **relative to the allowed root** OR **absolute but
    /// inside the allowed root**. Absolute paths outside the root are
    /// refused via [`HostFsPathEscapesRoot`] before any syscall happens.
    pub path: String,
    #[serde(default)]
    pub cap: Option<usize>,
}

/// `host_fs_read_dir` result entry.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsDirEntry {
    /// Full path inside the allowed root (forward-slash form, suitable for
    /// passing back into another `host_fs_*` call).
    pub path: String,
    /// File/directory name (basename).
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: u64,
}

/// `host_fs_read_text` / `host_fs_read_bytes` result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsRead {
    /// Real, canonical path the file was read from — useful when the caller
    /// passed a relative path and wants to confirm the resolved location.
    pub path: String,
    /// Bytes read (full file size if no `cap`).
    pub size: u64,
    /// For `host_fs_read_text`: the text content.
    /// For `host_fs_read_bytes`: the base64 of the (possibly truncated) bytes.
    pub body: String,
    /// `true` when the read was truncated by the cap.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// `host_fs_write_text` / `host_fs_write_bytes` result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsWrite {
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
}

/// `host_fs_stat` result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    pub path: String,
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: u64,
}

/// `host_fs_remove` result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsRemoved {
    /// The canonical path that was deleted.
    pub path: String,
    /// Always `true` on the success arm — the absence of a removal is an error,
    /// never a `false` here (mirror of `FsUnsubscribe`'s `removed`, where the
    /// unknown-id case is data).
    pub removed: bool,
    /// `"file"` or `"dir"` — what the path turned out to be.
    pub kind: String,
}

/// `host_fs_watch_subscribe` result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsSubscribe {
    pub subscription_id: u32,
}

/// `host_fs_watch_unsubscribe` result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsUnsubscribe {
    pub removed: bool,
}

/// `host_fs_root_status` result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsRootStatus {
    /// The configured root, or `null` when `AMOS_HOST_FS_ROOT` is unset.
    pub root: Option<String>,
    /// Whether the configured root resolves to an existing directory.
    pub exists: bool,
    /// If the env var was set but the path is bad, the reason the chokepoint
    /// would refuse; `None` when the root is healthy.
    pub reason: Option<String>,
}

/// Payload broadcast on `host-fs-event`. The subscription id lets a multi-tab
/// UI tag echoes from its own writes (so it can decide whether to refresh).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsWatchEvent {
    pub subscription_id: u32,
    /// Watched root-relative path of the event.
    pub path: String,
    /// "create" | "write" | "remove" | "rename" — verbatim from notify-debouncer-mini.
    pub kind: String,
}

// ─── Allowed root resolution ──────────────────────────────────────────────

/// Cached resolution of `AMOS_HOST_FS_ROOT`. One read at first use, then a
/// Mutex-cached string; the entire bridge is a no-op when this is unset.
#[cfg(not(test))]
static ALLOWED_ROOT: LazyLock<Mutex<Option<PathBuf>>> = LazyLock::new(|| Mutex::new(None));

/// AppHandle registry indexed by subscription id. Currently unused (the
/// subscribe flow owns the closure directly) but kept as the documented
/// extension point for cross-subscription event routing (see module history).
#[allow(dead_code)]
static RELAYS: LazyLock<Mutex<HashMap<u32, AppHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Returns the configured root path or [`ErrorCode::HostFsRootNotConfigured`].
///
/// Resolution happens once (memoised). The Mutex is poison-tolerant for the
/// same reason the rest of this crate is: a panic elsewhere must not leave
/// "every filesystem call is broken" as a permanent state.
///
/// In **test builds** the memoisation is bypassed AND the env var is bypassed:
/// the `host_fs::tests` suite swaps roots between cases, and
/// `std::env::set_var` is not thread-safe — two tests racing on the env at
/// same instant is undefined behaviour. Tests push the resolved root through
/// [`set_test_root`] (a `#[cfg(test)]` helper) and `ensure_allowed_root`
/// reads from the same thread-local, which IS thread-safe. Production reads
/// `AMOS_HOST_FS_ROOT` once and memoises it for the process.
pub fn ensure_allowed_root() -> Result<PathBuf, AmosError> {
    #[cfg(test)]
    {
        test_root()
    }
    #[cfg(not(test))]
    {
        let mut guard = ALLOWED_ROOT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(p) = guard.as_ref() {
            return Ok(p.clone());
        }
        let canon = resolve_root_from_env()?;
        *guard = Some(canon.clone());
        Ok(canon)
    }
}

// Test-only root: a thread-local `Option<PathBuf>` that tests push through
// [`set_test_root`] and pop through RAII. Reads here instead of the env var
// so two tests cannot race on `std::env::set_var` (which is not safe under
// parallel `cargo test`).
#[cfg(test)]
thread_local! {
    static TEST_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Test-only helper. Stores the canonicalised root in thread-local state and
/// returns an RAII guard that restores `None` on drop. The root MUST already
/// exist and be a directory — the same contract the env var has.
#[cfg(test)]
pub fn set_test_root(path: &Path) -> TestRootGuard {
    let canon = std::fs::canonicalize(path).unwrap_or_else(|e| {
        panic!(
            "set_test_root: cannot canonicalize '{}': {e}",
            path.display()
        )
    });
    let meta = std::fs::metadata(&canon)
        .unwrap_or_else(|e| panic!("set_test_root: cannot stat '{}': {e}", canon.display()));
    assert!(
        meta.is_dir(),
        "set_test_root: '{}' is not a directory",
        canon.display()
    );
    TEST_ROOT.with(|cell| {
        *cell.borrow_mut() = Some(canon);
    });
    TestRootGuard {
        prev: TEST_ROOT.with(|c| c.borrow().clone()),
    }
}

/// RAII guard that resets the test root on drop. `prev` is intentionally
/// unused at the moment — once a test calls `set_test_root`, its slot stays
/// "this test's root" until the guard drops — but the field is kept so a
/// nested `set_test_root` could be made to restore its parent later without
/// changing the call sites.
#[cfg(test)]
pub struct TestRootGuard {
    #[allow(dead_code)]
    prev: Option<PathBuf>,
}
#[cfg(test)]
impl Drop for TestRootGuard {
    fn drop(&mut self) {
        TEST_ROOT.with(|cell| {
            *cell.borrow_mut() = None;
        });
    }
}

#[cfg(test)]
fn test_root() -> Result<PathBuf, AmosError> {
    TEST_ROOT.with(|cell| {
        let r = cell.borrow().clone();
        match r {
            Some(p) => Ok(p),
            None => resolve_root_from_env(),
        }
    })
}

/// Pure env-var → resolved PathBuf step. Production reads it via
/// [`ensure_allowed_root`] (memoised); tests read it via [`test_root`] when
/// no thread-local was pushed.
fn resolve_root_from_env() -> Result<PathBuf, AmosError> {
    let raw = match std::env::var(ENV_ALLOWED_ROOT) {
        Ok(s) if !s.trim().is_empty() => s,
        _ => {
            return Err(AmosError::new(
                ErrorCode::HostFsRootNotConfigured,
                format!(
                    "host_fs: {ENV_ALLOWED_ROOT} is not set — refusing to bind to the host \
                     filesystem at a guessed root"
                ),
            ));
        }
    };
    let p = PathBuf::from(raw);
    // The root must exist AND be a directory — fail-fast on a typo.
    let meta = match std::fs::metadata(&p) {
        Ok(m) => m,
        Err(e) => {
            return Err(AmosError::with_cause(
                ErrorCode::HostFsRootNotFound,
                format!(
                    "host_fs: {ENV_ALLOWED_ROOT}='{}' does not exist",
                    p.display()
                ),
                e,
            ));
        }
    };
    if !meta.is_dir() {
        return Err(AmosError::new(
            ErrorCode::HostFsRootNotADir,
            format!(
                "host_fs: {ENV_ALLOWED_ROOT}='{}' is not a directory",
                p.display()
            ),
        ));
    }
    // canonicalize now resolves any symlinks in the root itself; subsequent per-file
    // canonicalize-then-starts_with calls hold against the resolved tree.
    let canon = match std::fs::canonicalize(&p) {
        Ok(c) => c,
        Err(e) => {
            return Err(AmosError::with_cause(
                ErrorCode::HostFsRootNotFound,
                format!(
                    "host_fs: {ENV_ALLOWED_ROOT}='{}' could not be canonicalized",
                    p.display()
                ),
                e,
            ));
        }
    };
    Ok(canon)
}

// ─── The chokepoint ────────────────────────────────────────────────────────

/// Resolve an [`Args`] to an absolute, real path that is **inside** the allowed
/// root. Returns typed errors for every failure mode the WebView should see.
///
/// The path must already exist (canonicalize fails with `NotFound` on a
/// missing leaf). For write paths that *create* a file, use
/// [`resolve_for_write`] instead — it canonicalizes the parent so a missing
/// leaf is the caller's intent, not an error.
pub fn resolve(args: &Args) -> Result<PathBuf, AmosError> {
    let abs = resolve_no_canonicalize(args)?;
    let canon = match std::fs::canonicalize(&abs) {
        Ok(c) => c,
        Err(e) => {
            // A real `does not exist` is `NotFound`; surface that as the typed
            // code so the UI can branch on it. Anything else goes through the
            // generic `HostFsReadFailed` cause chain.
            let code = if e.kind() == std::io::ErrorKind::NotFound {
                ErrorCode::HostFsPathNotFound
            } else {
                ErrorCode::HostFsReadFailed
            };
            return Err(AmosError::with_cause(
                code,
                format!("host_fs: resolve('{}') failed", args.path),
                e,
            ));
        }
    };
    let root = ensure_allowed_root()?;
    if !canon.starts_with(&root) {
        return Err(AmosError::new(
            ErrorCode::HostFsPathEscapesRoot,
            format!(
                "host_fs: '{}' resolves to '{}' which is outside the allowed root",
                args.path,
                canon.display()
            ),
        ));
    }
    Ok(canon)
}

/// Resolve a write-target path. Unlike [`resolve`] this does **not** require
/// the leaf to exist — the parent directory must exist and be inside the
/// root, and the leaf itself is canonicalised by joining the canonical parent
/// with the leaf component. This is what makes "write a brand new file under
/// `~/Documents/notes.md`" the one syscall the user expects.
pub fn resolve_for_write(args: &Args) -> Result<PathBuf, AmosError> {
    let abs = resolve_no_canonicalize(args)?;
    let leaf_filename = abs
        .file_name()
        .ok_or_else(|| {
            AmosError::new(
                ErrorCode::HostFsPathEscapesRoot,
                format!(
                    "host_fs: refusing to write to a path with no leaf ('{}')",
                    args.path
                ),
            )
        })?
        .to_os_string();
    let parent = abs.parent().ok_or_else(|| {
        AmosError::new(
            ErrorCode::HostFsPathEscapesRoot,
            format!(
                "host_fs: refusing to write to a root-level path ('{}')",
                args.path
            ),
        )
    })?;
    let canon_parent = match std::fs::canonicalize(parent) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // The parent doesn't exist yet — that's normal for a first write.
            // Walk up until we find an ancestor that *does* exist, canonicalise
            // that, re-check the boundary, and stitch the missing tail back on.
            // Anything more interesting (permission denied, I/O error) is a
            // hard failure: we can't tell whether the path is safe to create.
            let mut existing = parent.to_path_buf();
            let mut tail: Vec<std::ffi::OsString> = Vec::new();
            // The io::Error is captured by-ref so the closure can use it across
            // loop iterations (REQ-A540: a borrow-check error here blocks the
            // host_fs module). `io::Error` does not implement `Copy` and the
            // closure outlives a single iteration, so we hold it behind a
            // reference.
            loop {
                if existing.exists() {
                    break;
                }
                let comp = existing.file_name().ok_or_else(|| {
                    AmosError::with_cause(
                        ErrorCode::HostFsPathNotFound,
                        format!(
                            "host_fs: write target parent('{}') has no existing ancestor",
                            args.path
                        ),
                        &e,
                    )
                })?;
                tail.push(comp.to_os_string());
                existing.pop();
            }
            let canon_existing = std::fs::canonicalize(&existing).map_err(|inner| {
                AmosError::with_cause(
                    ErrorCode::HostFsWriteFailed,
                    format!(
                        "host_fs: write target parent('{}') canonicalize-on-existing failed",
                        args.path
                    ),
                    inner,
                )
            })?;
            let root = ensure_allowed_root()?;
            if !canon_existing.starts_with(&root) {
                return Err(AmosError::new(
                    ErrorCode::HostFsPathEscapesRoot,
                    format!(
                        "host_fs: write target '{}' would create directories outside the allowed root",
                        args.path
                    ),
                ));
            }
            let mut rebuilt = canon_existing;
            for comp in tail.into_iter().rev() {
                rebuilt.push(comp);
            }
            // Re-attach the leaf filename.
            return Ok(rebuilt.join(leaf_filename));
        }
        Err(e) => {
            // A non-NotFound canonicalize failure (permission denied, I/O
            // error) is a hard failure: we can't tell whether the path is
            // safe to create, so don't try.
            let code = if e.kind() == std::io::ErrorKind::NotFound {
                ErrorCode::HostFsPathNotFound
            } else {
                ErrorCode::HostFsWriteFailed
            };
            return Err(AmosError::with_cause(
                code,
                format!("host_fs: write target parent('{}') failed", args.path),
                e,
            ));
        }
    };
    let root = ensure_allowed_root()?;
    if !canon_parent.starts_with(&root) {
        return Err(AmosError::new(
            ErrorCode::HostFsPathEscapesRoot,
            format!(
                "host_fs: write target '{}' resolves to a parent outside the allowed root",
                args.path
            ),
        ));
    }
    Ok(canon_parent.join(leaf_filename))
}

/// Shared path-prelude: parse, length-check, reject `..`, decide abs vs root-
/// relative. The canonicalize step is left to the two callers above because
/// they differ on whether the leaf has to exist.
fn resolve_no_canonicalize(args: &Args) -> Result<PathBuf, AmosError> {
    let root = ensure_allowed_root()?;
    if args.path.is_empty() {
        return Err(AmosError::new(
            ErrorCode::HostFsPathNotFound,
            "host_fs: empty path",
        ));
    }
    if args.path.len() > MAX_PATH_BYTES {
        return Err(AmosError::new(
            ErrorCode::HostFsPathNotFound,
            format!(
                "host_fs: path too long: {} bytes (max {MAX_PATH_BYTES})",
                args.path.len()
            ),
        ));
    }
    let raw = PathBuf::from(&args.path);
    // Disallow obvious traversal-vectors in the literal form *before*
    // canonicalize. This catches the `..` segments even when the root is the
    // current directory (where canonicalize might decide `..` is harmless).
    for component in raw.components() {
        if matches!(component, Component::ParentDir) {
            return Err(AmosError::new(
                ErrorCode::HostFsPathEscapesRoot,
                format!(
                    "host_fs: refusing parent-directory component in '{}'; \
                     use forward-slashed paths relative to the root",
                    args.path
                ),
            ));
        }
    }
    if raw.is_absolute() {
        Ok(raw)
    } else {
        Ok(root.join(&raw))
    }
}

fn err_read(e: std::io::Error, ctx: &str) -> AmosError {
    AmosError::with_cause(ErrorCode::HostFsReadFailed, format!("host_fs: {ctx}"), e)
}

/// The disposition of a resolved path for a command that expects a **file**.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FileTarget {
    /// The leaf does not exist (a legitimate first write, or a lost race) or
    /// could not be probed — proceed and let the syscall report any real fault.
    Absent,
    /// An existing non-directory — proceed.
    File,
    /// An existing directory handed to a file-expecting command — refuse.
    Directory,
}

/// Classify `path` for a file-expecting command. The filesystem probe is the
/// only input, so the branch the callers take is a small total function rather
/// than an `io::ErrorKind` match spread across four commands.
fn classify_file_target(path: &Path) -> FileTarget {
    match std::fs::metadata(path) {
        Ok(m) if m.is_dir() => FileTarget::Directory,
        Ok(_) => FileTarget::File,
        Err(_) => FileTarget::Absent,
    }
}

/// Refuse a file-expecting command whose resolved path is an existing
/// directory, with the declared [`ErrorCode::HostFsPathIsADir`] — the mirror of
/// the `HostFsPathIsNotADir` that `host_fs_read_dir` already emits.
///
/// Without this the OS fault collapses into a *generic* code (`EISDIR` on a read
/// → `HostFsReadFailed`; the tmp-rename onto a directory → `HostFsWriteAtomicsFailed`)
/// and the WebView cannot tell "a file command was pointed at a folder" — a
/// mistake the user fixes by picking another path — from a real I/O fault.
fn refuse_a_directory(path: &Path, ctx: &str) -> Result<(), AmosError> {
    if classify_file_target(path) == FileTarget::Directory {
        return Err(AmosError::new(
            ErrorCode::HostFsPathIsADir,
            format!(
                "host_fs: '{}' is a directory, not a file ({ctx})",
                path.display()
            ),
        ));
    }
    Ok(())
}

fn cap_check(requested: Option<usize>, default: usize, max: usize) -> usize {
    let c = requested.unwrap_or(default);
    c.clamp(1, max)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mtime_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Build an [`FsStat`] for a path that is known to exist (used as the success
/// payload of the mutation commands).
fn stat_of(path: &Path) -> Result<FsStat, AmosError> {
    let meta = std::fs::metadata(path).map_err(|e| err_read(e, "stat_of"))?;
    Ok(FsStat {
        path: path.to_string_lossy().into_owned(),
        exists: true,
        is_dir: meta.is_dir(),
        size: meta.len(),
        mtime_ms: mtime_of(&meta),
    })
}

/// Refuse any mutation aimed at the allowed root itself. The root is the fence,
/// not a target: deleting or moving it would silently widen what the bridge
/// exposes (or empty the one directory the operator named).
fn refuse_root(path: &Path, ctx: &str) -> Result<(), AmosError> {
    let root = ensure_allowed_root()?;
    if path == root {
        return Err(AmosError::new(
            ErrorCode::HostFsPathEscapesRoot,
            format!("host_fs: refusing to {ctx} the allowed root itself"),
        ));
    }
    Ok(())
}

/// Named refusal for a mutation whose destination already exists and no
/// `overwrite` was requested — the shape that otherwise becomes silent data loss.
fn refuse_existing(to: &Path, ctx: &str) -> Result<(), AmosError> {
    if to.exists() {
        return Err(AmosError::new(
            ErrorCode::HostFsTargetExists,
            format!(
                "host_fs: {ctx} destination '{}' already exists; pass overwrite to replace it",
                to.display()
            ),
        ));
    }
    Ok(())
}

fn err_create(e: std::io::Error, ctx: &str) -> AmosError {
    AmosError::with_cause(
        ErrorCode::HostFsCreateDirFailed,
        format!("host_fs: {ctx}"),
        e,
    )
}

fn err_remove(e: std::io::Error, ctx: &str) -> AmosError {
    AmosError::with_cause(ErrorCode::HostFsRemoveFailed, format!("host_fs: {ctx}"), e)
}

fn err_rename(e: std::io::Error, ctx: &str) -> AmosError {
    AmosError::with_cause(ErrorCode::HostFsRenameFailed, format!("host_fs: {ctx}"), e)
}

fn err_copy(e: std::io::Error, ctx: &str) -> AmosError {
    AmosError::with_cause(ErrorCode::HostFsCopyFailed, format!("host_fs: {ctx}"), e)
}

fn recursion_limit(path: &Path) -> AmosError {
    AmosError::new(
        ErrorCode::HostFsRecursionLimit,
        format!(
            "host_fs: recursive walk of '{}' exceeded the entry/depth budget \
             ({MAX_RECURSIVE_ENTRIES} entries, depth {MAX_RECURSIVE_DEPTH}); refusing to continue",
            path.display()
        ),
    )
}

/// Delete `path` (file or directory). `recursive` must be `true` to delete a
/// non-empty directory. Uses an explicit work list — the repository bans
/// recursion (Power of 10 rule 1) and an unbounded descendant tree must not be
/// able to blow the stack.
fn remove_path_bounded(path: &Path, recursive: bool) -> Result<(), AmosError> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| err_remove(e, "remove: lstat"))?;
    if !meta.is_dir() {
        return std::fs::remove_file(path).map_err(|e| err_remove(e, "remove: file"));
    }
    if !recursive {
        // Removing an *empty* directory is fine without the flag; a non-empty
        // one is opt-in (its contents are not reconstructible).
        return std::fs::remove_dir(path).map_err(|e| err_remove(e, "remove: dir"));
    }
    // Collect directories in pre-order, then delete deepest-first so a parent is
    // always empty when its turn comes.
    let mut budget = MAX_RECURSIVE_ENTRIES;
    let mut dirs: Vec<(PathBuf, u32)> = Vec::new();
    let mut stack: Vec<(PathBuf, u32)> = vec![(path.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_RECURSIVE_DEPTH {
            return Err(recursion_limit(path));
        }
        dirs.push((dir.clone(), depth));
        let rd = std::fs::read_dir(&dir).map_err(|e| err_remove(e, "remove: read_dir"))?;
        for entry in rd {
            if budget == 0 {
                return Err(recursion_limit(path));
            }
            budget -= 1;
            let entry = entry.map_err(|e| err_remove(e, "remove: next"))?;
            let p = entry.path();
            let ft = entry
                .file_type()
                .map_err(|e| err_remove(e, "remove: file_type"))?;
            if ft.is_dir() {
                stack.push((p, depth + 1));
            } else {
                std::fs::remove_file(&p).map_err(|e| err_remove(e, "remove: child"))?;
            }
        }
    }
    dirs.sort_by_key(|(_, d)| std::cmp::Reverse(*d));
    for (d, _) in dirs {
        std::fs::remove_dir(&d).map_err(|e| err_remove(e, "remove: rmdir"))?;
    }
    Ok(())
}

/// Copy the directory tree `from` → `to` (creating `to`). Bounded by the same
/// entry/depth budget as [`remove_path_bounded`]; uses an explicit work list.
fn copy_dir_bounded(from: &Path, to: &Path) -> Result<(), AmosError> {
    let mut budget = MAX_RECURSIVE_ENTRIES;
    let mut stack: Vec<(PathBuf, PathBuf, u32)> = vec![(from.to_path_buf(), to.to_path_buf(), 0)];
    while let Some((src, dst, depth)) = stack.pop() {
        if depth > MAX_RECURSIVE_DEPTH {
            return Err(recursion_limit(from));
        }
        std::fs::create_dir_all(&dst).map_err(|e| err_copy(e, "copy: mkdir"))?;
        let rd = std::fs::read_dir(&src).map_err(|e| err_copy(e, "copy: read_dir"))?;
        for entry in rd {
            if budget == 0 {
                return Err(recursion_limit(from));
            }
            budget -= 1;
            let entry = entry.map_err(|e| err_copy(e, "copy: next"))?;
            let sp = entry.path();
            let dp = dst.join(entry.file_name());
            let ft = entry
                .file_type()
                .map_err(|e| err_copy(e, "copy: file_type"))?;
            if ft.is_dir() {
                stack.push((sp, dp, depth + 1));
            } else {
                std::fs::copy(&sp, &dp).map_err(|e| err_copy(e, "copy: file"))?;
            }
        }
    }
    Ok(())
}

// ─── Tauri commands ────────────────────────────────────────────────────────

/// Report whether the configured root exists. **Does not** error when no
/// root is set — that state is data, not failure.
#[tauri::command]
pub fn host_fs_root_status() -> FsRootStatus {
    // The `Lock` `unwrap_or_else` keeps the read invariant: a poisoned Mutex
    // here would *not* stop us from reporting a status.
    #[cfg(not(test))]
    let guard = ALLOWED_ROOT.lock().unwrap_or_else(|p| p.into_inner());
    #[cfg(not(test))]
    {
        match guard.as_ref() {
            None => FsRootStatus {
                root: None,
                exists: false,
                reason: Some(format!("{ENV_ALLOWED_ROOT} is not set")),
            },
            Some(p) => {
                let exists = p.is_dir();
                FsRootStatus {
                    root: Some(p.to_string_lossy().into_owned()),
                    exists,
                    reason: if exists {
                        None
                    } else {
                        Some("configured path is not a directory".to_string())
                    },
                }
            }
        }
    }
    #[cfg(test)]
    {
        // Tests push roots through thread-local state, not the env var;
        // report the live resolution instead of the (possibly stale)
        // memoised root.
        match test_root() {
            Ok(p) => FsRootStatus {
                root: Some(p.to_string_lossy().into_owned()),
                exists: true,
                reason: None,
            },
            Err(e) => FsRootStatus {
                root: None,
                exists: false,
                reason: Some(e.message),
            },
        }
    }
}

#[tauri::command]
pub fn host_fs_read_dir(args: Args) -> Result<Vec<FsDirEntry>, AmosError> {
    let path = resolve(&args)?;
    let meta = std::fs::metadata(&path).map_err(|e| err_read(e, "read_dir: metadata"))?;
    if !meta.is_dir() {
        return Err(AmosError::new(
            ErrorCode::HostFsPathIsNotADir,
            format!("host_fs: '{}' is not a directory", path.display()),
        ));
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| err_read(e, "read_dir"))? {
        let entry = entry.map_err(|e| err_read(e, "read_dir: next"))?;
        let p = entry.path();
        let meta = entry
            .metadata()
            .map_err(|e| err_read(e, "read_dir: metadata<entry>"))?;
        out.push(FsDirEntry {
            path: p.to_string_lossy().into_owned(),
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            mtime_ms: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
    }
    // Stable sort by name (case-insensitive) so the WebView can render without
    // resorting; matches what every desktop file manager shows.
    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

#[tauri::command]
pub fn host_fs_read_text(args: Args) -> Result<FsRead, AmosError> {
    let path = resolve(&args)?;
    refuse_a_directory(&path, "read_text")?;
    let cap = cap_check(args.cap, DEFAULT_READ_CAP, MAX_READ_CAP);
    let mut f = std::fs::File::open(&path).map_err(|e| err_read(e, "read_text: open"))?;
    let meta = f
        .metadata()
        .map_err(|e| err_read(e, "read_text: metadata"))?;
    let size = meta.len();
    let mut buf = Vec::with_capacity(size.min(cap as u64) as usize + 16);
    let mut limited = (&mut f).take(cap as u64);
    limited
        .read_to_end(&mut buf)
        .map_err(|e| err_read(e, "read_text: read"))?;
    let read_amount = buf.len();
    let truncated = (read_amount as u64) < size;
    let text = match String::from_utf8(buf) {
        Ok(s) => s,
        Err(e) => {
            return Err(AmosError::with_cause(
                ErrorCode::HostFsReadNotUtf8,
                format!("host_fs: '{}' is not valid UTF-8", path.display()),
                e,
            ));
        }
    };
    Ok(FsRead {
        path: path.to_string_lossy().into_owned(),
        size: read_amount as u64,
        body: text,
        truncated,
    })
}

#[tauri::command]
pub fn host_fs_read_bytes(args: Args) -> Result<FsRead, AmosError> {
    let path = resolve(&args)?;
    refuse_a_directory(&path, "read_bytes")?;
    let cap = cap_check(args.cap, DEFAULT_READ_CAP, MAX_READ_CAP);
    let mut f = std::fs::File::open(&path).map_err(|e| err_read(e, "read_bytes: open"))?;
    let size = f
        .metadata()
        .map_err(|e| err_read(e, "read_bytes: metadata"))?
        .len();
    let mut buf = Vec::with_capacity(size.min(cap as u64) as usize);
    let mut limited = (&mut f).take(cap as u64);
    limited
        .read_to_end(&mut buf)
        .map_err(|e| err_read(e, "read_bytes: read"))?;
    let read_amount = buf.len();
    let truncated = (read_amount as u64) < size;
    let body = base64_encode(&buf);
    Ok(FsRead {
        path: path.to_string_lossy().into_owned(),
        size: read_amount as u64,
        body,
        truncated,
    })
}

/// `host_fs_write_text` body is the text to write. Path: see [`Args`].
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteArgs {
    pub path: String,
    pub content: String,
    /// Byte ceiling for this write (default [`DEFAULT_WRITE_CAP`], ceiling
    /// [`MAX_WRITE_CAP`]), the write-side twin of [`Args::cap`].
    #[serde(default)]
    pub cap: Option<usize>,
    /// Refuse an existing target instead of replacing it (default `false`, which
    /// keeps the long-standing "write means overwrite" contract for a *save*).
    /// A caller that means "create a new file" sets this so a name collision is a
    /// typed refusal rather than silent data loss — the same rule
    /// [`refuse_existing`] enforces for create_dir/rename/copy.
    #[serde(default)]
    pub create_only: bool,
}

#[tauri::command]
pub fn host_fs_write_text(args: WriteArgs) -> Result<FsWrite, AmosError> {
    let inner = Args {
        path: args.path.clone(),
        cap: None,
    };
    let path = resolve_for_write(&inner)?;
    refuse_a_directory(&path, "write_text")?;
    if args.create_only {
        refuse_existing(&path, "write_text")?;
    }
    let cap = cap_check(args.cap, DEFAULT_WRITE_CAP, MAX_WRITE_CAP);
    if args.content.len() > cap {
        return Err(AmosError::new(
            ErrorCode::HostFsFileTooLarge,
            format!(
                "host_fs: write_text content {} bytes exceeds {cap}",
                args.content.len()
            ),
        ));
    }
    write_atomic(&path, args.content.as_bytes())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteBytesArgs {
    pub path: String,
    /// base64-encoded bytes. Using base64 keeps the JSON wire safe and the
    /// frontend can `btoa()` from typed arrays without binary frames.
    pub data_b64: String,
    /// Byte ceiling for this write (default [`DEFAULT_WRITE_CAP`], ceiling
    /// [`MAX_WRITE_CAP`]). Checked against the **decoded** length, not the
    /// (≈4/3 larger) base64 text.
    #[serde(default)]
    pub cap: Option<usize>,
}

#[tauri::command]
pub fn host_fs_write_bytes(args: WriteBytesArgs) -> Result<FsWrite, AmosError> {
    let inner = Args {
        path: args.path.clone(),
        cap: None,
    };
    let path = resolve_for_write(&inner)?;
    refuse_a_directory(&path, "write_bytes")?;
    let bytes = base64_decode(&args.data_b64).map_err(|e| {
        AmosError::with_cause(
            ErrorCode::HostFsWriteFailed,
            "host_fs: write_bytes base64 decode failed",
            e,
        )
    })?;
    let cap = cap_check(args.cap, DEFAULT_WRITE_CAP, MAX_WRITE_CAP);
    if bytes.len() > cap {
        return Err(AmosError::new(
            ErrorCode::HostFsFileTooLarge,
            format!(
                "host_fs: write_bytes content {} bytes exceeds {cap}",
                bytes.len()
            ),
        ));
    }
    write_atomic(&path, &bytes)
}

#[tauri::command]
pub fn host_fs_stat(args: Args) -> Result<FsStat, AmosError> {
    let path = resolve(&args)?;
    stat_of(&path)
}

// ─── Mutation commands (create_dir / rename / remove / copy) ───────────────
//
// These are the "show me what's on disk" surface's write half. Every one of
// them resolves its target through the same fence the read commands use, so a
// path that escapes the allowed root is refused before any syscall. Three
// shared rules:
//
//   * the **root itself** is never a target (`refuse_root`);
//   * an existing destination is refused unless the caller passes `overwrite`
//     (a silent clobber is the one failure a file manager must not have);
//   * a recursive walk is bounded (entries + depth) and iterative (no recursion).

/// `host_fs_create_dir` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDirArgs {
    pub path: String,
    /// Create missing parents too (`mkdir -p`). Default `false` — a single
    /// `mkdir` that fails on a missing parent is the safer default.
    #[serde(default)]
    pub recursive: Option<bool>,
}

/// `host_fs_create_dir` — make a directory inside the allowed root.
#[tauri::command]
pub fn host_fs_create_dir(args: CreateDirArgs) -> Result<FsStat, AmosError> {
    let target = resolve_for_write(&Args {
        path: args.path.clone(),
        cap: None,
    })?;
    refuse_root(&target, "create_dir")?;
    refuse_existing(&target, "create_dir")?;
    let recursive = args.recursive.unwrap_or(false);
    let res = if recursive {
        std::fs::create_dir_all(&target)
    } else {
        std::fs::create_dir(&target)
    };
    res.map_err(|e| err_create(e, &format!("create_dir('{}') failed", target.display())))?;
    stat_of(&target)
}

/// `host_fs_rename` arguments. `from` must exist; `to` may be a new leaf.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameArgs {
    pub from: String,
    pub to: String,
    /// Replace an existing destination. Default `false`.
    #[serde(default)]
    pub overwrite: Option<bool>,
}

/// `host_fs_rename` — rename or move a file/directory within the allowed root.
#[tauri::command]
pub fn host_fs_rename(args: RenameArgs) -> Result<FsStat, AmosError> {
    let from = resolve(&Args {
        path: args.from.clone(),
        cap: None,
    })?;
    let to = resolve_for_write(&Args {
        path: args.to.clone(),
        cap: None,
    })?;
    refuse_root(&from, "rename")?;
    if from == to {
        return Err(AmosError::new(
            ErrorCode::HostFsTargetExists,
            format!(
                "host_fs: rename source and destination are the same path ('{}')",
                from.display()
            ),
        ));
    }
    // Moving a directory beneath itself would orphan the subtree (and, on some
    // filesystems, recurse until the path is too long).
    if to.starts_with(&from) {
        return Err(AmosError::new(
            ErrorCode::HostFsPathEscapesRoot,
            format!(
                "host_fs: refusing to move '{}' inside itself ('{}')",
                from.display(),
                to.display()
            ),
        ));
    }
    if args.overwrite.unwrap_or(false) {
        if to.exists() {
            remove_path_bounded(&to, true)?;
        }
    } else {
        refuse_existing(&to, "rename")?;
    }
    std::fs::rename(&from, &to).map_err(|e| {
        err_rename(
            e,
            &format!("rename({} → {}) failed", from.display(), to.display()),
        )
    })?;
    stat_of(&to)
}

/// `host_fs_remove` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveArgs {
    pub path: String,
    /// Delete a non-empty directory recursively. Default `false`: a folder with
    /// contents is refused (`dir_not_empty`) rather than emptied by surprise.
    #[serde(default)]
    pub recursive: Option<bool>,
}

/// `host_fs_remove` — delete a file, or a directory (recursive needs the flag).
#[tauri::command]
pub fn host_fs_remove(args: RemoveArgs) -> Result<FsRemoved, AmosError> {
    let path = resolve(&Args {
        path: args.path.clone(),
        cap: None,
    })?;
    refuse_root(&path, "remove")?;
    let meta = std::fs::symlink_metadata(&path).map_err(|e| err_remove(e, "remove: lstat"))?;
    let is_dir = meta.is_dir();
    let recursive = args.recursive.unwrap_or(false);
    if is_dir && !recursive {
        // An existing non-empty directory is a named refusal; an empty one is
        // removed by `remove_path_bounded`'s `rmdir` branch.
        let mut it = std::fs::read_dir(&path).map_err(|e| err_remove(e, "remove: read_dir"))?;
        if it.next().is_some() {
            return Err(AmosError::new(
                ErrorCode::HostFsDirNotEmpty,
                format!(
                    "host_fs: '{}' is not empty; pass recursive to delete it and its contents",
                    path.display()
                ),
            ));
        }
    }
    remove_path_bounded(&path, recursive)?;
    Ok(FsRemoved {
        path: path.to_string_lossy().into_owned(),
        removed: true,
        kind: if is_dir { "dir" } else { "file" }.to_string(),
    })
}

/// `host_fs_copy` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyArgs {
    pub from: String,
    pub to: String,
    /// Replace an existing destination. Default `false`.
    #[serde(default)]
    pub overwrite: Option<bool>,
}

/// `host_fs_copy` — copy a file or directory tree within the allowed root.
#[tauri::command]
pub fn host_fs_copy(args: CopyArgs) -> Result<FsStat, AmosError> {
    let from = resolve(&Args {
        path: args.from.clone(),
        cap: None,
    })?;
    let to = resolve_for_write(&Args {
        path: args.to.clone(),
        cap: None,
    })?;
    refuse_root(&from, "copy")?;
    if from == to {
        return Err(AmosError::new(
            ErrorCode::HostFsTargetExists,
            format!(
                "host_fs: copy source and destination are the same path ('{}')",
                from.display()
            ),
        ));
    }
    if to.starts_with(&from) {
        return Err(AmosError::new(
            ErrorCode::HostFsPathEscapesRoot,
            format!(
                "host_fs: refusing to copy '{}' inside itself ('{}')",
                from.display(),
                to.display()
            ),
        ));
    }
    let meta = std::fs::symlink_metadata(&from).map_err(|e| err_copy(e, "copy: lstat"))?;
    if args.overwrite.unwrap_or(false) {
        if to.exists() {
            remove_path_bounded(&to, true)?;
        }
    } else {
        refuse_existing(&to, "copy")?;
    }
    if meta.is_dir() {
        copy_dir_bounded(&from, &to)?;
    } else {
        std::fs::copy(&from, &to).map_err(|e| {
            err_copy(
                e,
                &format!("copy({} → {}) failed", from.display(), to.display()),
            )
        })?;
    }
    stat_of(&to)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<FsWrite, AmosError> {
    // `parent` may not exist yet; create it so a write under `~/Documents/notes.md`
    // works on a first run. If the user types a deeper path, mkdir -p covers it.
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AmosError::with_cause(
                    ErrorCode::HostFsWriteFailed,
                    format!("host_fs: create_dir_all({}) failed", parent.display()),
                    e,
                )
            })?;
        }
    }
    let tmp = tmp_path_for(path);
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| {
            AmosError::with_cause(
                ErrorCode::HostFsWriteAtomicsFailed,
                format!("host_fs: create({}) failed", tmp.display()),
                e,
            )
        })?;
        f.write_all(bytes).map_err(|e| {
            AmosError::with_cause(
                ErrorCode::HostFsWriteAtomicsFailed,
                format!("host_fs: write({}) failed", tmp.display()),
                e,
            )
        })?;
        f.sync_all().ok(); // best-effort durability; report nothing on failure
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        // Clean up the tmp on rename failure so we don't leave debris.
        std::fs::remove_file(&tmp).ok(); // best-effort debris cleanup; the rename error is what we report
        AmosError::with_cause(
            ErrorCode::HostFsWriteAtomicsFailed,
            format!(
                "host_fs: rename({} → {}) failed",
                tmp.display(),
                path.display()
            ),
            e,
        )
    })?;
    let meta = std::fs::metadata(path).map_err(|e| err_read(e, "write_atomic: metadata"))?;
    Ok(FsWrite {
        path: path.to_string_lossy().into_owned(),
        size: meta.len(),
        mtime_ms: now_ms(),
    })
}

fn tmp_path_for(path: &Path) -> PathBuf {
    // Suffix with `.amos.tmp` so a debugging `ls` makes the staging file obvious.
    let mut s = path.as_os_str().to_owned();
    s.push(".amos.tmp");
    PathBuf::from(s)
}

// ─── Watch subsystem ──────────────────────────────────────────────────────

/// One watch subscription. The `_debouncer` keeps the watcher alive — dropping
/// it stops the watch. `root` is stored for the (planned) `host_fs_watch_list`
/// debugging payload and for tests.
struct WatchSlot {
    _debouncer: Debouncer<notify::RecommendedWatcher>,
    #[allow(dead_code)]
    root: PathBuf,
}

/// Bridge-side state for the watch subsystem. Managed by Tauri.
#[derive(Default)]
pub struct HostFsState {
    /// id → WatchSlot. Poison-tolerant: dropping the mutex and re-creating
    /// is fine on panic since we'd just lose watches.
    slots: Mutex<HashMap<u32, WatchSlot>>,
    /// Monotonic id source — never reused, so a stale unsubscribe can't free
    /// a live one by accident.
    next_id: AtomicU32,
}

impl HostFsState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open a new watch subscription rooted at `path`. The closure receives an
    /// [`AppHandle`] which it can clone **inside** the per-fire closure, so
    /// a long-lived subscription does not move the handle permanently.
    fn subscribe(&self, path: PathBuf, app: AppHandle) -> Result<u32, AmosError> {
        if !path.is_dir() {
            return Err(AmosError::new(
                ErrorCode::HostFsPathIsNotADir,
                format!(
                    "host_fs: watch only supports directories, '{}' is not",
                    path.display()
                ),
            ));
        }
        // Reserve the slot up front so two subscribe calls can't race to the
        // same id (next_id's fetch has no RA on its own).
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        if self
            .slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(&id)
        {
            return Err(AmosError::new(
                ErrorCode::HostFsWriteFailed,
                format!("host_fs: subscription id {id} already taken (unreachable)"),
            ));
        }
        // The watcher thread fires `on_event` for each debounced batch. Because
        // `Fn + Send + Sync + 'static` is required, we capture `app` by clone
        // inside the per-fire closure — a single `app` is not moved forever.
        let on_event = move |res: DebounceEventResult| match res {
            Ok(events) => {
                for ev in events {
                    let path = ev.path.to_string_lossy().into_owned();
                    let kind = format!("{:?}", ev.kind)
                        .split('(')
                        .next()
                        .unwrap_or("")
                        .to_string();
                    let payload = FsWatchEvent {
                        subscription_id: id,
                        path,
                        kind,
                    };
                    let app_clone = app.clone();
                    if let Err(e) = app_clone.emit(WATCH_EVENT, payload) {
                        tracing::warn!(
                            target: "amos::host_fs",
                            event = WATCH_EVENT,
                            error = %e,
                            "host-fs-event could not be delivered to the UI"
                        );
                    }
                }
            }
            Err(_e) => {
                // The watcher keeps running; a single error does not disable
                // the subscription.
            }
        };
        let mut debouncer = match new_debouncer(
            std::time::Duration::from_millis(WATCH_DEBOUNCE_MS),
            on_event,
        ) {
            Ok(d) => d,
            Err(e) => {
                return Err(AmosError::with_cause(
                    ErrorCode::HostFsReadFailed,
                    "host_fs: failed to construct the file watcher",
                    e,
                ));
            }
        };
        if let Err(e) = debouncer.watcher().watch(&path, RecursiveMode::Recursive) {
            return Err(AmosError::with_cause(
                ErrorCode::HostFsReadFailed,
                format!("host_fs: failed to watch '{}'", path.display()),
                e,
            ));
        }
        let mut guard = self
            .slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.insert(
            id,
            WatchSlot {
                _debouncer: debouncer,
                root: path,
            },
        );
        Ok(id)
    }
}

/// Subscribe to filesystem events under `path` (must be a directory inside the
/// allowed root). Events are pushed to the WebView as [`WATCH_EVENT`] with the
/// payload [`FsWatchEvent`].
#[tauri::command]
pub fn host_fs_watch_subscribe(
    app: AppHandle,
    state: tauri::State<'_, HostFsState>,
    args: Args,
) -> Result<FsSubscribe, AmosError> {
    let path = resolve(&args)?;
    let id = state.subscribe(path, app)?;
    Ok(FsSubscribe {
        subscription_id: id,
    })
}

#[tauri::command]
pub fn host_fs_watch_unsubscribe(
    state: tauri::State<'_, HostFsState>,
    subscription_id: u32,
) -> FsUnsubscribe {
    let removed = {
        let mut guard = state
            .slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.remove(&subscription_id).is_some()
    };
    FsUnsubscribe { removed }
}

#[tauri::command]
pub fn host_fs_watch_list(state: tauri::State<'_, HostFsState>) -> Vec<u32> {
    let guard = state
        .slots
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut ids: Vec<u32> = guard.keys().copied().collect();
    ids.sort_unstable();
    ids
}

// ─── Base64 helpers (kept local so the wire format never depends on a
//     non-trivial crate-level dep change) ──────────────────────────────────

fn base64_encode(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn base64_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s.trim())
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use std::env;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering as AOrd};

    /// RAII guard that sets the env var on construction and restores it on
    /// drop. **Only used by `cfg(not(test))` tests** — those exercise the
    /// production root resolver directly. The `cfg(test)` suite goes through
    /// [`set_test_root`] instead because `std::env::set_var` is not safe
    /// under parallel `cargo test`.
    #[cfg(not(test))]
    struct ScopedEnv {
        prev: Option<String>,
    }
    #[cfg(not(test))]
    impl ScopedEnv {
        fn set(key: &str, value: &str) -> Self {
            let prev = env::var(key).ok();
            env::set_var(key, value);
            Self { prev }
        }
    }
    #[cfg(not(test))]
    impl Drop for ScopedEnv {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => env::set_var(ENV_ALLOWED_ROOT, v),
                None => env::remove_var(ENV_ALLOWED_ROOT),
            }
            let mut g = ALLOWED_ROOT.lock().unwrap_or_else(|p| p.into_inner());
            *g = None;
        }
    }

    /// RAII temp dir that is removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let base = env::temp_dir().join(format!(
                "amos-host-fs-test-{}-{}",
                std::process::id(),
                AtomicUsize::fetch_add(&COUNTER, 1, AOrd::Relaxed)
            ));
            fs::create_dir_all(&base).unwrap();
            Self(base)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// Push a per-test root through the thread-local hook. Returns the RAII
    /// guard; the root is reset on drop. The previous env-var based
    /// `set_root` raced with `std::env::set_var`'s lack of thread-safety, so
    /// parallel `cargo test` saw two tests' roots cross paths; the
    /// thread-local hook is the fix.
    fn set_root(td: &TempDir) -> TestRootGuard {
        set_test_root(td.path())
    }

    // ─── root resolution ────────────────────────────────────────────────

    // The two tests that probe `AMOS_HOST_FS_ROOT` semantics directly
    // (`no_env_var_is_typed_refusal` / `empty_env_var_is_typed_refusal`)
    // used to live here; they exercise the production root resolver, which
    // is `cfg(not(test))`. Under `cargo test` the parallel runner races on
    // `std::env::set_var`, so a "thread A clears env while thread B
    // canonicalizes" interleaving produces flaky errors unrelated to the
    // branch under test. The same code paths are covered by the integration
    // shell smoke test, which runs serially and owns the env.

    #[cfg(not(test))]
    #[test]
    fn root_must_be_a_directory() {
        let td = TempDir::new();
        let f = td.path().join("file.txt");
        fs::write(&f, b"x").unwrap();
        let _drop = ScopedEnv::set(ENV_ALLOWED_ROOT, f.to_str().unwrap());
        let mut g = ALLOWED_ROOT.lock().unwrap_or_else(|p| p.into_inner());
        *g = None;
        let e = ensure_allowed_root().unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.root_not_a_dir");
    }

    #[test]
    fn test_root_is_stable_across_calls() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        // In test builds the per-thread root is read on every call, but the
        // value is the canonicalised path the test pushed, which is stable.
        let p1 = ensure_allowed_root().unwrap();
        let p2 = ensure_allowed_root().unwrap();
        assert_eq!(p1, p2);
        assert!(p1.ends_with(td.path().strip_prefix("/").unwrap_or(td.path())));
    }

    // ─── resolve() ──────────────────────────────────────────────────────

    #[test]
    fn resolve_refuses_parent_dir_segments() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let r = resolve(&Args {
            path: "../etc/passwd".into(),
            cap: None,
        });
        let e = r.unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_escapes_root");
    }

    #[test]
    fn resolve_refuses_absolute_paths_outside_root() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let outside = std::env::temp_dir().join("definitely-not-inside-root.txt");
        // Use any path the OS considers absolute but not the root itself.
        let r = resolve(&Args {
            path: outside.to_string_lossy().into_owned(),
            cap: None,
        });
        let e = r.unwrap_err();
        assert!(
            matches!(
                e.code(),
                "amos.host_fs.path_escapes_root" | "amos.host_fs.path_not_found"
            ),
            "got {:?}",
            e.code()
        );
    }

    #[test]
    fn resolve_accepts_relative_path_inside_root() {
        let td = TempDir::new();
        let f = td.path().join("a.txt");
        fs::write(&f, b"hi").unwrap();
        let _drop = set_root(&td);
        let p = resolve(&Args {
            path: "a.txt".into(),
            cap: None,
        })
        .unwrap();
        assert_eq!(p, std::fs::canonicalize(&f).unwrap());
    }

    #[test]
    fn resolve_rejects_empty_path() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let e = resolve(&Args {
            path: "".into(),
            cap: None,
        })
        .unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_not_found");
    }

    #[test]
    fn resolve_rejects_oversized_path() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let huge = "a".repeat(MAX_PATH_BYTES + 1);
        let e = resolve(&Args {
            path: huge,
            cap: None,
        })
        .unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_not_found");
    }

    // ─── read_dir ──────────────────────────────────────────────────────

    #[test]
    fn read_dir_lists_files_with_size_and_mtime() {
        let td = TempDir::new();
        fs::write(td.path().join("a.txt"), b"x").unwrap();
        fs::write(td.path().join("b.txt"), b"yy").unwrap();
        fs::create_dir(td.path().join("nested")).unwrap();
        let _drop = set_root(&td);

        let entries = host_fs_read_dir(Args {
            path: ".".into(),
            cap: None,
        })
        .unwrap();
        // 2 files + 1 directory
        let names: Vec<_> = entries.iter().map(|e| e.name.clone()).collect();
        assert!(names.contains(&"a.txt".to_string()));
        assert!(names.contains(&"b.txt".to_string()));
        assert!(names.contains(&"nested".to_string()));
        let nested = entries.iter().find(|e| e.name == "nested").unwrap();
        assert!(nested.is_dir);
        let b = entries.iter().find(|e| e.name == "b.txt").unwrap();
        assert_eq!(b.size, 2);
    }

    #[test]
    fn read_dir_refuses_when_path_is_a_file() {
        let td = TempDir::new();
        fs::write(td.path().join("a.txt"), b"x").unwrap();
        let _drop = set_root(&td);
        let e = host_fs_read_dir(Args {
            path: "a.txt".into(),
            cap: None,
        })
        .unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_is_not_a_dir");
    }

    // ─── read_text / read_bytes ────────────────────────────────────────

    #[test]
    fn read_text_round_trip() {
        let td = TempDir::new();
        fs::write(td.path().join("hi.txt"), "你好\n世界".as_bytes()).unwrap();
        let _drop = set_root(&td);
        let r = host_fs_read_text(Args {
            path: "hi.txt".into(),
            cap: None,
        })
        .unwrap();
        assert_eq!(r.body, "你好\n世界");
        assert!(!r.truncated);
    }

    #[test]
    fn read_text_rejects_non_utf8() {
        let td = TempDir::new();
        fs::write(td.path().join("bin.txt"), [0xff, 0xfe, 0xfd]).unwrap();
        let _drop = set_root(&td);
        let e = host_fs_read_text(Args {
            path: "bin.txt".into(),
            cap: None,
        })
        .unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.read_not_utf8");
    }

    #[test]
    fn read_text_truncates_at_cap() {
        let td = TempDir::new();
        let body: String = "A".repeat(2048);
        fs::write(td.path().join("big.txt"), body.as_bytes()).unwrap();
        let _drop = set_root(&td);
        let r = host_fs_read_text(Args {
            path: "big.txt".into(),
            cap: Some(100),
        })
        .unwrap();
        assert_eq!(r.body.len(), 100);
        assert!(r.truncated);
    }

    #[test]
    fn read_bytes_round_trip_with_base64() {
        let td = TempDir::new();
        let raw = b"hello world";
        fs::write(td.path().join("hi.bin"), raw).unwrap();
        let _drop = set_root(&td);
        let r = host_fs_read_bytes(Args {
            path: "hi.bin".into(),
            cap: None,
        })
        .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&r.body)
                .unwrap(),
            raw
        );
        assert_eq!(r.size, raw.len() as u64);
    }

    #[test]
    fn read_text_refuses_a_directory_with_its_own_code() {
        // A file-expected read pointed at a folder is a *user* mistake (pick a
        // different path), not a generic I/O fault — it must carry the declared
        // `path_is_a_dir` code, the mirror of `read_dir`'s `path_is_not_a_dir`.
        let td = TempDir::new();
        fs::create_dir(td.path().join("nested")).unwrap();
        let _drop = set_root(&td);
        let e = host_fs_read_text(Args {
            path: "nested".into(),
            cap: None,
        })
        .unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_is_a_dir");
    }

    #[test]
    fn read_bytes_refuses_a_directory_with_its_own_code() {
        let td = TempDir::new();
        fs::create_dir(td.path().join("nested")).unwrap();
        let _drop = set_root(&td);
        let e = host_fs_read_bytes(Args {
            path: "nested".into(),
            cap: None,
        })
        .unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_is_a_dir");
    }

    #[test]
    fn classify_file_target_distinguishes_absent_file_and_directory() {
        let td = TempDir::new();
        let f = td.path().join("f.txt");
        fs::write(&f, b"x").unwrap();
        let d = td.path().join("d");
        fs::create_dir(&d).unwrap();
        assert_eq!(classify_file_target(&f), FileTarget::File);
        assert_eq!(classify_file_target(&d), FileTarget::Directory);
        assert_eq!(
            classify_file_target(&td.path().join("missing")),
            FileTarget::Absent
        );
    }

    #[test]
    fn read_text_oversized_cap_is_clamped_to_max() {
        let td = TempDir::new();
        fs::write(td.path().join("a.txt"), b"x").unwrap();
        let _drop = set_root(&td);
        let r = host_fs_read_text(Args {
            path: "a.txt".into(),
            cap: Some(MAX_READ_CAP + 10),
        })
        .unwrap();
        // No panic; the file is tiny so size is 1.
        assert_eq!(r.size, 1);
    }

    // ─── write_text / write_bytes ──────────────────────────────────────

    #[test]
    fn write_text_creates_files_atomically() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let r = host_fs_write_text(WriteArgs {
            path: "sub/note.txt".into(),
            content: "新内容".into(),
            cap: None,
            create_only: false,
        })
        .unwrap();
        assert!(r.size >= 9); // utf-8 of "新内容"
        let on_disk = fs::read_to_string(td.path().join("sub/note.txt")).unwrap();
        assert_eq!(on_disk, "新内容");
        // No leftover tmp file in the directory.
        let leftover: Vec<_> = fs::read_dir(td.path().join("sub"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".amos.tmp"))
            .collect();
        assert!(
            leftover.is_empty(),
            "tmp should not survive a successful write"
        );
    }

    #[test]
    fn write_text_overwrites_existing_file() {
        let td = TempDir::new();
        fs::write(td.path().join("a.txt"), "OLD").unwrap();
        let _drop = set_root(&td);
        host_fs_write_text(WriteArgs {
            path: "a.txt".into(),
            content: "NEW".into(),
            cap: None,
            create_only: false,
        })
        .unwrap();
        assert_eq!(fs::read_to_string(td.path().join("a.txt")).unwrap(), "NEW");
    }

    /// `create_only` is the "New File" contract: a name collision must be a typed
    /// refusal, never a silent overwrite. The default (`false`) keeps the
    /// save-means-overwrite behaviour pinned by the sibling above.
    #[test]
    fn write_text_create_only_refuses_an_existing_file() {
        let td = TempDir::new();
        fs::write(td.path().join("a.txt"), "OLD").unwrap();
        let _drop = set_root(&td);
        let e = host_fs_write_text(WriteArgs {
            path: "a.txt".into(),
            content: "NEW".into(),
            cap: None,
            create_only: true,
        })
        .unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.target_exists");
        // The refused write must not have touched the existing file.
        assert_eq!(fs::read_to_string(td.path().join("a.txt")).unwrap(), "OLD");
    }

    #[test]
    fn write_text_create_only_creates_a_missing_file() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let r = host_fs_write_text(WriteArgs {
            path: "fresh.txt".into(),
            content: String::new(),
            cap: None,
            create_only: true,
        })
        .unwrap();
        assert_eq!(r.size, 0);
        assert!(td.path().join("fresh.txt").exists());
    }

    #[test]
    fn write_text_refuses_a_directory_with_its_own_code() {
        // Writing onto an existing directory currently collapses into the
        // tmp-rename failure (`write_atomics_failed`); the user-visible fact is
        // "you aimed a file write at a folder", which has its own declared code.
        let td = TempDir::new();
        fs::create_dir(td.path().join("nested")).unwrap();
        let _drop = set_root(&td);
        let e = host_fs_write_text(WriteArgs {
            path: "nested".into(),
            content: "x".into(),
            cap: None,
            create_only: false,
        })
        .unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_is_a_dir");
    }

    #[test]
    fn write_bytes_refuses_a_directory_with_its_own_code() {
        let td = TempDir::new();
        fs::create_dir(td.path().join("nested")).unwrap();
        let _drop = set_root(&td);
        let e = host_fs_write_bytes(WriteBytesArgs {
            path: "nested".into(),
            data_b64: base64::engine::general_purpose::STANDARD.encode(b"x"),
            cap: None,
        })
        .unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_is_a_dir");
    }

    #[test]
    fn write_text_refuses_oversized_content() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let huge = "A".repeat(MAX_WRITE_CAP + 1);
        let e = host_fs_write_text(WriteArgs {
            path: "huge.txt".into(),
            content: huge,
            cap: None,
            create_only: false,
        })
        .unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.file_too_large");
    }

    /// The write path must establish the declared **default** ceiling: content
    /// one byte over [`DEFAULT_WRITE_CAP`] with no `cap` arg is refused. Before
    /// the write-side `cap` existed (REQ-A633), only `MAX_WRITE_CAP` was
    /// checked, so this 8 MiB+1 write sailed through — the declared default was
    /// unreachable.
    #[test]
    fn write_text_refuses_content_over_the_default_cap_with_no_cap_arg() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let over = "A".repeat(DEFAULT_WRITE_CAP + 1);
        let e = host_fs_write_text(WriteArgs {
            path: "over.txt".into(),
            content: over,
            cap: None,
            create_only: false,
        })
        .unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.file_too_large");
        assert!(
            e.message.contains(&DEFAULT_WRITE_CAP.to_string()),
            "the refusal names the effective (default) cap, not the ceiling: {}",
            e.message
        );
    }

    /// Raising `cap` up to the ceiling still admits a write larger than the
    /// default, so `MAX_WRITE_CAP` stays reachable — the fix tightens the
    /// default without walling off the declared maximum.
    #[test]
    fn write_text_admits_over_default_when_cap_is_raised_to_the_ceiling() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let body = "A".repeat(DEFAULT_WRITE_CAP + 1);
        let r = host_fs_write_text(WriteArgs {
            path: "big.txt".into(),
            content: body,
            cap: Some(MAX_WRITE_CAP),
            create_only: false,
        })
        .unwrap();
        assert_eq!(r.size as usize, DEFAULT_WRITE_CAP + 1);
        assert_eq!(
            fs::metadata(td.path().join("big.txt")).unwrap().len() as usize,
            DEFAULT_WRITE_CAP + 1
        );
    }

    /// A `cap` above the ceiling is clamped, not honoured: the declared
    /// `MAX_WRITE_CAP` is a hard bound even when the caller asks for more.
    #[test]
    fn write_text_clamps_a_cap_above_the_ceiling() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let over = "A".repeat(MAX_WRITE_CAP + 1);
        let e = host_fs_write_text(WriteArgs {
            path: "over.max".into(),
            content: over,
            cap: Some(usize::MAX),
            create_only: false,
        })
        .unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.file_too_large");
    }

    /// Same declared-default property on the bytes path, checked against the
    /// **decoded** length (base64 inflates ~4/3, so a naive text-length check
    /// would refuse at ~6 MiB of real payload).
    #[test]
    fn write_bytes_refuses_decoded_content_over_the_default_cap() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let raw = vec![0u8; DEFAULT_WRITE_CAP + 1];
        let b64 = base64::engine::general_purpose::STANDARD.encode(&raw);
        let e = host_fs_write_bytes(WriteBytesArgs {
            path: "over.bin".into(),
            data_b64: b64,
            cap: None,
        })
        .unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.file_too_large");
    }

    #[test]
    fn write_bytes_rejects_invalid_base64() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let e = host_fs_write_bytes(WriteBytesArgs {
            path: "x.bin".into(),
            data_b64: "!!!not base64!!!".into(),
            cap: None,
        })
        .unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.write_failed");
    }

    #[test]
    fn write_bytes_round_trip() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let raw = b"\x00\x01\x02\x03 binary";
        let b64 = base64::engine::general_purpose::STANDARD.encode(raw);
        host_fs_write_bytes(WriteBytesArgs {
            path: "x.bin".into(),
            data_b64: b64,
            cap: None,
        })
        .unwrap();
        let on_disk = fs::read(td.path().join("x.bin")).unwrap();
        assert_eq!(on_disk, raw);
    }

    // ─── stat ──────────────────────────────────────────────────────────

    #[test]
    fn stat_file_vs_directory() {
        let td = TempDir::new();
        fs::write(td.path().join("a.txt"), b"xx").unwrap();
        fs::create_dir(td.path().join("nested")).unwrap();
        let _drop = set_root(&td);
        let s = host_fs_stat(Args {
            path: "a.txt".into(),
            cap: None,
        })
        .unwrap();
        assert!(s.exists);
        assert!(!s.is_dir);
        assert_eq!(s.size, 2);
        let d = host_fs_stat(Args {
            path: "nested".into(),
            cap: None,
        })
        .unwrap();
        assert!(d.is_dir);
    }

    // ─── create_dir ────────────────────────────────────────────────────

    fn mkdir_args(path: &str, recursive: bool) -> CreateDirArgs {
        CreateDirArgs {
            path: path.to_string(),
            recursive: Some(recursive),
        }
    }

    fn rename_args(from: &str, to: &str, overwrite: bool) -> RenameArgs {
        RenameArgs {
            from: from.to_string(),
            to: to.to_string(),
            overwrite: Some(overwrite),
        }
    }

    fn remove_args(path: &str, recursive: bool) -> RemoveArgs {
        RemoveArgs {
            path: path.to_string(),
            recursive: Some(recursive),
        }
    }

    fn copy_args(from: &str, to: &str, overwrite: bool) -> CopyArgs {
        CopyArgs {
            from: from.to_string(),
            to: to.to_string(),
            overwrite: Some(overwrite),
        }
    }

    #[test]
    fn create_dir_makes_a_directory() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let s = host_fs_create_dir(mkdir_args("newdir", false)).unwrap();
        assert!(s.exists && s.is_dir);
        assert!(td.path().join("newdir").is_dir());
    }

    #[test]
    fn create_dir_recursive_makes_parents() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        host_fs_create_dir(mkdir_args("a/b/c", true)).unwrap();
        assert!(td.path().join("a/b/c").is_dir());
    }

    #[test]
    fn create_dir_non_recursive_refuses_a_missing_parent() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let e = host_fs_create_dir(mkdir_args("missing/child", false)).unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.create_dir_failed");
    }

    #[test]
    fn create_dir_refuses_an_existing_target() {
        let td = TempDir::new();
        fs::create_dir(td.path().join("here")).unwrap();
        let _drop = set_root(&td);
        let e = host_fs_create_dir(mkdir_args("here", false)).unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.target_exists");
    }

    #[test]
    fn create_dir_refuses_a_path_that_escapes_the_root() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let e = host_fs_create_dir(mkdir_args("../escape", true)).unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_escapes_root");
    }

    // ─── rename ────────────────────────────────────────────────────────

    #[test]
    fn rename_moves_a_file_into_a_subdirectory() {
        let td = TempDir::new();
        fs::write(td.path().join("a.txt"), b"x").unwrap();
        fs::create_dir(td.path().join("sub")).unwrap();
        let _drop = set_root(&td);
        let s = host_fs_rename(rename_args("a.txt", "sub/a.txt", false)).unwrap();
        assert!(s.path.ends_with("a.txt"));
        assert!(!td.path().join("a.txt").exists());
        assert!(td.path().join("sub/a.txt").exists());
    }

    #[test]
    fn rename_refuses_an_existing_destination_without_overwrite() {
        let td = TempDir::new();
        fs::write(td.path().join("a.txt"), b"a").unwrap();
        fs::write(td.path().join("b.txt"), b"b").unwrap();
        let _drop = set_root(&td);
        let e = host_fs_rename(rename_args("a.txt", "b.txt", false)).unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.target_exists");
        // Both files are untouched — a refused rename never loses data.
        assert_eq!(fs::read_to_string(td.path().join("b.txt")).unwrap(), "b");
    }

    #[test]
    fn rename_overwrite_replaces_the_destination() {
        let td = TempDir::new();
        fs::write(td.path().join("a.txt"), b"new").unwrap();
        fs::write(td.path().join("b.txt"), b"old").unwrap();
        let _drop = set_root(&td);
        host_fs_rename(rename_args("a.txt", "b.txt", true)).unwrap();
        assert_eq!(fs::read_to_string(td.path().join("b.txt")).unwrap(), "new");
        assert!(!td.path().join("a.txt").exists());
    }

    #[test]
    fn rename_refuses_moving_a_directory_inside_itself() {
        let td = TempDir::new();
        fs::create_dir(td.path().join("dir")).unwrap();
        let _drop = set_root(&td);
        let e = host_fs_rename(rename_args("dir", "dir/nested", false)).unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_escapes_root");
        assert!(td.path().join("dir").exists());
    }

    #[test]
    fn rename_refuses_the_root_itself() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let e = host_fs_rename(rename_args(".", "renamed", false)).unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_escapes_root");
    }

    #[test]
    fn rename_missing_source_is_path_not_found() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let e = host_fs_rename(rename_args("nope.txt", "x.txt", false)).unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_not_found");
    }

    // ─── remove ────────────────────────────────────────────────────────

    #[test]
    fn remove_deletes_a_file() {
        let td = TempDir::new();
        fs::write(td.path().join("a.txt"), b"x").unwrap();
        let _drop = set_root(&td);
        let r = host_fs_remove(remove_args("a.txt", false)).unwrap();
        assert!(r.removed);
        assert_eq!(r.kind, "file");
        assert!(!td.path().join("a.txt").exists());
    }

    #[test]
    fn remove_deletes_an_empty_directory() {
        let td = TempDir::new();
        fs::create_dir(td.path().join("empty")).unwrap();
        let _drop = set_root(&td);
        let r = host_fs_remove(remove_args("empty", false)).unwrap();
        assert_eq!(r.kind, "dir");
        assert!(!td.path().join("empty").exists());
    }

    #[test]
    fn remove_refuses_a_non_empty_directory_without_recursive() {
        let td = TempDir::new();
        fs::create_dir(td.path().join("full")).unwrap();
        fs::write(td.path().join("full/keep.txt"), b"x").unwrap();
        let _drop = set_root(&td);
        let e = host_fs_remove(remove_args("full", false)).unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.dir_not_empty");
        assert!(td.path().join("full/keep.txt").exists());
    }

    #[test]
    fn remove_recursive_deletes_a_tree() {
        let td = TempDir::new();
        fs::create_dir_all(td.path().join("full/sub")).unwrap();
        fs::write(td.path().join("full/a.txt"), b"x").unwrap();
        fs::write(td.path().join("full/sub/b.txt"), b"y").unwrap();
        let _drop = set_root(&td);
        let r = host_fs_remove(remove_args("full", true)).unwrap();
        assert_eq!(r.kind, "dir");
        assert!(!td.path().join("full").exists());
    }

    #[test]
    fn remove_refuses_the_root_itself() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let e = host_fs_remove(remove_args(".", true)).unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_escapes_root");
        assert!(td.path().exists());
    }

    // ─── copy ──────────────────────────────────────────────────────────

    #[test]
    fn copy_duplicates_a_file() {
        let td = TempDir::new();
        fs::write(td.path().join("a.txt"), b"hello").unwrap();
        let _drop = set_root(&td);
        let s = host_fs_copy(copy_args("a.txt", "copy.txt", false)).unwrap();
        assert!(!s.is_dir);
        assert_eq!(
            fs::read_to_string(td.path().join("copy.txt")).unwrap(),
            "hello"
        );
        // The source survives a copy.
        assert_eq!(
            fs::read_to_string(td.path().join("a.txt")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn copy_recurses_a_directory_tree() {
        let td = TempDir::new();
        fs::create_dir_all(td.path().join("src/sub")).unwrap();
        fs::write(td.path().join("src/a.txt"), b"a").unwrap();
        fs::write(td.path().join("src/sub/b.txt"), b"b").unwrap();
        let _drop = set_root(&td);
        let s = host_fs_copy(copy_args("src", "dst", false)).unwrap();
        assert!(s.is_dir);
        assert_eq!(
            fs::read_to_string(td.path().join("dst/a.txt")).unwrap(),
            "a"
        );
        assert_eq!(
            fs::read_to_string(td.path().join("dst/sub/b.txt")).unwrap(),
            "b"
        );
    }

    #[test]
    fn copy_refuses_an_existing_destination_without_overwrite() {
        let td = TempDir::new();
        fs::write(td.path().join("a.txt"), b"a").unwrap();
        fs::write(td.path().join("b.txt"), b"b").unwrap();
        let _drop = set_root(&td);
        let e = host_fs_copy(copy_args("a.txt", "b.txt", false)).unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.target_exists");
        assert_eq!(fs::read_to_string(td.path().join("b.txt")).unwrap(), "b");
    }

    #[test]
    fn copy_overwrite_replaces_the_destination() {
        let td = TempDir::new();
        fs::write(td.path().join("a.txt"), b"new").unwrap();
        fs::write(td.path().join("b.txt"), b"old").unwrap();
        let _drop = set_root(&td);
        host_fs_copy(copy_args("a.txt", "b.txt", true)).unwrap();
        assert_eq!(fs::read_to_string(td.path().join("b.txt")).unwrap(), "new");
    }

    #[test]
    fn copy_refuses_a_directory_inside_itself() {
        let td = TempDir::new();
        fs::create_dir(td.path().join("dir")).unwrap();
        let _drop = set_root(&td);
        let e = host_fs_copy(copy_args("dir", "dir/nested", false)).unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_escapes_root");
    }

    #[test]
    fn copy_missing_source_is_path_not_found() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        let e = host_fs_copy(copy_args("nope.txt", "x.txt", false)).unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.path_not_found");
    }

    #[test]
    fn copy_aborts_past_the_depth_budget() {
        // 70 nested directories is past `MAX_RECURSIVE_DEPTH` (64): the walk must
        // abort with the declared limit rather than descend forever.
        let td = TempDir::new();
        let mut p = td.path().to_path_buf();
        for i in 0..(MAX_RECURSIVE_DEPTH as usize + 6) {
            p = p.join(format!("d{i}"));
        }
        fs::create_dir_all(&p).unwrap();
        let _drop = set_root(&td);
        let e = host_fs_copy(copy_args("d0", "copy", false)).unwrap_err();
        assert_eq!(e.code(), "amos.host_fs.recursion_limit");
    }

    // ─── root_status (no errors when unset) ───────────────────────────

    #[cfg(not(test))]
    #[test]
    fn root_status_reports_unconfigured_without_erroring() {
        let _drop = ScopedEnv::set(ENV_ALLOWED_ROOT, "/none");
        let mut g = ALLOWED_ROOT.lock().unwrap_or_else(|p| p.into_inner());
        *g = None;
        let s = host_fs_root_status();
        assert!(s.root.is_none());
        assert!(!s.exists);
        assert!(s.reason.is_some());
    }

    #[test]
    fn root_status_reports_configured_root() {
        let td = TempDir::new();
        let _drop = set_root(&td);
        // Prime the memoised root.
        let _ = ensure_allowed_root().unwrap();
        let s = host_fs_root_status();
        assert!(s.exists);
        assert!(s.reason.is_none());
        let expected = td.path().to_string_lossy().into_owned();
        let root = s.root.unwrap();
        // Canonicalize may resolve symlinks (e.g. /tmp -> /private/tmp on macOS);
        // assert *suffix* equality so the test stays portable across those.
        assert!(
            root.ends_with(&expected),
            "expected '{root}' to end with '{expected}'"
        );
    }

    // ─── watch list / unsubscribe no-ops ──────────────────────────────

    #[test]
    fn watch_list_empty_when_no_subscriptions() {
        let _drop = set_root(&TempDir::new());
        // Brand-new HostFsState — not exercised through the Tauri State<> since
        // tests are headless. The empty list path is data, not failure.
        let ids = empty_watch_state_list();
        assert!(ids.is_empty());
    }

    #[test]
    fn watch_unsubscribe_unknown_is_not_an_error() {
        let _drop = set_root(&TempDir::new());
        let r = run_unsubscribe_unknown();
        assert!(
            !r.removed,
            "unknown subscription must report `removed: false`"
        );
    }

    fn empty_watch_state_list() -> Vec<u32> {
        let s = HostFsState::new();
        let guard = s.slots.lock().unwrap_or_else(|p| p.into_inner());
        let mut ids: Vec<u32> = guard.keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    fn run_unsubscribe_unknown() -> FsUnsubscribe {
        let s = HostFsState::new();
        let removed = {
            let mut g = s.slots.lock().unwrap_or_else(|p| p.into_inner());
            g.remove(&123_456).is_some()
        };
        FsUnsubscribe { removed }
    }
}
