//! `webman_download` — the WebMan browser's **real** download pipeline.
//!
//! Before this module the download panel was a ledger, not a downloader: the UI
//! registered a row and a `setTimeout` walked its progress bar to 25%. That was
//! the honest shape of the gap, because the WebMan content area is an
//! `<iframe>` — the host WebView owns page loads, so there was nothing for a
//! pipeline to hook. This module is the pipeline anyway, driven by the frontend
//! instead of pretending the WebView handles it: a real HTTP GET over `ureq`,
//! streamed to a real file under the user's Downloads directory, with progress
//! events, cancellation, and a **persistent cookie jar** shared across
//! downloads.
//!
//! ## What is real here (and what still is not)
//!
//! * **Real**: bytes on disk (`downloadDir`), real HTTP status / redirect
//!   handling, real `Set-Cookie` capture and replay on later requests (RFC 6265
//!   domain/path matching via `cookie_store`), persisted to
//!   `<profile>/cookies.json`. `webman_download_start` returns while the
//!   transfer runs on a blocking worker; progress arrives on the
//!   [`EVENT_PROGRESS`] channel.
//! * **Still not**: **page content** is still an `<iframe>`. A link *inside* a
//!   page that triggers a browser-native download is handled by the platform
//!   WebView, not by this pipeline, and the cookies a page sets live in the
//!   WebView's own jar, not this one. Closing that is the child-webview work
//!   (phase 2) and is deliberately not faked here.
//!
//! ## Commands
//!
//! * `webman_download_start(url, filename?)` → [`DownloadStarted`]; runs the
//!   transfer, emitting [`DownloadProgress`] on [`EVENT_PROGRESS`].
//! * `webman_download_cancel(id)` → the transfer stops at the next chunk and
//!   the partial file is removed.
//! * `webman_cookies_list()` → the jar's live cookies.
//! * `webman_cookies_clear()` → empties the jar (and its on-disk copy).

use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use amos_media::{MediaKind, MediaProvider, StandardDir};
use cookie_store::CookieStore;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::error::{AmosError, ErrorCode};

/// Channel every [`DownloadProgress`] is emitted on.
pub const EVENT_PROGRESS: &str = "webman-download-progress";

/// Read size per write. Large enough that a fast local copy is not syscall-bound,
/// small enough that [`webman_download_cancel`] is observed promptly.
const CHUNK_BYTES: usize = 64 * 1024;

/// Hard ceiling on one download. A browser download of an unbounded body is a
/// disk-exhaustion primitive; the ceiling fails closed rather than filling the
/// volume. 4 GiB is a generous single-file bound for a phone.
const MAX_DOWNLOAD_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Minimum spacing between progress events. A 64 KiB chunk on a fast link would
/// otherwise emit thousands of events a second at the WebView.
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(100);

/// Total request timeout (connect + transfer). A stall fails the download
/// instead of hanging a worker thread forever.
const REQUEST_TIMEOUT_SECS: u64 = 600;

/// Cap on a caller-supplied filename (`LIMITS.FILENAME_MAX_LENGTH` in the UI).
pub const MAX_FILENAME_BYTES: usize = 255;

/// Cap on a download URL, mirroring the UI's `LIMITS.URL_MAX_LENGTH`.
pub const MAX_URL_BYTES: usize = 2048;

/// Cap on a caller-supplied correlation id (a frontend row id).
pub const MAX_DOWNLOAD_ID_BYTES: usize = 128;

/// Name of the persisted cookie-jar file under the profile directory.
const COOKIES_FILE: &str = "cookies.json";

/// Lifecycle of one download, mirrored to the UI. Renaming a variant is a wire break.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Pending,
    Downloading,
    Completed,
    Failed,
    Canceled,
}

/// One progress/terminal event on [`EVENT_PROGRESS`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub id: String,
    pub url: String,
    pub filename: String,
    /// Where the transfer's bytes are **now**: an absolute file path on a platform
    /// whose Downloads dir is a real directory (the `.part` file while in flight,
    /// the final path once completed), or a `content://` URI once a MediaStore
    /// destination has adopted it (Android). It is deliberately *not* called
    /// `path` any more — half the platforms cannot answer with one.
    pub location: String,
    /// Bytes written so far.
    pub received: u64,
    /// `Content-Length` when the server sent one; `None` for a chunked body.
    pub total: Option<u64>,
    pub status: DownloadStatus,
    /// Human-readable failure reason; present only when `status == Failed`.
    pub error: Option<String>,
}

/// Returned by `webman_download_start` before the transfer has finished.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStarted {
    pub id: String,
    pub url: String,
    pub filename: String,
    /// Where the transfer is being written. An absolute path on a platform with a
    /// real Downloads dir; app-private staging (also an absolute path) where the
    /// destination is MediaStore — the `content://` URI only exists at completion.
    pub location: String,
}

/// One cookie in the jar, for the UI's site-data view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieRecord {
    pub name: String,
    pub value: String,
    /// Empty for a host-only cookie with no `Domain` attribute.
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
}

/// How a transfer ended when it did not fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobEnd {
    Completed(u64),
    Canceled,
}

// ─── Where a finished transfer's bytes go ─────────────────────────────────

/// The result of handing a finished transfer to its destination.
pub struct Placed {
    /// What to report to the user: an absolute file path where the destination is
    /// a directory, a `content://` URI where it is MediaStore.
    pub location: String,
    /// The name the **destination** adopted — never the one we proposed. Both sinks
    /// rename on a collision (`pick_path` appends ` (1)` in a directory; MediaStore
    /// appends ` (1)` in the collection), and a UI shown the proposed name instead
    /// would be naming a file the device does not have.
    pub filename: String,
}

/// The platform's destination policy — where a finished download is *put*.
///
/// Two platforms, two answers: a real Downloads directory (the file is written
/// straight into it and only renamed), or Android's MediaStore, which has no
/// filesystem path at all and is addressed by `content://` URI. Keeping this as a
/// seam means the transfer loop — the part with cancellation, progress and the
/// 4 GiB cap — does not branch on the platform.
pub trait DownloadSink: Send + Sync {
    /// Directory the transfer is written into before [`place`] runs.
    ///
    /// `fallback` is the process-wide Downloads dir. A directory destination
    /// returns it unchanged (the staged file *is* the deliverable); a MediaStore
    /// destination returns app-private staging instead, because the bytes must not
    /// appear in a user-visible folder until MediaStore owns them.
    ///
    /// [`place`]: DownloadSink::place
    fn staging_dir(&self, fallback: &Path) -> PathBuf;

    /// The name the transfer is staged under. A directory destination stages under
    /// the destination's own name; a MediaStore destination stages under a
    /// per-transfer name, because the name the user will see is chosen by
    /// MediaStore at hand-over and two concurrent `report.pdf` transfers must not
    /// share one scratch file.
    fn staging_name(&self, id: &str, filename: &str) -> String;

    /// Move / hand over the staged file. `dest` is the reserved destination path
    /// (the rename target for a directory sink); a MediaStore sink ignores it and
    /// deletes it, since the bytes now live behind a URI.
    fn place(&self, dest: &Path, staged: &Path, filename: &str) -> Result<Placed, String>;
}

/// A Downloads directory that is a real, user-visible folder: the file is written
/// into it directly and the only remaining work is the atomic rename that makes
/// the finished name appear.
pub struct DirSink;

impl DownloadSink for DirSink {
    fn staging_dir(&self, fallback: &Path) -> PathBuf {
        fallback.to_path_buf()
    }

    fn staging_name(&self, _id: &str, filename: &str) -> String {
        filename.to_owned()
    }

    fn place(&self, dest: &Path, staged: &Path, filename: &str) -> Result<Placed, String> {
        std::fs::rename(staged, dest).map_err(|e| format!("could not finalize file: {e}"))?;
        Ok(Placed {
            location: dest.to_string_lossy().into_owned(),
            // `pick_path` avoids clobbering (`report.pdf`, `report (1).pdf`, …), so `dest`
            // may not carry the name we proposed — report the name the file actually has.
            filename: dest
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| filename.to_owned()),
        })
    }
}

/// Android's Downloads collection. Not a directory: the destination is a
/// `content://` URI inside MediaStore, so the transfer is staged app-privately and
/// then **streamed** into the provider (`save_from_path`), which never holds the
/// payload whole.
pub struct MediaStoreSink {
    provider: Arc<dyn MediaProvider>,
    staging: PathBuf,
}

impl MediaStoreSink {
    pub fn new(provider: Arc<dyn MediaProvider>, staging: PathBuf) -> Self {
        Self { provider, staging }
    }
}

impl DownloadSink for MediaStoreSink {
    fn staging_dir(&self, _fallback: &Path) -> PathBuf {
        self.staging.clone()
    }

    fn staging_name(&self, id: &str, filename: &str) -> String {
        // MediaStore picks the visible name; this one only has to be unique within
        // the staging directory for the life of the transfer.
        format!("{id}-{filename}")
    }

    fn place(&self, dest: &Path, staged: &Path, filename: &str) -> Result<Placed, String> {
        let item = self
            .provider
            .save_from_path(StandardDir::Download, MediaKind::File, filename, staged)
            .map_err(|e| e.to_string())?;
        // The staged copy is app-private scratch, now superseded by the MediaStore
        // row. Removing it also keeps the staging dir from growing across boots.
        let _ = std::fs::remove_file(staged);
        let _ = dest; // the reserved path *is* the staged path here; the sink owns removal
        Ok(Placed {
            location: item.uri,
            // MediaStore renames on a collision — report the name it adopted, never
            // the one we proposed, or the UI shows a name the device does not have.
            filename: item.name,
        })
    }
}

// ─── Manager ──────────────────────────────────────────────────────────────

/// The WebMan download engine: where files land, where the jar lives, and the
/// live cancel flags of in-flight transfers.
///
/// Registered once via `app.manage`. The cookie jar is the **single source of
/// truth** and is cloned into a fresh `ureq::Agent` per transfer (ureq only
/// hands out a read view of its own store, so owning the store here is what
/// makes `webman_cookies_clear` possible at all).
///
/// `reserved` is the other piece of state that must exist here rather than in a
/// caller: the destination names of transfers that are in flight. Without it,
/// choosing a destination is a *check-then-act* — two starts that interleave
/// between `exists()` and `File::create` both land on `report.pdf`, write into
/// the same `report.pdf.part`, and both report success for one file. The set is
/// consulted and updated under the same lock the search runs in, so the choice
/// is atomic; [`PathReservation`] releases the name when the worker ends.
pub struct WebmanDownloads {
    dir: PathBuf,
    profile: PathBuf,
    /// The platform's destination policy. Unset means [`DirSink`] — the state
    /// `boot()` can reach, since `manage()` runs before the app (and therefore
    /// `app.path()`) exists. [`Self::configure`] installs the real one from the
    /// app's `setup`, and it can arrive *after* transfers are possible.
    sink: OnceLock<Arc<dyn DownloadSink>>,
    cookies: Mutex<CookieStore>,
    cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Destination paths promised to an in-flight (or about-to-start) transfer.
    reserved: Mutex<HashSet<PathBuf>>,
}

impl WebmanDownloads {
    /// Resolve the directories and load the persisted jar. Best-effort: a jar
    /// that cannot be read starts empty rather than failing app boot.
    pub fn boot() -> Self {
        Self::with_dirs(download_dir(), profile_dir())
    }

    /// Explicit-directory constructor (tests and any caller that wants a
    /// sandboxed profile).
    pub fn with_dirs(dir: PathBuf, profile: PathBuf) -> Self {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!(target: "amos::webman", error = %e, "could not create download directory");
        }
        if let Err(e) = std::fs::create_dir_all(&profile) {
            tracing::warn!(target: "amos::webman", error = %e, "could not create webman profile directory");
        }
        let cookies = match load_cookies(&profile.join(COOKIES_FILE)) {
            Ok(store) => store,
            Err(e) => {
                tracing::warn!(target: "amos::webman", error = %e, "cookie jar unreadable; starting empty");
                CookieStore::default()
            }
        };
        Self {
            dir,
            profile,
            sink: OnceLock::new(),
            cookies: Mutex::new(cookies),
            cancel: Mutex::new(HashMap::new()),
            reserved: Mutex::new(HashSet::new()),
        }
    }

    /// Install the platform's destination policy. Idempotent (first call wins), so
    /// a re-entrant bring-up cannot swap the destination out from under a running
    /// transfer.
    pub fn configure(&self, sink: Arc<dyn DownloadSink>) {
        let _ = self.sink.set(sink);
    }

    /// The active destination policy — an explicit one, else [`DirSink`].
    fn sink(&self) -> Arc<dyn DownloadSink> {
        match self.sink.get() {
            Some(s) => Arc::clone(s),
            None => Arc::new(DirSink),
        }
    }

    /// Directory downloads are written to.
    pub fn download_dir(&self) -> &Path {
        &self.dir
    }

    fn lock_cookies(&self) -> std::sync::MutexGuard<'_, CookieStore> {
        self.cookies.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Reserve a correlation id, a destination path and a cancel flag for a new
    /// transfer — **atomically**.
    ///
    /// Both choices are check-then-act on their own (`is this id free?` / `does
    /// this name exist?`), and a command can run on any worker thread, so doing
    /// them separately is what let two concurrent starts pick the same id *and*
    /// the same file. Here the two tables are taken together and the answer is
    /// decided and recorded before either lock is released.
    fn begin(&self, wanted_id: Option<&str>, filename: &str) -> (String, PathBuf, Arc<AtomicBool>) {
        let mut cancel = self.cancel.lock().unwrap_or_else(|p| p.into_inner());
        let mut reserved = self.reserved.lock().unwrap_or_else(|p| p.into_inner());
        // A caller-supplied id is honoured only when it is a real correlation id
        // (non-blank, within the cap) and no transfer is already using it; a
        // concurrent start that lost the race gets a minted id instead of
        // silently stealing the other transfer's cancel flag.
        let id = match wanted_id {
            Some(candidate)
                if !candidate.is_empty()
                    && candidate.len() <= MAX_DOWNLOAD_ID_BYTES
                    && !cancel.contains_key(candidate) =>
            {
                candidate.to_owned()
            }
            _ => new_id(),
        };
        let sink = self.sink();
        let base = sink.staging_dir(&self.dir);
        let staged_name = sink.staging_name(&id, filename);
        let path = pick_path(&base, &staged_name, &reserved);
        reserved.insert(path.clone());
        let flag = Arc::new(AtomicBool::new(false));
        cancel.insert(id.clone(), Arc::clone(&flag));
        (id, path, flag)
    }

    /// Hand a destination name back once its transfer has ended.
    fn release_path(&self, path: &Path) {
        self.reserved
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(path);
    }

    fn take_cancel(&self, id: &str) -> Option<Arc<AtomicBool>> {
        self.cancel
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id)
    }

    /// Run one transfer to completion, emitting progress. Blocking: callers run
    /// this on a `spawn_blocking` worker.
    fn run_job<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        id: &str,
        url: &str,
        filename: &str,
        dest: &Path,
        cancel: &AtomicBool,
    ) {
        let part = part_path(dest);
        let emit = |status: DownloadStatus,
                    received: u64,
                    total: Option<u64>,
                    error: Option<String>,
                    location: String,
                    adopted: Option<String>| {
            let payload = DownloadProgress {
                id: id.to_owned(),
                url: url.to_owned(),
                // The destination may have renamed the file (MediaStore appends
                // ` (1)`); report the name it adopted, not the one we proposed.
                filename: adopted.unwrap_or_else(|| filename.to_owned()),
                location,
                received,
                total,
                status,
                error,
            };
            if let Err(e) = app.emit(EVENT_PROGRESS, payload) {
                tracing::warn!(target: "amos::webman", error = %e, "download progress emit failed");
            }
        };

        emit(
            DownloadStatus::Downloading,
            0,
            None,
            None,
            part.to_string_lossy().into_owned(),
            None,
        );

        let agent = self.agent();
        let mut last_emit = Instant::now();
        let mut on_progress = |received: u64, total: Option<u64>| {
            let now = Instant::now();
            if now.duration_since(last_emit) >= PROGRESS_MIN_INTERVAL {
                last_emit = now;
                emit(
                    DownloadStatus::Downloading,
                    received,
                    total,
                    None,
                    part.to_string_lossy().into_owned(),
                    None,
                );
            }
        };

        let outcome = download_to_file(&agent, url, &part, cancel, &mut on_progress);
        // Capture whatever cookies the exchange set (including on a failure the
        // server answered with a `Set-Cookie` + error status).
        self.absorb_cookies(&agent);

        match outcome {
            Ok(JobEnd::Completed(received)) => match self.sink().place(dest, &part, filename) {
                Ok(placed) => emit(
                    DownloadStatus::Completed,
                    received,
                    Some(received),
                    None,
                    placed.location,
                    Some(placed.filename),
                ),
                Err(e) => {
                    let _ = std::fs::remove_file(&part);
                    emit(
                        DownloadStatus::Failed,
                        received,
                        None,
                        Some(e),
                        part.to_string_lossy().into_owned(),
                        None,
                    );
                }
            },
            Ok(JobEnd::Canceled) => {
                let _ = std::fs::remove_file(&part);
                emit(
                    DownloadStatus::Canceled,
                    0,
                    None,
                    None,
                    part.to_string_lossy().into_owned(),
                    None,
                );
            }
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                emit(
                    DownloadStatus::Failed,
                    0,
                    None,
                    Some(e.message.clone()),
                    part.to_string_lossy().into_owned(),
                    None,
                );
            }
        }
    }

    /// A fresh agent over a clone of the current jar.
    fn agent(&self) -> ureq::Agent {
        let store = self.lock_cookies().clone();
        ureq::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .cookie_store(store)
            .build()
    }

    /// Fold a finished exchange's cookies back into the owned jar and persist.
    fn absorb_cookies(&self, agent: &ureq::Agent) {
        let updated = agent.cookie_store().clone();
        *self.lock_cookies() = updated;
        self.save_cookies();
    }

    fn save_cookies(&self) {
        let store = self.lock_cookies();
        let path = self.profile.join(COOKIES_FILE);
        let tmp = part_path(&path);
        let result = std::fs::File::create(&tmp).and_then(|mut f| {
            cookie_store::serde::json::save(&store, &mut f)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            f.flush()
        });
        match result {
            Ok(()) => {
                if let Err(e) = std::fs::rename(&tmp, &path) {
                    tracing::warn!(target: "amos::webman", error = %e, "cookie jar rename failed");
                    let _ = std::fs::remove_file(&tmp);
                }
            }
            Err(e) => {
                tracing::warn!(target: "amos::webman", error = %e, "cookie jar write failed");
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }

    fn list_cookies(&self) -> Vec<CookieRecord> {
        let store = self.lock_cookies();
        let mut out: Vec<CookieRecord> = store
            .iter_unexpired()
            .map(|c| CookieRecord {
                name: c.name().to_owned(),
                value: c.value().to_owned(),
                domain: c.domain().unwrap_or("").to_owned(),
                path: c.path().unwrap_or("/").to_owned(),
                secure: c.secure().unwrap_or(false),
                http_only: c.http_only().unwrap_or(false),
            })
            .collect();
        out.sort_by(|a, b| {
            a.domain
                .cmp(&b.domain)
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.path.cmp(&b.path))
        });
        out
    }

    /// Empty the jar; returns how many live cookies were dropped.
    fn clear_cookies(&self) -> usize {
        let mut store = self.lock_cookies();
        let dropped = store.iter_unexpired().count();
        store.clear();
        drop(store);
        self.save_cookies();
        dropped
    }
}

/// RAII release for a reserved destination name: held from the moment the
/// command answers until the worker has renamed the file into place (or given
/// up), including on the early-return and panic paths — a leaked reservation
/// would push every later download of that name to `(1)`.
struct PathReservation<'a> {
    state: &'a WebmanDownloads,
    path: PathBuf,
}

impl<'a> PathReservation<'a> {
    fn new(state: &'a WebmanDownloads, path: PathBuf) -> Self {
        Self { state, path }
    }
}

impl Drop for PathReservation<'_> {
    fn drop(&mut self) {
        self.state.release_path(&self.path);
    }
}

/// Pick a destination that does not clobber an existing file, mirroring the
/// browser habit of `report.pdf`, `report (1).pdf`, … `taken` holds the paths
/// already promised to an in-flight transfer; both it and `dir` are read while
/// the caller holds the reservation lock, so the answer cannot go stale between
/// the search and the insert.
fn pick_path(dir: &Path, filename: &str, taken: &HashSet<PathBuf>) -> PathBuf {
    let free = |p: &PathBuf| !p.exists() && !taken.contains(p);
    let first = dir.join(filename);
    if free(&first) {
        return first;
    }
    let (stem, ext) = split_extension(filename);
    for n in 1..=9999u32 {
        let candidate = match ext {
            Some(ref e) => dir.join(format!("{stem} ({n}).{e}")),
            None => dir.join(format!("{stem} ({n})")),
        };
        if free(&candidate) {
            return candidate;
        }
    }
    // Fall back to a unique-enough name rather than looping forever.
    let suffix = new_id();
    match ext.as_deref() {
        Some(e) => dir.join(format!("{stem}-{suffix}.{e}")),
        None => dir.join(format!("{stem}-{suffix}")),
    }
}

// ─── Commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn webman_download_start<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    filename: Option<String>,
    id: Option<String>,
) -> Result<DownloadStarted, AmosError> {
    validate_url(&url)?;
    let filename = match filename.as_deref() {
        Some(name) if !name.trim().is_empty() => sanitize_filename(name),
        _ => filename_from_url(&url),
    };

    // The UI owns the row it draws, so it may pass the correlation id it already
    // stored; a blank / oversized / already-active id falls back to a fresh one
    // rather than being trusted. The id, the destination name and the cancel flag
    // are chosen together (`begin`) because each choice is a check-then-act and a
    // command can run on any worker thread: two starts that interleaved used to
    // be able to share one path (and one cancel flag).
    let state = app.state::<WebmanDownloads>();
    let (id, dest, flag) = state.begin(id.as_deref(), &filename);

    // The transfer can take minutes; the command returns now and the worker
    // reports through events. The flag is shared so `webman_download_cancel`
    // can reach it, and the reservation is released by the worker (or by the
    // guard, should it panic) rather than here — the name is held for as long as
    // the file it names is being written.
    {
        let (job_id, job_url, job_name, job_dest) =
            (id.clone(), url.clone(), filename.clone(), dest.clone());
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<WebmanDownloads>();
            let _reservation = PathReservation::new(&state, job_dest.clone());
            state.run_job(&app, &job_id, &job_url, &job_name, &job_dest, &flag);
            state.take_cancel(&job_id);
        });
    }

    Ok(DownloadStarted {
        id,
        url,
        filename,
        location: dest.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn webman_download_cancel<R: Runtime>(app: AppHandle<R>, id: String) -> bool {
    let state = app.state::<WebmanDownloads>();
    let flag = state
        .cancel
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&id)
        .cloned();
    match flag {
        Some(f) => {
            f.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

#[tauri::command]
pub fn webman_cookies_list<R: Runtime>(app: AppHandle<R>) -> Vec<CookieRecord> {
    app.state::<WebmanDownloads>().list_cookies()
}

#[tauri::command]
pub fn webman_cookies_clear<R: Runtime>(app: AppHandle<R>) -> usize {
    app.state::<WebmanDownloads>().clear_cookies()
}

// ─── Pure helpers (unit-tested) ───────────────────────────────────────────

/// Where downloads land, decided from the platform facts that actually differ —
/// pure, so both answers are testable on the host.
///
/// `dirs::download_dir()` and `dirs::home_dir()` both return `None` on Android
/// (no XDG dirs, no `HOME`), which used to send every download to the last
/// fall-through — `temp_dir()/amos-downloads` = `/data/local/tmp/amos-downloads`,
/// a file the user can never see and the system prunes. Android has no browsable
/// filesystem Downloads; its destination is the MediaStore `Download` collection
/// (`MediaStoreSink`), so all this directory has to be there is **app-private
/// staging** the sink hands over and deletes.
pub fn download_dir_for(
    android: bool,
    env_override: Option<String>,
    dirs_download: Option<PathBuf>,
    home: Option<PathBuf>,
    temp: PathBuf,
) -> PathBuf {
    if let Some(p) = env_override.filter(|p| !p.trim().is_empty()) {
        return PathBuf::from(p);
    }
    if android {
        return temp.join("amos-downloads");
    }
    if let Some(d) = dirs_download {
        return d;
    }
    if let Some(h) = home {
        return h.join("Downloads");
    }
    temp.join("amos-downloads")
}

/// Directory downloads are staged in. `AMOS_WEBMAN_DOWNLOAD_DIR` overrides (tests
/// and a host that wants a fixed location); otherwise the platform Downloads dir
/// (a real user-visible folder) or, on Android, app-private staging.
pub fn download_dir() -> PathBuf {
    download_dir_for(
        cfg!(target_os = "android"),
        std::env::var("AMOS_WEBMAN_DOWNLOAD_DIR").ok(),
        dirs::download_dir(),
        dirs::home_dir(),
        std::env::temp_dir(),
    )
}

/// Directory the cookie jar persists under. `AMOS_WEBMAN_PROFILE` overrides.
pub fn profile_dir() -> PathBuf {
    if let Ok(p) = std::env::var("AMOS_WEBMAN_PROFILE") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Some(d) = dirs::data_dir() {
        return d.join("amos").join("webman");
    }
    std::env::temp_dir().join("amos-webman")
}

/// Reject anything that is not a plain absolute-ish HTTP(S) URL before it
/// reaches a socket. The frontend already filters, but a command is a public
/// boundary — it is validated here too.
pub fn validate_url(url: &str) -> Result<(), AmosError> {
    if url.is_empty() {
        return Err(AmosError::new(
            ErrorCode::WebmanUrlInvalid,
            "download url is empty",
        ));
    }
    if url.len() > MAX_URL_BYTES {
        return Err(AmosError::new(
            ErrorCode::WebmanUrlInvalid,
            format!("download url exceeds {MAX_URL_BYTES} bytes"),
        ));
    }
    let lower = url.to_ascii_lowercase();
    let rest = if let Some(r) = lower.strip_prefix("https://") {
        r
    } else if let Some(r) = lower.strip_prefix("http://") {
        r
    } else {
        return Err(AmosError::new(
            ErrorCode::WebmanUrlInvalid,
            "download url must be http(s)",
        ));
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        return Err(AmosError::new(
            ErrorCode::WebmanUrlInvalid,
            "download url has no host",
        ));
    }
    Ok(())
}

/// Best-effort filename from a URL: the last path segment, percent-decoded and
/// sanitised, falling back to `download` when the path names no file.
pub fn filename_from_url(url: &str) -> String {
    let without_fragment = url.split('#').next().unwrap_or(url);
    let without_query = without_fragment
        .split('?')
        .next()
        .unwrap_or(without_fragment);
    let after_scheme = without_query
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(without_query);
    let path = match after_scheme.split_once('/') {
        Some((_, p)) => p,
        None => "",
    };
    // A missing path (`host`) or a trailing `/` (`host/dir/`) names a page or a
    // directory, not a file; taking the segment before the slash would invent a
    // filename. The browser-correct answer is to fall back to "download".
    if path.is_empty() || path.ends_with('/') {
        return "download".to_owned();
    }
    let last = path.rsplit('/').next().unwrap_or("");
    let decoded = percent_decode(last);
    sanitize_filename(&decoded)
}

/// Make an arbitrary string safe to use as a single path segment: strip control
/// chars and separators, refuse the `.`/`..` traversal names, cap the length.
pub fn sanitize_filename(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_control() {
            continue;
        }
        match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => out.push('_'),
            _ => out.push(ch),
        }
    }
    let trimmed = out.trim();
    let name = if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "download".to_owned()
    } else {
        trimmed.to_owned()
    };
    truncate_bytes(&name, MAX_FILENAME_BYTES)
}

/// Truncate to at most `max` bytes without splitting a UTF-8 scalar.
fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_owned();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_owned()
}

/// Minimal `%XX` decoder (a URL path segment never contains `+`-for-space).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let (Some(hi), Some(lo)) = (hex_val(bytes.get(i + 1)), hex_val(bytes.get(i + 2))) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: Option<&u8>) -> Option<u8> {
    match b {
        Some(c @ b'0'..=b'9') => Some(c - b'0'),
        Some(c @ b'a'..=b'f') => Some(c - b'a' + 10),
        Some(c @ b'A'..=b'F') => Some(c - b'A' + 10),
        _ => None,
    }
}

/// `("report", Some("pdf"))` for `report.pdf`; `("report", None)` otherwise.
fn split_extension(name: &str) -> (String, Option<String>) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => {
            (stem.to_owned(), Some(ext.to_owned()))
        }
        _ => (name.to_owned(), None),
    }
}

/// `a/b.txt` → `a/b.txt.part` (append, not replace: `with_extension` would turn
/// `a/b.tar.gz` into `a/b.tar.part`).
fn part_path(dest: &Path) -> PathBuf {
    let mut os = dest.as_os_str().to_owned();
    os.push(".part");
    PathBuf::from(os)
}

/// Monotonic-ish unique id: wall-clock nanos plus a process counter.
fn new_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("wm-dl-{nanos:x}-{seq:x}")
}

fn load_cookies(path: &Path) -> Result<CookieStore, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    cookie_store::serde::json::load(reader).map_err(|e| e.to_string())
}

/// Actually perform the transfer. Split out from the manager so it is testable
/// against a plain `ureq::Agent` with no Tauri handle.
pub fn download_to_file(
    agent: &ureq::Agent,
    url: &str,
    part: &Path,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(u64, Option<u64>),
) -> Result<JobEnd, AmosError> {
    let response = agent.get(url).call().map_err(|e| match e {
        ureq::Error::Status(code, _) => AmosError::new(
            ErrorCode::WebmanDownloadFailed,
            format!("server answered HTTP {code}"),
        ),
        other => AmosError::with_cause(
            ErrorCode::WebmanDownloadFailed,
            "download request failed".to_owned(),
            other,
        ),
    })?;

    let total = response
        .header("Content-Length")
        .and_then(|v| v.trim().parse::<u64>().ok());

    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(part).map_err(|e| {
        AmosError::with_cause(
            ErrorCode::WebmanIoFailed,
            "could not create download file",
            e,
        )
    })?;

    let mut buf = vec![0u8; CHUNK_BYTES];
    let mut received: u64 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(JobEnd::Canceled);
        }
        let n = reader.read(&mut buf).map_err(|e| {
            AmosError::with_cause(ErrorCode::WebmanIoFailed, "download read failed", e)
        })?;
        if n == 0 {
            break;
        }
        received += n as u64;
        if received > MAX_DOWNLOAD_BYTES {
            return Err(AmosError::new(
                ErrorCode::WebmanDownloadTooLarge,
                format!("download exceeds the {MAX_DOWNLOAD_BYTES} byte ceiling"),
            ));
        }
        file.write_all(&buf[..n]).map_err(|e| {
            AmosError::with_cause(ErrorCode::WebmanIoFailed, "download write failed", e)
        })?;
        on_progress(received, total);
    }
    file.flush().map_err(|e| {
        AmosError::with_cause(ErrorCode::WebmanIoFailed, "download flush failed", e)
    })?;
    on_progress(received, total.or(Some(received)));
    Ok(JobEnd::Completed(received))
}

#[cfg(test)]
#[path = "webman_download_tests.rs"]
mod tests;
